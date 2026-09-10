import { useEffect, useRef, useState } from "react";
import {
  blendPadToEngineWeights,
  ENGINE2_ALGOS,
  ASSISTANT_TONES,
  defaultOzvenaStateV1,
} from "../effects/ozvena-core/v2/types";
import { recommend, applyRecommendation, defaultAssistantState } from "../effects/ozvena-core/core/reverbAssistant";
import { Slider } from "./controls";

/** Vertices of the blend triangle in normalized pad space (y up). */
const VERTICES = {
  e1: { x: 0.06, y: 0.1, label: "E1 REFLECTIONS" },
  e2: { x: 0.94, y: 0.1, label: "E2 PLATE" },
  e3: { x: 0.5, y: 0.9, label: "E3 HALL" },
};
const VERTEX_COLORS = {
  e1: "#22d3ee",
  e2: "#f59e0b",
  e3: "#a78bfa",
};

/** Flatten a state tree into dotted numeric/boolean params for bulk apply. */
function flattenState(state: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (node: unknown, prefix: string) => {
    if (node === null || node === undefined || Array.isArray(node)) return;
    if (typeof node === "object") {
      for (const [key, value] of Object.entries(node)) walk(value, prefix ? `${prefix}.${key}` : key);
      return;
    }
    if (typeof node === "number" || typeof node === "boolean") {
      out[prefix] = typeof node === "boolean" ? (node ? 1 : 0) : node;
    }
  };
  walk(state, "");
  return out;
}

/**
 * OzvenaPanel — the XY Blend Pad: Ozvena's heart.
 *
 * The pad is an equilateral triangle whose vertices are the three reverb
 * engines; dragging the point morphs the space barycentrically. Plus engine
 * toggles with E2 algorithm, and the Reverb Assistant (style/size/tone →
 * one-gesture starting point with a human summary).
 */
