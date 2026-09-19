import { useEffect, useMemo, useRef } from "react";
import { setInstrumentParam } from "../commands/commands";
import { extractWavetable, FACTORY_WAVETABLES } from "../instruments/wavetables";
import type { InstrumentTrack, ProjectDocument } from "../project-model/types";
import type { Services } from "../services";
import { Slider } from "./controls";

/**
 * Wavetable panel — visual editing for the wavetable synth.
 *
 * Canvas: all frames of the active table stacked front-to-back, the two
 * frames under the morph position highlighted, and the blended current frame
 * drawn bright on top. With S RATE active a marker tracks the scan position.
 * Below: the per-voice modulation matrix (MOD A/B — source → destination →
 * amount) driving the wtvoice worklet routes.
 */

const SRC_OPTIONS = [
  { value: 0, label: "Env" },
  { value: 1, label: "LFO" },
  { value: 2, label: "Vel" },
  { value: 3, label: "Press" },
];

const DST_OPTIONS = [
  { value: 0, label: "Morph" },
  { value: 1, label: "Cutoff" },
  { value: 2, label: "Detune" },
  { value: 3, label: "Amp" },
];

const W = 320;
const H = 132;

export function WavetablePanel({
  track,
  doc,
  services,
}: {
  track: Extract<InstrumentTrack, { kind: "instrument" }>;
  doc: ProjectDocument;
  // Pick only what this panel uses — the broader `Services` contract requires
  // ~25 fields most of which are irrelevant here, and tests would otherwise
  // have to fake the entire interface. The inline-struct leak we previously
  // had (`execute: (c: unknown) => unknown`) is gone: this prop now has the
  // same exact type the production code site uses.
  services: Pick<Services, "bank" | "store">;
}) {
  const p = track.params;
  const tableIdx =
    ((Math.round(p.table ?? 0) % FACTORY_WAVETABLES.length) + FACTORY_WAVETABLES.length) % FACTORY_WAVETABLES.length;

  const table = useMemo(() => {
    if (track.sampleId) {
      const buffer = services.bank.get(track.sampleId);
      if (buffer) return extractWavetable(buffer.getChannelData(0), buffer.sampleRate) ?? FACTORY_WAVETABLES[tableIdx];
    }
    return FACTORY_WAVETABLES[tableIdx];
  }, [track.sampleId, tableIdx, services.bank]);

  const morph = Math.max(0, Math.min(1, p.morph ?? 0.3));
  const scanRate = Math.max(0, Math.min(8, p.scanRate ?? 0));

  const commit = (id: string, v: number) => services.store.execute(setInstrumentParam(doc, track.id, id, v));

  // ── Canvas drawing ──
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const frames = table.frames;
    const n = frames.length;
    const rowH = n > 1 ? (H - 28) / (n - 1) : 0;
    const baseY = H - 20;

    // frame stack (dim -> bright), deepest frame at the bottom
    for (let i = n - 1; i >= 0; i--) {
      const frame = frames[i];
      const yC = baseY - i * rowH;
      const near = 1 - i / Math.max(1, n - 1);
      ctx.strokeStyle = `rgba(140, 170, 220, ${0.18 + 0.3 * (1 - near)})`;
      ctx.beginPath();
      for (let x = 0; x <= W - 4; x += 2) {
        const sample = frame[Math.floor((x / (W - 4)) * (frame.length - 1))] ?? 0;
        const y = yC - sample * 14;
        if (x === 0) ctx.moveTo(x + 2, y);
        else ctx.lineTo(x + 2, y);
      }
      ctx.stroke();
    }

    // morph pair highlight
    const pos = morph * Math.max(1, n - 1);
    const ia = Math.min(n - 2, Math.floor(pos));
    const blend = n > 1 ? pos - ia : 0;
    const ib = Math.min(n - 1, ia + 1);
    for (const [i, color] of [
      [ia, "rgba(120, 220, 180, 0.9)"],
      [ib, "rgba(220, 180, 120, 0.9)"],
    ] as const) {
      const frame = frames[i];
      const yC = baseY - i * rowH;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let x = 0; x <= W - 4; x += 2) {
        const sample = frame[Math.floor((x / (W - 4)) * (frame.length - 1))] ?? 0;
        const y = yC - sample * 14;
        if (x === 0) ctx.moveTo(x + 2, y);
        else ctx.lineTo(x + 2, y);
      }
      ctx.stroke();
    }

    // current blended frame drawn bright across the middle
    const fa = frames[ia];
    const fb = frames[ib];
    ctx.strokeStyle = "rgba(240, 240, 255, 0.95)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x <= W - 4; x += 2) {
      const idx = Math.floor((x / (W - 4)) * (fa.length - 1));
      const sample = (fa[idx] ?? 0) * (1 - blend) + (fb[idx] ?? 0) * blend;
      const y = H / 2 - 6 - sample * 16;
      if (x === 0) ctx.moveTo(x + 2, y);
      else ctx.lineTo(x + 2, y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  };

  useEffect(() => {
    draw();
    // scan position animates only when the scan engine runs
    if (scanRate <= 0) return;
    let raf = 0;
    const tick = () => {
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, morph, scanRate]);

  const selectRow = (
    label: string,
    src: number,
    dst: number,
    amt: number,
    srcParam: string,
    dstParam: string,
    amtParam: string,
  ) => (
    <div className="wt-mod-row">
      <span className="wt-mod-label">{label}</span>
      <select
        className="wt-mod-select"
        aria-label={`${label} source`}
        value={src}
        onChange={(e) => commit(srcParam, Number(e.target.value))}
      >
        {SRC_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="wt-mod-arrow">→</span>
      <select
        className="wt-mod-select"
        aria-label={`${label} destination`}
        value={dst}
        onChange={(e) => commit(dstParam, Number(e.target.value))}
      >
        {DST_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <div className="wt-mod-amt">
        <Slider
          label="AMT"
          min={-1}
          max={1}
          value={amt}
          defaultValue={0}
          format={(v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`}
          onCommit={(v) => commit(amtParam, v)}
        />
      </div>
    </div>
  );

  return (
    <div className="wt-panel">
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className="wt-canvas"
        aria-label={`Wavetable ${table.name} — ${table.frames.length} frames, morph ${morph.toFixed(2)}`}
      />
      <div className="wt-caption">
        <span>{track.sampleId ? `SAMPLE — ${table.name}` : table.name.toUpperCase()}</span>
        <span>
          {table.frames.length} FRAMES · MORPH {morph.toFixed(2)}
          {scanRate > 0 ? ` · SCAN ${scanRate.toFixed(2)} Hz` : ""}
        </span>
      </div>
      {selectRow("MOD A", p.modASrc ?? 0, p.modADst ?? 0, p.modAAmt ?? 0, "modASrc", "modADst", "modAAmt")}
      {selectRow("MOD B", p.modBSrc ?? 0, p.modBDst ?? 1, p.modBAmt ?? 0, "modBSrc", "modBDst", "modBAmt")}
      <Slider
        label="MOD LFO"
        min={0}
        max={12}
        value={p.modLfoRate ?? 2}
        defaultValue={2}
        format={(v) => `${v.toFixed(2)} Hz`}
        onCommit={(v) => commit("modLfoRate", v)}
      />
    </div>
  );
}
