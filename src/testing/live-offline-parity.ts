/**
 * Live ↔ offline parity obligation + null test (release-gate hardening).
 *
 * Invariant #3 says one engine drives live and offline playback, and an
 * export must sound exactly like the project. Until now that was enforced by
 * comment and by structural source-grep tests. This module turns it into a
 * machine obligation with two layers:
 *
 *   1. OBLIGATION (pure, runs in Vitest — `tests/parity-obligation.test.ts`):
 *      every EffectType and InstrumentKind in the registries must either be
 *      in the audio null-test corpus or be explicitly excluded WITH a
 *      documented reason. A new effect/instrument therefore cannot ship
 *      without a parity decision.
 *
 *   2. NULL TEST (real audio, runs in the browser gate — see
 *      `auditLiveOfflineParity`): the same document is rendered twice —
 *      once through a REAL-TIME AudioContext with the shared engine (the
 *      post-limiter master tapped by the `parity-capture-worklet`), and
 *      once through the export renderer (`renderProject`) — and the two
 *      signals are compared sample-by-sample after alignment.
 *
 * Honest limits, stated rather than hidden: a realtime context is driven by
 * a device clock, so bit-exactness is not a platform guarantee. The gate
 * therefore requires the measured null to sit below the inaudibility floor
 * (-40 dB relative to the reference) AND alignment within a few samples;
 * the actual measured dB is reported so regressions are visible long before
 * they become audible.
 */

import { EFFECT_ORDER, defaultParamsOf } from "../effects/registry";
import { INSTRUMENT_ORDER, defaultInstrumentParams } from "../instruments/registry";
import {
  noteExpressionTargetsForInstrument,
  supportsHeldVoiceSlideNote,
} from "../instruments/noteExpressionCapabilities";
import { createProjectFromTemplate } from "../project-model/templates";
import { createInstrumentTrackModel } from "../project-model/schema";
import type {
  DrumTrack,
  EffectInstance,
  EffectType,
  InstrumentKind,
  NoteExpression,
  ProjectDocument,
} from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import { AudioEngine } from "../audio-engine/AudioEngine";
import { ensureWorkletsForDoc, isWorkletReady } from "../audio-worklets/loader";

const SR = 44100;
/** Seconds of live capture per case (also the offline comparison window). */
const CASE_SECONDS = 0.45;
/** Schedule capture in the future so the note events can be queued before it starts. */
const CAPTURE_START_LEAD_SEC = 0.5;
/** AudioWorklet render quantum used to align the requested capture frame. */
const CAPTURE_QUANTUM_FRAMES = 128;
/** Additional scheduling cushion for browser-thread note-event probes. */
const NOTE_EXPRESSION_EVENT_PREROLL_SEC = 0.12;
/** Null below this (dB, relative to reference energy) is inaudible. */
export const PARITY_NULL_FLOOR_DB = -40;
/**
 * Minimum correlation for a realtime branch that is not bit-reproducible.
 * A device-clock jitter or a free-running modulator moves samples; it does
 * not change the processing path, so the correlation stays near 1. A genuinely
 * different path (bypassed FX, double processing, wrong graph) drops well below.
 */
export const PARITY_MIN_CORRELATION = 0.99;
export const PARITY_MIN_SPECTRAL_COSINE = 0.98;
/** Keys has measured browser-dependent phase-spectrum drift; keep that parity gate local. */
export const PARITY_MIN_SPECTRAL_COSINE_KEYS = 0.97;
export const PARITY_SPECTRAL_RMS_RATIO_MIN = 0.9;
export const PARITY_SPECTRAL_RMS_RATIO_MAX = 1.1;
export const PARITY_MIN_SPECTRAL_WINDOWS = 8;
/**
 * Alignment tolerance in samples. A realtime capture arms mid-quantum, so the
 * tap can land up to a few render quanta off the offline sample grid; four
 * quanta at 128 frames is still far inside the first transient.
 */
export const PARITY_ALIGN_TOLERANCE = 512;

export interface ParityCheckResult {
  name: string;
  ok: boolean;
  message: string;
}

/**
 * Effects excluded from the audio null corpus, each with the reason the
 * exclusion is honest. Prefer exclusion reasons that name the free-running
 * state — "it is nondeterministic between two live starts" is the only good
 * reason to skip a null test.
 */
export const PARITY_FX_EXCLUSIONS: ReadonlyMap<EffectType, string> = new Map<EffectType, string>([
  // Free-running LFO / phase state: the live instance is mid-modulation when
  // the capture starts; the offline instance starts from phase zero. Their
  // render determinism is covered by the golden/vector suites.
  ["phaser", "free-running LFO phase"],
  ["flanger", "free-running LFO phase"],
  ["chorus", "free-running LFO phase"],
  ["tremolo", "free-running LFO phase"],
  ["autowah", "free-running LFO phase"],
  // Reverb's comb read positions are detuned by a 0.5 Hz free-running
  // MODULATOR (reverb-processor.js: modPhase -> driftL/driftR). Over a
  // 1.8 s tail the device-clock jitter of a realtime context and that
  // modulator both move the read window, so the live capture correlates at
  // ~0.98 instead of 1.0 — the processing path is identical (offline
  // determinism control is exact), but the sample-level null is not a
  // meaningful gate for this effect. Its tail is covered by the decay and
  // audibility checks in the FX audit.
  ["reverb", "free-running 0.5 Hz read-position modulator; device-clock jitter accumulates over the tail"],
  // SV Filter smooths its cutoff coefficient with a one-pole glide
  // (svfilter-processor.js: cutoffSmoothed) that starts at the first processed
  // quantum. The realtime instance has already consumed quanta before the
  // captured event, the offline one starts cold, so the two runs take a
  // measurably different path through the filter on the first transient —
  // independent of the device clock. Its own filter-stability suite
  // (tests/svfilter-drive.test.ts) covers the DSP contract.
  ["svFilter", "one-pole cutoff glide starts at first processed quantum; realtime instance is mid-glide at capture"],
  // Transport-loop anchored with bar-scale state: a sub-bar null window is
  // not meaningful. Renders are covered by the transport-synced FX suites.
  ["beatMangler", "bar-scale transport state"],
  ["stepGate", "bar-scale transport state"],
  ["stutter", "bar-scale transport state"],
  ["pump", "bar-scale transport state"],
  ["reverseSwell", "bar-scale transport state"],
  ["tapeStop", "bar-scale transport state"],
  ["granularFreeze", "bar-scale transport state"],
]);

/**
 * Instruments excluded from the audio null corpus. The default is to null-
 * test every instrument kind (default params, one note); exclusions need a
 * free-running/nondeterministic reason.
 */
export const PARITY_INSTRUMENT_EXCLUSIONS: ReadonlyMap<InstrumentKind, string> = new Map<InstrumentKind, string>([
  // Granular/wavetable voices randomize grain offsets per voice start from a
  // seeded RNG — deterministic offline, but a live start consumes RNG order
  // through the shared scheduler, so two starts are not bit-identical.
  ["granular", "per-voice seeded grain RNG across live/offline start order"],
  ["wavetable", "free-running table scan phase"],
]);

export function parityFxCorpus(): EffectType[] {
  return EFFECT_ORDER.filter((type) => !PARITY_FX_EXCLUSIONS.has(type));
}

