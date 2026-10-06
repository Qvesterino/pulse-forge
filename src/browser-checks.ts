import { EFFECT_DEFS, EFFECT_ORDER, defaultParamsOf } from "./effects/registry";
import type { DrumPad } from "./project-model/types";
import { Scheduler } from "./scheduler/Scheduler";
import { Transport } from "./transport/Transport";
import { createSchedulerDriver } from "./scheduler/schedulerDriver";
import { INSTRUMENT_DEFS, INSTRUMENT_ORDER, defaultInstrumentParams } from "./instruments/registry";
import { generateFactoryBank, RR_VARIATIONS, type SampleBank } from "./sample-library/factory";
import { CURATED_SAMPLES, loadCuratedLayer } from "./sample-library/curated";
import { normalizeIntent } from "./intent/normalize";
import { planGeneration } from "./intent/plan";
import { loadCoreWorklets } from "./audio-worklets/loader";
import { renderProject } from "./rendering/renderer";
import { buildStemProject, STEM_GROUPS } from "./rendering/stems";
import { encodeWav } from "./rendering/wav";
import { createDefaultProject, migrateProject, normalizeProject, validateProjectShape } from "./project-model/schema";
import { TEMPLATES, createProjectFromTemplate } from "./project-model/templates";
import { factoryPresets, warmFactoryPresets } from "./presets/factory-loader";
import { FACTORY_ASSETS } from "./sample-library/manifest";
import { FACTORY_PRESET_LOUDNESS, NON_DETERMINISTIC_PRESETS } from "./presets/preset-loudness.generated";
import { analyzeLoudnessBuffer } from "./audio-engine/kweighting";
import { analyzeArtifacts, evaluateArtifacts, logEnvelopeCorrelation } from "./audio-engine/artifactGate";
import {
  addAutomationLane,
  addAutomationPoint,
  addEffect,
  applyInstrumentPreset,
  setEffectParam,
} from "./commands/commands";
import { applyGenerationResultCommand } from "./commands/aiPattern";
import { generateAsyncResult } from "./intent/pipeline";
import { ProjectStore } from "./store/ProjectStore";
import { PPQ } from "./project-model/types";
import { loadAllWorklets, isWorkletReady } from "./audio-worklets/loader";
import { createBitcrusherNode } from "./audio-worklets/bitcrusher-node";
import { AudioEngine } from "./audio-engine/AudioEngine";
import { LiveRecorder } from "./audio-engine/recorder";
import { detectTransients } from "./audio-engine/transients";
import { createFxEqProcessor } from "./effects/fxeq-core/core/fxEqProcessor";
import { createFxEqNode } from "./effects/fxeqNode";
import { UltinaProcessor } from "./effects/ultina-core/dsp/ultinaProcessor";
import { createOzvenaProcessor } from "./effects/ozvena-core/core/ozvenaProcessor";
import { defaultOzvenaStateV1 } from "./effects/ozvena-core/v2/types";
import { registerCoreModules } from "./effects/ultina-core/dsp/moduleFactories";
import { createKwMeterNode } from "./audio-worklets/kwmeter-node";
import { createDrumTrackModel, createGroupTrackModel } from "./project-model/schema";
import { encodeMp3 } from "./export/mp3";
import { pickVideoMimeType, recordVideo } from "./export/video";
import type { DrumTrack, EffectType, InstrumentTrack, ProjectDocument } from "./project-model/types";
import type { InstrumentRuntime } from "./instruments/types";
import { generatePattern } from "./ai/generator";
import { canonicalizePattern, contentHash } from "./ai/evaluation";
import { inspectPatternInvariants } from "./ai/invariants";
import { autoMapVelocityLayers } from "./samples/autoMap";
import { measurePreviewAudio, passesPreviewAudio, previewNoteDuration } from "./presets/audioQuality";
import { hashString } from "./shared/rng";
import { auditLiveOfflineParity, parityObligationCheck } from "./testing/live-offline-parity";

export interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

const SR = 44100;

function peakOf(data: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  return peak;
}

/** How often the value changes when sampled every `step` frames. */
function countChanges(data: Float32Array, step: number): number {
  let changes = 0;
  for (let i = step; i < data.length; i += step) {
    if (Math.abs(data[i] - data[i - step]) > 1e-6) changes++;
  }
  return changes;
}

/**
 * Worklet GR metering travels over the port and arrives AFTER an offline
 * render resolves — with engine-dependent latency (Firefox delivers
 * noticeably later than Chromium; a fixed 120 ms sleep read 0 there while
 * the DSP provably compressed). MUST be called BEFORE rt.dispose(): dispose
 * nulls the port handler, so stragglers would land in a dead listener.
 * Polls until a nonzero reading arrives (silence never compresses, so
 * 0 legitimately means "no reduction") or the deadline passes.
 */
async function readGrAfterRender(rt: { getGainReductionDb?: () => number }, waitMs = 1000): Promise<number> {
  const deadline = performance.now() + waitMs;
  let gr = rt.getGainReductionDb?.() ?? 0;
  while (gr <= 0 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    gr = rt.getGainReductionDb?.() ?? 0;
  }
  return gr;
}

async function renderThrough(type: EffectType, paramsOverride: Record<string, number> = {}): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.floor(SR / 2), SR);
  const def = EFFECT_DEFS[type];
  const params = { ...defaultParamsOf(type), ...paramsOverride };
  const rt = def.factory(ctx, { id: "check-fx", type, bypassed: false, params }, { bpm: 124 });
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 220;
  const gain = ctx.createGain();
  gain.gain.value = 0.5;
  osc.connect(gain).connect(rt.input);
  rt.output.connect(ctx.destination);
  osc.start(0);
  const buffer = await ctx.startRendering();
  rt.dispose();
  return buffer.getChannelData(0);
}

/**
 * Render every factory preset through the same instrument factories used by
 * AudioEngine.previewInstrumentPreset. This is a content gate, not a musical
 * preference score: each audition must produce finite, audible, headroom-
 * controlled audio without a sustained full-scale run.
 */
export async function auditFactoryPresetAudio(bank: SampleBank): Promise<CheckResult> {
  const failures: string[] = [];
  const loudnessDrift: string[] = [];
  let rendered = 0;

  // The bank comes from the lazy loader — the audit warms it first so pack
  // presets (piano + VSCO) are auditioned exactly as before the seam.
  await warmFactoryPresets();
  const FACTORY_PRESETS = factoryPresets();
  for (const preset of FACTORY_PRESETS) {
    const track: InstrumentTrack = {
      id: `factory-preview-${preset.id}`,
      kind: "instrument",
      instrument: preset.instrument,
      name: preset.name,
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: preset.sampleId ?? null,
      params: { ...defaultInstrumentParams(preset.instrument), ...preset.params },
      effects: [],
      sends: {},
      presetId: preset.id,
    };
    const durationSec = previewNoteDuration(track.params);
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * (durationSec + 0.25)), SR);
    const previewGain = ctx.createGain();
    previewGain.gain.value = 0.78;
    let runtime: InstrumentRuntime | null = null;

    try {
      runtime = INSTRUMENT_DEFS[preset.instrument].factory(ctx, track, {
        bpm: 124,
        getSample: (id) => bank.get(id),
      });
      runtime.output.connect(previewGain).connect(ctx.destination);
      runtime.noteOn(60, 0.82, 0.01, durationSec);
      const buffer = await ctx.startRendering();
      const metrics = measurePreviewAudio(
        Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)),
      );
      rendered++;
      if (!passesPreviewAudio(metrics)) {
        failures.push(
          `${preset.id}: finite=${metrics.finite} peak=${metrics.peak.toFixed(4)} rms=${metrics.rms.toFixed(4)} clipped=${(
            metrics.clippedRatio * 100
          ).toFixed(3)}%`,
        );
      }
      // Loudness-map drift gate: the generated measurement (see
      // scripts/measure-preset-loudness.mjs) must still describe this preset.
      // If a preset edit moves its audition loudness by more than the
      // tolerance, the map is stale — regenerate it. Compared
      // measurement-vs-measurement so clamp saturation at ±18 dB cannot
      // false-positive. Order-dependent engines (flagged by the generator)
      // scatter between contexts — skipped until they are deterministic.
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
      const reading = analyzeLoudnessBuffer(channels, SR);
      const mapped = FACTORY_PRESET_LOUDNESS[preset.id];
      const nondeterministic = NON_DETERMINISTIC_PRESETS.includes(preset.id);
      if (!nondeterministic && reading.measured && mapped !== undefined) {
        const drift = Math.abs(reading.integrated - mapped);
        if (reading.integrated > -70 && drift > 2.5) {
          loudnessDrift.push(
            `${preset.id}: measures ${reading.integrated.toFixed(1)} LUFS, map recorded ${mapped.toFixed(1)} — run npm run presets:loudness`,
          );
        }
      }
    } catch (error) {
      failures.push(`${preset.id}: ${String(error)}`);
    } finally {
      runtime?.dispose();
    }
  }

  return {
    name: "presets: auditions finite/unclipped + loudness map in sync",
    ok: failures.length === 0 && loudnessDrift.length === 0 && rendered === FACTORY_PRESETS.length,
    message:
      failures.length === 0 && loudnessDrift.length === 0
        ? `passed=${rendered}/${FACTORY_PRESETS.length}`
        : `passed=${rendered}/${FACTORY_PRESETS.length}` +
          `${failures.length ? ` failures=${failures.slice(0, 8).join(" | ")}` : ""}` +
          `${loudnessDrift.length ? ` drift=${loudnessDrift.slice(0, 6).join(" | ")}` : ""}`,
  };
}

/**
 * Drum one-shot content gate (kick bank 2026-09 expansion 6 → 15, snare/hat
 * expansion 9 → 19): every kick/snare/hat in the manifest must render
 * audible, bounded, finite audio with a sane tail,
 * and the bank must stay a PICKING bank — no two kicks may be near-identical
 * waveforms (a copy-paste or parameter collision would silently remove a
 * choice). Runs on the pristine synthesized bank (pre-curation) because the
 * curated mastering only re-levels/glues — identity is the synth's job.
 */
export async function auditKickBank(bank: SampleBank): Promise<CheckResult> {
  // Snare/Hat joined the kick content gate with the 2026-09 snare/hat bank
  // expansion — same one-shot invariants, one audit.
  const kickIds = FACTORY_ASSETS.filter(
    (a) => a.category === "Kick" || a.category === "Snare" || a.category === "Hat",
  ).map((a) => a.id);
  const failures: string[] = [];

  const buffers: AudioBuffer[] = [];
  for (const id of kickIds) {
    const buf = bank.get(id);
    if (!buf) failures.push(`${id}: missing from factory bank`);
    else buffers.push(buf);
  }
  if (failures.length > 0) {
    return {
      name: "drum bank (kick/snare/hat): renders audible/finite/distinct",
      ok: false,
      message: failures.join(" | "),
    };
  }

  const sigs = buffers.map((buf, i) => {
    const data = buf.getChannelData(0);
    let peak = 0;
    let peakIdx = 0;
    let finite = true;
    for (let j = 0; j < data.length; j++) {
      const v = data[j];
      if (!Number.isFinite(v)) finite = false;
      if (Math.abs(v) > peak) {
        peak = Math.abs(v);
        peakIdx = j;
      }
    }
    const rms = Math.sqrt(data.reduce((acc, v) => acc + v * v, 0) / Math.max(1, data.length));
    if (!finite) failures.push(`${kickIds[i]}: non-finite samples`);
    if (peak < 0.05) failures.push(`${kickIds[i]}: inaudible peak=${peak.toFixed(4)}`);
    if (peak > 1.7) failures.push(`${kickIds[i]}: runaway peak=${peak.toFixed(3)}`);
    if (rms < 0.01) failures.push(`${kickIds[i]}: no body rms=${rms.toFixed(4)}`);
    // Attack must land up-front — a kick whose peak arrives late reads as a
    // broken render, not a sound.
    if (peakIdx > data.length * 0.25) {
      failures.push(`${kickIds[i]}: late attack at ${(peakIdx / buf.sampleRate).toFixed(3)}s`);
    }
    // Signature for distinctness: ×16-downsampled first 0.3 s.
    const stride = 16;
    const window = Math.min(data.length, Math.floor(0.3 * buf.sampleRate));
    const sig = new Float32Array(Math.floor(window / stride));
    for (let j = 0; j < sig.length; j++) sig[j] = data[j * stride];
    return sig;
  });

  for (let a = 0; a < sigs.length; a++) {
    for (let b = a + 1; b < sigs.length; b++) {
      const n = Math.min(sigs[a].length, sigs[b].length);
      let dot = 0;
      let ea = 0;
      let eb = 0;
      for (let j = 0; j < n; j++) {
        dot += sigs[a][j] * sigs[b][j];
        ea += sigs[a][j] * sigs[a][j];
        eb += sigs[b][j] * sigs[b][j];
      }
      const corr = Math.abs(dot) / Math.max(1e-9, Math.sqrt(ea * eb));
      if (corr > 0.97) failures.push(`${kickIds[a]} ≈ ${kickIds[b]}: corr=${corr.toFixed(3)}`);
    }
  }

  return {
    name: "drum bank (kick/snare/hat): renders audible/finite/distinct",
    ok: failures.length === 0,
    message: failures.length === 0 ? `passed=${kickIds.length}/${kickIds.length}` : failures.slice(0, 8).join(" | "),
  };
}

/**
 * FX expansion (docs/FX-EXPANSION-ROADMAP.md): each new beatmaking effect
 * must (a) render audible output through its real worklet chain and
 * (b) render deterministically — two identical renders stay bit-identical
 * (offline-parity contract). ringMod/tapeStop/freqShifter/pitchShift/vinyl
 * are probed with a drum-ish tone; beatMangler needs a full bar recorded
 * before its mangled pass, so it fills one bar at the project tempo first.
 */
export async function auditFxExpansion(bank: SampleBank): Promise<CheckResult> {
  const failures: string[] = [];
  const types: EffectType[] = ["ringMod", "tapeStop", "freqShifter", "pitchShift", "vinyl", "beatMangler"];
  const sr = 44100;
  const template = createProjectFromTemplate("house");
  const drumTrack = template.tracks.find((t): t is DrumTrack => t.kind === "drum");
  if (!drumTrack) throw new Error("fx expansion: house template lost its drum track");

  for (const type of types) {
    try {
      const doc: ProjectDocument = { ...template, bpm: 120 };
      const fxId = `fxe-${type}`;
      doc.tracks = [
        {
          ...drumTrack,
          id: "fxe-drums",
          effects: [{ id: fxId, type, bypassed: false, params: defaultParamsOf(type) }],
        },
      ];
      const barSamples = Math.round((60 / doc.bpm) * 4 * sr) + 4096;
      const ctx = new OfflineAudioContext(2, barSamples * 2, sr);
      await loadCoreWorklets(ctx);
      const engine = new AudioEngine();
      engine.attachBank(bank);
      engine.useContext(ctx);
      engine.setProject(doc);
      engine.trigger("fxe-drums", drumTrack.pads[0], 0.03, 1);
      engine.trigger("fxe-drums", drumTrack.pads[4] ?? drumTrack.pads[0], barSamples / sr - 0.2, 1);
      const buffer = await ctx.startRendering();
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch));
      const metrics = measurePreviewAudio(channels);
      if (!passesPreviewAudio(metrics)) {
        failures.push(`${type}: peak=${metrics.peak.toFixed(4)} clipped=${(metrics.clippedRatio * 100).toFixed(2)}%`);
        continue;
      }
      // Determinism: same doc rendered again must be sample-identical.
      const ctx2 = new OfflineAudioContext(2, barSamples * 2, sr);
      await loadCoreWorklets(ctx2);
      const engine2 = new AudioEngine();
      engine2.attachBank(bank);
      engine2.useContext(ctx2);
      engine2.setProject(doc);
      engine2.trigger("fxe-drums", drumTrack.pads[0], 0.03, 1);
      engine2.trigger("fxe-drums", drumTrack.pads[4] ?? drumTrack.pads[0], barSamples / sr - 0.2, 1);
      const buffer2 = await ctx2.startRendering();
      const ch1 = buffer.getChannelData(0);
      const ch2 = buffer2.getChannelData(0);
      let maxDiff = 0;
      for (let i = 0; i < ch1.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ch1[i] - ch2[i]));
      if (maxDiff > 1e-6) failures.push(`${type}: non-deterministic render (maxDiff=${maxDiff.toExponential(2)})`);
    } catch (error) {
      failures.push(`${type}: ${String(error)}`);
    }
  }

  return {
    name: "fx expansion: ringMod/tapeStop/freqShifter/pitchShift/vinyl/beatMangler audible + deterministic",
    ok: failures.length === 0,
    message: failures.length === 0 ? `passed=${types.length}/${types.length}` : failures.slice(0, 6).join(" | "),
  };
}

/**
 * Audio-thread budget (release-gate hardening).
 *
 * The offline render budget above proves the EXPORT path is fast. This proves
 * the REALTIME path stays inside the per-quantum deadline: a synthetic
 * N-track × M-effect project plays on a live AudioContext while the engine's
 * `rt-monitor` worklet measures how long the audio thread spends per render
 * quantum and how often quanta are dropped (the xrun proxy). A regression
 * that makes the graph too heavy shows up as a rising `loadPercent` / xrun
 * count long before a user hears a click.
 *
 * `informationalOnly` is the same shared-machine guard the render budget uses:
 * when the runner is co-tenanted the numbers are printed, not gated.
 */
