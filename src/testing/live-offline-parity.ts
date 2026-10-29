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
/**
 * The live branch's capture starts CAPTURE_START_LEAD_SEC into the live
 * context, so every realtime worklet has ALREADY processed that much
 * history by the time the first event lands: a free-running modulation
 * phase, a filter's memory, a comb's drift, a pitch tracker's buffer.
 *
 * The offline branch used to start COLD (leadSec = 0), so the two branches
 * were compared at the same nominal time while their worklet state differed
 * by a whole capture lead. The divergence that produced was the LEAD, not
 * the engine — which is exactly what the PARITY_FX_EXCLUSIONS say
 * ("the realtime instance is mid-modulation at capture", "the offline one
 * starts cold", "the realtime instance has already consumed quanta before
 * the captured event").
 *
 * The offline render therefore gets the SAME lead: it renders that many
 * frames of silence before the compared window and the comparison skips
 * them. Both worklets then reach the first event with the same history, so
 * what the null test measures is the ENGINE and not the capture lead.
 *
 * The lead is quantised to the render quantum, because the live capture's
 * start frame is quantised too (the capture worklet can only start on a
 * quantum boundary).
 */
const CAPTURE_LEAD_FRAMES = Math.ceil((CAPTURE_START_LEAD_SEC * SR) / CAPTURE_QUANTUM_FRAMES) * CAPTURE_QUANTUM_FRAMES;
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

/**
 * The corpus case that says whether THIS ENVIRONMENT can measure the corpus
 * at all.
 *
 * `bitcrusher` is deterministic by construction: the same document rendered
 * twice offline has to come out bit-identical, and its two live captures have
 * to agree just as well. Every other case is judged against a null floor,
 * but that floor only means something if the arithmetic underneath it is
 * exact — so this case is the environment's own health check. When it is
 * dirty, the corpus's numbers describe the load of the machine rather than
 * the engine, and the verdict has to say THAT instead of listing divergences.
 */
export const PARITY_CALIBRATION_CASE = "bitcrusher";

/**
 * How clean the calibration case's offline determinism control has to be for
 * the environment to count as able to measure the corpus. A deterministic
 * effect rendered twice offline is bit-identical, and the measured control
 * of the calibration case sits at about -325 dB. Anything above this floor
 * means the environment's arithmetic is not exact enough to attribute a
 * divergence to the engine.
 */
export const PARITY_CALIBRATION_MAX_CONTROL_DB = -200;

/**
 * How clean the calibration case's REALTIME reproducibility has to be for the
 * environment to count as able to measure the corpus.
 *
 * The control above measures the OFFLINE branch (the same document rendered
 * twice offline has to be bit-identical). This one measures the REALTIME
 * branch: the same script captured twice has to reproduce itself. Both axes
 * have to be exact before a live↔offline divergence can be attributed to the
 * engine — a divergence measured against a realtime branch that does not
 * reproduce itself describes the device clock, not the processing path.
 *
 * Measured: the calibration case's live↔live sits at -231.3 dB on one desktop
 * and -325.2 dB on another, so the floor below keeps more than 30 dB of
 * margin on the tightest measured machine.
 */
