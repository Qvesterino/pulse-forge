import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLibrary, useServices } from "./context";
import type { FactoryAsset } from "../sample-library/manifest";
import { FACTORY_ASSETS } from "../sample-library/manifest";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";
import { PPQ } from "../project-model/types";
import { tempoAtTick } from "../project-model/scene-time";
import { ticksPerBar } from "../project-model/schema";
import { loopPreviewPlaybackRate } from "../audio-engine/loopTempo";
import { categoryColor } from "./kitColors";
import { DropZone } from "./DropZone";
import { IntakeTray } from "./IntakeTray";
import { FreesoundSection } from "./FreesoundSection";
import type { SongStarterHandoff } from "../landing/handoff";
import { installKyxStarterLoops } from "../sample-library/kyx-starter-loops";
import type { SampleLayer, Track } from "../project-model/types";
import {
  projectSoundContext,
  projectSoundGenreOptions,
  projectSoundMoodOptions,
  rankByProjectSoundFit,
  type SoundFitDescriptor,
} from "../sample-library/projectFit";
import { autoMapVelocityLayers } from "../samples/autoMap";
import { setVelocityLayersCommand } from "../commands/layerCommands";
import { ensureFactorySamples } from "../sample-library/factory";
import { ensurePianoPackLoaded, isPianoPackSample } from "../presets/piano-pack";
import type { InstrumentPreset } from "../presets/types";
import { KitAuditionBrowser } from "./KitAuditionBrowser";

const PresetBrowser = lazy(() => import("./PresetBrowser").then((m) => ({ default: m.PresetBrowser })));

/** Unified asset type — factory or user-imported. */
export type SampleAsset = FactoryAsset | UserSampleAsset;

/** MIME type carrying a sample asset id in drag&drop (ROADMAP-UI-2027 V4).
 *  Drop targets: sequencer drum rows (pad asset) and instrument track tabs.
 *
 *  The constant and its reader live in ./sample-browser-contract — a leaf
 *  module — so that the boot path (TrackTabs, Sequencer) can name them
 *  without pulling this whole browser into the static closure. They are
 *  re-exported here so the browser's public API is unchanged. */
import { KYX_SAMPLE_MIME, sampleIdFromDrag } from "./sample-browser-contract";
export { KYX_SAMPLE_MIME, sampleIdFromDrag };

type CategoryFilter = "all" | string;
type LoopMetadata = NonNullable<UserSampleAsset["loopMetadata"]>;
type LoopDraft = { isLoop: boolean; bpm: string; genre: string; mood: string; instrument: string; key: string };
type BrowserView = "sounds" | "loops" | "presets";

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

function soundFitDescriptor(asset: SampleAsset): SoundFitDescriptor {
  return isFactoryAsset(asset)
    ? { genres: asset.tags, moods: asset.mood }
    : {
        genres: asset.loopMetadata?.genre ? [asset.loopMetadata.genre] : [],
        moods: asset.loopMetadata?.mood ? [asset.loopMetadata.mood] : [],
        bpm: asset.bpm,
        key: asset.loopMetadata?.key,
      };
}