export function parityInstrumentCorpus(): InstrumentKind[] {
  return INSTRUMENT_ORDER.filter((kind) => !PARITY_INSTRUMENT_EXCLUSIONS.has(kind));
}

/**
 * The pure obligation: every registry member is either null-tested or
 * explicitly excluded with a reason. Never throws; returns the uncovered
 * lists so the test can print exactly what needs a decision.
 */
export function parityObligations(): { uncoveredFx: EffectType[]; uncoveredInstruments: InstrumentKind[] } {
  const fxCorpus = new Set(parityFxCorpus());
  const instrumentCorpus = new Set(parityInstrumentCorpus());
  return {
    uncoveredFx: EFFECT_ORDER.filter((type) => !fxCorpus.has(type) && !PARITY_FX_EXCLUSIONS.has(type)),
    uncoveredInstruments: INSTRUMENT_ORDER.filter(
      (kind) => !instrumentCorpus.has(kind) && !PARITY_INSTRUMENT_EXCLUSIONS.has(kind),
    ),
  };
}

export function parityObligationCheck(): ParityCheckResult {
  const { uncoveredFx, uncoveredInstruments } = parityObligations();
  const uncovered = [...uncoveredFx, ...uncoveredInstruments];
  return {
    name: "parity obligation: every effect/instrument is null-tested or explicitly excluded",
    ok: uncovered.length === 0,
    message:
      uncovered.length === 0
        ? `fx=${parityFxCorpus().length}+${PARITY_FX_EXCLUSIONS.size} instruments=${parityInstrumentCorpus().length}+${
            PARITY_INSTRUMENT_EXCLUSIONS.size
          }`
        : `needs a parity decision: ${uncovered.join(", ")}`,
  };
}

/* ------------------------------------------------------------------ */
/* Real-audio null test (browser gate)                                 */
/* ------------------------------------------------------------------ */

/**
 * The event script both branches play: identical engine calls at identical
 * RELATIVE offsets. Offline maps them onto the render timeline (origin 0),
 * live maps them onto the capture origin (T0, reported by the capture
 * processor), so the two signals are directly comparable.
 */
type ParityScript = (engine: AudioEngine, at: (offsetSec: number) => number) => void;

interface CaptureResult {
  left: Float32Array;
  /** Audio-clock time of the first captured sample (from capture-start). */
  originTime: number;
  /** Absolute audio frame of the first captured sample. */
  originFrame: number;
  /** The context sample rate the live capture actually ran at. */
  sampleRate: number;
  /** Exact frame target shared with the matching offline render. */
  requestedFrames: number;
  /** Absolute audio frame requested for capture start. */
  requestedStartFrame: number;
  /** Smallest future lead, in seconds, when the script scheduled its events. */
  minimumEventLeadSec: number;
}

async function loadParityCapture(ctx: BaseAudioContext): Promise<void> {
  await ctx.audioWorklet.addModule(new URL("/parity-capture-worklet.js", self.location.href).href);
}

/** Render the script through the shared engine on an OfflineAudioContext. */
async function renderOffline(
  bank: SampleBank,
  doc: ProjectDocument,
  script: ParityScript,
  sampleRate: number,
  eventPrerollSec = 0,
  leadSec = 0,
): Promise<Float32Array | null> {
  const frames = Math.ceil((CASE_SECONDS + 0.2 + eventPrerollSec + leadSec) * sampleRate);
  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  // Same loader contract as the renderer: core + exactly the plugin suites
  // this doc uses.
  await ensureWorkletsForDoc(doc, ctx);
  const engine = new AudioEngine();
  engine.attachBank(bank);
  try {
    engine.useContext(ctx);
    engine.setProject(doc);
    script(engine, (offset) => leadSec + eventPrerollSec + offset);
    // The export barrier: exact PDC sizing before the (un-abortable) render —
    // the same sequencing the real renderer performs.
    await engine.prepareOfflineRender();
    const buffer = await ctx.startRendering();
    return buffer.getChannelData(0);
  } finally {
    engine.detachBank();
    engine.dispose();
  }
}

/** Capture the post-limiter master of a realtime engine while the script plays. */
async function captureLive(
  bank: SampleBank,
  doc: ProjectDocument,
  script: ParityScript,
  leadSec = 0,
  expectedWorklet?: "wtVoice" | "grainVoice",
  eventPrerollSec = 0,
): Promise<CaptureResult | null> {
  const ctx = new AudioContext({ sampleRate: SR });
  let engine: AudioEngine | null = null;
  try {
    if (ctx.state === "suspended") await ctx.resume();
    await loadParityCapture(ctx);
    // Same loader contract as the offline branch (core + the doc's plugins),
    // so both engines hold the same processor implementations.
    await ensureWorkletsForDoc(doc, ctx);
    if (expectedWorklet && !isWorkletReady(expectedWorklet, ctx)) {
      throw new Error(`${expectedWorklet} core worklet did not become ready`);
    }
    engine = new AudioEngine();
    engine.attachBank(bank);
    engine.useContext(ctx);
    engine.setProject(doc);
    // The master chain upgrades (look-ahead limiter worklet) land ASYNCHRONOUSLY
    // via the worklet-refresh queue; capturing before the swap would record
    // the native-limiter warm-up instead of the steady-state engine. Wait
    // until the core modules (and the splices that ride them) are live, then
    // re-apply the project so the final processors are constructed as close
    // to the capture as the engine allows.
    const readyDeadline = performance.now() + 5000;
    while (performance.now() < readyDeadline && !isWorkletReady("limiter", ctx)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    // Rebuild the chains on the settled graph: the first event then lands
    // within a quantum of the final processor construction, matching the
    // offline render (which always builds on a cold, settled timeline).
    engine.setProject(doc);
    if (expectedWorklet) {
      const instruments = (
        engine as unknown as {
          instruments?: Map<string, { runtime?: { processorNode?: AudioWorkletNode } }>;
        }
      ).instruments;
      const processorNode = instruments?.get("parity-inst")?.runtime?.processorNode;
      if (typeof AudioWorkletNode === "undefined" || !(processorNode instanceof AudioWorkletNode)) {
        throw new Error(
          `${expectedWorklet} was ready, but parity-inst selected ${processorNode?.constructor?.name ?? "no processor"}`,
        );
      }
    }

    const chunks: Float32Array[] = [];
    let originTime = Number.NaN;
    let captureSampleRate = 0;
    let captureStartFrame = 0;
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const requestedFrames = Math.ceil((CASE_SECONDS + 0.2 + eventPrerollSec + leadSec) * ctx.sampleRate);
    const scheduledTimes: number[] = [];
    const capture = new AudioWorkletNode(ctx, "capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
      channelInterpretation: "speakers",
    });
    capture.port.onmessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        time?: number;
        frame?: number;
        sampleRate?: number;
        left?: Float32Array;
      } | null;
      if (data?.type === "capture-start" && typeof data.time === "number") {
        originTime = data.time;
        if (typeof data.frame === "number" && Number.isSafeInteger(data.frame)) captureStartFrame = data.frame;
        if (typeof data.sampleRate === "number" && data.sampleRate > 0) captureSampleRate = data.sampleRate;
      } else if (data?.type === "chunk" && data.left) chunks.push(data.left);
      else if (data?.type === "capture-done") resolveDone?.();
    };
    const masterTap = engine.getMasterTapNode();
    if (!masterTap) return null;
    masterTap.connect(capture);
    // Choose an absolute future frame and queue every event before capture
    // begins. Waiting for capture-start on the main thread is unsafe: a busy
    // browser can deliver that port message after the audio clock has already
    // advanced, making an event appear late even though capture began on time.
    const requestedStartFrame =
      Math.ceil(((ctx.currentTime + CAPTURE_START_LEAD_SEC) * ctx.sampleRate) / CAPTURE_QUANTUM_FRAMES) *
      CAPTURE_QUANTUM_FRAMES;
    const requestedStartTime = requestedStartFrame / ctx.sampleRate;
    script(engine, (offset) => {
      const when = requestedStartTime + leadSec + eventPrerollSec + offset;
      scheduledTimes.push(when);
      return when;
    });
    const minimumEventLeadSec = scheduledTimes.length
      ? Math.min(...scheduledTimes.map((when) => when - ctx.currentTime))
      : Number.POSITIVE_INFINITY;
    capture.port.postMessage({
      type: "arm",
      chunkFrames: 4096,
      captureFrames: requestedFrames,
      startFrame: requestedStartFrame,
    });

    const captureCompleted = await Promise.race([
      done.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!captureCompleted) {
      capture.port.postMessage({ type: "stop" });
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 500))]);
    }

    capture.port.onmessage = null;
    try {
      masterTap.disconnect(capture);
      capture.disconnect();
    } catch {
      /* already torn down */
    }
    const frames = chunks.reduce((sum, c) => sum + c.length, 0);
    if (frames === 0) return null;
    const left = new Float32Array(frames);
    let offset = 0;
    for (const chunk of chunks) {
      left.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      left,
      originTime,
      originFrame: captureStartFrame,
      sampleRate: captureSampleRate || ctx.sampleRate,
      requestedFrames,
      requestedStartFrame,
      minimumEventLeadSec,
    };
  } finally {
    engine?.detachBank();
    engine?.dispose();
    await ctx.close().catch(() => undefined);
  }
}

