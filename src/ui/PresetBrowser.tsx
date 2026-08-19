import { useCallback, useEffect, useMemo, useState } from "react";
import { useDoc, useServices } from "./context";
import { applyInstrumentPreset } from "../commands/commands";
import { FACTORY_PRESETS } from "../presets/factory";
import { PRESET_GENRES } from "../presets/types";
import type { InstrumentPreset, PresetGenre } from "../presets/types";
import type { InstrumentTrack } from "../project-model/types";
import { uid } from "../shared/ids";

type GenreFilter = PresetGenre | "all";

export function PresetBrowser({ track }: { track: InstrumentTrack }) {
  const services = useServices();
  const doc = useDoc();
  const [genre, setGenre] = useState<GenreFilter>("all");
  const [query, setQuery] = useState("");
  const [userPresets, setUserPresets] = useState<InstrumentPreset[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

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
    if (query.trim().length > 0) {
      const q = query.trim().toLowerCase();
      const haystack = `${preset.name} ${preset.tags.join(" ")}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const current = all.find((p) => p.id === track.presetId) ?? null;

  const apply = (preset: InstrumentPreset) => {
    services.store.execute(applyInstrumentPreset(doc, track.id, preset));
  };

  const saveCurrent = async () => {
    const name = saveName.trim();
    if (name.length === 0) return;
    const preset: InstrumentPreset = {
      id: uid("preset"),
      name,
      instrument: track.instrument,
      genre: null,
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
              if (event.key === "Enter") void saveCurrent();
              if (event.key === "Escape") setSaveOpen(false);
            }}
          />
          <button type="button" className="btn btn-small" onClick={() => void saveCurrent()}>
            OK
          </button>
        </div>
      )}

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
              {preset.genre ? preset.genre : "user"} · {preset.tags.slice(0, 2).join(", ")}
            </span>
            {preset.user && (
              <button
                type="button"
                className="preset-delete"
                aria-label={`Delete preset ${preset.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void removeUserPreset(preset.id);
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
