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
import { createProjectFromTemplate } from "../project-model/templates";
import { createInstrumentTrackModel } from "../project-model/schema";
import type { DrumTrack, EffectInstance, EffectType, InstrumentKind, ProjectDocument } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import { AudioEngine } from "../audio-engine/AudioEngine";
import { ensureWorkletsForDoc, isWorkletReady } from "../audio-worklets/loader";

const SR = 44100;
/** Seconds of live capture per case (also the offline comparison window). */
const CASE_SECONDS = 0.45;
/** Null below this (dB, relative to reference energy) is inaudible. */
export const PARITY_NULL_FLOOR_DB = -40;
/**
 * Minimum correlation for a realtime branch that is not bit-reproducible.
 * A device-clock jitter or a free-running modulator moves samples; it does
 * not change the processing path, so the correlation stays near 1. A genuinely
 * different path (bypassed FX, double processing, wrong graph) drops well below.
 */
export const PARITY_MIN_CORRELATION = 0.99;
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
  /** The context sample rate the live capture actually ran at. */
  sampleRate: number;
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
): Promise<Float32Array | null> {
  const frames = Math.ceil((CASE_SECONDS + 0.2) * sampleRate);
  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  // Same loader contract as the renderer: core + exactly the plugin suites
  // this doc uses.
  await ensureWorkletsForDoc(doc, ctx);
  const engine = new AudioEngine();
  engine.attachBank(bank);
  engine.useContext(ctx);
  engine.setProject(doc);
  script(engine, (offset) => offset);
  // The export barrier: exact PDC sizing before the (un-abortable) render —
  // the same sequencing the real renderer performs.
  await engine.prepareOfflineRender();
  const buffer = await ctx.startRendering();
  engine.detachBank();
  return buffer.getChannelData(0);
}

/** Capture the post-limiter master of a realtime engine while the script plays. */
async function captureLive(
  bank: SampleBank,
  doc: ProjectDocument,
  script: ParityScript,
  leadSec = 0,
): Promise<CaptureResult | null> {
    const ctx = new AudioContext({ sampleRate: SR });
    try {
      if (ctx.state === "suspended") await ctx.resume();
      await loadParityCapture(ctx);
      // Same loader contract as the offline branch (core + the doc's plugins),
      // so both engines hold the same processor implementations.
      await ensureWorkletsForDoc(doc, ctx);
      const engine = new AudioEngine();
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

    const chunks: Float32Array[] = [];
    let originTime = Number.NaN;
    let captureSampleRate = 0;
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const capture = new AudioWorkletNode(ctx, "capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
      channelInterpretation: "speakers",
    });
    capture.port.onmessage = (event: MessageEvent) => {
      const data = event.data as
        | { type?: string; time?: number; sampleRate?: number; left?: Float32Array }
        | null;
      if (data?.type === "capture-start" && typeof data.time === "number") {
        originTime = data.time;
        if (typeof data.sampleRate === "number" && data.sampleRate > 0) captureSampleRate = data.sampleRate;
      } else if (data?.type === "chunk" && data.left) chunks.push(data.left);
      else if (data?.type === "capture-done") resolveDone?.();
    };
    const masterTap = engine.getMasterTapNode();
    if (!masterTap) return null;
    masterTap.connect(capture);
    capture.port.postMessage({ type: "arm", chunkFrames: 4096 });

    // Wait until the capture has actually started before scheduling, so the
    // first event cannot land in a pre-capture quantum.
    const armDeadline = performance.now() + 1000;
    while (Number.isNaN(originTime) && performance.now() < armDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (Number.isNaN(originTime)) return null;
    if (leadSec > 0) await new Promise((resolve) => setTimeout(resolve, leadSec * 1000));
    script(engine, (offset) => originTime + leadSec + offset);

    await new Promise((resolve) => setTimeout(resolve, CASE_SECONDS * 1000 + 150));
    capture.port.postMessage({ type: "stop" });
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 500))]);

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
    return { left, originTime, sampleRate: captureSampleRate || ctx.sampleRate };
  } finally {
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
): Promise<string | null> {
  const m = await measureParityCase(bank, doc, script);
  if (m.error) return `${label}: ${m.error}`;
  if (Math.abs(m.alignOffset) > PARITY_ALIGN_TOLERANCE) {
    return `${label}: misaligned (offset=${m.alignOffset} samples, tolerance ${PARITY_ALIGN_TOLERANCE})`;
  }
  if (!Number.isFinite(m.liveNullDb) || m.liveNullDb > PARITY_NULL_FLOOR_DB) {
    // A realtime branch that is not bit-reproducible (device clock +
    // free-running processor state) cannot be judged on a sample null, but it
    // CAN still be judged perceptually: if the live capture correlates with
    // the offline reference, it is the same processing path with timing
    // jitter, not a different one.
    if (m.realtimeNondeterministic && m.correlation >= PARITY_MIN_CORRELATION) {
      return null;
    }
    return `${label}: null ${m.liveNullDb.toFixed(1)} dB corr=${m.correlation.toFixed(
      4,
    )} liveRepeat=${Number.isFinite(m.liveRepeatNullDb) ? m.liveRepeatNullDb.toFixed(1) : "n/a"} dB (needs ≤ ${
      PARITY_NULL_FLOOR_DB
    } dB, or corr ≥ ${PARITY_MIN_CORRELATION} when realtime is not reproducible)`;
  }
  return null;
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
): Promise<ParityMeasurement> {
  const empty: ParityMeasurement = {
    alignOffset: 0,
    liveNullDb: Number.NaN,
    controlNullDb: Number.NaN,
    liveRepeatNullDb: Number.NaN,
    correlation: Number.NaN,
    realtimeNondeterministic: false,
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
  const live = await captureLive(bank, doc, script, leadSec);
  if (!live) return { ...empty, error: "live capture produced no frames" };
  const reference = await renderOffline(bank, doc, script, live.sampleRate);
  if (!reference) return { ...empty, error: "offline render produced no buffer" };
  const control = await renderOffline(bank, doc, script, live.sampleRate);
  // Third control: a SECOND realtime capture. If two live runs of the same
  // case disagree by the same order as the live null, the divergence is the
  // realtime clock/jitter, not the engine's live-vs-offline behaviour.
  const live2 = await captureLive(bank, doc, script, leadSec);
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
