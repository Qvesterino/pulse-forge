import { useEffect, useMemo, useState } from "react";
import { useLibrary, useServices } from "./context";
import type { FactoryAsset } from "../sample-library/manifest";
import { ASSET_MOODS } from "../sample-library/manifest";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";
import { categoryColor } from "./kitColors";
import { DropZone } from "./DropZone";
import { FreesoundSection } from "./FreesoundSection";

/** Unified asset type — factory or user-imported. */
export type SampleAsset = FactoryAsset | UserSampleAsset;

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
}: {
  assets: FactoryAsset[];
  userAssets?: UserSampleAsset[];
  currentId: string | null;
  onSelect: (assetId: string | null) => void;
  allowNone?: boolean;
  showDropZone?: boolean;
}) {
  const services = useServices();
  const library = useLibrary();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [mood, setMood] = useState<MoodFilter>("all");
  const [allUserAssets, setAllUserAssets] = useState<UserSampleAsset[]>(userAssets);

  // Load user samples from repo on mount
  useEffect(() => {
    void services.userSamples.list().then(setAllUserAssets);
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
      void services.library.recordAsset(id);
      services.engine.previewAsset(id);
    }
  };

  const handleImport = (asset: UserSampleAsset) => {
    setAllUserAssets((prev) => [...prev, asset]);
    apply(asset.id);
  };

  const Row = ({ asset, fav }: { asset: SampleAsset; fav: boolean }) => (
    <div className={`sample-row${asset.id === currentId ? " active" : ""}`}>
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
          onClick={() => void services.library.toggleAssetFavorite(asset.id)}
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
      {showDropZone && <DropZone onImport={handleImport} />}
      {showDropZone && <FreesoundSection onImport={handleImport} />}
      <input
        className="preset-search"
        value={query}
        placeholder="Search sounds…"
        aria-label="Search samples"
        onChange={(event) => setQuery(event.target.value)}
      />
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
        {rest.length === 0 && <div className="preset-empty">No sounds match.</div>}
        {rest.map((asset) => (
          <Row key={asset.id} asset={asset} fav={library.favoriteAssets.includes(asset.id)} />
        ))}
      </div>
    </div>
  );
}
