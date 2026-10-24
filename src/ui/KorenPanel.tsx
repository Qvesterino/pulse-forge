import { useEffect, useRef, useState } from "react";
import type { KorenMeterFrame } from "../audio-worklets/bass-harmonic-node";
import { readKorenSceneState } from "../effects/koren-scene";
import { KOREN_SCENE_PACK, findKorenScenePair, type KorenScenePair } from "../effects/koren-scene-pack";
import { useServices } from "./context";

/**
 * GROW (bassHarmonic) panel — live missing-fundamental visualizer + PHONE
 * CHECK + the level-matched A/B audition.
 *
 * Visualizer: a log axis (20–500 Hz) with the `focusHz` tracking window
 * shaded, the YIN-tracked fundamental marked, and the generated harmonic
 * bars (green = mono ≤ 120 Hz, amber = width-rotated above). Data comes from
 * the processor's throttled `type:"koren"` telemetry frame — a few scalars at
 * ~20 Hz; the panel polls `getFxMeters` at 15 Hz and paints straight to the
 * canvas (no React state on the hot path, same discipline as KaskadaPanel).
 *
 * PHONE CHECK: a monitor-only ~350 Hz highpass on the live listening path
 * (`AudioEngine.setMonitorHighpass`). Toggling it A/Bs what a phone speaker
 * hears — the moment the generated harmonics earn their keep. Never project
 * state, never part of a render, and always released on unmount.
 *
 * AUDITION (wave 1 of the flagship roadmap): a three-way monitor-only switch
 * — WET (the processed signal), DRY (the input alone) and HARMONICS (the
 * generated branch alone). The plugin level-matches the auditioned path to
 * the processed one, so the comparison is about TIMBRE and not loudness:
 * "the effect sounds better" is otherwise just "the effect is louder".
 * The switch is written to the RUNTIME (`AudioEngine.setFxAudition`), never
 * to the document — no command, no undo entry, no export. The panel only
 * reads the telemetry to say what it is listening to; the DSP never depends
 * on this panel being open.
 *
 * The panel is display + audition only: every AudioParam edit stays on the
 * generic device grid below it (single command path, one undo per gesture).
 *
 * SCENE PACK: the select applies a curated A/B pair (commands/korenScene.ts)
 * — both maps land in deviceState, the live params take the midpoint and every
 * difference becomes an intensity-sourced mapping, so the intro scene lands
 * side A and the drop lands B. The select reads CUSTOM when the stored slots
 * come from anything but a pack pair; the chip reports the armed binding.
 */

/** The monitor-only audition slots (the plugin decides what they carry). */
const AUDITION_MODES = [
  {
    id: 0,
    label: "WET",
    title: "the processed signal — the dry blend plus the generated harmonics",
  },
  {
    id: 1,
    label: "DRY",
    title: "the input alone, level-matched to the processed signal",
  },
  {
    id: 2,
    label: "HARM",
    title: "the generated harmonic branch alone, level-matched to the processed signal",
  },
] as const;

