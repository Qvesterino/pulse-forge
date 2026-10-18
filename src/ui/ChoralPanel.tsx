import { useMemo, useRef, useState } from "react";
import { useServices, useTracks } from "./context";
import { Slider } from "./controls";
import { choralParams } from "../choral/params";
import { setInstrumentParam, setInstrumentSample } from "../commands/commands";
import { forgePlan } from "../tsar/forge";
import { importAudioFile } from "./sample-import";
import type { InstrumentPreset } from "../presets/types";
import type { InstrumentTrack } from "../project-model/types";

/**
 * CHORÁL PANEL (ADR 0054) — the drop-a-hum surface.
 *
 * The heart is the SOURCE drop: a hum or vowel lands in the user library
 * via the same import path as the Sample Forge, and the Forge's root
 * estimate pre-fills SRC ROOT (the pitch the grain replay tunes to — a
 * wrong root is an out-of-tune choir, so the suggestion is shown loudly
 * and stays editable).
 *
 * Every control commits a command; ▶ previews through the existing preset
 * audition machinery with a pseudo-preset (nothing touches the project).
 */

const SOURCE = choralParams.filter((param) => param.id === "srcRoot");
const STACK = choralParams.filter((param) => param.id.startsWith("stack"));
const GRAIN = choralParams.filter((param) => param.id.startsWith("grain"));
const SHAPE = choralParams.filter((param) => ["attack", "release", "tone", "formant", "level"].includes(param.id));

function Row({
  param,
  track,
  onParam,
}: {
  param: (typeof choralParams)[number];
  track: InstrumentTrack;
  onParam: (paramId: string, value: number) => void;
}) {
  const value = track.params[param.id] ?? param.default;
  if (param.kind === "discrete" && param.options) {
    return (
      <label className="tsar-param-select">
        <span className="slider-label">{param.label}</span>
        <select
          aria-label={param.label}
          value={value}
          onChange={(event) => onParam(param.id, Number(event.target.value))}
        >
          {param.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <Slider
      compact
      label={param.label}
      hint={`${param.label}${param.unit ? ` ${param.unit}` : ""}`}
      value={value}
      min={param.min}
      max={param.max}
      defaultValue={param.default}
      format={param.format}
      taper={param.taper}
      onCommit={(next) => onParam(param.id, next)}
    />
  );
}

export function ChoralPanel() {
  const services = useServices();
  const tracks = useTracks();
  const choralTracks = useMemo(
    () => tracks.filter((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "choral"),
    [tracks],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const track = choralTracks.find((candidate) => candidate.id === selectedId) ?? choralTracks[0];
  const [status, setStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!track) {
    return (
      <div className="tsar-panel" role="region" aria-label="CHORÁL engine">
        <div className="fx-empty">
          No CHORÁL track in this project — add an instrument track and pick CHORÁL to open the choir.
        </div>
      </div>
    );
  }

  const onParam = (paramId: string, value: number) => {
    services.store.execute(setInstrumentParam(services.store.doc, track.id, paramId, value));
  };

  const preview = () => {
    services.engine.previewInstrumentPreset(track.id, {
      id: "choral-preview",
      name: "CHORÁL preview",
      instrument: "choral",
      genre: null,
      mood: [],
      tags: [],
      params: {},
    } satisfies InstrumentPreset);
  };

  /**
   * Drop a hum: import → decode → the Forge estimates the root → install
   * the sample (ONE command) and pre-fill SRC ROOT (a second command). Two
   * undo steps, both named; the estimate is a suggestion, never a silent
   * patch (the Forge honesty rule).
   */
  const ingestSource = async (file: File) => {
    setStatus(`Reading ${file.name}…`);
    try {
      const asset = await importAudioFile(services, file);
      const buffer = services.bank.get(asset.id);
      if (!buffer) {
        setStatus("Import failed — the sample could not be decoded");
        return;
      }
      const plan = forgePlan(buffer.getChannelData(0), buffer.sampleRate);
      if (plan.kind === "empty") {
        setStatus(`Nothing to sing: ${plan.warnings.join("; ")}`);
        return;
      }
      services.store.execute(setInstrumentSample(services.store.doc, track.id, asset.id));
      if (plan.rootMidi !== null) {
        services.store.execute(setInstrumentParam(services.store.doc, track.id, "srcRoot", plan.rootMidi));
        setStatus(
          `Source installed — Forge suggests root MIDI ${plan.rootMidi}${
            plan.warnings.length > 0 ? ` (${plan.warnings.join("; ")})` : ""
          }`,
        );
      } else {
        setStatus("Source installed — the root could not be estimated; set SRC ROOT by ear");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Import failed");
    }
  };

  return (
    <div className="tsar-panel" role="region" aria-label="CHORÁL engine">
      <div className="tsar-header">
        <strong className="tsar-title">CHORÁL</strong>
        {choralTracks.length > 1 && (
          <select
            className="tsar-track-select"
            aria-label="CHORÁL track"
            value={track.id}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {choralTracks.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        )}
        <span className="tsar-header-hint">Drop a hum — the choir follows the song's harmony</span>
      </div>

      <div className="tsar-columns">
        <section
          className="tsar-section"
          aria-label="Source"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files?.[0];
            if (file) void ingestSource(file);
          }}
        >
          <h3 className="tsar-section-title">SOURCE</h3>
          <div className="tsar-forge-controls">
            <button type="button" className="btn btn-small" onClick={() => fileInputRef.current?.click()}>
              LOAD AUDIO…
            </button>
            <button type="button" className="btn btn-small" onClick={preview}>
              ▶ PREVIEW
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void ingestSource(file);
                event.target.value = "";
              }}
            />
          </div>
          <div className="tsar-forge-hint">
            Drop a WAV here — the Forge estimates the root; a sample playing a C should stay MIDI 60.
          </div>
          {status && <div className="tsar-forge-status">{status}</div>}
          <div className="tsar-params">
            {SOURCE.map((param) => (
              <Row key={param.id} param={param} track={track} onParam={onParam} />
            ))}
          </div>
        </section>

        <section className="tsar-section" aria-label="Harmony and timbre">
          <h3 className="tsar-section-title">HARMONY STACK</h3>
          <div className="tsar-params">
            {STACK.map((param) => (
              <Row key={param.id} param={param} track={track} onParam={onParam} />
            ))}
          </div>
          <h3 className="tsar-section-title">TIMBRE</h3>
          <div className="tsar-params">
            {SHAPE.map((param) => (
              <Row key={param.id} param={param} track={track} onParam={onParam} />
            ))}
          </div>
          <h3 className="tsar-section-title">GRAINS</h3>
          <div className="tsar-params">
            {GRAIN.map((param) => (
              <Row key={param.id} param={param} track={track} onParam={onParam} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
