import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

/**
 * WORKLET FLUSH COVERAGE GATE (engine audit 2026-10-18, follow-up)
 *
 * Closes the whole denormal class WITHOUT touching the DSP wire format:
 *
 *   1. COVERAGE — every `src/audio-worklets/*-processor.js` must be classified
 *      as flushed, quiet-only, or exempt with a reason. A new processor file
 *      fails the gate until it is classified, exactly like a new suite red must
 *      be classified in the ledger. Exempt AGGREGATORS are machine-checked too:
 *      every relative import must exist, and an imported sibling processor must
 *      itself be classified — "its components are protected elsewhere" is a
 *      claim, not an excuse.
 *   2. TAIL — every flushed processor is excited with an impulse and run into
 *      silence; after the tail enters the flush zone (1e-18) it must reach
 *      EXACTLY zero and stay zero for the settle window. Feedback processors
 *      are excited at high feedback so the decay crosses the zone slowly enough
 *      to observe (default fast decay would hide behind Float32 underflow).
 *   3. QUIET STATE — the probe that closes the "flush is indistinguishable from
 *      underflow" gap: ONE sample at 1e-30 (below the 1e-20 flush threshold,
 *      far above Float32 subnormal 1.2e-38) followed by silence. Any output in
 *      the silence blocks is energy STORED without being flushed, regardless of
 *      how fast the processor's natural decay would underflow. This also covers
 *      the intentionally sustaining beat-repeat (stutter): its loop must hold
 *      zero, not a sub-threshold echo, forever.
 *
 * Aggregators whose DSP lives outside the worklet directory (PORTAL's spectral
 * core, the PCM ring sink) stay exempt with a reason and a structural import
 * check; PORTAL's three guards are documented in ADR 0038 / spectral-core.
 */

const BLOCK = 128;
const SAMPLE_RATE = 48000;
const FLUSH_ZONE = 1e-18;
/**
 * After the tail enters the flush zone the flushed state must clear the line
 * within this window. 2 s covers a 30 ms feedback loop running at 0.9 while
 * staying far shorter than the ~27-45 s an UN-flushed tail stays non-zero.
 */
const SETTLE_SECONDS = 2;
/** A processor that never outputs anything has no tail (message-driven sinks). */
const NO_TAIL_GRACE_SECONDS = 2.6;
const DEFAULT_CAP_SECONDS = 6;
/** Sub-threshold excitation: below the 1e-20 flush, above Float32 subnormal. */
const QUIET_IMPULSE = 1e-30;
/** Covers the longest declared delay (2000 ms) plus a settle margin. */
const QUIET_WINDOW_SECONDS = 2.6;