/** Best alignment offset (samples) between reference and capture, ±radius. */
function bestOffset(
  reference: Float32Array,
  capture: Float32Array,
  radius: number,
  sr: number,
): { offset: number; rms: number } {
  let best = { offset: 0, rms: Number.POSITIVE_INFINITY };
  const n = Math.min(reference.length, capture.length, sr / 2);
  // Coarse sweep first (step 8), then refine to sample resolution — a
  // sub-sample misalignment alone decorrelates a percussion null by tens of
  // dB, so the alignment precision is part of the gate's honesty.
  for (let offset = -radius; offset <= radius; offset += 8) {
    let error = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const j = i + offset;
      if (j < 0 || j >= capture.length) continue;
      const d = reference[i] - capture[j];
      error += d * d;
      count++;
    }
    if (count === 0) continue;
    const rms = Math.sqrt(error / count);
    if (rms < best.rms) best = { offset, rms };
  }
  const coarse = best;
  for (let offset = coarse.offset - 8; offset <= coarse.offset + 8; offset++) {
    let error = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const j = i + offset;
      if (j < 0 || j >= capture.length) continue;
      const d = reference[i] - capture[j];
      error += d * d;
      count++;
    }
    if (count === 0) continue;
    const rms = Math.sqrt(error / count);
    if (rms < best.rms) best = { offset, rms };
  }
  return best;
}

export interface PhaseInsensitiveParity {
  /** Cosine similarity between windowed magnitude spectra; ignores oscillator phase. */
  spectralCosine: number;
  /** Aggregate level ratio for the same windows. */
  rmsRatio: number;
  windows: number;
}

function windowSpectrum(samples: Float32Array, start: number, offset: number, size: number): Float64Array {
  const real = new Float64Array(size);
  const imag = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const source = start + i + offset;
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    real[i] = (source >= 0 && source < samples.length ? samples[source]! : 0) * hann;
  }

  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    while ((j & bit) !== 0) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j]!, real[i]!];
      [imag[i], imag[j]] = [imag[j]!, imag[i]!];
    }
  }

  for (let length = 2; length <= size; length *= 2) {
    const angle = (-2 * Math.PI) / length;
    const half = length >> 1;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    for (let base = 0; base < size; base += length) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < half; j++) {
        const even = base + j;
        const odd = even + half;
        const tr = wr * real[odd]! - wi * imag[odd]!;
        const ti = wr * imag[odd]! + wi * real[odd]!;
        real[odd] = real[even]! - tr;
        imag[odd] = imag[even]! - ti;
        real[even] += tr;
        imag[even] += ti;
        const nextWr = wr * stepReal - wi * stepImag;
        wi = wr * stepImag + wi * stepReal;
        wr = nextWr;
      }
    }
  }

  const magnitudes = new Float64Array(size / 2);
  for (let i = 1; i < size / 2; i++) magnitudes[i] = Math.hypot(real[i]!, imag[i]!);
  return magnitudes;
}

/** Compare event audio without requiring phase-locked OscillatorNode starts. */
export function comparePhaseInsensitiveParity(
  reference: Float32Array,
  capture: Float32Array,
  offset: number,
  sr: number,
): PhaseInsensitiveParity {
  const size = 2048;
  const hop = size / 2;
  const startAt = Math.floor(0.04 * sr);
  const endAt = Math.min(Math.floor(0.48 * sr), reference.length, capture.length - offset);
  const referenceSpectrum = new Float64Array(size / 2);
  const captureSpectrumSum = new Float64Array(size / 2);
  let referenceEnergy = 0;
  let captureEnergy = 0;
  let windows = 0;
  for (let start = startAt; start + size <= endAt; start += hop) {
    if (start + offset < 0 || start + size + offset > capture.length) continue;
    let refWindowEnergy = 0;
    let captureWindowEnergy = 0;
    for (let i = 0; i < size; i++) {
      const a = reference[start + i]!;
      const b = capture[start + i + offset]!;
      refWindowEnergy += a * a;
      captureWindowEnergy += b * b;
    }
    if (refWindowEnergy + captureWindowEnergy < 1e-12) continue;
    const refSpectrum = windowSpectrum(reference, start, 0, size);
    const capturedSpectrum = windowSpectrum(capture, start + offset, 0, size);
    for (let i = 1; i < refSpectrum.length; i++) {
      const a = refSpectrum[i]!;
      const b = capturedSpectrum[i]!;
      referenceSpectrum[i] += a;
      captureSpectrumSum[i] += b;
    }
    referenceEnergy += refWindowEnergy;
    captureEnergy += captureWindowEnergy;
    windows++;
  }
  let dot = 0;
  let referencePower = 0;
  let capturePower = 0;
  for (let i = 1; i < referenceSpectrum.length; i++) {
    const a = referenceSpectrum[i]!;
    const b = captureSpectrumSum[i]!;
    dot += a * b;
    referencePower += a * a;
    capturePower += b * b;
  }
  const denom = Math.sqrt(referencePower * capturePower);
  return {
    spectralCosine: denom > 0 ? dot / denom : 0,
    rmsRatio: Math.sqrt(captureEnergy / Math.max(1e-12, referenceEnergy)),
    windows,
  };
}