export function KorenPanel({
  trackId,
  fxId,
  params,
  degraded,
  docked = false,
  deviceState,
  sceneBound = false,
  onApplyScenePair,
}: {
  trackId: string;
  fxId: string;
  params: Record<string, number>;
  degraded: boolean;
  docked?: boolean;
  deviceState?: { kind: string; data: Record<string, unknown> } | null;
  sceneBound?: boolean;
  onApplyScenePair?: (pair: KorenScenePair) => void;
}) {
  const services = useServices();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<KorenMeterFrame | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const f0Ref = useRef<HTMLSpanElement>(null);
  const stateRef = useRef<HTMLSpanElement>(null);
  const confidenceRef = useRef<HTMLSpanElement>(null);
  const harmRef = useRef<HTMLSpanElement>(null);
  const auditionRef = useRef<HTMLSpanElement>(null);
  const [phoneOn, setPhoneOn] = useState(false);
  const [audition, setAudition] = useState(0);

  // PHONE CHECK is monitor-only and panel-scoped: when the device card (or
  // the panel itself) unmounts, the audition filter must not survive it.
  // The A/B audition is monitor-only for the same reason — it is released
  // with the panel so a closed panel never leaves the track in a comparison
  // state the user cannot see.
  useEffect(() => {
    const engine = services.engine as typeof services.engine & {
      setMonitorHighpass?: (hz: number | null) => void;
      setFxAudition?: (trackId: string, fxId: string, mode: number) => void;
    };
    return () => {
      engine.setMonitorHighpass?.(null);
      engine.setFxAudition?.(trackId, fxId, 0);
    };
  }, [services, trackId, fxId]);

  useEffect(() => {
    const engine = services.engine as typeof services.engine & {
      getFxMeters?: (trackId: string, fxId: string) => unknown;
    };
    const canvas = canvasRef.current;
    let observer: ResizeObserver | null = null;

    const sizeCanvas = () => {
      const el = canvasRef.current;
      if (!el) return;
      const w = Math.max(200, Math.floor(el.clientWidth));
      const h = Math.max(80, Math.floor(el.clientHeight));
      const dpr = window.devicePixelRatio || 1;
      el.width = Math.floor(w * dpr);
      el.height = Math.floor(h * dpr);
    };
    if (canvas && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(sizeCanvas);
      observer.observe(canvas);
    }
    sizeCanvas();

    const draw = () => {
      const el = canvasRef.current;
      if (!el) return;
      const c2d = el.getContext("2d");
      if (!c2d) return;
      const dpr = window.devicePixelRatio || 1;
      const cw = el.width / dpr;
      const ch = el.height / dpr;
      if (cw <= 0 || ch <= 0) return;
      c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      c2d.clearRect(0, 0, cw, ch);

      const F_LO = 20;
      const F_HI = 1400; // covers the 650 Hz presence hump and its 880 Hz tail
      const xOf = (f: number) => (Math.log(Math.min(F_HI, Math.max(F_LO, f)) / F_LO) / Math.log(F_HI / F_LO)) * cw;

      const focus = paramsRef.current.focusHz ?? 90;
      const frame = frameRef.current;
      const f0 = frame && frame.f0 > 0 ? frame.f0 : 0;

      // Tracking window (focusHz × [0.5, 2]) — everything outside it can
      // never be tracked, so nothing outside it is generated.
      const xa = xOf(focus * 0.5);
      const xb = xOf(focus * 2);
      c2d.fillStyle = "rgba(120, 200, 255, 0.10)";
      c2d.fillRect(xa, 0, Math.max(1, xb - xa), ch);
      c2d.strokeStyle = "rgba(120, 200, 255, 0.45)";
      c2d.beginPath();
      c2d.moveTo(xa, 0);
      c2d.lineTo(xa, ch);
      c2d.moveTo(xb, 0);
      c2d.lineTo(xb, ch);
      c2d.stroke();

      // WIDTH crossover: the sub stays mono, partials above this rotate.
      const xw = xOf(120);
      c2d.setLineDash([3, 4]);
      c2d.strokeStyle = "rgba(200, 200, 200, 0.35)";
      c2d.beginPath();
      c2d.moveTo(xw, 0);
      c2d.lineTo(xw, ch);
      c2d.stroke();
      c2d.setLineDash([]);

      // PHONE line: a small speaker's usable band starts ~350 Hz (PHONE CHECK's
      // highpass). Bars right of it are what survives on a phone.
      const xp = xOf(350);
      c2d.strokeStyle = "rgba(125, 211, 252, 0.5)";
      c2d.beginPath();
      c2d.moveTo(xp, 0);
      c2d.lineTo(xp, ch);
      c2d.stroke();

      // Tracked fundamental.
      if (f0 > 0) {
        const x = xOf(f0);
        c2d.strokeStyle = "rgba(255, 210, 120, 0.95)";
        c2d.beginPath();
        c2d.moveTo(x, 0);
        c2d.lineTo(x, ch);
        c2d.stroke();
      }

      // Generated harmonic bars at n·f0: green ≤ 120 Hz (mono width split),
      // amber 120–350 (laptop-band), sky blue > 350 (phones reproduce these).
      const partials = frame?.partials ?? null;
      if (f0 > 0 && partials && partials.length > 0) {
        let maxAmp = 1e-4;
        for (let i = 0; i < partials.length; i++) maxAmp = Math.max(maxAmp, partials[i] ?? 0);
        for (let n = 2; n <= 16; n++) {
          const amp = partials[n - 2] ?? 0;
          if (amp <= 1e-4) continue;
          const f = n * f0;
          if (f > F_HI * 1.4) continue;
          const x = xOf(f);
          const barH = Math.min(1, amp / maxAmp) * ch * 0.74;
          c2d.fillStyle =
            f <= 120 ? "rgba(150, 220, 160, 0.9)" : f <= 350 ? "rgba(255, 170, 120, 0.9)" : "rgba(125, 211, 252, 0.9)";
          c2d.fillRect(x - 2, ch - barH, 4, barH);
        }
      }
    };

    const timer = window.setInterval(() => {
      const raw = engine.getFxMeters?.(trackId, fxId) as Partial<KorenMeterFrame> | null;
      frameRef.current =
        raw && typeof raw.f0 === "number" && Number.isFinite(raw.f0)
          ? {
              f0: raw.f0,
              clarity: typeof raw.clarity === "number" ? raw.clarity : 0,
              harm: typeof raw.harm === "number" ? raw.harm : 0,
              key: typeof raw.key === "number" ? raw.key : 1,
              hint: typeof raw.hint === "number" ? raw.hint : 0,
              partials: raw.partials instanceof Float32Array ? raw.partials : null,
              audition: typeof raw.audition === "number" ? raw.audition : 0,
              matchDb: typeof raw.matchDb === "number" ? raw.matchDb : 0,
              audDb: typeof raw.audDb === "number" ? raw.audDb : 0,
            }
          : null;
      const frame = frameRef.current;
      const f0 = frame && frame.f0 > 0 ? frame.f0 : 0;
      if (stateRef.current) {
        stateRef.current.textContent = f0 > 0 ? ((frame?.clarity ?? 0) >= 0.85 ? "LOCKED" : "HOLD") : "SEARCH";
      }
      if (confidenceRef.current) {
        confidenceRef.current.textContent = f0 > 0 ? `${Math.round((frame?.clarity ?? 0) * 100)}% CONF` : "— CONF";
      }
      if (f0Ref.current) f0Ref.current.textContent = f0 > 0 ? `${f0.toFixed(1)} Hz` : "— Hz";
      if (harmRef.current) {
        harmRef.current.textContent =
          f0 > 0 && frame && frame.harm > 0 ? `+${frame.harm.toFixed(1)} dB harmonics` : "— dB harmonics";
      }
      if (auditionRef.current) {
        // The comparison state, read from the PROCESSOR's own match — the panel
        // never computes it, so a closed panel cannot change what it says.
        const mode = frame?.audition ?? 0;
        const matchDb = frame?.matchDb ?? 0;
        const audDb = frame?.audDb ?? 0;
        let text: string;
        let hint: string;
        if (mode === 0) {
          text = "LISTENING: WET";
          hint = "the processed signal";
        } else if (audDb <= -60) {
          // Silence, or a tracker that holds nothing: there is nothing to
          // compare, and the panel says so instead of showing a fake gain.
          text = mode === 2 ? "NO HARMONIC LAYER" : "NOTHING TO COMPARE";
          hint = "the compared path carries no signal";
        } else {
          const sign = matchDb >= 0 ? "+" : "";
          // The match is clamped: the source sits further from the reference
          // than the clamp allows, so the comparison is NOT level-neutral.
          const limited = matchDb < -audDb - 0.5;
          text = `${limited ? "MATCH LIMIT" : "MATCHED"} ${sign}${matchDb.toFixed(1)} dB`;
          hint = `${audDb.toFixed(1)} dB relative to the processed signal`;
        }
        // Write only on a CHANGE: the readout is inside an aria-live region,
        // and re-assigning the same text every poll would announce it forever.
        if (auditionRef.current.textContent !== text) auditionRef.current.textContent = text;
        if (auditionRef.current.title !== hint) auditionRef.current.title = hint;
      }
      draw();
    }, 66);

    return () => {
      observer?.disconnect();
      window.clearInterval(timer);
    };
  }, [services, trackId, fxId]);

  const togglePhone = () => {
    const engine = services.engine as typeof services.engine & {
      setMonitorHighpass?: (hz: number | null) => void;
    };
    const next = !phoneOn;
    setPhoneOn(next);
    engine.setMonitorHighpass?.(next ? 350 : null);
  };

  // The A/B switch is a RUNTIME write — the project never sees it, so there
  // is no command, no undo entry and nothing to persist.
  const selectAudition = (mode: number) => {
    const engine = services.engine as typeof services.engine & {
      setFxAudition?: (trackId: string, fxId: string, mode: number) => void;
    };
    setAudition(mode);
    engine.setFxAudition?.(trackId, fxId, mode);
  };

  const sceneState = readKorenSceneState(deviceState);
  const activePair = findKorenScenePair(sceneState?.slots);

  return (
    <section className={`koren-panel${docked ? " docked" : ""}`} aria-label="GROW visualizer">
      {degraded && <div className="koren-degraded">AudioWorklet unavailable — GROW is bypassed (1:1 signal)</div>}
      <div className="koren-head">
        <span className="koren-readout" ref={f0Ref}>
          — Hz
        </span>
        <span className="koren-state" ref={stateRef} aria-label="Pitch tracking state">
          SEARCH
        </span>
        <span className="koren-confidence" ref={confidenceRef}>
          — CONF
        </span>
        <span className="koren-boost" ref={harmRef}>
          — dB harmonics
        </span>
        <button
          type="button"
          className={`btn btn-small koren-phone${phoneOn ? " on" : ""}`}
          aria-pressed={phoneOn}
          onClick={togglePhone}
          title="Audition the whole mix through a small-speaker highpass (~350 Hz). Monitor only — never in exports."
        >
          PHONE CHECK
        </button>
        <select
          className="koren-pack"
          aria-label="Scene pack"
          value={activePair?.id ?? ""}
          disabled={!onApplyScenePair}
          title="Curated A/B pairs for the scene-intensity arc — the phone intro leans A, the drop lands B"
          onChange={(event) => {
            const pair = KOREN_SCENE_PACK.find((candidate) => candidate.id === event.target.value);
            if (pair) onApplyScenePair?.(pair);
          }}
        >
          {!activePair && <option value="">CUSTOM</option>}
          {KOREN_SCENE_PACK.map((pair) => (
            <option key={pair.id} value={pair.id}>
              {pair.genre} — {pair.label}
            </option>
          ))}
        </select>
        {sceneBound && (
          <span
            className="koren-chip"
            title="The pair rides the project's scene intensity — intro scenes lean A, drops land B"
          >
            SCENE-INTENSITY
          </span>
        )}
      </div>
      <canvas ref={canvasRef} className="koren-viz" />
      <div className="koren-ab-row">
        <div className="koren-ab" role="group" aria-label="Audition comparison">
          {AUDITION_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={`btn btn-small koren-ab-btn${audition === mode.id ? " on" : ""}`}
              aria-pressed={audition === mode.id}
              disabled={degraded}
              title={mode.title}
              onClick={() => selectAudition(mode.id)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <span className="koren-ab-state" ref={auditionRef} aria-live="polite">
          LISTENING: WET
        </span>
      </div>
      <details className="koren-notes">
        <summary>What lowCut, subAnchor and mix really do</summary>
        <ul>
          <li>
            <b>lowCut</b> ({params.lowCut ?? 45} Hz) — the corner of the highpass on the dry before the sub branch.
            Everything under it leaves the wet path.
          </li>
          <li>
            <b>subAnchor</b> ({params.subAnchor ?? 0.7}) — how much of the highpassed dry the wet path keeps. At 0 only
            the generated harmonics remain.
          </li>
          <li>
            <b>mix</b> ({params.mix ?? 0.6}) — dry ↔ wet blend. At <b>mix = 1</b> the dry is gone: what you hear is the
            highpassed dry plus the generated harmonics, so the sub under lowCut disappears.
          </li>
        </ul>
      </details>
    </section>
  );
}
