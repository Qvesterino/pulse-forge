import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLibrary, useServices } from "./context";
import { applyInstrumentPreset } from "../commands/commands";
import { FACTORY_PRESETS } from "../presets/factory";
import { PRESET_ENERGIES, PRESET_USE_CASES, getPresetMetadata } from "../presets/catalog";
import { PRESET_GENRES, PRESET_MOODS } from "../presets/types";
import type { InstrumentPreset, PresetEnergy, PresetGenre, PresetMood, PresetUseCase } from "../presets/types";
import { rankSimilarPresets } from "../presets/similar";
import type { InstrumentTrack } from "../project-model/types";
import { uid } from "../shared/ids";

type GenreFilter = PresetGenre | "all";
type MoodFilter = PresetMood | "all";
type UseCaseFilter = PresetUseCase | "all";
type EnergyFilter = PresetEnergy | "all";
type ScopeFilter = "all" | "fav" | "recent" | "similar";

export function PresetBrowser({ track }: { track: InstrumentTrack }) {
  const services = useServices();
  const doc = services.store.getDoc();
  const library = useLibrary();
  const [genre, setGenre] = useState<GenreFilter>("all");
  const [mood, setMood] = useState<MoodFilter>("all");
  const [useCase, setUseCase] = useState<UseCaseFilter>("all");
  const [energy, setEnergy] = useState<EnergyFilter>("all");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [query, setQuery] = useState("");
  // Filters live behind one toggle — search-first keeps the browser scannable;
  // the toggle shows how many filters are shaping the list when collapsed.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [userPresets, setUserPresets] = useState<InstrumentPreset[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewingPresetId, setPreviewingPresetId] = useState<string | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setPreviewingPresetId(null);
    // A preview must never outlive the browser/track that started it. This is
    // intentionally a cleanup-only effect so opening the browser does not
    // stop an unrelated preview before the user interacts with it.
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
      services.engine.stopPreview();
    };
  }, [services, track.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !previewingPresetId) return;
      if (previewTimer.current) clearTimeout(previewTimer.current);
      previewTimer.current = null;
      services.engine.stopPreview();
      setPreviewingPresetId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewingPresetId, services]);

  // Quota/private-browsing failures must surface in the UI instead of dying
  // as unhandled rejections behind a `void`ed promise.
  const guard = useCallback((action: () => Promise<void>): Promise<void> => {
    setSaveError(null);
    return action().catch((err) => {
      console.error("[PresetBrowser] operation failed:", err);
      setSaveError(err instanceof Error ? err.message : "Storage operation failed");
    });
  }, []);

  const refreshUserPresets = useCallback(() => {
    services.core.presets
      .list()
      .then(setUserPresets)
      .catch(() => setUserPresets([]));
  }, [services]);

  useEffect(() => {
    refreshUserPresets();
  }, [refreshUserPresets, track.instrument]);

  const all = useMemo(
    () => [...FACTORY_PRESETS, ...userPresets].filter((p) => p.instrument === track.instrument),
    [userPresets, track.instrument],
  );

  const base = all.filter((preset) => {
    const metadata = getPresetMetadata(preset);
    if (genre !== "all" && preset.genre !== genre) return false;
    if (mood !== "all" && !preset.mood.includes(mood)) return false;
    if (useCase !== "all" && metadata.useCase !== useCase) return false;
    if (energy !== "all" && metadata.energy !== energy) return false;
    if (scope === "fav" && !library.favoritePresets.includes(preset.id)) return false;
    if (scope === "recent" && !library.recentPresets.includes(preset.id)) return false;
    if (query.trim().length > 0) {
      const q = query.trim().toLowerCase();
      const haystack =
        `${preset.name} ${preset.tags.join(" ")} ${preset.genre ?? ""} ${preset.mood.join(" ")} ${metadata.useCase} ${metadata.energy} ${metadata.source}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
  // SIMILAR: rank the remaining presets of this instrument by param distance
  // to the current patch; a similarity chip is rendered next to each row.
  const ranked = scope === "similar" ? rankSimilarPresets(base, track, 24) : null;
  const similarityOf = new Map(ranked?.map((r) => [r.preset.id, r.similarity]) ?? []);
  const filtered = ranked ? ranked.map((r) => r.preset) : base;

  const current = all.find((p) => p.id === track.presetId) ?? null;
  const activeFilterCount =
    (useCase !== "all" ? 1 : 0) + (energy !== "all" ? 1 : 0) + (genre !== "all" ? 1 : 0) + (mood !== "all" ? 1 : 0);

  const apply = (preset: InstrumentPreset) => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = null;
    services.engine.stopPreview();
    setPreviewingPresetId(null);
    services.store.execute(applyInstrumentPreset(doc, track.id, preset));
    void guard(async () => {
      await services.library.recordPreset(preset.id);
    });
  };

  const preview = (preset: InstrumentPreset) => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    services.engine.previewInstrumentPreset(track.id, preset);
    setPreviewingPresetId(preset.id);
    previewTimer.current = setTimeout(() => {
      previewTimer.current = null;
      setPreviewingPresetId((active) => (active === preset.id ? null : active));
    }, 1_500);
  };

  const saveCurrent = async () => {
    setSaveError(null);
    const name = saveName.trim();
    if (name.length === 0) return;
    const preset: InstrumentPreset = {
      id: uid("preset"),
      name,
      instrument: track.instrument,
      genre: null,
      mood: [],
      tags: ["user"],
      params: { ...track.params },
      sampleId: track.sampleId,
      user: true,
    };
    preset.metadata = getPresetMetadata(preset);
    await services.core.presets.save(preset);
    setSaveOpen(false);
    setSaveName("");
    refreshUserPresets();
  };

  const removeUserPreset = async (id: string) => {
    await services.core.presets.delete(id);
    refreshUserPresets();
  };

  return (
    <div className="preset-browser">
      <div className="preset-current">
        <span className="preset-current-label">PRESET</span>
        <span className="preset-current-name">{current ? current.name : "Custom"}</span>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            setSaveOpen((open) => !open);
            setSaveName(current ? `${current.name} ` : `${track.name} `);
          }}
          title="Save current sound as a user preset"
        >
          SAVE
        </button>
      </div>

      {saveOpen && (
        <div className="preset-save">
          <input
            className="preset-save-input"
            value={saveName}
            autoFocus
            placeholder="Preset name"
            aria-label="New preset name"
            onChange={(event) => setSaveName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void guard(saveCurrent);
              if (event.key === "Escape") setSaveOpen(false);
            }}
          />
          <button type="button" className="btn btn-small" onClick={() => void guard(saveCurrent)}>
            OK
          </button>
        </div>
      )}

      {saveError && (
        <div className="preset-save-error" role="alert" aria-live="polite">
          {saveError}
        </div>
      )}

      <div className="preset-toolbar">
        <input
          className="preset-search"
          value={query}
          placeholder="Search presets…"
          aria-label="Search presets"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className={`btn btn-small preset-filter-toggle${filtersOpen || activeFilterCount > 0 ? " active" : ""}`}
          aria-expanded={filtersOpen}
          title="Filter by role, energy, genre and mood"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          FILTERS{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
          <span aria-hidden="true">{filtersOpen ? " ▴" : " ▾"}</span>
        </button>
      </div>

      <div className="preset-chips" role="group" aria-label="Preset scope">
        {(["all", "fav", "recent", "similar"] as ScopeFilter[]).map((s) => (
          <button
            key={s}
            type="button"
            className={`preset-chip${scope === s ? " active" : ""}`}
            onClick={() => setScope(s)}
            title={s === "similar" ? "Presets closest to the current sound (same instrument)" : undefined}
          >
            {s === "similar" ? "SIMILAR ▸" : s.toUpperCase()}
          </button>
        ))}
      </div>

      {filtersOpen && (
        <>
          <div className="preset-chips" role="group" aria-label="Preset role filter">
            <button
              type="button"
              className={`preset-chip${useCase === "all" ? " active" : ""}`}
              aria-pressed={useCase === "all"}
              onClick={() => setUseCase("all")}
            >
              ROLE: ALL
            </button>
            {PRESET_USE_CASES.map((value) => (
              <button
                key={value}
                type="button"
                className={`preset-chip${useCase === value ? " active" : ""}`}
                aria-pressed={useCase === value}
                onClick={() => setUseCase(useCase === value ? "all" : value)}
              >
                ROLE: {value.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="preset-chips" role="group" aria-label="Preset energy filter">
            <button
              type="button"
              className={`preset-chip${energy === "all" ? " active" : ""}`}
              aria-pressed={energy === "all"}
              onClick={() => setEnergy("all")}
            >
              ENERGY: ALL
            </button>
            {PRESET_ENERGIES.map((value) => (
              <button
                key={value}
                type="button"
                className={`preset-chip${energy === value ? " active" : ""}`}
                aria-pressed={energy === value}
                onClick={() => setEnergy(energy === value ? "all" : value)}
              >
                ENERGY: {value.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="preset-chips">
            <button
              type="button"
              className={`preset-chip${genre === "all" ? " active" : ""}`}
              onClick={() => setGenre("all")}
            >
              ALL
            </button>
            {PRESET_GENRES.map((g) => (
              <button
                key={g}
                type="button"
                className={`preset-chip${genre === g ? " active" : ""}`}
                onClick={() => setGenre(g)}
              >
                {g.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="preset-chips">
            {PRESET_MOODS.map((m) => (
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
        </>
      )}

      <div className="preset-list">
        {filtered.length === 0 && <div className="preset-empty">No presets match.</div>}
        {filtered.map((preset) => {
          const metadata = getPresetMetadata(preset);
          return (
            <div
              key={preset.id}
              className={`preset-row${preset.id === track.presetId ? " active" : ""}`}
              title={`${metadata.source} · ${metadata.license} · ${metadata.bpmRange.min}–${metadata.bpmRange.max} BPM · key ${metadata.keySuitability}`}
            >
              <button
                type="button"
                className={`preset-preview${previewingPresetId === preset.id ? " active" : ""}`}
                aria-label={previewingPresetId === preset.id ? `Stop preview ${preset.name}` : `Preview ${preset.name}`}
                aria-pressed={previewingPresetId === preset.id}
                title={previewingPresetId === preset.id ? "Stop preview" : "Preview preset"}
                onClick={() => {
                  if (previewingPresetId === preset.id) {
                    if (previewTimer.current) clearTimeout(previewTimer.current);
                    previewTimer.current = null;
                    services.engine.stopPreview();
                    setPreviewingPresetId(null);
                  } else {
                    preview(preset);
                  }
                }}
              >
                {previewingPresetId === preset.id ? "■" : "▶"}
              </button>
              <button
                type="button"
                className="preset-name"
                aria-label={`Apply ${preset.name}`}
                onClick={() => apply(preset)}
                title={`Apply ${preset.name}`}
              >
                {preset.name}
              </button>
              <span className="preset-tags">
                {metadata.useCase} · {metadata.energy} · {preset.genre ? preset.genre : "user"}
              </span>
              {similarityOf.has(preset.id) && (
                <span className="preset-sim" title="Parameter similarity to the current sound">
                  ≈{Math.round((similarityOf.get(preset.id) ?? 0) * 100)}%
                </span>
              )}
              <button
                type="button"
                className={`preset-fav${library.favoritePresets.includes(preset.id) ? " active" : ""}`}
                aria-label={
                  library.favoritePresets.includes(preset.id) ? `Unfavorite ${preset.name}` : `Favorite ${preset.name}`
                }
                aria-pressed={library.favoritePresets.includes(preset.id)}
                onClick={(event) => {
                  event.stopPropagation();
                  void guard(async () => {
                    await services.library.togglePresetFavorite(preset.id);
                  });
                }}
              >
                {library.favoritePresets.includes(preset.id) ? "♥" : "♡"}
              </button>
              {preset.user && (
                <button
                  type="button"
                  className="preset-delete"
                  aria-label={`Delete preset ${preset.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void guard(async () => removeUserPreset(preset.id));
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