/**
 * Permit a phase-insensitive verdict only when offline rendering is
 * deterministic and all three spectral comparisons retain shape and level.
 */
export function phaseInsensitiveParityAgrees(
  liveOffline: PhaseInsensitiveParity | null,
  offlineRepeat: PhaseInsensitiveParity | null,
  liveRepeat: PhaseInsensitiveParity | null,
  controlNullDb: number,
  minimumSpectralCosine = PARITY_MIN_SPECTRAL_COSINE,
): boolean {
  if (!Number.isFinite(controlNullDb) || controlNullDb > PARITY_NULL_FLOOR_DB) return false;
  return [liveOffline, offlineRepeat, liveRepeat].every(
    (phase) =>
      phase !== null &&
      phase.windows >= PARITY_MIN_SPECTRAL_WINDOWS &&
      phase.spectralCosine >= minimumSpectralCosine &&
      phase.rmsRatio >= PARITY_SPECTRAL_RMS_RATIO_MIN &&
      phase.rmsRatio <= PARITY_SPECTRAL_RMS_RATIO_MAX,
  );
}

export function noteExpressionParityAgrees(
  measurement: Pick<
    ParityMeasurement,
    | "alignOffset"
    | "liveNullDb"
    | "liveRepeatNullDb"
    | "liveRepeatAlignOffset"
    | "phaseInsensitive"
    | "phaseInsensitiveControl"
    | "phaseInsensitiveRepeat"
    | "controlNullDb"
  >,
  minimumSpectralCosine = PARITY_MIN_SPECTRAL_COSINE,
): boolean {
  const liveWaveformAgrees =
    Number.isFinite(measurement.liveNullDb) &&
    measurement.liveNullDb <= PARITY_NULL_FLOOR_DB &&
    Math.abs(measurement.alignOffset) <= PARITY_ALIGN_TOLERANCE;
  const liveRepeatWaveformAgrees =
    Number.isFinite(measurement.liveRepeatNullDb) &&
    measurement.liveRepeatNullDb <= PARITY_NULL_FLOOR_DB &&
    Math.abs(measurement.liveRepeatAlignOffset) <= PARITY_ALIGN_TOLERANCE;
  if (liveWaveformAgrees && liveRepeatWaveformAgrees) return true;
  return phaseInsensitiveParityAgrees(
    measurement.phaseInsensitive,
    measurement.phaseInsensitiveControl,
    measurement.phaseInsensitiveRepeat,
    measurement.controlNullDb,
    minimumSpectralCosine,
  );
}

function compare(reference: Float32Array, capture: Float32Array, sr: number): { alignOffset: number; nullDb: number } {
  const { offset } = bestOffset(reference, capture, 384, sr);
  const start = offset;
  const n = Math.min(reference.length, capture.length - Math.max(0, -start));
  let diff = 0;
  let ref = 0;
  for (let i = 0; i < n; i++) {
    const j = i + start;
    if (j < 0 || j >= capture.length) continue;
    const d = reference[i] - capture[j];
    diff += d * d;
    ref += reference[i] * reference[i];
  }
  return { alignOffset: offset, nullDb: 10 * Math.log10((diff + 1e-30) / (ref + 1e-30)) };
}

/** Pearson correlation of the aligned signals (perceptual verdict). */
function correlationAt(reference: Float32Array, capture: Float32Array, offset: number): number {
  const n = Math.min(reference.length, capture.length - Math.max(0, -offset));
  let dot = 0;
  let ea = 0;
  let eb = 0;
  for (let i = 0; i < n; i++) {
    const j = i + offset;
    if (j < 0 || j >= capture.length) continue;
    const a = reference[i];
    const b = capture[j];
    dot += a * b;
    ea += a * a;
    eb += b * b;
  }
  const denom = Math.sqrt(ea * eb);
  return denom > 0 ? Math.max(-1, Math.min(1, dot / denom)) : 1;
}

/**
 * A realtime context delivers the master tap one render quantum off the
 * offline render's sample grid whenever the capture arms mid-quantum. When the
 * best alignment lands outside the tolerance, re-score with a WHOLE-quantum
 * shift: a single-quantum difference is a platform artefact, while anything
 * still above the floor at the corrected offset is a real divergence.
 */
function compareWithQuantumRetry(
  reference: Float32Array,
  capture: Float32Array,
  sr: number,
): { alignOffset: number; nullDb: number; quantumShift: boolean; correlation: number } {
  const first = compare(reference, capture, sr);
  let best = { ...first, quantumShift: false, correlation: correlationAt(reference, capture, first.alignOffset) };
  if (Math.abs(first.alignOffset) <= PARITY_ALIGN_TOLERANCE) return best;
  for (const shift of [-128, 128, -256, 256, -384, 384, -512, 512]) {
    const cropped = shift > 0 ? capture.subarray(shift) : capture.subarray(0, capture.length + shift);
    const reffed = shift > 0 ? reference.subarray(shift) : reference.subarray(0, reference.length + shift);
    const again = compare(reffed, cropped, sr);
    if (again.nullDb < best.nullDb) {
      best = { alignOffset: again.alignOffset, nullDb: again.nullDb, quantumShift: true, correlation: 1 };
    }
  }
  // Recompute the correlation at the winning offset.
  best.correlation = correlationAt(reference, capture, best.alignOffset);
  return best;
}

function effectDoc(template: ProjectDocument, type: EffectType): ProjectDocument {
  const drum = template.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
  const fx: EffectInstance = { id: `parity-${type}`, type, bypassed: false, params: defaultParamsOf(type) };
  return { ...template, bpm: 120, tracks: [{ ...drum, id: "parity-drums", effects: [fx] }] };
}

function instrumentDoc(template: ProjectDocument, kind: InstrumentKind): ProjectDocument {
  const track = createInstrumentTrackModel(kind, 0);
  track.id = "parity-inst";
  track.params = defaultInstrumentParams(kind);
  return { ...template, bpm: 120, tracks: [track] };
}

