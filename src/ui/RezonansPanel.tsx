import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  REZ_PARAM,
  VOICE_COUNT,
  clampParam,
  paramDef,
  resolveFormantSemitones,
  voiceParamId,
} from "../effects/rezonans-core/contracts/parameters";
import { Slider } from "./controls";
import { useServices } from "./context";

/**
 * REZONANS panel — the formant warp, then the voice table.
 *
 * The canvas is two stacked views of what the device is actually doing:
 *
 *   TOP      the frequency-axis WARP. Log-frequency in, semitones of formant
 *            displacement out, so every enabled voice draws as a horizontal
 *            line and the global shift draws as a dashed one. Dragging
 *            vertically moves the global formant. This is α = 2^(st/12), the
 *            same mapping `FormantWarp` runs, so the curve is the control and
 *            not an illustration of it.
 *
 *   BOTTOM   the PITCH LADDER: what the singer sang, the chord root the
 *            resolver was following, and where each voice actually landed.
 *
 * The ladder reads the markers from the processor's own meter snapshot and
 * NEVER recomputes them host-side. A panel that re-derived the targets from
 * the chord lane would draw a harmony the audio is not producing — the mask
 * the worklet holds, the clarity gate and the unvoiced hold all change the
 * outcome, and only the solver knows the final one. If the meter is missing,
 * the ladder says "waiting" instead of guessing.
 *
 * The voice table owns the 24 per-voice parameters so they are one labelled
 * row each rather than six pages of unlabelled knobs in the generic pager.
 */

const MODE_LABELS = ["OFF", "INTERVAL", "DEGREES", "CHORD TONES"] as const;
const MODE_HINTS = [
  "harmony off",
  "intervals follow the singer's pitch",
  "degree selects a key note near the singer",
  "degree anchors each voice; chord follow pulls it into the chord",
] as const;
const QUALITY_LABELS = ["ECONOMY", "BALANCED", "FINE"] as const;
const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"] as const;

/** Per-voice sliders shown in each row, in reading order. */
const ROW_FIELDS = ["degree", "level", "pan", "formant", "humanize"] as const;

const VOICE_COLORS = [
  "rgba(120, 205, 255, 0.95)",
  "rgba(255, 170, 120, 0.95)",
  "rgba(175, 235, 150, 0.95)",
  "rgba(215, 160, 255, 0.95)",
] as const;

/** Pitch class → name, for the chord marker. */
function pcLabel(pc: number): string {
  return NOTE_NAMES[((pc % 12) + 12) % 12]!;
}

