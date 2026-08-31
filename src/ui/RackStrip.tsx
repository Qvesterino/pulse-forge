import { useEffect, useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import type { DrumTrack } from "../project-model/types";
import { usePlayheadStep } from "./playhead";
import { assetCategoryOf, categoryColor } from "./kitColors";
import { FALLOFF_MODES, REPEAT_RATES, type FalloffMode, type RepeatRate } from "../audio-engine/NoteRepeat";

/** Two-row QWERTY layout for the 16 pads (MPC style). Plain letters only — no clash with shortcuts (digits, Alt+letters, Ctrl+letters). */
const PAD_KEYS = ["q", "w", "e", "r", "t", "y", "u", "i", "a", "s", "d", "f", "g", "h", "j", "k"] as const;

export function RackStrip({
  track,
  selectedPadId,
  onSelectPad,
}: {
  track: DrumTrack;
  selectedPadId: string;
  onSelectPad: (padId: string) => void;
}) {
  const services = useServices();
  const doc = useDoc();
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId)!;
  const playheadStep = usePlayheadStep(services.transport, doc);
  const [repeatRate, setRepeatRate] = useState<RepeatRate>("off");
  const [falloff, setFalloff] = useState<FalloffMode>("decay");

  const triggerPad = (padId: string) => {
    const pad = track.pads.find((p) => p.id === padId);
    if (pad) {
      services.engine.preview(pad, track.id);
      const peak = pad.gain;
      setPeaks((prev) => ({ ...prev, [padId]: peak }));
    }
  };

  const padKeyOf = (padId: string) => `pad:${track.id}:${padId}`;

  /** Pad-down via pointer/QWERTY: one immediate hit, repeats while held when armed. */
  const padDown = (padId: string, baseVelocity: number, holdKey: string) => {
    const pad = track.pads.find((p) => p.id === padId);
    if (!pad) return;
    services.noteRepeat.start(holdKey, track.id, padId, baseVelocity);
    const peak = pad.gain * baseVelocity;
    setPeaks((prev) => ({ ...prev, [padId]: peak }));
  };

  const padUp = (holdKey: string) => {
    services.noteRepeat.stop(holdKey);
  };

  // QWERTY pad play: hold a key to trigger (and repeat when armed). Plain
  // letters only — digits and modifier combos belong to the shortcut system.
  useEffect(() => {
    const padByKey = new Map<string, string>();
    track.pads.forEach((pad, index) => {
      if (index < PAD_KEYS.length) padByKey.set(PAD_KEYS[index], pad.id);
    });
    const isTypingTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const padId = padByKey.get(event.key.toLowerCase());
      if (!padId) return;
      event.preventDefault();
      padDown(padId, 1, `key:${event.key.toLowerCase()}`);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const padId = padByKey.get(event.key.toLowerCase());
      if (!padId) return;
      padUp(`key:${event.key.toLowerCase()}`);
    };
    const onBlur = () => {
      services.noteRepeat.stopAll();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      services.noteRepeat.stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, track.pads, services.noteRepeat]);

  const [peaks, setPeaks] = useState<Record<string, number>>({});
  const peaksRef = useRef(peaks);
  peaksRef.current = peaks;

  // Decay peaks 60fps
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [id, v] of Object.entries(peaksRef.current)) {
        const nv = v * 0.88;
        if (nv > 0.02) {
          next[id] = nv;
          changed = true;
        } else changed = true;
      }
      if (changed) setPeaks(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Playhead hit → peak from pattern velocity * pad gain
  const prevStepRef = useRef<number>(-1);
  useEffect(() => {
    if (playheadStep < 0 || prevStepRef.current === playheadStep) return;
    prevStepRef.current = playheadStep;
    for (const pad of track.pads) {
      const vel = pattern.rows[pad.id]?.[playheadStep] ?? 0;
      if (vel > 0 && !pad.mute && !track.mute) {
        const peak = Math.min(1.2, vel * pad.gain);
        setPeaks((prev) => ({ ...prev, [pad.id]: peak }));
      }
    }
  }, [playheadStep, pattern.rows, track.pads, track.mute]);

  return (
    <section className="rack" aria-label="Drum Rack">
      <div className="rack-header" role="group" aria-label="Note Repeat">
        <span className="rack-header-title">NOTE REPEAT</span>
        <label className="rack-header-field">
          <span>RATE</span>
          <select
            aria-label="Note repeat rate"
            value={repeatRate}
            onChange={(e) => {
              const rate = e.target.value as RepeatRate;
              setRepeatRate(rate);
              services.noteRepeat.setRate(rate);
            }}
          >
            {REPEAT_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate}
              </option>
            ))}
          </select>
        </label>
        <label className="rack-header-field">
          <span>VELO</span>
          <select
            aria-label="Note repeat velocity falloff"
            value={falloff}
            disabled={repeatRate === "off"}
            onChange={(e) => {
              const mode = e.target.value as FalloffMode;
              setFalloff(mode);
              services.noteRepeat.setFalloff(mode);
            }}
          >
            {FALLOFF_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>
        <span className="rack-header-hint">hold pad / QWERTYUI·ASDFGHJK</span>
      </div>
      {track.pads.map((pad, index) => {
        const hit = playheadStep >= 0 && (pattern.rows[pad.id]?.[playheadStep] ?? 0) > 0;
        const selected = pad.id === selectedPadId;
        const holdKey = padKeyOf(pad.id);
        return (
          <button
            key={pad.id}
            type="button"
            className={`pad${hit ? " hit" : ""}${selected ? " selected" : ""}`}
            style={{ "--pad-color": categoryColor(assetCategoryOf(pad)) } as React.CSSProperties}
            title={`${pad.name} — hold to play${repeatRate !== "off" ? ` (repeats ${repeatRate}, velocity ${falloff})` : ""} — key ${PAD_KEYS[index]?.toUpperCase() ?? "—"}`}
            onPointerDown={(event) => {
              event.preventDefault();
              onSelectPad(pad.id);
              padDown(pad.id, 1, holdKey);
            }}
            onPointerUp={() => padUp(holdKey)}
            onPointerLeave={() => padUp(holdKey)}
            onPointerCancel={() => padUp(holdKey)}
            onKeyDown={(event) => {
              // Keyboard-activated button (Enter/Space): single hit, no hold.
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectPad(pad.id);
                triggerPad(pad.id);
              }
            }}
          >
            <span className="pad-index">{index + 1}</span>
            <span className="pad-name">{pad.name}</span>
            {pad.synth && <span className="pad-synth-badge">{pad.synth.type.slice(0, 3).toUpperCase()}</span>}
            <span className="pad-meter" aria-hidden="true">
              <span className="pad-meter-fill" style={{ height: `${Math.min(100, (peaks[pad.id] ?? 0) * 100)}%` }} />
            </span>
          </button>
        );
      })}
    </section>
  );
}