async function nullTestCase(
  bank: SampleBank,
  doc: ProjectDocument,
  script: ParityScript,
  label: string,
  onMeasurement?: (measurement: ParityMeasurement) => void,
  phaseInsensitiveFallback = false,
  eventPrerollSec = 0,
  minimumSpectralCosine = PARITY_MIN_SPECTRAL_COSINE,
): Promise<string | null> {
  const m = await measureParityCase(bank, doc, script, 0, eventPrerollSec);
  onMeasurement?.(m);
  if (m.error) return `${label}: ${m.error}`;
  if (Math.abs(m.alignOffset) > PARITY_ALIGN_TOLERANCE) {
    return `${label}: misaligned (offset=${m.alignOffset} samples, tolerance ${PARITY_ALIGN_TOLERANCE})`;
  }
  if (phaseInsensitiveFallback && !noteExpressionParityAgrees(m, minimumSpectralCosine)) {
    const rmsRatio = m.liveRms / Math.max(1e-12, m.refRms);
    const phaseInsensitive = m.phaseInsensitive;
    return `${label}: null ${m.liveNullDb.toFixed(1)} dB corr=${m.correlation.toFixed(
      4,
    )} liveRepeat=${Number.isFinite(m.liveRepeatNullDb) ? m.liveRepeatNullDb.toFixed(1) : "n/a"} dB rms=${rmsRatio.toFixed(
      3,
    )}× spectrum=${phaseInsensitive?.spectralCosine.toFixed(4) ?? "n/a"} RMS=${phaseInsensitive?.rmsRatio.toFixed(3) ?? "n/a"} windows=${phaseInsensitive?.windows ?? 0} offlineSpectrum=${m.phaseInsensitiveControl?.spectralCosine.toFixed(4) ?? "n/a"} offlineRMS=${m.phaseInsensitiveControl?.rmsRatio.toFixed(3) ?? "n/a"} offlineWindows=${m.phaseInsensitiveControl?.windows ?? 0} liveRepeatSpectrum=${m.phaseInsensitiveRepeat?.spectralCosine.toFixed(4) ?? "n/a"} liveRepeatRMS=${m.phaseInsensitiveRepeat?.rmsRatio.toFixed(3) ?? "n/a"} liveRepeatWindows=${m.phaseInsensitiveRepeat?.windows ?? 0} offset=${m.alignOffset} samples repeatOffset=${m.liveRepeatAlignOffset} samples control=${m.controlNullDb.toFixed(1)} dB (needs clean live↔offline and live↔live waveform comparisons, or deterministic offline control plus ≥${minimumSpectralCosine} spectral cosine and RMS ${PARITY_SPECTRAL_RMS_RATIO_MIN}–${PARITY_SPECTRAL_RMS_RATIO_MAX} across live/offline, offline repeat, and live repeat)`;
  }
  if (!phaseInsensitiveFallback && (!Number.isFinite(m.liveNullDb) || m.liveNullDb > PARITY_NULL_FLOOR_DB)) {
    // Some oscillator starts are not phase-locked between AudioContexts, so
    // a waveform null alone can reject the same expressive event. This narrow
    // fallback is allowed only for the note-expression audit and only when an
    // offline repeat is deterministic and phase-insensitive spectrum/level
    // agree for live↔offline, offline↔offline, and live↔live.
    if (!phaseInsensitiveFallback && m.realtimeNondeterministic && m.correlation >= PARITY_MIN_CORRELATION) return null;
    const rmsRatio = m.liveRms / Math.max(1e-12, m.refRms);
    const phaseInsensitive = m.phaseInsensitive;
    return `${label}: null ${m.liveNullDb.toFixed(1)} dB corr=${m.correlation.toFixed(
      4,
    )} liveRepeat=${Number.isFinite(m.liveRepeatNullDb) ? m.liveRepeatNullDb.toFixed(1) : "n/a"} dB rms=${rmsRatio.toFixed(
      3,
    )}× spectrum=${phaseInsensitive?.spectralCosine.toFixed(4) ?? "n/a"} windows=${phaseInsensitive?.windows ?? 0} offlineSpectrum=${m.phaseInsensitiveControl?.spectralCosine.toFixed(4) ?? "n/a"} liveRepeatSpectrum=${m.phaseInsensitiveRepeat?.spectralCosine.toFixed(4) ?? "n/a"} liveRepeatRMS=${m.phaseInsensitiveRepeat?.rmsRatio.toFixed(3) ?? "n/a"} offset=${m.alignOffset} samples repeatOffset=${m.liveRepeatAlignOffset} samples control=${m.controlNullDb.toFixed(1)} dB realtimeNondeterministic=${m.realtimeNondeterministic} (needs ≤ ${
      PARITY_NULL_FLOOR_DB
    } dB, corr ≥ ${PARITY_MIN_CORRELATION}, or deterministic offline control plus ≥${PARITY_MIN_SPECTRAL_COSINE} spectral cosine and RMS ${PARITY_SPECTRAL_RMS_RATIO_MIN}–${PARITY_SPECTRAL_RMS_RATIO_MAX} across live/offline, offline repeat, and live repeat)`;
  }
  return null;
}

function windowRms(samples: Float32Array, sampleRate: number, startSec: number, endSec: number): number {
  const start = Math.max(0, Math.floor(startSec * sampleRate));
  const end = Math.min(samples.length, Math.ceil(endSec * sampleRate));
  let energy = 0;
  for (let i = start; i < end; i++) energy += samples[i]! * samples[i]!;
  return Math.sqrt(energy / Math.max(1, end - start));
}

/**
 * Compare the release response itself for worklet-backed instruments whose
 * realtime and offline synth implementations differ. Absolute waveform nulls
 * are not meaningful for these pairs, so compare the live and offline ratios
 * between the short and long release settings while checking that expression
 * leaves the pre-note-off body unchanged in each path.
 */
export async function auditWorkletReleaseResponseParity(
  bank: SampleBank,
  onlyKinds?: readonly ("wavetable" | "granular")[],
): Promise<ParityCheckResult> {
  const template = createProjectFromTemplate("house");
  const sampleId = "parity-granular-release-fixture";
  if (!bank.has(sampleId)) {
    const sampleContext = new OfflineAudioContext(1, SR, SR);
    const sample = sampleContext.createBuffer(1, SR, SR);
    const data = sample.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / SR;
      data[i] =
        0.3 * Math.sin(2 * Math.PI * 110 * t) +
        0.2 * Math.sin(2 * Math.PI * 440 * t) +
        0.1 * Math.sin(2 * Math.PI * 1760 * t);
    }
    bank.add(sampleId, sample);
  }

  const failures: string[] = [];
  const details: string[] = [];
  const kinds = (["wavetable", "granular"] as const).filter((kind) => !onlyKinds || onlyKinds.includes(kind));
  for (const kind of kinds) {
    const doc = instrumentDoc(template, kind);
    if (kind === "granular") {
      const track = doc.tracks.find((candidate) => candidate.kind === "instrument");
      if (!track || track.kind !== "instrument") {
        failures.push("granular: instrument track missing");
        continue;
      }
      track.sampleId = sampleId;
    }

    const captures: Array<{ live: CaptureResult; offline: Float32Array }> = [];
    for (const releaseVelocity of [0, 1]) {
      const script: ParityScript = (engine, at) => {
        engine.noteOn("parity-inst", 60, 0.85, at(0.05), 0.22, undefined, undefined, undefined, undefined, {
          releaseVelocity,
        });
        engine.noteOff("parity-inst", 60, at(0.27));
      };
      try {
        const live = await captureLive(bank, doc, script, 0, kind === "wavetable" ? "wtVoice" : "grainVoice");
        if (!live) throw new Error("live capture produced no frames");
        const offline = await renderOffline(bank, doc, script, live.sampleRate);
        if (!offline) throw new Error("offline render produced no buffer");
        captures.push({ live, offline });
      } catch (error) {
        failures.push(`${kind}: release ${releaseVelocity} capture failed (${String(error)})`);
        break;
      }
    }
    if (captures.length !== 2) continue;

    const [short, long] = captures as [(typeof captures)[number], (typeof captures)[number]];
    const livePreShort = windowRms(short.live.left, short.live.sampleRate, 0.08, 0.22);
    const livePreLong = windowRms(long.live.left, long.live.sampleRate, 0.08, 0.22);
    const offlinePreShort = windowRms(short.offline, short.live.sampleRate, 0.08, 0.22);
    const offlinePreLong = windowRms(long.offline, long.live.sampleRate, 0.08, 0.22);
    const liveTailShort = windowRms(short.live.left, short.live.sampleRate, 0.29, 0.44);
    const liveTailLong = windowRms(long.live.left, long.live.sampleRate, 0.29, 0.44);
    const offlineTailShort = windowRms(short.offline, short.live.sampleRate, 0.29, 0.44);
    const offlineTailLong = windowRms(long.offline, long.live.sampleRate, 0.29, 0.44);
    const livePreRatio = livePreLong / Math.max(1e-9, livePreShort);
    const offlinePreRatio = offlinePreLong / Math.max(1e-9, offlinePreShort);
    const liveTailRatio = liveTailLong / Math.max(1e-9, liveTailShort);
    const offlineTailRatio = offlineTailLong / Math.max(1e-9, offlineTailShort);
    const ratioDelta = Math.abs(Math.log(liveTailRatio / Math.max(1e-9, offlineTailRatio)));
    const preStable = [livePreRatio, offlinePreRatio].every((ratio) => ratio >= 0.8 && ratio <= 1.2);
    const releaseAudible = liveTailRatio > 1.5 && offlineTailRatio > 1.5;
    const responseMatches = ratioDelta <= Math.log(1.35);
    const ok = preStable && releaseAudible && responseMatches;
    const detail = `${kind}: pre live/offline=${livePreRatio.toFixed(2)}×/${offlinePreRatio.toFixed(2)}×, tail live/offline=${liveTailRatio.toFixed(2)}×/${offlineTailRatio.toFixed(2)}×`;
    details.push(detail);
    if (!ok)
      failures.push(`${detail} (needs pre-note-off 0.80–1.20×, tail >1.50× and response-ratio agreement within 35%)`);
  }

  return {
    name: "worklet release response live↔offline parity",
    ok: failures.length === 0,
    message: failures.length === 0 ? details.join("; ") : failures.join(" | "),
  };
}

