import { useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import {
  addAutomationLane,
  addAutomationPoint,
  addLfo,
  addMacroMapping,
  addSceneAutomation,
  addSceneAutomationPoint,
  deleteAutomationPoint,
  moveAutomationPoint,
  moveSceneAutomationPoint,
  removeAutomationLane,
  removeLfo,
  removeMacroMapping,
  removeSceneAutomation,
  removeSceneAutomationPoint,
  renameMacro,
  setLfoParams,
  setMacroMappingAmount,
  setMacroValue,
  setSceneIntensity,
  setSceneIntensityCurve,
} from "../commands/commands";
import type { AutomationParamKind, AutomationTarget, LfoKind, LfoWave } from "../project-model/types";
import { STEP_TICKS } from "../project-model/types";
import { DEFAULT_STEP_PATTERN } from "../project-model/modulators";
import { laneLabel } from "../project-model/automation";
import { EFFECT_DEFS } from "../effects/registry";
import { INSTRUMENT_DEFS } from "../instruments/registry";
import { Slider } from "./controls";
import { trackBadge } from "./TrackTabs";
import { clamp } from "../shared/ids";
import { StepGridEditor } from "./StepGridEditor";
import { newModulatorSeed } from "../commands/commands";

const LFO_WAVES: { value: LfoWave; label: string }[] = [
  { value: "sine", label: "Sine" },
  { value: "triangle", label: "Tri" },
  { value: "square", label: "Sqr" },
  { value: "sawUp", label: "Saw ↑" },
  { value: "sawDown", label: "Saw ↓" },
];

const LFO_DIVISIONS = [
  { value: 0, label: "1/1" },
  { value: 1, label: "1/2" },
  { value: 2, label: "1/4" },
  { value: 3, label: "1/8" },
  { value: 4, label: "1/16" },
];

const LFO_KINDS: { value: LfoKind; label: string }[] = [
  { value: "osc", label: "LFO" },
  { value: "random", label: "S&H Random" },
  { value: "step", label: "Step Gate" },
  { value: "envFollower", label: "Env Follower" },
];

function kindSwitchPatch(kind: LfoKind, hostTrackId: string): Parameters<typeof setLfoParams>[2] {
  switch (kind) {
    case "random":
      return {
        kind,
        snh: "hold",
        rateMode: "sync",
        rateHz: 8,
        division: 3,
        seed: newModulatorSeed(),
        target: undefined,
      };
    case "step":
      return { kind, division: 3, glideSec: 0.02, steps: [...DEFAULT_STEP_PATTERN], target: undefined };
    case "envFollower":
      return { kind, sourceTrackId: hostTrackId, attackMs: 12, releaseMs: 180, sensitivity: 1.5 };
    default:
      return { kind: undefined, wave: "sine", rateMode: "sync", rateHz: 2, division: 2, target: undefined };
  }
}

/** Encoded automation-target options for schedulable modulators (host track scope). */
function targetOptionsFor(doc: ReturnType<typeof useDoc>, hostTrackId: string): { value: string; label: string }[] {
  const options = [
    { value: "trackGain:", label: "Volume" },
    { value: "trackPan:", label: "Pan" },
  ];
  const host = doc.tracks.find((t) => t.id === hostTrackId);
  if (host?.kind === "instrument") {
    for (const p of INSTRUMENT_DEFS[host.instrument].params) {
      options.push({ value: `instParam::${p.id}`, label: p.label });
    }
  }
  if (host && "effects" in host) {
    for (const fx of host.effects) {
      for (const p of EFFECT_DEFS[fx.type].params) {
        options.push({ value: `fxParam:${fx.id}:${p.id}`, label: `${EFFECT_DEFS[fx.type].name} · ${p.label}` });
      }
    }
  }
  return options;
}

function parseEncodedTarget(hostTrackId: string, encoded: string): AutomationTarget {
  const [kind, fxId, paramId] = encoded.split(":");
  if (kind === "instParam") return { kind: "instParam", trackId: hostTrackId, paramId };
  if (kind === "fxParam") return { kind: "fxParam", trackId: hostTrackId, fxId, paramId };
  return { kind: kind === "trackPan" ? "trackPan" : "trackGain", trackId: hostTrackId };
}

function encodeTarget(target: AutomationTarget | undefined): string {
  if (!target) return "trackGain:";
  return `${target.kind}:${target.fxId ?? ""}:${target.paramId ?? ""}`;
}

const KIND_LABELS: Record<LfoKind, string> = {
  osc: "LFO",
  random: "S&H",
  step: "STEP",
  envFollower: "ENV",
};

interface ParamRange {
  min: number;
  max: number;
  format?: (v: number) => string;
}

function laneRange(doc: ReturnType<typeof useDoc>, target: AutomationTarget): ParamRange {
  if (target.kind === "trackGain") return { min: 0, max: 1.5, format: (v) => v.toFixed(2) };
  if (target.kind === "trackPan") return { min: -1, max: 1, format: (v) => (Math.abs(v) < 0.02 ? "C" : v.toFixed(2)) };
  const track = doc.tracks.find((t) => t.id === target.trackId);
  if (target.kind === "fxParam" && track && "effects" in track) {
    const fx = track.effects.find((f) => f.id === target.fxId);
    if (fx) {
      const def = EFFECT_DEFS[fx.type].params.find((p) => p.id === target.paramId);
      if (def) return { min: def.min, max: def.max, format: def.format };
    }
  }
  if (target.kind === "instParam" && track?.kind === "instrument") {
    const def = INSTRUMENT_DEFS[track.instrument].params.find((p) => p.id === target.paramId);
    if (def) return { min: def.min, max: def.max, format: def.format };
  }
  return { min: 0, max: 1 };
}

function trackBadgeSafe(track: { kind: string; instrument?: string } | undefined): string {
  if (!track) return "??";
  if (track.kind === "drum") return "DR";
  const badge: Record<string, string> = { sampler: "SMP", analog: "AN", bass: "BSS", "808": "808" };
  return badge[track.instrument ?? ""] ?? "??";
}

export function ModPanel() {
  const services = useServices();
  const doc = useDoc();
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(doc.automation[0]?.id ?? null);
  const [addTarget, setAddTarget] = useState<{
    trackId: string;
    kind: AutomationParamKind;
    fxId?: string;
    paramId?: string;
  }>({
    trackId: doc.tracks[0]?.id ?? "",
    kind: "trackGain",
  });

  const selectedLane = doc.automation.find((l) => l.id === selectedLaneId) ?? null;
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId)!;

  const submitAddLane = () => {
    if (!addTarget.trackId) return;
    const target: AutomationTarget = {
      kind: addTarget.kind,
      trackId: addTarget.trackId,
      fxId: addTarget.fxId,
      paramId: addTarget.paramId,
    };
    try {
      services.store.execute(addAutomationLane(services.store.doc, target));
    } catch {
      // duplicate lane: ignore
    }
  };

  const addableTrack = doc.tracks.find((t) => t.id === addTarget.trackId);

  return (
    <section className="mod-panel" aria-label="Automation, LFOs and macros">
      <div className="mod-section">
        <h2 className="panel-title">AUTOMATION</h2>
        <div className="mod-lane-add">
          <select
            aria-label="Automation target track"
            value={addTarget.trackId}
            onChange={(event) => setAddTarget({ trackId: event.target.value, kind: "trackGain" })}
          >
            {doc.tracks.map((track) => (
              <option key={track.id} value={track.id}>
                {trackBadge(track)} {track.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Automation target parameter"
            value={`${addTarget.kind}:${addTarget.fxId ?? ""}:${addTarget.paramId ?? ""}`}
            onChange={(event) => {
              const [kind, fxId, paramId] = event.target.value.split(":");
              setAddTarget((prev) => ({
                ...prev,
                kind: kind as AutomationParamKind,
                fxId: fxId || undefined,
                paramId: paramId || undefined,
              }));
            }}
          >
            <option value="trackGain:">Volume</option>
            <option value="trackPan:">Pan</option>
            {addableTrack?.kind === "instrument" &&
              INSTRUMENT_DEFS[addableTrack.instrument].params.map((p) => (
                <option key={p.id} value={`instParam::${p.id}`}>
                  {p.label}
                </option>
              ))}
            {addableTrack &&
              "effects" in addableTrack &&
              addableTrack.effects.map((fx) =>
                EFFECT_DEFS[fx.type].params.map((p) => (
                  <option key={`${fx.id}:${p.id}`} value={`fxParam:${fx.id}:${p.id}`}>
                    {EFFECT_DEFS[fx.type].name} · {p.label}
                  </option>
                )),
              )}
          </select>
          <button type="button" className="btn btn-small" onClick={submitAddLane}>
            + LANE
          </button>
        </div>
        <div className="mod-lane-list">
          {doc.automation.length === 0 && <div className="fx-empty">No automation lanes yet.</div>}
          {doc.automation.map((lane) => {
            const track = doc.tracks.find((t) => t.id === lane.target.trackId);
            const fxName =
              lane.target.kind === "fxParam" && track && "effects" in track
                ? EFFECT_DEFS[track.effects.find((f) => f.id === lane.target.fxId)?.type ?? "eq"]?.name
                : undefined;
            return (
              <div key={lane.id} className={`mod-lane-row${lane.id === selectedLaneId ? " selected" : ""}`}>
                <button type="button" className="mod-lane-label" onClick={() => setSelectedLaneId(lane.id)}>
                  {laneLabel(lane, track?.name ?? "?", fxName)} · {lane.points.length} pts
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-danger"
                  title="Remove lane"
                  onClick={() => {
                    services.store.execute(removeAutomationLane(services.store.doc, lane.id));
                    if (selectedLaneId === lane.id) setSelectedLaneId(null);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        {selectedLane && (
          <PointEditor
            laneId={selectedLane.id}
            points={selectedLane.points}
            patternTicks={STEP_TICKS * pattern.stepCount}
            range={laneRange(doc, selectedLane.target)}
          />
        )}
      </div>

      <div className="mod-section">
        <h2 className="panel-title">MODULATORS</h2>
        <div className="mod-lane-add">
          <select
            aria-label="Add modulator"
            value=""
            onChange={(event) => {
              const encoded = event.target.value;
              const sep = encoded.indexOf(":");
              if (sep > 0) {
                const kind = encoded.slice(0, sep) as LfoKind;
                services.store.execute(addLfo(services.store.doc, encoded.slice(sep + 1), kind));
              }
            }}
          >
            <option value="">+ ADD MODULATOR…</option>
            {LFO_KINDS.map((kind) => (
              <optgroup key={kind.value} label={kind.label}>
                {doc.tracks.map((track) => (
                  <option key={`${kind.value}:${track.id}`} value={`${kind.value}:${track.id}`}>
                    {trackBadge(track)} {track.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="lfo-list">
          {doc.lfos.length === 0 && (
            <div className="fx-empty">
              No modulators yet. Oscillators run at audio rate; S&amp;H and step patterns schedule per division;
              followers track dynamics.
            </div>
          )}
          {doc.lfos.map((lfo) => {
            const track = doc.tracks.find((t) => t.id === lfo.trackId);
            const kind: LfoKind = lfo.kind ?? "osc";
            return (
              <div key={lfo.id} className={`lfo-row${kind !== "osc" ? " lfo-row-sched" : ""}`}>
                <div className="lfo-row-header">
                  <span className="lfo-row-name">
                    {trackBadgeSafe(track)} {track?.name ?? "?"} · {KIND_LABELS[kind]}
                  </span>
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    title="Remove modulator"
                    onClick={() => services.store.execute(removeLfo(services.store.doc, lfo.id))}
                  >
                    ×
                  </button>
                </div>
                <div className="lfo-row-controls">
                  <label className="fx-param-select">
                    <span className="slider-label">TYPE</span>
                    <select
                      value={kind}
                      onChange={(event) =>
                        services.store.execute(
                          setLfoParams(
                            services.store.doc,
                            lfo.id,
                            kindSwitchPatch(event.target.value as LfoKind, lfo.trackId),
                          ),
                        )
                      }
                    >
                      {LFO_KINDS.map((k) => (
                        <option key={k.value} value={k.value}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {(kind === "osc" || kind === "envFollower") && (
                    <label className="fx-param-select">
                      <span className="slider-label">TARGET</span>
                      <select
                        value={lfo.param}
                        onChange={(event) =>
                          services.store.execute(
                            setLfoParams(services.store.doc, lfo.id, {
                              param: event.target.value as "gain" | "pan",
                              target: undefined,
                            }),
                          )
                        }
                      >
                        <option value="gain">Volume</option>
                        <option value="pan">Pan</option>
                      </select>
                    </label>
                  )}

                  {(kind === "random" || kind === "step") && (
                    <label className="fx-param-select">
                      <span className="slider-label">TARGET</span>
                      <select
                        value={encodeTarget(lfo.target)}
                        onChange={(event) =>
                          services.store.execute(
                            setLfoParams(services.store.doc, lfo.id, {
                              target: parseEncodedTarget(lfo.trackId, event.target.value),
                              param: "gain",
                            }),
                          )
                        }
                      >
                        {targetOptionsFor(doc, lfo.trackId).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {kind === "osc" && (
                    <>
                      <label className="fx-param-select">
                        <span className="slider-label">WAVE</span>
                        <select
                          value={lfo.wave ?? "sine"}
                          onChange={(event) =>
                            services.store.execute(
                              setLfoParams(services.store.doc, lfo.id, { wave: event.target.value as LfoWave }),
                            )
                          }
                        >
                          {LFO_WAVES.map((w) => (
                            <option key={w.value} value={w.value}>
                              {w.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="fx-param-select">
                        <span className="slider-label">SYNC</span>
                        <select
                          value={lfo.rateMode ?? "sync"}
                          onChange={(event) =>
                            services.store.execute(
                              setLfoParams(services.store.doc, lfo.id, {
                                rateMode: event.target.value as "hz" | "sync",
                              }),
                            )
                          }
                        >
                          <option value="sync">Tempo</option>
                          <option value="hz">Hz</option>
                        </select>
                      </label>
                    </>
                  )}

                  {(kind === "osc" || kind === "random") && (
                    <>
                      {(lfo.rateMode ?? "sync") === "sync" ? (
                        <label className="fx-param-select">
                          <span className="slider-label">RATE</span>
                          <select
                            value={lfo.division ?? 2}
                            onChange={(event) =>
                              services.store.execute(
                                setLfoParams(services.store.doc, lfo.id, { division: Number(event.target.value) }),
                              )
                            }
                          >
                            {LFO_DIVISIONS.map((d) => (
                              <option key={d.value} value={d.value}>
                                {d.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <Slider
                          compact
                          label="RATE"
                          value={lfo.rateHz ?? 2}
                          min={0.1}
                          max={20}
                          defaultValue={2}
                          format={(v) => `${v.toFixed(2)} Hz`}
                          onCommit={(rateHz) =>
                            services.store.execute(setLfoParams(services.store.doc, lfo.id, { rateHz }))
                          }
                        />
                      )}
                    </>
                  )}

                  {kind === "random" && (
                    <>
                      <label className="fx-param-select">
                        <span className="slider-label">MODE</span>
                        <select
                          value={lfo.snh ?? "hold"}
                          onChange={(event) =>
                            services.store.execute(
                              setLfoParams(services.store.doc, lfo.id, { snh: event.target.value as "hold" | "glide" }),
                            )
                          }
                        >
                          <option value="hold">Hold</option>
                          <option value="glide">Glide</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        className="btn btn-small"
                        title="Generate a new random seed (deterministic once stored)"
                        onClick={() =>
                          services.store.execute(setLfoParams(services.store.doc, lfo.id, { seed: newModulatorSeed() }))
                        }
                      >
                        🎲 SEED
                      </button>
                    </>
                  )}

                  {kind === "step" && (
                    <>
                      <label className="fx-param-select">
                        <span className="slider-label">RATE</span>
                        <select
                          value={lfo.division ?? 3}
                          onChange={(event) =>
                            services.store.execute(
                              setLfoParams(services.store.doc, lfo.id, { division: Number(event.target.value) }),
                            )
                          }
                        >
                          {LFO_DIVISIONS.map((d) => (
                            <option key={d.value} value={d.value}>
                              {d.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Slider
                        compact
                        label="GLIDE"
                        value={lfo.glideSec ?? 0.02}
                        min={0}
                        max={0.3}
                        defaultValue={0.02}
                        format={(v) => `${Math.round(v * 1000)} ms`}
                        onCommit={(glideSec) =>
                          services.store.execute(setLfoParams(services.store.doc, lfo.id, { glideSec }))
                        }
                      />
                      <StepGridEditor
                        steps={lfo.steps && lfo.steps.length > 0 ? lfo.steps : [...DEFAULT_STEP_PATTERN]}
                        onCommit={(steps) =>
                          services.store.execute(setLfoParams(services.store.doc, lfo.id, { steps }))
                        }
                      />
                    </>
                  )}

                  {kind === "envFollower" && (
                    <>
                      <label className="fx-param-select">
                        <span className="slider-label">SOURCE</span>
                        <select
                          value={lfo.sourceTrackId ?? lfo.trackId}
                          onChange={(event) =>
                            services.store.execute(
                              setLfoParams(services.store.doc, lfo.id, { sourceTrackId: event.target.value }),
                            )
                          }
                        >
                          {doc.tracks.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {trackBadge(candidate)} {candidate.name}
                              {candidate.id === lfo.trackId ? " (self)" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Slider
                        compact
                        label="ATTACK"
                        value={lfo.attackMs ?? 12}
                        min={1}
                        max={400}
                        defaultValue={12}
                        format={(v) => `${Math.round(v)} ms`}
                        onCommit={(attackMs) =>
                          services.store.execute(setLfoParams(services.store.doc, lfo.id, { attackMs }))
                        }
                      />
                      <Slider
                        compact
                        label="RELEASE"
                        value={lfo.releaseMs ?? 180}
                        min={20}
                        max={2000}
                        defaultValue={180}
                        format={(v) => `${Math.round(v)} ms`}
                        onCommit={(releaseMs) =>
                          services.store.execute(setLfoParams(services.store.doc, lfo.id, { releaseMs }))
                        }
                      />
                      <Slider
                        compact
                        label="SENSITIVITY"
                        value={lfo.sensitivity ?? 1.5}
                        min={0.2}
                        max={3}
                        defaultValue={1.5}
                        format={(v) => v.toFixed(2)}
                        onCommit={(sensitivity) =>
                          services.store.execute(setLfoParams(services.store.doc, lfo.id, { sensitivity }))
                        }
                      />
                      <label className="fx-param-select">
                        <span className="slider-label">POLARITY</span>
                        <select
                          value={(lfo.polarity ?? -1) === 1 ? "swell" : "duck"}
                          onChange={(event) =>
                            services.store.execute(
                              setLfoParams(services.store.doc, lfo.id, {
                                polarity: event.target.value === "swell" ? 1 : -1,
                              }),
                            )
                          }
                        >
                          <option value="duck">Duck</option>
                          <option value="swell">Swell</option>
                        </select>
                      </label>
                    </>
                  )}

                  <Slider
                    compact
                    label="AMOUNT"
                    value={lfo.amount}
                    min={0}
                    max={1}
                    defaultValue={0.3}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onCommit={(amount) => services.store.execute(setLfoParams(services.store.doc, lfo.id, { amount }))}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mod-section">
        <ScenePanel />
      </div>

      <div className="mod-section">
        <h2 className="panel-title">MACROS</h2>
        <div className="macro-grid">
          {doc.macros.map((macro) => (
            <MacroCard key={macro.id} macro={macro} />
          ))}
        </div>
      </div>
    </section>
  );
}

function PointEditor({
  laneId,
  points,
  patternTicks,
  range,
}: {
  laneId: string;
  points: { tick: number; value: number }[];
  patternTicks: number;
  range: ParamRange;
}) {
  const services = useServices();
  const canvasRef = useRef<HTMLDivElement>(null);
  // Drag state: index of the point being dragged plus its live position. We
  // commit a single command on pointer-up so a drag doesn't pile up dozens
  // of undo steps (or push older history off the 256-entry cap).
  const dragRef = useRef<{ index: number; tick: number; value: number } | null>(null);
  const [livePos, setLivePos] = useState<{ index: number; tick: number; value: number } | null>(null);

  const posFromEvent = (event: React.PointerEvent): { tick: number; value: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { tick: 0, value: range.min };
    const rect = canvas.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    return {
      tick: Math.round(((x / rect.width) * patternTicks) / STEP_TICKS) * STEP_TICKS,
      value: range.max - (y / rect.height) * (range.max - range.min),
    };
  };

  const findPoint = (event: { clientX: number; clientY: number }): number => {
    const canvas = canvasRef.current;
    if (!canvas) return -1;
    const rect = canvas.getBoundingClientRect();
    const tPx = (t: number) => (t / patternTicks) * rect.width;
    const vPy = (v: number) => rect.height - ((v - range.min) / (range.max - range.min)) * rect.height;
    for (let i = 0; i < points.length; i++) {
      const dx = Math.abs(tPx(points[i].tick) - (event.clientX - rect.left));
      const dy = Math.abs(vPy(points[i].value) - (event.clientY - rect.top));
      if (dx < 8 && dy < 8) return i;
    }
    return -1;
  };

  const onCanvasPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    if (event.target !== canvasRef.current) return;
    const index = findPoint(event);
    if (index >= 0) {
      dragRef.current = { index, tick: points[index].tick, value: points[index].value };
      setLivePos({ index, tick: points[index].tick, value: points[index].value });
      event.currentTarget.setPointerCapture(event.pointerId);
    } else {
      const { tick, value } = posFromEvent(event);
      services.store.execute(addAutomationPoint(services.store.doc, laneId, tick, value));
    }
  };

  const onCanvasPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { tick, value } = posFromEvent(event);
    const clampedValue = clamp(value, range.min, range.max);
    drag.tick = tick;
    drag.value = clampedValue;
    setLivePos({ index: drag.index, tick, value: clampedValue });
  };

  const onCanvasPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const start = points[drag.index];
    // Only commit if the user actually moved the point.
    if (start && (start.tick !== drag.tick || start.value !== drag.value)) {
      services.store.execute(
        moveAutomationPoint(services.store.doc, laneId, drag.index, { tick: drag.tick, value: drag.value }),
      );
    }
    setLivePos(null);
  };

  const renderPoints = livePos
    ? points.map((p, i) => (i === livePos.index ? { tick: livePos.tick, value: livePos.value } : p))
    : points;

  return (
    <div
      className="auto-canvas"
      ref={canvasRef}
      onPointerDown={onCanvasPointerDown}
      onPointerMove={onCanvasPointerMove}
      onPointerUp={onCanvasPointerUp}
      onContextMenu={(event) => {
        event.preventDefault();
        const index = findPoint(event);
        if (index >= 0) services.store.execute(deleteAutomationPoint(services.store.doc, laneId, index));
      }}
      title="Click to add point · drag point to move · right-click point to delete"
    >
      <svg className="auto-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        {[25, 50, 75].map((y) => (
          <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="#262a32" strokeWidth="0.4" />
        ))}
        {Array.from({ length: Math.floor(patternTicks / STEP_TICKS / 4) + 1 }, (_, i) => (
          <line
            key={i}
            x1={(i * 4 * STEP_TICKS * 100) / patternTicks}
            y1="0"
            x2={(i * 4 * STEP_TICKS * 100) / patternTicks}
            y2="100"
            stroke="#2c313c"
            strokeWidth="0.4"
          />
        ))}
        {renderPoints.length > 0 && (
          <polyline
            fill="none"
            stroke="var(--accent)"
            strokeWidth="0.8"
            points={renderPoints
              .map((p) => {
                const x = (p.tick / patternTicks) * 100;
                const y = 100 - ((p.value - range.min) / (range.max - range.min)) * 100;
                return `${x},${y}`;
              })
              .join(" ")}
          />
        )}
      </svg>
      {renderPoints.map((p, i) => {
        const x = (p.tick / patternTicks) * 100;
        const y = 100 - ((p.value - range.min) / (range.max - range.min)) * 100;
        return (
          <div
            key={i}
            className="auto-point"
            style={{ left: `${x}%`, top: `${y}%` }}
            title={`${p.tick} ticks — ${range.format ? range.format(p.value) : p.value.toFixed(2)}`}
          />
        );
      })}
    </div>
  );
}

function MacroCard({ macro }: { macro: ReturnType<typeof useDoc>["macros"][number] }) {
  const services = useServices();
  const doc = useDoc();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [mapDraft, setMapDraft] = useState<{ trackId: string; param: "gain" | "pan" }>({
    trackId: doc.tracks[0]?.id ?? "",
    param: "gain",
  });

  return (
    <div className="macro-card">
      {editing ? (
        <input
          className="macro-name-input"
          value={draft}
          autoFocus
          aria-label="Macro name"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft.trim() !== "") services.store.execute(renameMacro(services.store.doc, macro.id, draft.trim()));
            setEditing(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      ) : (
        <button
          type="button"
          className="macro-name"
          title="Double-click or F2 to rename"
          onDoubleClick={() => {
            setEditing(true);
            setDraft(macro.name);
          }}
          onKeyDown={(event) => {
            if (event.key === "F2") {
              event.preventDefault();
              setEditing(true);
              setDraft(macro.name);
            }
          }}
        >
          {macro.name}
        </button>
      )}
      <Slider
        compact
        label="VALUE"
        value={macro.value}
        min={0}
        max={1}
        defaultValue={0.5}
        format={(v) => `${Math.round((v * 2 - 1) * 100)}`}
        onCommit={(value) => services.store.execute(setMacroValue(services.store.doc, macro.id, value))}
      />
      <div className="macro-mappings">
        {macro.mappings.map((mapping) => {
          const track = doc.tracks.find((t) => t.id === mapping.trackId);
          return (
            <div key={mapping.id} className="macro-mapping">
              <span className="macro-mapping-label">
                {trackBadgeSafe(track)} {track?.name ?? "?"} · {mapping.param === "gain" ? "VOL" : "PAN"}
              </span>
              <Slider
                compact
                label="AMOUNT"
                value={mapping.amount}
                min={-1}
                max={1}
                defaultValue={0.5}
                format={(v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}`}
                onCommit={(amount) =>
                  services.store.execute(setMacroMappingAmount(services.store.doc, macro.id, mapping.id, amount))
                }
              />
              <button
                type="button"
                className="btn btn-small btn-danger"
                title="Remove mapping"
                onClick={() => services.store.execute(removeMacroMapping(services.store.doc, macro.id, mapping.id))}
              >
                ×
              </button>
            </div>
          );
        })}
        <div className="macro-map-add">
          <select
            aria-label="Map macro to track"
            value={mapDraft.trackId}
            onChange={(event) => setMapDraft((prev) => ({ ...prev, trackId: event.target.value }))}
          >
            {doc.tracks.map((track) => (
              <option key={track.id} value={track.id}>
                {trackBadge(track)} {track.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Macro parameter"
            value={mapDraft.param}
            onChange={(event) => setMapDraft((prev) => ({ ...prev, param: event.target.value as "gain" | "pan" }))}
          >
            <option value="gain">VOL</option>
            <option value="pan">PAN</option>
          </select>
          <button
            type="button"
            className="btn btn-small"
            onClick={() =>
              services.store.execute(addMacroMapping(services.store.doc, macro.id, mapDraft.trackId, mapDraft.param))
            }
          >
            + MAP
          </button>
        </div>
      </div>
    </div>
  );
}

function ScenePanel() {
  const services = useServices();
  const doc = useDoc();
  const [selectedSceneId, setSelectedSceneId] = useState(doc.scenes[0]?.id ?? null);
  const scene = doc.scenes.find((s) => s.id === selectedSceneId) ?? null;

  // Scene automation lanes for the selected scene
  const sceneLanes = scene ? doc.sceneAutomation.filter((l) => l.sceneId === scene.id) : [];
  const [selectedSceneLaneId, setSelectedSceneLaneId] = useState<string | null>(sceneLanes[0]?.id ?? null);
  const selectedLane = sceneLanes.find((l) => l.id === selectedSceneLaneId) ?? null;

  // Scene intensity curve: max range is the scene's pattern length in ticks
  const scenePattern = scene ? doc.patterns.find((p) => p.id === scene.patternId) : null;
  const maxSceneTicks = scenePattern ? scenePattern.stepCount * STEP_TICKS : 2 * 1920;
  const sceneRange = { min: 0, max: 1, format: (v: number) => v.toFixed(2) };

  return (
    <div className="scene-panel">
      <h2 className="panel-title">SCENES</h2>
      {doc.scenes.length === 0 && <div className="fx-empty">No scenes yet.</div>}

      <div className="mod-lane-add">
        <select
          aria-label="Select scene"
          value={selectedSceneId ?? ""}
          onChange={(event) => {
            setSelectedSceneId(event.target.value);
            setSelectedSceneLaneId(null);
          }}
        >
          <option value="">— select scene —</option>
          {doc.scenes.map((s) => {
            const pattern = doc.patterns.find((p) => p.id === s.patternId);
            return (
              <option key={s.id} value={s.id}>
                {s.name} → {pattern?.name ?? "?"} ({(s.intensity * 100).toFixed(0)}%)
              </option>
            );
          })}
        </select>
      </div>

      {scene && (
        <>
          {/* Intensity slider */}
          <Slider
            compact
            label="INTENSITY"
            value={scene.intensity}
            min={0}
            max={1}
            defaultValue={0.7}
            format={(v) => `${(v * 100).toFixed(0)}%`}
            onCommit={(intensity) => services.store.execute(setSceneIntensity(services.store.doc, scene.id, intensity))}
          />

          {/* Intensity curve editor */}
          <div className="mod-section">
            <h3 className="panel-title" style={{ fontSize: "9px", marginBottom: "6px" }}>
              INTENSITY CURVE
            </h3>
            <div style={{ fontSize: "10px", color: "var(--text-faint)", marginBottom: "4px" }}>
              Click to add a point · drag to move · right-click to delete
            </div>
            <IntensityEditor
              sceneId={scene.id}
              curve={scene.intensityCurve ?? []}
              maxTicks={maxSceneTicks}
              range={sceneRange}
            />
          </div>

          {/* Scene automation lanes */}
          <div className="mod-section">
            <h3 className="panel-title" style={{ fontSize: "9px", marginBottom: "6px" }}>
              SCENE AUTOMATION
            </h3>
            <div className="mod-lane-add">
              <button
                type="button"
                className="btn btn-small"
                title="Add automation lane to this scene"
                onClick={() => {
                  if (!selectedSceneId) return;
                  try {
                    services.store.execute(
                      addSceneAutomation(services.store.doc, selectedSceneId, {
                        kind: "trackGain",
                        trackId: doc.tracks[0]?.id ?? "",
                      }),
                    );
                    const updated = services.store.doc.sceneAutomation.filter((l) => l.sceneId === selectedSceneId);
                    if (updated.length > 0) setSelectedSceneLaneId(updated[updated.length - 1].id);
                  } catch {
                    // duplicate lane
                  }
                }}
              >
                + LANE
              </button>
            </div>

            <div className="mod-lane-list">
              {sceneLanes.length === 0 && <div className="fx-empty">No scene automation yet.</div>}
              {sceneLanes.map((lane) => {
                const track = doc.tracks.find((t) => t.id === lane.target.trackId);
                return (
                  <div key={lane.id} className={`mod-lane-row${lane.id === selectedSceneLaneId ? " selected" : ""}`}>
                    <button type="button" className="mod-lane-label" onClick={() => setSelectedSceneLaneId(lane.id)}>
                      {trackBadgeSafe(track)} {track?.name ?? "?"} · {lane.target.kind} · {lane.points.length} pts
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      title="Remove lane"
                      onClick={() => {
                        services.store.execute(removeSceneAutomation(services.store.doc, lane.id));
                        if (selectedSceneLaneId === lane.id) setSelectedSceneLaneId(null);
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>

            {selectedLane && (
              <ScenePointEditor
                laneId={selectedLane.id}
                points={selectedLane.points}
                maxTicks={maxSceneTicks}
                range={sceneRange}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Scene-local intensity curve editor (points are ticks relative to the scene start, values 0..1). */
function IntensityEditor({
  sceneId,
  curve,
  maxTicks,
  range,
}: {
  sceneId: string;
  curve: { offset: number; value: number }[];
  maxTicks: number;
  range: ParamRange;
}) {
  const services = useServices();
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ index: number; offset: number; value: number } | null>(null);
  const [livePos, setLivePos] = useState<{ index: number; offset: number; value: number } | null>(null);

  const posFromEvent = (event: React.PointerEvent): { offset: number; value: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { offset: 0, value: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    return {
      offset: Math.round(((x / rect.width) * maxTicks) / STEP_TICKS) * STEP_TICKS,
      value: range.max - (y / rect.height) * (range.max - range.min),
    };
  };

  const findPoint = (event: { clientX: number; clientY: number }): number => {
    const canvas = canvasRef.current;
    if (!canvas) return -1;
    const rect = canvas.getBoundingClientRect();
    const tPx = (t: number) => (t / maxTicks) * rect.width;
    const vPy = (v: number) => rect.height - ((v - range.min) / (range.max - range.min)) * rect.height;
    for (let i = 0; i < curve.length; i++) {
      const dx = Math.abs(tPx(curve[i].offset) - (event.clientX - rect.left));
      const dy = Math.abs(vPy(curve[i].value) - (event.clientY - rect.top));
      if (dx < 8 && dy < 8) return i;
    }
    return -1;
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    if (event.target !== canvasRef.current) return;
    const index = findPoint(event);
    if (index >= 0) {
      dragRef.current = { index, offset: curve[index].offset, value: curve[index].value };
      setLivePos({ index, offset: curve[index].offset, value: curve[index].value });
      event.currentTarget.setPointerCapture(event.pointerId);
    } else {
      const { offset, value } = posFromEvent(event);
      const newPoint = { offset, value: clamp(value, range.min, range.max) };
      services.store.execute(setSceneIntensityCurve(services.store.doc, sceneId, [...curve, newPoint] as any));
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { offset, value } = posFromEvent(event);
    const clamped = clamp(value, range.min, range.max);
    drag.offset = offset;
    drag.value = clamped;
    setLivePos({ index: drag.index, offset, value: clamped });
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const start = curve[drag.index];
    if (start && (start.offset !== drag.offset || start.value !== drag.value)) {
      const updated = [...curve];
      updated[drag.index] = { offset: drag.offset, value: drag.value } as any;
      services.store.execute(setSceneIntensityCurve(services.store.doc, sceneId, updated));
    }
    setLivePos(null);
  };

  const renderPoints = livePos
    ? curve.map((p, i) => (i === livePos.index ? { offset: livePos.offset, value: livePos.value } : p))
    : curve;

  return (
    <div
      className="auto-canvas"
      ref={canvasRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(event) => {
        event.preventDefault();
        const index = findPoint(event);
        if (index >= 0) {
          const updated = curve.filter((_, i) => i !== index);
          services.store.execute(setSceneIntensityCurve(services.store.doc, sceneId, updated));
        }
      }}
      title="Click to add point · drag to move · right-click to delete"
    >
      <svg className="auto-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        {[25, 50, 75].map((y) => (
          <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="#262a32" strokeWidth="0.4" />
        ))}
        {renderPoints.length > 0 && (
          <polyline
            fill="none"
            stroke="var(--accent)"
            strokeWidth="0.8"
            points={renderPoints
              .map((p) => {
                const x = (p.offset / maxTicks) * 100;
                const y = 100 - ((p.value - range.min) / (range.max - range.min)) * 100;
                return `${x},${y}`;
              })
              .join(" ")}
          />
        )}
      </svg>
      {renderPoints.map((p, i) => {
        const x = (p.offset / maxTicks) * 100;
        const y = 100 - ((p.value - range.min) / (range.max - range.min)) * 100;
        return (
          <div
            key={i}
            className="auto-point"
            style={{ left: `${x}%`, top: `${y}%` }}
            title={`${p.offset} ticks — ${p.value.toFixed(2)}`}
          />
        );
      })}
    </div>
  );
}

/** Scene-local automation point editor (same shape as the pattern automation PointEditor). */
function ScenePointEditor({
  laneId,
  points,
  maxTicks,
  range,
}: {
  laneId: string;
  points: { tick: number; value: number }[];
  maxTicks: number;
  range: ParamRange;
}) {
  const services = useServices();
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ index: number; tick: number; value: number } | null>(null);
  const [livePos, setLivePos] = useState<{ index: number; tick: number; value: number } | null>(null);

  const posFromEvent = (event: React.PointerEvent): { tick: number; value: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { tick: 0, value: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    return {
      tick: Math.round(((x / rect.width) * maxTicks) / STEP_TICKS) * STEP_TICKS,
      value: range.max - (y / rect.height) * (range.max - range.min),
    };
  };

  const findPoint = (event: { clientX: number; clientY: number }): number => {
    const canvas = canvasRef.current;
    if (!canvas) return -1;
    const rect = canvas.getBoundingClientRect();
    const tPx = (t: number) => (t / maxTicks) * rect.width;
    const vPy = (v: number) => rect.height - ((v - range.min) / (range.max - range.min)) * rect.height;
    for (let i = 0; i < points.length; i++) {
      const dx = Math.abs(tPx(points[i].tick) - (event.clientX - rect.left));
      const dy = Math.abs(vPy(points[i].value) - (event.clientY - rect.top));
      if (dx < 8 && dy < 8) return i;
    }
    return -1;
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    if (event.target !== canvasRef.current) return;
    const index = findPoint(event);
    if (index >= 0) {
      dragRef.current = { index, tick: points[index].tick, value: points[index].value };
      setLivePos({ index, tick: points[index].tick, value: points[index].value });
      event.currentTarget.setPointerCapture(event.pointerId);
    } else {
      const { tick, value } = posFromEvent(event);
      services.store.execute(
        addSceneAutomationPoint(services.store.doc, laneId, tick, clamp(value, range.min, range.max)),
      );
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { tick, value } = posFromEvent(event);
    const clamped = clamp(value, range.min, range.max);
    drag.tick = tick;
    drag.value = clamped;
    setLivePos({ index: drag.index, tick, value: clamped });
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const start = points[drag.index];
    if (start && (start.tick !== drag.tick || start.value !== drag.value)) {
      services.store.execute(
        moveSceneAutomationPoint(services.store.doc, laneId, drag.index, { tick: drag.tick, value: drag.value }),
      );
    }
    setLivePos(null);
  };

  const renderPoints = livePos
    ? points.map((p, i) => (i === livePos.index ? { tick: livePos.tick, value: livePos.value } : p))
    : points;

  return (
    <div
      className="auto-canvas"
      ref={canvasRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(event) => {
        event.preventDefault();
        const index = findPoint(event);
        if (index >= 0) services.store.execute(removeSceneAutomationPoint(services.store.doc, laneId, index));
      }}
      title="Click to add point · drag to move · right-click to delete"
    >
      <svg className="auto-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        {[25, 50, 75].map((y) => (
          <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="#262a32" strokeWidth="0.4" />
        ))}
        {renderPoints.length > 0 && (
          <polyline
            fill="none"
            stroke="var(--accent)"
            strokeWidth="0.8"
            points={renderPoints
              .map((p) => {
                const x = (p.tick / maxTicks) * 100;
                const y = 100 - ((p.value - range.min) / (range.max - range.min)) * 100;
                return `${x},${y}`;
              })
              .join(" ")}
          />
        )}
      </svg>
      {renderPoints.map((p, i) => {
        const x = (p.tick / maxTicks) * 100;
        const y = 100 - ((p.value - range.min) / (range.max - range.min)) * 100;
        return (
          <div
            key={i}
            className="auto-point"
            style={{ left: `${x}%`, top: `${y}%` }}
            title={`${p.tick} ticks — ${p.value.toFixed(2)}`}
          />
        );
      })}
    </div>
  );
}
