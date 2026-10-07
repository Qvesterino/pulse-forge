import { useMemo, useRef, useState } from "react";
import { useServices, useTracks } from "./context";
import { Slider } from "./controls";
import { tsarParams } from "../tsar/params";
import { applyInstrumentPreset, setInstrumentParam, forgeSampleCommand } from "../commands/commands";
import { forgePlan } from "../tsar/forge";
import { TSAR_FACTORY_PRESETS } from "../presets/tsar-factory";
import { importAudioFile } from "./sample-import";
import type { InstrumentPreset } from "../presets/types";
import type { InstrumentTrack } from "../project-model/types";

/**
 * TSAR PANEL (docs/TSAR-ROADMAP.md T4) — the flagship engine editor.
 *
 * The panel is a RENDERER of intent (AGENTS #1/#2): every control commits a
 * command through `services.store.execute`, nothing writes params directly.
 * Three surfaces:
 *   - SOURCES: per-slot engine/root/envelope/filter, morph + sub/noise.
 *   - MOD + LFO: the four matrix slots with a source/destination picker.
 *   - FORGE + PRESETS: drop a sample to forge a patch, browse the factory bank.
 *
 * Forge runs on the selected track's chosen slot; the plan and the drop are
 * refused honestly (no silent patch) when the source is empty.
 */

const SOURCE_A = tsarParams.filter((param) => param.id.startsWith("srcA"));
const SOURCE_B = tsarParams.filter((param) => param.id.startsWith("srcB"));
const SHARED = tsarParams.filter(
  (param) => param.id === "morph" || param.id.startsWith("sub") || param.id.startsWith("noise"),
);
const VOICE = tsarParams.filter((param) => ["glide", "velocity", "drift"].includes(param.id));
const LFO = tsarParams.filter((param) => param.id.startsWith("lfo"));
const ARP = tsarParams.filter((param) => param.id.startsWith("arp"));
const TONE = tsarParams.filter((param) => ["tone", "drive", "width", "level"].includes(param.id));

const MOD_SOURCES = ["OFF", "ENV", "LFO", "VEL", "PRESS"] as const;
const MOD_DESTS = ["OFF", "A MORPH", "A CUTOFF", "B MORPH", "B CUTOFF", "MORPH", "AMP", "PAN"] as const;

function ParamRow({
  id,
  track,
  onParam,
}: {
  id: string;
  track: InstrumentTrack;
  onParam: (paramId: string, value: number) => void;
}) {
  const def = tsarParams.find((param) => param.id === id)!;
  return (
    <Slider
      compact
      label={def.label}
      hint={`${def.label} - ${def.min}…${def.max}${def.unit ? ` ${def.unit}` : ""}`}
      value={track.params[id] ?? def.default}
      min={def.min}
      max={def.max}
      defaultValue={def.default}
      format={def.format}
      taper={def.taper}
      onCommit={(value) => onParam(id, value)}
    />
  );
}

