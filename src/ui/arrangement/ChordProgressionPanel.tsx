import type { ReactElement } from "react";
import { PROGRESSIONS_BY_GENRE, progressionsForGenre } from "../../ai/harmony";

/**
 * Arrangement collaborator 1/4 — the chord progression generator strip
 * (GEN / ROOT / MODE / BARS / AT / PROG + ⚡ GENERATE).
 *
 * Extracted verbatim from ArrangementPanel. Pure renderer: the form lives in the
 * shell, and the generation itself (which touches the live doc and the command
 * bus) stays there too — this module only renders the controls and reports what
 * the user asked for.
 */

/** One source of truth for the shell's `chordGen` state. */
export interface ChordGenForm {
  genre: string;
  tonic: number;
  mode: "major" | "minor";
  bars: number;
  startBar: number;
  index: number;
}

export interface ChordProgressionPanelProps {
  form: ChordGenForm;
  /** Merged into the shell state exactly as a functional `setState` would. */
  onChange: (patch: Partial<ChordGenForm>) => void;
  /** Shell-side: reads the live doc, executes the command, owns the error. */
  onGenerate: () => void;
}

export function ChordProgressionPanel({ form, onChange, onGenerate }: ChordProgressionPanelProps): ReactElement {
  return (
    <div className="arr-ripple-row" aria-label="Chord progression generator">
      <label className="arr-snap-label">
        GEN
        <select
          className="arr-arm-select"
          aria-label="Progression genre"
          value={form.genre}
          onChange={(event) => {
            const genre = event.target.value;
            onChange({ genre, index: 0 });
          }}
        >
          {Object.keys(PROGRESSIONS_BY_GENRE).map((genre) => (
            <option key={genre} value={genre}>
              {genre.toUpperCase()}
            </option>
          ))}
        </select>
      </label>
      <label className="arr-snap-label">
        ROOT
        <select
          className="arr-arm-select"
          aria-label="Progression tonic"
          value={form.tonic}
          onChange={(event) => onChange({ tonic: Number(event.target.value) })}
        >
          {["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"].map((name, index) => (
            <option key={name} value={index}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="arr-snap-label">
        MODE
        <select
          className="arr-arm-select"
          aria-label="Progression mode"
          value={form.mode}
          onChange={(event) => onChange({ mode: event.target.value as "major" | "minor" })}
        >
          <option value="minor">MIN</option>
          <option value="major">MAJ</option>
        </select>
      </label>
      <label className="arr-snap-label">
        BARS
        <input
          className="arr-arm-select"
          type="number"
          min={1}
          max={256}
          aria-label="Progression length in bars"
          value={form.bars}
          onChange={(event) =>
            onChange({
              bars: Math.max(1, Math.min(256, Number(event.target.value) || 1)),
            })
          }
        />
      </label>
      <label className="arr-snap-label">
        AT
        <input
          className="arr-arm-select"
          type="number"
          min={0}
          max={9999}
          aria-label="Generation start bar"
          value={form.startBar}
          onChange={(event) =>
            onChange({
              startBar: Math.max(0, Math.min(9999, Number(event.target.value) || 0)),
            })
          }
        />
      </label>
      <label className="arr-snap-label">
        PROG
        <select
          className="arr-arm-select"
          aria-label="Progression"
          value={form.index}
          onChange={(event) => onChange({ index: Number(event.target.value) })}
        >
          {progressionsForGenre(form.genre).map((progression, index) => (
            <option key={progression.name} value={index}>
              {progression.name}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="arr-ripple-toggle" onClick={onGenerate}>
        ⚡ GENERATE
      </button>
    </div>
  );
}
