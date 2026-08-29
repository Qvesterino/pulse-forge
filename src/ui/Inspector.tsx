import { useState } from "react";
import { useDoc, useServices } from "./context";
import { SliceLab } from "./SliceLab";
import {
  resetPadSlice,
  setPadParams,
  setPadSynth,
  setTrackParams,
  setInstrumentParam,
  setInstrumentSample,
} from "../commands/commands";
import type { InstrumentKind, Track } from "../project-model/types";
import { FACTORY_ASSETS } from "../sample-library/manifest";
import { INSTRUMENT_DEFS } from "../instruments/registry";
import { pitchName } from "../project-model/types";
import { Slider } from "./controls";
import { PresetBrowser } from "./PresetBrowser";
import { SampleBrowser } from "./SampleBrowser";
import { WavetablePreview } from "./WavetablePreview";

const TONAL_ASSETS = FACTORY_ASSETS.filter((a) => a.category === "Tonal");
const DRUM_ASSETS = FACTORY_ASSETS.filter((a) => a.category !== "Tonal");

/** Instruments that play a sample/browser source, with their panel labels. */
const SAMPLE_BROWSER_KINDS: Partial<Record<InstrumentKind, string>> = {
  sampler: "SAMPLE",
  wavetable: "WAVETABLE SOURCE",
  granular: "GRAIN SOURCE",
};

