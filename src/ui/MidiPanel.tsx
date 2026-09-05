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
import type {
  ArpeggiatorMode,
  ChordQuality,
  ChordVoicing,
  MidiCreativeOperation,
  StrumDirection,
} from "../midi/creative";
import {
  effectTargetParamDefs,
  instrumentTargetParamDefs,
  targetOwner,
  targetParamDef,
} from "../project-model/targets";
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
  const midi = doc.midi ?? {
    enabled: false,
    deviceId: "",
    drumChannel: 0,
    instrumentChannel: 0,
    ccMappings: [],
    drumNoteMap: [],
    pitchBendRange: 2,
  };

  const [addTrackId, setAddTrackId] = useState(doc.tracks[0]?.id ?? "");
  const [addTarget, setAddTarget] = useState<{ kind: string; fxId?: string; paramId?: string }>({ kind: "trackGain" });
  const [addCc, setAddCc] = useState(1);
  const [latencyOpen, setLatencyOpen] = useState(false);
  const [tab, setTab] = useState<"input" | "creativity">("input");
  const midiTargetTracks = [...doc.tracks, ...doc.returns];
  const activeAddTrackId = targetOwner(doc, addTrackId)?.id ?? midiTargetTracks[0]?.id ?? "";

  const toggle = () => services.store.execute(setMidiConfig(doc, { enabled: !midi.enabled }));

  const submitAddMapping = () => {
    const target: AutomationTarget = {
      kind: addTarget.kind as AutomationTarget["kind"],
      trackId: activeAddTrackId,
      fxId: addTarget.fxId,
      paramId: addTarget.paramId,
    };
    const def = targetParamDef(doc, target);
    if (!def) return;
    // Start each mapping at the complete legal parameter range. A universal
    // 0..1 default makes MIDI frequency/dB targets appear connected while
    // only reaching a tiny, often inaudible slice of their actual control.
    services.store.execute(addMidiCcMapping(doc, addCc, target, def.min, def.max));
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
                    <option key={i + 1} value={i + 1}>
                      {i + 1}
                    </option>
                  ))}
                </select>
              </div>

              <div className="midi-row">
                <label className="midi-label">INST CH</label>
                <select
                  className="midi-select"
                  value={midi.instrumentChannel}
                  aria-label="Instrument MIDI channel"
                  onChange={(e) =>
                    services.store.execute(setMidiConfig(doc, { instrumentChannel: Number(e.target.value) }))
                  }
                >
                  <option value={0}>All</option>
                  {Array.from({ length: 16 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {i + 1}
                    </option>
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
                <h3 className="panel-title" style={{ fontSize: "10px" }}>
                  CC MAPPINGS
                </h3>
                {midi.ccMappings.length === 0 && <div className="midi-empty">No CC mappings. Add one below.</div>}
                {midi.ccMappings.map((m) => (
                  <MidiCcRow key={m.id} mapping={m} doc={doc} />
                ))}
                <div className="midi-add-row">
                  <select
                    className="midi-select midi-select-small"
                    value={activeAddTrackId}
                    aria-label="CC target track"
                    onChange={(e) => {
                      setAddTrackId(e.target.value);
                      setAddTarget({ kind: "trackGain" });
                    }}
                  >
                    {midiTargetTracks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
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
                    {midiTargetOptions(doc, activeAddTrackId).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="midi-select midi-select-tiny"
                    value={addCc}
                    aria-label="CC number"
                    onChange={(e) => setAddCc(Number(e.target.value))}
                  >
                    {Array.from({ length: 128 }, (_, i) => (
                      <option key={i} value={i}>
                        {i}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={submitAddMapping}
                    aria-label="Add MIDI mapping"
                    title="Add mapping"
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="midi-drum-section">
                <div className="midi-drum-header">
                  <h3 className="panel-title" style={{ fontSize: "10px" }}>
                    DRUM NOTE MAP
                  </h3>
                  {midi.drumNoteMap.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => services.store.execute(resetDrumNoteMapping(doc))}
                    >
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
                      {doc.tracks
                        .filter((t) => t.kind === "drum")
                        .flatMap((t) =>
                          t.pads.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          )),
                        )}
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
                      if (note >= 0)
                        services.store.execute(
                          setDrumNoteMapping(doc, note, doc.tracks.find((t) => t.kind === "drum")?.pads[0]?.id ?? ""),
                        );
                    }}
                  >
                    <option value="">+ MAP</option>
                    {GM_DRUM_MAP.filter((g) => !midi.drumNoteMap.some((d) => d.midiNote === g.note)).map((g) => (
                      <option key={g.note} value={g.note}>
                        {g.note} — {g.name}
                      </option>
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
  const [arpMode, setArpMode] = useState<ArpeggiatorMode>("up");
  const [arpRate, setArpRate] = useState(120);
  const [arpOctaves, setArpOctaves] = useState(1);
  const [arpGate, setArpGate] = useState(0.85);
  const [repeatRate, setRepeatRate] = useState(60);
  const [repeatCount, setRepeatCount] = useState(4);
  const [repeatFalloff, setRepeatFalloff] = useState(0.12);
  const [euclideanPulses, setEuclideanPulses] = useState(3);
  const [euclideanSteps, setEuclideanSteps] = useState(8);
  const [euclideanRotation, setEuclideanRotation] = useState(0);
  const [euclideanPitch, setEuclideanPitch] = useState(36);
  const [euclideanGate, setEuclideanGate] = useState(0.8);
  const [bassOctave, setBassOctave] = useState(1);
  const [bassGate, setBassGate] = useState(0.9);
  const [error, setError] = useState<string | null>(null);

  const track = doc.tracks.find((candidate) => candidate.id === selectedTrackId);
  const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
  const trackNotes = track?.kind === "instrument" ? (pattern?.notes?.[track.id] ?? []) : [];
  const selectionIsForTrack = selectedNote?.trackId === selectedTrackId && selectedNote.noteIds.length > 0;
  const targetCount = selectionIsForTrack ? selectedNote!.noteIds.length : trackNotes.length;
  const hasTarget = targetCount > 0;
  const canUseScale = !!doc.key;
  const canUseDiatonic = chordMode === "explicit" || canUseScale;
  const sourceVelocity = selectionIsForTrack
    ? (trackNotes.find((note) => selectedNote!.noteIds.includes(note.id))?.velocity ?? trackNotes[0]?.velocity ?? 0.8)
    : (trackNotes[0]?.velocity ?? 0.8);

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
        <span>
          {targetCount} note{targetCount === 1 ? "" : "s"} targeted
        </span>
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
            <select
              className="midi-select"
              value={chordMode}
              onChange={(event) => setChordMode(event.target.value as "diatonic" | "explicit")}
            >
              <option value="diatonic">Diatonic</option>
              <option value="explicit">Explicit</option>
            </select>
            <label className="midi-label">VOICE</label>
            <select
              className="midi-select"
              value={voicing}
              onChange={(event) => setVoicing(event.target.value as ChordVoicing)}
            >
              <option value="close">Close</option>
              <option value="open">Open</option>
              <option value="drop2">Drop 2</option>
            </select>
          </div>
          <div className="midi-row">
            <label className="midi-label">QUALITY</label>
            <select
              className="midi-select"
              value={quality}
              onChange={(event) => setQuality(event.target.value as ChordQuality)}
              disabled={chordMode === "diatonic"}
            >
              {CHORD_QUALITIES.map((value) => (
                <option key={value} value={value}>
                  {formatCreativeLabel(value)}
                </option>
              ))}
            </select>
            <label className="midi-label">INV</label>
            <select
              className="midi-select midi-select-tiny"
              value={inversion}
              onChange={(event) => setInversion(Number(event.target.value))}
            >
              {[0, 1, 2, 3].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <div className="midi-row">
            <button
              type="button"
              className={`btn btn-small${seventh ? " active-solo" : ""}`}
              aria-pressed={seventh}
              onClick={() => setSeventh((value) => !value)}
              disabled={chordMode === "explicit"}
            >
              7TH {seventh ? "ON" : "OFF"}
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={!hasTarget || !canUseDiatonic}
              onClick={() =>
                run({
                  kind: "chord",
                  options: {
                    mode: chordMode,
                    quality,
                    voicing,
                    inversion,
                    seventh,
                    gate,
                    strumTicks,
                    strumDirection,
                    scaleLock: scaleSnap,
                    key: doc.key,
                  },
                })
              }
            >
              APPLY CHORD
            </button>
          </div>
        </section>

        <section className="midi-tool-section">
          <h3 className="panel-title">TRANSFORM</h3>
          <div className="midi-tool-buttons">
            <button
              type="button"
              className="btn btn-small"
              disabled={!hasTarget}
              onClick={() => run({ kind: "reverse", ...scaleOptions })}
            >
              REVERSE
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={!hasTarget}
              onClick={() => run({ kind: "invert", ...scaleOptions })}
            >
              INVERT
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={!hasTarget}
              onClick={() => run({ kind: "halve", ...scaleOptions })}
            >
              HALVE
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={!hasTarget}
              onClick={() => run({ kind: "double", ...scaleOptions })}
            >
              DOUBLE
            </button>
          </div>
          <div className="midi-tool-buttons">
            <button
              type="button"
              className="btn btn-small"
              disabled={!hasTarget}
              onClick={() =>
                run({ kind: "strum", options: { spreadTicks: strumTicks, direction: strumDirection }, ...scaleOptions })
              }
            >
              APPLY STRUM
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={!hasTarget}
              onClick={() => run({ kind: "gate", gate, ...scaleOptions })}
            >
              APPLY GATE
            </button>
          </div>
        </section>

        <section className="midi-tool-section">
          <h3 className="panel-title">PERFORMANCE</h3>
          <div className="midi-row midi-number-row">
            <DragNumber
              label="GATE"
              value={gate}
              min={0.01}
              max={1}
              defaultValue={0.9}
              sensitivity={0.005}
              format={(value) => `${Math.round(value * 100)}%`}
              onCommit={setGate}
            />
            <DragNumber
              label="STRUM"
              value={strumTicks}
              min={0}
              max={240}
              defaultValue={0}
              sensitivity={1}
              format={(value) => `${Math.round(value)} tk`}
              onCommit={(value) => setStrumTicks(Math.round(value))}
            />
          </div>
          <div className="midi-row midi-number-row">
            <DragNumber
              label="TIMING"
              value={timingTicks}
              min={0}
              max={120}
              defaultValue={24}
              sensitivity={0.5}
              format={(value) => `±${Math.round(value)} tk`}
              onCommit={(value) => setTimingTicks(Math.round(value))}
            />
            <DragNumber
              label="HUM·V"
              value={humanizeVelocity}
              min={0}
              max={0.5}
              defaultValue={0.1}
              sensitivity={0.005}
              format={(value) => `±${value.toFixed(2)}`}
              onCommit={setHumanizeVelocity}
            />
          </div>
          <div className="midi-row midi-number-row">
            <DragNumber
              label="VEL·RND"
              value={velocityAmount}
              min={0}
              max={0.5}
              defaultValue={0.15}
              sensitivity={0.005}
              format={(value) => `±${value.toFixed(2)}`}
              onCommit={setVelocityAmount}
            />
            <select
              className="midi-select"
              value={strumDirection}
              onChange={(event) => setStrumDirection(event.target.value as StrumDirection)}
              aria-label="Strum direction"
            >
              <option value="up">Strum up</option>
              <option value="down">Strum down</option>
            </select>
          </div>
          <div className="midi-row">
            <label className="midi-label" htmlFor="midi-seed">
              SEED
            </label>
            <input
              id="midi-seed"
              className="midi-seed"
              value={seed}
              onChange={(event) => setSeed(event.target.value)}
            />
            <button type="button" className="btn btn-small" onClick={() => setSeed((value) => `${value}-r`)}>
              REROLL
            </button>
          </div>
          <div className="midi-tool-buttons">
            <button
              type="button"
              className="btn btn-small"
              disabled={!hasTarget}
              onClick={() =>
                run({
                  kind: "humanize",
                  options: { timingTicks, velocityAmount: humanizeVelocity, seed },
                  ...scaleOptions,
                })
              }
            >
              APPLY HUMANIZE
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={!hasTarget}
              onClick={() =>
                run({ kind: "velocity-randomize", options: { amount: velocityAmount, seed }, ...scaleOptions })
              }
            >
              APPLY VELOCITY
            </button>
          </div>
        </section>

        <section className="midi-tool-section midi-generator-section">
          <h3 className="panel-title">GENERATORS</h3>
          <div className="midi-row midi-number-row">
            <label className="midi-label">ARP</label>
            <select
              className="midi-select"
              value={arpMode}
              aria-label="Arpeggiator mode"
              onChange={(event) => setArpMode(event.target.value as ArpeggiatorMode)}
            >
              <option value="up">Up</option>
              <option value="down">Down</option>
              <option value="up-down">Up / Down</option>
              <option value="random">Random</option>
            </select>
            <DragNumber
              label="RATE"
              value={arpRate}
              min={1}
              max={960}
              defaultValue={120}
              sensitivity={1}
              format={(value) => `${Math.round(value)} tk`}
              onCommit={(value) => setArpRate(Math.round(value))}
            />
          </div>
          <div className="midi-row midi-number-row">
            <DragNumber
              label="OCT"
              value={arpOctaves}
              min={0}
              max={4}
              defaultValue={1}
              sensitivity={0.05}
              format={(value) => `${Math.round(value)}`}
              onCommit={(value) => setArpOctaves(Math.round(value))}
            />
            <DragNumber
              label="GATE"
              value={arpGate}
              min={0.01}
              max={1}
              defaultValue={0.85}
              sensitivity={0.005}
              format={(value) => `${Math.round(value * 100)}%`}
              onCommit={setArpGate}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={!hasTarget}
              onClick={() =>
                run({
                  kind: "arpeggiate",
                  options: { mode: arpMode, rateTicks: arpRate, octaveRange: arpOctaves, gate: arpGate, seed },
                  ...scaleOptions,
                })
              }
            >
              APPLY ARP
            </button>
          </div>
          <div className="midi-row midi-number-row">
            <DragNumber
              label="REP·RATE"
              value={repeatRate}
              min={1}
              max={960}
              defaultValue={60}
              sensitivity={1}
              format={(value) => `${Math.round(value)} tk`}
              onCommit={(value) => setRepeatRate(Math.round(value))}
            />
            <DragNumber
              label="COUNT"
              value={repeatCount}
              min={1}
              max={32}
              defaultValue={4}
              sensitivity={0.1}
              format={(value) => `${Math.round(value)}`}
              onCommit={(value) => setRepeatCount(Math.round(value))}
            />
            <DragNumber
              label="FALL"
              value={repeatFalloff}
              min={0}
              max={1}
              defaultValue={0.12}
              sensitivity={0.005}
              format={(value) => `${Math.round(value * 100)}%`}
              onCommit={setRepeatFalloff}
            />
          </div>
          <button
            type="button"
            className="btn btn-small"
            disabled={!hasTarget}
            onClick={() =>
              run({
                kind: "note-repeat",
                options: { rateTicks: repeatRate, count: repeatCount, velocityFalloff: repeatFalloff },
                ...scaleOptions,
              })
            }
          >
            APPLY NOTE REPEAT
          </button>
          <div className="midi-row midi-number-row">
            <DragNumber
              label="PULSES"
              value={euclideanPulses}
              min={0}
              max={32}
              defaultValue={3}
              sensitivity={0.1}
              format={(value) => `${Math.round(value)}`}
              onCommit={(value) => setEuclideanPulses(Math.round(value))}
            />
            <DragNumber
              label="STEPS"
              value={euclideanSteps}
              min={1}
              max={32}
              defaultValue={8}
              sensitivity={0.1}
              format={(value) => `${Math.round(value)}`}
              onCommit={(value) => setEuclideanSteps(Math.round(value))}
            />
            <DragNumber
              label="ROT"
              value={euclideanRotation}
              min={-31}
              max={31}
              defaultValue={0}
              sensitivity={0.2}
              format={(value) => `${Math.round(value)}`}
              onCommit={(value) => setEuclideanRotation(Math.round(value))}
            />
          </div>
          <div className="midi-row midi-number-row">
            <DragNumber
              label="PITCH"
              value={euclideanPitch}
              min={0}
              max={127}
              defaultValue={36}
              sensitivity={0.5}
              format={(value) => `${Math.round(value)}`}
              onCommit={(value) => setEuclideanPitch(Math.round(value))}
            />
            <DragNumber
              label="GATE"
              value={euclideanGate}
              min={0.01}
              max={1}
              defaultValue={0.8}
              sensitivity={0.005}
              format={(value) => `${Math.round(value * 100)}%`}
              onCommit={setEuclideanGate}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={!hasTarget}
              onClick={() =>
                run({
                  kind: "euclidean",
                  options: {
                    pulses: euclideanPulses,
                    steps: euclideanSteps,
                    rotation: euclideanRotation,
                    pitch: euclideanPitch,
                    velocity: sourceVelocity,
                    gate: euclideanGate,
                  },
                  ...scaleOptions,
                })
              }
            >
              APPLY EUCLIDEAN
            </button>
          </div>
          <div className="midi-row midi-number-row">
            <DragNumber
              label="BASS OCT"
              value={bassOctave}
              min={-1}
              max={8}
              defaultValue={1}
              sensitivity={0.1}
              format={(value) => `${Math.round(value)}`}
              onCommit={(value) => setBassOctave(Math.round(value))}
            />
            <DragNumber
              label="GATE"
              value={bassGate}
              min={0.01}
              max={1}
              defaultValue={0.9}
              sensitivity={0.005}
              format={(value) => `${Math.round(value * 100)}%`}
              onCommit={setBassGate}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={!hasTarget}
              onClick={() =>
                run({
                  kind: "bassline",
                  options: { octave: bassOctave, gate: bassGate, scaleLock: scaleSnap, key: doc.key },
                })
              }
            >
              APPLY BASSLINE
            </button>
          </div>
        </section>
      </div>
      {!hasTarget && <div className="midi-empty">Draw or select at least one note in the piano roll.</div>}
      {!canUseScale && (
        <div className="midi-empty">Set a project key in the top bar to use scale lock or diatonic chords.</div>
      )}
      {error && <div className="midi-error">{error}</div>}
    </div>
  );
}

function formatCreativeLabel(value: string): string {
  return value
    .replace(/(^|[-_])([a-z])/g, (_, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`)
    .replace(/[-_]/g, " ");
}

function MidiCcRow({
  mapping,
  doc,
}: {
  mapping: MidiCcMapping;
  doc: import("../project-model/types").ProjectDocument;
}) {
  const services = useServices();
  const owner = targetOwner(doc, mapping.target.trackId);
  const targetDef = targetParamDef(doc, mapping.target);
  const targetLabel = (() => {
    switch (mapping.target.kind) {
      case "trackGain":
        return `${owner?.name ?? "?"} → Volume`;
      case "trackPan":
        return `${owner?.name ?? "?"} → Pan`;
      case "fxParam":
        return `${owner?.name ?? "?"} → FX · ${targetDef?.label ?? mapping.target.paramId ?? "?"}`;
      case "instParam":
        return `${owner?.name ?? "?"} → Instrument · ${targetDef?.label ?? mapping.target.paramId ?? "?"}`;
    }
  })();

  return (
    <div className="midi-cc-row">
      <span className="midi-cc-num">CC{mapping.ccNumber}</span>
      <span className="midi-cc-target">{targetLabel}</span>
      <button
        type="button"
        className="btn btn-small btn-danger"
        onClick={() => services.store.execute(removeMidiCcMapping(doc, mapping.id))}
      >
        ×
      </button>
    </div>
  );
}

/** Full MIDI target picker, kept on the same catalog as automation/macros. */
function midiTargetOptions(
  doc: import("../project-model/types").ProjectDocument,
  trackId: string,
): { value: string; label: string }[] {
  const owner = targetOwner(doc, trackId);
  const options: { value: string; label: string }[] = [{ value: "trackGain::", label: "Volume" }];
  if (owner?.kind !== "return") options.push({ value: "trackPan::", label: "Pan" });
  if (owner?.kind === "instrument") {
    for (const param of instrumentTargetParamDefs(owner)) {
      options.push({ value: `instParam::${param.id}`, label: `Instrument — ${param.label}` });
    }
  }
  for (const fx of owner?.effects ?? []) {
    for (const param of effectTargetParamDefs(fx)) {
      options.push({ value: `fxParam:${fx.id}:${param.id}`, label: `${fx.type} — ${param.label}` });
    }
  }
  return options;
}
