import { useEffect, useMemo, useRef, useState } from "react";
import { EFFECT_DEFS, type CoreEffectGroupKey } from "../effects/registry";
import { presetsForEffect } from "../effects/presets";
import { EFFECT_BLURBS } from "../effects/blurbs";
import { parseProductionIntent } from "../intent/production";
import type { EffectType } from "../project-model/types";

/**
 * GOAL-FIRST FX ADD POPOVER (FX-ADD-REWORK-ROADMAP Wave A) — the modular
 * door for "put an effect on this instrument". Three ways in, one surface:
 *
 *  1. TEXT — "what should this track do?" Free words. A device-name match
 *     filters the grid; a production CONCEPT ("deeper", "wobbly", "vinyl")
 *     offers a one-click goal that folds the planner onto THIS track.
 *  2. GOAL TILES — five human categories (the registry's category enum,
 *     relabelled) expand into a device grid.
 *  3. THE GRID — every device with its one-line blurb and a preset-count
 *     badge; clicking adds it.
 *
 * The old `<select>` list stays available as "ALL DEVICES" in the rack —
 * the popover replaces the first contact, not the pro path.
 */

const CATEGORY_LABELS: Record<string, { tile: string; caption: string }> = {
  tone: { tile: "TONE", caption: "reshape the sound" },
  dynamics: { tile: "DYNAMICS", caption: "level, punch & glue" },
  character: { tile: "CHARACTER", caption: "age, color & drive" },
  movement: { tile: "MOVEMENT", caption: "rhythm, motion & wobble" },
  space: { tile: "SPACE", caption: "rooms, echoes & width" },
};

interface FxAddPopoverProps {
  /** Track name shown in the header ("FX — 808 Sub"). */
  trackLabel: string;
  /** The device types this surface can add (rack already filters per mode). */
  devices: readonly EffectType[];
  /** Add a device — the parent owns the command (insertion index etc.). */
  onPick: (type: EffectType) => void;
  /** Fold a production concept onto this track (text path goal row). */
  onGoal: (goalText: string) => void;
  onClose: () => void;
}

export function FxAddPopover({ trackLabel, devices, onPick, onGoal, onClose }: FxAddPopoverProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();

  // A production CONCEPT in the text ("deeper", "wobbly", "vinyl 808") gets
  // a dedicated goal row above the grid — the whole-track INTENT panel
  // already understands these, the popover scopes them to THIS track.
  const concept = trimmed.length >= 3 ? parseProductionIntent(trimmed) : null;

  const goalTiles = useMemo(() => {
    const keys = [...new Set(devices.map((type) => EFFECT_DEFS[type]?.category ?? "tone"))];
    return keys.map((key) => ({ key, ...(CATEGORY_LABELS[key] ?? { tile: key.toUpperCase(), caption: "" }) }));
  }, [devices]);

  const visible = useMemo(
    () =>
      devices.filter((type) => {
        const def = EFFECT_DEFS[type];
        if (!def) return false;
        if (category && def.category !== category) return false;
        if (!lower) return true;
        const blurb = EFFECT_BLURBS[type] ?? "";
        return def.name.toLowerCase().includes(lower) || blurb.toLowerCase().includes(lower);
      }),
    [devices, category, lower],
  );

  return (
    <div className="fx-add-popover" role="dialog" aria-label={`Add effect — ${trackLabel}`}>
      <div className="fx-add-head">
        <span className="fx-add-title">FX — {trackLabel}</span>
        <button type="button" className="fx-add-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <input
        ref={inputRef}
        data-allow-focus=""
        className="fx-add-search"
        type="text"
        value={query}
        placeholder="what should this track do? — deeper, vinyl, punch…"
        aria-label="Describe what you want, or search devices"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && concept) {
            onGoal(trimmed);
          } else if (event.key === "Enter" && visible.length > 0) {
            onPick(visible[0]!);
          }
        }}
      />

      {concept && (
        <button
          type="button"
          className="fx-add-goal"
          onClick={() => onGoal(trimmed)}
          title="Fold this goal onto this track with the production planner"
        >
          ♪ {concept.goals.map((g) => g.concept).join(" + ")} — apply to this track
        </button>
      )}

      <div className="fx-add-tiles" role="toolbar" aria-label="Categories">
        <button
          type="button"
          className={`fx-add-tile${category === null ? " active" : ""}`}
          onClick={() => setCategory(null)}
        >
          ALL
        </button>
        {goalTiles.map((tile) => (
          <button
            key={tile.key}
            type="button"
            className={`fx-add-tile${category === tile.key ? " active" : ""}`}
            title={tile.caption}
            onClick={() => setCategory(category === tile.key ? null : tile.key)}
          >
            {tile.tile}
          </button>
        ))}
      </div>

      <div className="fx-add-grid">
        {visible.map((type) => {
          const def = EFFECT_DEFS[type];
          const presetCount = presetsForEffect(type).length;
          return (
            <button key={type} type="button" className="fx-add-device" onClick={() => onPick(type)}>
              <span className="fx-add-device-name">{def.name}</span>
              <span className="fx-add-device-blurb">{EFFECT_BLURBS[type] ?? ""}</span>
              {presetCount > 0 && <span className="fx-add-device-presets">{presetCount} starts</span>}
            </button>
          );
        })}
        {visible.length === 0 && <span className="fx-add-empty">nothing matches — try another word</span>}
      </div>
    </div>
  );
}
