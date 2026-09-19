import { lazy, Suspense, useEffect, useState } from "react";
import { useDoc, useServices } from "./context";
import {
  resetPadSlice,
  setPadMod,
  setPadParams,
  setPadSynth,
  setTrackParams,
  setInstrumentParam,
  setInstrumentSample,
} from "../commands/commands";
import type { DrumPad, InstrumentKind, PadMod, SampleLayer, Track } from "../project-model/types";
import { FACTORY_ASSETS } from "../sample-library/manifest";
import { INSTRUMENT_DEFS } from "../instruments/registry";
import { pitchName } from "../project-model/types";
import { autoMapVelocityLayers } from "../samples/autoMap";
import { setVelocityLayersCommand } from "../commands/layerCommands";
import { Slider } from "./controls";
import { SampleBrowser } from "./SampleBrowser";
import { WavetablePreview } from "./WavetablePreview";
import { ModMatrixRow, isModMatrixParam } from "./ModMatrixRow";
// Both load on demand: PresetBrowser drags the ~45 KB factory-preset table
// into its chunk (only needed once an instrument track is selected), SliceLab
// only when the SLICE LAB toggle opens. Keeps them out of the entry budget.
const PresetBrowser = lazy(() => import("./PresetBrowser").then((m) => ({ default: m.PresetBrowser })));
const SliceLab = lazy(() => import("./SliceLab").then((m) => ({ default: m.SliceLab })));

const TONAL_ASSETS = FACTORY_ASSETS.filter((a) => a.category === "Tonal");
const DRUM_ASSETS = FACTORY_ASSETS.filter((a) => a.category !== "Tonal");

/**
 * The first screen should expose musical decisions, not every implementation
 * parameter. Advanced mode still renders the complete registry definition.
 * Keep this metadata here (rather than a component-level if/else tree) so a
 * new instrument can opt into the same contract without changing the model.
 */
const SIMPLE_PARAM_IDS: Partial<Record<InstrumentKind, readonly string[]>> = {
  analog: ["oscA", "oscB", "cutoff", "resonance", "attack", "release", "drive"],
  bass: ["sub", "body", "punch", "grit", "cutoff", "glide"],
  "808": ["decay", "pitchDrop", "click", "drive", "glide", "tone"],
  sampler: ["root", "start", "attack", "decay", "cutoff", "reverse"],
  texture: ["color", "motion", "space", "density", "texture", "chaos"],
  wavetable: ["table", "morph", "morphRate", "scanRate", "cutoff", "attack", "release"],
  granular: ["position", "size", "rate", "jitter", "scan", "spread"],
  keys: ["tine", "bell", "body", "damp", "cutoff", "attack", "release"],
  fm: ["ratio", "index", "feedback", "attack", "decay", "release"],
  pluck: ["pick", "damp", "body", "tone", "decay", "cutoff"],
  logdrum: ["decay", "pitchDrop", "tone", "body", "hollow", "grit"],
  spectral: ["profile", "partials", "spacing", "shimmer", "attack", "release"],
  vocalchop: ["root", "vowel", "color", "shift", "sharp", "morph"],
  drumsynth: ["type", "tune", "tone", "decay", "snap", "body", "drive"],
};

/** Instruments that play a sample/browser source, with their panel labels. */
const SAMPLE_BROWSER_KINDS: Partial<Record<InstrumentKind, string>> = {
  sampler: "SAMPLE",
  wavetable: "WAVETABLE SOURCE",
  granular: "GRAIN SOURCE",
};