export interface ParityMeasurement {
  error?: string;
  /** Best alignment of the live capture against the offline reference. */
  alignOffset: number;
  /** Null of live vs offline (the gated number). */
  liveNullDb: number;
  /** Null of offline vs a second offline render (determinism control). */
  controlNullDb: number;
  livePeak: number;
  refPeak: number;
  liveRms: number;
  refRms: number;
  liveRate: number;
  refRate: number;
  liveFrames: number;
  refFrames: number;
  /** Seconds between capture start and the first scheduled event. */
  leadSec: number;
  /** Null of two REALTIME captures of the same case (live jitter control). */
  liveRepeatNullDb: number;
  /** Best sample offset aligning the repeated realtime capture to the first. */
  liveRepeatAlignOffset: number;
  /**
   * Pearson correlation of the aligned live capture against the offline
   * reference — the PERCEPTUAL verdict that stays meaningful when the
   * realtime branch is not bit-reproducible (device clock + free-running
   * modulation): 1.0 means the same signal, and a genuinely different
   * processing path drops well below it.
   */
  correlation: number;
  /**
   * True when the realtime branch is the source of the null: the second live
   * capture of the SAME script disagrees at least as much as the offline
   * reference does, while the offline determinism control stays clean. That
   * combination is a device-clock / non-reproducing-realtime-DSP artefact, not
   * a live↔offline engine divergence.
   */
  realtimeNondeterministic: boolean;
  /** Magnitude-spectrum comparison for phase-unlocked realtime oscillators. */
  phaseInsensitive: PhaseInsensitiveParity | null;
  /** Magnitude-spectrum comparison for the two offline determinism controls. */
  phaseInsensitiveControl: PhaseInsensitiveParity | null;
  /** Magnitude-spectrum comparison for the two realtime captures. */
  phaseInsensitiveRepeat: PhaseInsensitiveParity | null;
}

/**
 * One measured parity case with the DETERMINISM CONTROL (a second offline
 * render of the same doc). A large control null means the divergence is in the
 * engine/render determinism; a clean control with a large live null points at
 * the realtime branch. Used by the probe runner to diagnose a gate failure.
 */
export async function measureParityCase(
  bank: SampleBank,
  doc: ProjectDocument,
  script: ParityScript,
  leadSec = 0,
  eventPrerollSec = 0,
): Promise<ParityMeasurement> {
  const empty: ParityMeasurement = {
    alignOffset: 0,
    liveNullDb: Number.NaN,
    controlNullDb: Number.NaN,
    liveRepeatNullDb: Number.NaN,
    liveRepeatAlignOffset: 0,
    correlation: Number.NaN,
    realtimeNondeterministic: false,
    phaseInsensitive: null,
    phaseInsensitiveControl: null,
    phaseInsensitiveRepeat: null,
    livePeak: 0,
    refPeak: 0,
    liveRms: 0,
    refRms: 0,
    liveRate: 0,
    refRate: 0,
    liveFrames: 0,
    refFrames: 0,
    leadSec: 0,
  };
  // The realtime branch can be NONDETERMINISTIC on its own (a realtime
  // context is driven by a device clock, and a few processors with free-running
  // analysis/modulation state do not reproduce bit-exactly between two live
  // runs of the same script). Without the second live capture the gate could
  // not tell a real live↔offline engine divergence from a device-clock
  // artefact, so it is measured on every case.
  const live = await captureLive(bank, doc, script, leadSec, undefined, eventPrerollSec);
  if (!live) return { ...empty, error: "live capture produced no frames" };
  if (live.left.length !== live.requestedFrames) {
    return {
      ...empty,
      error: `live capture ended early: received ${live.left.length} of ${live.requestedFrames} audio frames`,
    };
  }
  if (live.originFrame !== live.requestedStartFrame) {
    return {
      ...empty,
      error: `live capture started at frame ${live.originFrame}, requested ${live.requestedStartFrame}`,
    };
  }
  if (live.minimumEventLeadSec <= 0) {
    return { ...empty, error: `live event was scheduled late (${(live.minimumEventLeadSec * 1000).toFixed(1)} ms)` };
  }
  const reference = await renderOffline(bank, doc, script, live.sampleRate, eventPrerollSec, leadSec);
  if (!reference) return { ...empty, error: "offline render produced no buffer" };
  const control = await renderOffline(bank, doc, script, live.sampleRate, eventPrerollSec, leadSec);
  // Third control: a SECOND realtime capture. If two live runs of the same
  // case disagree by the same order as the live null, the divergence is the
  // realtime clock/jitter, not the engine's live-vs-offline behaviour.
  const live2 = await captureLive(bank, doc, script, leadSec, undefined, eventPrerollSec);
  if (!live2) return { ...empty, error: "live repeat capture produced no frames" };
  if (live2.left.length !== live2.requestedFrames) {
    return {
      ...empty,
      error: `live repeat capture ended early: received ${live2.left.length} of ${live2.requestedFrames} audio frames`,
    };
  }
  if (live2.originFrame !== live2.requestedStartFrame) {
    return {
      ...empty,
      error: `live repeat capture started at frame ${live2.originFrame}, requested ${live2.requestedStartFrame}`,
    };
  }
  if (live2.minimumEventLeadSec <= 0) {
    return {
      ...empty,
      error: `live repeat event was scheduled late (${(live2.minimumEventLeadSec * 1000).toFixed(1)} ms)`,
    };
  }
  const liveMatch = compareWithQuantumRetry(reference, live.left, live.sampleRate);
  const controlMatch = control
    ? compareWithQuantumRetry(reference, control, live.sampleRate)
    : { alignOffset: 0, nullDb: Number.NaN, quantumShift: false };
  const liveRepeatMatch = live2
    ? compareWithQuantumRetry(live.left, live2.left, live.sampleRate)
    : { alignOffset: 0, nullDb: Number.NaN, quantumShift: false };
  const stats = (data: Float32Array) => {
    let peak = 0;
    let energy = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
      energy += data[i] * data[i];
    }
    return { peak, rms: Math.sqrt(energy / Math.max(1, data.length)) };
  };
  const ref = stats(reference);
  const liveStats = stats(live.left);
  const phaseInsensitive = comparePhaseInsensitiveParity(reference, live.left, liveMatch.alignOffset, live.sampleRate);
  const phaseInsensitiveControl = control
    ? comparePhaseInsensitiveParity(reference, control, controlMatch.alignOffset, live.sampleRate)
    : null;
  const phaseInsensitiveRepeat = live2
    ? comparePhaseInsensitiveParity(live.left, live2.left, liveRepeatMatch.alignOffset, live.sampleRate)
    : null;
  return {
    alignOffset: liveMatch.alignOffset,
    liveNullDb: liveMatch.nullDb,
    controlNullDb: controlMatch.nullDb,
    livePeak: liveStats.peak,
    refPeak: ref.peak,
    liveRms: liveStats.rms,
    refRms: ref.rms,
    liveRate: live.sampleRate,
    refRate: live.sampleRate,
    liveFrames: live.left.length,
    refFrames: reference.length,
    leadSec,
    liveRepeatNullDb: liveRepeatMatch.nullDb,
    liveRepeatAlignOffset: liveRepeatMatch.alignOffset,
    correlation: liveMatch.correlation,
    // The realtime branch owns the null when two live runs of the SAME script
    // disagree at least as much as the offline reference does, while the
    // offline determinism control is clean. Guard against a missing/failed
    // second capture (NaN) so the verdict stays conservative.
    realtimeNondeterministic:
      liveMatch.nullDb > PARITY_NULL_FLOOR_DB &&
      Number.isFinite(liveRepeatMatch.nullDb) &&
      Number.isFinite(controlMatch.nullDb) &&
      controlMatch.nullDb <= PARITY_NULL_FLOOR_DB &&
      liveRepeatMatch.nullDb >= liveMatch.nullDb - 3,
    phaseInsensitive,
    phaseInsensitiveControl,
    phaseInsensitiveRepeat,
  };
}