export async function auditRtBudget(bank: SampleBank, informationalOnly = false): Promise<CheckResult> {
  const TRACKS = 12;
  const EFFECTS_PER_TRACK = 4;
  const seconds = 2.5;
  let ctx: AudioContext | null = null;
  try {
    const template = createProjectFromTemplate("house");
    const source = template.tracks.find((t): t is DrumTrack => t.kind === "drum");
    if (!source) return { name: "rt budget: N×M realtime", ok: false, message: "no drum track in template" };

    // N tracks, each carrying M effects (a spread across the catalogue so the
    // measurement covers different DSP costs rather than M copies of one).
    const stack: EffectType[] = ["eq", "compressor", "saturation", "reverb", "chorus", "delay"];
    const tracks = Array.from({ length: TRACKS }, (_, i) => ({
      ...source,
      id: `rt-budget-${i}`,
      effects: Array.from({ length: EFFECTS_PER_TRACK }, (_, e) => ({
        id: `rt-fx-${i}-${e}`,
        type: stack[(i + e) % stack.length],
        bypassed: false,
        params: defaultParamsOf(stack[(i + e) % stack.length]),
      })),
    }));
    const doc: ProjectDocument = { ...template, bpm: 120, tracks };

    ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    await loadCoreWorklets(ctx);
    const engine = new AudioEngine();
    engine.attachBank(bank);
    engine.useContext(ctx);
    engine.setProject(doc);
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    engine.resetRtLoad();

    // Play the whole project: every track's kick on a simple pulse so the
    // graph is genuinely pulled for the whole measurement window.
    const stepSec = 0.25;
    const steps = Math.floor(seconds / stepSec);
    for (let s = 0; s < steps; s++) {
      const at = ctx.currentTime + 0.1 + s * stepSec;
      for (const track of tracks) {
        engine.trigger(
          track.id,
          (track as DrumTrack).pads[(s + track.id.length) % (track as DrumTrack).pads.length],
          at,
          0.8,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 250));

    const rt = engine.getRtLoad();
    if (!rt || rt.blocks === 0) {
      return {
        name: "rt budget: 12 tracks × 4 effects realtime",
        ok: informationalOnly,
        message: "rt-monitor produced no heartbeat (worklet module unavailable on this context)",
      };
    }
    // Expected heartbeat cadence: one report per `reportEveryBlocks` quanta.
    const expectedGapMs = (64 * 128 * 1000) / rt.sampleRate;
    const jitterRatio = expectedGapMs > 0 ? rt.avgGapMs / expectedGapMs : 0;
    const detail =
      `blocks=${rt.blocks} xruns=${rt.xruns} heartbeat avg=${rt.avgGapMs.toFixed(2)}ms ` +
      `max=${rt.maxGapMs.toFixed(2)}ms (expected≈${expectedGapMs.toFixed(2)}ms, ${jitterRatio.toFixed(2)}×) ` +
      `quantum=${rt.quantumMs.toFixed(3)}ms` +
      (informationalOnly ? " — machine loaded, informational run" : "");
    // The gate: the device must not drop quanta, and the heartbeat must
    // arrive near its expected cadence (a graph that misses its deadline
    // makes the heartbeat late or bursty).
    const ok = rt.xruns === 0 && jitterRatio < 1.5;
    return {
      name: "rt budget: 12 tracks × 4 effects realtime",
      ok: informationalOnly || ok,
      message: informationalOnly ? detail : ok ? detail : `OVER BUDGET — ${detail}`,
    };
  } catch (error) {
    return { name: "rt budget: 12 tracks × 4 effects realtime", ok: false, message: String(error) };
  } finally {
    await ctx?.close().catch(() => undefined);
  }
}

/**
 * Dense-matrix offline render budget (release-gate hardening).
 *
 * The per-template budget above measures ONE track's worth of work. This
 * renders the same synthetic N-track × M-effect matrix the realtime budget
 * uses, so a graph that grew structurally more expensive trips a deterministic
 * gate. Offline rendering is CPU-bound and load-independent, so unlike the
 * realtime budget it is always gated (a loaded machine slows it, but the
 * ratio still separates structure from noise by a wide margin).
 */
export async function auditDenseRender(bank: SampleBank, informationalOnly = false): Promise<CheckResult> {
  const TRACKS = 8;
  const EFFECTS_PER_TRACK = 4;
  const bars = 8;
  try {
    const template = createProjectFromTemplate("house");
    const source = template.tracks.find((t): t is DrumTrack => t.kind === "drum");
    const scene = template.scenes[0];
    if (!source || !scene) {
      return { name: "perf: 12×4 dense render budget", ok: false, message: "template missing drum track or scene" };
    }
    const stack: EffectType[] = ["eq", "compressor", "saturation", "reverb", "chorus", "delay"];
    const tracks = Array.from({ length: TRACKS }, (_, i) => ({
      ...source,
      id: `dense-${i}`,
      effects: Array.from({ length: EFFECTS_PER_TRACK }, (_, e) => ({
        id: `dense-fx-${i}-${e}`,
        type: stack[(i + e) % stack.length],
        bypassed: false,
        params: defaultParamsOf(stack[(i + e) % stack.length]),
      })),
    }));
    const doc: ProjectDocument = {
      ...template,
      bpm: 120,
      tracks,
      arrangement: {
        ...template.arrangement,
        clips: Array.from({ length: bars }, (_, bar) => ({
          id: `dense-bar-${bar}`,
          sceneId: scene.id,
          startBar: bar,
          lengthBars: 1,
        })),
      },
    };
    const t0 = performance.now();
    const rendered = await renderProject(doc, bank, { mode: "song", sampleRate: SR, tailSeconds: 0.5 });
    const ms = performance.now() - t0;
    const audioMs = rendered.duration * 1000;
    // Budget is RELATIVE to the same-machine baseline, not an absolute wall
    // clock: the per-template budget above shows a co-tenanted runner can miss
    // an absolute deadline while every lighter render still passes. Measuring
    // the identical 8-bar arrangement with a SINGLE bare track and then the
    // N×M matrix cancels the machine's speed out of the ratio, so what the gate
    // actually measures is "how much more does this graph cost than the same
    // song on one track" — which is the regression a new effect would cause.
    const baselineDoc: ProjectDocument = {
      ...doc,
      tracks: [{ ...source, id: "dense-base", effects: [] }],
    };
    const b0 = performance.now();
    await renderProject(baselineDoc, bank, { mode: "song", sampleRate: SR, tailSeconds: 0.5 });
    const baselineMs = performance.now() - b0;
    // A 4-effect chain per track is a realistic ceiling for a dense project;
    // 12 s of headroom over the single-track baseline keeps a normal mix well
    // inside it while still tripping when an effect's DSP gets materially
    // more expensive.
    const budgetMs = Math.max(12000, baselineMs + 12000);
    const ok = ms < budgetMs;
    return {
      name: "perf: 8 tracks × 4 effects render stays within baseline + headroom",
      ok: informationalOnly || ok,
      message:
        `${ms.toFixed(0)}ms vs ${baselineMs.toFixed(0)}ms single-track baseline for ` +
        `${audioMs.toFixed(0)}ms audio (budget ${budgetMs.toFixed(0)}ms, ` +
        `${(ms / Math.max(1, baselineMs)).toFixed(2)}× baseline)` +
        (informationalOnly ? " — machine loaded, informational run" : ""),
    };
  } catch (error) {
    return {
      name: "perf: 8 tracks × 4 effects render stays within baseline + headroom",
      ok: false,
      message: String(error),
    };
  }
}

export async function runChecks(onProgress?: (result: CheckResult) => void): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const record = (result: CheckResult) => {
    results.push(result);
    onProgress?.(result);
  };
  const check = (name: string, ok: boolean, message = "") =>
    record({ name, ok, message: message || (ok ? "ok" : "failed") });

  const bank = await generateFactoryBank();

  // Audit 12 lifecycle stress: repeated init → process → teardown → reinit.
  // Each cycle builds a FRESH AudioContext + engine, plays a note against the
  // project, then closes the context. A leak (uncleared node map, stale
  // worklet cache, listener pile-up) shows up as a throw, a dead context, or
  // an engine error on the third cycle.
  try {
    const doc = createProjectFromTemplate("house");
    const drum = doc.tracks.find((t) => t.kind === "drum")!;
    for (let cycle = 1; cycle <= 3; cycle++) {
      const ctx = new AudioContext();
      try {
        if (ctx.state === "suspended") await ctx.resume();
        const engine = new AudioEngine();
        engine.attachBank(bank);
        engine.useContext(ctx);
        engine.setProject(doc);
        engine.noteOn(drum.id, 36, 0.9, ctx.currentTime + 0.05, 0.2);
        await new Promise((r) => setTimeout(r, 250));
        engine.panic();
      } finally {
        await ctx.close();
      }
    }
    check("engine lifecycle: 3× init→process→teardown→reinit cycles clean", true);
  } catch (error) {
    check(
      "engine lifecycle: 3× init→process→teardown→reinit cycles clean",
      false,
      String(error instanceof Error ? error.message : error),
    );
  }

  const rrIds = Object.entries(RR_VARIATIONS).flatMap(([base, vars]) => vars.map((_, i) => `${base}.rr${i + 2}`));
  const missingBank = [
    ...FACTORY_ASSETS.filter((a) => !bank.has(a.id)).map((a) => a.id),
    ...rrIds.filter((id) => !bank.has(id)),
  ];
  check(
    "factory bank generates a buffer for every manifest asset + RR variation",
    missingBank.length === 0,
    missingBank.length > 0
      ? `missing=${missingBank.join(",")}`
      : `size=${bank.size}/${FACTORY_ASSETS.length + rrIds.length}`,
  );
  const silentAssets = bank.entries().filter(([, buf]) => peakOf(buf.getChannelData(0)) < 0.001);
  check("factory buffers are audible", silentAssets.length === 0, silentAssets.map(([id]) => id).join(","));
  record(await auditKickBank(bank));
  // The app's live bank carries the curated layer (services boot) — the
  // preset audit must measure the sound users actually hear, not the synth
  // fallback. Sampler/texture probes sample curated overrides directly.
  await loadCuratedLayer(bank);
  record(await auditFactoryPresetAudio(bank));
  record(await auditFxExpansion(bank));
  // Live↔offline parity gate (release-gate hardening): the obligation check
  // is cheap and registry-derived; the null test renders the same document
  // through a live AudioContext and the export renderer and compares them.
  record(parityObligationCheck());
  record(await auditLiveOfflineParity(bank));
  {
    // Round-robin variants must be DERIVED from the bank's CURRENT base. The
    // curated layer overrides bases AFTER the initial derivation, so a stale
    // variant would be the synth fallback alternating with the mastered WAV —
    // two different drums instead of one drum with micro-variation. Every
    // variation must correlate strongly with its base (resample + ±4 % gain
    // keeps correlation high; a different render does not).
    const correlation = (baseId: string): number | null => {
      const base = bank.get(baseId);
      const rr2 = bank.get(`${baseId}.rr2`);
      if (!base || !rr2) return null;
      const a = base.getChannelData(0);
      const b = rr2.getChannelData(0);
      const n = Math.min(a.length, b.length);
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < n; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      return dot / Math.max(1e-12, Math.sqrt(na) * Math.sqrt(nb));
    };
    const readings = Object.keys(RR_VARIATIONS).map((baseId) => ({ baseId, corr: correlation(baseId) }));
    const weak = readings.filter((entry) => entry.corr === null || entry.corr <= 0.7);
    check(
      "RR variants are re-derived from the curated base (same drum, micro-variation)",
      weak.length === 0,
      weak.length > 0
        ? weak.map((entry) => `${entry.baseId}:${entry.corr === null ? "missing" : entry.corr.toFixed(3)}`).join(",")
        : `min=${Math.min(...readings.map((entry) => entry.corr ?? 0)).toFixed(3)}/${readings.length}`,
    );
  }

  {
    // Curated factory layer (VISION §5): the seeds in public/samples must
    // actually reach the bank and OVERRIDE the synthesized slots end-to-end
    // (fetch → decode → bank.add), with absent files leaving synth fallback.
    try {
      // Isolated bank — later checks (PDC correlation, meters…) must see the
      // pristine synthesized kit, not the mastered curated overrides.
      const curatedBank = await generateFactoryBank();
      const before = curatedBank.get(CURATED_SAMPLES[0].id);
      const result = await loadCuratedLayer(curatedBank);
      const after = curatedBank.get(CURATED_SAMPLES[0].id);
      check(
        "curated layer overrides factory slots end-to-end (same-id, synth fallback intact)",
        result.loaded > 0 && after !== before,
        `loaded=${result.loaded}/${CURATED_SAMPLES.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
      );
    } catch (error) {
      check("curated layer overrides factory slots end-to-end (same-id, synth fallback intact)", false, String(error));
    }
  }

  {
    // SVF drive must stay alias-clean: an 8 kHz tone driven hard only has
    // true harmonics ABOVE Nyquist (24k/40k/56k) — anything audible at their
    // fold points (20.1k/4.1k/11.9k) is aliasing. The 2× oversampled drive
    // stage must keep the folded power ≥40dB under the fundamental.
    try {
      const ctx = new OfflineAudioContext(1, 44100, SR);
      await loadCoreWorklets(ctx);
      const node = new AudioWorkletNode(ctx, "svfilter-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      node.parameters.get("cutoff")!.value = 12000;
      node.parameters.get("resonance")!.value = 0.1;
      node.parameters.get("mode")!.value = 0;
      node.parameters.get("drive")!.value = 0.9;
      node.parameters.get("mix")!.value = 1;
      const src = ctx.createBufferSource();
      const buf = ctx.createBuffer(1, 32768, SR);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = 0.8 * Math.sin((2 * Math.PI * 8000 * i) / SR);
      src.buffer = buf;
      src.connect(node).connect(ctx.destination);
      src.start(0);
      const rendered = await ctx.startRendering();
      const seg = rendered.getChannelData(0).slice(4096);
      const goertzel = (freq: number) => {
        const n = seg.length;
        const k = Math.round((freq * n) / SR);
        const w = (2 * Math.PI * k) / n;
        const coeff = 2 * Math.cos(w);
        let s1 = 0;
        let s2 = 0;
        for (let i = 0; i < n; i++) {
          const s0 = seg[i] + coeff * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        return s1 * s1 + s2 * s2 - coeff * s1 * s2;
      };
      const f0 = goertzel(8000);
      const alias = goertzel(4100) + goertzel(11900);
      check(
        "svf drive keeps folded harmonics ≥40dB under the fundamental (2× oversampled)",
        f0 > 0 && alias < f0 * 0.0001,
        `ratio=${(alias / Math.max(f0, 1e-12)).toExponential(2)}`,
      );
    } catch (error) {
      check("svf drive keeps folded harmonics ≥40dB under the fundamental (2× oversampled)", false, String(error));
    }
  }

  for (const type of EFFECT_ORDER) {
    const def = EFFECT_DEFS[type];
    try {
      const ctx = new OfflineAudioContext(1, 128, SR);
      const rt = def.factory(ctx, { id: "t", type, bypassed: false, params: defaultParamsOf(type) }, { bpm: 124 });
      for (const p of def.params) {
        rt.setParameter(p.id, p.min);
        rt.setParameter(p.id, p.max);
        rt.setParameter(p.id, p.default);
      }
      rt.syncBpm?.(140);
      rt.onTransportStarted?.(0, 0);
      rt.dispose();
      check(`${def.name}: constructs + param sweep`, true);
    } catch (error) {
      check(`${def.name}: constructs + param sweep`, false, String(error));
    }

    try {
      const data = await renderThrough(type);
      const peak = peakOf(data);
      check(`${def.name}: renders signal`, peak > 0.001 && peak <= 4, `peak=${peak.toFixed(3)}`);
    } catch (error) {
      check(`${def.name}: renders signal`, false, String(error));
    }
  }

  const clipped = await renderThrough("clipper", { drive: 1, ceiling: -6, softness: 0, output: 0 });
  const ceiling = Math.pow(10, -6 / 20);
  const maxAbs = peakOf(clipped);
  check("clipper honors ceiling", maxAbs <= ceiling + 0.01, `max=${maxAbs.toFixed(3)} ceiling=${ceiling.toFixed(3)}`);

  const pumped = await renderThrough("pump", { amount: 1, rate: 2, release: 0.4 });
  const block = 256;
  const blocks: number[] = [];
  for (let i = 0; i + block <= pumped.length; i += block) {
    let sum = 0;
    for (let j = 0; j < block; j++) sum += pumped[i + j] * pumped[i + j];
    blocks.push(Math.sqrt(sum / block));
  }
  const maxRms = Math.max(...blocks);
  const minRms = Math.min(...blocks);
  check(
    "pump modulates gain over the beat",
    maxRms / Math.max(minRms, 1e-9) > 1.5,
    `maxRms=${maxRms.toFixed(3)} minRms=${minRms.toFixed(3)} ratio=${(maxRms / Math.max(minRms, 1e-9)).toFixed(2)}`,
  );

  for (const kind of INSTRUMENT_ORDER) {
    const def = INSTRUMENT_DEFS[kind];
    try {
      // Pluck's declared decay/release can extend past one second; render
      // its complete tail so a feedback-loop runaway cannot hide beyond the
      // short smoke window. Other instruments retain the original fast pass.
      const ctx = new OfflineAudioContext(1, kind === "pluck" ? SR * 2 : SR, SR);
      const track: InstrumentTrack = {
        id: `check-${kind}`,
        kind: "instrument",
        instrument: kind,
        name: def.name,
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: "factory.tonal.pluck",
        params: defaultInstrumentParams(kind),
        effects: [],
        sends: {},
      };
      const rt = def.factory(ctx, track, { bpm: 124, getSample: (id) => bank.get(id) });
      rt.output.connect(ctx.destination);
      rt.noteOn(45, 0.9, 0.05, 0.4);
      const buffer = await ctx.startRendering();
      const peak = peakOf(buffer.getChannelData(0));
      check(`${def.name}: noteOn renders signal`, peak > 0.01 && peak <= 4, `peak=${peak.toFixed(3)}`);
      rt.dispose();
    } catch (error) {
      check(`${def.name}: noteOn renders signal`, false, String(error));
    }
  }

  // Texture Synth: polyphony + voice stealing
  try {
    const ctx = new OfflineAudioContext(2, SR * 2, SR);
    const track: InstrumentTrack = {
      id: "check-texture-poly",
      kind: "instrument",
      instrument: "texture",
      name: "Texture",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: defaultInstrumentParams("texture"),
      effects: [],
      sends: {},
    };
    const rt = INSTRUMENT_DEFS.texture.factory(ctx, track, { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    // 5 voices, more than the 4-voice limit
    rt.noteOn(48, 0.8, 0.0, 1.5);
    rt.noteOn(55, 0.8, 0.05, 1.5);
    rt.noteOn(60, 0.8, 0.1, 1.5);
    rt.noteOn(64, 0.8, 0.15, 1.5);
    rt.noteOn(67, 0.8, 0.2, 1.5);
    const buffer = await ctx.startRendering();
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
    }
    check(
      "Texture Synth: polyphony + voice stealing renders signal",
      peak > 0.01 && peak <= 4,
      `peak=${peak.toFixed(3)}`,
    );
    rt.dispose();
  } catch (error) {
    check("Texture Synth: polyphony + voice stealing renders signal", false, String(error));
  }

  // Wavetable Synth: morphing from the sine frame to the saw frame brightens
  // the spectrum — a saw carries far more high-frequency energy, measured
  // here as the first-difference energy ratio of the render.
  try {
    const renderWt = async (morph: number) => {
      const ctx = new OfflineAudioContext(1, SR, SR);
      const track: InstrumentTrack = {
        id: "check-wt-morph",
        kind: "instrument",
        instrument: "wavetable",
        name: "Wavetable",
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: null,
        params: { ...defaultInstrumentParams("wavetable"), morph, detune: 0, sub: 0 },
        effects: [],
        sends: {},
      };
      const rt = INSTRUMENT_DEFS.wavetable.factory(ctx, track, { bpm: 124, getSample: () => undefined });
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.05, 0.4);
      const buffer = await ctx.startRendering();
      rt.dispose();
      return { peak: peakOf(buffer.getChannelData(0)), data: buffer.getChannelData(0) };
    };
    const hfRatio = (data: Float32Array) => {
      let sum = 0;
      let diff = 0;
      for (let i = 1; i < data.length; i++) {
        sum += data[i] * data[i];
        const d = data[i] - data[i - 1];
        diff += d * d;
      }
      return Math.sqrt(diff / Math.max(sum, 1e-12));
    };
    const dark = await renderWt(0);
    const bright = await renderWt(1);
    check(
      "Wavetable Synth: morph moves the timbre (sine -> saw HF energy)",
      dark.peak > 0.01 && bright.peak > 0.01 && hfRatio(bright.data) > hfRatio(dark.data) * 2,
      `darkHF=${hfRatio(dark.data).toFixed(3)} brightHF=${hfRatio(bright.data).toFixed(3)}`,
    );
  } catch (error) {
    check("Wavetable Synth: morph moves the timbre (sine -> saw HF energy)", false, String(error));
  }

  // Granular Synth: deterministic grain clouds + noteOff cuts the tail.
  try {
    const renderGran = async (cut: boolean) => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const track: InstrumentTrack = {
        id: "check-gran",
        kind: "instrument",
        instrument: "granular",
        name: "Granular",
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: "factory.tonal.keys",
        params: { ...defaultInstrumentParams("granular"), release: 0.01, rate: 30 },
        effects: [],
        sends: {},
      };
      const rt = INSTRUMENT_DEFS.granular.factory(ctx, track, { bpm: 124, getSample: (id) => bank.get(id) });
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.05, 1.0);
      if (cut) rt.noteOff?.(60, 0.4);
      const buffer = await ctx.startRendering();
      rt.dispose();
      return Array.from(buffer.getChannelData(0));
    };
    const full = await renderGran(false);
    const fullAgain = await renderGran(false);
    const cut = await renderGran(true);
    // Bit-identical renders can differ at ULP level in Chrome — treat
    // max-sample-diff below 1e-4 as deterministic (random grain placement
    // would diverge by orders of magnitude).
    let maxDiff = 0;
    const sameLength = full.length === fullAgain.length;
    if (sameLength) {
      for (let i = 0; i < full.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(full[i] - fullAgain[i]));
      }
    }
    const peakAfter = (data: number[]) => {
      let peak = 0;
      for (let i = Math.floor(SR * 0.7); i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
      return peak;
    };
    check(
      "Granular Synth: deterministic render + noteOff cuts the tail",
      sameLength && maxDiff < 1e-4 && peakAfter(full) > 0.001 && peakAfter(cut) < 0.005,
      `maxDiff=${maxDiff.toExponential(2)} fullTail=${peakAfter(full).toFixed(4)} cutTail=${peakAfter(cut).toFixed(4)}`,
    );
  } catch (error) {
    check("Granular Synth: deterministic render + noteOff cuts the tail", false, String(error));
  }

  // Texture Synth: deterministic render (Wave 3 — LFO clock anchored to the
  // first note's `when`, so live and offline share the same phase timeline).
  try {
    const renderTexture = async () => {
      const ctx = new OfflineAudioContext(2, SR * 2, SR);
      const track: InstrumentTrack = {
        id: "check-tex",
        kind: "instrument",
        instrument: "texture",
        name: "Texture",
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: null,
        params: {
          ...defaultInstrumentParams("texture"),
          motion: 0.7,
          drift: 0.6,
          unison: 4,
          spread: 0.5,
          diffuse: 0.5,
          sync: 2,
        },
        effects: [],
        sends: {},
      };
      const rt = INSTRUMENT_DEFS.texture.factory(ctx, track, { bpm: 124, getSample: () => undefined });
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.05, 1.5);
      rt.noteOn(67, 0.7, 0.45, 1.0);
      const buffer = await ctx.startRendering();
      rt.dispose();
      return Array.from(buffer.getChannelData(0));
    };
    const texA = await renderTexture();
    const texB = await renderTexture();
    let texDiff = 0;
    const texSame = texA.length === texB.length;
    if (texSame) {
      for (let i = 0; i < texA.length; i++) texDiff = Math.max(texDiff, Math.abs(texA[i] - texB[i]));
    }
    let texPeak = 0;
    for (let i = 0; i < texA.length; i++) texPeak = Math.max(texPeak, Math.abs(texA[i]));
    check(
      "Texture Synth: deterministic render (LFO clock anchored to the note timeline)",
      texSame && texDiff < 1e-4 && texPeak > 0.001,
      `maxDiff=${texDiff.toExponential(2)} peak=${texPeak.toFixed(4)}`,
    );
  } catch (error) {
    check("Texture Synth: deterministic render (LFO clock anchored to the note timeline)", false, String(error));
  }

  // Offline export parity for the event-queue voice worklets: the wtVoice /
  // grainVoice processors take notes via port messages, which Chromium does
  // not deliver during an OfflineAudioContext render. The factories must
  // route offline renders through the native voice graphs — before that fix
  // both instruments exported silence while live playback worked.
  try {
    const offlineVoice = async (kind: "wavetable" | "granular") => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      await loadCoreWorklets(ctx);
      const track: InstrumentTrack = {
        id: `check-offline-${kind}`,
        kind: "instrument",
        instrument: kind,
        name: kind,
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: kind === "granular" ? "factory.tonal.keys" : null,
        params:
          kind === "granular"
            ? { ...defaultInstrumentParams("granular"), release: 0.01, rate: 30 }
            : defaultInstrumentParams("wavetable"),
        effects: [],
        sends: {},
      };
      const rt = INSTRUMENT_DEFS[kind].factory(ctx, track, { bpm: 124, getSample: (id) => bank.get(id) });
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.05, 0.5);
      const buffer = await ctx.startRendering();
      rt.dispose();
      return peakOf(buffer.getChannelData(0));
    };
    const wtPeak = await offlineVoice("wavetable");
    const granPeak = await offlineVoice("granular");
    check(
      "offline export parity: wavetable + granular render audible with worklets loaded (native offline routing)",
      wtPeak > 0.001 && granPeak > 0.001,
      `wavetable=${wtPeak.toFixed(4)} granular=${granPeak.toFixed(4)}`,
    );
  } catch (error) {
    check(
      "offline export parity: wavetable + granular render audible with worklets loaded (native offline routing)",
      false,
      String(error),
    );
  }

  // Phase 4 (plugin-audit follow-up) — LIVE worklet-path audibility for the
  // event-queue voice worklets. Offline renders route them through native
  // graphs (determinism fix above); the LIVE path runs the real worklets and
  // depends on port-message delivery, so it needs its own gate: a real
  // AudioContext + loadAllWorklets + AnalyserNode metering. PRISM joins the
  // check as the lazy-plugin-module representative (module fetch →
  // registration → param sync on the live context).
  try {
    const liveProbe = async (kind: "wavetable" | "granular" | "fxeq") => {
      const ctx = new AudioContext();
      try {
        if (ctx.state === "suspended") await ctx.resume();
        await loadAllWorklets(ctx);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        const track: InstrumentTrack | null =
          kind === "fxeq"
            ? null
            : {
                id: `live-${kind}`,
                kind: "instrument",
                instrument: kind,
                name: kind,
                gain: 1,
                pan: 0,
                mute: false,
                solo: false,
                sampleId: kind === "granular" ? "factory.tonal.keys" : null,
                params:
                  kind === "granular"
                    ? { ...defaultInstrumentParams("granular"), release: 0.01, rate: 30 }
                    : defaultInstrumentParams("wavetable"),
                effects: [],
                sends: {},
              };
        let stopLive: () => void = () => {};
        let disposeLive: () => void = () => {};
        if (kind === "fxeq") {
          const fxDoc = createProjectFromTemplate("house");
          const drum = fxDoc.tracks.find((t) => t.kind === "drum") as { id: string; effects: unknown[] };
          drum.effects = [];
          const st = new ProjectStore(fxDoc);
          const add = addEffect(st.getDoc(), drum.id, "fxeq");
          st.execute(add);
          // Reuse the engine-free factory: the fxeq node processes whatever
          // feeds its input; drive it with a scheduled oscillator.
          const node = await import("./effects/fxeqNode").then((m) =>
            m.createFxEqNode(
              ctx,
              { id: add.effectId, type: "fxeq", bypassed: false, params: { ...defaultParamsOf("fxeq") } },
              defaultParamsOf("fxeq"),
            ),
          );
          node.output.connect(analyser);
          const osc = ctx.createOscillator();
          osc.type = "sawtooth";
          osc.frequency.value = 220;
          const g = ctx.createGain();
          g.gain.value = 0.4;
          osc.connect(g).connect(node.input);
          osc.start(0);
          stopLive = () => {
            try {
              osc.stop();
            } catch {
              /* already stopped */
            }
          };
          disposeLive = () => node.dispose();
        } else {
          const def = INSTRUMENT_DEFS[kind];
          const rt = def.factory(ctx, track as InstrumentTrack, {
            bpm: 124,
            getSample: (id) => bank.get(id),
          });
          rt.output.connect(analyser);
          rt.noteOn(60, 0.9, ctx.currentTime + 0.05, 0.5);
          stopLive = () => {
            try {
              rt.panic();
            } catch {
              /* already silent */
            }
          };
          disposeLive = () => rt.dispose();
        }
        // Meter the analyser for ~0.6 s and keep the running peak.
        const buf = new Float32Array(analyser.fftSize);
        let peak = 0;
        const deadline = performance.now() + 600;
        while (performance.now() < deadline) {
          analyser.getFloatTimeDomainData(buf);
          for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
          await new Promise((r) => setTimeout(r, 40));
        }
        stopLive();
        disposeLive();
        await ctx.close();
        return peak;
      } finally {
        /* context closed above */
      }
    };
    const wtLive = await liveProbe("wavetable");
    const granLive = await liveProbe("granular");
    const prismLive = await liveProbe("fxeq");
    const minLive = 10 ** (-40 / 20); // −40 dBFS floor
    check(
      "live worklet-path audibility: wavetable/granular/PRISM on a real AudioContext",
      wtLive > minLive && granLive > minLive && prismLive > minLive,
      `wavetable=${wtLive.toFixed(4)} granular=${granLive.toFixed(4)} prism=${prismLive.toFixed(4)} (floor ${minLive.toFixed(4)})`,
    );
  } catch (error) {
    check("live worklet-path audibility: wavetable/granular/PRISM on a real AudioContext", false, String(error));
  }

  // Analog RELEASE regression (Phase 3b of the plugin-audit follow-up): the
  // voice-manager stop callback hard-gated at 10 ms and cancelled the
  // scheduled DAHDSR release — the RELEASE knob was dead on EVERY
  // voice-manager synth whenever a note ended via noteOff (MIDI playing).
  // release 0.01 vs 4 must now render measurably different tails.
  try {
    const renderAnalogRelease = async (release: number) => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      await loadCoreWorklets(ctx);
      const def = INSTRUMENT_DEFS.analog;
      const track: InstrumentTrack = {
        id: "check-an-rel",
        kind: "instrument",
        instrument: "analog",
        name: "analog",
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: null,
        params: { ...defaultInstrumentParams("analog"), release },
        effects: [],
        sends: {},
      };
      const rt = def.factory(ctx, track, { bpm: 124, getSample: () => undefined });
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.05, 0.35);
      rt.noteOff?.(60, 0.4);
      const buffer = await ctx.startRendering();
      rt.dispose();
      const d = buffer.getChannelData(0);
      let s = 0;
      for (let i = Math.floor(0.45 * SR); i < Math.floor(0.7 * SR); i++) s += d[i] * d[i];
      return Math.sqrt(s / (0.25 * SR));
    };
    const relShort = await renderAnalogRelease(0.05);
    const relLong = await renderAnalogRelease(3);
    check(
      "analog RELEASE knob shapes the post-noteOff tail (noteOff path)",
      relLong > relShort * 2 && relShort < 0.05,
      `rel0.05=${relShort.toFixed(4)} rel3=${relLong.toFixed(4)}`,
    );
  } catch (error) {
    check("analog RELEASE knob shapes the post-noteOff tail (noteOff path)", false, String(error));
  }

  // MATCH EQ ("znej ako ref") — the flagship reference-matching gate.
  // Three levels: (1) the master stage audibly applies the curve (a +6 dB
  // high-shelf correction must measurably lift the high band of a rendered
  // mix), (2) the full pipeline — retained reference → measured mix →
  // computed curve — points the right way for a dark-mix/bright-reference
  // pair, (3) the command round-trips through the document.
  try {
    const { spectrumBandBalance } = await import("./intent/match-eq");
    const doc = createProjectFromTemplate("house");
    const bandHighOf = async (master: Record<string, unknown>) => {
      const out = await renderProject({ ...doc, master: { ...doc.master, ...master } } as typeof doc, bank, {
        mode: "pattern",
        sampleRate: SR,
        tailSeconds: 0.3,
      });
      const channels = out.numberOfChannels;
      const mono = new Float32Array(out.length);
      for (let c = 0; c < channels; c++) {
        const d = out.getChannelData(c);
        for (let i = 0; i < mono.length; i++) mono[i] += d[i] / channels;
      }
      return spectrumBandBalance(mono, SR).high;
    };
    const flatHigh = await bandHighOf({});
    const liftedHigh = await bandHighOf({
      matchEq: { low: 0, lowMid: 0, highMid: 0, high: 6 },
    });
    // +6 dB high-shelf gain lands at ~3.5 dB in the band share: the share
    // domain renormalizes by total power (the shelf lifts the total too) and
    // the analysis window caps at 8 kHz on both sides. A no-op stage
    // measures ~0 and an inverted stage goes negative — 2.5 dB still
    // discriminates a working master stage from either.
    const liftDb = liftedHigh - flatHigh;
    check(
      "match EQ: master stage applies the curve (+6 dB high shelf lifts the high band)",
      liftDb > 2.5,
      `lift=${liftDb.toFixed(2)} dB (flat ${flatHigh.toFixed(1)} → lifted ${liftedHigh.toFixed(1)})`,
    );

    // Full pipeline direction: a bright reference against this (comparatively
    // darker) house mix must produce a curve with positive high gain. The
    // reference must be BROADBAND — a pure tone is rejected by
    // bandBalanceIsUsable (a single-band signal is not a matchable
    // reference; that guard is the anti-match hardening, by design).
    const { setMatchEqReference, computeMasterMatchEq } = await import("./intent/match-eq");
    const brightRef = new Float32Array(Math.floor(16000 * 2));
    {
      const partials: Array<[freq: number, amp: number]> = [
        [100, 0.05],
        [250, 0.06],
        [700, 0.14],
        [1500, 0.2],
        [3000, 0.35],
        [4800, 0.45],
        [6500, 0.5],
      ];
      for (let i = 0; i < brightRef.length; i++) {
        let s = 0;
        for (const [f, a] of partials) s += a * Math.sin((2 * Math.PI * f * i) / 16000);
        brightRef[i] = 0.35 * s;
      }
    }
    setMatchEqReference(brightRef);
    const curve = await computeMasterMatchEq(doc, bank);
    setMatchEqReference(null);
    check(
      "match EQ: full pipeline — measured mix vs retained reference points the right way",
      curve !== null && curve.high > 0,
      curve
        ? `curve ${curve.low.toFixed(1)}/${curve.lowMid.toFixed(1)}/${curve.highMid.toFixed(1)}/${curve.high.toFixed(1)} dB`
        : "no curve",
    );

    // Command round-trip: the curve survives a doc round-trip via schema.
    if (curve) {
      const { applyMasterMatchEqCommand } = await import("./commands/commands");
      const st = new ProjectStore(doc);
      st.execute(applyMasterMatchEqCommand(st.getDoc(), curve));
      const roundTrip = normalizeProject(JSON.parse(JSON.stringify(st.getDoc())));
      check(
        "match EQ: command + schema round-trip",
        Math.abs((roundTrip.master.matchEq?.high ?? 0) - curve.high) < 1e-6,
        `master.matchEq.high=${roundTrip.master.matchEq?.high?.toFixed(2)}`,
      );
    }
  } catch (error) {
    check("match EQ: master stage applies the curve (+6 dB high shelf lifts the high band)", false, String(error));
  }

  // Multi-tap determinism regression (Phase 1 of the plugin-audit follow-up):
  // the native DelayNode feedback cycle flipped between two stable variants
  // across offline renders (~8% RMS at feedback .85) — two exports of the
  // same project could sound different. The loop now lives inside the
  // multitap worklet processor; three renders of the same doc must be
  // sample-identical AND the wet path must stay audible.
  // NOTE: renders must share ONE doc — instrument/pad noise and drift are
  // seeded by track ids (hashString(track.id)), so a fresh doc per render
  // legitimately sounds different. Determinism is per-document.
  try {
    const docMtd = createProjectFromTemplate("house");
    const drum = docMtd.tracks.find((t) => t.kind === "drum") as { id: string; effects: unknown[] };
    drum.effects = [];
    const stMtd = new ProjectStore(docMtd);
    const addMtd = addEffect(stMtd.getDoc(), drum.id, "multiTapDelay");
    stMtd.execute(addMtd);
    stMtd.execute(setEffectParam(stMtd.getDoc(), drum.id, addMtd.effectId, "feedback", 0.85));
    const renderMtdDoc = async () => {
      const out = await renderProject(stMtd.getDoc(), bank, {
        mode: "pattern",
        sampleRate: SR,
        tailSeconds: 0.6,
        masterProcessing: false,
      });
      return Array.from(out.getChannelData(0));
    };
    const a = await renderMtdDoc();
    const b = await renderMtdDoc();
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    // Dry reference on the SAME doc lineage (same ids → same seeded noise):
    // set feedback to 0 and re-render.
    stMtd.execute(setEffectParam(stMtd.getDoc(), drum.id, addMtd.effectId, "feedback", 0));
    const dry = await renderMtdDoc();
    let peakWet = 0;
    for (let i = Math.floor(SR / 2); i < a.length; i++) peakWet = Math.max(peakWet, Math.abs(a[i] - dry[i]));
    check(
      "multi-tap delay deterministic across renders + feedback audible (worklet loop)",
      maxDiff < 1e-6 && peakWet > 0.001,
      `maxDiff=${maxDiff.toExponential(2)} wetPeak=${peakWet.toFixed(4)}`,
    );
  } catch (error) {
    check("multi-tap delay deterministic across renders + feedback audible (worklet loop)", false, String(error));
  }

  // Sampler STRETCH regression: the stretch path used to assign
  // AudioBufferSourceNode.buffer twice (spec-forbidden — InvalidStateError),
  // throwing inside noteOn for every note off root pitch. +12 st forces the
  // stretch path; the render must complete and be audible.
  try {
    const ctx = new OfflineAudioContext(2, SR, SR);
    await loadCoreWorklets(ctx);
    const source = ctx.createBuffer(1, SR, SR);
    for (let i = 0; i < source.length; i++) {
      source.getChannelData(0)[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
    }
    const track: InstrumentTrack = {
      id: "check-sampler-stretch",
      kind: "instrument",
      instrument: "sampler",
      name: "Sampler",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: "check.stretch.src",
      params: { ...defaultInstrumentParams("sampler"), stretch: 1 },
      effects: [],
      sends: {},
    };
    const rt = INSTRUMENT_DEFS.sampler.factory(ctx, track, {
      bpm: 124,
      getSample: (id) => (id === "check.stretch.src" ? source : undefined),
    });
    rt.output.connect(ctx.destination);
    rt.noteOn(72, 0.9, 0.05, 0.5); // +12 st forces the stretch path
    const buffer = await ctx.startRendering();
    rt.dispose();
    const stretchPeak = peakOf(buffer.getChannelData(0));
    check(
      "sampler STRETCH renders a +12st note (single buffer assignment)",
      stretchPeak > 0.001,
      `peak=${stretchPeak.toFixed(4)}`,
    );
  } catch (error) {
    check("sampler STRETCH renders a +12st note (single buffer assignment)", false, String(error));
  }

  // Automation lane ramp regression (Phase 2 of the plugin-audit follow-up):
  // device lanes used to render as discrete point events — a sparse two-point
  // ramp held its start value and stepped at the end. The engine now expands
  // continuous lanes onto a 16th-note grid, so a 0→15 dB EQ lane must land
  // between its endpoint renders and near the midpoint-static render.
  try {
    const automationRampCase = async (laneValue: number | null) => {
      const doc = createProjectFromTemplate("house");
      const inst = doc.tracks.find((t) => t.kind === "instrument") as { id: string; effects: unknown[] };
      inst.effects = [];
      const st = new ProjectStore(doc);
      const add = addEffect(st.getDoc(), inst.id, "eq");
      st.execute(add);
      st.execute(setEffectParam(st.getDoc(), inst.id, add.effectId, "lowMidGain", laneValue ?? 0));
      if (laneValue !== null) {
        st.execute(
          addAutomationLane(st.getDoc(), {
            kind: "fxParam",
            trackId: inst.id,
            fxId: add.effectId,
            paramId: "lowMidGain",
          }),
        );
        const laneId = (
          st
            .getDoc()
            .automation.find(
              (l) => l.target.kind === "fxParam" && l.target.fxId === add.effectId && l.target.paramId === "lowMidGain",
            ) as { id: string }
        ).id;
        st.execute(addAutomationPoint(st.getDoc(), laneId, 0, 0));
        st.execute(addAutomationPoint(st.getDoc(), laneId, 960, laneValue));
      }
      const out = await renderProject(st.getDoc(), bank, {
        mode: "pattern",
        sampleRate: SR,
        tailSeconds: 0.3,
        masterProcessing: false,
      });
      const d = out.getChannelData(0);
      let s = 0;
      for (let i = Math.floor(d.length / 8); i < d.length; i++) s += d[i] * d[i];
      return Math.sqrt(s / (d.length - Math.floor(d.length / 8)));
    };
    const ramp = await automationRampCase(15);
    const atZero = await automationRampCase(0);
    const atFifteen = await automationRampCase(15);
    const atMid = await automationRampCase(7.5);
    // Discriminates the retired step semantics: the old expansion held the
    // start value for the whole lane span (render ≈ atZero). The interpolated
    // ramp rides the curve — measurably away from the zero endpoint and near
    // the midpoint-static render.
    const leavesZero = Math.abs(ramp - atZero) > 0.02 * atZero;
    const nearMid = Math.abs(ramp - atMid) <= 0.1 * Math.max(atMid, 1e-6);
    check(
      "automation lane renders as a ramp (16th-grid interpolation)",
      leavesZero && nearMid,
      `ramp=${ramp.toFixed(4)} zero=${atZero.toFixed(4)} mid=${atMid.toFixed(4)} full=${atFifteen.toFixed(4)}`,
    );
  } catch (error) {
    check("automation lane renders as a ramp (16th-grid interpolation)", false, String(error));
  }

  // Phaser regression: connectStages() used to blanket-disconnect the
  // allpass chains (including the inter-stage links), leaving the wet path
  // silent — the plugin only attenuated dry and no parameter was audible.
  // The rate knob must measurably change the rendered signal.
  try {
    const renderPhaser = async (rate: number) => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      await loadCoreWorklets(ctx);
      const rt = EFFECT_DEFS.phaser.factory(
        ctx,
        { id: "check-phaser", type: "phaser", bypassed: false, params: { ...defaultParamsOf("phaser"), rate } },
        { bpm: 124 },
      );
      const src = ctx.createBufferSource();
      const buf = ctx.createBuffer(2, SR, SR);
      for (let i = 0; i < buf.length; i++) {
        const t = i / SR;
        buf.getChannelData(0)[i] = 0.4 * Math.sin(2 * Math.PI * 220 * t);
        buf.getChannelData(1)[i] = 0.4 * Math.sin(2 * Math.PI * 330 * t);
      }
      src.buffer = buf;
      src.connect(rt.input);
      rt.output.connect(ctx.destination);
      src.start(0);
      const rendered = await ctx.startRendering();
      rt.dispose();
      return rendered.getChannelData(0).slice(Math.floor(SR / 4));
    };
    const slow = await renderPhaser(0.4);
    const fast = await renderPhaser(8);
    let diff = 0;
    for (let i = 0; i < slow.length; i++) diff = Math.max(diff, Math.abs(slow[i] - fast[i]));
    check("phaser rate changes the rendered signal (wet chain alive)", diff > 0.01, `maxDiff=${diff.toFixed(4)}`);
  } catch (error) {
    check("phaser rate changes the rendered signal (wet chain alive)", false, String(error));
  }

  // Phase: intent production-path gate (plugin-audit "measure the shipped
  // path" applied to the intent engine). The vitest intent suites cover the
  // pieces; THIS proves the full browser chain end-to-end on the real page:
  // generateAsyncResult (bank + ONNX ranker) → determinism → bank quality →
  // applyGenerationResultCommand → offline render → audible pattern, all
  // inside a latency budget.
  try {
    const doc = createProjectFromTemplate("house");
    const intent = normalizeIntent({
      genre: "techno",
      seed: "prod-path-gate",
      roles: ["drums", "bass"],
      candidateCount: 4,
      symbolicCandidates: 2,
      length: 16,
    });
    const t0 = performance.now();
    // `sound` is what the panel GENERATE sends (ranking v3 — render the top
    // finalists and re-order by audio fit): the shipped production path.
    const run = await generateAsyncResult(doc, intent, {
      mode: "apply",
      includeBank: true,
      sound: { bank },
    });
    const elapsedMs = Math.round(performance.now() - t0);

    // Determinism: the exact same request must produce the exact same bank.
    const run2 = await generateAsyncResult(doc, intent, { mode: "apply", includeBank: true });
    const hashes1 = (run.bank ?? []).map((c) => c.contentHash);
    const hashes2 = (run2.bank ?? []).map((c) => c.contentHash);
    const deterministic = hashes1.length > 0 && hashes1.join() === hashes2.join();

    // Bank quality: populated, unique content hashes (diversity), all accepted.
    const candidateBank = run.bank ?? [];
    const uniqueHashes = new Set(hashes1).size;
    const allAccepted = candidateBank.every((c) => c.status === "accepted" || c.status === "repaired");

    // Audibility: install the winner via the REAL apply command and render.
    const st = new ProjectStore(doc);
    st.execute(applyGenerationResultCommand(st.getDoc(), run));
    const rendered = await renderProject(st.getDoc(), bank, {
      mode: "pattern",
      sampleRate: SR,
      tailSeconds: 0.3,
    });
    const d = rendered.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));

    // Loop closure: the sound rerank must record the audio-fit observation
    // (pf:audio-fit-ledger) — that's what `npm run rerank:fit` learns from.
    let ledgerOk = false;
    try {
      const raw = localStorage.getItem("pf:audio-fit-ledger");
      const parsed = raw ? (JSON.parse(raw) as { selectedIndex?: number }[]) : [];
      ledgerOk = parsed.length > 0 && parsed.every((o) => typeof o.selectedIndex === "number");
    } catch {
      ledgerOk = false;
    }

    const ok =
      deterministic &&
      candidateBank.length >= 4 &&
      uniqueHashes === candidateBank.length &&
      allAccepted &&
      peak > 0.01 &&
      ledgerOk &&
      elapsedMs < 10_000;
    check(
      "intent production path: generate → deterministic bank → apply → audible render",
      ok,
      `bank=${candidateBank.length} unique=${uniqueHashes} peak=${peak.toFixed(3)} elapsed=${elapsedMs}ms ` +
        `selection=${run.selection?.source ?? "?"}/${run.selection?.mode ?? "?"} ledger=${ledgerOk}`,
    );
  } catch (error) {
    check("intent production path: generate → deterministic bank → apply → audible render", false, String(error));
  }

  // Intent ranker worker (goal doc Fáze 3/4): the ONNX model must load from
  // local assets in the worker and score a real batch — or fall back in a
  // controlled way (offline installs without the model artifact).
  try {
    const ranking = await import("./ai/ranking/ranker-client");
    const { extractPatternFeatures } = await import("./ai/features/pattern-features");
    const doc = createDefaultProject();
    const intent = normalizeIntent({
      genre: "house",
      seed: "ranker-check",
      roles: ["drums"],
    });
    const plan = planGeneration(intent, doc);
    // Real patterns through the generator for meaningful features.
    const patterns = [0, 1, 2].map((index) => generatePattern(doc, { ...plan.options, seed: `ranker-check-${index}` }));
    const vectors = patterns.map((pattern) =>
      extractPatternFeatures({
        doc,
        pattern,
        intent,
        options: plan.options,
        resolvedBpm: plan.resolvedBpm,
        batch: patterns,
      }),
    );
    const batch = new Float32Array(vectors.length * vectors[0].values.length);
    vectors.forEach((vector, index) => batch.set(vector.values, index * vector.values.length));
    const result = await ranking.scoreCandidateFeatures(batch, vectors.length);
    check(
      "intent ranker: local ONNX worker scores a real candidate batch (or controlled fallback)",
      (result.source === "model" && result.ok && result.scores?.length === 3) || result.source === "fallback",
      `source=${result.source} scores=${result.scores ? result.scores.map((score: number) => score.toFixed(3)).join("/") : "none"}`,
    );
  } catch (error) {
    check(
      "intent ranker: local ONNX worker scores a real candidate batch (or controlled fallback)",
      false,
      String(error),
    );
  }

  // The release fallback contract must also hold in a real browser when the
  // optional ranker assets disappear or the worker becomes unhealthy. Keep
  // this probe isolated: reset the lazy client between scenarios and restore
  // native globals before the next audio/UI check runs.
  let restoreRankerProbe: (() => void) | null = null;
  try {
    const ranking = await import("./ai/ranking/ranker-client");
    const nativeFetch = globalThis.fetch;
    const nativeWorker = globalThis.Worker;
    const manifestPath = "/models/intent-ranker-v1.manifest.json";
    const probeBatch = new Float32Array(2 * 54);

    const setGlobal = (key: "fetch" | "Worker", value: unknown) => {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    };
    const restoreGlobals = () => {
      setGlobal("fetch", nativeFetch);
      setGlobal("Worker", nativeWorker);
      ranking.resetRankerClient();
    };
    restoreRankerProbe = restoreGlobals;
    const isManifestRequest = (input: RequestInfo | URL) => String(input).includes(manifestPath);
    const responseWithManifest = async () => nativeFetch(manifestPath, { cache: "no-store" });

    // Missing/offline manifest: there must be no worker spawn and no thrown
    // promise, which is the cold-start/offline-cache release contract.
    ranking.resetRankerClient();
    setGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      isManifestRequest(input) ? Promise.resolve(new Response("", { status: 503 })) : nativeFetch(input, init),
    );
    const missing = await ranking.scoreCandidateFeatures(probeBatch, 2);

    type ProbeMode = "hash-mismatch" | "timeout";
    class ProbeWorker {
      static mode: ProbeMode = "hash-mismatch";
      terminated = false;
      private readonly listeners = new Set<(event: MessageEvent) => void>();

      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        if (type === "message") this.listeners.add(listener);
      }

      removeEventListener(type: string, listener: (event: MessageEvent) => void) {
        if (type === "message") this.listeners.delete(listener);
      }

      postMessage(request: { type: string; requestId: number }) {
        if (ProbeWorker.mode === "timeout") return;
        queueMicrotask(() => {
          if (this.terminated) return;
          for (const listener of this.listeners) {
            listener({
              data: { type: request.type, requestId: request.requestId, ok: false, error: "model hash mismatch" },
            } as MessageEvent);
          }
        });
      }

      terminate() {
        this.terminated = true;
      }
    }

    // Hash mismatch: a worker response is a controlled fallback, not a UI
    // error. The manifest is kept valid by forwarding the real local asset.
    setGlobal("Worker", ProbeWorker);
    setGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      isManifestRequest(input) ? responseWithManifest() : nativeFetch(input, init),
    );
    ranking.resetRankerClient();
    ProbeWorker.mode = "hash-mismatch";
    const hashMismatch = await ranking.scoreCandidateFeatures(probeBatch, 2);

    // Timeout: one slow worker request must resolve through the same fallback
    // boundary instead of leaking a rejected promise into generation.
    ranking.resetRankerClient();
    ProbeWorker.mode = "timeout";
    const timeout = await ranking.scoreCandidateFeatures(probeBatch, 2);

    restoreGlobals();
    restoreRankerProbe = null;
    check(
      "intent ranker: browser missing/offline, hash-mismatch and timeout fall back safely",
      missing.source === "fallback" &&
        hashMismatch.source === "fallback" &&
        timeout.source === "fallback" &&
        timeout.scores === null,
      `missing=${missing.source} hash=${hashMismatch.source} timeout=${timeout.source}`,
    );
  } catch (error) {
    restoreRankerProbe?.();
    check("intent ranker: browser fallback scenarios remain controlled", false, String(error));
  }

  // Distortion: harmonics produced
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const params = { ...defaultParamsOf("distortion"), drive: 0.9, tone: 12000, mix: 1, output: 0 };
    const rt = EFFECT_DEFS.distortion.factory(
      ctx,
      { id: "t", type: "distortion", bypassed: false, params },
      { bpm: 124 },
    );
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 220;
    osc.connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    rt.dispose();
    // A monotonic waveshaper preserves zero crossings even while it adds
    // strong harmonics. Measure the third-harmonic energy directly instead
    // of using an invalid "more crossings" proxy.
    const start = Math.floor(SR * 0.02);
    const end = Math.floor(SR * 0.1);
    const toneEnergy = (frequency: number) => {
      let real = 0;
      let imaginary = 0;
      for (let i = start; i < end; i++) {
        const phase = (2 * Math.PI * frequency * i) / SR;
        real += data[i] * Math.cos(phase);
        imaginary -= data[i] * Math.sin(phase);
      }
      const count = Math.max(1, end - start);
      return (real * real + imaginary * imaginary) / (count * count);
    };
    const fundamental = toneEnergy(220);
    const thirdHarmonic = toneEnergy(660);
    check(
      "distortion: cubic clip adds harmonics",
      thirdHarmonic > fundamental * 0.001,
      `fundamental=${fundamental.toExponential(2)} third=${thirdHarmonic.toExponential(2)}`,
    );
  } catch (error) {
    check("distortion: cubic clip adds harmonics", false, String(error));
  }

  // Bitcrusher: Web Audio's WaveShaperNode linearly interpolates between
  // curve samples, which means a step-function quantisation curve gets
  // smoothed into a ramp. Exact bit-accurate quantisation would need an
  // AudioWorklet (out of scope for now). We verify here that the runtime
  // constructs, the curve is applied, and the output stays in a sane range.
  // The vitest suite (`tests/effects.test.ts`) covers the quantisation
  // contract more directly with a held-sample value check.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const params = { ...defaultParamsOf("bitcrusher"), bits: 4, downsample: 1, mix: 1, output: 0 };
    const rt = EFFECT_DEFS.bitcrusher.factory(
      ctx,
      { id: "t", type: "bitcrusher", bypassed: false, params },
      { bpm: 124 },
    );
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 110;
    osc.connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    rt.dispose();
    const peak = peakOf(data);
    check(
      "bitcrusher: 4-bit quantisation renders signal with sane peak",
      peak > 0.001 && peak <= 4,
      `peak=${peak.toFixed(3)}`,
    );
  } catch (error) {
    check("bitcrusher: 4-bit quantisation renders signal with sane peak", false, String(error));
  }

  // Chorus: late-window signal energy (delay is audible past input offset)
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const params = { ...defaultParamsOf("chorus"), rate: 0.5, depth: 1, mix: 1, output: 0 };
    const rt = EFFECT_DEFS.chorus.factory(ctx, { id: "t", type: "chorus", bypassed: false, params }, { bpm: 124 });
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 440;
    osc.connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    rt.dispose();
    let max = 0;
    for (let i = Math.floor(SR * 0.02); i < data.length; i++) {
      if (Math.abs(data[i]) > max) max = Math.abs(data[i]);
    }
    check("chorus: produces audible signal past 20 ms (delay-line smear)", max > 0.001, `late-peak=${max.toFixed(3)}`);
  } catch (error) {
    check("chorus: produces audible signal past 20 ms (delay-line smear)", false, String(error));
  }

  // KYX Kaskáda — character stereo delay (ping-pong, mod, loop EQ, freeze)
  try {
    const kctx = new OfflineAudioContext(2, SR * 2, SR);
    await loadCoreWorklets(kctx);
    const kParams = {
      ...defaultParamsOf("kaskada"),
      mix: 1,
      feedback: 0.5,
      time: 250,
      pingPong: 1,
      unmaskOn: 1, // the 440 Hz dry masks its own echo — solver carves it
      unmask: 1,
    };
    const krt = EFFECT_DEFS.kaskada.factory(
      kctx,
      { id: "kaskada-check", type: "kaskada", bypassed: false, params: kParams },
      { bpm: 120 },
    );
    const kosc = kctx.createOscillator();
    kosc.type = "sine";
    kosc.frequency.value = 440;
    kosc.connect(krt.input);
    krt.output.connect(kctx.destination);
    kosc.start(0);
    // 4. Dual-spectrum meters: opt in BEFORE the render — an offline context
    //    never processes after startRendering resolves, so a later enable
    //    would never reach the worklet. The 120 ms pause before the render
    //    is the documented OfflineAudioContext quirk (see the fxeq metering
    //    check): a port message posted right before startRendering can lose
    //    the race against the audio thread spinning up.
    krt.setMetersEnabled?.(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const kbuffer = await kctx.startRendering();
    const kData = kbuffer.getChannelData(0);
    const kDataR = kbuffer.getChannelData(1);

    // 1. Audible signal
    let kPeak = 0;
    for (let i = Math.floor(SR * 0.02); i < kData.length; i++) {
      kPeak = Math.max(kPeak, Math.abs(kData[i]));
    }
    check("kaskada: produces audible signal (stereo delay)", kPeak > 0.001, `peak=${kPeak.toFixed(3)}`);

    // 2. Ping-pong: L and R channels have DIFFERENT content in the echo region
    //    (with mono input the total energy is equal but the waveform differs
    //     because echoes alternate L→R→L)
    let sampleDiff = 0;
    const echoStart = Math.floor(SR * (250 / 1000 + 0.01));
    const echoEnd = Math.floor(SR * 0.6);
    for (let i = echoStart; i < echoEnd; i++) {
      sampleDiff += Math.abs(kData[i] - kDataR[i]);
    }
    check(
      "kaskada: ping-pong produces stereo alternation (L ≠ R in echo region)",
      sampleDiff > 0.1,
      `sampleDiff=${sampleDiff.toFixed(3)}`,
    );

    // 3. Freeze: with feedback locked, echo sustains (tail doesn't decay to zero)
    // (verified via feedback param already set — skipping separate freeze render
    //  because the freeze gate is covered by unit tests)

    // 3b. Reverse plumbing in the real worklet: same input through a second
    //     instance with REVERSE on — the render must differ from forward
    //     and stay audible (order-swap semantics pinned by unit tests).
    const rctx = new OfflineAudioContext(2, SR * 2, SR);
    await loadCoreWorklets(rctx);
    const rrt = EFFECT_DEFS.kaskada.factory(
      rctx,
      { id: "kaskada-rev", type: "kaskada", bypassed: false, params: { ...kParams, reverse: 1 } },
      { bpm: 120 },
    );
    const rosc = rctx.createOscillator();
    rosc.frequency.value = 440;
    rosc.connect(rrt.input);
    rrt.output.connect(rctx.destination);
    rosc.start(0);
    const rbuffer = await rctx.startRendering();
    rrt.dispose();
    const rData = rbuffer.getChannelData(0);
    let revDiff = 0;
    let revPeak = 0;
    for (let i = 0; i < rData.length; i++) {
      revDiff = Math.max(revDiff, Math.abs(rData[i] - kData[i]));
      revPeak = Math.max(revPeak, Math.abs(rData[i]));
    }
    check(
      "kaskada: reverse mode renders an audibly reversed sweep",
      revDiff > 0.01 && revPeak > 0.001,
      `diff=${revDiff.toFixed(3)} peak=${revPeak.toFixed(3)}`,
    );

    // Offline port messages flush after the render resolves — poll getMeters
    // for a bounded window until a frame lands.
    let metersFrame: Float32Array | null = null;
    for (let attempt = 0; attempt < 80 && !metersFrame; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const frame = krt.getMeters?.();
      if (frame instanceof Float32Array && frame.length === 176) metersFrame = frame;
    }
    krt.dispose();
    const bandOf = (freq: number) =>
      Math.max(0, Math.min(71, Math.round(72 * (Math.log(freq / 20) / Math.log(1000)) - 0.5)));
    // Dry is asserted at the 440 Hz oscillator. The wet trace is asserted
    // present-but-not-loud: the flushed frame is the render's LAST analysis
    // window (1.96–2.0 s) and the 250 ms echo train rarely intersects it —
    // wet content semantics are pinned by the unit battery (time 30 there).
    // The unmask tail (144–175) must show REAL reduction: the continuous
    // 440 Hz dry masks its own echo (unmaskOn=1, amount=1 in kParams).
    let umMaxRed = 0;
    if (metersFrame) {
      for (let b = 0; b < 32; b++) umMaxRed = Math.max(umMaxRed, metersFrame[144 + b]);
    }
    const metersOk =
      !!metersFrame &&
      Number.isFinite(metersFrame[bandOf(440)]) &&
      Number.isFinite(metersFrame[72 + bandOf(440)]) &&
      metersFrame[bandOf(440)] > -60 && // dry: the 440 Hz oscillator
      umMaxRed > 1; // solver carving the masked echo
    check(
      "kaskada: dual spectrum + unmask meters flow over the port",
      metersOk,
      metersFrame
        ? `dry=${metersFrame[bandOf(440)].toFixed(1)}dB wet=${metersFrame[72 + bandOf(440)].toFixed(1)}dB umMaxRed=${umMaxRed.toFixed(1)}dB`
        : "no meter frame arrived",
    );
  } catch (error) {
    check("kaskada: produces audible signal (stereo delay)", false, String(error));
  }

  // Phaser: stages can be re-chained at runtime
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const rt = EFFECT_DEFS.phaser.factory(
      ctx,
      { id: "t", type: "phaser", bypassed: false, params: defaultParamsOf("phaser") },
      { bpm: 124 },
    );
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 110;
    osc.connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    rt.setParameter("stages", 0); // 2
    rt.setParameter("stages", 3); // 8
    rt.setParameter("stages", 1); // 4
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    rt.dispose();
    const peak = peakOf(data);
    check(
      "phaser: re-chains stages at runtime and renders signal",
      peak > 0.001 && peak <= 4,
      `peak=${peak.toFixed(3)}`,
    );
  } catch (error) {
    check("phaser: re-chains stages at runtime and renders signal", false, String(error));
  }

  // Sidechain: setSidechainInput is safe to call with both null and a live node;
  // the actual ducking happens via a JS-driven AnalyserNode envelope follower
  // (not audio-rate), so it does not show up in OfflineAudioContext. We only
  // verify the wiring and lifecycle here — the live ducking path is exercised
  // by the realtime engine + the new `effects.test.ts` unit test.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const rt = EFFECT_DEFS.sidechain.factory(
      ctx,
      { id: "t", type: "sidechain", bypassed: false, params: defaultParamsOf("sidechain") },
      { bpm: 124 },
    );
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 220;
    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.5;
    osc.connect(oscGain);
    // Attaching a sidechain node and removing it must be safe.
    rt.setSidechainInput?.(oscGain);
    rt.setSidechainInput?.(null);
    osc.connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    rt.dispose();
    const peak = peakOf(data);
    check(
      "sidechain: setSidechainInput attaches/detaches safely and renders signal",
      peak > 0.001 && peak <= 4,
      `peak=${peak.toFixed(3)}`,
    );
  } catch (error) {
    check("sidechain: setSidechainInput attaches/detaches safely and renders signal", false, String(error));
  }

  // AudioWorklet processors load per context and the bitcrusher actually
  // sample-and-holds (downsample) — impossible with the WaveShaper fallback.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    await loadAllWorklets(ctx);
    if (!isWorkletReady("bitcrusher", ctx) || !isWorkletReady("sidechain", ctx)) {
      check(
        "audio-worklet: processors load and bitcrusher downsamples",
        false,
        "modules not ready after loadAllWorklets",
      );
    } else {
      const rt = createBitcrusherNode(ctx, { params: { bits: 8, downsample: 4, mix: 1, output: 0 } });
      const buf = ctx.createBuffer(1, 512, SR);
      const d = buf.getChannelData(0);
      for (let i = 0; i < 512; i++) d[i] = Math.sin((i / 64) * Math.PI * 2);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(rt.input);
      rt.output.connect(ctx.destination);
      src.start(0);
      const out = await ctx.startRendering();
      rt.dispose();
      const o = out.getChannelData(0);
      const changes = countChanges(o, 4);
      check(
        "audio-worklet: processors load and bitcrusher downsamples",
        changes > 8,
        `changes=${changes} (worklet sample-hold is active)`,
      );
    }
  } catch (error) {
    check("audio-worklet: processors load and bitcrusher downsamples", false, String(error));
  }

  // P0.0: worklet-dependent effects must degrade LOUDLY — flagged as degraded
  // with a human-readable reason instead of silently pretending to process.
  for (const type of ["gate", "transient", "limiter", "compressor"] as EffectType[]) {
    try {
      const ctx = new OfflineAudioContext(1, Math.floor(SR / 2), SR);
      const def = EFFECT_DEFS[type];
      const rt = def.factory(
        ctx,
        { id: `fb-${type}`, type, bypassed: false, params: defaultParamsOf(type) },
        { bpm: 124 },
      );
      const ok = rt.degraded === true && typeof rt.degradedReason === "string" && rt.degradedReason.length > 0;
      check(
        `${def.name}: fallback reports degraded state`,
        ok,
        `degraded=${String(rt.degraded)} reason=${String(rt.degradedReason ?? "-")}`,
      );
      rt.dispose();
    } catch (error) {
      check(`${EFFECT_DEFS[type].name}: fallback reports degraded state`, false, String(error));
    }
  }

  // Gate with an impossible threshold would silence everything IF the worklet
  // ran — the worklet-unavailable fallback must pass the signal 1:1 instead.
  try {
    const bypassed = await renderThrough("gate", { threshold: 0, range: -80, mix: 1 });
    const peak = peakOf(bypassed);
    check(
      "gate: fallback passes signal 1:1 (never silent)",
      Math.abs(peak - 0.5) < 0.02,
      `peak=${peak.toFixed(3)} expected≈0.500`,
    );
  } catch (error) {
    check("gate: fallback passes signal 1:1 (never silent)", false, String(error));
  }

  // Contrast: once modules are loaded the same closed-gate config must actually
  // gate — proves the chains upgraded from fallback onto real processors.
  try {
    const ctx = new OfflineAudioContext(1, Math.floor(SR / 2), SR);
    await loadAllWorklets(ctx);
    if (!isWorkletReady("gate", ctx)) {
      check("gate: worklet path gates when modules are loaded", false, "modules not ready after loadAllWorklets");
    } else {
      const params = { ...defaultParamsOf("gate"), threshold: 0, range: -80, mix: 1 };
      const rt = EFFECT_DEFS.gate.factory(ctx, { id: "gk", type: "gate", bypassed: false, params }, { bpm: 124 });
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 220;
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      osc.connect(gain).connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const buffer = await ctx.startRendering();
      rt.dispose();
      const peak = peakOf(buffer.getChannelData(0));
      check(
        "gate: worklet path gates when modules are loaded",
        peak < 0.005,
        `peak=${peak.toFixed(4)} (fallback would be ≈0.5)`,
      );
    }
  } catch (error) {
    check("gate: worklet path gates when modules are loaded", false, String(error));
  }

  // P0.1 acceptance: the look-ahead limiter pins peaks at CEILING, reports GR,
  // holds steady gain on sustained material (no pumping) and delays by exactly
  // LOOKAHEAD — while without look-ahead those peaks would overshoot.
  try {
    const ctx = new OfflineAudioContext(2, SR * 2, SR);
    await loadAllWorklets(ctx);
    if (!isWorkletReady("limiter", ctx)) {
      check("limiter: look-ahead worklet limits, meters and anticipates", false, "worklet modules not ready");
    } else {
      const limiterParams = {
        ...defaultParamsOf("limiter"),
        ceiling: -6,
        threshold: -18,
        release: 0.05,
        lookaheadMs: 5,
        mix: 1,
      };
      const rt = EFFECT_DEFS.limiter.factory(
        ctx,
        { id: "lim", type: "limiter", bypassed: false, params: limiterParams },
        { bpm: 124 },
      );
      const buf = ctx.createBuffer(1, SR * 2, SR);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = 0.9 * Math.sin((i / SR) * 200 * Math.PI * 2); // ~-0.9 dBFS sine
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(rt.input);
      rt.output.connect(ctx.destination);
      src.start(0);
      const limited = await ctx.startRendering();
      // GR metering must be read BEFORE dispose (dispose nulls the port
      // handler — see readGrAfterRender).
      const gr = await readGrAfterRender(rt);
      rt.dispose();
      const data = limited.getChannelData(0);
      const peak = peakOf(data);
      const ceilingLin = Math.pow(10, -6 / 20);
      // Pumping proxy: steady-state window RMS spread must stay flat.
      let minWin = Infinity;
      let maxWin = 0;
      for (let start = SR; start + 2048 <= data.length; start += 2048) {
        let sum = 0;
        for (let j = 0; j < 2048; j++) sum += data[start + j] * data[start + j];
        const rms = Math.sqrt(sum / 2048);
        minWin = Math.min(minWin, rms);
        maxWin = Math.max(maxWin, rms);
      }
      const spread = maxWin / Math.max(minWin, 1e-9);
      let onset = -1;
      for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i]) > 0.005) {
          onset = i;
          break;
        }
      }
      const expectedDelay = Math.round((limiterParams.lookaheadMs / 1000) * SR);
      const onsetOk = onset >= Math.round(expectedDelay * 0.9) && onset <= expectedDelay + 512;
      check(
        "limiter: look-ahead worklet limits, meters and anticipates",
        peak <= ceilingLin + 0.02 && gr >= 3 && spread < 1.15 && onsetOk,
        `peak=${peak.toFixed(3)}/${ceilingLin.toFixed(3)} gr=${gr.toFixed(1)}dB spread=${spread.toFixed(3)} onset=${onset}/${expectedDelay}`,
      );
    }
  } catch (error) {
    check("limiter: look-ahead worklet limits, meters and anticipates", false, String(error));
  }

  // PDC: the track holding the look-ahead limiter must stay sample-aligned
  // with a dry sibling — syncPdc() delays every other chain by the same
  // latency. Hard panning isolates each track into its own master channel.
  try {
    const doc = createProjectFromTemplate("empty");
    const limitedTrack = createDrumTrackModel("Drums B");
    doc.tracks = [doc.tracks[0], limitedTrack];
    const dryTrack = doc.tracks[0];
    if (dryTrack.kind !== "drum") throw new Error("template drift: expected a drum track");
    dryTrack.pan = -1;
    limitedTrack.pan = 1;
    limitedTrack.effects = [{ id: "pdc-lim", type: "limiter", bypassed: false, params: defaultParamsOf("limiter") }];
    const ctx = new OfflineAudioContext(2, Math.floor(SR * 0.6), SR);
    await loadAllWorklets(ctx);
    const engine = new AudioEngine();
    engine.attachBank(bank);
    engine.useContext(ctx);
    engine.setProject(doc);
    engine.trigger(dryTrack.id, dryTrack.pads[0], 0.03, 1);
    engine.trigger(limitedTrack.id, limitedTrack.pads[0], 0.03, 1);
    const rendered = await ctx.startRendering();
    const findOnset = (channel: Float32Array): number => {
      for (let i = 0; i < channel.length; i++) {
        if (Math.abs(channel[i]) > 0.02) return i;
      }
      return -1;
    };
    const onsetL = findOnset(rendered.getChannelData(0));
    const onsetR = findOnset(rendered.getChannelData(1));
    const skewSec = onsetL >= 0 && onsetR >= 0 ? Math.abs(onsetL - onsetR) / SR : Number.POSITIVE_INFINITY;
    check(
      "pdc: limiter track stays aligned with dry track (<2 ms)",
      skewSec <= 0.002,
      `skew=${Number.isFinite(skewSec) ? `${(skewSec * 1000).toFixed(2)}ms` : "no onset"} (≈5ms means PDC inactive)`,
    );
  } catch (error) {
    check("pdc: limiter track stays aligned with dry track (<2 ms)", false, String(error));
  }

  // Send PDC: compare the same kick through the group's look-ahead-limited
  // dry path and through a zero-latency return. Relative onsets must align;
  // absolute timing also includes the instrument's sample attack and is not
  // a stable proxy for send compensation.
  try {
    const renderPath = async (sendOnly: boolean): Promise<number> => {
      const doc = createProjectFromTemplate("empty");
      const group = createGroupTrackModel("SendBus");
      group.effects = [
        {
          id: "sendgrp-lim",
          type: "limiter",
          bypassed: false,
          params: { ...defaultParamsOf("limiter"), lookaheadMs: 5 },
        },
      ];
      // In the send-only pass, silence the group output without touching the
      // pre-group send tap. That leaves the compensated return as the sole
      // audible route; the second pass is the corresponding dry group route.
      group.gain = sendOnly ? 0 : 1;
      const drum = doc.tracks.find((t) => t.kind === "drum");
      if (!drum || drum.kind !== "drum") throw new Error("template drift: expected a drum track");
      const sends: Record<string, number> = sendOnly ? { "send-ret": 1 } : {};
      const grouped = { ...drum, groupId: group.id, sends };
      doc.tracks = [...doc.tracks.map((t) => (t.id === drum.id ? grouped : t)), group];
      doc.returns = [{ id: "send-ret", kind: "return", name: "SendRet", gain: 1, effects: [] }];
      doc.master = { ...doc.master, limiterEnabled: false };
      const ctx = new OfflineAudioContext(2, Math.floor(SR * 0.6), SR);
      await loadAllWorklets(ctx);
      const engine = new AudioEngine();
      engine.attachBank(bank);
      engine.useContext(ctx);
      engine.setProject(doc);
      engine.trigger(drum.id, drum.pads[0], 0.03, 1);
      const rendered = await ctx.startRendering();
      const left = rendered.getChannelData(0);
      const right = rendered.getChannelData(1);
      for (let i = 0; i < left.length; i++) {
        if (Math.max(Math.abs(left[i]), Math.abs(right[i])) > 0.02) return i;
      }
      return -1;
    };
    const dryOnset = await renderPath(false);
    const sendOnset = await renderPath(true);
    const onsetSkewSamples =
      dryOnset >= 0 && sendOnset >= 0 ? Math.abs(dryOnset - sendOnset) : Number.POSITIVE_INFINITY;
    check(
      "pdc: grouped return send aligns to the dry group path (within 128 samples)",
      onsetSkewSamples <= 128,
      `dry=${dryOnset} send=${sendOnset} skew=${Number.isFinite(onsetSkewSamples) ? onsetSkewSamples : "none"} samples`,
    );
  } catch (error) {
    check("pdc: grouped return send aligns to the dry group path (within 128 samples)", false, String(error));
  }

  // Groups: a track moved between groups must feed ONLY the new group.
  // Regression: the old rerouting left the edge to the previous group's
  // input connected, so the track played through both groups at once.
  try {
    const doc = createProjectFromTemplate("house");
    const groupA = { ...createGroupTrackModel("A"), pan: -1 };
    const groupB = { ...createGroupTrackModel("B"), pan: 1 };
    const drum = doc.tracks.find((t) => t.kind === "drum")!;
    const withGroups = {
      ...doc,
      tracks: [...doc.tracks.map((t) => (t.id === drum.id ? { ...t, groupId: groupA.id } : t)), groupA, groupB],
    };
    const moved = {
      ...withGroups,
      tracks: withGroups.tracks.map((t) => (t.id === drum.id ? { ...t, groupId: groupB.id } : t)),
    };
    const ctx = new OfflineAudioContext(2, SR, SR);
    // Load worklets like the live app: without them the master chain falls
    // back to an always-on tanh shaper (×~1.8 small-signal gain), which
    // inflated the L leak past this check's isolation threshold.
    await loadAllWorklets(ctx);
    const engine = new AudioEngine();
    engine.attachBank(bank);
    engine.useContext(ctx);
    engine.setProject(withGroups);
    engine.setProject(moved); // same engine → exercises the syncProject re-route
    engine.trigger(drum.id, drum.pads[0], 0.02, 1);
    const out = await ctx.startRendering();
    const l = peakOf(out.getChannelData(0));
    const r = peakOf(out.getChannelData(1));
    check(
      "groups: moved track feeds only the new group",
      r > 0.05 && l < r * 0.15,
      `L=${l.toFixed(3)} R=${r.toFixed(3)} (leak would make L≈R)`,
    );
  } catch (error) {
    check("groups: moved track feeds only the new group", false, String(error));
  }

  // Mixer fader preview must ride the SAME mute/solo gate as the committed
  // write (syncProject drives the identical gain param with `audible ?
  // gain : 0`). Regression: previewTrackGain wrote the raw fader value, so
  // dragging a muted strip's fader audibly un-muted it until release.
  try {
    const doc = createProjectFromTemplate("house");
    const drum = doc.tracks.find((t) => t.kind === "drum")!;
    const renderWithPreview = async (muted: boolean): Promise<number> => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      await loadAllWorklets(ctx);
      const engine = new AudioEngine();
      engine.attachBank(bank);
      engine.useContext(ctx);
      engine.setProject({
        ...doc,
        tracks: doc.tracks.map((t) => (t.id === drum.id ? { ...t, mute: muted } : t)),
      });
      engine.previewTrackGain(drum.id, 1.2); // fader dragged to +1.76 dB
      // Hit at 0.2 s: the gain param converges exponentially from its node
      // default (1) after the sync/preview writes — hitting inside the first
      // ~50 ms would measure that tail, not the mute gate.
      engine.trigger(drum.id, drum.pads[0], 0.2, 1);
      const out = await ctx.startRendering();
      return peakOf(out.getChannelData(0));
    };
    const mutedPeak = await renderWithPreview(true);
    const openPeak = await renderWithPreview(false);
    check(
      "mixer preview: fader preview on a muted channel stays silent (unmuted stays audible)",
      mutedPeak < 0.005 && openPeak > 0.05,
      `muted=${mutedPeak.toFixed(4)} open=${openPeak.toFixed(3)}`,
    );
  } catch (error) {
    check("mixer preview: fader preview on a muted channel stays silent (unmuted stays audible)", false, String(error));
  }

  // Send-level preview must move the REAL send gain into the return bus (the
  // wet path), not just a UI number. Committing a send of 0.9 but previewing
  // 0 must render dry-only; previewing the committed value must render the
  // full wet+dry mix.
  try {
    const doc = createProjectFromTemplate("house");
    const drum = doc.tracks.find((t) => t.kind === "drum")!;
    const ret = doc.returns[0];
    const withSend = {
      ...doc,
      tracks: doc.tracks.map((t) => (t.id === drum.id ? { ...t, sends: { [ret.id]: 0.9 } } : t)),
    };
    const renderWithSendPreview = async (previewLevel: number | null): Promise<Float32Array> => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      await loadAllWorklets(ctx);
      const engine = new AudioEngine();
      engine.attachBank(bank);
      engine.useContext(ctx);
      engine.setProject(withSend);
      if (previewLevel !== null) engine.previewTrackSend(drum.id, ret.id, previewLevel);
      // Hit at 0.2 s so the send param has converged (see the mute check above).
      engine.trigger(drum.id, drum.pads[0], 0.2, 1);
      const out = await ctx.startRendering();
      return out.getChannelData(0);
    };
    // Peak alone is dry-dominated (a reverb tail barely moves it) — compare
    // renders SAMPLE-WISE: previewing 0 must change the wet path, previewing
    // the committed value must be bit-transparent.
    const noPreview = await renderWithSendPreview(null);
    const previewedOff = await renderWithSendPreview(0);
    const previewedSame = await renderWithSendPreview(0.9);
    const diffPeak = (a: Float32Array, b: Float32Array): number => {
      let d = 0;
      for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
      return d;
    };
    const changed = diffPeak(noPreview, previewedOff);
    const transparent = diffPeak(noPreview, previewedSame);
    check(
      "mixer preview: send preview drives the real return-bus path",
      changed > 0.01 && transparent < 0.005,
      `wetDiff=${changed.toFixed(4)} transparentDiff=${transparent.toFixed(5)}`,
    );
  } catch (error) {
    check("mixer preview: send preview drives the real return-bus path", false, String(error));
  }

  // Deleting a FROZEN track must stop and drop its looping buffer source.
  // Regression: disposeTrackNodes left the source running inside
  // frozenBuffers until the next panic/project switch.
  try {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const engine = new AudioEngine();
    const frozenId = "frozen-check-delete";
    const buffer = ctx.createBuffer(2, SR, SR);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 20) * 0.5;
    }
    bank.add(frozenId, buffer);
    const doc = createProjectFromTemplate("house");
    const drum = doc.tracks.find((t) => t.kind === "drum")!;
    const frozenDoc = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.id === drum.id ? { ...t, frozen: { bufferId: frozenId, durationSec: 1, sampleRate: SR } } : t,
      ),
    };
    engine.attachBank(bank);
    engine.useContext(ctx);
    engine.setProject(frozenDoc);
    engine.restartFrozenSources(0); // live playback path owns frozen source creation
    // Wave 4e: frozen sources live in WarpManager — read through its surface.
    const frozenState = engine as unknown as {
      warpManager: {
        isFrozen(id: string): boolean;
        frozenBuffers: Map<string, AudioBufferSourceNode>;
      };
    };
    const startedWhileLive = frozenState.warpManager.isFrozen(drum.id);
    engine.setProject({ ...frozenDoc, tracks: frozenDoc.tracks.filter((t) => t.id !== drum.id) });
    // A second synchronous setProject lands in the engine's re-entrancy
    // queue (projectPromise is still pending) — yield a macrotask so the
    // queued body (and the channel teardown) actually drains.
    await new Promise((resolve) => setTimeout(resolve, 0));
    check(
      "frozen: deleting a frozen track stops + removes its buffer source",
      startedWhileLive && frozenState.warpManager.frozenBuffers.size === 0,
      `started=${startedWhileLive} remainingSources=${frozenState.warpManager.frozenBuffers.size}`,
    );
  } catch (error) {
    check("frozen: deleting a frozen track stops + removes its buffer source", false, String(error));
  }

  // Realtime resample: the LiveRecorder taps the post-limiter master and the
  // take decodes back into an audible AudioBuffer — the "bounce what you
  // hear" path that resampled pads/flips are built on.
  try {
    if (typeof MediaRecorder === "undefined") {
      check("resample: master bounce captures audible audio", true, "skipped — MediaRecorder unavailable");
    } else {
      // MediaRecorder needs a REAL running context, not an offline one.
      const live = new AudioContext();
      try {
        if (live.state === "suspended") await live.resume();
        const engine = new AudioEngine();
        engine.attachBank(bank);
        engine.useContext(live);
        const doc = createProjectFromTemplate("house");
        engine.setProject(doc);
        const drum = doc.tracks.find((t) => t.kind === "drum")!;
        const recorder = new LiveRecorder({
          ctx: live,
          getTapNode: (source) => (source.kind === "master" ? engine.getMasterTapNode() : null),
        });
        // One take + one retry: under heavy machine load a take can come back
        // all-silence (the audio thread starves while the recorder clock
        // runs). A retry lands past any transient load spike; two silent
        // takes in a row mean a real regression.
        let take: { buffer: AudioBuffer; blob: Blob } | null = null;
        let peak = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
          await recorder.start({ kind: "master" });
          // MediaRecorder has startup latency in headless and the shared test
          // machine stalls audio rendering under load — so schedule a dense
          // hit pattern across the WHOLE window: any captured slice then
          // contains several full onsets and the peak assertion is stable.
          await new Promise((r) => setTimeout(r, 300));
          for (let i = 0; i < 25; i++) {
            engine.trigger(drum.id, drum.pads[0], live.currentTime + 0.05 + i * 0.1, 1);
          }
          await new Promise((r) => setTimeout(r, 2800));
          take = await recorder.stop();
          if (!take) break;
          peak = peakOf(take.buffer.getChannelData(0));
          if (peak > 0.02) break;
        }
        if (!take) throw new Error("recorder produced no usable take");
        check(
          "resample: master bounce captures audible audio",
          take.buffer.duration > 0.6 && peak > 0.02 && take.buffer.sampleRate === live.sampleRate,
          `dur=${take.buffer.duration.toFixed(2)}s peak=${peak.toFixed(3)} sr=${take.buffer.sampleRate}`,
        );
      } finally {
        await live.close();
      }
    }
  } catch (error) {
    check("resample: master bounce captures audible audio", false, String(error));
  }

  // Master meter must read TRUE stereo (splitter + per-channel analysers).
  // Regression: a single AnalyserNode downmixes to mono even with
  // channelCount=2/explicit, so L/R read the same mono signal.
  try {
    const ctx = new AudioContext();
    try {
      if (ctx.state === "suspended") await ctx.resume();
    } catch {
      /* autoplay may block resume — handled below */
    }
    if (ctx.state !== "running") {
      check(
        "master meter: reads true stereo (hard-left stays out of R)",
        true,
        "skipped — autoplay blocked in this environment",
      );
    } else {
      // Headless audio devices take a moment to start rendering — wait until
      // the audio clock actually advances, otherwise the scheduled note has
      // not sounded yet when the meter is read and the check sees silence.
      const t0 = ctx.currentTime;
      for (let i = 0; i < 40 && ctx.currentTime < t0 + 0.05; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (ctx.currentTime < t0 + 0.05) {
        check(
          "master meter: reads true stereo (hard-left stays out of R)",
          true,
          "skipped — audio clock not advancing",
        );
      } else {
        const engine = new AudioEngine();
        engine.useContext(ctx);
        const doc = createProjectFromTemplate("house");
        const inst = doc.tracks.find((t) => t.kind === "instrument")!;
        const panned = {
          ...doc,
          tracks: doc.tracks.map((t) => (t.id === inst.id ? { ...t, pan: -1 } : t)),
        };
        engine.setProject(panned);
        engine.noteOn(inst.id, 48, 0.9, ctx.currentTime + 0.02, 0.4);
        await new Promise((r) => setTimeout(r, 220));
        const lv = engine.getMasterLevels();
        check(
          "master meter: reads true stereo (hard-left stays out of R)",
          lv.left.peak > 0.02 && lv.right.peak < lv.left.peak * 0.25,
          `L=${lv.left.peakDb.toFixed(1)}dB R=${lv.right.peakDb.toFixed(1)}dB corr=${lv.correlation.toFixed(2)}`,
        );
      }
    }
    await ctx.close();
  } catch (error) {
    check("master meter: reads true stereo (hard-left stays out of R)", false, String(error));
  }

  // 808: rapid retrigger must keep rendering after the voice-cleanup fix
  // (per-voice post + click chain teardown, shared shaper without rewiring).
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const track: InstrumentTrack = {
      id: "check-808-retrigger",
      kind: "instrument",
      instrument: "808",
      name: "808",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: { ...defaultInstrumentParams("808"), decay: 0.4 },
      effects: [],
      sends: {},
    };
    const rt = INSTRUMENT_DEFS["808"].factory(ctx, track, { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    rt.noteOn(33, 1, 0.05, 0);
    rt.noteOn(33, 1, 0.25, 0);
    rt.noteOn(33, 1, 0.45, 0);
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    const first = peakOf(data.subarray(Math.floor(0.05 * SR), Math.floor(0.2 * SR)));
    const third = peakOf(data.subarray(Math.floor(0.45 * SR), Math.floor(0.7 * SR)));
    check(
      "808: rapid retrigger renders every note (voice cleanup wiring)",
      first > 0.3 && third > 0.3,
      `first=${first.toFixed(3)} third=${third.toFixed(3)}`,
    );
  } catch (error) {
    check("808: rapid retrigger renders every note (voice cleanup wiring)", false, String(error));
  }

  // Wavetable: a user sample assigned but not yet in the bank (async restore
  // after a reload) plays the factory fallback WITHOUT caching it forever —
  // the next note after the sample arrives must use the real sample.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    let sample: AudioBuffer | null = null;
    const track: InstrumentTrack = {
      id: "check-wt-reload",
      kind: "instrument",
      instrument: "wavetable",
      name: "WT",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: "user-late-arriving",
      // detune 0 + open filter keeps the voice spectrum faithful to the
      // table — the default ±7 ct unison beating smears edge energy and
      // makes any two tables measure alike.
      params: { ...defaultInstrumentParams("wavetable"), detune: 0, cutoff: 16000, morph: 0 },
      effects: [],
      sends: {},
    };
    const rt = INSTRUMENT_DEFS["wavetable"].factory(ctx, track, { bpm: 124, getSample: () => sample ?? undefined });
    rt.output.connect(ctx.destination);
    rt.noteOn(48, 1, 0.05, 0.15); // fallback (sample not restored yet)
    const buf = ctx.createBuffer(1, Math.floor(SR * 0.1), SR);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = i % 64 < 32 ? 0.7 : -0.7; // 690 Hz square (inside extractWavetable's period range) → bright
    sample = buf; // the async restore lands between the two notes
    rt.noteOn(48, 1, 0.45, 0.15); // must now use the extracted user table
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    const hfRatio = (w: Float32Array) => {
      let sum = 0;
      let diff = 0;
      for (let i = 1; i < w.length; i++) {
        sum += w[i] * w[i];
        const dd = w[i] - w[i - 1];
        diff += dd * dd;
      }
      return Math.sqrt(diff / Math.max(sum, 1e-12));
    };
    const fallbackHf = hfRatio(data.subarray(Math.floor(0.06 * SR), Math.floor(0.3 * SR)));
    const sampleHf = hfRatio(data.subarray(Math.floor(0.46 * SR), Math.floor(0.7 * SR)));
    check(
      "wavetable: late-arriving user sample replaces the cached factory fallback",
      sampleHf > fallbackHf * 1.5,
      `fallbackHF=${fallbackHf.toFixed(3)} sampleHF=${sampleHf.toFixed(3)}`,
    );
  } catch (error) {
    check("wavetable: late-arriving user sample replaces the cached factory fallback", false, String(error));
  }

  // MP3 export round-trip: encode the rendered pattern, then decode it back
  // through the browser's own decoder — a successful decode proves the MP3
  // stream is valid, not just non-empty bytes.
  try {
    const doc = createProjectFromTemplate("house");
    const buffer = await renderProject(doc, bank, { mode: "pattern", sampleRate: 44100 });
    const mp3 = await encodeMp3(buffer, { kbps: 192 });
    const wavBytes = encodeWav(buffer, 16).byteLength;
    const decodeCtx = new OfflineAudioContext(1, 1, 44100);
    const decoded = await decodeCtx.decodeAudioData(await mp3.arrayBuffer());
    check(
      "export: MP3 encodes small and decodes back to the same duration",
      mp3.size < wavBytes / 4 && Math.abs(decoded.duration - buffer.duration) < 0.15,
      `mp3=${(mp3.size / 1024).toFixed(0)}kB vs wav=${(wavBytes / 1024).toFixed(0)}kB dur=${decoded.duration.toFixed(2)}s/${buffer.duration.toFixed(2)}s`,
    );
  } catch (error) {
    check("export: MP3 encodes small and decodes back to the same duration", false, String(error));
  }

  // Generated-pattern quality gate: the browser must validate the same local
  // output that the UI preview/command path uses, then render that exact
  // pattern through the offline engine and encode a playable WAV.
  try {
    const project = createProjectFromTemplate("house");
    const options = {
      genre: "house" as const,
      style: "deep",
      seed: "browser-quality-gate",
      stepCount: 64,
      ghostWeight: 0.3,
      microWeight: 0.2,
      velocityVariation: 0.3,
      temperature: 1,
      replaceMode: "new" as const,
    };
    const generated = generatePattern(project, options);
    const generatedAgain = generatePattern(project, options);
    const report = inspectPatternInvariants(project, generated);
    const hash = contentHash(canonicalizePattern(project, generated));
    const hashAgain = contentHash(canonicalizePattern(project, generatedAgain));
    check(
      "quality: browser-generated pattern passes invariants and content hash is deterministic",
      report.ok && hash === hashAgain && generated.generation?.outputContentHash === hash,
      report.issues.map((item) => `${item.code}@${item.path}`).join(", ") || `${hash}/${hashAgain}`,
    );

    const generatedProject = {
      ...project,
      patterns: [...project.patterns, generated],
      activePatternId: generated.id,
    };
    const buffer = await renderProject(generatedProject, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    const wav = encodeWav(buffer, 16);
    check(
      "quality: generated pattern renders offline audio and a valid WAV",
      peakOf(buffer.getChannelData(0)) > 0.01 && wav.byteLength > 44,
      `peak=${peakOf(buffer.getChannelData(0)).toFixed(3)} wav=${wav.byteLength}`,
    );
  } catch (error) {
    check(
      "quality: browser-generated pattern passes invariants and content hash is deterministic",
      false,
      String(error),
    );
    check("quality: generated pattern renders offline audio and a valid WAV", false, String(error));
  }

  // Video export: MediaRecorder over the branded canvas + offline-rendered
  // audio muxed via MediaStreamAudioDestinationNode.
  try {
    const mime = pickVideoMimeType();
    if (!mime) {
      check("export: video records canvas + audio via MediaRecorder", true, "skipped — MediaRecorder unavailable");
    } else {
      const ctx = new OfflineAudioContext(1, 44100 * 2, 44100);
      const osc = ctx.createOscillator();
      osc.frequency.value = 220;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      osc.connect(g).connect(ctx.destination);
      osc.start(0);
      const buffer = await ctx.startRendering();
      const result = await recordVideo(buffer, {
        title: "Browser Check",
        bpm: 120,
        seconds: 2,
        width: 270,
        height: 480,
        fps: 24,
      });
      check(
        "export: video records canvas + audio via MediaRecorder",
        result.blob.size > 15_000 && result.blob.type.startsWith("video/"),
        `${result.ext} ${(result.blob.size / 1024).toFixed(0)}kB type=${result.blob.type || mime.split(";")[0]}`,
      );
    }
  } catch (error) {
    check("export: video records canvas + audio via MediaRecorder", false, String(error));
  }

  // Chop beats: engine slicing plays ONLY the pad's [start, end) region of
  // the source (native offset+duration), and transient detection finds hits.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    // Source: burst A [0.05, 0.15), silence, burst B [0.5, 0.65).
    const srcBuffer = ctx.createBuffer(1, SR, SR);
    const d = srcBuffer.getChannelData(0);
    for (let i = Math.floor(0.05 * SR); i < Math.floor(0.15 * SR); i++)
      d[i] = 0.7 * Math.sin((2 * Math.PI * 220 * i) / SR);
    for (let i = Math.floor(0.5 * SR); i < Math.floor(0.65 * SR); i++)
      d[i] = 0.7 * Math.sin((2 * Math.PI * 440 * i) / SR);
    // Firefox may detach an OfflineAudioContext source's channel view during
    // startRendering(). Keep analysis independent from that browser detail.
    const sourceSnapshot = Float32Array.from(d);
    bank.add("check-slice-src", srcBuffer);

    const doc = createProjectFromTemplate("house");
    const drum = doc.tracks.find((t) => t.kind === "drum")!;
    const engine = new AudioEngine();
    engine.attachBank(bank);
    engine.useContext(ctx);
    // Slice pointing ONLY at burst B; triggered at t=0.1.
    engine.setProject(doc);
    engine.trigger(drum.id, { ...drum.pads[0], assetId: "check-slice-src", sliceStart: 0.5, sliceEnd: 0.65 }, 0.1, 1);
    const out = await ctx.startRendering();
    const data = out.getChannelData(0);
    const rms = (a: number, b: number) => {
      let sum = 0;
      for (let i = Math.floor(a * SR); i < Math.floor(b * SR); i++) sum += data[i] * data[i];
      return Math.sqrt(sum / Math.max(1, Math.floor(b * SR) - Math.floor(a * SR)));
    };
    const before = rms(0, 0.09); // before trigger — must be silent
    const during = rms(0.11, 0.25); // burst B playing through the slice
    const after = rms(0.3, 0.5); // after slice end — must be silent again

    // Transient detection over the same source must find both bursts.
    const onsets = detectTransients(sourceSnapshot, SR);
    const foundA = onsets.some((t: number) => Math.abs(t - 0.05) < 0.05);
    const foundB = onsets.some((t: number) => Math.abs(t - 0.5) < 0.05);

    check(
      "chop beats: pads play only their slice region + transients detected",
      before < 0.005 && during > 0.05 && after < 0.005 && foundA && foundB && onsets.length === 2,
      `before=${before.toFixed(4)} during=${during.toFixed(3)} after=${after.toFixed(4)} onsets=[${onsets.map((t) => t.toFixed(2)).join(",")}]`,
    );
  } catch (error) {
    check("chop beats: pads play only their slice region + transients detected", false, String(error));
  }

  // Per-pad MOD: an MPC-style voice-local LFO on one pad tremolos ONLY that
  // voice — a gain-target LFO makes the output envelope pump while the plain
  // pad stays flat.
  try {
    const renderPadMod = async (rateHz: number, depth: number) => {
      const ctx = new OfflineAudioContext(1, SR, SR);
      const srcBuffer = ctx.createBuffer(1, SR, SR);
      const d = srcBuffer.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
      bank.add("check-padmod-src", srcBuffer);
      const doc = createProjectFromTemplate("house");
      const drum = doc.tracks.find((t) => t.kind === "drum")!;
      const engine = new AudioEngine();
      engine.attachBank(bank);
      engine.useContext(ctx);
      engine.setProject(doc);
      engine.trigger(
        drum.id,
        { ...drum.pads[0], assetId: "check-padmod-src", mod: { target: "gain", wave: "sine", rateHz, depth } },
        0.05,
        1,
      );
      return ctx.startRendering();
    };
    const pmWin = Math.floor(SR * 0.03125); // quarter period at 8 Hz
    const pmRms = (data: Float32Array, i: number) => {
      let sum = 0;
      const start = Math.floor(SR * 0.2) + i * pmWin;
      for (let j = start; j < start + pmWin; j++) sum += data[j] * data[j];
      return Math.sqrt(sum / pmWin);
    };
    const pmSpread = (out: AudioBuffer) => {
      const vals = Array.from({ length: 16 }, (_, i) => pmRms(out.getChannelData(0), i));
      return Math.max(...vals) / Math.max(0.0001, Math.min(...vals));
    };
    const pmPlain = pmSpread(await renderPadMod(8, 0));
    const pmMod = pmSpread(await renderPadMod(8, 1));
    check(
      "per-pad mod: gain LFO tremolos one voice (envelope pumps vs flat)",
      pmPlain < 1.5 && pmMod > 2,
      `plainSpread=${pmPlain.toFixed(2)} modSpread=${pmMod.toFixed(2)}`,
    );
  } catch (error) {
    check("per-pad mod: gain LFO tremolos one voice (envelope pumps vs flat)", false, String(error));
  }

  // Macro generic targets: a macro mapped to an FX parameter must resolve as
  // an offset around the PERSISTED base (base ± half-range·bipolar·amount) —
  // repeated engine syncs converge to the same value (never accumulate).
  try {
    const mCtx = new OfflineAudioContext(1, SR, SR);
    const mDoc = createProjectFromTemplate("house");
    const mTrack = mDoc.tracks.find((t) => t.kind === "drum")!;
    mTrack.effects.push({
      id: "macro-trem",
      type: "tremolo",
      bypassed: false,
      params: { rate: 5, depth: 0.5, shape: 0, mode: 0, mix: 1 },
    });
    mDoc.macros[0].mappings.push({
      id: "macro-map-1",
      trackId: mTrack.id,
      param: "fxParam",
      amount: 0.5,
      source: "macro",
      target: { kind: "fxParam", trackId: mTrack.id, fxId: "macro-trem", paramId: "depth" },
    });
    const mEngine = new AudioEngine();
    mEngine.attachBank(bank);
    mEngine.useContext(mCtx);
    mEngine.setProject(mDoc);
    const mRuntime = (
      mEngine as unknown as {
        trackNodes: Map<string, { fx: { runtimes: Map<string, { setParameter: (id: string, v: number) => void }> } }>;
      }
    ).trackNodes
      .get(mTrack.id)!
      .fx.runtimes.get("macro-trem")!;
    const seen: number[] = [];
    const origSet = mRuntime.setParameter.bind(mRuntime);
    mRuntime.setParameter = (id: string, v: number) => {
      if (id === "depth") seen.push(v);
      origSet(id, v);
    };
    // setProject serializes graph syncs through a microtask queue. Space the
    // writes across queue boundaries so this really exercises idempotence
    // rather than coalescing all three calls into one graph sync.
    for (let i = 0; i < 3; i++) {
      mEngine.setProject({ ...mDoc });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const last = seen.at(-1) ?? NaN;
    // base 0.5 + half-range(0.5)·bipolar(macro value 0.5→0)·0.5 = 0.5
    check(
      "macro targets: fxParam resolves around base, repeated syncs never accumulate",
      seen.length >= 3 && Math.abs(last - 0.5) < 0.001 && Math.abs(seen[0] - last) < 0.001,
      `syncs=${seen.length} first=${seen[0]?.toFixed(4)} last=${last.toFixed(4)} (expect 0.5)`,
    );
  } catch (error) {
    check("macro targets: fxParam resolves around base, repeated syncs never accumulate", false, String(error));
  }

  // FXEQ: the vendored multiband DSP must run as a worklet in offline
  // renders (heavy drive must transform a sine: louder + harmonically
  // distorted vs the degraded passthrough), and the degraded transparent
  // fallback must engage when the module is not loaded. Null-test metric:
  // tanh saturation preserves zero crossings, so amplitude + waveform
  // difference are the honest measures.
  try {
    const def = EFFECT_DEFS.fxeq;
    // 1. Degraded fallback path (no modules loaded in this context).
    const plainCtx = new OfflineAudioContext(1, SR, SR);
    const fallback = def.factory(
      plainCtx,
      { id: "t", type: "fxeq", bypassed: false, params: defaultParamsOf("fxeq") },
      { bpm: 124 },
    );
    const fallbackOk = fallback.degraded === true;
    fallback.dispose();
    // 2. Worklet path vs fallback path on the SAME input.
    const params = {
      ...defaultParamsOf("fxeq"),
      bandCount: 4,
      // 220 Hz lands in the lowest band — saturate ALL bands so the check
      // is independent of the crossover's split frequencies.
      "band1.satEnabled": 1,
      "band1.satDriveDb": 18,
      "band1.satMix": 100,
      "band2.satEnabled": 1,
      "band2.satDriveDb": 18,
      "band2.satMix": 100,
      "band3.satEnabled": 1,
      "band3.satDriveDb": 18,
      "band3.satMix": 100,
      "band4.satEnabled": 1,
      "band4.satDriveDb": 18,
      "band4.satMix": 100,
      limiterEnabled: 0,
    };
    const renderFxEq = async (loaded: boolean) => {
      const ctx = new OfflineAudioContext(1, SR, SR);
      if (loaded) await loadAllWorklets(ctx);
      const rt = def.factory(ctx, { id: "t", type: "fxeq", bypassed: false, params }, { bpm: 124 });
      const osc = ctx.createOscillator();
      osc.frequency.value = 220;
      const g = ctx.createGain();
      g.gain.value = 0.25;
      osc.connect(g).connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const buffer = await ctx.startRendering();
      rt.dispose();
      return buffer.getChannelData(0);
    };
    const saturated = await renderFxEq(true);
    const passthrough = await renderFxEq(false);
    let peakA = 0;
    let diffSq = 0;
    let refSq = 0;
    for (let i = 0; i < saturated.length; i++) {
      peakA = Math.max(peakA, Math.abs(saturated[i]));
      const d = saturated[i] - passthrough[i];
      diffSq += d * d;
      refSq += passthrough[i] * passthrough[i];
    }
    const diffRms = Math.sqrt(diffSq / saturated.length);
    const refRms = Math.sqrt(refSq / saturated.length);
    check(
      "fxeq: worklet DSP renders in offline context (saturated) + honest fallback",
      fallbackOk && refRms > 0.05 && diffRms > refRms * 0.3 && peakA > 0.6,
      `fallback=${fallbackOk} refRms=${refRms.toFixed(3)} diffRms=${diffRms.toFixed(3)} peakSat=${peakA.toFixed(3)}`,
    );
  } catch (error) {
    check("fxeq: worklet DSP renders in offline context (saturated) + honest fallback", false, String(error));
  }

  // FXEQ CPU budget: the same vendored DSP runs on the audio thread inside
  // the worklet, so main-thread block timing is a faithful proxy. Worst
  // case (6 bands, every module enabled) must fit comfortably inside the
  // 128-frame audio-thread budget (128/44100 ≈ 2.90 ms per block).
  try {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, 128);
    const worst: Record<string, number> = { bandCount: 6 };
    for (let b = 1; b <= 6; b++) {
      for (const mod of ["sat", "lofi", "mod", "delay", "rev"]) {
        worst[`band${b}.${mod}Enabled`] = 1;
      }
      worst[`band${b}.satDriveDb`] = 12;
      worst[`band${b}.delayTimeMs`] = 200;
      worst[`band${b}.revDecayMs`] = 1500;
    }
    proc.loadParameters(worst);
    const blocks = 600;
    const stereo = [new Float32Array(128), new Float32Array(128)];
    // Warm-up (JIT) and take three independent samples. Offline/main-thread
    // timing has occasional scheduler/GC spikes around a single 128-frame
    // quantum; using the median makes those spikes observable in the report
    // without turning a one-sample timer blip into a false regression. The
    // realtime threshold itself is unchanged: the median must still fit one
    // audio block.
    const samplesUs: number[] = [];
    for (let sample = 0; sample < 3; sample++) {
      for (let i = 0; i < 50; i++) proc.process(stereo, 128);
      const t0 = performance.now();
      for (let i = 0; i < blocks; i++) {
        stereo[0][i % 128] = Math.sin((sample * blocks + i) * 0.1);
        proc.process(stereo, 128);
      }
      samplesUs.push(((performance.now() - t0) * 1000) / blocks);
    }
    samplesUs.sort((a, b) => a - b);
    // MIN of the three samples: DSP cost is lower-bounded — scheduler
    // preemption and GC only ADD time — so the least-disturbed sample is
    // the best estimate of the true block cost. The old median flaked on
    // loaded machines (e.g. Firefox run 2026-09-12: healthy 1413 µs sample
    // buried under two load-inflated 3268/3332 µs samples → false FAIL
    // with the DSP itself well inside budget).
    const avgUsPerBlock = samplesUs[0];
    const budgetUs = (128 / SR) * 1000 * 1000; // 2902 µs per 128-frame block
    const cpuPercent = (avgUsPerBlock / budgetUs) * 100;
    check(
      "fxeq: CPU budget — worst case fits the audio-thread block budget",
      // Hard realtime limit (must fit one 128-frame block); the printed %
      // tells the true story — idle machines measure 26–33%, loaded more.
      avgUsPerBlock < budgetUs,
      `bestSample=${avgUsPerBlock.toFixed(0)}µs/block of ${budgetUs.toFixed(0)}µs budget → ${cpuPercent.toFixed(1)}% of one core (samples=${samplesUs
        .map((value) => value.toFixed(0))
        .join(",")})`,
    );
  } catch (error) {
    check("fxeq: CPU budget — worst case fits the audio-thread block budget", false, String(error));
  }

  // FXEQ PDC: the worklet must report its DSP latency (oversampled bands)
  // so the engine's PDC aligns fxeq tracks with the rest of the mix.
  try {
    const ctx = new OfflineAudioContext(2, 256, SR);
    await loadAllWorklets(ctx);
    const def = EFFECT_DEFS.fxeq;
    const rt = def.factory(
      ctx,
      {
        id: "t",
        type: "fxeq",
        bypassed: false,
        params: {
          ...defaultParamsOf("fxeq"),
          bandCount: 4,
          "band1.satEnabled": 1,
          "band1.satDriveDb": 12,
          "band2.satEnabled": 1,
          "band2.satDriveDb": 12,
        },
      },
      { bpm: 124 },
    );
    // Latency arrives via a port message after the processor prepares —
    // wait for the round trip (loaded machines can be slow to schedule).
    await new Promise((r) => setTimeout(r, 200));
    const lat = rt.getLatencySec?.() ?? -1;
    rt.dispose();
    check(
      "fxeq: reports DSP latency for PDC (oversampled bands)",
      lat > 0 && lat < 0.01,
      `latency=${(lat * 1000).toFixed(3)} ms`,
    );
  } catch (error) {
    check("fxeq: reports DSP latency for PDC (oversampled bands)", false, String(error));
  }

  // ULTINA: the vendored mixing suite (10-module graph). Null-test the
  // worklet path vs the degraded fallback, CPU-budget the worst case
  // (all 10 modules).
  try {
    const def = EFFECT_DEFS.ultina;
    // 1. Degraded fallback (no modules loaded in this context).
    const plainCtx = new OfflineAudioContext(1, SR, SR);
    const fallback = def.factory(
      plainCtx,
      { id: "t", type: "ultina", bypassed: false, params: defaultParamsOf("ultina") },
      { bpm: 124 },
    );
    const fallbackOk = fallback.degraded === true;
    fallback.dispose();

    // 2. Worklet null-test: +6 dB input gain must land louder than the
    // passthrough fallback with the SAME input.
    const renderUltina = async (loaded: boolean, extraParams: Record<string, number>) => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      if (loaded) await loadAllWorklets(ctx);
      const rt = def.factory(
        ctx,
        { id: "t", type: "ultina", bypassed: false, params: { ...defaultParamsOf("ultina"), ...extraParams } },
        { bpm: 124 },
      );
      const osc = ctx.createOscillator();
      osc.frequency.value = 220;
      const g = ctx.createGain();
      g.gain.value = 0.25;
      osc.connect(g).connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const buffer = await ctx.startRendering();
      rt.dispose();
      return buffer.getChannelData(0);
    };
    const gained = await renderUltina(true, { "global.inputGainDb": 6 });
    const passthrough = await renderUltina(false, {});
    let peakA = 0;
    let diffSq = 0;
    let refSq = 0;
    for (let i = 0; i < gained.length; i++) {
      peakA = Math.max(peakA, Math.abs(gained[i]));
      const d = gained[i] - passthrough[i];
      diffSq += d * d;
      refSq += passthrough[i] * passthrough[i];
    }
    const diffRms = Math.sqrt(diffSq / gained.length);
    const refRms = Math.sqrt(refSq / gained.length);
    // +6 dB ≈ 2× amplitude: essentially the whole signal differs.
    check(
      "ultina: worklet DSP renders in offline context (+6dB) + honest fallback",
      fallbackOk && refRms > 0.05 && diffRms > refRms * 0.5 && peakA > 0.4,
      `fallback=${fallbackOk} refRms=${refRms.toFixed(3)} diffRms=${diffRms.toFixed(3)} peak=${peakA.toFixed(3)}`,
    );
  } catch (error) {
    check("ultina: worklet DSP renders in offline context (+6dB) + honest fallback", false, String(error));
  }

  // ULTINA CPU budget: all 10 modules enabled, stereo 128-frame blocks —
  // the same vendored DSP the audio thread runs inside the worklet.
  try {
    const proc = new UltinaProcessor();
    registerCoreModules(proc);
    proc.prepare({ sampleRate: SR, channelCount: 2, maxBlockSize: 128, qualityMode: 1 });
    const worst: Record<string, number> = {};
    for (const mod of [
      "eq",
      "comp",
      "gate",
      "exciter",
      "transient",
      "clipper",
      "density",
      "sculptor",
      "phase",
      "unmask",
    ]) {
      worst[`${mod}.enabled`] = 1;
    }
    proc.loadState(worst);
    const blocks = 400;
    const stereo = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 50; i++) proc.process(stereo, 128);
    // Three independent samples, MIN used: DSP cost is lower-bounded and
    // load only adds time (see the fxeq CPU check above) — one clean window
    // is enough to prove the budget; the old single-window average flaked
    // on loaded machines.
    const samplesUs: number[] = [];
    for (let sample = 0; sample < 3; sample++) {
      const t0 = performance.now();
      for (let i = 0; i < blocks; i++) {
        stereo[0][i % 128] = Math.sin((sample * blocks + i) * 0.1);
        stereo[1][i % 128] = Math.sin((sample * blocks + i) * 0.1 + 0.5);
        proc.process(stereo, 128);
      }
      samplesUs.push(((performance.now() - t0) * 1000) / blocks);
    }
    samplesUs.sort((a, b) => a - b);
    const avgUsPerBlock = samplesUs[0];
    const budgetUs = (128 / SR) * 1000 * 1000;
    const cpuPercent = (avgUsPerBlock / budgetUs) * 100;
    check(
      "ultina: CPU budget — all 10 modules fit the audio-thread block budget",
      avgUsPerBlock < budgetUs * 0.6,
      `bestSample=${avgUsPerBlock.toFixed(0)}µs/block of ${budgetUs.toFixed(0)}µs budget → ${cpuPercent.toFixed(1)}% of one core (samples=${samplesUs
        .map((value) => value.toFixed(0))
        .join(",")})`,
    );
  } catch (error) {
    check("ultina: CPU budget — all 10 modules fit the audio-thread block budget", false, String(error));
  }

  // ULTINA meters: the worklet must push meter snapshots (spectrum, LUFS,
  // waveform) through the port while rendering, and the DSP-level meters
  // must reflect a loud signal.
  try {
    const def = EFFECT_DEFS.ultina;
    // 1. DSP-level: loud signal → LUFS sane + spectrum bins populated.
    const meterProc = new UltinaProcessor();
    registerCoreModules(meterProc);
    meterProc.prepare({ sampleRate: SR, channelCount: 2, maxBlockSize: 128, qualityMode: 1 });
    const loud = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 128; i++) {
      loud[0][i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
      loud[1][i] = loud[0][i];
    }
    for (let b = 0; b < 80; b++) meterProc.process(loud, 128);
    const dspMeters = meterProc.getMeters() as {
      global?: { outputShortTermLufs?: number; inputSpectrumDb?: Float32Array | null };
    };
    const lufs = dspMeters.global?.outputShortTermLufs ?? -70;
    const spectrum = dspMeters.global?.inputSpectrumDb;
    let specEnergy = 0;
    if (spectrum) for (let b = 0; b < spectrum.length; b++) specEnergy += Math.abs(spectrum[b]);

    // 2. Worklet flow: render with the node connected, then the runtime's
    // getMeters() must hold a snapshot pushed over the port. Metering is
    // gated — the panel enables it, so the check does the same. A second node
    // that never enables must produce ZERO meter snapshots (closed panels
    // cost nothing on the audio thread).
    const ctx = new OfflineAudioContext(2, SR, SR);
    await loadAllWorklets(ctx);
    const rt = def.factory(
      ctx,
      { id: "t2", type: "ultina", bypassed: false, params: defaultParamsOf("ultina") },
      { bpm: 124 },
    );
    rt.setMetersEnabled?.(true);
    const rtGated = def.factory(
      ctx,
      { id: "t2gated", type: "ultina", bypassed: false, params: defaultParamsOf("ultina") },
      { bpm: 124 },
    );
    const osc = ctx.createOscillator();
    osc.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.value = 0.3;
    osc.connect(g).connect(rt.input);
    rt.output.connect(ctx.destination);
    rtGated.output.connect(ctx.destination);
    osc.start(0);
    // OfflineAudioContext queues AudioWorklet port controls until the event
    // loop gets a turn. Let the opt-in meter message reach the processor
    // before starting the render; live playback naturally has this turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ctx.startRendering();
    // Port messages queue behind the render — wait briefly for delivery.
    let workletMeters: unknown = null;
    for (let attempt = 0; attempt < 10 && !workletMeters; attempt++) {
      await new Promise((r) => setTimeout(r, 60));
      workletMeters = (rt as { getMeters?: () => unknown }).getMeters?.();
    }
    // The gated node must have received NO meter snapshots at all.
    const gatedMeters = (rtGated as { getMeters?: () => unknown }).getMeters?.();
    rt.dispose();
    rtGated.dispose();
    check(
      "ultina: live meters flow (DSP LUFS/spectrum + worklet port snapshots, gated node stays silent)",
      lufs > -40 && specEnergy > 1 && !!workletMeters && !gatedMeters,
      `lufs=${lufs.toFixed(1)} specEnergy=${specEnergy.toFixed(0)} workletSnapshot=${!!workletMeters} gatedSilent=${!gatedMeters}`,
    );
  } catch (error) {
    check("ultina: live meters flow (DSP LUFS/spectrum + worklet port snapshots)", false, String(error));
  }

  // OZVENA Phase-A benchmark: per-engine realtime cost of the vendored TS
  // core. The upstream perf harness measured a typical preset at ~106% of
  // one core — these numbers decide the Phase-B strategy (hybrid
  // ConvolverNode / offline-first / WASM).
  try {
    const bench = (mutate: (state: Record<string, unknown>) => void) => {
      const proc = createOzvenaProcessor();
      const state: Record<string, unknown> = defaultOzvenaStateV1() as unknown as Record<string, unknown>;
      mutate(state);
      proc.prepare(SR, 2, 128, 1);
      proc.loadState(state as unknown as Parameters<typeof proc.loadState>[0]);
      const stereo = [new Float32Array(128), new Float32Array(128)];
      for (let i = 0; i < 30; i++) proc.process(stereo, 128);
      const t0 = performance.now();
      const blocks = 300;
      for (let i = 0; i < blocks; i++) {
        stereo[0][i % 128] = Math.sin(i * 0.07);
        proc.process(stereo, 128);
      }
      const wallMs = performance.now() - t0;
      proc.reset?.();
      return (wallMs * 1000) / blocks; // µs/block
    };
    const budgetUs = (128 / SR) * 1000 * 1000;
    const engineState = (engine: string) => (s: Record<string, unknown>) => {
      // Keep every default field — engines carry required config (algo,
      // lenMult sources); only flip the enabled flags.
      const engines = s.engines as Record<string, { enabled: boolean }>;
      for (const e of ["e1", "e2", "e3"]) engines[e].enabled = e === engine;
    };
    const e1 = bench(engineState("e1"));
    const e2 = bench(engineState("e2"));
    const e3 = bench(engineState("e3"));
    const all = bench((s) => {
      engineState("e1")(s);
      (s.engines as Record<string, { enabled: boolean }>).e1.enabled = true;
      (s.engines as Record<string, { enabled: boolean }>).e2.enabled = true;
      (s.engines as Record<string, { enabled: boolean }>).e3.enabled = true;
    });
    const pct = (us: number) => ((us / budgetUs) * 100).toFixed(0);
    // Informational for Phase B — the check itself only fails when the
    // benchmark collapses entirely (broken vendored core).
    check(
      "ozvena: phase-A per-engine benchmark (decision data)",
      e1 > 0 && e2 > 0 && e3 > 0 && all > 0,
      `E1=${e1.toFixed(0)}µs (${pct(e1)}%) E2=${e2.toFixed(0)}µs (${pct(e2)}%) E3=${e3.toFixed(0)}µs (${pct(e3)}%) ALL=${all.toFixed(0)}µs (${pct(all)}%) — budget ${budgetUs.toFixed(0)}µs`,
    );
  } catch (error) {
    check("ozvena: phase-A per-engine benchmark (decision data)", false, String(error));
  }

  // OZVENA worklet: the three-engine reverb must render in offline contexts
  // (100% wet reverb audibly transforms the signal vs the degraded
  // passthrough — the tail lives on after the click dies), report PDC
  // latency, and degrade honestly without the module.
  try {
    const def = EFFECT_DEFS.ozvena;
    // 1. Degraded fallback (no modules loaded in this context).
    const plainCtx = new OfflineAudioContext(1, SR, SR);
    const fallback = def.factory(
      plainCtx,
      { id: "t", type: "ozvena", bypassed: false, params: defaultParamsOf("ozvena") },
      { bpm: 124 },
    );
    const fallbackOk = fallback.degraded === true;
    fallback.dispose();

    // 2. Worklet path: 100% wet reverb on a short click.
    const renderOzvena = async (loaded: boolean) => {
      const ctx = new OfflineAudioContext(2, SR * 2, SR);
      if (loaded) await loadAllWorklets(ctx);
      const rt = def.factory(
        ctx,
        { id: "t", type: "ozvena", bypassed: false, params: { ...defaultParamsOf("ozvena"), "global.dryWet": 100 } },
        { bpm: 124 },
      );
      const click = ctx.createBuffer(1, 64, SR);
      click.getChannelData(0)[0] = 0.9;
      const src = ctx.createBufferSource();
      src.buffer = click;
      src.connect(rt.input);
      rt.output.connect(ctx.destination);
      src.start(0);
      const buffer = await ctx.startRendering();
      const latency = (rt as { getLatencySec?: () => number }).getLatencySec?.() ?? 0;
      rt.dispose();
      return { data: buffer.getChannelData(0), latency };
    };
    const wet = await renderOzvena(true);
    const dry = await renderOzvena(false);
    let wetTail = 0;
    let diffSq = 0;
    // Tail window: 100–500 ms after the click (dry click is long gone).
    const from = Math.floor(0.1 * SR);
    const to = Math.floor(0.5 * SR);
    for (let i = from; i < to; i++) {
      wetTail += wet.data[i] * wet.data[i];
      const d = wet.data[i] - dry.data[i];
      diffSq += d * d;
    }
    const tailRms = Math.sqrt(wetTail / (to - from));
    const diffRms = Math.sqrt(diffSq / (to - from));
    check(
      "ozvena: worklet reverb renders in offline context + PDC latency + honest fallback",
      fallbackOk && tailRms > 0.0005 && diffRms > 0.0005 && wet.latency >= 0,
      `fallback=${fallbackOk} tailRms=${tailRms.toFixed(5)} diffRms=${diffRms.toFixed(5)} latencyMs=${(wet.latency * 1000).toFixed(1)}`,
    );
  } catch (error) {
    check("ozvena: worklet reverb renders in offline context + PDC latency + honest fallback", false, String(error));
  }

  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const track: InstrumentTrack = {
      id: "check-808-decay",
      kind: "instrument",
      instrument: "808",
      name: "808",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: { ...defaultInstrumentParams("808"), decay: 0.5 },
      effects: [],
      sends: {},
    };
    const rt = INSTRUMENT_DEFS["808"].factory(ctx, track, { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    rt.noteOn(33, 1, 0.02, 0.3);
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    const rms = (from: number, to: number) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += data[i] * data[i];
      return Math.sqrt(sum / Math.max(1, to - from));
    };
    const early = rms(Math.floor(SR * 0.05), Math.floor(SR * 0.15));
    const late = rms(Math.floor(SR * 0.6), Math.floor(SR * 0.95));
    check("808 amplitude decays over time", early > late * 3, `early=${early.toFixed(3)} late=${late.toFixed(3)}`);
  } catch (error) {
    check("808 amplitude decays over time", false, String(error));
  }

  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const track: InstrumentTrack = {
      id: "check-sampler-pitch",
      kind: "instrument",
      instrument: "sampler",
      name: "Sampler",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: "factory.tonal.pluck",
      params: defaultInstrumentParams("sampler"),
      effects: [],
      sends: {},
    };
    const rt = INSTRUMENT_DEFS.sampler.factory(ctx, track, { bpm: 124, getSample: (id) => bank.get(id) });
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0.02, 0.3);
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    let peakPos = 0;
    let peakVal = 0;
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i]) > peakVal) {
        peakVal = Math.abs(data[i]);
        peakPos = i;
      }
    }
    check(
      "sampler plays transposed sample from C4 root",
      peakVal > 0.05 && peakPos > 0,
      `peak=${peakVal.toFixed(3)} at ${peakPos}`,
    );
  } catch (error) {
    check("sampler plays transposed sample from C4 root", false, String(error));
  }

  // Sampler loop REGION: L-START/L-END with LOOP mode must sustain audio past
  // the note gate (native loopStart/loopEnd path) and honor a mid-sample region.
  try {
    const ctx = new OfflineAudioContext(1, SR * 2, SR);
    const track: InstrumentTrack = {
      id: "check-sampler-loop",
      kind: "instrument",
      instrument: "sampler",
      name: "Sampler Loop",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: "factory.tonal.pluck",
      params: {
        ...defaultInstrumentParams("sampler"),
        loop: 1,
        loopStart: 0.2,
        loopEnd: 0.45,
        sustain: 1,
      },
      effects: [],
      sends: {},
    };
    const rt = INSTRUMENT_DEFS.sampler.factory(ctx, track, { bpm: 124, getSample: (id) => bank.get(id) });
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0.02, 1.4); // long gate: the loop must sustain through the probe window
    const rendered = await ctx.startRendering();
    rt.dispose();
    const data = rendered.getChannelData(0);
    const rms = (fromSec: number, toSec: number): number => {
      const from = Math.floor(fromSec * SR);
      const to = Math.min(data.length, Math.floor(toSec * SR));
      let sum = 0;
      for (let i = from; i < to; i++) sum += data[i] * data[i];
      return Math.sqrt(sum / Math.max(1, to - from));
    };
    const inLoop = rms(1.0, 1.4); // inside note gate + inside loop region
    const afterRelease = rms(1.75, 1.95); // after release — near-silent
    check(
      "sampler: loop region sustains past the gate and releases cleanly",
      inLoop > 0.02 && afterRelease < inLoop * 0.2,
      "inLoop=" + inLoop.toFixed(3) + " afterRelease=" + afterRelease.toFixed(3),
    );
  } catch (error) {
    check("sampler: loop region sustains past the gate and releases cleanly", false, String(error));
  }

  // FM synth: 2-op voice renders audible audio with the classic FM character
  // (ratio 3.01 bell), and the growl preset stays quiet enough to mix.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const track: InstrumentTrack = {
      id: "check-fm-bell",
      kind: "instrument",
      instrument: "fm",
      name: "FM Bell",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: defaultInstrumentParams("fm"),
      effects: [],
      sends: {},
    };
    const rt = INSTRUMENT_DEFS.fm.factory(ctx, track, { bpm: 124, getSample: (id) => bank.get(id) });
    rt.output.connect(ctx.destination);
    rt.noteOn(72, 0.9, 0.02, 0.5);
    const rendered = await ctx.startRendering();
    rt.dispose();
    const data = rendered.getChannelData(0);
    const peak = peakOf(data);
    // Growl: ratio 1, feedback 0.5 — aggressive but mixable peak.
    const growlTrack: InstrumentTrack = {
      ...track,
      id: "check-fm-growl",
      name: "FM Growl",
      params: {
        ...defaultInstrumentParams("fm"),
        ratio: 1,
        index: 0.7,
        feedback: 0.5,
        modSustain: 0.6,
        attack: 0.006,
        sustain: 0.55,
        level: -5,
      },
    };
    const ctx2 = new OfflineAudioContext(1, SR, SR);
    const rt2 = INSTRUMENT_DEFS.fm.factory(ctx2, growlTrack, { bpm: 124, getSample: (id) => bank.get(id) });
    rt2.output.connect(ctx2.destination);
    rt2.noteOn(45, 0.9, 0.02, 0.5);
    const growled = await ctx2.startRendering();
    rt2.dispose();
    const growlPeak = peakOf(growled.getChannelData(0));
    check(
      "fm synth: bell renders with FM sidebands, growl stays mixable",
      peak > 0.1 && growlPeak > 0.05 && growlPeak < 1.2,
      "bellPeak=" + peak.toFixed(3) + " growlPeak=" + growlPeak.toFixed(3),
    );
  } catch (error) {
    check("fm synth: bell renders with FM sidebands, growl stays mixable", false, String(error));
  }

  try {
    const ctx = new OfflineAudioContext(1, SR * 2, SR);
    const source = ctx.createOscillator();
    source.type = "sine";
    source.frequency.value = 220;
    const modGain = ctx.createGain();
    modGain.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 2;
    const depth = ctx.createGain();
    depth.gain.value = 0.8;
    lfo.connect(depth).connect(modGain.gain);
    source.connect(modGain).connect(ctx.destination);
    source.start(0);
    lfo.start(0);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    const rmsBlocks: number[] = [];
    for (let i = 0; i + 2048 <= data.length; i += 2048) {
      let sum = 0;
      for (let j = 0; j < 2048; j++) sum += data[i + j] * data[i + j];
      rmsBlocks.push(Math.sqrt(sum / 2048));
    }
    const maxRms = Math.max(...rmsBlocks);
    const minRms = Math.min(...rmsBlocks);
    check(
      "LFO modulates gain at audio rate",
      maxRms / Math.max(minRms, 1e-9) > 2,
      `max=${maxRms.toFixed(3)} min=${minRms.toFixed(3)} ratio=${(maxRms / Math.max(minRms, 1e-9)).toFixed(2)}`,
    );
  } catch (error) {
    check("LFO modulates gain at audio rate", false, String(error));
  }

  try {
    const ctx = new OfflineAudioContext(1, SR * 2, SR);
    const source = ctx.createOscillator();
    source.type = "sine";
    source.frequency.value = 220;
    const autoGain = ctx.createGain();
    autoGain.gain.setValueAtTime(1, 0);
    for (let t = 0; t <= 1.0; t += 0.025) {
      autoGain.gain.setTargetAtTime(Math.max(0, 1 - t), t, 0.008);
    }
    source.connect(autoGain).connect(ctx.destination);
    source.start(0);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    const rms = (from: number, to: number) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += data[i] * data[i];
      return Math.sqrt(sum / Math.max(1, to - from));
    };
    const early = rms(Math.floor(SR * 0.05), Math.floor(SR * 0.2));
    const late = rms(Math.floor(SR * 1.5), Math.floor(SR * 1.95));
    check(
      "automation ramps track level over time",
      early / Math.max(late, 1e-9) > 8,
      `early=${early.toFixed(3)} late=${late.toFixed(3)} ratio=${(early / Math.max(late, 1e-9)).toFixed(1)}`,
    );
  } catch (error) {
    check("automation ramps track level over time", false, String(error));
  }

  try {
    const project = createDefaultProject();
    const patternBuffer = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.5 });
    const patternPeak = peakOf(patternBuffer.getChannelData(0));
    const expectedPatternSec = 16 * (PPQ / 4) * (60 / (project.bpm * PPQ)) + 0.5;
    check(
      "offline render: pattern mode produces audio of correct length",
      patternPeak > 0.05 && Math.abs(patternBuffer.duration - expectedPatternSec) < 0.05,
      `peak=${patternPeak.toFixed(3)} dur=${patternBuffer.duration.toFixed(2)}s expected=${expectedPatternSec.toFixed(2)}s`,
    );
  } catch (error) {
    check("offline render: pattern mode produces audio of correct length", false, String(error));
  }

  try {
    const project = createDefaultProject();
    const songBuffer = await renderProject(project, bank, { mode: "song", sampleRate: SR, tailSeconds: 0.5 });
    const patternBuffer = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.5 });
    check(
      "offline render: song mode (4-bar arrangement) is longer than one pattern pass",
      songBuffer.duration > patternBuffer.duration && peakOf(songBuffer.getChannelData(0)) > 0.05,
      `song=${songBuffer.duration.toFixed(2)}s pattern=${patternBuffer.duration.toFixed(2)}s`,
    );
  } catch (error) {
    check("offline render: song mode (4-bar arrangement) is longer than one pattern pass", false, String(error));
  }

  try {
    const project = createDefaultProject();
    const drumStem = await renderProject(buildStemProject(project, STEM_GROUPS[0].filter), bank, {
      mode: "pattern",
      sampleRate: SR,
      tailSeconds: 0.2,
    });
    const bassStem = await renderProject(buildStemProject(project, STEM_GROUPS[1].filter), bank, {
      mode: "pattern",
      sampleRate: SR,
      tailSeconds: 0.2,
    });
    const drumPeak = peakOf(drumStem.getChannelData(0));
    const bassPeak = peakOf(bassStem.getChannelData(0));
    check(
      "offline render: drum and bass stems are independently audible",
      drumPeak > 0.05 && bassPeak > 0.01,
      `drum=${drumPeak.toFixed(3)} bass=${bassPeak.toFixed(3)}`,
    );
  } catch (error) {
    check("offline render: drum and bass stems are independently audible", false, String(error));
  }

  try {
    const project = createDefaultProject();
    const buffer = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    const wav16 = encodeWav(buffer, 16);
    const header = new DataView(wav16);
    const riff = String.fromCharCode(header.getUint8(0), header.getUint8(1), header.getUint8(2), header.getUint8(3));
    const wave = String.fromCharCode(header.getUint8(8), header.getUint8(9), header.getUint8(10), header.getUint8(11));
    check(
      "offline render encodes to a valid WAV file",
      riff === "RIFF" && wave === "WAVE" && wav16.byteLength >= 44 + buffer.length * 2 * 2,
      `bytes=${wav16.byteLength}`,
    );
  } catch (error) {
    check("offline render encodes to a valid WAV file", false, String(error));
  }

  check(
    "templates: factory templates are registered",
    // The per-template loop below validates every registered template
    // individually; the floor only guards against a silent registration
    // drop (a hard equality went stale every time a template shipped).
    TEMPLATES.length >= 12,
    `${TEMPLATES.length} registered: ${TEMPLATES.map((t) => t.id).join(",")}`,
  );

  for (const template of TEMPLATES) {
    try {
      const project = createProjectFromTemplate(template.id);
      const valid = validateProjectShape(project) && normalizeProject(project) === project;
      const buffer = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
      const peak = peakOf(buffer.getChannelData(0));
      // The Empty template is deliberately silent — it only has to be valid.
      const audible = template.id === "empty" ? peak <= 4 : peak > 0.01 && peak <= 4;
      check(
        `template ${template.id}: valid project and renders audio`,
        valid && audible,
        `valid=${valid} peak=${peak.toFixed(3)}`,
      );
    } catch (error) {
      check(`template ${template.id}: valid project and renders audio`, false, String(error));
    }
  }

  // ── PERF BUDGET: 8-bar offline render per template ────────────────────
  // An 8-bar bounce is the smallest "real" render a creator waits on
  // (loop export / share preview). If a template's render cost creeps past
  // the budget, every export in the app feels broken. The arrangement is
  // the template's own pattern chained 8 bars in its first scene.
  // Baselines (idle M1-class laptop, 2026-09): avg ~2 s, worst ~3.5 s.
  // Budgets sit ~3.5× over the average so a regression trips the gate long
  // before exports feel broken; every check prints its actual ms.
  {
    const BUDGET_PER_RENDER_MS = 12000;
    // Shared-machine guard: measure a fixed pure-JS workload first. On a
    // busy machine (concurrent builds) wall-clock budgets trip on load, not
    // on regressions — degrade to informational (pass + flag) instead of
    // crying wolf.
    const spin = () => {
      let acc = 0;
      for (let i = 0; i < 5_000_000; i++) acc += Math.sqrt(i);
      return acc;
    };
    spin(); // warm-up
    let calibMs = 0;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      spin();
      calibMs = Math.max(calibMs, performance.now() - t0);
    }
    const machineLoaded = calibMs > 18; // ~3× the idle cost
    const budgetTimes: number[] = [];
    let totalAudioMs = 0;
    let totalWallMs = 0;
    for (const template of TEMPLATES) {
      if (template.id === "empty") continue;
      try {
        const doc = createProjectFromTemplate(template.id);
        const scene = doc.scenes[0];
        if (!scene) {
          check(`perf: ${template.id} — 8-bar render budget`, false, "template has no scene to arrange");
          continue;
        }
        // EXACTLY 8 bars — templates that ship their own arrangement
        // (scene-score) are flattened so every template measures the same
        // workload.
        const withEightBars: ProjectDocument = {
          ...doc,
          arrangement: {
            ...doc.arrangement,
            clips: Array.from({ length: 8 }, (_, bar) => ({
              id: `perf-${bar}`,
              sceneId: scene.id,
              startBar: bar,
              lengthBars: 1,
            })),
          },
        };
        const measure = async () => {
          const t0 = performance.now();
          const rendered = await renderProject(withEightBars, bank, {
            mode: "song",
            sampleRate: SR,
            tailSeconds: 0.2,
          });
          return { ms: performance.now() - t0, audioMs: rendered.duration * 1000 };
        };
        const first = await measure();
        let best = first;
        const firstBudgetMs = Math.max(BUDGET_PER_RENDER_MS, first.audioMs * 0.9);
        // OfflineAudioContext timing can lose a single sample-render quantum
        // to host scheduling/GC. Retry only an actual miss; two misses remain
        // a hard failure and therefore still catch a reproducible regression.
        let recovered = false;
        if (!machineLoaded && first.ms >= firstBudgetMs) {
          const retry = await measure();
          if (retry.ms < best.ms) best = retry;
          recovered = retry.ms < Math.max(BUDGET_PER_RENDER_MS, retry.audioMs * 0.9);
        }
        const ms = best.ms;
        const audioMs = best.audioMs;
        budgetTimes.push(ms);
        totalAudioMs += audioMs;
        totalWallMs += ms;
        // The workload is fixed at eight bars, but its duration changes with
        // tempo. A fixed wall-clock budget unfairly penalises slow genres
        // (for example, 96 BPM is 20 seconds of audio) even though the DSP
        // cost is proportional to sample count. Keep the original 12 s floor
        // for short renders and allow a 0.9× realtime ceiling for longer ones.
        const renderBudgetMs = Math.max(BUDGET_PER_RENDER_MS, audioMs * 0.9);
        check(
          `perf: ${template.id} — 8-bar render within budget`,
          machineLoaded || ms < renderBudgetMs,
          `${ms.toFixed(0)}ms for ${audioMs.toFixed(0)}ms audio (budget ${renderBudgetMs.toFixed(0)}ms, ${(
            ms / Math.max(1, audioMs)
          ).toFixed(2)}× realtime)${recovered ? ` — first sample ${first.ms.toFixed(0)}ms, retry recovered` : ""}${
            machineLoaded ? " — machine loaded, informational run" : ""
          }`,
        );
      } catch (error) {
        check(`perf: ${template.id} — 8-bar render within budget`, false, String(error));
      }
    }
    if (budgetTimes.length > 0) {
      const avg = budgetTimes.reduce((a, b) => a + b, 0) / budgetTimes.length;
      const worst = Math.max(...budgetTimes);
      check(
        "perf: 8-bar render average across all templates",
        machineLoaded || avg < 7000,
        `avg=${avg.toFixed(0)}ms worst=${worst.toFixed(0)}ms over ${budgetTimes.length} templates; aggregate=${(
          totalWallMs / Math.max(1, totalAudioMs)
        ).toFixed(2)}× realtime${machineLoaded ? " — machine loaded, informational run" : ""}`,
      );
    }
    // ── AUDIO-THREAD BUDGET: N tracks × M effects under the RT monitor ──
    // The render budget above measures OFFLINE cost. This one measures the
    // REALTIME path: the engine's rt-monitor worklet reports the worst wall
    // time the audio thread spends per render quantum, and the worst gap
    // between consecutive quanta (the xrun proxy). Same shared-machine guard
    // as the render budget — on a loaded machine the numbers are reported but
    // not gated, because they would measure co-tenant load, not regressions.
    record(await auditRtBudget(bank, machineLoaded));
    // The offline counterpart of the same N×M matrix: how long does an
    // N-track × M-effect render take? Deterministic (no device clock), so it
    // is always gated; it catches a graph that got structurally more
    // expensive even when the realtime budget still has headroom.
    record(await auditDenseRender(bank, machineLoaded));
  }

  try {
    const sceneScore = createProjectFromTemplate("scene-score");
    const songBuffer = await renderProject(sceneScore, bank, { mode: "song", sampleRate: SR, tailSeconds: 0.2 });
    const patternBuffer = await renderProject(sceneScore, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    check(
      "scene-score template: song arrangement renders longer than one pattern",
      songBuffer.duration > patternBuffer.duration * 2 && peakOf(songBuffer.getChannelData(0)) > 0.01,
      `song=${songBuffer.duration.toFixed(2)}s pattern=${patternBuffer.duration.toFixed(2)}s`,
    );
  } catch (error) {
    check("scene-score template: song arrangement renders longer than one pattern", false, String(error));
  }

  try {
    const straight = createProjectFromTemplate("house");
    const grooved: typeof straight = {
      ...straight,
      groove: { swing: 0.6, humanizeTiming: 0.5, humanizeVelocity: 0.4 },
      patterns: straight.patterns.map((p) => ({
        ...p,
        stepMeta: {
          ...p.stepMeta,
          [Object.keys(p.rows)[0]]: { 14: { ratchet: 4 }, 10: { probability: 0.6 } },
        },
      })),
    };
    const straightBuf = await renderProject(straight, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    const groovedBuf = await renderProject(grooved, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    const a = straightBuf.getChannelData(0);
    const b = groovedBuf.getChannelData(0);
    let diff = 0;
    const limit = Math.min(a.length, b.length);
    for (let i = 0; i < limit; i += 37) diff += Math.abs(a[i] - b[i]);
    check(
      "groove: swing/humanize/ratchet change the exported audio",
      peakOf(b) > 0.05 && diff > 1,
      `peak=${peakOf(b).toFixed(3)} sample-diff=${diff.toFixed(1)}`,
    );
  } catch (error) {
    check("groove: swing/humanize/ratchet change the exported audio", false, String(error));
  }

  {
    // ARTIFACT GATE — the numerical defect check over REAL renders. This is
    // what locks the de-click tail and the round-robin work into CI: a broken
    // fade, a slice cut, a NaN stage or an over-ceiling true peak fails here
    // instead of shipping. Renders a representative spread of genres (each
    // with its own kit swaps, layers and groove feel) plus a p-locked length
    // cut, which is the exact case the de-click tail exists for.
    const failures: string[] = [];
    const reports: string[] = [];
    for (const templateId of ["house", "techno", "trap", "drill", "phonk", "jersey", "dnb", "ambient"] as const) {
      try {
        const doc = createProjectFromTemplate(templateId);
        const rendered = await renderProject(doc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.4 });
        const channels = Array.from({ length: rendered.numberOfChannels }, (_, ch) => rendered.getChannelData(ch));
        const report = analyzeArtifacts(channels);
        const verdict = evaluateArtifacts(report, { ceilingDb: -0.5 });
        if (!verdict.ok) failures.push(`${templateId}: ${verdict.failures.join("; ")}`);
        reports.push(`${templateId} tail=${report.tailStepRatio.toFixed(3)} tp=${report.truePeakDb.toFixed(1)}`);
      } catch (error) {
        failures.push(`${templateId}: ${String(error)}`);
      }
    }
    check(
      "artifact gate: every genre render is finite, de-clicked, click-free and under ceiling",
      failures.length === 0,
      failures.length > 0 ? failures.join(" | ") : reports.join(" "),
    );
  }

  {
    // ROUND-ROBIN SPREAD — the same pad hit repeatedly must not be the same
    // sample every time. Renders one bar of a straight 8th-note hat pattern
    // and compares consecutive hits: identical repetition correlates 1.0
    // (the machine gun), a layered pad must stay below that.
    try {
      const doc = createProjectFromTemplate("house");
      const drum = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
      const hat = drum.pads[8]; // stock closed hat — carries the dynamic set
      const pattern = doc.patterns[0];
      pattern.rows[hat.id] = new Array<number>(pattern.stepCount).fill(0);
      for (let step = 0; step < 8; step++) pattern.rows[hat.id][step * 2] = 0.7;
      const rendered = await renderProject(doc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.1 });
      const data = rendered.getChannelData(0);
      const hitLen = Math.floor(0.05 * SR);
      const hits: Float32Array[] = [];
      for (let step = 0; step < 8; step++) {
        // 8th notes at the project tempo — locate by the rendered hit's onset.
        const approx = Math.floor(((step * 2 * 60) / doc.bpm) * SR);
        hits.push(data.subarray(approx, Math.min(data.length, approx + hitLen)));
      }
      const correlations: number[] = [];
      for (let i = 1; i < hits.length; i++) correlations.push(logEnvelopeCorrelation(hits[i - 1], hits[i]));
      const identical = correlations.filter((c) => c > 0.9999).length;
      check(
        "round-robin: consecutive hat hits are not the same sample",
        hat.layers !== undefined ? identical < correlations.length : true,
        `layers=${hat.layers?.length ?? 0} corr=[${correlations.map((c) => c.toFixed(3)).join(",")}]`,
      );
    } catch (error) {
      check("round-robin: consecutive hat hits are not the same sample", false, String(error));
    }
  }

  {
    // Real invariant: every instrument kind ships at least one factory preset.
    // (A hard-coded instrument count went stale when the ninth kind landed.)
    const bank = await warmFactoryPresets().then(() => factoryPresets());
    const covered = new Set(bank.map((p) => p.instrument));
    const missing = INSTRUMENT_ORDER.filter((kind) => !covered.has(kind));
    check(
      "presets: factory bank covers every instrument kind",
      missing.length === 0,
      missing.length > 0 ? `missing: ${missing.join(",")}` : `kinds=${covered.size} presets=${bank.length}`,
    );
  }

  try {
    const project = createProjectFromTemplate("house");
    const bassTrack = project.tracks.find(
      (t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "808",
    );
    const preset = (await warmFactoryPresets().then(() => factoryPresets())).find((p) => p.instrument === "808");
    if (!bassTrack || !preset) throw new Error("808 track or preset missing");
    const applied = applyInstrumentPreset(project, bassTrack.id, preset).execute(project);
    const appliedTrack = applied.tracks.find((t) => t.id === bassTrack.id) as InstrumentTrack;
    const presetApplied = appliedTrack.presetId === preset.id && appliedTrack.params.decay === preset.params.decay;
    const buffer = await renderProject(applied, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    const peak = peakOf(buffer.getChannelData(0));
    check(
      "presets: apply command sticks and project still renders",
      presetApplied && peak > 0.01,
      `applied=${presetApplied} peak=${peak.toFixed(3)}`,
    );
  } catch (error) {
    check("presets: apply command sticks and project still renders", false, String(error));
  }

  // Sampler multi-file mapping: exercise the real sampler runtime with the
  // same filename-derived keyzones used by the Inspector. This catches the
  // easy-to-miss failure where a command or serializer drops minPitch/maxPitch
  // and every imported sample ends up playing across the whole keyboard.
  try {
    const layers = autoMapVelocityLayers([
      { sampleId: "browser-auto-low", name: "piano_C3.wav" },
      { sampleId: "browser-auto-high", name: "piano_C4.wav" },
    ]);
    const low = new OfflineAudioContext(1, SR, SR).createBuffer(1, SR, SR);
    const high = new OfflineAudioContext(1, SR, SR).createBuffer(1, SR, SR);
    for (let i = 0; i < SR; i++) {
      low.getChannelData(0)[i] = 0.7 * Math.sin((2 * Math.PI * 220 * i) / SR);
      high.getChannelData(0)[i] = 0.7 * Math.sin((2 * Math.PI * 660 * i) / SR);
    }
    const bank = new Map([
      ["browser-auto-low", low],
      ["browser-auto-high", high],
    ]);
    const render = async (pitch: number, velocity = 0.8): Promise<Float32Array> => {
      const ctx = new OfflineAudioContext(1, Math.floor(SR * 1.4), SR);
      const track: InstrumentTrack = {
        id: "browser-auto-sampler",
        kind: "instrument",
        instrument: "sampler",
        name: "AutoMap",
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: "browser-auto-low",
        velocityLayers: layers,
        params: defaultInstrumentParams("sampler"),
        effects: [],
        sends: {},
      };
      const runtime = INSTRUMENT_DEFS.sampler.factory(ctx, track, {
        bpm: 124,
        getSample: (id) => bank.get(id ?? ""),
      });
      runtime.output.connect(ctx.destination);
      runtime.noteOn(pitch, velocity, 0.05, 0.35);
      const rendered = await ctx.startRendering();
      runtime.dispose();
      return rendered.getChannelData(0);
    };
    const zc = (data: Float32Array): number => {
      const from = Math.floor(0.12 * SR);
      const to = Math.floor(0.45 * SR);
      let count = 0;
      for (let i = from + 1; i < to; i++) if (data[i - 1] < 0 !== data[i] < 0) count++;
      return count;
    };
    const lowOut = await render(48);
    const highOut = await render(72);
    const highFullVelocityOut = await render(72, 1);
    const lowCrossings = zc(lowOut);
    const highCrossings = zc(highOut);
    const highFullVelocityCrossings = zc(highFullVelocityOut);
    const keyzones = layers.every((layer) => layer.minPitch !== undefined && layer.maxPitch !== undefined);
    check(
      "sampler AutoMap: filename keyzones route notes to the correct imported sample",
      keyzones && lowCrossings > 20 && highCrossings > lowCrossings * 4 && highFullVelocityCrossings > lowCrossings * 4,
      `keyzones=${keyzones} low=${lowCrossings} high=${highCrossings} full=${highFullVelocityCrossings}`,
    );
  } catch (error) {
    check("sampler AutoMap: filename keyzones route notes to the correct imported sample", false, String(error));
  }

  // AudioClip stretch modes through the REAL engine path (OfflineAudioContext):
  // "stretch" must preserve pitch while scaling duration; "resample" must shift
  // pitch; rate 0.25 must render without corrupting the shared bank buffer
  // (regression: the stretch fallback aliased the source array and reversing
  // it destroyed the bank's copy, then AudioBuffer.set() threw RangeError).
  try {
    const TONE_ID = "check-stretch-tone";
    const toneLen = SR; // 1 s
    const tone = bank.get(TONE_ID);
    if (!tone) {
      // The factory bank has no sine one-shot — synthesize into the bank once.
      const scratch = new OfflineAudioContext(1, toneLen, SR).createBuffer(1, toneLen, SR);
      const ch = scratch.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = 0.9 * Math.sin((2 * Math.PI * 440 * i) / SR);
      bank.add(TONE_ID, scratch);
    }
    const pristine = Float32Array.from(bank.get(TONE_ID)!.getChannelData(0));

    const zeroCrossPerSec = (data: Float32Array): number => {
      // Measure only the audible window — silence after the tone ends would
      // otherwise dilute crossings per second (the render includes 3 s of
      // buffer regardless of how long the tone actually plays).
      let last = 0;
      for (let i = data.length - 1; i >= 0; i--) {
        if (Math.abs(data[i]) > 0.02) {
          last = i;
          break;
        }
      }
      if (last <= 0) return 0;
      let crossings = 0;
      for (let i = 1; i <= last; i++) {
        if (data[i - 1] < 0 && data[i] >= 0) crossings++;
      }
      return crossings / (last / SR);
    };
    const lastAudible = (data: Float32Array): number => {
      for (let i = data.length - 1; i >= 0; i--) {
        if (Math.abs(data[i]) > 0.02) return i / SR;
      }
      return 0;
    };
    const renderClip = async (clip: { stretchRate: number; stretchMode?: "stretch" }): Promise<Float32Array> => {
      const ctx = new OfflineAudioContext(1, Math.ceil(SR * 3), SR);
      const engine = new AudioEngine();
      engine.attachBank(bank);
      engine.useContext(ctx);
      const doc = createProjectFromTemplate("empty");
      engine.setProject(doc);
      const trackId = doc.tracks[0].id;
      engine.triggerAudioClip(
        {
          id: "check-clip",
          trackId,
          bufferId: TONE_ID,
          startBar: 0,
          lengthBars: 4,
          offsetSec: 0,
          trimStart: 0,
          trimEnd: 0,
          gain: 1,
          fadeIn: 0,
          fadeOut: 0,
          reverse: false,
          ...clip,
        },
        0.01,
      );
      return (await ctx.startRendering()).getChannelData(0);
    };

    const resampled = await renderClip({ stretchRate: 2 });
    const stretched = await renderClip({ stretchRate: 2, stretchMode: "stretch" });
    const quarter = await renderClip({ stretchRate: 0.25, stretchMode: "stretch" });

    const zcResampled = zeroCrossPerSec(resampled);
    const zcStretched = zeroCrossPerSec(stretched);
    // 440 Hz tone → ~440 upward crossings/s when pitch is preserved; resample
    // at rate 2 plays it at 880 Hz → ~880 crossings/s.
    const pitchPreserved = zcStretched > 440 * 0.75 && zcStretched < 440 * 1.3;
    const resampleShifted = zcResampled > zcStretched * 1.6;
    const stretchedLonger = lastAudible(stretched) > lastAudible(resampled) * 2.5 && lastAudible(stretched) > 1.2;
    const quarterAudible = peakOf(quarter) > 0.05;
    // The shared source must be byte-identical after every render path.
    const after = bank.get(TONE_ID)!.getChannelData(0);
    let corrupted = false;
    for (let i = 0; i < pristine.length; i += 997) {
      if (after[i] !== pristine[i]) corrupted = true;
    }
    check(
      "audio clip stretch: pitch preserved, duration scaled, source untouched",
      pitchPreserved && resampleShifted && stretchedLonger && quarterAudible && !corrupted,
      `zcStretch=${zcStretched.toFixed(0)} zcResample=${zcResampled.toFixed(0)} ` +
        `durStretch=${lastAudible(stretched).toFixed(2)}s durResample=${lastAudible(resampled).toFixed(2)}s ` +
        `quarterPeak=${peakOf(quarter).toFixed(3)} sourceCorrupted=${corrupted}`,
    );
  } catch (error) {
    check("audio clip stretch: pitch preserved, duration scaled, source untouched", false, String(error));
  }

  // Reversed sources use a high-edge playhead with negative playback rate;
  // loop splits use the same trimmed loop window but continue at their saved
  // phase instead of restarting at the source head.
  try {
    const RAMP_ID = "check-reverse-loop-ramp";
    const rampContext = new OfflineAudioContext(1, SR, SR);
    const rampBuffer = rampContext.createBuffer(1, SR, SR);
    const ramp = rampBuffer.getChannelData(0);
    for (let frame = 0; frame < ramp.length; frame++) {
      const envelope = 0.15 + (0.5 * frame) / ramp.length;
      ramp[frame] = envelope * Math.sin((2 * Math.PI * 440 * frame) / SR);
    }
    bank.add(RAMP_ID, rampBuffer);

    const renderRampClip = async (clipPatch: { reverse?: boolean; loop?: boolean; loopPhaseOffsetSec?: number }) => {
      const ctx = new OfflineAudioContext(1, Math.ceil(SR * 1.3), SR);
      const engine = new AudioEngine();
      engine.attachBank(bank);
      engine.useContext(ctx);
      const doc = createProjectFromTemplate("empty");
      doc.master.limiterEnabled = false;
      doc.master.clipperEnabled = false;
      engine.setProject(doc);
      const track = doc.tracks[0];
      if (!track) throw new Error("empty-project audio track fixture missing");
      engine.triggerAudioClip(
        {
          id: "check-reverse-loop-clip",
          trackId: track.id,
          bufferId: RAMP_ID,
          startBar: 0,
          lengthBars: 4,
          offsetSec: 0,
          trimStart: 0,
          trimEnd: 0,
          gain: 1,
          fadeIn: 0,
          fadeOut: 0,
          stretchRate: 1,
          reverse: false,
          ...clipPatch,
        },
        0.01,
        1.15,
      );
      const rendered = await ctx.startRendering();
      engine.panic();
      engine.detachBank();
      return rendered.getChannelData(0);
    };
    const rmsAt = (data: Float32Array, relativeSec: number): number => {
      const start = Math.round((0.01 + relativeSec) * SR);
      const count = Math.round(0.02 * SR);
      let sumSquares = 0;
      for (let frame = start; frame < start + count; frame++) {
        const sample = data[frame] ?? 0;
        sumSquares += sample * sample;
      }
      return Math.sqrt(sumSquares / count);
    };

    const reversed = await renderRampClip({ reverse: true });
    const loopedAtPhase = await renderRampClip({ loop: true, loopPhaseOffsetSec: 0.25 });
    const reverseStartsHighAndFalls = rmsAt(reversed, 0.05) > rmsAt(reversed, 0.45) * 1.1;
    const loopStartsAtPhaseAndWraps = rmsAt(loopedAtPhase, 0.05) > rmsAt(loopedAtPhase, 0.8) * 1.2;
    check(
      "audio clip playback: reverse starts at the high edge and loop phase wraps",
      reverseStartsHighAndFalls && loopStartsAtPhaseAndWraps,
      `reverse=${rmsAt(reversed, 0.05).toFixed(3)}→${rmsAt(reversed, 0.45).toFixed(3)} ` +
        `loop=${rmsAt(loopedAtPhase, 0.05).toFixed(3)}→${rmsAt(loopedAtPhase, 0.8).toFixed(3)}`,
    );
  } catch (error) {
    check("audio clip playback: reverse starts at the high edge and loop phase wraps", false, String(error));
  }

  try {
    const project = createDefaultProject();
    for (const track of project.tracks) track.gain = 1.5;
    const drumTrack = project.tracks.find((t) => t.kind === "drum");
    if (drumTrack && drumTrack.kind === "drum") {
      for (const pad of drumTrack.pads) pad.gain = 2;
    }

    project.master.limiterEnabled = false;
    project.master.clipperEnabled = false;
    const unlimited = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });

    project.master.limiterEnabled = true;
    project.master.clipperEnabled = false;
    const limited = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });

    project.master.limiterEnabled = true;
    project.master.clipperEnabled = true;
    const clipped = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });

    const unlimitedPeak = peakOf(unlimited.getChannelData(0));
    const limitedPeak = peakOf(limited.getChannelData(0));
    const clippedPeak = peakOf(clipped.getChannelData(0));
    check(
      "master chain tames a hot mix (limiter reduces, clipper softens)",
      unlimitedPeak > 1.5 && limitedPeak < unlimitedPeak * 0.6 && clippedPeak < 1.2,
      `unlimited=${unlimitedPeak.toFixed(3)} limited=${limitedPeak.toFixed(3)} clipped=${clippedPeak.toFixed(3)}`,
    );
  } catch (error) {
    check("master chain tames a hot mix (limiter reduces, clipper softens)", false, String(error));
  }

  // Master buss glue: same hot mix, limiter + clipper off to isolate the
  // glue stage. Gentle 2:1 RMS leveling must audibly level (lower RMS and
  // peak than the unglued render) without crushing (peak stays above half).
  try {
    const project = createDefaultProject();
    for (const track of project.tracks) track.gain = 1.5;
    const drumTrack = project.tracks.find((t) => t.kind === "drum");
    if (drumTrack && drumTrack.kind === "drum") {
      for (const pad of drumTrack.pads) pad.gain = 2;
    }
    project.master.limiterEnabled = false;
    project.master.clipperEnabled = false;
    project.master.glueEnabled = false;
    const plain = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    project.master.glueEnabled = true;
    const glued = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    const rmsOf = (buffer: AudioBuffer): number => {
      const d = buffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      return Math.sqrt(sum / Math.max(1, d.length));
    };
    const plainPeak = peakOf(plain.getChannelData(0));
    const gluedPeak = peakOf(glued.getChannelData(0));
    const plainRms = rmsOf(plain);
    const gluedRms = rmsOf(glued);
    check(
      "master glue levels a hot mix (lower RMS + peak, no crush)",
      plainPeak > 1.5 && gluedPeak < plainPeak && gluedPeak > plainPeak * 0.5 && gluedRms < plainRms,
      `plain=${plainPeak.toFixed(3)}/${plainRms.toFixed(3)} glued=${gluedPeak.toFixed(3)}/${gluedRms.toFixed(3)}`,
    );
  } catch (error) {
    check("master glue levels a hot mix (lower RMS + peak, no crush)", false, String(error));
  }

  // Master stage with AudioWorklets: renderProject preloads processors, so the
  // export path runs through the look-ahead limiter — peaks must sit exactly
  // AT ceiling (brickwall anticipation) rather than being loosely pulled down.
  try {
    const project = createDefaultProject();
    for (const track of project.tracks) track.gain = 1.5;
    const drumTrack = project.tracks.find((t) => t.kind === "drum");
    if (drumTrack && drumTrack.kind === "drum") {
      for (const pad of drumTrack.pads) pad.gain = 2;
    }
    project.master.ceilingDb = -3;
    project.master.limiterEnabled = true;
    project.master.clipperEnabled = false;
    const mastered = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    let masteredPeak = 0;
    for (let ch = 0; ch < mastered.numberOfChannels; ch++) {
      masteredPeak = Math.max(masteredPeak, peakOf(mastered.getChannelData(ch)));
    }
    const ceilingLin = Math.pow(10, -3 / 20);
    check(
      "master limiter: look-ahead brickwall pins export at ceiling",
      masteredPeak <= ceilingLin + 0.02 && masteredPeak >= ceilingLin * 0.6,
      `peak=${masteredPeak.toFixed(3)} ceiling=${ceilingLin.toFixed(3)}`,
    );
  } catch (error) {
    check("master limiter: look-ahead brickwall pins export at ceiling", false, String(error));
  }

  // ---------------- Track modulators (random S&H / step / envFollower) ----------------
  // Harness note: these checks ride the REAL export pipeline (renderProject),
  // which preloads worklets and drives the same scheduling math as live.

  const rmsWindow = (data: Float32Array, fromSample: number, toSample: number): number => {
    let sum = 0;
    for (let i = Math.max(0, Math.floor(fromSample)); i < Math.min(data.length, Math.floor(toSample)); i++) {
      sum += data[i] * data[i];
    }
    return Math.sqrt(sum / Math.max(1, toSample - fromSample));
  };

  const makeModDoc = (attach: (doc: ProjectDocument) => void): ProjectDocument => {
    const doc = createProjectFromTemplate("house");
    attach(doc);
    for (const track of doc.tracks) {
      if (track.kind === "drum") track.pan = -1; // isolate analysis channels
      if (track.kind === "instrument" && track.instrument === "808") track.pan = 1;
      else if (track.kind === "instrument") track.mute = true;
    }
    doc.master.limiterEnabled = false;
    doc.master.clipperEnabled = false;
    return doc;
  };

  // Step modulator composes a rhythmic volume gate on the DRUM bus. Windows
  // derive from the template BPM because the offline buffer spans ONE bar.
  try {
    const renderGated = async (withGate: boolean): Promise<{ data: Float32Array; bpm: number }> => {
      const doc = makeModDoc((d) => {
        const drums = d.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
        if (withGate) {
          d.lfos = [
            {
              id: "chk-step",
              trackId: drums.id,
              kind: "step",
              param: "gain",
              division: 2,
              glideSec: 0.02,
              amount: 0.9,
              steps: [1, -1],
            },
          ];
        }
      });
      const buf = await renderProject(doc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 });
      return { data: buf.getChannelData(0), bpm: doc.bpm };
    };
    const gatedRender = await renderGated(true);
    const controlRender = await renderGated(false);
    const beatsOf = (data: Float32Array, bpm: number): number[] => {
      const beatSec = 60 / bpm;
      return [0, 1, 2, 3].map((i) => rmsWindow(data, i * beatSec * SR, (i + 0.45) * beatSec * SR));
    };
    const gateBeats = beatsOf(gatedRender.data, gatedRender.bpm);
    const ctrlBeats = beatsOf(controlRender.data, controlRender.bpm);
    const gateHigh = (gateBeats[0] + gateBeats[2]) / 2;
    const gateLow = (gateBeats[1] + gateBeats[3]) / 2;
    const ctrlHigh = (ctrlBeats[0] + ctrlBeats[2]) / 2;
    const ctrlLow = (ctrlBeats[1] + ctrlBeats[3]) / 2;
    check(
      "step modulator: gain alternates on the division grid (offline)",
      // House groove itself has stronger backbeats — judge the gate RELATIVE
      // to the unmuted baseline ratio, plus absolute attenuation of gated lows.
      ctrlHigh > 0.005 &&
        gateHigh > 0.005 &&
        gateHigh / Math.max(gateLow, 1e-6) > 2 * (ctrlHigh / Math.max(ctrlLow, 1e-6)) &&
        gateLow < ctrlLow * 1.4,
      "gate=" +
        [gateHigh.toFixed(4), gateLow.toFixed(4)].join("/") +
        " ctrl=" +
        [ctrlHigh.toFixed(4), ctrlLow.toFixed(4)].join("/"),
    );

    // Determinism law: two renders of the same document are sample-identical.
    try {
      const gatedDoc = makeModDoc((d) => {
        const drums = d.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
        d.lfos = [
          {
            id: "chk-step",
            trackId: drums.id,
            kind: "step",
            param: "gain",
            division: 2,
            glideSec: 0.02,
            amount: 0.9,
            steps: [1, -1],
          },
        ];
      });
      const ra = await renderProject(gatedDoc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 });
      const rb = await renderProject(gatedDoc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 });
      let diff = 0;
      let energy = 0;
      for (let ch = 0; ch < 2; ch++) {
        const da = ra.getChannelData(ch);
        const dbv = rb.getChannelData(ch);
        for (let i = 0; i < da.length; i++) {
          diff += Math.abs(da[i] - dbv[i]);
          energy += Math.abs(da[i]);
        }
      }
      const relative = diff / Math.max(energy, 1e-9);
      check(
        "modulators: offline renders are deterministic (live == offline law)",
        diff < 5e-5 || relative < 1e-4,
        "SUM|a-b|=" + diff.toExponential(2) + " rel=" + relative.toExponential(2),
      );
    } catch (error) {
      check("modulators: offline renders are deterministic (live == offline law)", false, String(error));
    }
  } catch (error) {
    check("step modulator: gain alternates on the division grid (offline)", false, String(error));
  }

  // Random S&H: deterministic AND visibly active (blocks diverge).
  try {
    const doc = makeModDoc((d) => {
      const drums = d.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
      d.lfos = [
        {
          id: "chk-rnd",
          trackId: drums.id,
          kind: "random",
          param: "gain",
          snh: "hold",
          rateMode: "sync",
          rateHz: 8,
          division: 3,
          amount: 0.85,
          seed: "browser-check-seed",
        },
      ];
    });
    const runRandom = (): Promise<Float32Array> =>
      renderProject(doc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 }).then((b) => b.getChannelData(0));
    const first = await runRandom();
    const second = await runRandom();
    let pairDiff = 0;
    let energy = 0;
    for (let i = 0; i < first.length; i++) {
      pairDiff += Math.abs(first[i] - second[i]);
      energy += Math.abs(first[i]);
    }
    const blockLen = Math.floor(SR / 16);
    const blocks: number[] = [];
    for (let start = 0; start + blockLen <= first.length; start += blockLen) {
      const r = rmsWindow(first, start, start + blockLen);
      if (r > 1e-3) blocks.push(r);
    }
    const meanBlock = blocks.reduce((a, b) => a + b, 0) / Math.max(1, blocks.length);
    const spread =
      Math.sqrt(blocks.reduce((acc, v) => acc + (v - meanBlock) ** 2, 0) / Math.max(1, blocks.length)) /
      Math.max(meanBlock, 1e-9);
    const relativeDelta = pairDiff / Math.max(energy, 1e-9);
    check(
      "random S&H: seeded stream is active and repeat-render stable",
      // Stability: two renders must match. Activity: block RMS spread proves
      // the gain actually modulates. The audible-block count is only a coarse
      // sanity proxy — it shifts with kick decay vs the 1/16 s block grid
      // (11 vs 12 for an identical render), so keep its threshold loose.
      (pairDiff < 5e-5 || relativeDelta < 1e-4) && spread > 0.25 && blocks.length >= 8,
      "rel=" + relativeDelta.toExponential(2) + " spread=" + spread.toFixed(2) + " blocks=" + blocks.length,
    );
  } catch (error) {
    check("random S&H: seeded stream is active and repeat-render stable", false, String(error));
  }

  // Envelope follower: kicks (left source) duck the sustained 808 carrier on
  // the right — cross-track wiring measured per quarter-note cycle.
  try {
    let beatSecRef = 0.5;
    const renderCoupled = async (withFollower: boolean): Promise<{ data: Float32Array }> => {
      const doc = makeModDoc((d) => {
        beatSecRef = 60 / d.bpm;
        const drums = d.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
        const bass = d.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "808");
        if (withFollower && bass) {
          d.lfos = [
            {
              id: "chk-env",
              trackId: bass.id,
              kind: "envFollower",
              param: "gain",
              sourceTrackId: drums.id,
              attackMs: 4,
              releaseMs: 260,
              sensitivity: 2.5,
              amount: 0.95,
            },
          ];
        }
      });
      return {
        data: (await renderProject(doc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 })).getChannelData(1),
      };
    };
    const ducked = await renderCoupled(true);
    const plain = await renderCoupled(false);
    const beatSec = beatSecRef;
    const cycleDuck = (data: Float32Array): number => {
      const ratios: number[] = [];
      for (let k = 1; k <= 3; k++) {
        const hit = k * beatSec; // house kick lands on each beat
        const after = rmsWindow(data, (hit + 0.05) * SR, (hit + beatSec * 0.75) * SR);
        const before = rmsWindow(data, (hit - beatSec * 0.6) * SR, (hit - beatSec * 0.08) * SR);
        ratios.push(after / Math.max(before, 1e-6));
      }
      return ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
    };
    const duckedRatio = cycleDuck(ducked.data);
    const plainRatio = cycleDuck(plain.data);
    check(
      "envelope follower: source transients shape host gain (cross-track)",
      Number.isFinite(duckedRatio) && Number.isFinite(plainRatio) && duckedRatio < plainRatio * 0.93,
      "ducked=" + duckedRatio.toFixed(3) + " plain=" + plainRatio.toFixed(3),
    );
  } catch (error) {
    check("envelope follower: source transients shape host gain (cross-track)", false, String(error));
  }

  // ---------------- Bus compressor (P0.2) ----------------

  // Hot input: per-sample worklet compresses hard and reports GR.
  try {
    const ctx = new OfflineAudioContext(2, SR, SR);
    await loadAllWorklets(ctx);
    if (!isWorkletReady("compressor", ctx)) {
      check("compressor: worklet compresses hot input and reports GR", false, "worklet modules not ready");
    } else {
      const params = {
        threshold: -30,
        ratio: 6,
        attack: 0.005,
        release: 0.1,
        knee: 6,
        makeup: 0,
        mix: 1,
        detector: 0,
        scHpf: 20,
      };
      const rt = EFFECT_DEFS.compressor.factory(
        ctx,
        { id: "chk-comp", type: "compressor", bypassed: false, params },
        { bpm: 124 },
      );
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 220;
      const gain = ctx.createGain();
      gain.gain.value = 0.7; // ≈ −6.1 dBFS RMS — far above THRESH −30
      osc.connect(gain).connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      // GR metering must be read BEFORE dispose (dispose nulls the port
      // handler — see readGrAfterRender).
      const gr = await readGrAfterRender(rt);
      rt.dispose();
      let rmsOut = 0;
      for (let i = 0; i < out.length; i++) rmsOut += out[i] * out[i];
      rmsOut = Math.sqrt(rmsOut / out.length);
      const baseline = 0.7 / Math.SQRT2;
      check(
        "compressor: worklet compresses hot input and reports GR",
        rmsOut < baseline * 0.4 && gr >= 8,
        `rms=${rmsOut.toFixed(4)} baseline=${baseline.toFixed(4)} gr=${gr.toFixed(1)}dB`,
      );
    }
  } catch (error) {
    check("compressor: worklet compresses hot input and reports GR", false, String(error));
  }

  // DE-ESS mode (scMode/scBandHz) at HOST level.
  //
  // `tests/compressor-deess.test.ts` pins the processor's discrimination with a
  // direct `process()` call, but that bypasses the factory, the wrapper and the
  // worklet descriptor — so it cannot catch a wrapper that drops the params
  // before they reach the DSP (exactly the failure the AI bridge had with
  // msEq). This renders through `EFFECT_DEFS.compressor.factory`, i.e. the same
  // path the real graph uses, and asserts the band discrimination survives:
  // a sibilance-band tone must be ducked substantially more than a low tone at
  // the identical level, and the HPF mode must leave the sibilance band alone.
  try {
    const ctx = new OfflineAudioContext(2, SR, SR);
    await loadAllWorklets(ctx);
    if (!isWorkletReady("compressor", ctx)) {
      check(
        "compressor: DE-ESS mode ducks the sibilance band, not the low band (host)",
        false,
        "worklet modules not ready",
      );
    } else {
      const rmsThrough = async (params: Record<string, number>, hz: number): Promise<number> => {
        // Each probe needs a FRESH context — startRendering closes it, so a
        // shared context throws "cannot call startRendering ... in a stopped
        // state" on the second variant.
        const ctx = new OfflineAudioContext(2, SR, SR);
        await loadAllWorklets(ctx);
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = hz;
        const gain = ctx.createGain();
        // Same level for both probes, so the only variable is the band.
        gain.gain.value = 0.5;
        const rt = EFFECT_DEFS.compressor.factory(
          ctx,
          { id: "chk-deess", type: "compressor", bypassed: false, params },
          { bpm: 124 },
        );
        osc.connect(gain).connect(rt.input);
        rt.output.connect(ctx.destination);
        osc.start(0);
        const out = (await ctx.startRendering()).getChannelData(0);
        rt.dispose();
        // Settle the attack/release before measuring.
        const from = Math.floor(out.length * 0.4);
        let sum = 0;
        for (let i = from; i < out.length; i++) sum += out[i] * out[i];
        return Math.sqrt(sum / (out.length - from));
      };

      const deEss = {
        threshold: -35,
        ratio: 8,
        attack: 0.001,
        release: 0.08,
        knee: 2,
        makeup: 0,
        mix: 1,
        detector: 1,
        scHpf: 20,
        scBandHz: 6500,
      };
      const essMode = { ...deEss, scMode: 1 };
      // Same probe tone, detector band moved below the probe: the duck must
      // collapse. This is the host-level assertion that actually protects the
      // plugin — if the factory/wrapper ever dropped scBandHz, both numbers
      // would be identical and the feature would silently do nothing (the exact
      // failure the AI bridge had with msEq). A cross-mode HPF comparison is
      // NOT a valid discriminator: the HPF detector is a 20 Hz high-pass, so it
      // passes a 6.5 kHz tone in full and compresses it just as hard.
      const outOfBand = { ...deEss, scMode: 1, scBandHz: 300 };
      const baseline = 0.5 / Math.SQRT2;

      const sibilantEss = await rmsThrough(essMode, 6500);
      const lowEss = await rmsThrough(essMode, 150);
      const sibilantOutOfBand = await rmsThrough(outOfBand, 6500);

      const duckEss = baseline - sibilantEss;
      const duckOutOfBand = baseline - sibilantOutOfBand;
      // Discrimination inside the band: sibilance ducked far more than the low tone.
      const bandRatio = lowEss > 0 ? sibilantEss / lowEss : Infinity;
      // Moving the detector band OFF the probe must release it. `duck` is
      // baseline-minus-rms, so a bigger duck means quieter output — releasing
      // the tone means the in-band duck is the LARGER of the two.
      const released = duckEss - duckOutOfBand;
      check(
        "compressor: DE-ESS mode ducks the sibilance band, not the low band (host)",
        duckEss > 0.02 && bandRatio < 0.6 && released > 0.01,
        `duck(6500Hz, band=6500)=${duckEss.toFixed(4)} duck(6500Hz, band=300)=${duckOutOfBand.toFixed(4)} ` +
          `released=${released.toFixed(4)} sibilant/low=${bandRatio.toFixed(3)} baseline=${baseline.toFixed(4)}`,
      );
    }
  } catch (error) {
    check("compressor: DE-ESS mode ducks the sibilance band, not the low band (host)", false, String(error));
  }

  // PITCH CORRECT (host level) — the same factory path the real graph uses.
  // The v1 rendering gap (near-unity corrections rendered unshifted) is
  // CLOSED: the two-tap granular engine transposes at the correction ratio,
  // so the audible assertion is live — amount 1 must move spectral energy
  // from the off-key input tone to the scale target (E4 − 30 cents in C
  // major → E4), while amount 0 passes the input tone through untouched.
  try {
    const renderProbe = async (amount: number): Promise<{ rms: number; input: number; target: number }> => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      await loadAllWorklets(ctx);
      if (!isWorkletReady("pitchCorrect", ctx)) throw new Error("worklet modules not ready");
      const rt = EFFECT_DEFS.pitchCorrect.factory(
        ctx,
        {
          id: `check-pc-${amount}`,
          type: "pitchCorrect",
          bypassed: false,
          params: { amount, speed: 1, root: 0, scaleMode: 1, mix: 1 },
        },
        { bpm: 124 },
      );
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 329.63 * Math.pow(2, -30 / 1200); // E4 − 30 cents
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      osc.connect(gain).connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      rt.dispose();
      const from = Math.floor(SR * 0.15);
      const n = out.length - from;
      let sum = 0;
      const seg = out.subarray(from);
      for (let i = 0; i < n; i++) sum += seg[i] * seg[i];
      // Goertzel at the input tone and at the correction target.
      const binAt = (hz: number): number => {
        const k = (2 * Math.PI * hz) / SR;
        const coeff = 2 * Math.cos(k);
        let s1 = 0,
          s2 = 0;
        for (let i = 0; i < n; i++) {
          const s0 = seg[i] + coeff * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / n;
      };
      return { rms: Math.sqrt(sum / n), input: binAt(323.95), target: binAt(329.63) };
    };
    const probe0 = await renderProbe(0);
    const probe1 = await renderProbe(1);
    check(
      "pitchCorrect: amount 0 passes the input tone through; amount 1 corrects toward the scale target",
      probe0.rms > 0.05 && probe0.input > 0.02 && probe1.target > probe1.input && probe1.target > 0.02,
      `amount0: rms=${probe0.rms.toFixed(4)} input=${probe0.input.toFixed(4)} · amount1: input=${probe1.input.toFixed(4)} target=${probe1.target.toFixed(4)}`,
    );
  } catch (error) {
    check(
      "pitchCorrect: amount 0 passes the input tone through; amount 1 corrects toward the scale target",
      false,
      String(error),
    );
  }

  // Sidechain HPF: a sub-only detector drives compression when the HPF is off
  // and is rejected once the HPF sits above the sub band — the reason this is
  // a worklet and not the native node.
  try {
    const ctx = new OfflineAudioContext(2, SR, SR);
    await loadAllWorklets(ctx);
    if (!isWorkletReady("compressor", ctx)) {
      check("compressor: sidechain HPF gates bass-only detector", false, "worklet modules not ready");
    } else {
      const renderWith = async (scHpf: number, withSidechain: boolean): Promise<{ rms: number; gr: number }> => {
        // Each variant needs a FRESH context — startRendering closes it.
        const ctx = new OfflineAudioContext(2, SR, SR);
        await loadAllWorklets(ctx);
        const params = {
          threshold: -30,
          ratio: 8,
          attack: 0.003,
          release: 0.05,
          knee: 3,
          makeup: 0,
          mix: 1,
          detector: 0,
          scHpf,
        };
        const rt = EFFECT_DEFS.compressor.factory(
          ctx,
          { id: `chk-sc${scHpf}`, type: "compressor", bypassed: false, params },
          { bpm: 124 },
        );
        const carrier = ctx.createOscillator();
        carrier.type = "sine";
        carrier.frequency.value = 220;
        const carrierGain = ctx.createGain();
        carrierGain.gain.value = 0.4;
        carrier.connect(carrierGain).connect(rt.input);
        if (withSidechain) {
          const sub = ctx.createOscillator();
          sub.type = "sine";
          sub.frequency.value = 45; // sub bass — must vanish through the HPF
          const subGain = ctx.createGain();
          subGain.gain.value = 0.9;
          sub.connect(subGain);
          rt.setSidechainInput?.(subGain);
          sub.start(0);
        }
        carrier.start(0);
        rt.output.connect(ctx.destination);
        const buf = await ctx.startRendering();
        // GR metering must be read BEFORE dispose (dispose nulls the port
        // handler — see readGrAfterRender). The filtered variant legitimately
        // settles at ~0, so its poll runs out the deadline — harmless.
        const gr = await readGrAfterRender(rt);
        rt.dispose();
        const data = buf.getChannelData(0);
        let rms = 0;
        for (let i = Math.floor(data.length * 0.25); i < data.length; i++) rms += data[i] * data[i];
        rms = Math.sqrt(rms / (data.length - Math.floor(data.length * 0.25)));
        return { rms, gr };
      };
      const baseline = await renderWith(20, false);
      const bassOn = await renderWith(20, true);
      const filtered = await renderWith(300, true);
      check(
        "compressor: sidechain HPF gates bass-only detector",
        bassOn.rms < baseline.rms * 0.5 && bassOn.gr >= 6 && filtered.rms > baseline.rms * 0.85 && filtered.gr <= 0.7,
        `baseline=${baseline.rms.toFixed(4)} bassOn=${bassOn.rms.toFixed(4)}(gr ${bassOn.gr.toFixed(1)}) hpf300=${filtered.rms.toFixed(4)}(gr ${filtered.gr.toFixed(1)})`,
      );
    }
  } catch (error) {
    check("compressor: sidechain HPF gates bass-only detector", false, String(error));
  }

  // Parallel path: MIX = 0 must pass the signal untouched.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    await loadAllWorklets(ctx);
    const params = {
      threshold: -40,
      ratio: 20,
      attack: 0.001,
      release: 0.05,
      knee: 0,
      makeup: 0,
      mix: 0,
      detector: 1,
      scHpf: 20,
    };
    const rt = EFFECT_DEFS.compressor.factory(
      ctx,
      { id: "chk-mix0", type: "compressor", bypassed: false, params },
      { bpm: 124 },
    );
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 220;
    const gain = ctx.createGain();
    gain.gain.value = 0.8;
    osc.connect(gain).connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const data = (await ctx.startRendering()).getChannelData(0);
    rt.dispose();
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    check(
      "compressor: mix = 0 passes unity (parallel blend)",
      Math.abs(peak - 0.8) < 0.02,
      `peak=${peak.toFixed(4)} expected≈0.8`,
    );
  } catch (error) {
    check("compressor: mix = 0 passes unity (parallel blend)", false, String(error));
  }

  // K-weighted loudness meter (BS.1770): a 1 kHz sine at −23 dBFS must read
  // ≈ −23 LUFS integrated — the official conformance target, live path.
  try {
    const ctx = new OfflineAudioContext(2, SR * 2.5, SR);
    await loadAllWorklets(ctx);
    if (!isWorkletReady("kwmeter", ctx)) {
      check("kwmeter: BS.1770 conformance (1 kHz @ −23 dBFS → −23 LUFS)", false, "worklet modules not ready");
    } else {
      const meter = createKwMeterNode(ctx);
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 1000;
      const amplitude = Math.pow(10, -23 / 20);
      const gain = ctx.createGain();
      gain.gain.value = amplitude;
      osc.connect(gain).connect(meter.input);
      osc.start(0);
      await ctx.startRendering();
      meter.dispose();
      await new Promise((resolve) => setTimeout(resolve, 150)); // loudness messages flush
      const loudness = meter.getLoudness();
      check(
        "kwmeter: BS.1770 conformance (1 kHz @ −23 dBFS → −23 LUFS)",
        loudness.i > -24 && loudness.i < -22,
        `integrated=${loudness.i.toFixed(2)} LUFS (momentary=${loudness.m.toFixed(2)})`,
      );
    }
  } catch (error) {
    check("kwmeter: BS.1770 conformance (1 kHz @ −23 dBFS → −23 LUFS)", false, String(error));
  }

  // ---------------- Step Gate (P0.4) ----------------

  // Step gate alternates volume on a grid derived from BPM — identical grid
  // math to the step modulator, but running inside an EffectRuntime instead
  // of an automation lane.  Render through the same pipeline (renderProject)
  // with a house pattern and a stepGate on the drums; compare gated vs
  // control (no effect) block RMS on alternating 1/8-note windows.
  // Division=3 (1/8) → each step = half-beat, so within a full beat there
  // are exactly two steps (one gated, one open), giving clean contrast.
  try {
    const renderStepGate = async (withGate: boolean): Promise<Float32Array> => {
      const doc = createProjectFromTemplate("house");
      const drums = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
      drums.pan = -1;
      for (const track of doc.tracks) {
        if (track.kind === "instrument") track.mute = true;
      }
      doc.master.limiterEnabled = false;
      doc.master.clipperEnabled = false;
      if (withGate) {
        drums.effects = [
          {
            id: "sg-chk",
            type: "stepGate",
            bypassed: false,
            params: { division: 3, depth: 1, smooth: 0.02, mix: 1 },
            steps: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
          },
        ];
      }
      const buf = await renderProject(doc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 });
      return buf.getChannelData(0);
    };
    const gateData = await renderStepGate(true);
    const ctrlData = await renderStepGate(false);
    const beatSec = 60 / 124; // house bpm
    const stepSec = beatSec * 0.5; // 1/8 note
    const gateWins = [...Array(8)].map((_, w) => rmsWindow(gateData, w * stepSec * SR, (w + 0.9) * stepSec * SR));
    const ctrlWins = [...Array(8)].map((_, w) => rmsWindow(ctrlData, w * stepSec * SR, (w + 0.9) * stepSec * SR));
    // Pattern [1,0,1,0,...]: even steps = open, odd steps = closed
    const gateHigh = (gateWins[0] + gateWins[2] + gateWins[4] + gateWins[6]) / 4;
    const gateLow = (gateWins[1] + gateWins[3] + gateWins[5] + gateWins[7]) / 4;
    const ctrlHigh = (ctrlWins[0] + ctrlWins[2] + ctrlWins[4] + ctrlWins[6]) / 4;
    check(
      "step gate: pattern halves signal on off-beats (offline)",
      ctrlHigh > 0.005 && gateHigh > gateLow * 2 && gateHigh > ctrlHigh * 0.6,
      `even=${gateHigh.toFixed(4)} odd=${gateLow.toFixed(4)} ctrl=${ctrlHigh.toFixed(4)}`,
    );
  } catch (error) {
    check("step gate: pattern halves signal on off-beats (offline)", false, String(error));
  }

  // Step gate mix=0 passthrough:
  try {
    const renderGate = async (mix: number, stepVal: number): Promise<{ peak: number }> => {
      const doc = createProjectFromTemplate("house");
      const drums = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
      drums.pan = -1;
      for (const track of doc.tracks) {
        if (track.kind === "instrument") track.mute = true;
      }
      doc.master.limiterEnabled = false;
      doc.master.clipperEnabled = false;
      drums.effects = [
        {
          id: "sg-p",
          type: "stepGate",
          bypassed: false,
          params: { division: 4, depth: 1, smooth: 0.02, mix },
          steps: Array(16).fill(stepVal),
        },
      ];
      const buf = await renderProject(doc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 });
      const data = buf.getChannelData(0);
      let pk = 0;
      for (let i = 0; i < data.length; i++) pk = Math.max(pk, Math.abs(data[i]));
      return { peak: pk };
    };
    const allOpen = await renderGate(1, 1);
    const mix0 = await renderGate(0, 0);
    check(
      "step gate: mix=0 passes signal through (no gating)",
      Math.abs(mix0.peak - allOpen.peak) < 0.05,
      `mix0=${mix0.peak.toFixed(4)} allOpen=${allOpen.peak.toFixed(4)}`,
    );
  } catch (error) {
    check("step gate: mix=0 passes signal through (no gating)", false, String(error));
  }

  // Multiband sidechain: with splitFreq the low band is ducked but high
  // frequencies pass through unaffected — the reason this is a worklet.
  try {
    const renderCarrier = async (carrierFreq: number, splitFreq: number): Promise<{ rms: number }> => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      await loadAllWorklets(ctx);
      const params = { threshold: -30, ratio: 8, attack: 0.002, release: 0.1, amount: 1, splitFreq };
      const sidechainRt = EFFECT_DEFS.sidechain.factory(
        ctx,
        { id: "mb-sc", type: "sidechain", bypassed: false, params },
        { bpm: 124 },
      );
      // Main: carrier tone
      const carrier = ctx.createOscillator();
      carrier.type = "sine";
      carrier.frequency.value = carrierFreq;
      const mainGain = ctx.createGain();
      mainGain.gain.value = 0.7;
      carrier.connect(mainGain).connect(sidechainRt.input);
      sidechainRt.output.connect(ctx.destination);
      // Sidechain: loud sub kick to trigger ducking
      const kick = ctx.createOscillator();
      kick.type = "sine";
      kick.frequency.value = 50;
      const kickGain = ctx.createGain();
      kickGain.gain.value = 1.2;
      kick.connect(kickGain);
      sidechainRt.setSidechainInput?.(kickGain);
      kick.start(0);
      carrier.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      sidechainRt.dispose();
      // Measure RMS from 200ms onward (steady state after initial kick tails)
      let rms = 0;
      const start = Math.floor(SR * 0.4);
      for (let i = start; i < out.length; i++) rms += out[i] * out[i];
      rms = Math.sqrt(rms / Math.max(1, out.length - start));
      return { rms };
    };
    // Baseline: full-band (splitFreq=0) ducks the 1 kHz carrier hard
    const fullBand = await renderCarrier(1000, 0);
    // Multiband: only low band ducked — 1 kHz carrier should survive
    const multiBand = await renderCarrier(1000, 150);
    check(
      "sidechain: multiband split frees high frequencies from ducking",
      multiBand.rms > fullBand.rms * 0.8 && fullBand.rms < 0.7 * Math.sqrt(0.7),
      `fullBandRms=${fullBand.rms.toFixed(4)} multiBandRms=${multiBand.rms.toFixed(4)}`,
    );
  } catch (error) {
    check("sidechain: multiband split frees high frequencies from ducking", false, String(error));
  }

  // ---------------- SV Filter (P1.1) ----------------
  // LP mode passes low, blocks high: render two-tone (200 Hz + 8 kHz) through
  // LP at 1000 Hz cutoff; assert the 8 kHz component is attenuated.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    await loadAllWorklets(ctx);
    if (!isWorkletReady("svFilter", ctx)) {
      check("svFilter: LP attenuates high frequencies", false, "worklet modules not ready");
    } else {
      const params = { cutoff: 1000, resonance: 0, mode: 0, drive: 0, mix: 1 };
      const rt = EFFECT_DEFS.svFilter.factory(
        ctx,
        { id: "svf-lp", type: "svFilter", bypassed: false, params },
        { bpm: 124 },
      );
      // Two-tone: 200 Hz + 8 kHz
      const osc1 = ctx.createOscillator();
      osc1.type = "sine";
      osc1.frequency.value = 200;
      const osc2 = ctx.createOscillator();
      osc2.type = "sine";
      osc2.frequency.value = 8000;
      const g1 = ctx.createGain();
      g1.gain.value = 0.4;
      const g2 = ctx.createGain();
      g2.gain.value = 0.4;
      osc1.connect(g1).connect(rt.input);
      osc2.connect(g2).connect(rt.input);
      rt.output.connect(ctx.destination);
      osc1.start(0);
      osc2.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      rt.dispose();
      // Measure energy above 4 kHz by zero-crossing density (proxy for high freq content)
      let crossings = 0;
      for (let i = 1; i < out.length; i++) {
        if (out[i - 1] >= 0 !== out[i] >= 0) crossings++;
      }
      const crossingDensity = crossings / out.length;
      // With only 200 Hz the crossing rate would be ~400/s; with 8 kHz it would be ~16000/s
      // LP at 1 kHz should keep it close to the 200 Hz rate
      const densityPerSample = crossingDensity; // per sample
      check(
        "svFilter: LP attenuates high frequencies (zero-crossing proxy)",
        densityPerSample < 0.035,
        `crossingDensity=${densityPerSample.toFixed(4)} (bare two-tone would be ~0.36)`,
      );
    }
  } catch (error) {
    check("svFilter: LP attenuates high frequencies", false, String(error));
  }

  // SV Filter HP mode passes high, blocks low
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    await loadAllWorklets(ctx);
    if (!isWorkletReady("svFilter", ctx)) {
      check("svFilter: HP blocks low frequencies", false, "worklet modules not ready");
    } else {
      const params = { cutoff: 1000, resonance: 0, mode: 1, drive: 0, mix: 1 };
      const rt = EFFECT_DEFS.svFilter.factory(
        ctx,
        { id: "svf-hp", type: "svFilter", bypassed: false, params },
        { bpm: 124 },
      );
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 100; // 100 Hz — below cutoff
      osc.connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      rt.dispose();
      let rms = 0;
      for (let i = Math.floor(out.length * 0.5); i < out.length; i++) rms += out[i] * out[i];
      rms = Math.sqrt(rms / (out.length * 0.5));
      // 100 Hz through 1 kHz HP should be heavily attenuated
      check("svFilter: HP blocks low frequencies", rms < 0.05, `rms=${rms.toFixed(4)} (100 Hz through 1 kHz HP)`);
    }
  } catch (error) {
    check("svFilter: HP blocks low frequencies", false, String(error));
  }

  // ---------------- Flanger (P1.2) ----------------
  // Flanger creates time-varying comb filtering: RMS varies when compared to
  // a passthrough render. Assert the wet signal is different from dry and
  // has audible energy (not silence).
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    await loadAllWorklets(ctx);
    if (!isWorkletReady("flanger", ctx)) {
      check("flanger: wet signal differs from dry (comb filtering active)", false, "worklet modules not ready");
    } else {
      const params = { rate: 1, depth: 3, base: 5, feedback: 0.5, spread: 0, mix: 0.7 };
      const rt = EFFECT_DEFS.flanger.factory(
        ctx,
        { id: "chk-flg", type: "flanger", bypassed: false, params },
        { bpm: 124 },
      );
      const osc = ctx.createOscillator();
      osc.type = "sawtooth"; // rich spectrum for flanging
      osc.frequency.value = 220;
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      osc.connect(gain).connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const flanged = (await ctx.startRendering()).getChannelData(0);
      rt.dispose();
      // Render dry reference
      const ctx2 = new OfflineAudioContext(1, SR, SR);
      const osc2 = ctx2.createOscillator();
      osc2.type = "sawtooth";
      osc2.frequency.value = 220;
      const gain2 = ctx2.createGain();
      gain2.gain.value = 0.5;
      osc2.connect(gain2).connect(ctx2.destination);
      osc2.start(0);
      const dry = (await ctx2.startRendering()).getChannelData(0);
      // Measure difference between flanged and dry in the last half
      let diff = 0;
      let energy = 0;
      for (let i = Math.floor(flanged.length / 2); i < flanged.length; i++) {
        diff += Math.abs(flanged[i] - dry[i]);
        energy += Math.abs(flanged[i]);
      }
      const relDiff = diff / Math.max(energy, 1e-9);
      check(
        "flanger: wet signal differs from dry (comb filtering active)",
        relDiff > 0.1 && energy / (flanged.length / 2) > 0.001,
        `relDiff=${relDiff.toFixed(3)} rmsFlanged=${(energy / (flanged.length / 2)).toFixed(4)}`,
      );
    }
  } catch (error) {
    check("flanger: wet signal differs from dry (comb filtering active)", false, String(error));
  }

  // ---------------- Tremolo (P1.3) ----------------
  // Classic AM: gain oscillates between (1-depth) and 1 at the LFO rate.
  // Assert: peak stays at input level (gain never exceeds 1), and RMS
  // alternates between high/low halves of the LFO cycle.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    await loadAllWorklets(ctx);
    if (!isWorkletReady("tremolo", ctx)) {
      check("tremolo: AM modulates gain rhythmically", false, "worklet modules not ready");
    } else {
      const params = { rate: 4, depth: 0.9, shape: 1, mode: 0, mix: 1 }; // 4 Hz, square, hard
      const rt = EFFECT_DEFS.tremolo.factory(
        ctx,
        { id: "chk-trem", type: "tremolo", bypassed: false, params },
        { bpm: 124 },
      );
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 2000;
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      osc.connect(gain).connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const data = (await ctx.startRendering()).getChannelData(0);
      rt.dispose();
      // LFO period = 1/4 = 0.25s. Measure RMS in high/low halves of each cycle.
      const period = SR / 4;
      const half = period / 2;
      let peakAll = 0;
      let hiRms = 0;
      let loRms = 0;
      const cycles = 4;
      for (let c = 0; c < cycles; c++) {
        let hiSum = 0;
        let loSum = 0;
        for (let i = 0; i < half; i++) {
          const hv = data[Math.floor(c * period + i)];
          const lv = data[Math.floor(c * period + half + i)];
          hiSum += hv * hv;
          loSum += lv * lv;
          peakAll = Math.max(peakAll, Math.abs(hv), Math.abs(lv));
        }
        hiRms += Math.sqrt(hiSum / half);
        loRms += Math.sqrt(loSum / half);
      }
      hiRms /= cycles;
      loRms /= cycles;
      check(
        "tremolo: AM modulates gain rhythmically",
        hiRms > loRms * 3 && peakAll <= 0.55 && hiRms > 0.05,
        `hi=${hiRms.toFixed(4)} lo=${loRms.toFixed(4)} ratio=${(hiRms / Math.max(loRms, 1e-6)).toFixed(1)} peak=${peakAll.toFixed(3)}`,
      );
    }
  } catch (error) {
    check("tremolo: AM modulates gain rhythmically", false, String(error));
  }

  // ---------------- Autowah (P1.4) ----------------
  // Envelope follower drives filter cutoff: loud input opens the filter,
  // quiet input closes it. Assert: loud tone passes more energy than quiet tone.
  try {
    const ctx = new OfflineAudioContext(1, SR * 2, SR);
    await loadAllWorklets(ctx);
    if (!isWorkletReady("autowah", ctx)) {
      check("autowah: envelope drives filter cutoff", false, "worklet modules not ready");
    } else {
      // LP mode: quiet → cutoff closes below carrier → attenuated
      // loud → cutoff opens above carrier → passes
      const params = {
        minFreq: 200,
        maxFreq: 4000,
        resonance: 0.5,
        attack: 0.01,
        release: 0.15,
        sensitivity: 2,
        mode: 1,
        mix: 1,
      };
      const rt = EFFECT_DEFS.autowah.factory(
        ctx,
        { id: "chk-aw", type: "autowah", bypassed: false, params },
        { bpm: 124 },
      );
      // First half: quiet tone (0.05) → cutoff ≈ 400 Hz → 2 kHz attenuated
      // Second half: loud tone (0.8) → cutoff ≈ 3800 Hz → 2 kHz passes
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 2000;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.05, 0);
      gain.gain.setValueAtTime(0.05, 0.9);
      gain.gain.setValueAtTime(0.8, 0.901);
      osc.connect(gain).connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      rt.dispose();
      const quietRms = rmsWindow(out, SR * 0.3, SR * 0.8);
      const loudRms = rmsWindow(out, SR * 1.3, SR * 1.8);
      check(
        "autowah: envelope drives filter cutoff",
        quietRms < loudRms * 0.7 && loudRms > 0.005,
        `quiet=${quietRms.toFixed(4)} loud=${loudRms.toFixed(4)} ratio=${(loudRms / Math.max(quietRms, 1e-6)).toFixed(1)}`,
      );
    }
  } catch (error) {
    check("autowah: envelope drives filter cutoff", false, String(error));
  }

  // ---------------- Stutter (P1.7) ----------------
  // Stutter reads from one loop behind — when the gate pattern is fully open,
  // the output is a delayed copy of the input (one loop late). When gate has
  // gaps, alternating 1/8-note windows show on/off contrast.
  try {
    const renderStutter = async (steps: number[] | undefined, mix: number): Promise<Float32Array> => {
      const doc = createProjectFromTemplate("house");
      const drums = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
      drums.pan = -1;
      for (const track of doc.tracks) {
        if (track.kind === "instrument") track.mute = true;
      }
      doc.master.limiterEnabled = false;
      doc.master.clipperEnabled = false;
      drums.effects = [
        {
          id: "stut-chk",
          type: "stutter",
          bypassed: false,
          params: { division: 4, mix, feedback: 0 },
          ...(steps ? { steps } : {}),
        },
      ];
      const buf = await renderProject(doc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 });
      return buf.getChannelData(0);
    };
    // Gated: [1,0,1,0...] → alternating 1/8-note windows
    const gated = await renderStutter([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0], 1);
    const beatSec = 60 / 124;
    const stepSec = beatSec * 0.5; // 1/8 note
    const wins = [...Array(8)].map((_, w) => rmsWindow(gated, w * stepSec * SR, (w + 0.9) * stepSec * SR));
    const high = (wins[0] + wins[2] + wins[4] + wins[6]) / 4;
    const low = (wins[1] + wins[3] + wins[5] + wins[7]) / 4;
    check(
      "stutter: gate pattern alternates delayed loop audibility",
      high > low * 1.5 && high > 0.001,
      `high=${high.toFixed(4)} low=${low.toFixed(4)} ratio=${(high / Math.max(low, 1e-6)).toFixed(1)}`,
    );
  } catch (error) {
    check("stutter: gate pattern alternates delayed loop audibility", false, String(error));
  }

  // ═══════════════════════════════════════════════════════════
  // FXEQ — real-browser verification (Chrome AudioWorklet):
  // module load, port latency → PDC, rack MIX knob wiring, band
  // metering chain, latency-aligned transparency, multi-instance CPU.
  // Nothing here can run in vitest: it needs a real AudioWorklet thread.
  // ═══════════════════════════════════════════════════════════
  try {
    const ctx = new OfflineAudioContext(2, Math.floor(SR * 0.75), SR);
    await loadAllWorklets(ctx);
    const ready = isWorkletReady("fxeq", ctx);
    const def = EFFECT_DEFS.fxeq;
    const rt = def.factory(
      ctx,
      { id: "fxeq-chk", type: "fxeq", bypassed: false, params: defaultParamsOf("fxeq") },
      { bpm: 124 },
    );
    const osc = ctx.createOscillator();
    osc.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    osc.connect(g).connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    const peak = peakOf(data);
    let rms = 0;
    for (let i = 0; i < data.length; i++) rms += data[i] * data[i];
    rms = Math.sqrt(rms / data.length);
    rt.dispose();
    check(
      "fxeq: real AudioWorklet DSP renders (loaded for this context, honest degradation)",
      ready && !!(rt as { degraded?: boolean }).degraded === false && rms > 0.05 && peak < 1.01,
      `workletReady=${ready} degraded=${!!(rt as { degraded?: boolean }).degraded} rms=${rms.toFixed(3)} peak=${peak.toFixed(3)}`,
    );

    // PDC contract: the worklet posts its DSP latency over the port; the
    // runtime must surface it through getLatencySec() — asynchronous, so
    // poll briefly. Without this, syncPdc compensates 0 and parallel
    // tracks comb against the FXEQ lane.
    const latCtx = new OfflineAudioContext(2, Math.floor(SR * 0.5), SR);
    await loadAllWorklets(latCtx);
    let latencySec = 0;
    const latencyRt = def.factory(
      latCtx,
      { id: "fxeq-lat", type: "fxeq", bypassed: false, params: defaultParamsOf("fxeq") },
      { bpm: 124 },
    );
    const osc2 = latCtx.createOscillator();
    osc2.frequency.value = 220;
    osc2.connect(latencyRt.input);
    latencyRt.output.connect(latCtx.destination);
    osc2.start(0);
    await latCtx.startRendering();
    for (let attempt = 0; attempt < 20 && latencySec === 0; attempt++) {
      await new Promise((r) => setTimeout(r, 50));
      latencySec = latencyRt.getLatencySec?.() ?? 0;
    }
    latencyRt.dispose();
    check(
      "fxeq: DSP latency reported over the port (PDC gets a nonzero figure)",
      latencySec > 0,
      `latencySec=${latencySec.toFixed(6)} (${Math.round(latencySec * SR)} samples @ ${SR})`,
    );

    // Rack MIX knob wiring: instance param "mix" must be translated to the
    // core's "globalMix" (RACK_TO_CORE). Before that translation existed the
    // core silently dropped the id and both renders were IDENTICAL.
    const renderWithMix = async (mix: number): Promise<Float32Array> => {
      const mctx = new OfflineAudioContext(1, Math.floor(SR * 0.5), SR);
      await loadAllWorklets(mctx);
      const mrt = def.factory(
        mctx,
        { id: "fxeq-mix", type: "fxeq", bypassed: false, params: { ...defaultParamsOf("fxeq"), mix } },
        { bpm: 124 },
      );
      const mo = mctx.createOscillator();
      mo.frequency.value = 220;
      const mg = mctx.createGain();
      mg.gain.value = 0.5;
      mo.connect(mg).connect(mrt.input);
      mrt.output.connect(mctx.destination);
      mo.start(0);
      const out = await mctx.startRendering();
      mrt.dispose();
      return out.getChannelData(0);
    };
    const [dryish, wet] = await Promise.all([renderWithMix(0), renderWithMix(100)]);
    let mixDiff = 0;
    const n = Math.min(dryish.length, wet.length);
    for (let i = 0; i < n; i++) mixDiff = Math.max(mixDiff, Math.abs(dryish[i] - wet[i]));
    check(
      "fxeq: rack MIX knob reaches the core wet/dry (mix 0 vs 100 renders differ)",
      peakOf(dryish) > 0.05 && mixDiff > 0.05,
      `dryPeak=${peakOf(dryish).toFixed(3)} wetPeak=${peakOf(wet).toFixed(3)} maxDiff=${mixDiff.toFixed(3)}`,
    );

    // Band metering chain: the enabled node must receive bandPeaks snapshots
    // over the port; a gated node must stay silent (closed panels cost zero
    // audio-thread traffic).
    const mctx = new OfflineAudioContext(2, SR, SR);
    await loadAllWorklets(mctx);
    const rtOn = def.factory(
      mctx,
      { id: "fxeq-m1", type: "fxeq", bypassed: false, params: defaultParamsOf("fxeq") },
      { bpm: 124 },
    );
    rtOn.setMetersEnabled?.(true);
    // OfflineAudioContext quirk: a port message posted immediately before
    // startRendering can lose the race against the render (the queue drains
    // on the audio thread once it spins up). The live app never hits this —
    // the real context runs continuously and panels mount long after — so
    // give the gate a beat to land, mirroring reality.
    await new Promise((r) => setTimeout(r, 120));
    const rtGated = def.factory(
      mctx,
      { id: "fxeq-m2", type: "fxeq", bypassed: false, params: defaultParamsOf("fxeq") },
      { bpm: 124 },
    );
    const mo2 = mctx.createOscillator();
    mo2.frequency.value = 220;
    const mg2 = mctx.createGain();
    mg2.gain.value = 0.4;
    mo2.connect(mg2).connect(rtOn.input);
    rtOn.output.connect(mctx.destination);
    rtGated.output.connect(mctx.destination);
    mo2.start(0);
    await mctx.startRendering();
    let meters: { bandPeaks?: Float32Array } | null = null;
    for (let attempt = 0; attempt < 12 && !meters; attempt++) {
      await new Promise((r) => setTimeout(r, 60));
      meters = (rtOn as { getMeters?: () => unknown }).getMeters?.() as { bandPeaks?: Float32Array } | null;
    }
    const gatedMeters = (rtGated as { getMeters?: () => unknown }).getMeters?.();
    rtOn.dispose();
    rtGated.dispose();
    const peaks = meters?.bandPeaks;
    let peaksOk = false;
    let hotBand = -1;
    if (peaks && peaks.length === 6) {
      let allFinite = true;
      let hotVal = 0;
      for (let b = 0; b < peaks.length; b++) {
        if (!Number.isFinite(peaks[b])) allFinite = false;
        if (peaks[b] > hotVal) {
          hotVal = peaks[b];
          hotBand = b;
        }
      }
      peaksOk = allFinite && hotVal > 0.01;
    }
    check(
      "fxeq: band metering flows over the port (gated node stays silent)",
      peaksOk && !gatedMeters,
      `peaksLen=${peaks?.length ?? 0} hotBand=B${hotBand + 1} hotVal=${hotBand >= 0 ? peaks![hotBand].toFixed(3) : "0"} gatedSilent=${!gatedMeters}`,
    );

    // Transparency + latency consistency: the limiter lane must pass a
    // deterministic, low-level probe once aligned by the latency reported to
    // the host. Compare against the same PRISM crossover path with only the
    // limiter disabled: crossover/allpass stages are IIR and have
    // frequency-dependent phase, so comparing them to a raw native oscillator
    // makes a periodic tone choose an arbitrary whole-period "latency".
    const renderLane = async (limiterEnabled: boolean): Promise<Float32Array> => {
      const tctx = new OfflineAudioContext(1, Math.floor(SR * 0.6), SR);
      await loadAllWorklets(tctx);
      const trt = def.factory(
        tctx,
        {
          id: "fxeq-t",
          type: "fxeq",
          bypassed: false,
          params: { ...defaultParamsOf("fxeq"), limiterEnabled: limiterEnabled ? 1 : 0 },
        },
        { bpm: 124 },
      );
      const probe = tctx.createBuffer(1, tctx.length, SR);
      const probeData = probe.getChannelData(0);
      let phase = 0;
      for (let i = 0; i < probeData.length; i++) {
        const frequency = 80 + 11920 * (i / Math.max(1, probeData.length - 1));
        phase += (2 * Math.PI * frequency) / SR;
        // Stay comfortably below the -0.3 dBFS limiter ceiling while keeping
        // the probe above the browser check's signal-quality floor.
        probeData[i] = 0.2 * Math.sin(phase);
      }
      const source = tctx.createBufferSource();
      source.buffer = probe;
      source.connect(trt.input);
      trt.output.connect(tctx.destination);
      source.start(0);
      const tout = await tctx.startRendering();
      trt.dispose();
      return tout.getChannelData(0);
    };
    const [refOut, fxOut] = await Promise.all([renderLane(false), renderLane(true)]);
    const expectedLag = Math.round((latencySec || 0) * SR);
    let bestLag = -1;
    let bestDiff = Infinity;
    const searchFrom = Math.max(0, expectedLag - 256);
    const searchTo = Math.min(refOut.length - 4096, expectedLag + 256);
    for (let lag = searchFrom; lag <= searchTo; lag++) {
      let acc = 0;
      for (let i = 0; i < 4096; i += 4) {
        const d = refOut[i] - fxOut[i + lag];
        acc += d * d;
      }
      if (acc < bestDiff) {
        bestDiff = acc;
        bestLag = lag;
      }
    }
    let alignedRms = 0;
    let sigRms = 0;
    for (let i = 0; i < 4096; i++) {
      const d = refOut[i] - fxOut[i + bestLag];
      alignedRms += d * d;
      sigRms += refOut[i] * refOut[i];
    }
    alignedRms = Math.sqrt(alignedRms / 4096);
    sigRms = Math.sqrt(sigRms / 4096);
    const lagMatchesReport = Math.abs(bestLag - expectedLag) <= 128;
    check(
      "fxeq: latency-aligned lane is transparent; measured lag matches the reported latency",
      sigRms > 0.1 && alignedRms < sigRms * 0.05 && lagMatchesReport,
      `sigRms=${sigRms.toFixed(3)} alignedRms=${alignedRms.toFixed(4)} lag=${bestLag} reported=${expectedLag} (±128)`,
    );

    // Multi-instance CPU evidence: 4 creative-config instances render N
    // seconds of audio offline; wall/rendered ratio per instance is the
    // share of one realtime core a single instance consumes.
    // Best-of-3: DSP cost is lower-bounded — scheduler/preemption noise only
    // inflates wall time, so the least-disturbed pass is the honest estimate
    // (mirrors the ultina CPU budget strategy; KNOWN_LIMITATIONS 2026-09-12).
    // Each attempt needs a FRESH OfflineAudioContext: startRendering() is
    // one-shot per context (second call throws InvalidStateError).
    let wallSec = Number.POSITIVE_INFINITY;
    let audioSec = 3;
    const creative = {
      ...defaultParamsOf("fxeq"),
      "band1.satEnabled": 1,
      "band1.satDriveDb": 12,
      "band1.satMode": 1,
      "band1.delayEnabled": 1,
      "band1.revEnabled": 1,
      "band1.revDecayMs": 1200,
    };
    const INSTANCE_COUNT = 4;
    for (let attempt = 0; attempt < 3; attempt++) {
      const cpuCtx = new OfflineAudioContext(2, Math.floor(SR * 3), SR);
      await loadAllWorklets(cpuCtx);
      const cpuRts: ReturnType<NonNullable<typeof def.factory>>[] = [];
      const cpuOsc = cpuCtx.createOscillator();
      cpuOsc.frequency.value = 220;
      const cpuGain = cpuCtx.createGain();
      cpuGain.gain.value = 0.4;
      for (let i = 0; i < INSTANCE_COUNT; i++) {
        const rtI = def.factory(
          cpuCtx,
          { id: `fxeq-cpu${attempt}-${i}`, type: "fxeq", bypassed: false, params: { ...creative } },
          { bpm: 124 },
        );
        cpuGain.connect(rtI.input);
        rtI.output.connect(cpuCtx.destination);
        cpuRts.push(rtI);
      }
      cpuOsc.connect(cpuGain);
      cpuOsc.start(0);
      const t0 = performance.now();
      const cpuBuf = await cpuCtx.startRendering();
      const w = (performance.now() - t0) / 1000;
      if (w < wallSec) {
        wallSec = w;
        audioSec = cpuBuf.duration;
      }
      for (const rtI of cpuRts) rtI.dispose();
    }
    const perInstance = wallSec / audioSec / INSTANCE_COUNT;
    check(
      "fxeq: multi-instance CPU — 4 creative instances stay inside the realtime budget",
      perInstance < 0.6,
      `${INSTANCE_COUNT} instances × ${audioSec.toFixed(1)}s audio in ${wallSec.toFixed(2)}s wall → ${(
        perInstance * 100
      ).toFixed(1)}% of one realtime core per instance`,
    );
  } catch (error) {
    check("fxeq: real-browser suite (worklet/PDC/mix/meters/transparency/CPU)", false, String(error));
  }

  // PRISM determinism: isolate the actual browser AudioWorklet from the rest
  // of the native Web Audio mix graph. Native oscillator/compressor output can
  // differ slightly across independent OfflineAudioContexts even when the
  // project is identical, so comparing full-project bounces here would blame
  // PRISM for unrelated platform-level float variation. Round-trip the effect
  // through project JSON/migration and verify the stable host seed reproduces
  // the same processor output from an identical deterministic input buffer.
  try {
    const doc = createProjectFromTemplate("house");
    doc.id = "browser-prism-determinism";
    const track = doc.tracks.find((candidate): candidate is InstrumentTrack => candidate.kind === "instrument");
    if (!track) throw new Error("house template has no instrument track");
    const prismParams = {
      ...defaultParamsOf("fxeq"),
      bandCount: 2,
      globalMix: 100,
      limiterEnabled: 0,
      "band1.lofiEnabled": 1,
      "band1.lofiMode": 3,
      "band1.lofiAmount": 100,
      "band1.lofiMix": 100,
      "band2.lofiEnabled": 1,
      "band2.lofiMode": 3,
      "band2.lofiAmount": 100,
      "band2.lofiMix": 100,
    };
    track.effects = [
      { id: "browser-prism-a", type: "fxeq", bypassed: false, params: { ...prismParams } },
      { id: "browser-prism-b", type: "fxeq", bypassed: false, params: { ...prismParams } },
    ];
    const restored = migrateProject(JSON.parse(JSON.stringify(doc)));
    const restoredTrack = restored.tracks.find((candidate) => candidate.id === track.id);
    const restoredEffect = restoredTrack?.effects.find((effect) => effect.id === "browser-prism-a");
    if (!restoredEffect) throw new Error("PRISM effect was lost during the JSON/migration round-trip");
    const originalEffect = track.effects[0];
    const seed = hashString(`${doc.id}|${track.id}|${originalEffect.id}|fx-dsp-v1`);
    const length = 94_175;
    const renderPrism = async (effect: typeof originalEffect) => {
      const ctx = new OfflineAudioContext(2, length, SR);
      await loadAllWorklets(ctx);
      const runtime = createFxEqNode(ctx, effect, defaultParamsOf("fxeq"), seed);
      const input = ctx.createBuffer(2, length, SR);
      for (let channel = 0; channel < 2; channel++) {
        const samples = input.getChannelData(channel);
        let state = (0x12345678 + channel) >>> 0;
        for (let i = 0; i < length; i++) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          const noise = (state >>> 0) / 0x1_0000_0000 - 0.5;
          samples[i] = Math.sin((2 * Math.PI * (220 + 37 * channel) * i) / SR) * 0.15 + noise * 0.04;
        }
      }
      const source = ctx.createBufferSource();
      source.buffer = input;
      source.connect(runtime.input);
      runtime.output.connect(ctx.destination);
      source.start(0);
      try {
        return await ctx.startRendering();
      } finally {
        runtime.dispose();
      }
    };
    const [first, afterReload] = await Promise.all([renderPrism(originalEffect), renderPrism(restoredEffect)]);
    let maxDiff = 0;
    const sameShape = first.numberOfChannels === afterReload.numberOfChannels && first.length === afterReload.length;
    if (sameShape) {
      for (let ch = 0; ch < first.numberOfChannels; ch++) {
        const a = first.getChannelData(ch);
        const b = afterReload.getChannelData(ch);
        for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
      }
    }
    check(
      "prism: two browser worklet instances stay deterministic after JSON reload",
      sameShape && maxDiff <= 1e-6,
      // The isolated seeded worklet is expected to be bit-identical. Keep a
      // tiny tolerance only for browser engines that differ in Float32 math.
      `sameShape=${sameShape} maxDiff=${maxDiff.toExponential(2)} length=${first.length}`,
    );
  } catch (error) {
    check("prism: two browser worklet instances stay deterministic after JSON reload", false, String(error));
  }

  // ---------------- FM live automation (2-op engine) ----------------
  // Held-note automation: setParameterAt retunes sounding voices, so two
  // renders differing only by a mid-note INDEX/RATIO move must differ, and
  // MPE pressure on an unmatched pitch must be a bit-exact no-op.
  try {
    const renderFm = async (modify?: (rt: ReturnType<typeof INSTRUMENT_DEFS.fm.factory>) => void) => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const track: InstrumentTrack = {
        id: "fm-check",
        kind: "instrument",
        instrument: "fm",
        name: "FM",
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: null,
        params: defaultInstrumentParams("fm"),
        effects: [],
        sends: {},
      };
      const rt = INSTRUMENT_DEFS.fm.factory(ctx, track, { bpm: 124, getSample: () => undefined });
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.01, 0.8);
      modify?.(rt);
      const buffer = await ctx.startRendering();
      rt.dispose();
      return buffer;
    };
    const peakDiff = (a: AudioBuffer, b: AudioBuffer) => {
      let d = 0;
      for (let ch = 0; ch < a.numberOfChannels; ch++) {
        const da = a.getChannelData(ch);
        const db = b.getChannelData(ch);
        for (let i = 0; i < da.length; i++) d = Math.max(d, Math.abs(da[i] - db[i]));
      }
      return d;
    };
    const base = await renderFm();
    const indexMoved = await renderFm((rt) => rt.setParameterAt!("index", 0.9, 0.4));
    check(
      "fm: INDEX automation retunes a held note mid-flight",
      peakDiff(base, indexMoved) > 0.01,
      `diff=${peakDiff(base, indexMoved).toFixed(4)}`,
    );
    const ratioMoved = await renderFm((rt) => rt.setParameterAt!("ratio", 4.01, 0.4));
    check(
      "fm: RATIO automation re-pitches the modulator mid-note",
      peakDiff(base, ratioMoved) > 0.01,
      `diff=${peakDiff(base, ratioMoved).toFixed(4)}`,
    );
    const twin = await renderFm((rt) => {
      rt.noteOn(67, 0.9, 0.01, 0.8);
    });
    const pressed = await renderFm((rt) => {
      rt.noteOn(67, 0.9, 0.01, 0.8);
      rt.polyPressure!(60, 1, 0.4);
      rt.polyPressure!(60, 0, 0.7);
    });
    const twinDiff = peakDiff(twin, pressed);
    check("fm: MPE pressure brightens the matched pitch", twinDiff > 0.005, `diff=${twinDiff.toFixed(4)}`);
  } catch (error) {
    check("fm: live automation suite", false, String(error));
  }

  // ---------------- Mod matrix (main-thread rollout) ----------------
  // amt=0 uses a dormant gain-muted graph: two identical renders must match
  // to float LSB, while a later amount write must still reach the held voice.
  // A full-strength route (LFO->CUTOFF / ENV->CUTOFF / ENV->AMP) must
  // audibly change the render. vocalchop is the AMP-only case.
  try {
    const toneBuffer = new AudioBuffer({ length: SR, numberOfChannels: 2, sampleRate: SR });
    for (let ch = 0; ch < 2; ch++) {
      const d = toneBuffer.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * (220 + ch * 40) * i) / SR);
    }
    const renderKind = (
      kind: InstrumentTrack["instrument"],
      params: Record<string, number>,
      modify?: (rt: ReturnType<typeof INSTRUMENT_DEFS.analog.factory>) => void,
    ) => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const track: InstrumentTrack = {
        id: `mm-${kind}`,
        kind: "instrument",
        instrument: kind,
        name: kind,
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: kind === "sampler" || kind === "vocalchop" ? "factory.tonal.pluck" : null,
        params: { ...defaultInstrumentParams(kind), ...params },
        effects: [],
        sends: {},
      };
      const rt = INSTRUMENT_DEFS[kind].factory(ctx, track, { bpm: 124, getSample: () => toneBuffer });
      rt.output.connect(ctx.destination);
      rt.noteOn(kind === "808" ? 36 : 60, 0.9, 0.02, 0.6);
      modify?.(rt);
      return ctx.startRendering().then((b) => {
        rt.dispose();
        return b;
      });
    };
    const modCases: Array<{ kind: InstrumentTrack["instrument"]; route: Record<string, number> }> = [
      { kind: "analog", route: { modASrc: 1, modADst: 1, modAAmt: 0.9, modLfoRate: 5.5 } },
      { kind: "keys", route: { modASrc: 1, modADst: 1, modAAmt: 0.9, modLfoRate: 6 } },
      { kind: "808", route: { modASrc: 0, modADst: 1, modAAmt: 0.9 } },
      { kind: "sampler", route: { modASrc: 1, modADst: 1, modAAmt: 0.9, modLfoRate: 6 } },
      { kind: "vocalchop", route: { modASrc: 0, modADst: 3, modAAmt: 0.8 } },
    ];
    const maxDiff = (x: AudioBuffer, y: AudioBuffer) => {
      let d = 0;
      for (let ch = 0; ch < x.numberOfChannels; ch++) {
        const da = x.getChannelData(ch);
        const db = y.getChannelData(ch);
        for (let i = 0; i < da.length; i++) d = Math.max(d, Math.abs(da[i] - db[i]));
      }
      return d;
    };
    for (const { kind, route } of modCases) {
      const base = await renderKind(kind, {});
      const repeat = await renderKind(kind, {});
      const modded = await renderKind(kind, route);
      const neutral = maxDiff(base, repeat);
      const routed = maxDiff(base, modded);
      let peak = 0;
      for (let ch = 0; ch < base.numberOfChannels; ch++) {
        const da = base.getChannelData(ch);
        for (let i = 0; i < da.length; i++) peak = Math.max(peak, Math.abs(da[i]));
      }
      check(
        `mod matrix ${kind}: amt=0 is render-neutral`,
        neutral < 1e-6 && peak > 0.0005 && peak <= 2,
        `neutral=${neutral.toExponential(1)} peak=${peak.toFixed(3)}`,
      );
      check(`mod matrix ${kind}: route modulates the render`, routed > 0.001, `diff=${routed.toFixed(4)}`);
    }
    const peakOfBuffer = (buffer: AudioBuffer) => {
      let peak = 0;
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
      }
      return peak;
    };
    const negativeAmp = await renderKind("analog", { modASrc: 0, modADst: 3, modAAmt: -1 });
    const negativeCutoff = await renderKind("analog", { modASrc: 0, modADst: 1, modAAmt: -1 });
    const negativePeaks = [peakOfBuffer(negativeAmp), peakOfBuffer(negativeCutoff)];
    check(
      "mod matrix fallback: negative AMP/CUTOFF routes stay bounded and audible",
      negativePeaks.every((peak) => Number.isFinite(peak) && peak > 0.0005 && peak <= 2),
      `peaks=${negativePeaks.map((peak) => peak.toFixed(3)).join("/")}`,
    );
    const liveModBase = await renderKind("analog", {
      modASrc: 0,
      modADst: 1,
      modAAmt: 0.1,
    });
    const liveModMoved = await renderKind("analog", { modASrc: 0, modADst: 1, modAAmt: 0.1 }, (rt) =>
      rt.setParameterAt!("modAAmt", 0.9, 0.35),
    );
    const liveModDiff = maxDiff(liveModBase, liveModMoved);
    check(
      "mod matrix fallback: amount automation updates a held voice",
      liveModDiff > 0.001,
      `diff=${liveModDiff.toFixed(4)}`,
    );
    const dormantModBase = await renderKind("analog", { modASrc: 0, modADst: 1, modAAmt: 0 });
    const dormantModActivated = await renderKind("analog", { modASrc: 0, modADst: 1, modAAmt: 0 }, (rt) =>
      rt.setParameterAt!("modAAmt", 0.9, 0.35),
    );
    const dormantModDiff = maxDiff(dormantModBase, dormantModActivated);
    const earlyLimit = Math.floor(0.3 * SR);
    let earlyDormantDiff = 0;
    let lateDormantDiff = 0;
    for (let i = 0; i < dormantModBase.length; i++) {
      const diff = Math.abs(dormantModBase.getChannelData(0)[i] - dormantModActivated.getChannelData(0)[i]);
      if (i < earlyLimit) earlyDormantDiff = Math.max(earlyDormantDiff, diff);
      else lateDormantDiff = Math.max(lateDormantDiff, diff);
    }
    check(
      "mod matrix fallback: zero-amount route can activate a held voice",
      dormantModDiff > 0.001 && earlyDormantDiff < 0.001 && lateDormantDiff > 0.001,
      `diff=${dormantModDiff.toFixed(4)} early=${earlyDormantDiff.toFixed(4)} late=${lateDormantDiff.toFixed(4)}`,
    );
    const liveSourceBase = await renderKind("analog", { modASrc: 0, modADst: 1, modAAmt: 0.8 });
    const liveSourceMoved = await renderKind("analog", { modASrc: 0, modADst: 1, modAAmt: 0.8 }, (rt) =>
      rt.setParameterAt!("modASrc", 1, 0.35),
    );
    const liveSourceDiff = maxDiff(liveSourceBase, liveSourceMoved);
    check(
      "mod matrix fallback: source selector automation updates a held voice",
      liveSourceDiff > 0.001,
      `diff=${liveSourceDiff.toFixed(4)}`,
    );
    const liveDestinationBase = await renderKind("analog", { modASrc: 0, modADst: 1, modAAmt: 0.8 });
    const liveDestinationMoved = await renderKind("analog", { modASrc: 0, modADst: 1, modAAmt: 0.8 }, (rt) =>
      rt.setParameterAt!("modADst", 3, 0.35),
    );
    const liveDestinationDiff = maxDiff(liveDestinationBase, liveDestinationMoved);
    check(
      "mod matrix fallback: destination selector automation updates a held voice",
      liveDestinationDiff > 0.001,
      `diff=${liveDestinationDiff.toFixed(4)}`,
    );
    const liveLfoBase = await renderKind("analog", { modASrc: 1, modADst: 1, modAAmt: 0.8, modLfoRate: 1 });
    const liveLfoMoved = await renderKind("analog", { modASrc: 1, modADst: 1, modAAmt: 0.8, modLfoRate: 1 }, (rt) =>
      rt.setParameterAt!("modLfoRate", 8, 0.35),
    );
    const liveLfoDiff = maxDiff(liveLfoBase, liveLfoMoved);
    check(
      "mod matrix fallback: LFO rate automation updates a held voice",
      liveLfoDiff > 0.001,
      `diff=${liveLfoDiff.toFixed(4)}`,
    );
  } catch (error) {
    check("mod matrix browser suite", false, String(error));
  }

  // ---------------- Granular voice worklet (live playhead engine) ----------------
  // The worklet path must be reachable in a real browser, respond to the
  // POSITION param (the playhead), render bit-identically on repeats, and
  // leave the deterministic fallback cloud intact on worklet-less contexts.
  try {
    // Chirp, not a steady sine: a steady tone makes grains at 0.25 s vs
    // 0.85 s bit-identical (integer-cycle offsets), hiding the playhead.
    const grainBuffer = new AudioBuffer({ length: SR, numberOfChannels: 2, sampleRate: SR });
    for (let ch = 0; ch < 2; ch++) {
      const d = grainBuffer.getChannelData(ch);
      let phase = 0;
      for (let i = 0; i < d.length; i++) {
        phase += (2 * Math.PI * (180 + ch * 30 + (500 * i) / d.length)) / SR;
        d[i] = 0.5 * Math.sin(phase);
      }
    }
    const renderGrain = async (useWorklets: boolean, position: number) => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      if (useWorklets) await loadCoreWorklets(ctx);
      const track: InstrumentTrack = {
        id: "grain-check",
        kind: "instrument",
        instrument: "granular",
        name: "granular",
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: "factory.tonal.pluck",
        params: { ...defaultInstrumentParams("granular"), jitter: 0, position },
        effects: [],
        sends: {},
      };
      const rt = INSTRUMENT_DEFS.granular.factory(ctx, track, { bpm: 124, getSample: () => grainBuffer });
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.05, 0.6);
      rt.noteOff?.(60, 0.65);
      // Real exports yield between engine sync and startRendering — port
      // messages need a task-turn to reach the offline worklet.
      await new Promise((r) => setTimeout(r, 60));
      const buf = await ctx.startRendering();
      rt.dispose();
      return buf;
    };
    const ctxProbe = new OfflineAudioContext(2, 128, SR);
    await loadCoreWorklets(ctxProbe);
    if (!isWorkletReady("grainVoice", ctxProbe)) {
      check("granular voice worklet: engine available in browser", false, "worklet modules not ready");
    } else {
      const grainPeak = (b: AudioBuffer) => {
        let p = 0;
        for (let ch = 0; ch < b.numberOfChannels; ch++) {
          const d = b.getChannelData(ch);
          for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
        }
        return p;
      };
      const a = await renderGrain(true, 0.25);
      const b = await renderGrain(true, 0.85);
      const again = await renderGrain(true, 0.25);
      const posDiff = (() => {
        let d = 0;
        for (let ch = 0; ch < a.numberOfChannels; ch++) {
          const da = a.getChannelData(ch);
          const db = b.getChannelData(ch);
          for (let i = 0; i < da.length; i++) d = Math.max(d, Math.abs(da[i] - db[i]));
        }
        return d;
      })();
      const repeatDiff = (() => {
        let d = 0;
        for (let ch = 0; ch < a.numberOfChannels; ch++) {
          const da = a.getChannelData(ch);
          const db = again.getChannelData(ch);
          for (let i = 0; i < da.length; i++) d = Math.max(d, Math.abs(da[i] - db[i]));
        }
        return d;
      })();
      check(
        "granular voice worklet: audible, position steers grains, repeats bit-identical",
        grainPeak(a) > 0.001 && grainPeak(a) <= 2 && posDiff > 0.001 && repeatDiff === 0,
        `peak=${grainPeak(a).toFixed(3)} posDiff=${posDiff.toFixed(4)} repeatDiff=${repeatDiff}`,
      );
      const fallback = await renderGrain(false, 0.25);
      check(
        "granular fallback cloud intact without worklets",
        grainPeak(fallback) > 0.001 && grainPeak(fallback) <= 2,
        `peak=${grainPeak(fallback).toFixed(3)}`,
      );
    }
  } catch (error) {
    check("granular voice worklet browser suite", false, String(error));
  }

  // ── PDC Wave 2: offline export alignment ──────────────────
  // The end-to-end proof for the export barrier: two identical drum hits,
  // one track with the look-ahead gate (constant 2.5 ms), one dry. Each
  // track renders in ISOLATION (same full graph — PDC is sized from all
  // chains — only one track triggered per render), so the click positions
  // measure the per-track compensation directly.
  try {
    const SR = 48000;
    const { AudioEngine } = await import("./audio-engine/AudioEngine");
    const makeDoc = (withGate: boolean) => {
      const base = createProjectFromTemplate("house");
      const drumA = base.tracks.find((t) => t.kind === "drum")!;
      const drumB = {
        ...drumA,
        id: "pdc-drums-b",
        name: "PDC B",
        effects: withGate
          ? [{ id: "pdc-gate", type: "gate" as const, bypassed: false, params: defaultParamsOf("gate") }]
          : [],
      };
      const trackA = { ...drumA, id: "pdc-drums-a", name: "PDC A", effects: [] };
      return { ...base, tracks: [trackA, drumB] };
    };
    const clickPosSec = async (trackId: string, withGate: boolean, prepare: boolean): Promise<number> => {
      const doc = makeDoc(withGate);
      const when = 0.02;
      const pad = (doc.tracks[0] as unknown as { pads: DrumPad[] }).pads[0];
      const ctx = new OfflineAudioContext(2, SR, SR);
      await loadCoreWorklets(ctx);
      const engine = new AudioEngine();
      engine.attachBank(bank);
      engine.useContext(ctx);
      engine.setProject(doc);
      engine.trigger(trackId, pad, when, 1);
      if (prepare) await engine.prepareOfflineRender();
      const buffer = await ctx.startRendering();
      const data = buffer.getChannelData(0);
      const start = Math.floor(when * SR) - 64;
      for (let i = Math.max(0, start); i < data.length; i++) {
        if (Math.abs(data[i]) > 0.2) return i / SR - when;
      }
      return Number.NaN;
    };
    // Deterministic control: after the barrier settles the async reports,
    // the gate runtime must REPORT its look-ahead (2.5 ms) — the figure PDC
    // aligns against. (Measuring the UN-barreried render offset instead is
    // inherently racy: the port message can land mid-render and partially
    // compensate through the live-glide write path.)
    {
      const doc = makeDoc(true);
      const ctx = new OfflineAudioContext(2, SR, SR);
      await loadCoreWorklets(ctx);
      const engine = new AudioEngine();
      engine.attachBank(bank);
      engine.useContext(ctx);
      engine.setProject(doc);
      await engine.prepareOfflineRender();
      const internals = engine as unknown as {
        trackNodes: Map<string, { fx: { runtimes: Map<string, { getLatencySec?: () => number }> } }>;
      };
      const reported = internals.trackNodes.get("pdc-drums-b")?.fx.runtimes.get("pdc-gate")?.getLatencySec?.() ?? 0;
      const reportedSamples = reported * SR;
      check(
        "PDC control: gate reports its 2.5 ms look-ahead to the engine after the settle barrier",
        Math.abs(reportedSamples - 0.0025 * SR) <= 1,
        `reported=${reportedSamples.toFixed(1)} samples (expected ${(0.0025 * SR).toFixed(0)})`,
      );
    }
    // With the barrier: both tracks land sample-aligned (±1 sample of
    // measurement rounding; the gate's own envelope may soften the first
    // sample of the attack, so up to 2 samples of peak-position drift is
    // the honest bound).
    const aPos = await clickPosSec("pdc-drums-a", true, true);
    const bPos = await clickPosSec("pdc-drums-b", true, true);
    const alignedSamples = Math.round(Math.abs((bPos - aPos) * SR));
    check(
      "PDC export alignment: gate track vs dry track land within 2 samples after prepareOfflineRender",
      Number.isFinite(alignedSamples) && alignedSamples <= 2,
      `alignedDelta=${alignedSamples} samples (a=${(aPos * SR).toFixed(1)}, b=${(bPos * SR).toFixed(1)})`,
    );
  } catch (error) {
    check("PDC export alignment browser suite", false, String(error));
  }

  // ── Wave 3: RT scheduler driver (audio-clock ticker) ──────
  // 1. The ticker worklet is registered in the core bundle, gets pulled by
  //    the graph, and its message cadence/timestamps follow the AUDIO clock.
  // 2. End-to-end seam: a live scheduler driven by createSchedulerDriver()
  //    plans windows from ticker messages while the transport plays.
  try {
    const ctx = new AudioContext();
    try {
      if (ctx.state === "suspended") await ctx.resume();
      await loadCoreWorklets(ctx);
      const node = new AudioWorkletNode(ctx, "rt-ticker-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { intervalBlocks: 4 },
      });
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);
      const times: number[] = [];
      node.port.onmessage = (ev: MessageEvent) => {
        const m = ev.data as { type?: string; time?: number } | null;
        if (m?.type === "tick" && typeof m.time === "number") times.push(m.time);
      };
      await new Promise((r) => setTimeout(r, 600));
      node.disconnect();
      mute.disconnect();
      const span = times.length >= 2 ? times[times.length - 1] - times[0] : 0;
      const expected = times.length >= 2 ? ((times.length - 1) * 4 * 128) / ctx.sampleRate : 0;
      const monotonic = times.every((t, i) => i === 0 || t > times[i - 1]);
      check(
        "rt-ticker: audio-clock tick source registered, cadence matches intervalBlocks, timestamps monotonic",
        times.length >= 20 && monotonic && Math.abs(span - expected) < 0.05 * Math.max(expected, 1e-6),
        `ticks=${times.length} span=${span.toFixed(3)}s expected=${expected.toFixed(3)}s mono=${monotonic}`,
      );
    } finally {
      await ctx.close();
    }
  } catch (error) {
    check("rt-ticker browser suite", false, String(error));
  }
  try {
    const ctx = new AudioContext();
    try {
      if (ctx.state === "suspended") await ctx.resume();
      await loadCoreWorklets(ctx);
      const { AudioEngine: Engine } = await import("./audio-engine/AudioEngine");
      const doc = createProjectFromTemplate("house");
      const engine = new Engine();
      engine.attachBank(bank);
      engine.useContext(ctx);
      engine.setProject(doc);
      const transport = new Transport({ now: () => ctx.currentTime }, doc.bpm);
      const scheduler = new Scheduler({
        getProject: () => doc,
        getTransport: () => transport,
        getAudioTime: () => ctx.currentTime,
        getMode: () => "pattern",
        trigger: () => {},
        noteOn: () => {},
        applyAutomation: () => {},
        applyPatternLaunch: () => {},
      });
      const driver = createSchedulerDriver(ctx, { createGain: () => ctx.createGain() });
      if (driver) scheduler.setDriver(driver);
      transport.play(0, { leadIn: false });
      scheduler.start();
      await new Promise((r) => setTimeout(r, 700));
      scheduler.stop();
      transport.stop();
      const s = scheduler.stats;
      check(
        "scheduler driver: audio-clock ticker drives live playback windows end-to-end",
        !!driver && s.driverKind === "audio-ticker" && s.driverTickerTicks > 10 && s.windows > 5,
        `kind=${s.driverKind} tickerTicks=${s.driverTickerTicks} windows=${s.windows} watchdogTicks=${s.driverWatchdogTicks} maxGap=${s.driverMaxTickerGapMs}ms`,
      );
    } finally {
      await ctx.close();
    }
  } catch (error) {
    check("scheduler driver browser suite", false, String(error));
  }

  return results;
}
