import { useMemo, useState } from "react";
import { useDoc, useServices } from "./context";
import { setBeatManglerSteps } from "../commands/commands";
import { StepGridEditor } from "./StepGridEditor";

/**
 * Beat Mangler envelope editor (FX expansion, phase 3b).
 *
 * Two stacked lanes — VOL (0..1 gain per step) and PITCH (−24..24 semitones
 * read-speed per step) — plus the preset shelf from the roadmap: the shapes
 * that make this effect a signature (halftime, double-time, scratch-in,
 * fill-repeat, wobble). Presets are pure data: applying one writes both
 * envelopes through the same undoable command as a manual edit.
 *
 * Every action goes through `setBeatManglerSteps` so undo/redo, collab sync
 * and persistence behave exactly like the rest of the rack.
 */

/** How many steps a preset grid is authored at (matches the 16-step default). */
const PRESET_STEPS = 16;

interface ManglerPreset {
  id: string;
  name: string;
  hint: string;
  volume: number[];
  pitch?: number[];
}

/** `null` pitch = leave the pitch lane untouched (keep the user's melody). */
function ramp(from: number, to: number, steps = PRESET_STEPS): number[] {
  return Array.from({ length: steps }, (_, i) => Math.round((from + ((to - from) * i) / (steps - 1)) * 100) / 100);
}

const MANGLER_PRESETS: ManglerPreset[] = [
  {
    id: "halftime",
    name: "HALFTIME",
    hint: "Every other 1/8 gated off — the classic halftime chop",
    volume: Array.from({ length: PRESET_STEPS }, (_, i) => (i % 4 < 2 ? 1 : 0)),
  },
  {
    id: "doubletime",
    name: "2× FAST",
    hint: "Tight 1/16 gates on every other step — double-time stutter",
    volume: Array.from({ length: PRESET_STEPS }, (_, i) => (i % 2 === 0 ? 1 : 0.35)),
  },
  {
    id: "scratch-in",
    name: "SCRATCH IN",
    hint: "Pitch spins from −12 to 0 across the bar — turntable scratch-in",
    volume: Array.from({ length: PRESET_STEPS }, () => 1),
    pitch: ramp(-12, 0),
  },
  {
    id: "scratch-out",
    name: "SCRATCH OUT",
    hint: "Pitch spins from 0 to +12 — scratch-out",
    volume: Array.from({ length: PRESET_STEPS }, () => 1),
    pitch: ramp(0, 12),
  },
  {
    id: "fill-quarter",
    name: "FILL 1/4",
    hint: "Silence, then the last 1/4 of the bar repeats — a fill bridge",
    volume: [...Array(PRESET_STEPS - 4).fill(0), ...Array(4).fill(1)],
  },
  {
    id: "wobble-8th",
    name: "WOBBLE 8TH",
    hint: "Alternating half-volume 1/8s — tape-wobble gating",
    volume: Array.from({ length: PRESET_STEPS }, (_, i) => (i % 2 === 0 ? 1 : 0.4)),
  },
  {
    id: "gate-open",
    name: "OPEN",
    hint: "Full gain, no pitch movement — a clean slate",
    volume: Array.from({ length: PRESET_STEPS }, () => 1),
    pitch: Array.from({ length: PRESET_STEPS }, () => 0),
  },
];