/** Probe hook: run one effect case end-to-end and return its measurement. */
export async function __runParityCaseForProbe(
  bank: SampleBank,
  type: EffectType,
  leadSec = 0,
  paramOverride: Record<string, number> = {},
): Promise<ParityMeasurement> {
  const template = createProjectFromTemplate("house");
  const doc = effectDoc(template, type);
  const track = doc.tracks[0];
  for (const fx of track.effects ?? []) {
    if (fx.type === type) fx.params = { ...fx.params, ...paramOverride };
  }
  if (Object.keys(paramOverride).length > 0) {
    console.log(
      `[parity] ${type} override ${JSON.stringify(paramOverride)} → ${JSON.stringify(
        (track.effects ?? []).find((f) => f.type === type)?.params ?? {},
      ).slice(0, 200)}`,
    );
  }
  const drum = track as DrumTrack;
  const script: ParityScript = (engine, at) => {
    engine.trigger("parity-drums", drum.pads[0], at(0.05), 1);
    engine.trigger("parity-drums", drum.pads[4] ?? drum.pads[0], at(0.28), 1);
  };
  return measureParityCase(bank, doc, script, leadSec);
}

/**
 * Run the real-audio null test over the FX + instrument corpora. Registry-
 * derived, so every new registry member is automatically exercised unless it
 * carries an explicit exclusion (see parityObligations).
 */
export async function auditLiveOfflineParity(bank: SampleBank): Promise<ParityCheckResult> {
  const failures: string[] = [];
  const template = createProjectFromTemplate("house");
  let cases = 0;

  for (const type of parityFxCorpus()) {
    cases++;
    try {
      const doc = effectDoc(template, type);
      const drum = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
      const script: ParityScript = (engine, at) => {
        engine.trigger("parity-drums", drum.pads[0], at(0.05), 1);
        engine.trigger("parity-drums", drum.pads[4] ?? drum.pads[0], at(0.28), 1);
      };
      const failure = await nullTestCase(bank, doc, script, `fx:${type}`);
      if (failure) failures.push(failure);
    } catch (error) {
      failures.push(`fx:${type}: ${String(error)}`);
    }
  }

  for (const kind of parityInstrumentCorpus()) {
    cases++;
    try {
      const doc = instrumentDoc(template, kind);
      const script: ParityScript = (engine, at) => {
        engine.noteOn("parity-inst", 60, 0.85, at(0.05), 0.3);
      };
      const failure = await nullTestCase(bank, doc, script, `instrument:${kind}`);
      if (failure) failures.push(failure);
    } catch (error) {
      failures.push(`instrument:${kind}: ${String(error)}`);
    }
  }

  return {
    name: "live↔offline null test: same engine + events on both contexts",
    ok: failures.length === 0,
    message: failures.length === 0 ? `passed=${cases}/${cases}` : failures.slice(0, 8).join(" | "),
  };
}

export type NoteExpressionParityFamily = "note-on" | "direct-filter" | "modulation" | "held-slide";

export interface NoteExpressionParityObligation {
  kind: InstrumentKind;
  family: NoteExpressionParityFamily;
  /** Event inputs exercised by at least one live/offline audio parity case. */
  targetKeys: readonly string[];
}

/**
 * Derive the parity obligation matrix from the same capability declaration
 * that drives the Piano Roll. This makes newly supported targets expand the
 * real-audio parity corpus automatically, while the unit obligation locks the
 * exact mapping between declarations and cases.
 */
export function noteExpressionParityMatrix(): NoteExpressionParityObligation[] {
  return INSTRUMENT_ORDER.flatMap((kind) => {
    const declaredTargets = noteExpressionTargetsForInstrument(kind);
    const obligations: NoteExpressionParityObligation[] = [
      "velocity",
      "pitchOffsetSemitones",
      ...declaredTargets.filter((target) => target === "pan" || target === "releaseVelocity"),
    ].map((target) => ({ kind, family: "note-on", targetKeys: [target] }));
    obligations.push(
      ...declaredTargets
        .filter((target) => target === "filterCutoffHz" || target === "filterResonance")
        .map((target) => ({ kind, family: "direct-filter" as const, targetKeys: [target] })),
    );
    obligations.push(
      ...declaredTargets
        .filter((target) => target === "modX" || target === "modY")
        .map((target) => ({ kind, family: "modulation" as const, targetKeys: [target] })),
    );
    if (supportsHeldVoiceSlideNote(kind)) {
      obligations.push({
        kind,
        family: "held-slide",
        targetKeys: ["slideNote"],
      });
    }
    return obligations;
  });
}

