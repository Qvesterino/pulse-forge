import { useMemo, useRef, useState } from "react";
import { useDoc, useServices, useTracks } from "./context";
import { Slider } from "./controls";
import { kopaParams } from "../instruments/definitions";
import { lowEndPlan } from "../instruments/lowEnd";
import { forgeKickCommand, forgeLowEndStackCommand, setInstrumentParam } from "../commands/commands";
import { forgeKick, type KickForgePlan } from "../kopa/forge";
import { importAudioFile } from "./sample-import";
import type { InstrumentTrack } from "../project-model/types";

/**
 * KOPA PANEL (ADR 0035 follow-up / the Forge wave) — the kick-designer
 * surface. The heart is the REFERENCE drop: a kick you like lands in the
 * user library, the KOPA Forge measures its pitch envelope, decay and
 * layers, and the fitted patch applies as ONE undoable command. The
 * estimate is a measured suggestion (the Forge honesty rule: warnings are
 * loud, nothing is silently patched).
 *
 * Every slider commits a command; ▶ previews through the existing preset
 * audition machinery.
 */

const PITCH = kopaParams.filter((param) => param.id.startsWith("pitch"));
const CLICK = kopaParams.filter((param) => param.id.startsWith("click"));
const BODY = kopaParams.filter((param) => ["bodyDecay", "bodyHollow", "bodyWave", "keyTrack"].includes(param.id));
const TAIL = kopaParams.filter((param) => param.id.startsWith("tail") || param.id === "subLevel");
const OUT = kopaParams.filter((param) => ["drive", "harmonicLevel", "level"].includes(param.id));