export function BeatManglerEditor({ trackId, fxId }: { trackId: string; fxId: string }) {
  const services = useServices();
  // Subscribe to the document so a preset/commit re-renders the lanes with
  // the new envelope (props would go stale the moment a command lands).
  const doc = useDoc();
  const [lastPreset, setLastPreset] = useState<string | null>(null);

  const fx = doc.tracks.find((t) => t.id === trackId)?.effects.find((e) => e.id === fxId);
  const volume = useMemo(
    () => (fx?.volumeSteps && fx.volumeSteps.length > 0 ? fx.volumeSteps : Array(PRESET_STEPS).fill(1)),
    [fx?.volumeSteps],
  );
  const pitch = useMemo(
    () => (fx?.pitchSteps && fx.pitchSteps.length > 0 ? fx.pitchSteps : Array(PRESET_STEPS).fill(0)),
    [fx?.pitchSteps],
  );

  const commit = (patch: { volume?: number[]; pitch?: number[] }) => {
    services.store.execute(setBeatManglerSteps(services.store.getDoc(), trackId, fxId, patch));
  };

  const applyPreset = (preset: ManglerPreset) => {
    setLastPreset(preset.id);
    commit({ volume: [...preset.volume], ...(preset.pitch ? { pitch: [...preset.pitch] } : {}) });
  };

  /** Shift both lanes to the given length (16/32) by tiling the existing shape. */
  const resize = (length: number) => {
    const tile = (source: number[], fallback: number) => {
      const base = source.length > 0 ? source : [fallback];
      return Array.from({ length }, (_, i) => base[i % base.length]);
    };
    commit({ volume: tile(volume, 1), pitch: tile(pitch, 0) });
  };

  const invert = () => commit({ volume: volume.map((v) => Math.round((1 - v) * 100) / 100) });
  const duplicate = () => commit({ pitch: [...pitch] });
  const copyVolToPitch = () => {
    // Map 0..1 gain onto the −24..24 pitch lane (0.5 = 0 st).
    commit({ pitch: volume.map((v) => Math.round((v * 48 - 24) * 10) / 10) });
  };
  const resetLanes = () => commit({ volume: Array(volume.length).fill(1), pitch: Array(pitch.length).fill(0) });

  return (
    <div className="beatmangler-editor">
      <div className="beatmangler-shelf" role="group" aria-label="Beat mangler envelope presets">
        {MANGLER_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`btn btn-small beatmangler-preset${lastPreset === preset.id ? " active" : ""}`}
            title={preset.hint}
            onClick={() => applyPreset(preset)}
          >
            {preset.name}
          </button>
        ))}
      </div>

      <div className="beatmangler-lane">
        <span className="beatmangler-lane-label" title="Volume envelope — gain per step (0..1)">
          VOL
        </span>
        <StepGridEditor
          steps={volume}
          min={0}
          max={1}
          ariaLabel="Beat mangler volume envelope"
          onCommit={(steps) => commit({ volume: steps })}
        />
      </div>

      <div className="beatmangler-lane">
        <span className="beatmangler-lane-label" title="Pitch envelope — read-speed per step in semitones (−24..24)">
          PITCH
        </span>
        <StepGridEditor
          steps={pitch}
          min={-24}
          max={24}
          ariaLabel="Beat mangler pitch envelope"
          onCommit={(steps) => commit({ pitch: steps })}
        />
      </div>

      <div className="beatmangler-actions" role="group" aria-label="Beat mangler envelope tools">
        <span className="beatmangler-actions-label">STEPS</span>
        {[16, 32].map((length) => (
          <button
            key={length}
            type="button"
            className={`btn btn-small${volume.length === length ? " active" : ""}`}
            title={`Resize both envelopes to ${length} steps (tiles the current shape)`}
            onClick={() => resize(length)}
          >
            {length}
          </button>
        ))}
        <span className="beatmangler-actions-divider" aria-hidden="true" />
        <button
          type="button"
          className="btn btn-small"
          title="Invert the volume envelope (1 − v per step)"
          onClick={invert}
        >
          INVERT
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Map the volume envelope onto the pitch lane (0.5 → 0 st)"
          onClick={copyVolToPitch}
        >
          VOL→PITCH
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Duplicate the pitch lane (forces it into the document so it can be edited independently)"
          onClick={duplicate}
        >
          DUP PITCH
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger"
          title="Reset both envelopes (full gain, no pitch movement)"
          onClick={resetLanes}
        >
          RESET
        </button>
      </div>
    </div>
  );
}
