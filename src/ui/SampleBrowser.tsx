import { useEffect, useMemo, useRef, useState } from "react";
import { useLibrary, useServices } from "./context";
import type { FactoryAsset } from "../sample-library/manifest";
import { ASSET_MOODS } from "../sample-library/manifest";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";
import { PPQ } from "../project-model/types";
import { tempoAtTick } from "../project-model/scene-time";
import { loopPreviewPlaybackRate } from "../audio-engine/loopTempo";
import { categoryColor } from "./kitColors";
import { DropZone } from "./DropZone";
import { IntakeTray } from "./IntakeTray";
import { FreesoundSection } from "./FreesoundSection";
import type { SongStarterHandoff } from "../landing/handoff";
import { installKyxStarterLoops } from "../sample-library/kyx-starter-loops";

/** Unified asset type — factory or user-imported. */
export type SampleAsset = FactoryAsset | UserSampleAsset;

/** MIME type carrying a sample asset id in drag&drop (ROADMAP-UI-2027 V4).
 *  Drop targets: sequencer drum rows (pad asset) and instrument track tabs. */
export const KYX_SAMPLE_MIME = "application/kyx-sample";

/** Read a dragged sample id from a drop event — null when the drag carries
 *  no KYX sample (files, text, external drags all pass through untouched). */
export function sampleIdFromDrag(dt: DataTransfer): string | null {
  const id = dt.getData(KYX_SAMPLE_MIME);
  if (id) return id;
  // Some hosts (Safari private mode, synthetic test events) drop the custom
  // MIME but keep text/plain — the id also rides there.
  const plain = dt.getData("text/plain");
  return plain && /^[a-z0-9-]{8,}$/i.test(plain) ? plain : null;
}

type CategoryFilter = "all" | string;
type MoodFilter = "all" | (typeof ASSET_MOODS)[number];
type LoopMetadata = NonNullable<UserSampleAsset["loopMetadata"]>;
type LoopDraft = { isLoop: boolean; bpm: string; genre: string; mood: string; instrument: string; key: string };

function isFactoryAsset(a: SampleAsset): a is FactoryAsset {
  return "character" in a;
}

function hasValidLoopBpm(asset: UserSampleAsset): asset is UserSampleAsset & { bpm: number } {
  return Number.isFinite(asset.bpm) && asset.bpm! >= 40 && asset.bpm! <= 240;
}

/** Returns undefined for an intentionally cleared tempo and null for invalid input. */
function parseLoopBpm(value: string): number | undefined | null {
  if (!value.trim()) return undefined;
  const bpm = Number(value);
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 240) return null;
  return Math.round(bpm * 10) / 10;
}