/** Frequency → the nearest MIDI note, for the readout. */
function hzToMidiLabel(hz: number): string {
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]!}${Math.floor(midi / 12) - 1}`;
}

function ordinal(value: number): string {
  const n = Math.max(1, Math.round(value));
  const lastTwo = n % 100;
  const suffix =
    lastTwo >= 11 && lastTwo <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

export function RezonansPanel({
  trackId,
  fxId,
  params,
  degraded,
  docked = false,
  onParam,
  onGestureStart,
  onGestureEnd,
}: {
  trackId: string;
  fxId: string;
  params: Record<string, number>;
  degraded: boolean;
  docked?: boolean;
  onParam?: (paramId: string, value: number) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
}) {
  const services = useServices();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const draggingRef = useRef(false);
  const [unavailable, setUnavailable] = useState(false);

  // Metering is panel-scoped: the engine flips the worklet's meter work on
  // here and off on unmount, so a closed panel costs nothing on the audio
  // thread. A missing engine method is tolerated (older host, headless test)
  // and reported in the readout rather than silently drawing a dead ladder.
  useEffect(() => {
    const engine = services.engine as typeof services.engine & {
      setFxMetersEnabled?: (trackId: string, fxId: string, enabled: boolean) => void;
    };
    if (!engine.setFxMetersEnabled) {
      setUnavailable(true);
      return;
    }
    engine.setFxMetersEnabled(trackId, fxId, true);
    return () => engine.setFxMetersEnabled?.(trackId, fxId, false);
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
      const dpr = window.devicePixelRatio || 1;
      el.width = Math.max(200, Math.floor(el.clientWidth)) * dpr;
      el.height = Math.max(120, Math.floor(el.clientHeight)) * dpr;
    };

    // A meter frame is untrusted: it crossed a MessagePort, and a malformed
    // one must degrade to "no pitch" rather than throw inside the poll.
    const readMeters = () => {
      const raw = engine.getFxMeters?.(trackId, fxId) as Record<string, unknown> | null | undefined;
      if (!raw || typeof raw !== "object") return null;
      const num = (key: string): number => {
        const v = raw[key];
        return typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
      };
      const midi = Array.isArray(raw.voiceMidi)
        ? (raw.voiceMidi as unknown[]).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : -1))
        : null;
      return {
        f0: num("f0"),
        clarity: num("clarity"),
        chordPc: num("chordPc"),
        latencySamples: num("latencySamples"),
        sampleRate: num("sampleRate"),
        voiceMidi: midi,
      };
    };

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

      const p = paramsRef.current;
      const globalFormant = p[REZ_PARAM.formant] ?? 0;
      const voiceScale = p[REZ_PARAM.formantVoiceScale] ?? 1;
      const m = readMeters();
      const f0 = m?.f0 ?? Number.NaN;
      const clarity = m?.clarity ?? Number.NaN;
      const chordPc = m?.chordPc ?? Number.NaN;
      const voiced = Number.isFinite(f0) && f0 > 0 && Number.isFinite(clarity) && clarity > 0;

      // ── top: the formant warp ──────────────────────────────────────────
      const warpH = Math.round(ch * 0.52);
      const F_LO = 70;
      const F_HI = 11000;
      const SEMI_SPAN = 12;
      const xOf = (f: number) => (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * cw;
      const yOf = (semis: number) => warpH * 0.5 - (semis / SEMI_SPAN) * (warpH * 0.42);

      // Decade grid.
      c2d.strokeStyle = "rgba(200, 200, 200, 0.16)";
      c2d.fillStyle = "rgba(200, 200, 200, 0.45)";
      c2d.font = "9px monospace";
      for (const f of [100, 1000, 10000]) {
        const x = xOf(f);
        c2d.beginPath();
        c2d.moveTo(x, 0);
        c2d.lineTo(x, warpH);
        c2d.stroke();
        c2d.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, warpH - 3);
      }

      // Zero displacement.
      c2d.strokeStyle = "rgba(255, 255, 255, 0.22)";
      c2d.beginPath();
      c2d.moveTo(0, yOf(0));
      c2d.lineTo(cw, yOf(0));
      c2d.stroke();

      // The global shift, dashed — the line a voice is measured against.
      c2d.strokeStyle = "rgba(255, 255, 255, 0.34)";
      c2d.setLineDash([4, 4]);
      c2d.beginPath();
      c2d.moveTo(0, yOf(globalFormant));
      c2d.lineTo(cw, yOf(globalFormant));
      c2d.stroke();
      c2d.setLineDash([]);

      // One solid line per enabled voice, at its TOTAL displacement.
      for (let i = 0; i < VOICE_COUNT; i++) {
        if ((p[voiceParamId(i, "enabled")] ?? 0) <= 0.5) continue;
        const total = resolveFormantSemitones(globalFormant, p[voiceParamId(i, "formant")] ?? 0, voiceScale);
        const y = yOf(total);
        if (y < 0 || y > warpH) continue;
        c2d.strokeStyle = VOICE_COLORS[i]!;
        c2d.lineWidth = 1.5;
        c2d.beginPath();
        c2d.moveTo(0, y);
        c2d.lineTo(cw, y);
        c2d.stroke();
        c2d.fillStyle = VOICE_COLORS[i]!;
        c2d.fillText(`V${i + 1}`, 4, y - 3 > 9 ? y - 3 : y + 10);
      }
      c2d.lineWidth = 1;
      c2d.fillStyle = "rgba(200, 200, 200, 0.45)";
      c2d.fillText(`FORMANT ${globalFormant >= 0 ? "+" : ""}${globalFormant.toFixed(1)} st`, 4, 10);

      // ── bottom: the pitch ladder ───────────────────────────────────────
      const ladderTop = warpH + 8;
      const ladderH = ch - ladderTop - 2;
      c2d.strokeStyle = "rgba(255, 255, 255, 0.12)";
      c2d.strokeRect(0.5, ladderTop + 0.5, cw - 1, ladderH - 1);

      const railY = ladderTop + ladderH - 9;
      if (!voiced) {
        c2d.fillStyle = "rgba(200, 200, 200, 0.45)";
        c2d.font = "10px monospace";
        const why = degraded
          ? "REZONANS is bypassed"
          : unavailable || !m
            ? "meters unavailable on this host"
            : clarity >= 0
              ? "no clear pitch — hold a vowel"
              : "listening…";
        c2d.fillText(why, 8, ladderTop + ladderH / 2);
      } else {
        const singerMidi = 69 + 12 * Math.log2(f0 / 440);
        const SPAN = 14;
        const lx = (midi: number) => cw * 0.5 + ((midi - singerMidi) / SPAN) * (cw * 0.5);

        // Semitone grid, labelled on each C.
        const from = Math.ceil(singerMidi - SPAN);
        const to = Math.floor(singerMidi + SPAN);
        for (let note = from; note <= to; note++) {
          const x = lx(note);
          if (x < 1 || x > cw - 1) continue;
          const isC = ((note % 12) + 12) % 12 === 0;
          c2d.strokeStyle = isC ? "rgba(255, 255, 255, 0.18)" : "rgba(200, 200, 200, 0.07)";
          c2d.beginPath();
          c2d.moveTo(x, ladderTop + 1);
          c2d.lineTo(x, ladderTop + ladderH - 1);
          c2d.stroke();
          if (isC) {
            c2d.fillStyle = "rgba(255, 255, 255, 0.45)";
            c2d.font = "9px monospace";
            c2d.fillText(pcLabel(note), x + 2, ladderTop + ladderH - 3);
          }
        }

        const singerX = lx(singerMidi);

        // Chord root the resolver is currently following.
        if (Number.isFinite(chordPc) && chordPc >= 0) {
          const rootMidi = from + ((((chordPc - (from % 12)) % 12) + 12) % 12);
          const rx = lx(rootMidi);
          if (rx >= 0 && rx <= cw) {
            c2d.strokeStyle = "rgba(255, 210, 120, 0.65)";
            c2d.setLineDash([2, 3]);
            c2d.beginPath();
            c2d.moveTo(rx, ladderTop + 1);
            c2d.lineTo(rx, ladderTop + ladderH - 1);
            c2d.stroke();
            c2d.setLineDash([]);
            c2d.fillStyle = "rgba(255, 210, 120, 0.9)";
            c2d.font = "9px monospace";
            c2d.fillText(pcLabel(chordPc), rx + 2, ladderTop + 10);
          }
        }

        // The singer.
        c2d.strokeStyle = "rgba(255, 255, 255, 0.8)";
        c2d.lineWidth = 2;
        c2d.beginPath();
        c2d.moveTo(singerX, railY);
        c2d.lineTo(singerX, railY - 7);
        c2d.stroke();
        c2d.lineWidth = 1;
        c2d.fillStyle = "rgba(255, 255, 255, 0.85)";
        c2d.font = "9px monospace";
        c2d.fillText("DRY", singerX + 3, ladderTop + 10);

        // The resolved voice targets — the solver's own answer, never a guess.
        for (let i = 0; i < VOICE_COUNT; i++) {
          if ((p[voiceParamId(i, "enabled")] ?? 0) <= 0.5) continue;
          const target = m?.voiceMidi?.[i];
          if (typeof target !== "number" || target < 0) continue;
          const x = lx(target);
          if (x < -8 || x > cw + 8) continue;
          const level = p[voiceParamId(i, "level")] ?? 0;
          const semis = Math.round(target - singerMidi);
          c2d.strokeStyle = VOICE_COLORS[i]!;
          c2d.lineWidth = 1.5;
          c2d.beginPath();
          c2d.moveTo(singerX, railY);
          c2d.lineTo(x, railY);
          c2d.stroke();
          c2d.lineWidth = 1;
          c2d.fillStyle = VOICE_COLORS[i]!;
          c2d.beginPath();
          c2d.arc(x, railY, 2.5 + Math.max(0, level) * 2.5, 0, Math.PI * 2);
          c2d.fill();
          c2d.fillText(`${semis > 0 ? "+" : ""}${semis}`, x + 4, railY - 5 > ladderTop + 9 ? railY - 5 : railY + 10);
        }
      }

      // ── readout ────────────────────────────────────────────────────────
      if (readoutRef.current) {
        const mode = MODE_LABELS[Math.max(0, Math.min(3, Math.round(p[REZ_PARAM.harmonyMode] ?? 0)))]!;
        const chord = Number.isFinite(chordPc) && chordPc >= 0 ? ` · ${pcLabel(chordPc)}` : "";
        const latency =
          m && Number.isFinite(m.latencySamples) && Number.isFinite(m.sampleRate) && m.sampleRate > 0
            ? ` · ${((m.latencySamples / m.sampleRate) * 1000) | 0}ms`
            : "";
        readoutRef.current.textContent = voiced
          ? `${f0.toFixed(0)} Hz ${hzToMidiLabel(f0)} · ${mode}${chord}${latency}`
          : degraded
            ? `bypassed · ${mode}`
            : `no pitch · ${mode}${chord}`;
      }
    };

    if (canvas && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        sizeCanvas();
        draw();
      });
      observer.observe(canvas);
    }
    sizeCanvas();
    draw();

    const timer = window.setInterval(draw, 66);
    return () => {
      observer?.disconnect();
      window.clearInterval(timer);
    };
  }, [services, trackId, fxId, degraded, unavailable]);

  // ── drag the warp curve ────────────────────────────────────────────────
  const SEMI_SPAN = 12;

  const dragToFormant = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!onParam) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const warpH = rect.height * 0.52;
    const y = Math.min(rect.height, Math.max(0, event.clientY - rect.top));
    // Same axis the curve is drawn on: mid-height is 0 st, the box edges ±12.
    const semis = ((warpH * 0.5 - y) / (warpH * 0.42)) * SEMI_SPAN;
    onParam(REZ_PARAM.formant, Math.round(Math.max(-SEMI_SPAN, Math.min(SEMI_SPAN, semis)) * 10) / 10);
  };

  // Live drag preview: straight to the runtime, bypassing the document. The
  // undoable write still happens once on commit. Clamped here because the
  // worklet port trusts the host.
  const previewParam = (paramId: string, value: number) => {
    services.engine.previewFxParam?.(trackId, fxId, paramId, clampParam(paramId, value));
  };

  const mode = Math.max(0, Math.min(3, Math.round(params[REZ_PARAM.harmonyMode] ?? 0)));
  const quality = Math.max(0, Math.min(2, Math.round(params[REZ_PARAM.quality] ?? 1)));
  const chordFollowing = mode === 3;
  const globalFormant = params[REZ_PARAM.formant] ?? 0;

  const chips = [
    `MODE ${MODE_LABELS[mode]}`,
    chordFollowing ? ((params[REZ_PARAM.chordFollow] ?? 0) > 0.5 ? "CHORD FOLLOW" : "SCALE ONLY") : "NO CHORD",
    `Q ${QUALITY_LABELS[quality]}`,
    `GLIDE ${Math.round((params[REZ_PARAM.glide] ?? 0) * 100)}%`,
    `MIX ${Math.round((params[REZ_PARAM.mix] ?? 0) * 100)}%`,
  ];

  return (
    <section className={`rezonans-panel${docked ? " docked" : ""}`} aria-label="REZONANS formant and harmony">
      {degraded && (
        <div className="rezonans-degraded">AudioWorklet unavailable — REZONANS is bypassed (1:1 signal)</div>
      )}
      <div className="rezonans-head">
        <span className="rezonans-readout" ref={readoutRef}>
          no pitch
        </span>
        <span className="rezonans-hint" title={`Drag the warp to move the global formant; ${MODE_HINTS[mode]}`}>
          drag warp = formant · {MODE_HINTS[mode]}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        className="rezonans-viz"
        onPointerDown={(event) => {
          if (!onParam) return;
          draggingRef.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          onGestureStart?.();
          dragToFormant(event);
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current) return;
          dragToFormant(event);
        }}
        onPointerUp={(event) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          onGestureEnd?.();
        }}
        onPointerCancel={() => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          onGestureEnd?.();
        }}
      />

      {/* The 24 per-voice parameters: one labelled row per voice. */}
      <div className="rezonans-voices">
        {Array.from({ length: VOICE_COUNT }, (_, i) => {
          const enabled = (params[voiceParamId(i, "enabled")] ?? 0) > 0.5;
          return (
            <div key={i} className={`rezonans-voice${enabled ? " on" : ""}`}>
              <button
                type="button"
                className="rezonans-voice-toggle"
                aria-pressed={enabled}
                onClick={() => onParam?.(voiceParamId(i, "enabled"), enabled ? 0 : 1)}
              >
                V{i + 1}
              </button>
              {ROW_FIELDS.map((field) => {
                const id = voiceParamId(i, field);
                const def = paramDef(id);
                if (!def) return null;
                return (
                  <Slider
                    key={field}
                    compact
                    label={field === "degree" && mode === 1 ? "interval" : field}
                    value={params[id] ?? def.def}
                    min={def.min}
                    max={def.max}
                    defaultValue={def.def}
                    disabled={!enabled}
                    format={(v) =>
                      field === "degree"
                        ? mode === 1
                          ? `${v > 0 ? "+" : ""}${Math.round(v)}st`
                          : ordinal(v + 1)
                        : field === "pan"
                          ? v.toFixed(2)
                          : v.toFixed(2)
                    }
                    onCommit={(v) => onParam?.(id, v)}
                    onPreview={(v) => previewParam(id, v)}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="rezonans-chips">
        {chips.map((chip) => (
          <span key={chip} className="rezonans-chip">
            {chip}
          </span>
        ))}
      </div>
      <span className="rezonans-sr" aria-live="polite">
        {`${MODE_LABELS[mode]}, ${globalFormant.toFixed(1)} semitones formant`}
      </span>
    </section>
  );
}
