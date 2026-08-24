import { useEffect, useState } from "react";
import { useDoc, useServices } from "./context";
import {
  addMidiCcMapping,
  applyMidiCreativeTool,
  removeMidiCcMapping,
  resetDrumNoteMapping,
  setDrumNoteMapping,
  setMidiConfig,
} from "../commands/commands";
import type { AutomationTarget, MidiCcMapping } from "../project-model/types";
import { GM_DRUM_MAP } from "../project-model/types";
import type { SelectedNote } from "./PianoRoll";
import { CHORD_QUALITIES } from "../midi/creative";
import type { ChordQuality, ChordVoicing, MidiCreativeOperation, StrumDirection } from "../midi/creative";
import { EFFECT_DEFS } from "../effects/registry";
import { INSTRUMENT_DEFS } from "../instruments/registry";
import { DragNumber } from "./controls";
import type { MidiDevice } from "../midi/MidiInput";
import { LatencyCalibrationWizard } from "./LatencyCalibrationWizard";

export function MidiPanel({
  selectedTrackId,
  selectedNote,
  scaleSnap,
  onToggleScaleSnap,
  onClearSelection,
}: {
  selectedTrackId: string;
  selectedNote: SelectedNote | null;
  scaleSnap: boolean;
  onToggleScaleSnap: () => void;
  onClearSelection: () => void;
}) {
  const services = useServices();
  const doc = useDoc();
  // Device list is subscription-driven — a snapshot taken once at render
  // time went stale on plug/unplug until the next unrelated re-render.
  const [devices, setDevices] = useState<MidiDevice[]>(() => services.midi.getDevices());
  useEffect(() => services.midi.subscribeDevices(setDevices), [services.midi]);
  const midi = doc.midi ?? { enabled: false, deviceId: "", drumChannel: 0, instrumentChannel: 0, ccMappings: [], drumNoteMap: [], pitchBendRange: 2 };

  const [addTrackId, setAddTrackId] = useState(doc.tracks[0]?.id ?? "");
  const [addTarget, setAddTarget] = useState<{ kind: string; fxId?: string; paramId?: string }>({ kind: "trackGain" });
  const [addCc, setAddCc] = useState(1);
  const [latencyOpen, setLatencyOpen] = useState(false);
  const [tab, setTab] = useState<"input" | "creativity">("input");

  const toggle = () => services.store.execute(setMidiConfig(doc, { enabled: !midi.enabled }));

  const submitAddMapping = () => {
    const target: AutomationTarget = {
      kind: addTarget.kind as AutomationTarget["kind"],
      trackId: addTrackId,
      fxId: addTarget.fxId,
      paramId: addTarget.paramId,
    };
    services.store.execute(addMidiCcMapping(doc, addCc, target, 0, 1));
  };

  return (
    <section className="midi-panel" aria-label="MIDI input configuration">
      <div className="midi-panel-header">
        <h2 className="panel-title">MIDI</h2>
        <div className="midi-tabs" role="tablist" aria-label="MIDI panel tabs">
          <button
            type="button"
            className={`btn btn-small${tab === "input" ? " active-solo" : ""}`}
            role="tab"
            aria-selected={tab === "input"}
            onClick={() => setTab("input")}
          >
            INPUT
          </button>
          <button
            type="button"
            className={`btn btn-small${tab === "creativity" ? " active-solo" : ""}`}
            role="tab"
            aria-selected={tab === "creativity"}
            onClick={() => setTab("creativity")}
          >
            CREATIVITY
          </button>
        </div>
      </div>

      {tab === "input" && (
        <>
          <div className="midi-row">
            <button
              type="button"
              className={`btn btn-small${midi.enabled ? " active-solo" : ""}`}
              onClick={toggle}
              aria-pressed={midi.enabled}
            >
              {midi.enabled ? "MIDI ON" : "MIDI OFF"}
            </button>
            <button type="button" className="btn btn-small" onClick={() => setLatencyOpen(true)}>
              CALIBRATE LATENCY
            </button>
          </div>

          {midi.enabled && (
            <>
          <div className="midi-row">
            <label className="midi-label">DEVICE</label>
            <select
              className="midi-select"
              value={midi.deviceId}
              aria-label="MIDI input device"
              onChange={(e) => services.store.execute(setMidiConfig(doc, { deviceId: e.target.value }))}
            >
              <option value="">All devices</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          <div className="midi-row">
            <label className="midi-label">DRUM CH</label>
            <select
              className="midi-select"
              value={midi.drumChannel}
              aria-label="Drum MIDI channel"
              onChange={(e) => services.store.execute(setMidiConfig(doc, { drumChannel: Number(e.target.value) }))}
            >
              <option value={0}>All</option>
              {Array.from({ length: 16 }, (_, i) => (
                <option key={i + 1} value={i + 1}>{i + 1}</option>
              ))}
            </select>
          </div>

          <div className="midi-row">
            <label className="midi-label">INST CH</label>
            <select
              className="midi-select"
              value={midi.instrumentChannel}
              aria-label="Instrument MIDI channel"
              onChange={(e) => services.store.execute(setMidiConfig(doc, { instrumentChannel: Number(e.target.value) }))}
            >
              <option value={0}>All</option>
              {Array.from({ length: 16 }, (_, i) => (
                <option key={i + 1} value={i + 1}>{i + 1}</option>
              ))}
            </select>
          </div>

          <div className="midi-row">
            <label className="midi-label">P.BEND</label>
            <DragNumber
              label="RANGE"
              value={midi.pitchBendRange}
              min={1}
              max={24}
              defaultValue={2}
              sensitivity={0.4}
              format={(v) => `${Math.round(v)} st`}
              onCommit={(v) => services.store.execute(setMidiConfig(doc, { pitchBendRange: Math.round(v) }))}
            />
          </div>

          <div className="midi-cc-section">
            <h3 className="panel-title" style={{ fontSize: "10px" }}>CC MAPPINGS</h3>
            {midi.ccMappings.length === 0 && (
              <div className="midi-empty">No CC mappings. Add one below.</div>
            )}
            {midi.ccMappings.map((m) => (
              <MidiCcRow key={m.id} mapping={m} doc={doc} />
            ))}
            <div className="midi-add-row">
              <select
                className="midi-select midi-select-small"
                value={addTrackId}
                aria-label="CC target track"
                onChange={(e) => { setAddTrackId(e.target.value); setAddTarget({ kind: "trackGain" }); }}
              >
                {doc.tracks.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <select
                className="midi-select midi-select-small"
                value={`${addTarget.kind}:${addTarget.fxId ?? ""}:${addTarget.paramId ?? ""}`}
                aria-label="CC target parameter"
                onChange={(e) => {
                  const [kind, fxId, paramId] = e.target.value.split(":");
                  setAddTarget({ kind, fxId: fxId || undefined, paramId: paramId || undefined });
                }}
              >
                <option value="trackGain::">Volume</option>
                <option value="trackPan::">Pan</option>
                {(() => {
                  const track = doc.tracks.find((t) => t.id === addTrackId);
                  if (!track) return null;
                  if (track.kind === "instrument") {
                    const def = INSTRUMENT_DEFS[track.instrument];
                    return def.params.map((p) => (
                      <option key={p.id} value={`instParam::${p.id}`}>{p.label}</option>
                    ));
                  }
                  return null;
                })()}
                {(() => {
                  const track = doc.tracks.find((t) => t.id === addTrackId);
                  if (!track || !("effects" in track)) return null;
                  return (track as any).effects.map((fx: any) => {
                    const def = EFFECT_DEFS[fx.type as keyof typeof EFFECT_DEFS];
                    if (!def) return null;
                    return def.params.map((p) => (
                      <option key={`${fx.id}-${p.id}`} value={`fxParam:${fx.id}:${p.id}`}>
                        {def.name} — {p.label}
                      </option>
                    ));
                  });
                })()}
              </select>
              <select
                className="midi-select midi-select-tiny"
                value={addCc}
                aria-label="CC number"
                onChange={(e) => setAddCc(Number(e.target.value))}
              >
                {Array.from({ length: 128 }, (_, i) => (
                  <option key={i} value={i}>{i}</option>
                ))}
              </select>
              <button type="button" className="btn btn-small" onClick={submitAddMapping}>+</button>
            </div>
          </div>

          <div className="midi-drum-section">
            <div className="midi-drum-header">
              <h3 className="panel-title" style={{ fontSize: "10px" }}>DRUM NOTE MAP</h3>
              {midi.drumNoteMap.length > 0 && (
                <button type="button" className="btn btn-small" onClick={() => services.store.execute(resetDrumNoteMapping(doc))}>
                  RESET
                </button>
              )}
            </div>
            {midi.drumNoteMap.map((m) => (
              <div key={m.midiNote} className="midi-drum-row">
                <span className="midi-drum-note">Note {m.midiNote}</span>
                <select
                  className="midi-select midi-select-small"
                  value={m.padId}
                  aria-label={`Pad for note ${m.midiNote}`}
                  onChange={(e) => services.store.execute(setDrumNoteMapping(doc, m.midiNote, e.target.value))}
                >
                  {doc.tracks.filter((t) => t.kind === "drum").flatMap((t) => t.pads.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  )))}
                </select>
                <button
                  type="button"
                  className="btn btn-small btn-danger"
                  onClick={() => {
                    const midi_ = doc.midi ?? { drumNoteMap: [] };
                    const filtered = midi_.drumNoteMap.filter((d) => d.midiNote !== m.midiNote);
                    services.store.execute(setMidiConfig(doc, { drumNoteMap: filtered }));
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="midi-add-row">
              <select
                className="midi-select midi-select-tiny"
                value=""
                aria-label="Add drum note mapping"
                onChange={(e) => {
                  const note = Number(e.target.value);
                  if (note >= 0) services.store.execute(setDrumNoteMapping(doc, note, doc.tracks.find((t) => t.kind === "drum")?.pads[0]?.id ?? ""));
                }}
              >
                <option value="">+ MAP</option>
                {GM_DRUM_MAP.filter((g) => !midi.drumNoteMap.some((d) => d.midiNote === g.note)).map((g) => (
                  <option key={g.note} value={g.note}>{g.note} — {g.name}</option>
                ))}
              </select>
            </div>
          </div>
            </>
          )}
        </>
      )}
      {tab === "creativity" && (
        <MidiCreativityPanel
          selectedTrackId={selectedTrackId}
          selectedNote={selectedNote}
          scaleSnap={scaleSnap}
          onToggleScaleSnap={onToggleScaleSnap}
          onClearSelection={onClearSelection}
        />
      )}
      <LatencyCalibrationWizard open={latencyOpen} onClose={() => setLatencyOpen(false)} />
    </section>
  );
}

function MidiCreativityPanel({
  selectedTrackId,
  selectedNote,
  scaleSnap,
  onToggleScaleSnap,
  onClearSelection,
}: {
  selectedTrackId: string;
  selectedNote: SelectedNote | null;
  scaleSnap: boolean;
  onToggleScaleSnap: () => void;
  onClearSelection: () => void;
}) {
  const services = useServices();
  const doc = useDoc();
  const [chordMode, setChordMode] = useState<"diatonic" | "explicit">("diatonic");
  const [quality, setQuality] = useState<ChordQuality>("major");
  const [voicing, setVoicing] = useState<ChordVoicing>("close");
  const [inversion, setInversion] = useState(0);
  const [seventh, setSeventh] = useState(false);
  const [gate, setGate] = useState(0.9);
  const [strumTicks, setStrumTicks] = useState(0);
  const [strumDirection, setStrumDirection] = useState<StrumDirection>("up");
  const [timingTicks, setTimingTicks] = useState(24);
  const [humanizeVelocity, setHumanizeVelocity] = useState(0.1);
  const [velocityAmount, setVelocityAmount] = useState(0.15);
  const [seed, setSeed] = useState("midi-1");
  const [error, setError] = useState<string | null>(null);

  const track = doc.tracks.find((candidate) => candidate.id === selectedTrackId);
  const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
  const trackNotes = track?.kind === "instrument" ? pattern?.notes?.[track.id] ?? [] : [];
  const selectionIsForTrack = selectedNote?.trackId === selectedTrackId && selectedNote.noteIds.length > 0;
  const targetCount = selectionIsForTrack ? selectedNote!.noteIds.length : trackNotes.length;
  const hasTarget = targetCount > 0;
  const canUseScale = !!doc.key;
  const canUseDiatonic = chordMode === "explicit" || canUseScale;

  const targetIds = selectionIsForTrack ? selectedNote!.noteIds : undefined;
  const run = (operation: MidiCreativeOperation) => {
    if (!track || track.kind !== "instrument" || !hasTarget) return;
    setError(null);
    try {
      services.store.execute(applyMidiCreativeTool(doc, { trackId: track.id, noteIds: targetIds, operation }));
      onClearSelection();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "MIDI operation failed");
    }
  };

  const scaleOptions = { scaleLock: scaleSnap, key: doc.key };

  if (!track || track.kind !== "instrument") {
    return (
      <div className="midi-creative-disabled">
        MIDI CREATIVITY works on an instrument track. Select an instrument track first.
      </div>
    );
  }

  return (
    <div className="midi-creativity" aria-label="MIDI creativity tools">
      <div className="midi-creative-status">
        <span className="midi-creative-track">{track.name}</span>
        <span>{targetCount} note{targetCount === 1 ? "" : "s"} targeted</span>
        <span>{doc.key ?? "No project key"}</span>
      </div>

      <div className="midi-row midi-creative-controls">
        <button
          type="button"
          className={`btn btn-small${scaleSnap ? " active-solo" : ""}`}
          aria-pressed={scaleSnap}
          onClick={onToggleScaleSnap}
          disabled={!canUseScale}
          title={canUseScale ? "Snap generated and edited notes to the project scale" : "Set a project key first"}
        >
          SCALE LOCK {scaleSnap ? "ON" : "OFF"}
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={!hasTarget || !canUseScale}
          onClick={() => doc.key && run({ kind: "snap-scale", key: doc.key })}
        >
          SNAP SELECTED
        </button>
      </div>

      <div className="midi-creative-grid">
        <section className="midi-tool-section">
          <h3 className="panel-title">CHORDS</h3>
          <div className="midi-row">
            <label className="midi-label">MODE</label>
            <select className="midi-select" value={chordMode} onChange={(event) => setChordMode(event.target.value as "diatonic" | "explicit")}>
              <option value="diatonic">Diatonic</option>
              <option value="explicit">Explicit</option>
            </select>
            <label className="midi-label">VOICE</label>
            <select className="midi-select" value={voicing} onChange={(event) => setVoicing(event.target.value as ChordVoicing)}>
              <option value="close">Close</option>
              <option value="open">Open</option>
              <option value="drop2">Drop 2</option>
            </select>
          </div>
          <div className="midi-row">
            <label className="midi-label">QUALITY</label>
            <select className="midi-select" value={quality} onChange={(event) => setQuality(event.target.value as ChordQuality)} disabled={chordMode === "diatonic"}>
              {CHORD_QUALITIES.map((value) => <option key={value} value={value}>{formatCreativeLabel(value)}</option>)}
            </select>
            <label className="midi-label">INV</label>
            <select className="midi-select midi-select-tiny" value={inversion} onChange={(event) => setInversion(Number(event.target.value))}>
              {[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <div className="midi-row">
            <button type="button" className={`btn btn-small${seventh ? " active-solo" : ""}`} aria-pressed={seventh} onClick={() => setSeventh((value) => !value)} disabled={chordMode === "explicit"}>
              7TH {seventh ? "ON" : "OFF"}
            </button>
            <button type="button" className="btn btn-small" disabled={!hasTarget || !canUseDiatonic} onClick={() => run({
              kind: "chord",
              options: { mode: chordMode, quality, voicing, inversion, seventh, gate, strumTicks, strumDirection, scaleLock: scaleSnap, key: doc.key },
            })}>
              APPLY CHORD
            </button>
          </div>
        </section>

        <section className="midi-tool-section">
          <h3 className="panel-title">TRANSFORM</h3>
          <div className="midi-tool-buttons">
            <button type="button" className="btn btn-small" disabled={!hasTarget} onClick={() => run({ kind: "reverse", ...scaleOptions })}>REVERSE</button>
            <button type="button" className="btn btn-small" disabled={!hasTarget} onClick={() => run({ kind: "invert", ...scaleOptions })}>INVERT</button>
            <button type="button" className="btn btn-small" disabled={!hasTarget} onClick={() => run({ kind: "halve", ...scaleOptions })}>HALVE</button>
            <button type="button" className="btn btn-small" disabled={!hasTarget} onClick={() => run({ kind: "double", ...scaleOptions })}>DOUBLE</button>
          </div>
          <div className="midi-tool-buttons">
            <button type="button" className="btn btn-small" disabled={!hasTarget} onClick={() => run({ kind: "strum", options: { spreadTicks: strumTicks, direction: strumDirection }, ...scaleOptions })}>APPLY STRUM</button>
            <button type="button" className="btn btn-small" disabled={!hasTarget} onClick={() => run({ kind: "gate", gate, ...scaleOptions })}>APPLY GATE</button>
          </div>
        </section>

        <section className="midi-tool-section">
          <h3 className="panel-title">PERFORMANCE</h3>
          <div className="midi-row midi-number-row">
            <DragNumber label="GATE" value={gate} min={0.01} max={1} defaultValue={0.9} sensitivity={0.005} format={(value) => `${Math.round(value * 100)}%`} onCommit={setGate} />
            <DragNumber label="STRUM" value={strumTicks} min={0} max={240} defaultValue={0} sensitivity={1} format={(value) => `${Math.round(value)} tk`} onCommit={(value) => setStrumTicks(Math.round(value))} />
          </div>
          <div className="midi-row midi-number-row">
            <DragNumber label="TIMING" value={timingTicks} min={0} max={120} defaultValue={24} sensitivity={0.5} format={(value) => `±${Math.round(value)} tk`} onCommit={(value) => setTimingTicks(Math.round(value))} />
            <DragNumber label="HUM·V" value={humanizeVelocity} min={0} max={0.5} defaultValue={0.1} sensitivity={0.005} format={(value) => `±${value.toFixed(2)}`} onCommit={setHumanizeVelocity} />
          </div>
          <div className="midi-row midi-number-row">
            <DragNumber label="VEL·RND" value={velocityAmount} min={0} max={0.5} defaultValue={0.15} sensitivity={0.005} format={(value) => `±${value.toFixed(2)}`} onCommit={setVelocityAmount} />
            <select className="midi-select" value={strumDirection} onChange={(event) => setStrumDirection(event.target.value as StrumDirection)} aria-label="Strum direction">
              <option value="up">Strum up</option>
              <option value="down">Strum down</option>
            </select>
          </div>
          <div className="midi-row">
            <label className="midi-label" htmlFor="midi-seed">SEED</label>
            <input id="midi-seed" className="midi-seed" value={seed} onChange={(event) => setSeed(event.target.value)} />
            <button type="button" className="btn btn-small" onClick={() => setSeed((value) => `${value}-r`)}>REROLL</button>
          </div>
          <div className="midi-tool-buttons">
            <button type="button" className="btn btn-small" disabled={!hasTarget} onClick={() => run({ kind: "humanize", options: { timingTicks, velocityAmount: humanizeVelocity, seed }, ...scaleOptions })}>APPLY HUMANIZE</button>
            <button type="button" className="btn btn-small" disabled={!hasTarget} onClick={() => run({ kind: "velocity-randomize", options: { amount: velocityAmount, seed }, ...scaleOptions })}>APPLY VELOCITY</button>
          </div>
        </section>
      </div>
      {!hasTarget && <div className="midi-empty">Draw or select at least one note in the piano roll.</div>}
      {!canUseScale && <div className="midi-empty">Set a project key in the top bar to use scale lock or diatonic chords.</div>}
      {error && <div className="midi-error">{error}</div>}
    </div>
  );
}

function formatCreativeLabel(value: string): string {
  return value.replace(/(^|[-_])([a-z])/g, (_, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`).replace(/[-_]/g, " ");
}

function MidiCcRow({ mapping, doc }: { mapping: MidiCcMapping; doc: import("../project-model/types").ProjectDocument }) {
  const services = useServices();
  const targetLabel = (() => {
    switch (mapping.target.kind) {
      case "trackGain": return `${doc.tracks.find((t) => t.id === mapping.target.trackId)?.name ?? "?"} → Volume`;
      case "trackPan": return `${doc.tracks.find((t) => t.id === mapping.target.trackId)?.name ?? "?"} → Pan`;
      case "fxParam": {
        const track = doc.tracks.find((t) => t.id === mapping.target.trackId);
        const fx = track && "effects" in track ? (track as any).effects.find((f: any) => f.id === mapping.target.fxId) : null;
        const def = fx ? EFFECT_DEFS[fx.type as keyof typeof EFFECT_DEFS] : null;
        const param = def?.params.find((p) => p.id === mapping.target.paramId);
        return `${track?.name ?? "?"} → ${def?.name ?? "?"} ${param?.label ?? ""}`;
      }
      case "instParam": {
        const track = doc.tracks.find((t) => t.id === mapping.target.trackId);
        const def = track?.kind === "instrument" ? INSTRUMENT_DEFS[track.instrument] : null;
        const param = def?.params.find((p) => p.id === mapping.target.paramId);
        return `${track?.name ?? "?"} → ${param?.label ?? ""}`;
      }
    }
  })();

  return (
    <div className="midi-cc-row">
      <span className="midi-cc-num">CC{mapping.ccNumber}</span>
      <span className="midi-cc-target">{targetLabel}</span>
      <button type="button" className="btn btn-small btn-danger" onClick={() => services.store.execute(removeMidiCcMapping(doc, mapping.id))}>
        ×
      </button>
    </div>
  );
}