function isLoopAsset(asset: UserSampleAsset): boolean {
  if (asset.loopMetadata?.isLoop !== undefined) return asset.loopMetadata.isLoop;
  return hasValidLoopBpm(asset);
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

function matchesSearchQuery(haystack: string, query: string): boolean {
  const normalizedHaystack = normalizedText(haystack);
  const terms = normalizedText(query).split(/\s+/).filter(Boolean);
  return terms.every((term) => normalizedHaystack.includes(term));
}

function uniqueMetadataValues(assets: UserSampleAsset[], field: "genre" | "mood" | "instrument" | "key"): string[] {
  const values = new Map<string, string>();
  for (const asset of assets) {
    const value = asset.loopMetadata?.[field]?.trim();
    if (value) values.set(value.toLocaleLowerCase(), value);
  }
  return [...values.values()].sort((a, b) => a.localeCompare(b));
}

function matchesFilter(value: string | undefined, filter: string): boolean {
  return filter === "all" || normalizedText(value) === normalizedText(filter);
}

export function SampleBrowser({
  assets,
  userAssets = [],
  currentId,
  onSelect,
  allowNone = true,
  showDropZone = false,
  onBatchImport,
  onPreviewLoop,
  onAddLoop,
  loopStarter = null,
}: {
  assets: FactoryAsset[];
  userAssets?: UserSampleAsset[];
  currentId: string | null;
  onSelect: (assetId: string | null) => void;
  allowNone?: boolean;
  showDropZone?: boolean;
  onBatchImport?: (assets: UserSampleAsset[]) => void;
  onPreviewLoop?: (asset: UserSampleAsset) => void;
  onAddLoop?: (asset: UserSampleAsset) => Promise<void> | void;
  loopStarter?: SongStarterHandoff | null;
}) {
  const services = useServices();
  const library = useLibrary();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [mood, setMood] = useState<MoodFilter>("all");
  const [loopView, setLoopView] = useState(() => Boolean(loopStarter));
  const [loopGenre, setLoopGenre] = useState(() => loopStarter?.genre ?? "all");
  const [loopMood, setLoopMood] = useState(() => loopStarter?.mood ?? "all");
  const [loopInstrument, setLoopInstrument] = useState("all");
  const [loopKey, setLoopKey] = useState("all");
  const [minBpm, setMinBpm] = useState(() =>
    loopStarter ? String(Math.max(40, Math.floor(loopStarter.bpm * 0.9))) : "",
  );
  const [maxBpm, setMaxBpm] = useState(() =>
    loopStarter ? String(Math.min(240, Math.ceil(loopStarter.bpm * 1.1))) : "",
  );
  const [allUserAssets, setAllUserAssets] = useState<UserSampleAsset[]>(userAssets);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [loopMessage, setLoopMessage] = useState<string | null>(null);
  const [editingLoopId, setEditingLoopId] = useState<string | null>(null);
  const [loopDraft, setLoopDraft] = useState<LoopDraft | null>(null);
  const [savingLoopId, setSavingLoopId] = useState<string | null>(null);
  const [addingLoopId, setAddingLoopId] = useState<string | null>(null);
  const [installingStarterPack, setInstallingStarterPack] = useState(false);
  const [starterPackProgress, setStarterPackProgress] = useState<string | null>(null);
  const installLock = useRef(false);
  const starterPackInstalledCount = allUserAssets.filter(
    (asset) => asset.factoryPack?.id === "kyx-starter-loops",
  ).length;

  const reportLibraryFailure = (operation: Promise<unknown> | void): void => {
    setLibraryError(null);
    void Promise.resolve(operation).catch((error: unknown) => {
      setLibraryError(error instanceof Error ? error.message : "Could not save library preferences");
    });
  };

  // Load user samples from the repository without losing assets passed by an
  // importer during the same mount.
  useEffect(() => {
    let cancelled = false;
    void services.userSamples
      .list()
      .then((loaded) => {
        if (!cancelled) {
          setAllUserAssets((current) => {
            const merged = new Map<string, UserSampleAsset>();
            for (const asset of [...loaded, ...current]) merged.set(asset.id, asset);
            const next = [...merged.values()];
            return next.length === current.length && next.every((asset, index) => asset === current[index])
              ? current
              : next;
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setLibraryError(error instanceof Error ? error.message : "Could not load sample library");
      });
    return () => {
      cancelled = true;
    };
  }, [services]);

  const allAssets: SampleAsset[] = useMemo(() => [...assets, ...allUserAssets], [assets, allUserAssets]);
  const loopAssets = useMemo(() => allUserAssets.filter(isLoopAsset), [allUserAssets]);
  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const asset of allAssets) seen.add(asset.category);
    return [...seen];
  }, [allAssets]);
  const genres = useMemo(() => uniqueMetadataValues(loopAssets, "genre"), [loopAssets]);
  const instruments = useMemo(() => uniqueMetadataValues(loopAssets, "instrument"), [loopAssets]);
  const keys = useMemo(() => uniqueMetadataValues(loopAssets, "key"), [loopAssets]);
  const loopMoods = useMemo(() => {
    const tagged = uniqueMetadataValues(loopAssets, "mood");
    return [...new Map([...ASSET_MOODS, ...tagged].map((value) => [value.toLocaleLowerCase(), value])).values()];
  }, [loopAssets]);

  const soundFiltered = useMemo(() => {
    return allAssets.filter((asset) => {
      if (category !== "all" && asset.category !== category) return false;
      if (mood !== "all") {
        const matchesMood = isFactoryAsset(asset)
          ? asset.mood.includes(mood)
          : normalizedText(asset.loopMetadata?.mood) === normalizedText(mood);
        if (!matchesMood) return false;
      }
      if (query.trim().length > 0) {
        const haystack = isFactoryAsset(asset)
          ? `${asset.name} ${asset.character} ${asset.tags.join(" ")} ${asset.mood.join(" ")} ${asset.category}`
          : `${asset.name} ${asset.fileName} ${asset.category} ${asset.loopMetadata?.genre ?? ""} ${asset.loopMetadata?.mood ?? ""} ${asset.loopMetadata?.instrument ?? ""} ${asset.loopMetadata?.key ?? ""}`;
        if (!matchesSearchQuery(haystack, query)) return false;
      }
      return true;
    });
  }, [allAssets, category, mood, query]);

  const loopFiltered = useMemo(() => {
    const minimum = minBpm.trim() ? Number(minBpm) : null;
    const maximum = maxBpm.trim() ? Number(maxBpm) : null;
    return loopAssets.filter((asset) => {
      if (!matchesFilter(asset.loopMetadata?.genre, loopGenre)) return false;
      if (!matchesFilter(asset.loopMetadata?.mood, loopMood)) return false;
      if (!matchesFilter(asset.loopMetadata?.instrument, loopInstrument)) return false;
      if (!matchesFilter(asset.loopMetadata?.key, loopKey)) return false;
      if (query.trim().length > 0) {
        const haystack = `${asset.name} ${asset.fileName} ${asset.loopMetadata?.genre ?? ""} ${asset.loopMetadata?.mood ?? ""} ${asset.loopMetadata?.instrument ?? ""} ${asset.loopMetadata?.key ?? ""} ${asset.bpm ?? ""}`;
        if (!matchesSearchQuery(haystack, query)) return false;
      }
      if (minimum !== null && (!Number.isFinite(asset.bpm) || asset.bpm! < minimum)) return false;
      if (maximum !== null && (!Number.isFinite(asset.bpm) || asset.bpm! > maximum)) return false;
      return true;
    });
  }, [loopAssets, loopGenre, loopMood, loopInstrument, loopKey, minBpm, maxBpm, query]);

  const filtered = loopView ? loopFiltered : soundFiltered;
  const sourceCount = loopView ? loopAssets.length : allAssets.length;
  const resultNoun = loopView ? (sourceCount === 1 ? "loop" : "loops") : sourceCount === 1 ? "sound" : "sounds";
  const hasActiveFilters = loopView
    ? query.trim().length > 0 ||
      loopGenre !== "all" ||
      loopMood !== "all" ||
      loopInstrument !== "all" ||
      loopKey !== "all" ||
      minBpm.trim().length > 0 ||
      maxBpm.trim().length > 0
    : query.trim().length > 0 || category !== "all" || mood !== "all";
  const filteredIds = new Set(filtered.map((asset) => asset.id));
  const recent = loopView ? [] : library.recentAssets.filter((id) => filteredIds.has(id));
  const favorites = loopView ? [] : library.favoriteAssets.filter((id) => filteredIds.has(id) && !recent.includes(id));
  const rest = filtered.filter((asset) => !recent.includes(asset.id) && !favorites.includes(asset.id));

  const apply = (id: string | null) => {
    onSelect(id);
    if (id) {
      reportLibraryFailure(services.library.recordAsset(id));
      previewAssetInContext(id);
    }
  };

  const previewAssetInContext = (assetId: string): void => {
    if (services.transport.playing) {
      services.engine.stopPreview();
      services.engine.previewAssetSynced(assetId, 1, false);
      return;
    }
    services.engine.previewAsset(assetId);
  };

  const handleImport = (asset: UserSampleAsset) => {
    setAllUserAssets((prev) => [...prev.filter((existing) => existing.id !== asset.id), asset]);
    setLoopMessage(null);
    // A sampler multi-file import is a proposal: the parent shows the
    // keyzone/RR mapping and commits it with one command after Apply. Do not
    // leak one setInstrumentSample undo entry per imported file.
    if (!onBatchImport) apply(asset.id);
  };

  const editLoopMetadata = (asset: UserSampleAsset) => {
    const metadata: LoopMetadata = asset.loopMetadata ?? {};
    setEditingLoopId(asset.id);
    setLoopDraft({
      isLoop: isLoopAsset(asset),
      bpm: Number.isFinite(asset.bpm) ? asset.bpm!.toFixed(1) : "",
      genre: metadata.genre ?? "",
      mood: metadata.mood ?? "",
      instrument: metadata.instrument ?? "",
      key: metadata.key ?? "",
    });
    setLibraryError(null);
    setLoopMessage(null);
  };

  const saveLoopMetadata = async (asset: UserSampleAsset) => {
    if (!loopDraft) return;
    const bpm = parseLoopBpm(loopDraft.bpm);
    if (bpm === null) {
      setLibraryError("Loop tempo must be between 40 and 240 BPM.");
      return;
    }
    const metadata: LoopMetadata = {
      isLoop: loopDraft.isLoop,
      genre: loopDraft.genre.trim() || undefined,
      mood: loopDraft.mood.trim() || undefined,
      instrument: loopDraft.instrument.trim() || undefined,
      key: loopDraft.key.trim() || undefined,
    };
    const updated: UserSampleAsset = { ...asset, bpm, loopMetadata: metadata };
    setSavingLoopId(asset.id);
    setLibraryError(null);
    setLoopMessage(null);
    try {
      await services.userSamples.save(updated);
      setAllUserAssets((current) => current.map((candidate) => (candidate.id === asset.id ? updated : candidate)));
      setEditingLoopId(null);
      setLoopDraft(null);
      setLoopMessage(`Tags saved for ${asset.name}.`);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "Could not save loop tags");
    } finally {
      setSavingLoopId(null);
    }
  };

  const preview = (asset: SampleAsset) => {
    if (loopView && !isFactoryAsset(asset)) {
      services.engine.stopPreview();
      if (hasValidLoopBpm(asset) && onPreviewLoop) onPreviewLoop(asset);
      else if (hasValidLoopBpm(asset)) {
        const doc = services.store.getDoc();
        const nextBeatTick = (Math.floor(services.transport.position / PPQ) + 1) * PPQ;
        const targetBpm = tempoAtTick(doc.arrangement.clips, doc.scenes, nextBeatTick, doc.bpm);
        services.engine.previewAssetSynced(asset.id, loopPreviewPlaybackRate(asset.bpm, targetBpm), true);
      } else services.engine.previewAsset(asset.id);
      return;
    }
    previewAssetInContext(asset.id);
  };

  const addLoop = async (asset: UserSampleAsset) => {
    if (!onAddLoop) return;
    setAddingLoopId(asset.id);
    setLibraryError(null);
    setLoopMessage(null);
    try {
      await onAddLoop(asset);
      setLoopMessage(`${asset.name} added to the arrangement.`);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "Could not add loop to the arrangement");
    } finally {
      setAddingLoopId(null);
    }
  };

  const installStarterPack = async () => {
    if (installLock.current) return;
    installLock.current = true;
    setInstallingStarterPack(true);
    setLibraryError(null);
    setLoopMessage(null);
    setStarterPackProgress("Preparing download…");
    try {
      await services.core.initialSampleBankHydration;
      const installed = await installKyxStarterLoops(services.bank, services.userSamples, {
        onProgress: ({ completed, total, name }) => setStarterPackProgress(`${completed}/${total} · ${name}`),
      });
      const refreshed = await services.userSamples.list();
      setAllUserAssets((current) => {
        const merged = new Map<string, UserSampleAsset>();
        for (const asset of [...refreshed, ...current, ...installed]) merged.set(asset.id, asset);
        return [...merged.values()];
      });
      setLoopMessage(
        installed.length > 0
          ? `${installed.length} original KYX loops added to your library.`
          : "KYX Starter Loops are already installed.",
      );
    } catch (error) {
      const refreshed = await services.userSamples.list().catch(() => []);
      setAllUserAssets((current) => {
        const merged = new Map<string, UserSampleAsset>();
        for (const asset of [...refreshed, ...current]) merged.set(asset.id, asset);
        return [...merged.values()];
      });
      setLibraryError(error instanceof Error ? error.message : "Could not install KYX Starter Loops");
    } finally {
      installLock.current = false;
      setInstallingStarterPack(false);
      setStarterPackProgress(null);
    }
  };

  const clearFilters = () => {
    setQuery("");
    if (loopView) {
      setLoopGenre("all");
      setLoopMood("all");
      setLoopInstrument("all");
      setLoopKey("all");
      setMinBpm("");
      setMaxBpm("");
    } else {
      setCategory("all");
      setMood("all");
    }
  };

  const renderRow = (asset: SampleAsset, fav: boolean) => {
    const userAsset = isFactoryAsset(asset) ? null : asset;
    const soundCharacter = isFactoryAsset(asset) ? asset.character : null;
    const isEditing = userAsset !== null && editingLoopId === userAsset.id;
    return (
      <div key={asset.id} className="sample-result">
        <div
          className={`sample-row${asset.id === currentId ? " active" : ""}`}
          draggable
          onDragStart={(event) => {
            // FL lesson (V4): sounds are dragged onto their destination — the
            // sequencer's drum rows and the instrument track tabs. text/plain
            // carries the id as a fallback for hosts that drop custom MIME types.
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData(KYX_SAMPLE_MIME, asset.id);
            event.dataTransfer.setData("text/plain", asset.id);
          }}
          title="Drag onto a drum row or an instrument track to assign"
        >
          <button
            type="button"
            className="sample-preview"
            title={
              loopView && userAsset && hasValidLoopBpm(userAsset)
                ? "Preview matched to project tempo"
                : "Preview now while stopped, or on the next beat over the mix while playing"
            }
            aria-label={
              loopView && userAsset && hasValidLoopBpm(userAsset)
                ? `Preview loop in project tempo ${asset.name}`
                : `Preview ${asset.name} in the current mix (next beat while playing)`
            }
            onClick={() => preview(asset)}
          >
            ▶
          </button>
          <button
            type="button"
            className="sample-name"
            title={
              isFactoryAsset(asset) ? `${asset.character} — click to assign` : `${asset.fileName} — click to assign`
            }
            onClick={() => apply(asset.id)}
          >
            {asset.name}
          </button>
          {soundCharacter && (
            <span className="sample-character" title={soundCharacter}>
              {soundCharacter}
            </span>
          )}
          {userAsset && hasValidLoopBpm(userAsset) && (
            <span className="sample-bpm" title="Detected tempo in BPM">
              {Math.round(userAsset.bpm)} BPM
            </span>
          )}
          {loopView && userAsset && onAddLoop && (
            <button
              type="button"
              className="sample-add-loop"
              disabled={addingLoopId !== null}
              aria-label={`Add ${asset.name} to arrangement`}
              onClick={() => void addLoop(userAsset)}
            >
              {addingLoopId === userAsset.id ? "Adding…" : "Add"}
            </button>
          )}
          {isFactoryAsset(asset) ? (
            <button
              type="button"
              className={`sample-fav${fav ? " active" : ""}`}
              title={fav ? "Remove from favorites" : "Add to favorites"}
              aria-label={fav ? `Unfavorite ${asset.name}` : `Favorite ${asset.name}`}
              aria-pressed={fav}
              onClick={() => reportLibraryFailure(services.library.toggleAssetFavorite(asset.id))}
            >
              {fav ? "♥" : "♡"}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="sample-edit-loop"
                aria-label={`Edit loop tags for ${asset.name}`}
                title="Edit loop metadata"
                onClick={() => editLoopMetadata(asset)}
              >
                Tags
              </button>
              <button
                type="button"
                className="sample-delete"
                title="Remove user sample"
                aria-label={`Remove ${asset.name}`}
                onClick={() => {
                  void services.userSamples.remove(asset.id);
                  setAllUserAssets((prev) => prev.filter((candidate) => candidate.id !== asset.id));
                }}
              >
                ×
              </button>
            </>
          )}
        </div>
        {isEditing && userAsset && loopDraft && (
          <div className="loop-tag-editor" aria-label={`Loop tags for ${userAsset.name}`}>
            <label className="loop-tag-checkbox">
              <input
                type="checkbox"
                checked={loopDraft.isLoop}
                onChange={(event) => setLoopDraft({ ...loopDraft, isLoop: event.target.checked })}
              />
              Include in loop browser
            </label>
            <label className="loop-tag-field">
              <span>Tempo (BPM)</span>
              <input
                type="number"
                min={40}
                max={240}
                step={0.1}
                value={loopDraft.bpm}
                aria-label="Loop tempo BPM"
                aria-invalid={parseLoopBpm(loopDraft.bpm) === null}
                onChange={(event) => setLoopDraft({ ...loopDraft, bpm: event.target.value })}
              />
            </label>
            {parseLoopBpm(loopDraft.bpm) === null && (
              <span className="loop-tag-error" role="alert">
                Enter a tempo from 40 to 240 BPM.
              </span>
            )}
            {(
              [
                ["genre", "Genre"],
                ["mood", "Mood"],
                ["instrument", "Instrument"],
                ["key", "Key"],
              ] as const
            ).map(([field, label]) => (
              <label key={field} className="loop-tag-field">
                <span>{label}</span>
                <input
                  value={loopDraft[field]}
                  maxLength={48}
                  aria-label={label}
                  onChange={(event) => setLoopDraft({ ...loopDraft, [field]: event.target.value })}
                />
              </label>
            ))}
            <div className="loop-tag-actions">
              <button
                type="button"
                className="preset-chip"
                disabled={savingLoopId === userAsset.id || parseLoopBpm(loopDraft.bpm) === null}
                onClick={() => void saveLoopMetadata(userAsset)}
              >
                {savingLoopId === userAsset.id ? "SAVING…" : "SAVE TAGS"}
              </button>
              <button
                type="button"
                className="preset-chip"
                disabled={savingLoopId === userAsset.id}
                onClick={() => {
                  setEditingLoopId(null);
                  setLoopDraft(null);
                }}
              >
                CANCEL
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const selectFilter = (label: string, value: string, values: string[], onChange: (value: string) => void) => {
    const matchingValue = values.find((option) => normalizedText(option) === normalizedText(value));
    const selectedValue = value === "all" ? "all" : (matchingValue ?? value);
    return (
      <label className="loop-filter">
        <span>{label}</span>
        <select
          aria-label={`Filter by ${label.toLocaleLowerCase()}`}
          value={selectedValue}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="all">All</option>
          {!matchingValue && value !== "all" && <option value={value}>{value}</option>}
          {values.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <div className="sample-browser">
      {showDropZone && <DropZone onImport={handleImport} onBatchImport={onBatchImport} />}
      {showDropZone && <FreesoundSection onImport={handleImport} />}
      {showDropZone && <IntakeTray onImported={handleImport} />}
      <div className="sample-view-tabs" aria-label="Sound browser view">
        <button
          type="button"
          aria-pressed={!loopView}
          className={!loopView ? "active" : ""}
          onClick={() => setLoopView(false)}
        >
          SOUNDS
        </button>
        <button
          type="button"
          aria-pressed={loopView}
          className={loopView ? "active" : ""}
          onClick={() => setLoopView(true)}
        >
          LOOPS <span>{loopAssets.length}</span>
        </button>
      </div>
      <input
        className="preset-search"
        value={query}
        placeholder={loopView ? "Search loops and tags…" : "Search sounds…"}
        aria-label={loopView ? "Search loops" : "Search samples"}
        onChange={(event) => setQuery(event.target.value)}
      />
      {libraryError && (
        <div className="sample-library-error" role="status" aria-live="polite">
          {libraryError}
        </div>
      )}
      {loopMessage && (
        <div className="sample-loop-message" role="status" aria-live="polite">
          {loopMessage}
        </div>
      )}
      {loopView && (
        <section className="sample-starter-pack" aria-label="KYX Starter Loops pack">
          <div>
            <strong>KYX STARTER LOOPS</strong>
            <span>8 original four-bar loops · 4.9 MB · install once for offline use</span>
          </div>
          <button
            type="button"
            className="btn btn-small"
            disabled={installingStarterPack}
            onClick={() => void installStarterPack()}
          >
            {installingStarterPack
              ? "INSTALLING…"
              : starterPackInstalledCount >= 8
                ? "INSTALLED"
                : starterPackInstalledCount > 0
                  ? `ADD ${8 - starterPackInstalledCount} MISSING`
                  : "INSTALL PACK"}
          </button>
          {starterPackProgress && (
            <span className="sample-starter-pack-progress" role="status">
              {starterPackProgress}
            </span>
          )}
        </section>
      )}
      {!loopView ? (
        <>
          <div className="preset-chips">
            <button
              type="button"
              className={`preset-chip${category === "all" ? " active" : ""}`}
              onClick={() => setCategory("all")}
            >
              ALL
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                aria-pressed={category === cat}
                className={`preset-chip${category === cat ? " active" : ""}`}
                style={
                  category === cat
                    ? { borderColor: categoryColor(cat as any), color: categoryColor(cat as any) }
                    : undefined
                }
                onClick={() => setCategory(cat)}
              >
                {cat.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="preset-chips">
            {ASSET_MOODS.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mood === m}
                className={`preset-chip${mood === m ? " active" : ""}`}
                onClick={() => setMood(mood === m ? "all" : m)}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="loop-browser-filters" aria-label="Loop filters">
          {selectFilter("Genre", loopGenre, genres, setLoopGenre)}
          {selectFilter("Mood", loopMood, loopMoods, setLoopMood)}
          {selectFilter("Instrument", loopInstrument, instruments, setLoopInstrument)}
          {selectFilter("Key", loopKey, keys, setLoopKey)}
          <label className="loop-filter">
            <span>Min BPM</span>
            <input
              type="number"
              min="40"
              max="240"
              value={minBpm}
              aria-label="Minimum BPM"
              onChange={(e) => setMinBpm(e.target.value)}
            />
          </label>
          <label className="loop-filter">
            <span>Max BPM</span>
            <input
              type="number"
              min="40"
              max="240"
              value={maxBpm}
              aria-label="Maximum BPM"
              onChange={(e) => setMaxBpm(e.target.value)}
            />
          </label>
        </div>
      )}
      {loopView && loopStarter && (
        <p className="sample-loop-starter-hint">
          {loopStarter.genre} · {loopStarter.mood ?? "any mood"} · {loopStarter.bpm} BPM. Choose a key above, preview at
          project tempo, then add loops as editable arrangement clips.
        </p>
      )}

      <div className="sample-result-summary">
        <span role="status">
          {filtered.length} of {sourceCount} {resultNoun}
        </span>
        {hasActiveFilters && (
          <button type="button" className="sample-clear-filters" onClick={clearFilters}>
            Clear {loopView ? "loop" : "sound"} filters
          </button>
        )}
      </div>

      <div className="sample-list">
        {!loopView && allowNone && (
          <div className={`sample-row${currentId === null ? " active" : ""}`}>
            <span className="sample-preview sample-preview-none" />
            <button type="button" className="sample-name sample-name-none" onClick={() => apply(null)}>
              — none —
            </button>
          </div>
        )}
        {recent.length > 0 && (
          <>
            <div className="sample-group-label">RECENT</div>
            {recent.map((id) => {
              const asset = allAssets.find((candidate) => candidate.id === id);
              return asset ? renderRow(asset, library.favoriteAssets.includes(id)) : null;
            })}
          </>
        )}
        {favorites.length > 0 && (
          <>
            <div className="sample-group-label">FAVORITES</div>
            {favorites.map((id) => {
              const asset = allAssets.find((candidate) => candidate.id === id);
              return asset ? renderRow(asset, true) : null;
            })}
          </>
        )}
        {(rest.length > 0 || (loopView && rest.length === 0)) && (
          <div className="sample-group-label">{loopView ? "LOOPS" : "LIBRARY"}</div>
        )}
        {rest.length === 0 && (
          <div className="sample-empty">
            <span className="sample-empty-icon" aria-hidden="true">
              🔍
            </span>
            {loopView
              ? loopAssets.length > 0
                ? "No loops match. Try another filter or clear the search."
                : "No loops yet. Import an audio loop, then add its tags from the Sounds list."
              : allAssets.length > 0
                ? "No sounds match. Try another category or clear the search."
                : "Drop audio files above to import."}
          </div>
        )}
        {rest.map((asset) => renderRow(asset, library.favoriteAssets.includes(asset.id)))}
      </div>
    </div>
  );
}
