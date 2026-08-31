import { useEffect, useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import { setInstrumentParam, setPadSynth, setPadParams } from "../commands/commands";
import { INSTRUMENT_DEFS } from "../instruments/registry";
import { Slider } from "./controls";
import type { Track } from "../project-model/types";

/** Hobby vs Profi — hobby shows 4 essential knobs, profi shows all. */
type PluginMode = "hobby" | "profi";

/**
 * Floating, draggable instrument plugin window — native DAW plugin.
 * One window per instrument: click kick/drums/keys → open dedicated panel.
 * Drag header to move, X to close. Hobby/Profi toggle separates simple vs full.
 */
export function FloatingPlugin({
  trackId,
  selectedPadId,
  onClose,
}: {
  trackId: string;
  selectedPadId: string;
  onClose: () => void;
}) {
  const services = useServices();
  const doc = useDoc();
  const track = doc.tracks.find((t) => t.id === trackId);
  const [mode, setMode] = useState<PluginMode>(() => {
    try {
      return (localStorage.getItem("pf:pluginMode") as PluginMode) ?? "hobby";
    } catch {
      return "hobby";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("pf:pluginMode", mode);
    } catch {}
  }, [mode]);

  const [pos, setPos] = useState({ x: 120, y: 80 });
  const dragging = useRef<{ dx: number; dy: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    dragging.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    setPos({ x: e.clientX - dragging.current.dx, y: e.clientY - dragging.current.dy });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {}
  };

  // Close on Escape
  useEffect(() => {
    const h = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  if (!track) return null;

  const isDrum = track.kind === "drum";
  const pad = isDrum ? (track.pads.find((p: any) => p.id === selectedPadId) ?? (track as any).pads[0]) : null;
  let title: string;
  if (isDrum) title = `DRUMS — ${pad?.name ?? "PAD"}`;
  else if (track.kind === "instrument")
    title = `${INSTRUMENT_DEFS[track.instrument].name.toUpperCase()} — ${track.name}`;
  else title = track.name;

  return (
    <div
      className="floating-plugin"
      role="dialog"
      aria-label={`${title} plugin`}
      aria-modal={false}
      style={{ left: pos.x, top: pos.y }}
    >
      <div
        className="floating-plugin-header"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span className="floating-plugin-title">{title}</span>
        <div className="floating-plugin-actions">
          <div className="floating-plugin-mode" role="group" aria-label="Plugin mode">
            <button
              type="button"
              className={`btn btn-small${mode === "hobby" ? " active" : ""}`}
              aria-pressed={mode === "hobby"}
              onClick={() => setMode("hobby")}
              title="Hobby — 4 knobs"
            >
              HOBBY
            </button>
            <button
              type="button"
              className={`btn btn-small${mode === "profi" ? " active" : ""}`}
              aria-pressed={mode === "profi"}
              onClick={() => setMode("profi")}
              title="Profi — full controls"
            >
              PROFI
            </button>
          </div>
          <button type="button" className="btn btn-small" aria-label="Close plugin" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>

      <div className="floating-plugin-body">
        {isDrum && pad ? (
          <DrumPluginContent track={track as any} pad={pad} mode={mode} doc={doc} services={services} />
        ) : track.kind === "instrument" ? (
          <InstrumentPluginContent track={track as any} mode={mode} doc={doc} services={services} />
        ) : track.kind === "group" ? (
          <div className="floating-plugin-empty">Group — no instrument params</div>
        ) : null}
      </div>
    </div>
  );
}

const HOBBY_PARAMS: Record<string, string[]> = {
  sampler: ["attack", "cutoff", "gain", "level"],
  analog: ["cutoff", "resonance", "attack", "level"],
  bass: ["sub", "body", "punch", "level"],
  "808": ["decay", "pitchDrop", "drive", "level"],
  texture: ["color", "density", "level", "chaos"],
  wavetable: ["table", "morph", "cutoff", "level"],
  granular: ["position", "size", "rate", "gain"],
  keys: ["tine", "bell", "ratio", "level"],
  pluck: ["pick", "body", "decay", "level"],
  logdrum: ["decay", "tone", "body", "level"],
};

function InstrumentPluginContent({
  track,
  mode,
  doc,
  services,
}: {
  track: Extract<Track, { kind: "instrument" }>;
  mode: PluginMode;
  doc: any;
  services: any;
}) {
  const def: any = INSTRUMENT_DEFS[track.instrument];
  const params: any[] = mode === "hobby" ? hobbyParams(def.params, track.instrument) : def.params;

  return (
    <div className="floating-plugin-grid">
      {params.map((p: any) =>
        p.options ? (
          <label key={p.id} className="fx-param-select floating-plugin-select">
            <span className="slider-label">{p.label}</span>
            <select
              value={
                p.options.some((o: any) => o.value === (track.params[p.id] ?? p.default))
                  ? (track.params[p.id] ?? p.default)
                  : p.default
              }
              onChange={(e) => services.store.execute(setInstrumentParam(doc, track.id, p.id, Number(e.target.value)))}
            >
              {p.options.map((o: any) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <Slider
            key={p.id}
            compact={mode === "hobby"}
            label={p.label}
            value={track.params[p.id] ?? p.default}
            min={p.min}
            max={p.max}
            defaultValue={p.default}
            format={p.format}
            onCommit={(v) => services.store.execute(setInstrumentParam(doc, track.id, p.id, v))}
          />
        ),
      )}
    </div>
  );
}

function DrumPluginContent({
  track,
  pad,
  mode,
  doc,
  services,
}: {
  track: Extract<Track, { kind: "drum" }>;
  pad: (typeof track)["pads"][number];
  mode: PluginMode;
  doc: any;
  services: any;
}) {
  const isSynth = !!pad.synth;
  // Pad gain/pan/pitch always visible; synth knobs hobby vs profi
  return (
    <div className="floating-plugin-stack">
      <div className="floating-plugin-pad-switch">
        <span className="slider-label">PAD — {pad.name}</span>
        <span className={`floating-plugin-badge${isSynth ? " is-synth" : ""}`}>
          {isSynth ? pad.synth!.type : "SAMPLE"}
        </span>
      </div>

      {isSynth && (
        <div className="floating-plugin-grid">
          <label className="fx-param-select floating-plugin-select">
            <span className="slider-label">TYPE</span>
            <select
              value={pad.synth?.type ?? "hatClosed"}
              onChange={(e) => {
                const type = e.target.value as any;
                const defaults: Record<string, { decay: number; tone: number; snap: number; body: number }> = {
                  hatClosed: { decay: 0.08, tone: 7500, snap: 0.35, body: 0.3 },
                  hatOpen: { decay: 0.32, tone: 7000, snap: 0.55, body: 0.5 },
                  clap: { decay: 0.25, tone: 1200, snap: 0.4, body: 0.5 },
                  perc: { decay: 0.12, tone: 2100, snap: 0.35, body: 0.45 },
                  cowbell: { decay: 0.32, tone: 540, snap: 0.35, body: 0.5 },
                  kick: { decay: 0.42, tone: 5000, snap: 0.3, body: 0.6 },
                  snare: { decay: 0.22, tone: 1750, snap: 0.45, body: 0.5 },
                };
                const d = defaults[type];
                services.store.execute(
                  setPadSynth(doc, pad.id, { type, decay: d.decay, tone: d.tone, snap: d.snap, body: d.body }),
                );
              }}
            >
              <option value="hatClosed">Hat Closed</option>
              <option value="hatOpen">Hat Open</option>
              <option value="clap">Clap</option>
              <option value="perc">Perc</option>
              <option value="cowbell">Cowbell</option>
              <option value="kick">Kick</option>
              <option value="snare">Snare</option>
            </select>
          </label>
          <Slider
            compact
            label="DECAY"
            value={pad.synth?.decay ?? 0.08}
            min={0.02}
            max={1.2}
            defaultValue={0.08}
            format={(v) => `${v.toFixed(2)} s`}
            onCommit={(decay) => services.store.execute(setPadSynth(doc, pad.id, { ...(pad.synth as any), decay }))}
          />
          <Slider
            compact
            label="TONE"
            value={pad.synth?.tone ?? 5000}
            min={200}
            max={12000}
            defaultValue={5000}
            format={(v) => `${Math.round(v)} Hz`}
            onCommit={(tone) => services.store.execute(setPadSynth(doc, pad.id, { ...(pad.synth as any), tone }))}
          />
          {(mode === "profi" || pad.synth?.type === "hatClosed" || pad.synth?.type === "hatOpen") && (
            <Slider
              compact
              label="SNAP"
              value={(pad.synth as any)?.snap ?? 0.35}
              min={0}
              max={1}
              defaultValue={0.35}
              format={(v) => `${Math.round(v * 100)}`}
              onCommit={(snap) => services.store.execute(setPadSynth(doc, pad.id, { ...(pad.synth as any), snap }))}
            />
          )}
          {mode === "profi" &&
            (pad.synth?.type === "kick" || pad.synth?.type === "snare" || pad.synth?.type === "clap") && (
              <Slider
                compact
                label="BODY"
                value={(pad.synth as any)?.body ?? 0.5}
                min={0}
                max={1}
                defaultValue={0.5}
                format={(v) => `${Math.round(v * 100)}`}
                onCommit={(body) => services.store.execute(setPadSynth(doc, pad.id, { ...(pad.synth as any), body }))}
              />
            )}
        </div>
      )}

      <div className="floating-plugin-grid" style={{ marginTop: 8 }}>
        <Slider
          compact
          label="GAIN"
          value={pad.gain}
          min={0}
          max={2}
          defaultValue={1}
          format={(v) => `${(20 * Math.log10(Math.max(v, 0.001))).toFixed(1)} dB`}
          onCommit={(gain) => services.store.execute(setPadParams(doc, pad.id, { gain }))}
        />
        <Slider
          compact
          label="PAN"
          value={pad.pan}
          min={-1}
          max={1}
          defaultValue={0}
          format={(v) => (Math.abs(v) < 0.02 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`)}
          onCommit={(pan) => services.store.execute(setPadParams(doc, pad.id, { pan }))}
        />
        <Slider
          compact
          label="PITCH"
          value={pad.pitch}
          min={-24}
          max={24}
          defaultValue={0}
          format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} st`}
          onCommit={(pitch) => services.store.execute(setPadParams(doc, pad.id, { pitch }))}
        />
      </div>
    </div>
  );
}

function hobbyParams(params: readonly any[], kind?: string): any[] {
  if (kind && HOBBY_PARAMS[kind]) {
    const ids = HOBBY_PARAMS[kind];
    const picked = ids.map((id) => params.find((p) => p.id === id)).filter(Boolean) as any[];
    if (picked.length >= 3) return picked;
  }
  // Fallback generic
  const keep = new Set([
    "sub",
    "tune",
    "cutoff",
    "decay",
    "level",
    "gain",
    "attack",
    "tine",
    "body",
    "pick",
    "table",
    "position",
  ]);
  const picked = params.filter((p) => keep.has(p.id) || p.label === "LEVEL" || p.label === "GAIN");
  if (picked.length < 3) return params.slice(0, 4) as any;
  const level = params.find((p) => p.id === "level" || p.id === "gain");
  const withoutLevel = picked.filter((p) => p !== level);
  const result = withoutLevel.slice(0, 3);
  if (level) result.push(level as any);
  return result as any;
}