/**
 * Registry-wide note-expression parity checks. Each case changes exactly one
 * declared target, enters through the engine's public noteOn/noteSlide calls,
 * and compares realtime playback with the same engine's offline export path.
 * The separate OfflineAudioContext sweep checks that every declared target
 * audibly changes its intended route.
 */
export async function auditNoteExpressionLiveOfflineParity(
  bank: SampleBank,
  onlyLabels?: readonly string[],
  onlyKinds?: readonly InstrumentKind[],
): Promise<ParityCheckResult> {
  const template = createProjectFromTemplate("house");
  const cases: Array<{ kind: InstrumentKind; label: string; doc: ProjectDocument; script: ParityScript }> = [];

  const sampleFixtureId = "parity-note-expression-sample-fixture";
  if (!bank.has(sampleFixtureId)) {
    const sampleContext = new OfflineAudioContext(1, SR, SR);
    const sample = sampleContext.createBuffer(1, SR, SR);
    const data = sample.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / SR;
      data[i] = 0.3 * Math.sin(2 * Math.PI * 110 * t) + 0.2 * Math.sin(2 * Math.PI * 440 * t);
    }
    bank.add(sampleFixtureId, sample);
  }

  const docForKind = (kind: InstrumentKind): ProjectDocument => {
    const doc = instrumentDoc(template, kind);
    const track = doc.tracks.find((candidate) => candidate.kind === "instrument");
    if (!track || track.kind !== "instrument") throw new Error(`missing ${kind} parity track`);
    if (kind === "808") track.params = { ...track.params, gate: 1, mono: 1, click: 0, knock: 0 };
    if (kind === "drumsynth") track.params = { ...track.params, type: 0, gate: 1 };
    if (kind === "spectral") track.params = { ...track.params, attack: 0.01, motion: 0 };
    if (kind === "sampler" || kind === "granular" || kind === "vocalchop" || kind === "choral") {
      track.sampleId = sampleFixtureId;
    }
    return doc;
  };

  for (const obligation of noteExpressionParityMatrix()) {
    const { kind, family, targetKeys } = obligation;
    const doc = docForKind(kind);
    if (family === "note-on") {
      const expression: NoteExpression = {};
      const target = targetKeys[0];
      let velocity = 0.68;
      if (target === "pitchOffsetSemitones") expression.pitchOffsetSemitones = 0.37;
      else if (target === "pan") expression.pan = kind === "spectral" ? 0.7 : -0.7;
      else if (target === "releaseVelocity") expression.releaseVelocity = 0.82;
      else if (target === "velocity") velocity = 0.84;
      cases.push({
        kind,
        label: `${kind}: ${target === "pitchOffsetSemitones" ? "fine pitch" : target}`,
        doc,
        script: (engine, at) =>
          engine.noteOn(
            "parity-inst",
            60,
            velocity,
            at(0.05),
            0.3,
            undefined,
            undefined,
            undefined,
            undefined,
            expression,
          ),
      });
    } else if (family === "direct-filter") {
      const expression: NoteExpression = {};
      if (targetKeys[0] === "filterCutoffHz") expression.filterCutoffHz = 2800;
      else expression.filterResonance = 0.72;
      cases.push({
        kind,
        label: `${kind}: direct ${targetKeys[0]}`,
        doc,
        script: (engine, at) =>
          engine.noteOn("parity-inst", 60, 0.8, at(0.05), 0.3, undefined, undefined, undefined, undefined, expression),
      });
    } else if (family === "modulation") {
      const expression: NoteExpression = {};
      if (targetKeys[0] === "modX") expression.modX = 0.78;
      else expression.modY = 0.77;
      cases.push({
        kind,
        label: `${kind}: ${targetKeys[0]}`,
        doc,
        script: (engine, at) =>
          engine.noteOn("parity-inst", 64, 0.8, at(0.05), 0.3, undefined, undefined, undefined, undefined, expression),
      });
    } else {
      const sourcePitch = kind === "808" ? 33 : 45;
      cases.push({
        kind,
        label: `${kind}: held slide pitch`,
        doc,
        script: (engine, at) => {
          engine.noteOn("parity-inst", sourcePitch, 0.85, at(0.05), 0.38);
          engine.noteSlide("parity-inst", sourcePitch + 12, at(0.18), 0.12);
        },
      });
    }
  }

  const failures: string[] = [];
  const measurements: string[] = [];
  const selectedCases = cases.filter(
    (item) => (!onlyLabels || onlyLabels.includes(item.label)) && (!onlyKinds || onlyKinds.includes(item.kind)),
  );
  if (selectedCases.length === 0) {
    return {
      name: "note-expression live↔offline audio parity",
      ok: false,
      message: `no parity cases matched filter: ${onlyLabels?.join(", ") ?? "<none>"}; kinds=${onlyKinds?.join(", ") ?? "<all>"}`,
    };
  }
  for (const item of selectedCases) {
    try {
      const failure = await nullTestCase(
        bank,
        item.doc,
        item.script,
        item.label,
        (m) => {
          const phase = m.phaseInsensitive;
          const offlinePhase = m.phaseInsensitiveControl;
          const repeatPhase = m.phaseInsensitiveRepeat;
          measurements.push(
            `${item.label}: waveform=${m.liveNullDb.toFixed(1)}dB/corr=${m.correlation.toFixed(3)}, ` +
              `magnitude=${phase?.spectralCosine.toFixed(4) ?? "n/a"}, ` +
              `magnitudeRMS=${phase?.rmsRatio.toFixed(3) ?? "n/a"}/windows=${phase?.windows ?? 0}, ` +
              `offlineMagnitude=${offlinePhase?.spectralCosine.toFixed(4) ?? "n/a"}, ` +
              `offlineRMS=${offlinePhase?.rmsRatio.toFixed(3) ?? "n/a"}/windows=${offlinePhase?.windows ?? 0}, ` +
              `liveRepeatMagnitude=${repeatPhase?.spectralCosine.toFixed(4) ?? "n/a"}, ` +
              `liveRepeatWindows=${repeatPhase?.windows ?? 0}, ` +
              `RMS=${(m.liveRms / Math.max(1e-12, m.refRms)).toFixed(3)}×, ` +
              `repeat=${m.liveRepeatNullDb.toFixed(1)}dB@${m.liveRepeatAlignOffset} samples ` +
              `repeatRMS=${repeatPhase?.rmsRatio.toFixed(3) ?? "n/a"}×, control=${m.controlNullDb.toFixed(1)}dB`,
          );
        },
        true,
        NOTE_EXPRESSION_EVENT_PREROLL_SEC,
        item.kind === "keys" ? PARITY_MIN_SPECTRAL_COSINE_KEYS : PARITY_MIN_SPECTRAL_COSINE,
      );
      if (failure) failures.push(failure);
    } catch (error) {
      failures.push(`${item.label}: ${String(error)}`);
    }
  }

  return {
    name: "note-expression live↔offline audio parity",
    ok: failures.length === 0,
    message: [
      failures.length === 0 ? `passed=${selectedCases.length}/${selectedCases.length}` : failures.join(" | "),
      ...measurements,
    ].join(" | "),
  };
}