export function OzvenaPanel({
  params,
  degraded,
  onParam,
  onApplyPatch,
}: {
  params: Record<string, number>;
  degraded?: boolean;
  onParam: (paramId: string, value: number) => void;
  onApplyPatch: (label: string, flatParams: Record<string, number>) => void;
}) {
  const padRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);
  const [engine2Algo, setEngine2Algo] = useState(() =>
    Math.max(0, Math.min(ENGINE2_ALGOS.length - 1, Math.round(params["engines.e2.algo"] ?? 0))),
  ); // index into ENGINE2_ALGOS
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistStyle, setAssistStyle] = useState(0.5);
  const [assistSize, setAssistSize] = useState(0.5);
  const [assistTone, setAssistTone] = useState(0);
  const [assistSummary, setAssistSummary] = useState<string | null>(null);

  const x = Math.max(0, Math.min(1, params["blendPad.x"] ?? 0.5));
  const y = Math.max(0, Math.min(1, params["blendPad.y"] ?? 0.5));
  const weights = blendPadToEngineWeights(x, y);
  useEffect(() => {
    setEngine2Algo(Math.max(0, Math.min(ENGINE2_ALGOS.length - 1, Math.round(params["engines.e2.algo"] ?? 0))));
  }, [params["engines.e2.algo"]]);
  const enabled = (mod: string) => (params[`${mod}.enabled`] ?? 0) >= 0.5;

  // ── pad drawing ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = padRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width;
    const h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);

    const px = (vx: number) => (0.04 + vx * 0.92) * w;
    const py = (vy: number) => (0.92 - vy * 0.84) * h;

    // Triangle.
    ctx2d.beginPath();
    ctx2d.moveTo(px(VERTICES.e1.x), py(VERTICES.e1.y));
    ctx2d.lineTo(px(VERTICES.e2.x), py(VERTICES.e2.y));
    ctx2d.lineTo(px(VERTICES.e3.x), py(VERTICES.e3.y));
    ctx2d.closePath();
    ctx2d.fillStyle = "rgba(255,255,255,0.04)";
    ctx2d.fill();
    ctx2d.strokeStyle = "#3f3f46";
    ctx2d.lineWidth = dpr;
    ctx2d.stroke();

    // Weight glows at vertices.
    for (const [key, weight] of Object.entries(weights)) {
      const v = VERTICES[key as keyof typeof VERTICES];
      if (weight <= 0.01) continue;
      const grad = ctx2d.createRadialGradient(
        px(v.x),
        py(v.y),
        0,
        px(v.x),
        py(v.y),
        42 * dpr * Math.min(1, weight + 0.3),
      );
      grad.addColorStop(0, VERTEX_COLORS[key as keyof typeof VERTICES] + "55");
      grad.addColorStop(1, "transparent");
      ctx2d.fillStyle = grad;
      ctx2d.fillRect(0, 0, w, h);
    }

    // Vertex dots + labels.
    for (const [key, v] of Object.entries(VERTICES)) {
      ctx2d.beginPath();
      ctx2d.arc(px(v.x), py(v.y), 4 * dpr, 0, Math.PI * 2);
      ctx2d.fillStyle = VERTEX_COLORS[key as keyof typeof VERTICES];
      ctx2d.fill();
      ctx2d.font = `700 ${9 * dpr}px system-ui, sans-serif`;
      ctx2d.fillStyle = VERTEX_COLORS[key as keyof typeof VERTICES];
      const label = v.label;
      const textW = ctx2d.measureText(label).width;
      const lx = v.x < 0.5 ? px(v.x) + 6 * dpr : px(v.x) - textW - 6 * dpr;
      const ly = v.y < 0.5 ? py(v.y) - 8 * dpr : py(v.y) + 14 * dpr;
      ctx2d.fillText(label, Math.max(2 * dpr, Math.min(w - textW - 2 * dpr, lx)), ly);
    }

    // Current point.
    ctx2d.beginPath();
    ctx2d.arc(px(x), py(y), 7 * dpr, 0, Math.PI * 2);
    ctx2d.fillStyle = "#f4f4f5";
    ctx2d.fill();
    ctx2d.strokeStyle = "#0e0f12";
    ctx2d.lineWidth = 2 * dpr;
    ctx2d.stroke();
  }, [x, y, weights]);

  // ── pad interaction (mouse + touch + keyboard) ─────────────────────────
  const onPointer = (clientX: number, clientY: number, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, ((clientX - rect.left) / rect.width - 0.04) / 0.92));
    const ny = Math.max(0, Math.min(1, (0.92 - (clientY - rect.top) / rect.height) / 0.84));
    onParam("blendPad.x", +nx.toFixed(4));
    onParam("blendPad.y", +ny.toFixed(4));
  };

  // 2-D pad on a 1-D slider role: X is the primary aria value, valuetext
  // carries the full engine distribution for screen readers.
  const padValueText = `E1 ${(weights.e1 * 100).toFixed(0)}%, E2 ${(weights.e2 * 100).toFixed(0)}%, E3 ${(weights.e3 * 100).toFixed(0)}%`;

  const onPadKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const key = e.key;
    let dx = 0;
    let dy = 0;
    let step = 0.05;
    if (key === "ArrowLeft") dx = -1;
    else if (key === "ArrowRight") dx = 1;
    else if (key === "ArrowUp") dy = 1;
    else if (key === "ArrowDown") dy = -1;
    else if (key === "PageUp") {
      dy = 1;
      step = 0.25;
    } else if (key === "PageDown") {
      dy = -1;
      step = 0.25;
    } else return;
    e.preventDefault();
    if (e.shiftKey && step === 0.05) step = 0.01;
    const nx = Math.max(0, Math.min(1, x + dx * step));
    const ny = Math.max(0, Math.min(1, y + dy * step));
    if (nx === x && ny === y) return;
    onParam("blendPad.x", +nx.toFixed(4));
    onParam("blendPad.y", +ny.toFixed(4));
  };

  // ── Reverb Assistant ────────────────────────────────────────────────────
  const runAssistant = () => {
    setAssistBusy(true);
    try {
      const assistant = {
        ...defaultAssistantState(),
        style: assistStyle,
        size: assistSize,
        dryWet: 1, // propose full wet — the rack MIX stays under user control
        tone: ASSISTANT_TONES[assistTone],
      };
      const rec = recommend(assistant);
      const base = defaultOzvenaStateV1();
      const nextState = applyRecommendation(base, rec);
      const proposed = flattenState(nextState as unknown as Record<string, unknown>);
      const baseline = flattenState(base as unknown as Record<string, unknown>);
      // DIFF-BASED PATCH: only fields the recommendation actually moves
      // away from the defaults land in the patch. The user's untouched
      // configuration — engine toggles, MIX, convolution choices, anything
      // not proposed — survives the gesture (applyOzvenaStatePatch merges).
      const flat: Record<string, number> = {};
      for (const [key, value] of Object.entries(proposed)) {
        if (baseline[key] !== value) flat[key] = value;
      }
      // Wizard bookkeeping is not sound; gain staging stays with the user.
      for (const key of Object.keys(flat)) {
        if (key.startsWith("assistant.")) delete flat[key];
      }
      delete flat["global.inputGainDb"];
      delete flat["global.outputGainDb"];
      delete flat["global.levelDb"];
      if (Object.keys(flat).length > 0) {
        onApplyPatch(`Reverb assist (${ASSISTANT_TONES[assistTone]})`, flat);
      }
      setAssistSummary(rec.summary || "Assistant starting point applied.");
    } finally {
      setAssistBusy(false);
    }
  };

  return (
    <div className="fxeq-panel ultina-panel ozvena-panel" aria-label="VØID reverb editor">
      {degraded && <div className="fxeq-degraded">AudioWorklet unavailable — VØID is bypassed (1:1 signal)</div>}

      {/* ── XY BLEND PAD ─────────────────────────────────────────────── */}
      <div className="ultina-assist-head">
        <span className="ultina-assist-title">BLEND PAD</span>
        <div className="ozvena-weights" aria-label="Engine mix">
          <span style={{ color: VERTEX_COLORS.e1 }}>E1 {(weights.e1 * 100).toFixed(0)}%</span>
          <span style={{ color: VERTEX_COLORS.e2 }}>E2 {(weights.e2 * 100).toFixed(0)}%</span>
          <span style={{ color: VERTEX_COLORS.e3 }}>E3 {(weights.e3 * 100).toFixed(0)}%</span>
        </div>
      </div>
      <canvas
        ref={padRef}
        className="ozvena-pad"
        width={512}
        height={280}
        role="slider"
        aria-label="Blend pad"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(x * 100)}
        aria-valuetext={padValueText}
        tabIndex={0}
        style={{ touchAction: "none" }}
        onKeyDown={onPadKeyDown}
        onPointerDown={(e) => {
          draggingRef.current = true;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // synthetic pointers have no active id — drag still tracks
          }
          onPointer(e.clientX, e.clientY, e.currentTarget);
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) onPointer(e.clientX, e.clientY, e.currentTarget);
        }}
        onPointerUp={() => {
          draggingRef.current = false;
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
        }}
      />

      {/* ── ENGINE TOGGLES ───────────────────────────────────────────── */}
      <div className="ozvena-engines">
        {(["e1", "e2", "e3"] as const).map((mod) => (
          <div key={mod} className={`ozvena-engine${enabled(mod) ? "" : " fxeq-module-off"}`}>
            <div className="ultina-module-head">
              <span className="fxeq-module-tag" style={{ background: VERTEX_COLORS[mod] }}>
                {mod.toUpperCase()}
              </span>
              <button
                type="button"
                className={`btn btn-small${enabled(mod) ? " active" : ""}`}
                aria-pressed={enabled(mod)}
                onClick={() => onParam(`engines.${mod}.enabled`, enabled(mod) ? 0 : 1)}
              >
                {enabled(mod) ? "ON" : "OFF"}
              </button>
            </div>
            {enabled(mod) && mod === "e2" && (
              <label className="collab-field">
                <span>ALGO</span>
                <select
                  value={engine2Algo}
                  onChange={(e) => {
                    const idx = Number(e.target.value);
                    setEngine2Algo(idx);
                    // The DSP state carries the algorithm as a string — the
                    // worklet maps the numeric enum index to ENGINE2_ALGOS.
                    onParam("engines.e2.algo", idx);
                  }}
                >
                  {ENGINE2_ALGOS.map((algo, idx) => (
                    <option key={algo} value={idx}>
                      {algo}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ))}
      </div>

      {/* ── REVERB ASSISTANT ─────────────────────────────────────────── */}
      <div className="ultina-assist" aria-label="Reverb assistant">
        <div className="ultina-assist-head">
          <span className="ultina-assist-title">REVERB ASSISTANT</span>
          <button
            type="button"
            className="btn btn-export"
            disabled={assistBusy}
            title="Propose a starting space from style/size/tone"
            onClick={runAssistant}
          >
            {assistBusy ? "…" : "⚡ ASSIST"}
          </button>
        </div>
        <div className="ultina-assist-opts">
          <label className="collab-field">
            <span>STYLE — {assistStyle < 0.33 ? "room" : assistStyle < 0.66 ? "stage" : "epic"}</span>
            <Slider
              compact
              label=""
              value={assistStyle}
              min={0}
              max={1}
              defaultValue={0.5}
              format={(v) => `${(v * 100).toFixed(0)}%`}
              onCommit={setAssistStyle}
            />
          </label>
          <label className="collab-field">
            <span>SIZE</span>
            <Slider
              compact
              label=""
              value={assistSize}
              min={0}
              max={1}
              defaultValue={0.5}
              format={(v) => `${(v * 100).toFixed(0)}%`}
              onCommit={setAssistSize}
            />
          </label>
          <label className="collab-field">
            <span>TONE</span>
            <select value={assistTone} onChange={(e) => setAssistTone(Number(e.target.value))}>
              {ASSISTANT_TONES.map((tone, idx) => (
                <option key={tone} value={idx}>
                  {tone}
                </option>
              ))}
            </select>
          </label>
        </div>
        {assistSummary && <div className="ultina-assist-summary">{assistSummary}</div>}
      </div>
    </div>
  );
}
