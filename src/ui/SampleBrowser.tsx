import { useEffect, useMemo, useState } from "react";
import { useLibrary, useServices } from "./context";
import type { FactoryAsset } from "../sample-library/manifest";
import { ASSET_MOODS } from "../sample-library/manifest";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";
import { categoryColor } from "./kitColors";
import { DropZone } from "./DropZone";
import { IntakeTray } from "./IntakeTray";
import { FreesoundSection } from "./FreesoundSection";

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

function isFactoryAsset(a: SampleAsset): a is FactoryAsset {
  return "character" in a;
}

export function SampleBrowser({
  assets,
  userAssets = [],
  currentId,
  onSelect,
  allowNone = true,
  showDropZone = false,
  onBatchImport,
}: {
  assets: FactoryAsset[];
  userAssets?: UserSampleAsset[];
  currentId: string | null;
  onSelect: (assetId: string | null) => void;
  allowNone?: boolean;
  showDropZone?: boolean;
  onBatchImport?: (assets: UserSampleAsset[]) => void;
}) {
  const services = useServices();
  const library = useLibrary();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [mood, setMood] = useState<MoodFilter>("all");
  const [allUserAssets, setAllUserAssets] = useState<UserSampleAsset[]>(userAssets);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  const reportLibraryFailure = (operation: Promise<unknown> | void): void => {
    setLibraryError(null);
    void Promise.resolve(operation).catch((error: unknown) => {
      setLibraryError(error instanceof Error ? error.message : "Could not save library preferences");
    });
  };

  // Load user samples from repo on mount
  useEffect(() => {
    let cancelled = false;
    void services.userSamples.list().then((assets) => {
      // setState on an unmounted component is a no-op in modern React but
      // is still observable as a warning under StrictMode + React DevTools.
      // The cancelled flag keeps the closure explicit about which async
      // result still belongs to this mount cycle.
      if (!cancelled) setAllUserAssets(assets);
    });
    return () => {
      cancelled = true;
    };
  }, [services]);

  const allAssets: SampleAsset[] = useMemo(() => [...assets, ...allUserAssets], [assets, allUserAssets]);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const asset of allAssets) seen.add(asset.category);
    return [...seen];
  }, [allAssets]);

  const filtered = useMemo(() => {
    return allAssets.filter((asset) => {
      if (category !== "all" && asset.category !== category) return false;
      if (mood !== "all" && isFactoryAsset(asset) && !asset.mood.includes(mood)) return false;
      if (query.trim().length > 0) {
        const q = query.trim().toLowerCase();
        const haystack = isFactoryAsset(asset)
          ? `${asset.name} ${asset.character} ${asset.tags.join(" ")} ${asset.category}`.toLowerCase()
          : `${asset.name} ${asset.fileName} ${asset.category}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [allAssets, category, mood, query]);

  const filteredIds = new Set(filtered.map((a) => a.id));
  const recent = library.recentAssets.filter((id) => filteredIds.has(id));
  const favorites = library.favoriteAssets.filter((id) => filteredIds.has(id) && !recent.includes(id));
  const rest = filtered.filter((a) => !recent.includes(a.id) && !favorites.includes(a.id));

  const apply = (id: string | null) => {
    onSelect(id);
    if (id) {
      reportLibraryFailure(services.library.recordAsset(id));
      services.engine.previewAsset(id);
    }
  };

  const handleImport = (asset: UserSampleAsset) => {
    setAllUserAssets((prev) => [...prev, asset]);
    // A sampler multi-file import is a proposal: the parent shows the
    // keyzone/RR mapping and commits it with one command after Apply. Do not
    // leak one setInstrumentSample undo entry per imported file.
    if (!onBatchImport) apply(asset.id);
  };

  const Row = ({ asset, fav }: { asset: SampleAsset; fav: boolean }) => (
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
      title="Drag onto a drum row or an instrument track to assign · click ▶ to preview"
    >
      <button
        type="button"
        className="sample-preview"
        title="Preview"
        aria-label={`Preview ${asset.name}`}
        onClick={() => services.engine.previewAsset(asset.id)}
      >
        ▶
      </button>
      <button
        type="button"
        className="sample-name"
        title={isFactoryAsset(asset) ? `${asset.character} — click to assign` : `${asset.fileName} — click to assign`}
        onClick={() => apply(asset.id)}
      >
        {asset.name}
      </button>
      {!isFactoryAsset(asset) && asset.bpm !== undefined && (
        <span className="sample-bpm" title={`Detected tempo — use "Fit to project BPM" on an audio clip`}>
          {Math.round(asset.bpm)}
        </span>
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
        <button
          type="button"
          className="sample-delete"
          title="Remove user sample"
          aria-label={`Remove ${asset.name}`}
          onClick={() => {
            void services.userSamples.remove(asset.id);
            setAllUserAssets((prev) => prev.filter((a) => a.id !== asset.id));
          }}
        >
          ×
        </button>
      )}
    </div>
  );

  return (
    <div className="sample-browser">
      {showDropZone && <DropZone onImport={handleImport} onBatchImport={onBatchImport} />}
      {showDropZone && <FreesoundSection onImport={handleImport} />}
      {showDropZone && <IntakeTray onImported={handleImport} />}
      <input
        className="preset-search"
        value={query}
        placeholder="Search sounds…"
        aria-label="Search samples"
        onChange={(event) => setQuery(event.target.value)}
      />
      {libraryError && (
        <div className="sample-library-error" role="status" aria-live="polite">
          {libraryError}
        </div>
      )}
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
            className={`preset-chip${mood === m ? " active" : ""}`}
            onClick={() => setMood(mood === m ? "all" : m)}
          >
            {m.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="sample-list">
        {allowNone && (
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
              const asset = allAssets.find((a) => a.id === id);
              return asset ? <Row key={id} asset={asset} fav={library.favoriteAssets.includes(id)} /> : null;
            })}
          </>
        )}
        {favorites.length > 0 && (
          <>
            <div className="sample-group-label">FAVORITES</div>
            {favorites.map((id) => {
              const asset = allAssets.find((a) => a.id === id);
              return asset ? <Row key={id} asset={asset} fav /> : null;
            })}
          </>
        )}
        <div className="sample-group-label">LIBRARY</div>
        {rest.length === 0 && (
          <div className="sample-empty">
            <span className="sample-empty-icon" aria-hidden="true">
              🔍
            </span>
            No sounds match.{" "}
            {allAssets.length > 0 ? "Try another category or clear the search." : "Drop audio files above to import."}
          </div>
        )}
        {rest.map((asset) => (
          <Row key={asset.id} asset={asset} fav={library.favoriteAssets.includes(asset.id)} />
        ))}
      </div>
    </div>
  );
}