function Row({
  param,
  track,
  onParam,
}: {
  param: (typeof kopaParams)[number];
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

/**
 * The LOW-END STACK card — the system-level builder. It is rendered even
 * when the project has NO KOPA track (that is the point: one apply creates
 * the kick, the bass and the wiring), and re-plans from the live doc on
 * every render so an already-wired stack shows RE-TUNE instead of BUILD.
 */
function LowEndStackCard() {
  const services = useServices();
  const doc = useDoc();
  const plan = useMemo(() => lowEndPlan(doc), [doc]);
  const [status, setStatus] = useState<string | null>(null);

  const build = () => {
    const d = services.store.doc;
    const p = lowEndPlan(d);
    services.store.execute(forgeLowEndStackCommand(d, { keyRootPc: p.keyRootPc }));
    setStatus(
      p.keyKnown
        ? `Stack built — kick tuned to the tonic (${p.kickTuneSt} st), 808 + sidechain wired`
        : "Stack built — no key set, chromatic C anchor (set the project key to tune to the tonic)",
    );
  };

  return (
    <section className="tsar-section" aria-label="Low-end stack">
      <h3 className="tsar-section-title">LOW-END STACK</h3>
      <div className="tsar-forge-hint">
        {plan.sidechainWired
          ? "Wired: KOPA kick + 808 bass (KOREŇ) ducking under every kick."
          : "Binds KOPA + an 808 bass (KOREŇ) + sidechain ducking into one undoable step."}
      </div>
      <div className="tsar-forge-hint">
        {plan.keyKnown
          ? `Key tonic → kick ${plan.kickTuneSt} st from the C anchor.`
          : "No key set — the build anchors chromatic (C)."}
      </div>
      <div className="tsar-forge-controls">
        <button type="button" className="btn btn-small" onClick={build}>
          {plan.sidechainWired ? "RE-TUNE TO KEY" : "BUILD THE STACK"}
        </button>
      </div>
      {status && <div className="tsar-forge-status">{status}</div>}
    </section>
  );
}

export function KopaPanel() {
  const services = useServices();
  const tracks = useTracks();
  const kopaTracks = useMemo(
    () => tracks.filter((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "kopa"),
    [tracks],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const track = kopaTracks.find((candidate) => candidate.id === selectedId) ?? kopaTracks[0];
  const [status, setStatus] = useState<string | null>(null);
  const [plan, setPlan] = useState<KickForgePlan | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!track) {
    return (
      <div className="tsar-panel" role="region" aria-label="KOPA engine">
        <div className="fx-empty">
          No KOPA track in this project — build the low-end stack below, or add an instrument track and pick KOPA.
        </div>
        <div className="tsar-columns">
          <LowEndStackCard />
        </div>
      </div>
    );
  }

  const onParam = (paramId: string, value: number) => {
    services.store.execute(setInstrumentParam(services.store.doc, track.id, paramId, value));
  };

  const preview = () => {
    services.engine.previewInstrumentWithParams(track.id, 36, {});
  };

  const forgeFromReference = async (file: File) => {
    setStatus(`Reading ${file.name}…`);
    try {
      const asset = await importAudioFile(services, file);
      const buffer = services.bank.get(asset.id);
      if (!buffer) {
        setStatus("Import failed — the reference could not be decoded");
        return;
      }
      const result = forgeKick(buffer.getChannelData(0), buffer.sampleRate);
      if (result.kind === "empty") {
        setStatus(`Nothing to forge: ${result.warnings.join("; ")}`);
        return;
      }
      setPlan(result);
      setStatus(`Measured: ${result.summary}${result.warnings.length > 0 ? ` — ${result.warnings.join("; ")}` : ""}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Forge failed");
    }
  };

  const applyForge = () => {
    if (!plan) return;
    services.store.execute(forgeKickCommand(services.store.doc, track.id, plan));
    setStatus(`Fitted patch applied${plan.rootMidi !== null ? ` — tune the key with KEY TRACK/B TUNE` : ""}`);
    setPlan(null);
  };

  return (
    <div className="tsar-panel" role="region" aria-label="KOPA engine">
      <div className="tsar-header">
        <strong className="tsar-title">KOPA</strong>
        {kopaTracks.length > 1 && (
          <select
            className="tsar-track-select"
            aria-label="KOPA track"
            value={track.id}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {kopaTracks.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        )}
        <span className="tsar-header-hint">Kick designer — drop a reference kick, play the fitted patch</span>
      </div>

      <div className="tsar-columns">
        <LowEndStackCard />
        <section
          className="tsar-section"
          aria-label="Kick Forge"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files?.[0];
            if (file) void forgeFromReference(file);
          }}
        >
          <h3 className="tsar-section-title">KICK FORGE</h3>
          <div className="tsar-forge-controls">
            <button type="button" className="btn btn-small" onClick={() => fileInputRef.current?.click()}>
              LOAD REFERENCE…
            </button>
            <button type="button" className="btn btn-small" onClick={preview}>
              ▶ PREVIEW
            </button>
            {plan && (
              <button type="button" className="btn btn-small" onClick={applyForge}>
                APPLY FITTED PATCH
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void forgeFromReference(file);
                event.target.value = "";
              }}
            />
          </div>
          <div className="tsar-forge-hint">
            Drop a reference kick — the pitch envelope, decay and layers are measured and fitted.
          </div>
          {status && <div className="tsar-forge-status">{status}</div>}
          {plan && (
            <div className="tsar-forge-hint">
              Fitted: {plan.summary}
              {plan.rootMidi !== null ? ` · root MIDI ${plan.rootMidi}` : " · root untracked"}
            </div>
          )}
        </section>

        <section className="tsar-section" aria-label="Pitch and click">
          <h3 className="tsar-section-title">PITCH</h3>
          <div className="tsar-params">
            {PITCH.map((param) => (
              <Row key={param.id} param={param} track={track} onParam={onParam} />
            ))}
          </div>
          <h3 className="tsar-section-title">CLICK</h3>
          <div className="tsar-params">
            {CLICK.map((param) => (
              <Row key={param.id} param={param} track={track} onParam={onParam} />
            ))}
          </div>
        </section>

        <section className="tsar-section" aria-label="Body, tail and output">
          <h3 className="tsar-section-title">BODY</h3>
          <div className="tsar-params">
            {BODY.map((param) => (
              <Row key={param.id} param={param} track={track} onParam={onParam} />
            ))}
          </div>
          <h3 className="tsar-section-title">TAIL + SUB</h3>
          <div className="tsar-params">
            {TAIL.map((param) => (
              <Row key={param.id} param={param} track={track} onParam={onParam} />
            ))}
          </div>
          <h3 className="tsar-section-title">OUTPUT</h3>
          <div className="tsar-params">
            {OUT.map((param) => (
              <Row key={param.id} param={param} track={track} onParam={onParam} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