export function TsarPanel() {
  const services = useServices();
  const tracks = useTracks();
  const tsarTracks = useMemo(
    () => tracks.filter((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "tsar"),
    [tracks],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const track = tsarTracks.find((candidate) => candidate.id === selectedId) ?? tsarTracks[0];

  const [forgeSlot, setForgeSlot] = useState<0 | 1>(0);
  const [forgeStatus, setForgeStatus] = useState<string | null>(null);
  const [presetFilter, setPresetFilter] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!track) {
    return (
      <div className="tsar-panel" role="region" aria-label="TSAR engine">
        <div className="fx-empty">
          No TSAR track in this project — add an instrument track and pick TSAR to open the engine.
        </div>
      </div>
    );
  }

  const onParam = (paramId: string, value: number) => {
    services.store.execute(setInstrumentParam(services.store.doc, track.id, paramId, value));
  };

  const presets = TSAR_FACTORY_PRESETS.filter((preset) => {
    if (presetFilter.trim() === "") return true;
    const needle = presetFilter.trim().toLowerCase();
    return (
      preset.name.toLowerCase().includes(needle) ||
      preset.tags.some((tag) => tag.includes(needle)) ||
      (preset.genre ?? "").includes(needle)
    );
  });

  const applyPreset = (preset: InstrumentPreset) => {
    services.store.execute(applyInstrumentPreset(services.store.doc, track.id, preset));
  };

  /**
   * Forge a dropped file: import -> decode -> plan -> command. The import
   * lands the sample in the user library (the same path DropZone uses); the
   * plan is refused loudly when the source is silent rather than installing
   * an empty patch.
   */
  const forgeFromFile = async (file: File) => {
    setForgeStatus(`Reading ${file.name}…`);
    try {
      const asset = await importAudioFile(services, file);
      const buffer = services.bank.get(asset.id);
      if (!buffer) {
        setForgeStatus("Import failed — the sample could not be decoded");
        return;
      }
      const plan = forgePlan(buffer.getChannelData(0), buffer.sampleRate);
      if (plan.kind === "empty") {
        setForgeStatus(`Nothing to forge: ${plan.warnings.join("; ")}`);
        return;
      }
      services.store.execute(forgeSampleCommand(services.store.doc, track.id, asset.id, plan, { slot: forgeSlot }));
      setForgeStatus(
        `Forged into source ${forgeSlot === 0 ? "A" : "B"}: ${plan.engine}${
          plan.rootMidi !== null ? `, root MIDI ${plan.rootMidi}` : ""
        }${plan.warnings.length > 0 ? ` — ${plan.warnings.join("; ")}` : ""}`,
      );
    } catch (error) {
      setForgeStatus(error instanceof Error ? `Forge failed: ${error.message}` : "Forge failed");
    }
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void forgeFromFile(file);
  };

  return (
    <div className="tsar-panel" role="region" aria-label="TSAR engine">
      <div className="tsar-header">
        <strong className="tsar-title">TSAR</strong>
        {tsarTracks.length > 1 && (
          <select
            className="tsar-track-select"
            aria-label="TSAR track"
            value={track.id}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {tsarTracks.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        )}
        <span className="tsar-header-hint">Hybrid engine — two sources · morph · mod matrix · Sample Forge</span>
      </div>

      <div className="tsar-columns">
        <section className="tsar-section" aria-label="Source A">
          <h3 className="tsar-section-title">SOURCE A</h3>
          <div className="tsar-params">
            {SOURCE_A.map((param) => (
              <ParamRow key={param.id} id={param.id} track={track} onParam={onParam} />
            ))}
          </div>
        </section>

        <section className="tsar-section" aria-label="Source B">
          <h3 className="tsar-section-title">SOURCE B</h3>
          <div className="tsar-params">
            {SOURCE_B.map((param) => (
              <ParamRow key={param.id} id={param.id} track={track} onParam={onParam} />
            ))}
          </div>
        </section>

        <section className="tsar-section" aria-label="Shared">
          <h3 className="tsar-section-title">MORPH · SUB · NOISE</h3>
          <div className="tsar-params">
            {SHARED.map((param) => (
              <ParamRow key={param.id} id={param.id} track={track} onParam={onParam} />
            ))}
          </div>
          <h3 className="tsar-section-title">VOICE</h3>
          <div className="tsar-params">
            {VOICE.map((param) => (
              <ParamRow key={param.id} id={param.id} track={track} onParam={onParam} />
            ))}
          </div>
        </section>

        <section className="tsar-section" aria-label="Modulation">
          <h3 className="tsar-section-title">LFO</h3>
          <div className="tsar-params">
            {LFO.map((param) => (
              <ParamRow key={param.id} id={param.id} track={track} onParam={onParam} />
            ))}
          </div>
          <h3 className="tsar-section-title">MOD MATRIX</h3>
          <div className="tsar-mod-grid">
            {[1, 2, 3, 4].map((slot) => {
              const srcValue = Math.round(track.params[`mod${slot}Src`] ?? -1) + 1;
              const dstValue = Math.round(track.params[`mod${slot}Dst`] ?? -1) + 1;
              return (
                <div className="tsar-mod-row" key={slot} role="group" aria-label={`Mod slot ${slot}`}>
                  <span className="tsar-mod-index">#{slot}</span>
                  <select
                    className="tsar-mod-select"
                    aria-label={`Mod ${slot} source`}
                    value={srcValue}
                    onChange={(event) => onParam(`mod${slot}Src`, Number(event.target.value) - 1)}
                  >
                    {MOD_SOURCES.map((label, index) => (
                      <option key={label} value={index}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="tsar-mod-select"
                    aria-label={`Mod ${slot} destination`}
                    value={dstValue}
                    onChange={(event) => onParam(`mod${slot}Dst`, Number(event.target.value) - 1)}
                  >
                    {MOD_DESTS.map((label, index) => (
                      <option key={label} value={index}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <Slider
                    compact
                    label="AMT"
                    value={track.params[`mod${slot}Amt`] ?? 0}
                    min={-1}
                    max={1}
                    defaultValue={0}
                    onCommit={(value) => onParam(`mod${slot}Amt`, value)}
                  />
                </div>
              );
            })}
          </div>
          <h3 className="tsar-section-title">TONE</h3>
          <div className="tsar-params">
            {TONE.map((param) => (
              <ParamRow key={param.id} id={param.id} track={track} onParam={onParam} />
            ))}
          </div>
          <h3 className="tsar-section-title">ARPEGGIATOR</h3>
          <div className="tsar-params">
            {ARP.map((param) => (
              <ParamRow key={param.id} id={param.id} track={track} onParam={onParam} />
            ))}
          </div>
        </section>
      </div>

      <div className="tsar-bottom">
        <section
          className="tsar-forge"
          aria-label="Sample Forge"
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
        >
          <h3 className="tsar-section-title">SAMPLE FORGE</h3>
          <div className="tsar-forge-controls">
            <label className="tsar-forge-slot">
              TARGET
              <select
                aria-label="Forge target source"
                value={forgeSlot}
                onChange={(event) => setForgeSlot(Number(event.target.value) === 1 ? 1 : 0)}
              >
                <option value={0}>Source A</option>
                <option value={1}>Source B</option>
              </select>
            </label>
            <button type="button" className="btn btn-small" onClick={() => fileInputRef.current?.click()}>
              FORGE SAMPLE…
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void forgeFromFile(file);
                event.target.value = "";
              }}
            />
          </div>
          <div className="tsar-forge-hint">
            Drop a WAV here — root, character and engine are detected automatically.
          </div>
          {forgeStatus && <div className="tsar-forge-status">{forgeStatus}</div>}
        </section>

        <section className="tsar-presets" aria-label="TSAR factory presets">
          <h3 className="tsar-section-title">FACTORY PRESETS ({presets.length})</h3>
          <input
            className="tsar-preset-filter"
            type="search"
            placeholder="Filter by name, tag or genre…"
            aria-label="Filter TSAR presets"
            value={presetFilter}
            onChange={(event) => setPresetFilter(event.target.value)}
          />
          <div className="tsar-preset-list">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`tsar-preset${track.presetId === preset.id ? " active" : ""}`}
                title={`${preset.name} — ${preset.tags.join(", ")}`}
                onClick={() => applyPreset(preset)}
              >
                <span className="tsar-preset-name">{preset.name.replace(/^TSAR /, "")}</span>
                <span className="tsar-preset-genre">{preset.genre}</span>
              </button>
            ))}
            {presets.length === 0 && <div className="tsar-preset-empty">No preset matches the filter.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
