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
 * `export` keywords are dropped; the harness only needs the side effects
 * (registerProcessor) and the imported helpers.
 */
function inlineSource(file: string, seen = new Set<string>()): string {
  const absolute = resolve(WORKLET_DIR, file);
  if (seen.has(absolute)) return "";
  seen.add(absolute);
  let source = readFileSync(absolute, "utf8");
  source = source.replace(
    /^\s*import\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["'];?\s*$/gm,
    (match: string, specifier: string) => {
      if (!specifier.startsWith(".")) return match; // bare specifier — not expected in worklets
      const target = resolveImport(file, specifier);
      if (!target) return match;
      const targetFile = relative(WORKLET_DIR, target).replace(/\\/g, "/");
      return inlineSource(targetFile, seen);
    },
  );
  return source.replace(/^\s*export\s+/gm, "");
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
    { parameters },
  );
}

type HarnessWithParams = Harness & { parameters: Record<string, Float32Array> };

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
});
