import { useEffect, useState } from "react";
import { useDoc, useServices } from "./context";
import {
  addMidiCcMapping,
  removeMidiCcMapping,
  resetDrumNoteMapping,
  setDrumNoteMapping,
  setMidiConfig,
} from "../commands/commands";
import type { AutomationTarget, MidiCcMapping } from "../project-model/types";
import { GM_DRUM_MAP } from "../project-model/types";
import { EFFECT_DEFS } from "../effects/registry";
import { INSTRUMENT_DEFS } from "../instruments/registry";
import { DragNumber } from "./controls";
import type { MidiDevice } from "../midi/MidiInput";

export function MidiPanel() {
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
      <h2 className="panel-title">MIDI INPUT</h2>

      <div className="midi-row">
        <button
          type="button"
          className={`btn btn-small${midi.enabled ? " active-solo" : ""}`}
          onClick={toggle}
          aria-pressed={midi.enabled}
        >
          {midi.enabled ? "MIDI ON" : "MIDI OFF"}
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
    </section>
  );
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