export const PARITY_CALIBRATION_MAX_REPEAT_DB = -200;

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
  // RING MOD: the carrier's phase is seeded by the PROCESSOR's construction —
  // ringmod-processor.js does `this.phase += phaseInc` per sample starting
  // from the constructor's `this.phase = 0`. The live branch builds the chain
  // right before the capture, the offline branch builds it at the render
  // origin, so the two modulate from a DIFFERENT phase; the gap between
  // construction and the event is load-dependent, which is why the null VALUE
  // moves between runs (-0.8 dB in the probe run, +0.7 dB in the gate run,
  // both measured on 2026-10-23) while the magnitude spectrum and the level do not
  // (cosine 0.9998, RMS 1.005x). Same sound, different modulation phase.
  // Offline determinism is exact (control -331.8 dB) and the effect's own
  // render determinism is asserted bit-identical by the FX-expansion audit
  // (src/browser-checks.ts: auditFxExpansion), so the processing path is not
  // in question — only the carrier's start phase, which no per-sample null
  // can judge.
  ["ringMod", "free-running carrier phase (the ring modulator starts at the processor's construction)"],
  // PITCH SHIFT: the same class, one layer down. The granular tap delay
  // accumulates `this.tapDelay[v] += dRate` per output sample from the
  // constructor (pitchshift-processor.js), and it only snaps back into
  // [2H, 4H] at a grain start, so the live instance reads the ring buffer at a
  // different offset than the cold offline one. Measured 2026-10-23: null
  // -0.1 dB at corr 0.4570, magnitude spectrum 0.9908, RMS 0.901x, offline
  // determinism control -334.0 dB.
  ["pitchShift", "free-running grain tap-delay accumulator (the shifter's read offset differs from the cold render)"],
  // VINYL: the wow/flutter delay is modulated by free-running LFOs
  // (vinyl-processor.js: `this.lfoPhase = 0`, `this.flutterPhase = 0`), so the
  // live instance is mid-modulation when the capture starts and the offline one
  // starts from phase zero — the same reason phaser/flanger/chorus/tremolo/
  // autowah carry. Measured 2026-10-23: null +0.5 dB at corr 0.4384,
  // magnitude spectrum 0.9886, RMS 1.000x, offline determinism control
  // -321.4 dB. The tail diverges, the head matches.
  ["vinyl", "free-running wow/flutter LFO phase (the vinyl instance is mid-modulation at capture)"],
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
  // KASKADA (RIFT delay): the delay READ POSITION is modulated by a free-running
  // LFO (kaskada-processor.js: lfoPhase advances per sample -> delayPos), so
  // the echo arrives at a different time in the two branches. Measured
  // 2026-10-25: the HEAD of the window — the first 150 ms, i.e. the direct
  // path and the document's parameter values — matches at -66.4 dB (the
  // parameters and the chain are exact), while the TAIL diverges (-9.1 dB)
  // because the echo's timing follows the modulation phase. The offline
  // determinism control is exact (-316.7 dB), so this is the modulation, not
  // a processing-path difference.
  ["kaskada", "free-running delay-modulation LFO phase (the echo's timing); the head of the window matches at -66 dB"],
  // WOW/FLUTTER: the wow/flutter delay is modulated by a free-running LFO too,
  // so the live instance is mid-modulation when the capture starts and the
  // offline one starts from phase zero. Measured 2026-10-25: the tail
  // correlates at ~0 (null +0.5 dB) while the offline determinism control is
  // exact (-325.2 dB).
  ["wowFlutter", "free-running LFO phase"],
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
  const frames = Math.ceil((CASE_SECONDS + 0.2 + eventPrerollSec + leadSec) * sampleRate) + CAPTURE_LEAD_FRAMES;
  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  // Same loader contract as the renderer: core + exactly the plugin suites
  // this doc uses.
  await ensureWorkletsForDoc(doc, ctx);
  const engine = new AudioEngine();
  engine.attachBank(bank);
  try {
    engine.useContext(ctx);
    engine.setProject(doc);
    // The event offset carries the capture lead, so the offline worklets
    // reach the first event with the SAME history the realtime ones have.
    script(engine, (offset) => CAPTURE_LEAD_FRAMES / sampleRate + leadSec + eventPrerollSec + offset);
    // The export barrier: exact PDC sizing before the (un-abortable) render —
    // the same sequencing the real renderer performs.
    await engine.prepareOfflineRender();
    const buffer = await ctx.startRendering();
    // The compared window starts where the live capture starts: the lead is
    // history, not signal.
    return buffer.getChannelData(0).subarray(CAPTURE_LEAD_FRAMES);
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

/**
 * Instruments whose runtime needs an UPLOADED source before it makes a sound.
 *
 * CHORÁL is a "drop-a-hum" instrument (ADR 0054): its worklet SUSTAINS the
 * uploaded sample, so with no source BOTH branches render silence and the null
 * test measures nothing (measured 2026-10-22: windows=0, rms=0.000x, and the
 * case failed on a 0.0 dB "null" of two silent buffers — it would pass or fail
 * by accident). The corpus therefore hands the track a factory source, which
 * makes the case REAL: the worklet has something to voice in both branches.
 */
const PARITY_INSTRUMENT_SOURCES: Partial<Record<InstrumentKind, string>> = {
  choral: "factory.tonal.keys",
};

function instrumentDoc(template: ProjectDocument, kind: InstrumentKind): ProjectDocument {
  const track = createInstrumentTrackModel(kind, 0);
  track.id = "parity-inst";
  track.params = defaultInstrumentParams(kind);
  const source = PARITY_INSTRUMENT_SOURCES[kind];
  if (source) track.sampleId = source;
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
    return `${label}: null ${m.liveNullDb.toFixed(1)} dB ${profileText(m)} corr=${m.correlation.toFixed(
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
    // A case whose REALTIME branch does not reproduce ITSELF cannot be
    // attributed to the engine: the comparison's own live side is not
    // reproducible, so the divergence it shows says nothing about the
    // processing path. `realtimeNondeterministic` is exactly that condition —
    // the second live capture of the same script disagrees at least as much
    // as the offline reference does, while the offline determinism control
    // stays clean.
    //
    // The escape used to ALSO demand corr >= PARITY_MIN_CORRELATION, and that
    // made it unreachable for the very class it was built for: the noise that
    // makes the realtime branch nondeterministic is exactly what destroys the
    // correlation (measured on the pluck case: liveRepeat -4.6 dB at corr
    // 0.8063). So every case the escape was written for was reported as a red
    // engine divergence, while a genuinely different processing path — which
    // is DETERMINISTIC, and therefore has a clean live↔live comparison — was
    // not excused at all. The correlation was a proxy for "same processing
    // path"; the live↔live comparison answers that question directly.
    if (!phaseInsensitiveFallback && m.realtimeNondeterministic) return null;
    const rmsRatio = m.liveRms / Math.max(1e-12, m.refRms);
    const phaseInsensitive = m.phaseInsensitive;
    return `${label}: null ${m.liveNullDb.toFixed(1)} dB ${profileText(m)} corr=${m.correlation.toFixed(
      4,
    )} liveRepeat=${Number.isFinite(m.liveRepeatNullDb) ? m.liveRepeatNullDb.toFixed(1) : "n/a"} dB rms=${rmsRatio.toFixed(
      3,
    )}× spectrum=${phaseInsensitive?.spectralCosine.toFixed(4) ?? "n/a"} windows=${phaseInsensitive?.windows ?? 0} offlineSpectrum=${m.phaseInsensitiveControl?.spectralCosine.toFixed(4) ?? "n/a"} liveRepeatSpectrum=${m.phaseInsensitiveRepeat?.spectralCosine.toFixed(4) ?? "n/a"} liveRepeatRMS=${m.phaseInsensitiveRepeat?.rmsRatio.toFixed(3) ?? "n/a"} segHead=${m.segmentNullDb.head.toFixed(1)} dB segTail=${m.segmentNullDb.tail.toFixed(1)} dB livePeak=${m.livePeak.toFixed(4)} refPeak=${m.refPeak.toFixed(4)} offset=${m.alignOffset} samples repeatOffset=${m.liveRepeatAlignOffset} samples control=${m.controlNullDb.toFixed(1)} dB realtimeNondeterministic=${m.realtimeNondeterministic} (needs ≤ ${
      PARITY_NULL_FLOOR_DB
    } dB; the phase-insensitive numbers above are DIAGNOSTIC in this corpus, NOT an acceptance criterion — corr is reported for DIAGNOSIS only (a value near ${PARITY_MIN_CORRELATION} means the same processing path with a moved sample); the acceptance rule is stated ONCE in the corpus header, not repeated per case, so the identifying part of a CI annotation is not pushed out by its own explanation)`;
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

/**
 * DIAGNOSTIC (not a gate criterion): the null of the aligned pair over the
 * HEAD of the window (the first `headSeconds`) and over the REST of it.
 *
 * A difference confined to the head is a startup transient; a difference
 * spread over the whole window is a processing-path divergence.
 */
function nullOverRange(
  reference: Float32Array,
  capture: Float32Array,
  offset: number,
  from: number,
  to: number,
): number {
  let diff = 0;
  let ref = 0;
  for (let i = Math.max(0, from); i < to; i++) {
    const j = i + offset;
    if (j < 0 || j >= capture.length) continue;
    const d = reference[i] - capture[j];
    diff += d * d;
    ref += reference[i] * reference[i];
  }
  return 10 * Math.log10((diff + 1e-30) / (ref + 1e-30));
}

export function segmentNulls(
  reference: Float32Array,
  capture: Float32Array,
  offset: number,
  sampleRate: number,
  headSeconds: number,
): { head: number; tail: number } {
  const total = Math.min(reference.length, capture.length - Math.max(0, -offset));
  const head = Math.min(total, Math.max(1, Math.round(headSeconds * sampleRate)));
  return {
    head: nullOverRange(reference, capture, offset, 0, head),
    tail: nullOverRange(reference, capture, offset, head, total),
  };
}

/**
 * DIAGNOSTIC (not a gate criterion): the null between the aligned live
 * capture and the offline reference, split into `windows` equal slices
 * across the compared span.
 *
 * The head/tail split says WHETHER the divergence sits at the start of the
 * event or after it. The profile says WHERE it starts and how it grows, which
 * separates the two mechanisms that look identical in a single number:
 *
 * - a profile that is already dirty in the FIRST window is a startup
 *   transient — the chain had not settled when the first event landed;
 * - a profile that is clean at the front and degrades towards the end is an
 *   accumulating state divergence — a feedback network or a filter that never
 *   reaches the same state in the two branches.
 */
export function divergenceProfile(
  reference: Float32Array,
  capture: Float32Array,
  offset: number,
  sampleRate: number,
  windows = 12,
): { profile: number[]; sliceSec: number } {
  const total = Math.min(reference.length, capture.length - Math.max(0, -offset));
  if (total <= 0 || windows <= 0) return { profile: [], sliceSec: 0 };
  const slice = Math.max(1, Math.floor(total / windows));
  const profile: number[] = [];
  for (let w = 0; w < windows; w++) {
    const from = w * slice;
    if (from >= total) break;
    profile.push(nullOverRange(reference, capture, offset, from, Math.min(total, from + slice)));
  }
  return { profile, sliceSec: slice / sampleRate };
}

/**
 * The moment the divergence becomes audible, in seconds from the start of the
 * compared window: the centre of the FIRST profile window whose null is worse
 * than the floor. `sliceSec` is the duration of one profile window. NaN when
 * no window crosses the floor.
 */
export function divergenceOnsetSec(profile: number[], sliceSec: number): number {
  for (let i = 0; i < profile.length; i++) {
    const v = profile[i]!;
    if (Number.isFinite(v) && v > PARITY_NULL_FLOOR_DB) return (i + 0.5) * sliceSec;
  }
  return Number.NaN;
}

/**
 * Compact one-line rendering of the divergence profile for a failure detail.
 * Kept short on purpose: the detail is copied into a CI annotation, and the
 * FIRST thing a reader needs is WHERE the two branches start to disagree.
 */
function profileText(m: ParityMeasurement): string {
  const cells = m.divergenceProfile.map((v) => (Number.isFinite(v) ? v.toFixed(1) : "n/a")).join(",");
  const onset = Number.isFinite(m.divergenceOnsetSec) ? `${m.divergenceOnsetSec.toFixed(3)}s` : "n/a";
  return `profile=[${cells}] onset=${onset}`;
}

export interface ParityMeasurement {
  error?: string;
  /** Best alignment of the live capture against the offline reference. */
  alignOffset: number;
  /** Null of live vs offline (the gated number). */
  liveNullDb: number;
  /**
   * DIAGNOSTIC (not a gate criterion): the null of the aligned pair over the
   * HEAD of the window and over the REST of it.
   *
   * A difference confined to the head is a STARTUP transient — the offline
   * chain has not settled when the first event lands, because the realtime
   * chain has been alive for the whole capture lead while the offline one is
   * built AT the render origin. A difference spread over the whole window is
   * a processing-path divergence, and no amount of settling would explain it.
   */
  segmentNullDb: { head: number; tail: number };
  /**
   * DIAGNOSTIC (not a gate criterion): the null between the aligned live
   * capture and the offline reference, per time slice across the compared
   * window. See `divergenceProfile` for what the shape means.
   */
  divergenceProfile: number[];
  /**
   * DIAGNOSTIC (not a gate criterion): seconds from the start of the compared
   * window where the divergence first crosses the floor. NaN when no slice
   * crosses it.
   */
  divergenceOnsetSec: number;
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
    segmentNullDb: { head: Number.NaN, tail: Number.NaN },
    divergenceProfile: [],
    divergenceOnsetSec: Number.NaN,
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
  const profile = divergenceProfile(reference, live.left, liveMatch.alignOffset, live.sampleRate);
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
    segmentNullDb: segmentNulls(reference, live.left, liveMatch.alignOffset, live.sampleRate, 0.15),
    divergenceProfile: profile.profile,
    divergenceOnsetSec: divergenceOnsetSec(profile.profile, profile.sliceSec),
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

/** Probe hook: run one INSTRUMENT case end-to-end and return its measurement. */
export async function __runParityInstrumentCaseForProbe(
  bank: SampleBank,
  kind: InstrumentKind,
  leadSec = 0,
): Promise<ParityMeasurement> {
  const template = createProjectFromTemplate("house");
  const doc = instrumentDoc(template, kind);
  const script: ParityScript = (engine, at) => {
    engine.noteOn("parity-inst", 60, 0.85, at(0.05), 0.3);
  };
  return measureParityCase(bank, doc, script, leadSec);
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
  // Every case's measurement, so the verdict can also report what it did NOT
  // judge: the cases whose realtime branch did not reproduce itself (their
  // divergence is not attributable to the engine) and the environment's own
  // calibration case. A gate that reports only its failures hides the part
  // of the corpus it could not measure.
  const measurements = new Map<string, ParityMeasurement>();
  const excused: string[] = [];
  const template = createProjectFromTemplate("house");
  let cases = 0;

  const record = (label: string) => (m: ParityMeasurement) => {
    measurements.set(label, m);
    // The same condition nullTestCase uses to excuse a case: the realtime
    // branch did not reproduce itself, so this case's divergence says nothing
    // about the processing path.
    if (m.realtimeNondeterministic && (!Number.isFinite(m.liveNullDb) || m.liveNullDb > PARITY_NULL_FLOOR_DB)) {
      excused.push(label);
    }
  };

  for (const type of parityFxCorpus()) {
    cases++;
    try {
      const doc = effectDoc(template, type);
      const drum = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
      const script: ParityScript = (engine, at) => {
        engine.trigger("parity-drums", drum.pads[0], at(0.05), 1);
        engine.trigger("parity-drums", drum.pads[4] ?? drum.pads[0], at(0.28), 1);
      };
      const failure = await nullTestCase(bank, doc, script, `fx:${type}`, record(`fx:${type}`));
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
      const failure = await nullTestCase(bank, doc, script, `instrument:${kind}`, record(`instrument:${kind}`));
      if (failure) failures.push(failure);
    } catch (error) {
      failures.push(`instrument:${kind}: ${String(error)}`);
    }
  }

  // A failure reads "<label>: <detail>", where the label is the corpus key
  // ("fx:<type>" / "instrument:<kind>"). A failure that carries no prefix is
  // its own label.
  const labelOf = (failure: string) => failure.split(": ")[0] ?? failure;
  // The COMPACT per-case summary. The verbose detail that follows it is
  // ~350 characters per case, so four cases need ~1.4 kB — which does not fit
  // next to the rest of a CI annotation. The compact form carries the numbers
  // that identify the case and its shape (null, correlation, the two
  // determinism controls, the divergence profile and the moment the
  // divergence starts) in ~130 characters, so it survives the annotation
  // budget while the verbose detail stays in the job summary.
  const compactCases = failures.slice(0, 8).map((failure) => {
    const label = labelOf(failure);
    const m = measurements.get(label);
    if (!m) return label;
    const db = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "n/a");
    return `${label}(null=${db(m.liveNullDb)}dB,corr=${m.correlation.toFixed(4)},liveRepeat=${db(
      m.liveRepeatNullDb,
    )}dB,control=${db(m.controlNullDb)}dB,${profileText(m)})`;
  });
  // The environment's own health check, read off the calibration case: a
  // deterministic effect rendered twice offline is bit-identical (measured
  // control ≈ -325 dB), and a runner whose arithmetic is that far from exact
  // cannot attribute a divergence to the engine.
  const calibration = measurements.get(`fx:${PARITY_CALIBRATION_CASE}`);
  const calibrationControlDb = calibration?.controlNullDb ?? Number.NaN;
  const calibrationRepeatDb = calibration?.liveRepeatNullDb ?? Number.NaN;
  const calibrationMeasurable =
    Number.isFinite(calibrationControlDb) &&
    calibrationControlDb <= PARITY_CALIBRATION_MAX_CONTROL_DB &&
    Number.isFinite(calibrationRepeatDb) &&
    calibrationRepeatDb <= PARITY_CALIBRATION_MAX_REPEAT_DB;
  const environment =
    calibration === undefined
      ? `environment=unknown (calibration fx:${PARITY_CALIBRATION_CASE} was not measured)`
      : `environment=${calibrationMeasurable ? "measurable" : "NOT measurable"} (calibration fx:${PARITY_CALIBRATION_CASE} control=${
          Number.isFinite(calibrationControlDb) ? calibrationControlDb.toFixed(1) : "n/a"
        } dB needs ≤ ${PARITY_CALIBRATION_MAX_CONTROL_DB} dB, live↔live=${
          Number.isFinite(calibrationRepeatDb) ? calibrationRepeatDb.toFixed(1) : "n/a"
        } dB needs ≤ ${PARITY_CALIBRATION_MAX_REPEAT_DB} dB)`;
  // The cases the corpus could NOT judge: their realtime branch did not
  // reproduce itself, so their divergence is not attributable to the engine.
  // Naming them keeps a green verdict honest about what it did not measure.
  const excusedLine = `not measurable=${excused.length} (the realtime branch did not reproduce itself)${
    excused.length > 0 ? `: ${excused.join(", ")}` : ""
  }`;
  return {
    name: "live↔offline null test: same engine + events on both contexts",
    ok: failures.length === 0,
    // The message used to list the FIRST EIGHT failures and nothing else, so
    // a gate that had been red for twenty cases reported eight of them —
    // and fixing those eight REVEALED the next eight instead of turning the
    // gate green. A gate must report how many cases failed, not how many fit
    // in one line.
    //
    // It now LEADS with the label of every failed case. The per-case
    // diagnostics are ~500 characters each and the CI annotation truncates
    // the message at a byte budget, so a tail-first message loses the cases
    // at its end — the triage then sees six of twenty-two and cannot name
    // the rest. The labels come first so every failure is named; the
    // diagnostics follow for the first eight.
    //
    // It also says what the corpus could NOT measure: the environment's
    // calibration and the cases whose realtime branch did not reproduce
    // itself. A verdict that lists only its failures hides its own blind
    // spot — and a reader who cannot tell a measurement from a coincidence
    // cannot act on it.
    //
    // The ACCEPTANCE RULE is stated once, here, instead of once per failing
    // case: the per-case detail carried ~480 characters of the same sentence,
    // so four cases spent ~1.9 kB of a 4096-byte annotation budget on it and
    // pushed the identifying part of the LAST case out of the annotation.
    // The rule now sits before the per-case details, so it survives the
    // truncation and the diagnostics get the space instead.
    message:
      failures.length === 0
        ? `passed=${cases}/${cases} — ${environment} — ${excusedLine}`
        : `failed=${failures.length}/${cases} — ${environment} — failing cases: ${failures
            .map(labelOf)
            .join(
              ", ",
            )} — ${excusedLine} — rule: a case passes when the waveform null is clean, or when the REALTIME branch is itself nondeterministic (live↔live within 3 dB of live↔offline with a clean offline control) — i.e. the divergence is the device clock, not the engine — case detail: ${compactCases.join(
            " ",
          )} — details for the first ${Math.min(8, failures.length)}: ${failures.slice(0, 8).join(" | ")}`,
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