export function Inspector({ track, selectedPadId }: { track: Track; selectedPadId: string }) {
  const services = useServices();
  const doc = useDoc();
  const [sliceLabOpen, setSliceLabOpen] = useState(false);

  const trackSection = (
    <>
      <h2 className="panel-title">TRACK — {track.name}</h2>
      <Slider
        label="Volume"
        value={track.gain}
        min={0}
        max={1.5}
        defaultValue={0.9}
        format={(v) => `${(20 * Math.log10(Math.max(v, 0.001))).toFixed(1)} dB`}
        onCommit={(gain) => services.store.execute(setTrackParams(doc, track.id, { gain }))}
      />
      <Slider
        label="Pan"
        value={track.pan}
        min={-1}
        max={1}
        defaultValue={0}
        format={(v) => (Math.abs(v) < 0.02 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`)}
        onCommit={(pan) => services.store.execute(setTrackParams(doc, track.id, { pan }))}
      />
    </>
  );

  if (track.kind === "instrument") {
    const def = INSTRUMENT_DEFS[track.instrument];
    const sampleLabel = SAMPLE_BROWSER_KINDS[track.instrument];
    return (
      <aside className="inspector" aria-label="Inspector">
        <h2 className="panel-title">
          {def.name.toUpperCase()} — {track.name}
        </h2>

        <PresetBrowser track={track} />

        {sampleLabel && (
          <>
            <h3 className="inspector-subtitle">{sampleLabel}</h3>
            <SampleBrowser
              assets={TONAL_ASSETS}
              currentId={track.sampleId}
              onSelect={(assetId) => services.store.execute(setInstrumentSample(doc, track.id, assetId))}
              showDropZone
            />
            {(track.instrument === "wavetable" || track.instrument === "granular") && (
              <WavetablePreview track={track} />
            )}
          </>
        )}

        {def.params.map((p) =>
          p.options ? (
            <label key={p.id} className="fx-param-select">
              <span className="slider-label">{p.label}</span>
              <select
                value={
                  p.options.some((o) => o.value === (track.params[p.id] ?? p.default))
                    ? (track.params[p.id] ?? p.default)
                    : p.default
                }
                onChange={(event) =>
                  services.store.execute(setInstrumentParam(doc, track.id, p.id, Number(event.target.value)))
                }
              >
                {p.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <Slider
              key={p.id}
              compact
              label={p.id === "root" ? `ROOT (${pitchName(Math.round(track.params[p.id] ?? p.default))})` : p.label}
              value={track.params[p.id] ?? p.default}
              min={p.min}
              max={p.max}
              defaultValue={p.default}
              format={p.format}
              onCommit={(v) => services.store.execute(setInstrumentParam(doc, track.id, p.id, v))}
            />
          ),
        )}

        {trackSection}
      </aside>
    );
  }

  // GroupTrack: show volume/pan controls only
  if (track.kind === "group") {
    return (
      <aside className="inspector" aria-label="Inspector">
        {trackSection}
      </aside>
    );
  }

  const pad = track.pads.find((p) => p.id === selectedPadId) ?? track.pads[0];
  if (!pad) return null;

  const isSynth = !!pad.synth;

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="slice-lab-toggle">
        <button
          type="button"
          className={`btn btn-small${sliceLabOpen ? " active" : ""}`}
          aria-pressed={sliceLabOpen}
          title="Chop a loop onto this track's pads"
          onClick={() => setSliceLabOpen((v) => !v)}
        >
          SLICE LAB
        </button>
      </div>
      {sliceLabOpen && track.kind === "drum" && <SliceLab track={track} onClose={() => setSliceLabOpen(false)} />}

      <h2 className="panel-title">PAD — {pad.name}</h2>

      <div className="pad-source-toggle" style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <button
          type="button"
          className={`btn btn-small${!isSynth ? " active" : ""}`}
          onClick={() => services.store.execute(setPadSynth(doc, pad.id, null))}
        >
          SAMPLE
        </button>
        <button
          type="button"
          className={`btn btn-small${isSynth ? " active" : ""}`}
          onClick={() =>
            services.store.execute(
              setPadSynth(doc, pad.id, pad.synth ?? { type: "hatClosed", decay: 0.08, tone: 7500 }),
            )
          }
        >
          SYNTH
        </button>
      </div>

      {!isSynth ? (
        <>
          <h3 className="inspector-subtitle">SAMPLE</h3>
          <SampleBrowser
            assets={DRUM_ASSETS}
            currentId={pad.assetId}
            onSelect={(assetId) => services.store.execute(setPadParams(doc, pad.id, { assetId }))}
            showDropZone
          />
        </>
      ) : (
        <div className="pad-synth-controls">
          <h3 className="inspector-subtitle">SYNTH</h3>
          <label className="fx-param-select">
            <span className="slider-label">TYPE</span>
            <select
              value={pad.synth?.type ?? "hatClosed"}
              onChange={(e) => {
                const type = e.target.value as any;
                const defaults: Record<string, { decay: number; tone: number }> = {
                  hatClosed: { decay: 0.08, tone: 7500 },
                  hatOpen: { decay: 0.32, tone: 7000 },
                  clap: { decay: 0.25, tone: 1200 },
                  perc: { decay: 0.08, tone: 2100 },
                  cowbell: { decay: 0.32, tone: 540 },
                };
                const d = defaults[type];
                services.store.execute(setPadSynth(doc, pad.id, { type, decay: d.decay, tone: d.tone }));
              }}
            >
              <option value="hatClosed">Hat Closed</option>
              <option value="hatOpen">Hat Open</option>
              <option value="clap">Clap</option>
              <option value="perc">Perc (Tick)</option>
              <option value="cowbell">Cowbell</option>
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
        </div>
      )}

      {!isSynth && (pad.sliceStart !== undefined || pad.sliceEnd !== undefined) && (
        <div className="pad-slice-controls">
          <h3 className="inspector-subtitle">SLICE</h3>
          <label className="slice-number">
            <span>START</span>
            <input
              type="number"
              min={0}
              max={services.bank.get(pad.assetId)?.duration ?? 9999}
              step={0.001}
              value={(pad.sliceStart ?? 0).toFixed(3)}
              onChange={(event) =>
                services.store.execute(
                  setPadParams(doc, pad.id, { sliceStart: Math.max(0, Number(event.target.value) || 0) }),
                )
              }
            />
          </label>
          <label className="slice-number">
            <span>END</span>
            <input
              type="number"
              min={(pad.sliceStart ?? 0) + 0.001}
              max={services.bank.get(pad.assetId)?.duration ?? 9999}
              step={0.001}
              value={(pad.sliceEnd ?? services.bank.get(pad.assetId)?.duration ?? 0).toFixed(3)}
              onChange={(event) =>
                services.store.execute(
                  setPadParams(doc, pad.id, {
                    sliceEnd: Math.max((pad.sliceStart ?? 0) + 0.001, Number(event.target.value) || 0),
                  }),
                )
              }
            />
          </label>
          <Slider
            compact
            label="Fade In"
            value={pad.sliceFadeIn ?? 0}
            min={0}
            max={Math.max(
              0.001,
              (pad.sliceEnd ?? services.bank.get(pad.assetId)?.duration ?? 1) - (pad.sliceStart ?? 0),
            )}
            defaultValue={0}
            format={(v) => `${v.toFixed(3)} s`}
            onCommit={(value) => services.store.execute(setPadParams(doc, pad.id, { sliceFadeIn: value }))}
          />
          <Slider
            compact
            label="Fade Out"
            value={pad.sliceFadeOut ?? 0}
            min={0}
            max={Math.max(
              0.001,
              (pad.sliceEnd ?? services.bank.get(pad.assetId)?.duration ?? 1) - (pad.sliceStart ?? 0),
            )}
            defaultValue={0}
            format={(v) => `${v.toFixed(3)} s`}
            onCommit={(value) => services.store.execute(setPadParams(doc, pad.id, { sliceFadeOut: value }))}
          />
          <div className="pad-toggles">
            <button
              type="button"
              className={`btn btn-small${pad.sliceReverse ? " active" : ""}`}
              aria-pressed={pad.sliceReverse === true}
              onClick={() => services.store.execute(setPadParams(doc, pad.id, { sliceReverse: !pad.sliceReverse }))}
            >
              REVERSE
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => services.store.execute(resetPadSlice(doc, pad.id))}
            >
              RESET
            </button>
          </div>
        </div>
      )}

      <Slider
        label="Gain"
        value={pad.gain}
        min={0}
        max={2}
        defaultValue={1}
        format={(v) => `${(20 * Math.log10(Math.max(v, 0.001))).toFixed(1)} dB`}
        onCommit={(gain) => services.store.execute(setPadParams(doc, pad.id, { gain }))}
      />
      <Slider
        label="Pan"
        value={pad.pan}
        min={-1}
        max={1}
        defaultValue={0}
        format={(v) => (Math.abs(v) < 0.02 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`)}
        onCommit={(pan) => services.store.execute(setPadParams(doc, pad.id, { pan }))}
      />
      <Slider
        label="Pitch"
        value={pad.pitch}
        min={-24}
        max={24}
        defaultValue={0}
        format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} st`}
        onCommit={(pitch) => services.store.execute(setPadParams(doc, pad.id, { pitch }))}
      />

      <div className="pad-toggles">
        <button
          type="button"
          className={`btn btn-small${pad.mute ? " active-mute" : ""}`}
          onClick={() => services.store.execute(setPadParams(doc, pad.id, { mute: !pad.mute }))}
        >
          MUTE
        </button>
        <button
          type="button"
          className={`btn btn-small${pad.solo ? " active-solo" : ""}`}
          onClick={() => services.store.execute(setPadParams(doc, pad.id, { solo: !pad.solo }))}
        >
          SOLO
        </button>
      </div>

      {trackSection}
    </aside>
  );
}