class FakePort {
  postMessage() {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

interface FlushEntry {
  /**
   * Excitation parameters: max feedback / shortest delay so the decay crosses
   * the flush zone in an observable window (not straight into Float32 zero).
   */
  params?: Record<string, number>;
  /** Upper bound for reaching the flush zone (long delays need more time). */
  capSeconds?: number;
}

/** Behaviourally tested with BOTH probes. */
const FLUSHED: Record<string, FlushEntry> = {
  "apeks-processor.js": {},
  "autowah-processor.js": {},
  "bass-harmonic-processor.js": {},
  "bassbuss-sub-processor.js": {},
  "beatmangler-processor.js": {},
  "bitcrusher-processor.js": {},
  "capture-processor.js": {},
  "chorus-processor.js": { params: { feedback: 0.9 }, capSeconds: 12 },
  "comb-processor.js": { params: { feedback: 0.95, delayMs: 5 }, capSeconds: 12 },
  "compressor-processor.js": {},
  "ducking-delay-processor.js": { params: { feedback: 0.7, time: 30 }, capSeconds: 8 },
  "envfollower-processor.js": { params: { release: 0.05 }, capSeconds: 12 },
  "eq-processor.js": {},
  "flanger-processor.js": { params: { feedback: 0.95 }, capSeconds: 12 },
  "freqshifter-processor.js": { params: { feedback: 0.9 }, capSeconds: 24 },
  "gate-processor.js": {},
  "generative-player-processor.js": {},
  "granular-voice-processor.js": {},
  "granularfreeze-processor.js": {},
  "kaskada-processor.js": { params: { feedback: 0.7, time: 30 }, capSeconds: 8 },
  "karplus-strong-processor.js": {},
  "kwmeter-processor.js": {},
  "latency-probe-processor.js": {},
  "limiter-processor.js": {},
  "multitap-processor.js": { params: { feedback: 0.9 }, capSeconds: 24 },
  "pitchcorrect-processor.js": {},
  "pitchshift-processor.js": {},
  "prud-processor.js": {},
  "reverb-processor.js": {},
  "reverseswell-processor.js": {},
  "ringmod-processor.js": { params: { feedback: 0.9 }, capSeconds: 12 },
  "rt-monitor-processor.js": {},
  "rt-ticker-processor.js": {},
  "sidechain-processor.js": {},
  "sirka-processor.js": {},
  "skrutka-processor.js": {},
  "stepgate-processor.js": {},
  "stock-delay-processor.js": { params: { feedback: 0.7, time: 30 }, capSeconds: 12 },
  "svfilter-processor.js": {},
  "tape-processor.js": {},
  "tapestop-processor.js": {},
  "transient-processor.js": {},
  "tremolo-processor.js": {},
  // The surface-noise generator is silenced through its master macro so the
  // impulse tail (drive/tone state) is what the probes measure.
  "vinyl-processor.js": { params: { amount: 0 } },
  "vocoder-processor.js": {},
  "vowel-processor.js": {},
  "wowflutter-processor.js": {},
  "wtvoice-processor.js": {},
};

/**
 * Intentionally sustaining processors: the TAIL criterion cannot apply (a
 * beat-repeat holds the captured loop for minutes), but the QUIET probe proves
 * it never stores sub-threshold energy.
 */
const QUIET_ONLY: Record<string, FlushEntry> = {
  "stutter-processor.js": {},
};

/** Not loadable here; DSP lives outside the worklet tree or is message-driven. */
const EXEMPT: Record<string, string> = {
  "core-processor.js": "entry aggregator: imports the sibling processors, each classified and tested here",
  "fx-extra-processor.js": "lazy FX-extras bundle: imports its processors, each classified and tested here",
  "pcm-playback-processor.js": "message-driven PCM sink (ring reader from src/audio-engine/pcmRing.ts)",
  "portal-processor.js":
    "imports the vendored spectral entry; guards documented in ADR 0038 + src/effects/spectral-core",
};

const WORKLET_DIR = resolve(__dirname, "../src/audio-worklets");
const ROOT = resolve(__dirname, "..");

function processorFiles(): string[] {
  return readdirSync(WORKLET_DIR)
    .filter((file) => file.endsWith("-processor.js"))
    .sort();
}

function resolveImport(fromFile: string, specifier: string): string | null {
  const base = resolve(WORKLET_DIR, dirname(fromFile), specifier);
  const candidates = [base, `${base}.js`, `${base}.ts`, `${base}.mjs`];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Inline same-project relative imports so `new Function` can evaluate the
 * module as a classic script (the processors are ES modules for addModule).
 * Handles the three forms the worklets use:
 *   - `import "spec"` (side effect, e.g. a worklet entry),
 *   - `import { A, B as C } from "spec"` (aliases become `const C = B`),
 *   - `export { A } from "spec"` (re-export; the imported module is inlined).
 * `export` keywords are dropped; the harness only needs the side effects
 * (registerProcessor) and the imported helpers.
 */
function inlineSource(file: string, seen = new Set<string>()): string {
  const absolute = resolve(WORKLET_DIR, file);
  if (seen.has(absolute)) return "";
  seen.add(absolute);
  let source = readFileSync(absolute, "utf8");
  const aliases: string[] = [];

  const inlineTarget = (specifier: string): string | null => {
    if (!specifier.startsWith(".")) return null;
    const target = resolveImport(file, specifier);
    if (!target) return null;
    return inlineSource(relative(WORKLET_DIR, target).replace(/\\/g, "/"), seen);
  };

  // import "spec"
  source = source.replace(
    /^\s*import\s+["']([^"']+)["'];?[^\S\n]*$/gm,
    (match: string, specifier: string) => inlineTarget(specifier) ?? match,
  );
  // import ... from "spec"
  source = source.replace(
    /^\s*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?[^\S\n]*$/gm,
    (match: string, clause: string, specifier: string) => {
      const inlined = inlineTarget(specifier);
      if (inlined === null) return match;
      for (const part of clause.replace(/[{}]/g, "").split(",")) {
        const [original, alias] = part
          .split(/\s+as\s+/)
          .map((piece) => piece.trim())
          .filter(Boolean);
        if (original && alias && alias !== original) aliases.push(`const ${alias} = ${original};`);
      }
      return inlined;
    },
  );
  // export { ... } from "spec"
  source = source.replace(
    /^\s*export\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];?[^\S\n]*$/gm,
    (match: string, specifier: string) => inlineTarget(specifier) ?? match,
  );
  // export { a, b };  (local list, no module side effect to keep)
  source = source.replace(/^\s*export\s*\{[^}]*\};?[^\S\n]*$/gm, "");
  // export declarations
  source = source.replace(/^\s*export\s+/gm, "");
  return aliases.length > 0 ? `${source}\n${aliases.join("\n")}\n` : source;
}

function loadProcessor(file: string): { Class: new (options?: unknown) => unknown } {
  const classic = inlineSource(file);
  const registered = new Map<string, new (options?: unknown) => unknown>();
  const host = new Function("registerProcessor", "AudioWorkletProcessor", "globalThis", classic);
  host(
    (name: string, Class: new (options?: unknown) => unknown) => registered.set(name, Class),
    FakeAudioWorkletProcessor,
    globalThis,
  );
  const entry = [...registered.values()].pop();
  if (!entry) throw new Error(`${file} registered no processor`);
  return { Class: entry };
}

function importsOf(file: string): string[] {
  const source = readFileSync(resolve(WORKLET_DIR, file), "utf8");
  const specs: string[] = [];
  for (const match of source.matchAll(/^\s*import\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["'];?/gm)) {
    specs.push(match[1]!);
  }
  return specs;
}

function peak(channel: Float32Array): number {
  let value = 0;
  for (let i = 0; i < channel.length; i += 1) value = Math.max(value, Math.abs(channel[i]!));
  return value;
}

interface Harness {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
}

function makeHarness(file: string, entry: FlushEntry, forceWet: boolean): Harness {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SAMPLE_RATE;
  (globalThis as unknown as { currentTime: number }).currentTime = 0;
  (globalThis as unknown as { currentFrame: number }).currentFrame = 0;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;

  const { Class } = loadProcessor(file);
  const descriptorSource = Class as unknown as { parameterDescriptors?: Array<{ name: string; defaultValue: number }> };
  const parameters: Record<string, Float32Array> = {};
  for (const descriptor of descriptorSource.parameterDescriptors ?? []) {
    const name = descriptor.name;
    const override = entry.params?.[name];
    if (forceWet) {
      if (name === "mix" || name === "wet" || name === "blend") {
        parameters[name] = Float32Array.of(1);
        continue;
      }
      if (name === "dry") {
        parameters[name] = Float32Array.of(0);
        continue;
      }
    }
    parameters[name] = Float32Array.of(override ?? descriptor.defaultValue ?? 0);
  }
  const processor = new Class({}) as Harness;
  return Object.assign(
    {
      process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) =>
        processor.process(i, o, p),
    },
    { parameters, processor },
  );
}

type HarnessWithParams = Harness & { parameters: Record<string, Float32Array>; processor: unknown };

interface TailReport {
  last: number;
  sawTail: boolean;
  observedZone: boolean;
  settled: boolean;
  blocks: number;
}

function runImpulseThenSilence(file: string, entry: FlushEntry): TailReport {
  const harness = makeHarness(file, entry, false) as HarnessWithParams;
  const parameters = harness.parameters;
  const impulseL = new Float32Array(BLOCK);
  const impulseR = new Float32Array(BLOCK);
  impulseL[0] = 0.5;
  impulseR[0] = 0.5;
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  const outputs = [[outL, outR]];
  harness.process([[impulseL, impulseR]], outputs, parameters);
  let sawTail = Math.max(peak(outL), peak(outR)) > 0;

  const capBlocks = Math.round(((entry.capSeconds ?? DEFAULT_CAP_SECONDS) * SAMPLE_RATE) / BLOCK);
  const settleBlocks = Math.round((SETTLE_SECONDS * SAMPLE_RATE) / BLOCK);
  const noTailBlocks = Math.round((NO_TAIL_GRACE_SECONDS * SAMPLE_RATE) / BLOCK);
  let observedZone = false;
  let settled = false;
  let zeroStreak = 0;
  let last = Number.NaN;
  let blocks = 0;

  for (let block = 0; block < capBlocks; block += 1) {
    (globalThis as unknown as { currentFrame: number }).currentFrame = (block + 1) * BLOCK;
    outL.fill(0);
    outR.fill(0);
    harness.process([[]], outputs, parameters);
    const samplePeak = Math.max(peak(outL), peak(outR));
    if (!Number.isFinite(samplePeak)) throw new Error(`non-finite output in block ${block}`);
    last = samplePeak;
    blocks = block + 1;

    if (samplePeak > 0) {
      sawTail = true;
      zeroStreak = 0;
      if (samplePeak < FLUSH_ZONE) observedZone = true;
      continue;
    }
    // Exact zero only counts AFTER the tail was seen: a delay line has silent
    // gaps before its first echo, and an un-flushed tail rings instead of
    // reaching zero. Before any tail, the grace window (longer than the max
    // declared delay) decides "no tail".
    zeroStreak += 1;
    const required = sawTail ? settleBlocks : noTailBlocks;
    if (zeroStreak >= required) {
      settled = true;
      break;
    }
  }
  return { last, sawTail, observedZone, settled, blocks };
}

interface QuietReport {
  /** Peak of any output AFTER the quiet impulse block. */
  tailPeak: number;
  firstTailBlock: number | null;
}

function runQuietImpulse(file: string, entry: FlushEntry): QuietReport {
  const harness = makeHarness(file, entry, true) as HarnessWithParams;
  const parameters = harness.parameters;
  const impulseL = new Float32Array(BLOCK);
  const impulseR = new Float32Array(BLOCK);
  impulseL[0] = QUIET_IMPULSE;
  impulseR[0] = QUIET_IMPULSE;
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  const outputs = [[outL, outR]];
  // The impulse block may legitimately pass the sample through (dry/wet); only
  // what the processor STORES shows up in the silence blocks afterwards.
  harness.process([[impulseL, impulseR]], outputs, parameters);

  const blocks = Math.round((QUIET_WINDOW_SECONDS * SAMPLE_RATE) / BLOCK);
  let tailPeak = 0;
  let firstTailBlock: number | null = null;
  for (let block = 0; block < blocks; block += 1) {
    (globalThis as unknown as { currentFrame: number }).currentFrame = (block + 1) * BLOCK;
    outL.fill(0);
    outR.fill(0);
    harness.process([[]], outputs, parameters);
    const samplePeak = Math.max(peak(outL), peak(outR));
    if (!Number.isFinite(samplePeak)) throw new Error(`non-finite output in block ${block}`);
    if (samplePeak > tailPeak) tailPeak = samplePeak;
    if (samplePeak > 0 && firstTailBlock === null) firstTailBlock = block;
  }
  return { tailPeak, firstTailBlock };
}

/**
 * STATE FLUSH — the probe the output-based gate above structurally CANNOT see.
 *
 * Both existing probes watch the OUTPUT. A processor that flushes its output
 * but leaves its INTERNAL state decaying into the subnormal range passes both
 * of them: the output is exactly zero, so there is no tail and no stored
 * energy — while the filter memories inside keep non-zero values forever.
 *
 * That residue is not free. x86 subnormal arithmetic is up to ~100x slower
 * than normal float, so a processor that keeps a subnormal in its state burns
 * CPU on every block for the rest of the session, long after the sound it
 * was processing is gone. It is also a state that never reaches zero, which
 * is exactly what the gate's contract says must not happen.
 *
 * The probe therefore excites the processor, runs it into silence, and then
 * inspects the processor's OWN state.
 *
 * The threshold is the TRUE subnormal floor, not the repo's 1e-20 musical
 * flush floor. Those are different things: 1e-20 is an aesthetic silence
 * floor (and a config constant in several processors), while the subnormal
 * floor is where the CPU actually degrades — 1.18e-38 for Float32 and
 * 2.23e-308 for Float64. Flagging the 1e-20 band instead would report the
 * deliberate 1e-20 thresholds themselves and every quiet-but-normal state
 * value, which is noise, not a defect.
 */
const FLOAT32_SUBNORMAL = 1.1754944e-38;
const FLOAT64_SUBNORMAL = 2.2250738585072014e-308;

function collectResidue(value: unknown, path: string, out: string[], depth = 0): void {
  if (depth > 6) return;
  if (typeof value === "number") {
    if (value !== 0 && Math.abs(value) < FLOAT64_SUBNORMAL) out.push(`${path} = ${value}`);
    return;
  }
  if (value instanceof Float32Array) {
    for (let i = 0; i < value.length; i += 1) {
      const element = value[i]!;
      if (element !== 0 && Math.abs(element) < FLOAT32_SUBNORMAL) out.push(`${path}[${i}] = ${element}`);
    }
    return;
  }
  if (value instanceof Float64Array) {
    for (let i = 0; i < value.length; i += 1) {
      const element = value[i]!;
      if (element !== 0 && Math.abs(element) < FLOAT64_SUBNORMAL) out.push(`${path}[${i}] = ${element}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) collectResidue(value[i], `${path}[${i}]`, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) collectResidue(record[key], `${path}.${key}`, out, depth + 1);
  }
}
function runIntoSilenceThenReadState(file: string, entry: FlushEntry): string[] {
  const harness = makeHarness(file, entry, false) as HarnessWithParams;
  const parameters = harness.parameters;
  const impulseL = new Float32Array(BLOCK);
  const impulseR = new Float32Array(BLOCK);
  impulseL[0] = 0.5;
  impulseR[0] = 0.5;
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  const outputs = [[outL, outR]];
  harness.process([[impulseL, impulseR]], outputs, parameters);

  // REAL zeros, not an empty input array: several processors early-return
  // when nothing is connected (`input.length === 0`), and that would freeze
  // the state instead of letting it decay — the probe would then measure
  // nothing at all.
  const silenceL = new Float32Array(BLOCK);
  const silenceR = new Float32Array(BLOCK);
  // Long enough for any feedback/decay tail to reach the flush zone.
  const blocks = Math.round((4 * SAMPLE_RATE) / BLOCK);
  for (let block = 0; block < blocks; block += 1) {
    (globalThis as unknown as { currentFrame: number }).currentFrame = (block + 1) * BLOCK;
    silenceL.fill(0);
    silenceR.fill(0);
    outL.fill(0);
    outR.fill(0);
    harness.process([[silenceL, silenceR]], outputs, parameters);
  }

  const residue: string[] = [];
  collectResidue(harness.processor, "state", residue);
  return residue;
}

describe("worklet flush coverage gate", () => {
  it("every processor file is classified (a new file must be added deliberately)", () => {
    const files = processorFiles();
    const classified = [...Object.keys(FLUSHED), ...Object.keys(QUIET_ONLY), ...Object.keys(EXEMPT)].sort();
    expect(classified, "a processor file is neither flushed, quiet-only nor exempt — classify it here").toEqual(files);
    expect(new Set(classified).size, "duplicate classification entry").toBe(classified.length);
  });

  it("exempt aggregators only import files that exist and classified processors", () => {
    const classified = new Set([...Object.keys(FLUSHED), ...Object.keys(QUIET_ONLY), ...Object.keys(EXEMPT)]);
    for (const file of Object.keys(EXEMPT)) {
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith(".")) continue;
        const target = resolveImport(file, specifier);
        expect(target, `${file} imports ${specifier}, which does not exist`).not.toBeNull();
        const repoPath = relative(ROOT, target!).replace(/\\/g, "/");
        if (repoPath.startsWith("src/audio-worklets/") && repoPath.endsWith("-processor.js")) {
          expect(
            classified.has(basename(repoPath)),
            `${file} imports ${repoPath}, which is not classified in this gate`,
          ).toBe(true);
        }
      }
    }
    // core-processor is the entry bundle: it must import the whole effect set.
    expect(importsOf("core-processor.js").length, "core-processor stopped aggregating processors").toBeGreaterThan(30);
  });

  for (const [file, entry] of Object.entries(FLUSHED)) {
    it(`${file} flushes its tail to exactly zero after the flush zone`, () => {
      const report = runImpulseThenSilence(file, entry);
      expect(
        report.settled,
        report.observedZone
          ? `tail entered the flush zone but never reached exactly zero (last ${report.last}) — ` +
              "the state is quiet but NOT flushed (subnormal residue keeps it alive)"
          : `tail never fell below ${FLUSH_ZONE} within the cap (${report.blocks} blocks, last ${report.last}) — ` +
              "if the decay is intentionally long, raise capSeconds; if it never decays, the processor needs a flush idiom",
      ).toBe(true);
    });

    it(`${file} stores no sub-threshold energy (quiet-impulse probe)`, () => {
      const report = runQuietImpulse(file, entry);
      expect(
        report.tailPeak,
        `a 1e-30 impulse left stored energy behind (first silent-block output at ` +
          `${report.firstTailBlock}, peak ${report.tailPeak}) — the write path is not flushed`,
      ).toBe(0);
    });
  }

  for (const [file, entry] of Object.entries(QUIET_ONLY)) {
    it(`${file} stores no sub-threshold energy (quiet-impulse probe; tail probe intentionally skipped)`, () => {
      const report = runQuietImpulse(file, entry);
      expect(
        report.tailPeak,
        `a 1e-30 impulse survived in the sustaining state (first silent-block output at ` +
          `${report.firstTailBlock}, peak ${report.tailPeak}) — the write path is not flushed`,
      ).toBe(0);
    });
  }

  for (const [file, entry] of Object.entries(FLUSHED)) {
    it(`${file} leaves no subnormal residue in its own state`, () => {
      const residue = runIntoSilenceThenReadState(file, entry);
      expect(
        residue.slice(0, 6),
        `${file} kept a subnormal in its own state after the signal stopped — ` +
          "the output is flushed but the internal state is not, so the processor " +
          "keeps doing subnormal arithmetic forever (and the state never reaches zero)",
      ).toEqual([]);
    });
  }
});

/**
 * THE STATE MUST REACH EXACTLY ZERO — targeted at the two processors whose
 * filter memories were left un-flushed.
 *
 * The generic sweep above cannot see these: their state decays SLOWLY (a
 * narrow band-pass has poles almost on the unit circle), so it takes seconds
 * of silence to cross into the subnormal band. The defect is still real — the
 * contract is that the state reaches EXACTLY zero, and an un-flushed state
 * only ever gets there by gradual underflow, after passing through the slow
 * subnormal range.
 *
 * These specs drive the filter directly, which makes them fast and exact.
 */
describe("worklet state flush — targeted", () => {
  it("kaskada-processor.js flushes its biquad STATE, not only its output", () => {
    const harness = makeHarness(
      "kaskada-processor.js",
      { params: { feedback: 0.7, time: 30 }, capSeconds: 8 },
      false,
    ) as HarnessWithParams;
    const processor = harness.processor as unknown as {
      makeUmBiquad: (channels: number) => { z1: Float32Array; z2: Float32Array };
      umBandpass: (bq: unknown, freq: number, q: number) => void;
      umSample: (bq: unknown, ch: number, x: number) => number;
    };

    const bq = processor.makeUmBiquad(1);
    processor.umBandpass(bq, 125, 2);
    processor.umSample(bq, 0, 1);
    // 125 Hz / Q 2 at 48 kHz has poles at r ≈ 0.99986 — the ring needs
    // ~330 000 samples to cross the 1e-20 flush floor, which is exactly the
    // window where an un-flushed state sits in the subnormal range.
    for (let i = 0; i < 400000; i += 1) processor.umSample(bq, 0, 0);

    expect(
      bq.z1[0],
      "the biquad's first state memory must reach exactly zero, not merely get quiet",
    ).toBe(0);
    expect(
      bq.z2[0],
      "the biquad's second state memory must reach exactly zero, not merely get quiet",
    ).toBe(0);
  });

  it("prud-processor.js flushes its detector and cut state, not only its output", () => {
    const harness = makeHarness("prud-processor.js", {}, false) as HarnessWithParams;
    const parameters = harness.parameters;
    const processor = harness.processor as unknown as {
      det: Array<{ z1: number; z2: number; env: number; grDb: number }>;
      cut: Array<Array<{ x1: number; x2: number; y1: number; y2: number }>>;
    };

    const impulseL = new Float32Array(BLOCK);
    const impulseR = new Float32Array(BLOCK);
    impulseL[0] = 0.5;
    impulseR[0] = 0.5;
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const outputs = [[outL, outR]];
    harness.process([[impulseL, impulseR]], outputs, parameters);

    // REAL zeros, not an empty input array: the processor early-returns on an
    // empty input (nothing connected), which would freeze the state and hide
    // what this spec is about — the DECAY of the state under silence.
    const silenceL = new Float32Array(BLOCK);
    const silenceR = new Float32Array(BLOCK);
    // 4000 blocks ≈ 27 s of silence. The detector envelope is the slowest
    // state (release 0.2 s ⇒ a ~9600-sample time constant), so it needs
    // ~440 000 samples to cross the 1e-20 flush floor.
    for (let block = 0; block < 4000; block += 1) {
      (globalThis as unknown as { currentFrame: number }).currentFrame = (block + 1) * BLOCK;
      silenceL.fill(0);
      silenceR.fill(0);
      outL.fill(0);
      outR.fill(0);
      harness.process([[silenceL, silenceR]], outputs, parameters);
    }

    // `grDb` is NOT decaying state — the band rides to its `amount` setting,
    // so it settles on a real value. Everything else must be exactly zero.
    const offenders: string[] = [];
    for (let b = 0; b < processor.det.length; b += 1) {
      const det = processor.det[b]!;
      if (det.z1 !== 0) offenders.push(`det[${b}].z1 = ${det.z1}`);
      if (det.z2 !== 0) offenders.push(`det[${b}].z2 = ${det.z2}`);
      if (det.env !== 0) offenders.push(`det[${b}].env = ${det.env}`);
    }
    for (let ch = 0; ch < processor.cut.length; ch += 1) {
      for (let b = 0; b < processor.cut[ch]!.length; b += 1) {
        const cut = processor.cut[ch]![b]!;
        if (cut.x1 !== 0) offenders.push(`cut[${ch}][${b}].x1 = ${cut.x1}`);
        if (cut.x2 !== 0) offenders.push(`cut[${ch}][${b}].x2 = ${cut.x2}`);
        if (cut.y1 !== 0) offenders.push(`cut[${ch}][${b}].y1 = ${cut.y1}`);
        if (cut.y2 !== 0) offenders.push(`cut[${ch}][${b}].y2 = ${cut.y2}`);
      }
    }

    expect(
      offenders,
      "the dynamic EQ kept decaying state that never reached zero — the output is " +
        "flushed but the state is not, so it crawls through the subnormal range " +
        "instead of being flushed to zero",
    ).toEqual([]);
  });
});