export function Inspector({
  track,
  selectedPadId,
  onOpenPlugin,
}: {
  track: Track;
  selectedPadId: string;
  onOpenPlugin?: () => void;
}) {
  const services = useServices();
  const doc = useDoc();
  const [sliceLabOpen, setSliceLabOpen] = useState(false);
  const [advancedInstrumentControls, setAdvancedInstrumentControls] = useState(false);
  const [pendingSamplerMapping, setPendingSamplerMapping] = useState<SampleLayer[] | null>(null);

  useEffect(() => {
    // A mapping proposal belongs to the track that received the drop. Never
    // leave an Apply button for a different track after selection changes.
    setPendingSamplerMapping(null);
  }, [track.id]);

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
    const simpleIds = SIMPLE_PARAM_IDS[track.instrument];
    const visibleParams = advancedInstrumentControls
      ? def.params
      : def.params.filter((param) => simpleIds?.includes(param.id) ?? true);
    return (
      <aside className="inspector" aria-label="Inspector">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h2 className="panel-title" style={{ flex: 1 }}>
            {def.name.toUpperCase()} — {track.name}
          </h2>
          {onOpenPlugin && (
            <button type="button" className="btn btn-small" onClick={onOpenPlugin} title="Open the device chain in the bottom dock">
              DEVICES
            </button>
          )}
        </div>

        <div className="inspector-control-mode" role="group" aria-label="Instrument control view">
          <span className="inspector-control-mode-label">CONTROLS</span>
          {([false, true] as const).map((advanced) => (
            <button
              key={advanced ? "advanced" : "simple"}
              type="button"
              className={`btn btn-small${advancedInstrumentControls === advanced ? " active" : ""}`}
              aria-pressed={advancedInstrumentControls === advanced}
              onClick={() => setAdvancedInstrumentControls(advanced)}
            >
              {advanced ? "ADVANCED" : "SIMPLE"}
            </button>
          ))}
        </div>

        <Suspense fallback={<h2 className="panel-title">PRESETS — loading…</h2>}>
          <PresetBrowser track={track} />
        </Suspense>

        {sampleLabel && (
          <>
            <h3 className="inspector-subtitle">{sampleLabel}</h3>
            <SampleBrowser
              assets={TONAL_ASSETS}
              currentId={track.sampleId}
              onSelect={(assetId) => services.store.execute(setInstrumentSample(doc, track.id, assetId))}
              showDropZone
              onBatchImport={
                track.instrument === "sampler"
                  ? (imported) => {
                      // Multi-file drop on a sampler track: file names carry
                      // the mapping (kick_C2.wav, stab F#4.wav, -1/-2 RR) —
                      // spread across the keyboard automatically.
                      const layers = autoMapVelocityLayers(
                        imported.map((a) => ({ sampleId: a.id, name: a.fileName })),
                      );
                      if (layers.length > 1) setPendingSamplerMapping(layers);
                    }
                  : undefined
              }
            />
            {track.instrument === "sampler" && pendingSamplerMapping && (
              <div className="sampler-map-preview" role="dialog" aria-label="Sampler mapping preview">
                <div className="sampler-map-preview-heading">
                  <strong>MAP PREVIEW</strong>
                  <span>
                    {pendingSamplerMapping.length} layers · {new Set(pendingSamplerMapping.map((l) => `${l.minPitch ?? 0}-${l.maxPitch ?? 127}`)).size} keyzones
                  </span>
                </div>
                <p>
                  Imported samples are ready. Preview the first zone, then Apply to commit one undoable sampler mapping.
                </p>
                <div className="sampler-map-preview-actions">
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => {
                      const first = pendingSamplerMapping[0]?.sampleId;
                      if (first) services.engine.previewAsset(first);
                    }}
                  >
                    PREVIEW
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => setPendingSamplerMapping(null)}>
                    CANCEL
                  </button>
                  <button
                    type="button"
                    className="btn btn-small active"
                    onClick={() => {
                      const currentDoc = services.store.doc;
                      const first = pendingSamplerMapping[0]?.sampleId ?? null;
                      services.store.execute(setVelocityLayersCommand(currentDoc, track.id, pendingSamplerMapping, first));
                      setPendingSamplerMapping(null);
                    }}
                  >
                    APPLY MAP
                  </button>
                </div>
              </div>
            )}
            {(track.instrument === "wavetable" || track.instrument === "granular") && (
              <WavetablePreview track={track} />
            )}
          </>
        )}

        {!advancedInstrumentControls && (
          <div className="inspector-control-hint">
            Core sound controls shown · open ADVANCED for the full instrument
          </div>
        )}

        {visibleParams
          .filter((p) => !isModMatrixParam(p.id))
          .map((p) =>
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

        {advancedInstrumentControls && <ModMatrixRow track={track} doc={doc} services={services} />}

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
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <button
          type="button"
          className={`btn btn-small${sliceLabOpen ? " active" : ""}`}
          aria-pressed={sliceLabOpen}
          title="Chop a loop onto this track's pads"
          onClick={() => setSliceLabOpen((v) => !v)}
        >
          SLICE LAB
        </button>
        {onOpenPlugin && (
          <button type="button" className="btn btn-small" onClick={onOpenPlugin} title="Open the drum device chain in the bottom dock">
            DEVICES
          </button>
        )}
      </div>
      {sliceLabOpen && track.kind === "drum" && (
        <Suspense fallback={<p className="inspector-subtitle">SLICE LAB — loading…</p>}>
          <SliceLab track={track} onClose={() => setSliceLabOpen(false)} />
        </Suspense>
      )}

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
              setPadSynth(
                doc,
                pad.id,
                pad.synth ?? { type: "hatClosed", decay: 0.08, tone: 7500, snap: 0.35, body: 0.3 },
              ),
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
              <option value="perc">Perc (Tick)</option>
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
          {(pad.synth?.type === "kick" || pad.synth?.type === "snare" || pad.synth?.type === "clap") && (
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

      <PadModSection pad={pad} />

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

const PAD_MOD_TARGETS = [
  { id: "pitch", label: "PITCH", max: 24, def: 2, fmt: (v: number) => `±${v.toFixed(1)} st` },
  { id: "gain", label: "GAIN", max: 1, def: 0.5, fmt: (v: number) => `±${Math.round(v * 100)}%` },
  { id: "filter", label: "FILTER", max: 8000, def: 2000, fmt: (v: number) => `±${Math.round(v)} Hz` },
] as const;

/** MPC-style per-pad LFO: pick a target, then wave/rate/depth (+ filter center). */
function PadModSection({ pad }: { pad: DrumPad }) {
  const services = useServices();
  const doc = useDoc();
  const mod = pad.mod ?? null;
  const spec = PAD_MOD_TARGETS.find((t) => t.id === mod?.target);
  const buildMod = (target: PadMod["target"]): PadMod => ({
    target,
    wave: mod?.wave ?? "sine",
    rateHz: mod?.rateHz ?? 2,
    depth: mod?.depth ?? PAD_MOD_TARGETS.find((t) => t.id === target)!.def,
    base: mod?.base,
  });
  return (
    <div className="pad-mod">
      <h3 className="inspector-subtitle">PAD LFO</h3>
      <div className="pad-toggles">
        {PAD_MOD_TARGETS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`btn btn-small${mod?.target === t.id ? " active" : ""}`}
            onClick={() => services.store.execute(setPadMod(doc, pad.id, mod?.target === t.id ? null : buildMod(t.id)))}
          >
            {t.label}
          </button>
        ))}
      </div>
      {mod && spec && (
        <>
          <label className="pad-mod-wave">
            <span>WAVE</span>
            <select
              value={mod.wave}
              onChange={(e) =>
                services.store.execute(setPadMod(doc, pad.id, { ...mod, wave: e.target.value as PadMod["wave"] }))
              }
            >
              <option value="sine">SINE</option>
              <option value="triangle">TRI</option>
              <option value="square">SQR</option>
              <option value="sawtooth">SAW</option>
            </select>
          </label>
          <Slider
            label="Rate"
            value={mod.rateHz}
            min={0.01}
            max={20}
            defaultValue={2}
            format={(v) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)} Hz`}
            onCommit={(rateHz) => services.store.execute(setPadMod(doc, pad.id, { ...mod, rateHz }))}
          />
          <Slider
            label="Depth"
            value={mod.depth}
            min={0}
            max={spec.max}
            defaultValue={spec.def}
            format={spec.fmt}
            onCommit={(depth) => services.store.execute(setPadMod(doc, pad.id, { ...mod, depth }))}
          />
          {mod.target === "filter" && (
            <Slider
              label="Center"
              value={mod.base ?? 8000}
              min={80}
              max={16000}
              defaultValue={8000}
              format={(v) => `${Math.round(v)} Hz`}
              onCommit={(base) => services.store.execute(setPadMod(doc, pad.id, { ...mod, base }))}
            />
          )}
        </>
      )}
    </div>
  );
}
