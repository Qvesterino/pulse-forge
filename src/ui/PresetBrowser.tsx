import { useCallback, useEffect, useMemo, useState } from "react";
import { useDoc, useLibrary, useServices } from "./context";
import { applyInstrumentPreset } from "../commands/commands";
import { FACTORY_PRESETS } from "../presets/factory";
import { PRESET_GENRES, PRESET_MOODS } from "../presets/types";
import type { InstrumentPreset, PresetGenre, PresetMood } from "../presets/types";
import type { InstrumentTrack } from "../project-model/types";
import { uid } from "../shared/ids";

type GenreFilter = PresetGenre | "all";
type MoodFilter = PresetMood | "all";
type ScopeFilter = "all" | "fav" | "recent";

export function PresetBrowser({ track }: { track: InstrumentTrack }) {
  const services = useServices();
  const doc = useDoc();
  const library = useLibrary();
  const [genre, setGenre] = useState<GenreFilter>("all");
  const [mood, setMood] = useState<MoodFilter>("all");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [query, setQuery] = useState("");
  const [userPresets, setUserPresets] = useState<InstrumentPreset[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Quota/private-browsing failures must surface in the UI instead of dying
  // as unhandled rejections behind a `void`ed promise.
  const guard = useCallback(
    (action: () => Promise<void>): Promise<void> =>
      action().catch((err) => {
        console.error("[PresetBrowser] operation failed:", err);
        setSaveError(err instanceof Error ? err.message : "Storage operation failed");
      }),
    [],
  );

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

  const filtered = all.filter((preset) => {
    if (genre !== "all" && preset.genre !== genre) return false;
    if (mood !== "all" && !preset.mood.includes(mood)) return false;
    if (scope === "fav" && !library.favoritePresets.includes(preset.id)) return false;
    if (scope === "recent" && !library.recentPresets.includes(preset.id)) return false;
    if (query.trim().length > 0) {
      const q = query.trim().toLowerCase();
      const haystack = `${preset.name} ${preset.tags.join(" ")} ${preset.mood.join(" ")}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const current = all.find((p) => p.id === track.presetId) ?? null;

  const apply = (preset: InstrumentPreset) => {
    services.store.execute(applyInstrumentPreset(doc, track.id, preset));
    void services.library.recordPreset(preset.id);
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
          {saveError && (
            <span className="preset-save-error" role="alert">
              {saveError}
            </span>
          )}
        </div>
      )}

      <div className="preset-chips">
        {(["all", "fav", "recent"] as ScopeFilter[]).map((s) => (
          <button
            key={s}
            type="button"
            className={`preset-chip${scope === s ? " active" : ""}`}
            onClick={() => setScope(s)}
          >
            {s.toUpperCase()}
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

      <input
        className="preset-search"
        value={query}
        placeholder="Search presets…"
        aria-label="Search presets"
        onChange={(event) => setQuery(event.target.value)}
      />

      <div className="preset-list">
        {filtered.length === 0 && <div className="preset-empty">No presets match.</div>}
        {filtered.map((preset) => (
          <div
            key={preset.id}
            className={`preset-row${preset.id === track.presetId ? " active" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => apply(preset)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                apply(preset);
              }
            }}
          >
            <span className="preset-name">{preset.name}</span>
            <span className="preset-tags">
              {preset.genre ? preset.genre : "user"} · {preset.mood.slice(0, 2).join(", ") || preset.tags[0]}
            </span>
            <button
              type="button"
              className={`preset-fav${library.favoritePresets.includes(preset.id) ? " active" : ""}`}
              aria-label={library.favoritePresets.includes(preset.id) ? `Unfavorite ${preset.name}` : `Favorite ${preset.name}`}
              aria-pressed={library.favoritePresets.includes(preset.id)}
              onClick={(event) => {
                event.stopPropagation();
                void services.library.togglePresetFavorite(preset.id);
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
        ))}
      </div>
    </div>
  );
}
