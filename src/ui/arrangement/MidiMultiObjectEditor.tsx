import { useEffect, useMemo, useState } from "react";
import type { MidiObjectNoteEdit } from "../../commands/midiClips";
import type { MidiClip, ProjectDocument } from "../../project-model/types";

type NumericEditKey =
  | "transposeSemitones"
  | "startOffsetTicks"
  | "durationScalePercent"
  | "velocityScalePercent"
  | "pitchOffsetSemitones"
  | "pan"
  | "filterCutoffHz"
  | "filterResonance"
  | "releaseVelocity"
  | "modX"
  | "modY";

const NUMBER_FIELDS: { key: NumericEditKey; label: string; min: number; max: number; step: number; suffix?: string }[] =
  [
    { key: "transposeSemitones", label: "Transpose", min: -127, max: 127, step: 1, suffix: "semitones" },
    { key: "startOffsetTicks", label: "Move in time", min: -15_728_640, max: 15_728_640, step: 1, suffix: "ticks" },
    { key: "durationScalePercent", label: "Note length", min: 1, max: 1000, step: 1, suffix: "%" },
    { key: "velocityScalePercent", label: "Velocity", min: 0, max: 200, step: 1, suffix: "%" },
    { key: "pitchOffsetSemitones", label: "Fine pitch shift", min: -12, max: 12, step: 0.1, suffix: "semitones" },
    { key: "pan", label: "Pan", min: -1, max: 1, step: 0.01 },
    { key: "filterCutoffHz", label: "Filter cutoff", min: 20, max: 20_000, step: 1, suffix: "Hz" },
    { key: "filterResonance", label: "Filter resonance", min: 0, max: 1, step: 0.01 },
    { key: "releaseVelocity", label: "Release velocity", min: 0, max: 1, step: 0.01 },
    { key: "modX", label: "Mod X", min: 0, max: 1, step: 0.01 },
    { key: "modY", label: "Mod Y", min: 0, max: 1, step: 0.01 },
  ];

function numberValue(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function MidiMultiObjectEditor({
  doc,
  clips,
  onApply,
  onClose,
}: {
  doc: ProjectDocument;
  clips: MidiClip[];
  onApply: (edit: MidiObjectNoteEdit) => string | null;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<NumericEditKey, string>>({
    transposeSemitones: "",
    startOffsetTicks: "",
    durationScalePercent: "",
    velocityScalePercent: "",
    pitchOffsetSemitones: "",
    pan: "",
    filterCutoffHz: "",
    filterResonance: "",
    releaseVelocity: "",
    modX: "",
    modY: "",
  });
  const [slide, setSlide] = useState<"keep" | "on" | "off">("keep");
  const [slideNote, setSlideNote] = useState<"keep" | "on" | "off">("keep");
  const [clearLocks, setClearLocks] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const notes = useMemo(() => {
    const seenSources = new Set<string>();
    return clips.reduce((sum, clip) => {
      const sourceKey = `${clip.patternId}:${clip.trackId}`;
      if (seenSources.has(sourceKey)) return sum;
      seenSources.add(sourceKey);
      const source = doc.patterns.find((pattern) => pattern.id === clip.patternId);
      return sum + (source?.notes?.[clip.trackId]?.length ?? 0);
    }, 0);
  }, [clips, doc.patterns]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const edit = (): MidiObjectNoteEdit => {
    const numeric = Object.fromEntries(
      NUMBER_FIELDS.flatMap(({ key, min, max }) => {
        const value = numberValue(values[key]);
        return value === undefined ? [] : [[key, Math.max(min, Math.min(max, value))]];
      }),
    ) as Pick<MidiObjectNoteEdit, NumericEditKey>;
    return {
      ...numeric,
      ...(slide === "keep" ? {} : { slide: slide === "on" }),
      ...(slideNote === "keep" ? {} : { slideNote: slideNote === "on" }),
      ...(clearLocks ? { clearLocks: true } : {}),
    };
  };
  const hasEdits =
    Object.values(values).some((value) => numberValue(value) !== undefined) ||
    slide !== "keep" ||
    slideNote !== "keep" ||
    clearLocks;

  return (
    <div className="midi-multi-edit-backdrop">
      <section className="midi-multi-edit" role="dialog" aria-modal="true" aria-labelledby="midi-multi-edit-title">
        <header className="midi-multi-edit__header">
          <div>
            <p className="midi-multi-edit__eyebrow">MIDI MULTI-OBJECT EDITOR</p>
            <h2 id="midi-multi-edit-title">Edit notes in {clips.length} MIDI objects</h2>
            <p className="midi-multi-edit__summary">
              {notes} source notes across {clips.length} objects · blank fields keep their current values · unselected
              shared sources stay unchanged
            </p>
          </div>
          <button type="button" aria-label="Close MIDI multi-object editor" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="midi-multi-edit__objects" aria-label="Selected MIDI objects">
          {clips.map((clip) => {
            const track = doc.tracks.find((candidate) => candidate.id === clip.trackId);
            const pattern = doc.patterns.find((candidate) => candidate.id === clip.patternId);
            return (
              <span key={clip.id}>
                {track?.name ?? "Track"} · {pattern?.name ?? "Pattern"}
              </span>
            );
          })}
        </div>

        <div className="midi-multi-edit__fields">
          {NUMBER_FIELDS.map(({ key, label, min, max, step, suffix }) => (
            <label key={key}>
              <span>{label}</span>
              <span className="midi-multi-edit__input-wrap">
                <input
                  aria-label={label}
                  type="number"
                  min={min}
                  max={max}
                  step={step}
                  value={values[key]}
                  onChange={(event) => {
                    setApplyError(null);
                    setValues((current) => ({ ...current, [key]: event.target.value }));
                  }}
                />
                {suffix && <small>{suffix}</small>}
              </span>
            </label>
          ))}
          <label>
            <span>Portamento transition</span>
            <select
              aria-label="Portamento transition"
              value={slide}
              onChange={(event) => {
                setApplyError(null);
                setSlide(event.target.value as typeof slide);
              }}
            >
              <option value="keep">Keep</option>
              <option value="on">Enable</option>
              <option value="off">Disable</option>
            </select>
          </label>
          <label>
            <span>Slide note articulation</span>
            <select
              aria-label="Slide note articulation"
              value={slideNote}
              onChange={(event) => {
                setApplyError(null);
                setSlideNote(event.target.value as typeof slideNote);
              }}
            >
              <option value="keep">Keep</option>
              <option value="on">Enable</option>
              <option value="off">Disable</option>
            </select>
          </label>
        </div>

        <label className="midi-multi-edit__clear-locks">
          <input
            type="checkbox"
            checked={clearLocks}
            onChange={(event) => {
              setApplyError(null);
              setClearLocks(event.target.checked);
            }}
          />
          Clear per-note parameter locks
        </label>

        {applyError && <p role="alert">{applyError}</p>}

        <footer className="midi-multi-edit__actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!hasEdits || notes === 0}
            onClick={() => setApplyError(onApply(edit()))}
          >
            Apply as one edit
          </button>
        </footer>
      </section>
    </div>
  );
}
