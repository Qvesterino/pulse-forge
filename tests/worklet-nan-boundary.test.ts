/**
 * Systemic non-finite input boundary regression (generic effect worklets).
 *
 * One NaN/Infinity render quantum used to latch the recursive state of most
 * generic effects (delay rings, biquad memories, envelope followers, LFO
 * phases), so every later block stayed NaN and the track was silent forever.
 * Each processor now sanitizes the samples it reads at the graph boundary.
 *
 * The test loads the real processor sources under a stubbed
 * AudioWorkletGlobalScope, feeds one poisoned block, then 220 blocks (~587 ms)
 * of a finite two-tone signal — long enough for the default 375 ms delay
 * lines to reach the poisoned region. It asserts that NOTHING non-finite
 * survives into any output channel. It deliberately does not assert a
 * particular sound: defaults differ per effect, and the contract under test is
 * recovery.
 *
 * Processors that import a local helper module (LIMITER's oversampler, WOW &
 * FLUTTER's shared math) are evaluated with that helper's source prepended, so
 * the test exercises the real class rather than a copy.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage() {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

const SR = 48000;
const BLOCK = 128;

const FILES = [
  "envfollower",
  "compressor",
  "stepgate",
  "svfilter",
  "flanger",
  "tremolo",
  "autowah",
  "stutter",
  "tape",
  "comb",
  "multitap",
  "vowel",
  "ducking-delay",
  "eq",
  "chorus",
  "stock-delay",
  "reverb",
  "ringmod",
  "tapestop",
  "freqshifter",
  "pitchshift",
  "pitchcorrect",
  "vinyl",
  "beatmangler",
  "bassbuss-sub",
  "reverseswell",
  "granularfreeze",
  "bass-harmonic",
  "sirka",
  "prud",
  "apeks",
  "gate",
  "transient",
  "sidechain",
  "limiter",
  "wowflutter",
];

const DEPS: Record<string, string[]> = {
  limiter: ["audio-worklets/limiter-oversampler-constants.js", "audio-worklets/limiter-oversampler.js"],
  wowflutter: ["shared/wowflutter-math.js"],
};

interface Processor {
  process: (inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) => boolean;
}

function loadProcessor(name: string): new () => Processor {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { currentTime: number }).currentTime = 0;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  let captured: unknown = null;
  const root = resolve(import.meta.dirname ?? ".", "..", "src");
  const strip = (src: string) =>
    src
      .replace(/^import\s+[^;]+;\s*/gm, "")
      .replace(/^export\s*\{[^}]*\}\s*from\s+["'][^"']+["'];?\s*/gm, "")
      .replace(/^export\s*\{[^}]*\};?\s*/gm, "")
      .replace(/^export /gm, "");
  const prelude =
    (DEPS[name] ?? []).map((dep) => strip(readFileSync(resolve(root, dep), "utf-8"))).join("\n") +
    (name === "wowflutter"
      ? "\nconst BASE_DELAY_SECONDS = WF_BASE_DELAY_SECONDS;\n" +
        "const MIN_OFFSET_SAMPLES = WF_MIN_OFFSET_SAMPLES;\n" +
        "const DRIFT_MAX_CENTS = WF_DRIFT_MAX_CENTS;\n" +
        "const DRIFT_RATE_HZ = WF_DRIFT_RATE_HZ;\n"
      : "");
  const source = prelude + strip(readFileSync(resolve(root, "audio-worklets", `${name}-processor.js`), "utf-8"));
  const host = new Function("registerProcessor", "AudioWorkletProcessor", "globalThis", source);
  host((_id: string, cls: unknown) => (captured = cls), FakeAudioWorkletProcessor, globalThis);
  if (!captured) throw new Error(`no processor registered in ${name}-processor.js`);
  return captured as new () => Processor;
}

function defaults(cls: unknown): Record<string, Float32Array> {
  const descriptors =
    (cls as { parameterDescriptors?: Array<{ name: string; defaultValue: number }> }).parameterDescriptors ?? [];
  return Object.fromEntries(descriptors.map((d) => [d.name, Float32Array.of(d.defaultValue)]));
}

function allFinite(channels: Float32Array[]): boolean {
  for (const ch of channels) for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) return false;
  return true;
}

function signal(startSample: number): [Float32Array, Float32Array] {
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    const n = startSample + i;
    l[i] = 0.4 * Math.sin((2 * Math.PI * 440 * n) / SR) + 0.2 * Math.sin((2 * Math.PI * 1200 * n) / SR);
    r[i] = 0.35 * Math.sin((2 * Math.PI * 660 * n) / SR) + 0.15 * Math.sin((2 * Math.PI * 1700 * n) / SR);
  }
  return [l, r];
}

describe.each(FILES)("%s processor — non-finite input boundary", (name) => {
  it("recovers from a NaN/Infinity block and never emits non-finite audio", () => {
    const Ctor = loadProcessor(name);
    const proc = new Ctor();
    const params = defaults(Ctor);
    // Exercise the limiter's oversampler history, not only its 1x path.
    if (name === "limiter") params.oversample = Float32Array.of(2);

    const bad = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) bad[i] = i % 2 === 0 ? NaN : i % 4 === 1 ? Infinity : -Infinity;
    const poisonOut = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    proc.process(
      [
        [bad, bad],
        [bad, bad],
      ],
      [poisonOut],
      params,
    );

    // Long enough for the default 375 ms delay lines to read the poisoned
    // region (24 blocks would only prove the dry path was clean).
    for (let b = 0; b < 220; b++) {
      const [l, r] = signal(b * BLOCK);
      const outL = new Float32Array(BLOCK);
      const outR = new Float32Array(BLOCK);
      proc.process(
        [
          [l, r],
          [l, r],
        ],
        [[outL, outR]],
        params,
      );
      expect(allFinite([outL, outR]), `block ${b} must be finite`).toBe(true);
    }
  });
});