function loopFitDescriptor(asset: UserSampleAsset): SoundFitDescriptor {
  return {
    genres: asset.loopMetadata?.genre ? [asset.loopMetadata.genre] : [],
    moods: asset.loopMetadata?.mood ? [asset.loopMetadata.mood] : [],
    bpm: asset.bpm,
    key: asset.loopMetadata?.key,
  };
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
  view: controlledView,
  onViewChange,
  targetTrack = null,
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
  view?: BrowserView;
  onViewChange?: (view: BrowserView) => void;
  targetTrack?: Track | null;
}) {
  const services = useServices();
  const library = useLibrary();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [genre, setGenre] = useState(() => loopStarter?.genre ?? "all");
  const [mood, setMood] = useState(() => loopStarter?.mood ?? "all");
  const [internalView, setInternalView] = useState<BrowserView>(() => (loopStarter ? "loops" : "sounds"));
  const view = controlledView ?? internalView;
  const setView = (nextView: BrowserView) => {
    if (onViewChange) onViewChange(nextView);
    else setInternalView(nextView);
  };
  const [loopInstrument, setLoopInstrument] = useState("all");
  const [loopKey, setLoopKey] = useState("all");
  const [minBpm, setMinBpm] = useState(() =>
    loopStarter ? String(Math.max(40, Math.floor(loopStarter.bpm * 0.9))) : "",
  );
  const [maxBpm, setMaxBpm] = useState(() =>
    loopStarter ? String(Math.min(240, Math.ceil(loopStarter.bpm * 1.1))) : "",
  );
  const [allUserAssets, setAllUserAssets] = useState<UserSampleAsset[]>(userAssets);
  const [playheadTick, setPlayheadTick] = useState(() => services.transport.position);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [loopMessage, setLoopMessage] = useState<string | null>(null);
  const [editingLoopId, setEditingLoopId] = useState<string | null>(null);
  const [loopDraft, setLoopDraft] = useState<LoopDraft | null>(null);
  const [savingLoopId, setSavingLoopId] = useState<string | null>(null);
  const [addingLoopId, setAddingLoopId] = useState<string | null>(null);
  const [installingStarterPack, setInstallingStarterPack] = useState(false);
  const [starterPackProgress, setStarterPackProgress] = useState<string | null>(null);
  const [pendingSamplerMapping, setPendingSamplerMapping] = useState<SampleLayer[] | null>(null);
  const [mappingBusy, setMappingBusy] = useState(false);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const installLock = useRef(false);
  const starterPackAutoInstallStarted = useRef(false);
  const starterPackInstalledCount = allUserAssets.filter(
    (asset) => asset.factoryPack?.id === "kyx-starter-loops",
  ).length;
  const loopView = view === "loops";
  const presetView = view === "presets";
  const doc = services.store.getDoc();
  const effectiveBpm = tempoAtTick(doc.arrangement.clips, doc.scenes, playheadTick, doc.bpm, ticksPerBar(doc));
  const fitContext = useMemo(() => projectSoundContext(doc, effectiveBpm), [doc, effectiveBpm]);

  useEffect(() => {
    let frame = 0;
    let lastSampleAt = 0;
    let active = false;
    const stop = services.transport.subscribePlaying((playing) => {
      active = playing;
      if (!playing) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        setPlayheadTick(services.transport.position);
      } else if (!frame) {
        const update = (time: number) => {
          if (!active) return;
          if (time - lastSampleAt >= 120) {
            lastSampleAt = time;
            const position = services.transport.position;
            setPlayheadTick((current) =>
              Math.floor(position / PPQ) === Math.floor(current / PPQ) ? current : position,
            );
          }
          frame = requestAnimationFrame(update);
        };
        frame = requestAnimationFrame(update);
      }
    });
    return () => {
      stop();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [services]);

  useEffect(() => {
    setPendingSamplerMapping(null);
    setMappingError(null);
  }, [targetTrack?.id]);

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
  const soundAssets = useMemo(
    () => allAssets.filter((asset) => isFactoryAsset(asset) || !isLoopAsset(asset)),
    [allAssets],
  );
  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const asset of soundAssets) seen.add(asset.category);
    return [...seen];
  }, [soundAssets]);
  const genres = useMemo(() => uniqueMetadataValues(loopAssets, "genre"), [loopAssets]);
  const instruments = useMemo(() => uniqueMetadataValues(loopAssets, "instrument"), [loopAssets]);
  const keys = useMemo(() => uniqueMetadataValues(loopAssets, "key"), [loopAssets]);
  const projectTags = [
    ...(doc.tags ?? []),
    ...(doc.producerBrief?.facts ?? []).flatMap((fact) => (typeof fact.value === "string" ? [fact.value] : [])),
    ...genres,
    ...uniqueMetadataValues(loopAssets, "mood"),
  ];
  const loopMoods = uniqueMetadataValues(loopAssets, "mood");
  const genreOptions = useMemo(() => {
    const values = new Map(projectSoundGenreOptions(projectTags).map((value) => [normalizedText(value), value]));
    for (const value of genres) values.set(normalizedText(value), value);
    return [...values.values()].sort((a, b) => a.localeCompare(b));
    // `projectTags` is assembled from stable project and library values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.tags, doc.producerBrief, genres.join("|")]);
  const moodOptions = useMemo(() => {
    const values = new Map(projectSoundMoodOptions(projectTags).map((value) => [normalizedText(value), value]));
    for (const value of loopMoods) values.set(normalizedText(value), value);
    return [...values.values()].sort((a, b) => a.localeCompare(b));
  }, [doc.tags, doc.producerBrief, loopMoods.join("|")]);

  const soundFiltered = useMemo(() => {
    return rankByProjectSoundFit(
      soundAssets.filter((asset) => {
        if (category !== "all" && asset.category !== category) return false;
        const descriptor = soundFitDescriptor(asset);
        if (
          genre !== "all" &&
          !(descriptor.genres ?? []).some((value) => normalizedText(value) === normalizedText(genre))
        ) {
          return false;
        }
        if (mood !== "all") {
          if (!(descriptor.moods ?? []).some((value) => normalizedText(value) === normalizedText(mood))) return false;
        }
        if (query.trim().length > 0) {
          const haystack = isFactoryAsset(asset)
            ? `${asset.name} ${asset.character} ${asset.tags.join(" ")} ${asset.mood.join(" ")} ${asset.category}`
            : `${asset.name} ${asset.fileName} ${asset.category} ${asset.loopMetadata?.genre ?? ""} ${asset.loopMetadata?.mood ?? ""} ${asset.loopMetadata?.instrument ?? ""} ${asset.loopMetadata?.key ?? ""}`;
          if (!matchesSearchQuery(haystack, query)) return false;
        }
        return true;
      }),
      soundFitDescriptor,
      fitContext,
    );
  }, [soundAssets, category, genre, mood, query, fitContext]);

  const loopFiltered = useMemo(() => {
    const minimum = minBpm.trim() ? Number(minBpm) : null;
    const maximum = maxBpm.trim() ? Number(maxBpm) : null;
    return rankByProjectSoundFit(
      loopAssets.filter((asset) => {
        if (!matchesFilter(asset.loopMetadata?.genre, genre)) return false;
        if (!matchesFilter(asset.loopMetadata?.mood, mood)) return false;
        if (!matchesFilter(asset.loopMetadata?.instrument, loopInstrument)) return false;
        if (!matchesFilter(asset.loopMetadata?.key, loopKey)) return false;
        if (query.trim().length > 0) {
          const haystack = `${asset.name} ${asset.fileName} ${asset.loopMetadata?.genre ?? ""} ${asset.loopMetadata?.mood ?? ""} ${asset.loopMetadata?.instrument ?? ""} ${asset.loopMetadata?.key ?? ""} ${asset.bpm ?? ""}`;
          if (!matchesSearchQuery(haystack, query)) return false;
        }
        if (minimum !== null && (!Number.isFinite(asset.bpm) || asset.bpm! < minimum)) return false;
        if (maximum !== null && (!Number.isFinite(asset.bpm) || asset.bpm! > maximum)) return false;
        return true;
      }),
      loopFitDescriptor,
      fitContext,
    );
  }, [loopAssets, genre, mood, loopInstrument, loopKey, minBpm, maxBpm, query, fitContext]);

  const filtered = loopView ? loopFiltered : soundFiltered;
  const sourceCount = loopView ? loopAssets.length : soundAssets.length;
  const resultNoun = loopView ? (sourceCount === 1 ? "loop" : "loops") : sourceCount === 1 ? "sound" : "sounds";
  const hasActiveFilters =
    query.trim().length > 0 ||
    genre !== "all" ||
    mood !== "all" ||
    (loopView
      ? loopInstrument !== "all" || loopKey !== "all" || minBpm.trim().length > 0 || maxBpm.trim().length > 0
      : category !== "all");
  const filteredIds = new Set(filtered.map((asset) => asset.id));
  const recent = presetView
    ? []
    : rankByProjectSoundFit(
        library.recentAssets
          .filter((id) => filteredIds.has(id))
          .flatMap((id) => {
            const asset = filtered.find((candidate) => candidate.id === id);
            return asset ? [asset] : [];
          }),
        loopView
          ? (asset) => ({
              genres: !isFactoryAsset(asset) && asset.loopMetadata?.genre ? [asset.loopMetadata.genre] : [],
              moods: !isFactoryAsset(asset) && asset.loopMetadata?.mood ? [asset.loopMetadata.mood] : [],
              bpm: !isFactoryAsset(asset) ? asset.bpm : undefined,
              key: !isFactoryAsset(asset) ? asset.loopMetadata?.key : undefined,
            })
          : soundFitDescriptor,
        fitContext,
      ).map((asset) => asset.id);
  const favorites = presetView
    ? []
    : rankByProjectSoundFit(
        library.favoriteAssets
          .filter((id) => filteredIds.has(id) && !recent.includes(id))
          .flatMap((id) => {
            const asset = filtered.find((candidate) => candidate.id === id);
            return asset ? [asset] : [];
          }),
        loopView
          ? (asset) => ({
              genres: !isFactoryAsset(asset) && asset.loopMetadata?.genre ? [asset.loopMetadata.genre] : [],
              moods: !isFactoryAsset(asset) && asset.loopMetadata?.mood ? [asset.loopMetadata.mood] : [],
              bpm: !isFactoryAsset(asset) ? asset.bpm : undefined,
              key: !isFactoryAsset(asset) ? asset.loopMetadata?.key : undefined,
            })
          : soundFitDescriptor,
        fitContext,
      ).map((asset) => asset.id);
  const rest = rankByProjectSoundFit(
    filtered.filter((asset) => !recent.includes(asset.id) && !favorites.includes(asset.id)),
    loopView ? (asset) => (isFactoryAsset(asset) ? {} : loopFitDescriptor(asset)) : soundFitDescriptor,
    fitContext,
  );

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
    if (!onBatchImport && !(targetTrack?.kind === "instrument" && targetTrack.instrument === "sampler")) {
      apply(asset.id);
    }
  };

  const handleSamplerBatchImport = (imported: UserSampleAsset[]) => {
    if (onBatchImport) {
      onBatchImport(imported);
      return;
    }
    if (targetTrack?.kind !== "instrument" || targetTrack.instrument !== "sampler") return;
    const layers = autoMapVelocityLayers(imported.map((asset) => ({ sampleId: asset.id, name: asset.fileName })));
    if (layers.length > 1) {
      setPendingSamplerMapping(layers);
      setMappingError(null);
      setView("sounds");
    }
  };

  const commitSamplerMapping = () => {
    if (!pendingSamplerMapping || targetTrack?.kind !== "instrument" || targetTrack.instrument !== "sampler") return;
    setMappingBusy(true);
    try {
      const currentDoc = services.store.getDoc();
      const first = pendingSamplerMapping[0]?.sampleId ?? null;
      services.store.execute(setVelocityLayersCommand(currentDoc, targetTrack.id, pendingSamplerMapping, first));
      setPendingSamplerMapping(null);
      setMappingError(null);
    } catch (error) {
      setMappingError(error instanceof Error ? error.message : "Could not apply sampler mapping");
    } finally {
      setMappingBusy(false);
    }
  };

  const preloadPresetSamples = async (preset: InstrumentPreset): Promise<void> => {
    await services.core.initialSampleBankHydration;
    const sampleIds = [
      ...new Set([preset.sampleId, ...(preset.velocityLayers ?? []).map((layer) => layer.sampleId)]),
    ].filter((id): id is string => Boolean(id));
    const pianoIds = sampleIds.filter(isPianoPackSample);
    if (pianoIds.length > 0) await ensurePianoPackLoaded(services.bank, pianoIds);
    const factoryIds = sampleIds.filter((id) => FACTORY_ASSETS.some((asset) => asset.id === id));
    if (factoryIds.length > 0) await ensureFactorySamples(services.bank, factoryIds);
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
    reportLibraryFailure(services.library.recordAsset(asset.id));
    if (loopView && !isFactoryAsset(asset)) {
      services.engine.stopPreview();
      if (hasValidLoopBpm(asset) && onPreviewLoop) onPreviewLoop(asset);
      else if (hasValidLoopBpm(asset)) {
        const doc = services.store.getDoc();
        const nextBeatTick = (Math.floor(services.transport.position / PPQ) + 1) * PPQ;
        const targetBpm = tempoAtTick(doc.arrangement.clips, doc.scenes, nextBeatTick, doc.bpm, ticksPerBar(doc));
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

  const installStarterPack = useCallback(async () => {
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
  }, [services]);

  // A guided starter lands directly in its filtered loop browser. Prepare the
  // small original pack there so the user can preview a loop without a second
  // setup decision; the existing button remains available for retries.
  useEffect(() => {
    if (!loopStarter || starterPackAutoInstallStarted.current) return;
    starterPackAutoInstallStarted.current = true;
    void installStarterPack();
  }, [installStarterPack, loopStarter]);

  const clearFilters = () => {
    setQuery("");
    setGenre("all");
    setMood("all");
    if (loopView) {
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
                className={`sample-fav${fav ? " active" : ""}`}
                title={fav ? "Remove from favorites" : "Add to favorites"}
                aria-label={fav ? `Unfavorite ${asset.name}` : `Favorite ${asset.name}`}
                aria-pressed={fav}
                onClick={() => reportLibraryFailure(services.library.toggleAssetFavorite(asset.id))}
              >
                {fav ? "♥" : "♡"}
              </button>
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
      {showDropZone && (
        <DropZone
          onImport={handleImport}
          onBatchImport={
            onBatchImport ??
            (targetTrack?.kind === "instrument" && targetTrack.instrument === "sampler"
              ? handleSamplerBatchImport
              : undefined)
          }
        />
      )}
      {showDropZone && <FreesoundSection onImport={handleImport} />}
      {showDropZone && <IntakeTray onImported={handleImport} />}
      <div className="sample-view-tabs" aria-label="Sound browser view">
        <button
          type="button"
          aria-pressed={view === "sounds"}
          className={view === "sounds" ? "active" : ""}
          onClick={() => setView("sounds")}
        >
          SOUNDS
        </button>
        <button
          type="button"
          aria-pressed={view === "loops"}
          className={view === "loops" ? "active" : ""}
          onClick={() => setView("loops")}
        >
          LOOPS <span>{loopAssets.length}</span>
        </button>
        <button
          type="button"
          aria-pressed={presetView}
          className={presetView ? "active" : ""}
          onClick={() => setView("presets")}
        >
          PRESETS
        </button>
      </div>
      <input
        className="preset-search"
        value={query}
        placeholder={loopView ? "Search loops and tags…" : presetView ? "Search presets…" : "Search sounds…"}
        aria-label={loopView ? "Search loops" : presetView ? "Search presets" : "Search samples"}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="loop-browser-filters sample-shared-filters" aria-label="Shared sound filters">
        {selectFilter("Genre", genre, genreOptions, setGenre)}
        {selectFilter("Mood", mood, moodOptions, setMood)}
      </div>
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
      {view === "sounds" ? (
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
        </>
      ) : loopView ? (
        <div className="loop-browser-filters" aria-label="Loop-specific filters">
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
      ) : null}
      {loopView && loopStarter && (
        <p className="sample-loop-starter-hint">
          {loopStarter.genre} · {loopStarter.mood ?? "any mood"} · {loopStarter.bpm} BPM. Choose a key above, preview at
          project tempo, then add loops as editable arrangement clips.
        </p>
      )}

      {presetView ? (
        targetTrack?.kind === "instrument" ? (
          <Suspense fallback={<div className="panel-loading">Loading presets…</div>}>
            <PresetBrowser
              track={targetTrack}
              query={query}
              genre={genre}
              mood={mood}
              projectContext={fitContext}
              preloadPresetSamples={preloadPresetSamples}
            />
          </Suspense>
        ) : (
          <div className="sample-empty">Select an instrument track to browse its presets.</div>
        )
      ) : (
        <>
          {pendingSamplerMapping && targetTrack?.kind === "instrument" && targetTrack.instrument === "sampler" && (
            <div className="sampler-map-preview" role="dialog" aria-label="Sampler mapping preview">
              <div className="sampler-map-preview-heading">
                <strong>MAP PREVIEW</strong>
                <span>
                  {pendingSamplerMapping.length} layers ·{" "}
                  {
                    new Set(pendingSamplerMapping.map((layer) => `${layer.minPitch ?? 0}-${layer.maxPitch ?? 127}`))
                      .size
                  }{" "}
                  keyzones
                </span>
              </div>
              <p>
                Imported samples are ready. Preview the first zone, then Apply to commit one undoable sampler mapping.
              </p>
              {mappingError && (
                <span className="loop-tag-error" role="alert">
                  {mappingError}
                </span>
              )}
              <div className="sampler-map-preview-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    const first = pendingSamplerMapping[0]?.sampleId;
                    if (first) services.engine.previewAsset(first);
                  }}
                >
                  PREVIEW
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={mappingBusy}
                  onClick={() => setPendingSamplerMapping(null)}
                >
                  CANCEL
                </button>
                <button
                  type="button"
                  className="btn btn-small active"
                  disabled={mappingBusy}
                  onClick={commitSamplerMapping}
                >
                  {mappingBusy ? "APPLYING…" : "APPLY MAP"}
                </button>
              </div>
            </div>
          )}
          {view === "sounds" && targetTrack?.kind === "drum" && (
            <KitAuditionBrowser
              key={targetTrack.id}
              track={targetTrack}
              query={query}
              genre={genre}
              mood={mood}
              projectContext={fitContext}
            />
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
        </>
      )}
    </div>
  );
}
