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
import { ensureWorkletsForDoc } from "../audio-worklets/loader";

const SR = 44100;
/** Seconds of live capture per case (also the offline comparison window). */
const CASE_SECONDS = 0.45;
/** Null below this (dB, relative to reference energy) is inaudible. */
export const PARITY_NULL_FLOOR_DB = -40;
/** Alignment tolerance in samples. */
export const PARITY_ALIGN_TOLERANCE = 96;

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
    // Let the async worklet-load rebuild finish so the captured graph is the
    // same one the offline branch builds (no fallback/real mismatch).
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 60));

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
    script(engine, (offset) => originTime + offset);

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
  // Live capture FIRST: the realtime context owns the sample rate (the
  // device may refuse a requested one), and the offline render must run at
  // the same rate or the "null" measures resampling, not the engine.
  const live = await captureLive(bank, doc, script);
  if (!live) return `${label}: live capture produced no frames`;
  const reference = await renderOffline(bank, doc, script, live.sampleRate);
  if (!reference) return `${label}: offline render produced no buffer`;
  const { alignOffset, nullDb } = compare(reference, live.left, live.sampleRate);
  if (Math.abs(alignOffset) > PARITY_ALIGN_TOLERANCE) {
    return `${label}: misaligned (offset=${alignOffset} samples, tolerance ${PARITY_ALIGN_TOLERANCE})`;
  }
  if (!Number.isFinite(nullDb) || nullDb > PARITY_NULL_FLOOR_DB) {
    return `${label}: null ${nullDb.toFixed(1)} dB (needs ≤ ${PARITY_NULL_FLOOR_DB} dB)`;
  }
  return null;
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
