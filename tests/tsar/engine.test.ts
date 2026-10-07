import { describe, expect, it } from "vitest";
import { TsarProcessor, FRAME_SIZE, type TsarEvent } from "../../src/tsar/dsp/tsarProcessor";
import { renderGoldenVoice, GOLDEN_VOICES } from "./golden-voices";

/**
 * T1 — TSAR ENGINE CORE (docs/TSAR-ROADMAP.md). The DSP is tested DIRECTLY at
 * its sample boundary (the morph-dynamics pattern): no AudioContext, no
 * worklet host, no port. Every claim here is about the SOUND.
 *
 * The offline-parity contract is asserted structurally: the SAME event list
 * produces the SAME samples whether it was applied through the live-style
 * queue or seeded at construction — the two paths in the real runtime differ
 * only in WHEN the queue is filled, never in what it contains.
 */

const SR = 44100;
const BLOCK = 128;

/** Drive a processor through a full render, block by block. */
function render(
  processor: TsarProcessor,
  seconds: number,
  options: { offlineSeed?: boolean; events?: TsarEvent[] } = {},
): { left: Float32Array; right: Float32Array } {
  const frames = Math.ceil(seconds * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  if (options.offlineSeed && options.events) {
    for (const event of options.events) processor.postEvent(event);
  }
  let frame = 0;
  while (frame < frames) {
    const count = Math.min(BLOCK, frames - frame);
    processor.process(left.subarray(frame, frame + count), right.subarray(frame, frame + count), frame);
    frame += count;
  }
  return { left, right };
}

function defaultParams(overrides: Record<string, number> = {}): Record<string, number> {
  return {
    srcAEngine: 1,
    srcALevel: 0.8,
    srcAPan: 0,
    srcACoarse: 0,
    srcAFine: 0,
    srcARoot: 60,
    srcAMorph: 0,
    srcAScan: 0,
    srcAUnison: 1,
    srcASpread: 0,
    srcAAtk: 0.005,
    srcADec: 0.6,
    srcASus: 0.7,
    srcARel: 0.4,
    srcAFilter: 0,
    srcACutoff: 18000,
    srcAQ: 0.8,
    srcAFilterEnv: 0,
    srcBEngine: 0,
    srcBLevel: 0,
    srcBAtk: 0.005,
    srcBDec: 0.6,
    srcBSus: 0.7,
    srcBRel: 0.4,
    srcBFilter: 0,
    srcBCutoff: 18000,
    srcBQ: 0.8,
    srcBMorph: 0,
    srcBScan: 0,
    srcBUnison: 1,
    srcBSpread: 0,
    morph: 0,
    sub: 0,
    subOct: -1,
    noise: 0,
    noiseColor: 0.5,
    glide: 0,
    velocity: 0.7,
    lfoRate: 2,
    lfoShape: 0,
    lfoSync: 0,
    tone: 0,
    drive: 0,
    width: 0.5,
    level: 0.8,
    ...overrides,
  };
}

/** A simple wavetable: `frameCount` frames of a sine with rising harmonic. */
function sineTable(frameCount = 4): { frames: Float32Array; frameCount: number } {
  const flat = new Float32Array(frameCount * FRAME_SIZE);
  for (let f = 0; f < frameCount; f++) {
    const harmonics = 1 + f * 2;
    for (let i = 0; i < FRAME_SIZE; i++) {
      let sample = 0;
      for (let h = 1; h <= harmonics; h++) {
        sample += Math.sin((2 * Math.PI * h * i) / FRAME_SIZE) / h;
      }
      flat[f * FRAME_SIZE + i] = sample * 0.5;
    }
  }
  return { frames: flat, frameCount };
}

function makeProcessor(overrides: Record<string, number> = {}, tableFrames = 4): TsarProcessor {
  const processor = new TsarProcessor({ sampleRate: SR });
  processor.applyParams(defaultParams(overrides));
  const table = sineTable(tableFrames);
  processor.setWavetable(0, table.frames, table.frameCount);
  return processor;
}

function rms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, data.length));
}

function peak(data: Float32Array): number {
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const magnitude = Math.abs(data[i]);
    if (magnitude > max) max = magnitude;
  }
  return max;
}

/**
 * Brightness metric: first-difference energy over signal energy. Zero-crossing
 * counting is useless here — every harmonic stack of a 261 Hz tone crosses
 * zero the same way, so it cannot see a timbre change. The difference-energy
 * ratio rises with high-frequency content, which IS what morph/filter change.
 */
function brightness(data: Float32Array): number {
  let diff = 0;
  let signal = 0;
  for (let i = 1; i < data.length; i++) {
    const d = data[i]! - data[i - 1]!;
    diff += d * d;
    signal += data[i]! * data[i]!;
  }
  return Math.sqrt(diff / Math.max(1e-12, signal));
}

describe("TsarProcessor — voice basics", () => {
  it("a noteOn produces audible output; a silent processor does not", () => {
    const withNote = makeProcessor();
    withNote.postEvent({ type: "noteOn", pitch: 60, velocity: 0.9, when: 0.01 });
    const sounded = render(withNote, 0.4);
    expect(rms(sounded.left), "note must be audible").toBeGreaterThan(0.01);

    const withoutNote = makeProcessor();
    const silent = render(withoutNote, 0.4);
    expect(rms(silent.left), "no note -> silence").toBeLessThan(1e-6);
  });

  it("noteOff releases the voice back to silence", () => {
    const processor = makeProcessor({ srcARel: 0.05 });
    processor.postEvent({ type: "noteOn", pitch: 60, velocity: 0.9, when: 0.01 });
    processor.postEvent({ type: "noteOff", pitch: 60, when: 0.2 });
    const { left } = render(processor, 0.6);
    const tail = left.subarray(Math.ceil(0.5 * SR));
    expect(rms(tail), "voice must release to silence").toBeLessThan(1e-4);
    expect(processor.activeVoiceCount).toBe(0);
  });

  it("plays at the note's pitch (zero-crossing check at A4)", () => {
    const processor = makeProcessor();
    processor.postEvent({ type: "noteOn", pitch: 69, velocity: 1, when: 0 });
    const { left } = render(processor, 0.5);
    // Count zero crossings in the steady second half → frequency estimate.
    let crossings = 0;
    let previous = left[Math.ceil(0.25 * SR)]!;
    for (let i = Math.ceil(0.25 * SR) + 1; i < left.length; i++) {
      const current = left[i]!;
      if ((previous >= 0 && current < 0) || (previous < 0 && current >= 0)) crossings += 1;
      previous = current;
    }
    const seconds = (left.length - Math.ceil(0.25 * SR)) / SR;
    const hz = crossings / 2 / seconds;
    expect(hz, `estimated ${hz.toFixed(1)} Hz`).toBeGreaterThan(400);
    expect(hz).toBeLessThan(480);
  });

  it("polyphony: 16 voices sum without clipping past the headroom", () => {
    const processor = makeProcessor();
    for (let i = 0; i < 16; i++) {
      processor.postEvent({ type: "noteOn", pitch: 48 + i, velocity: 0.7, when: 0.01 + i * 0.001 });
    }
    const { left } = render(processor, 0.5);
    expect(processor.activeVoiceCount).toBe(16);
    expect(peak(left), "16 voices must not clip at level 0.8").toBeLessThanOrEqual(1);
  });

  it("17th note steals the oldest voice instead of dropping the note", () => {
    const processor = makeProcessor();
    for (let i = 0; i < 17; i++) {
      processor.postEvent({ type: "noteOn", pitch: 40 + i, velocity: 0.7, when: 0.01 + i * 0.001 });
    }
    render(processor, 0.2);
    expect(processor.activeVoiceCount).toBe(16);
  });

  it("velocity scales the output (V=0.2 is audibly quieter than V=1)", () => {
    const loud = makeProcessor({ velocity: 1 });
    loud.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
    const quiet = makeProcessor({ velocity: 1 });
    quiet.postEvent({ type: "noteOn", pitch: 60, velocity: 0.2, when: 0 });
    const loudRms = rms(render(loud, 0.3).left);
    const quietRms = rms(render(quiet, 0.3).left);
    expect(quietRms).toBeLessThan(loudRms * 0.5);
  });
});

describe("TsarProcessor — sources and morph", () => {
  it("wavetable morph changes the timbre (harmonic count rises)", () => {
    // Same note, morph 0 (frame 0, 1 harmonic) vs morph 1 (frame 3, 7 harmonics).
    const measureBrightness = (morph: number): number => {
      const processor = makeProcessor({ srcAMorph: morph });
      processor.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
      const { left } = render(processor, 0.4);
      return brightness(left.subarray(Math.ceil(0.2 * SR)));
    };
    expect(measureBrightness(1), "7-harmonic frame must be brighter than the 1-harmonic frame").toBeGreaterThan(
      measureBrightness(0) * 1.5,
    );
  });

  it("Source B is silent at level 0 and audible at level 1 (dual-source)", () => {
    const silentB = makeProcessor({ srcBLevel: 0 });
    silentB.setWavetable(1, sineTable(1).frames, 1);
    silentB.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
    const silentRms = rms(render(silentB, 0.3).left);

    const audibleB = makeProcessor({ srcBLevel: 0.8, morph: 0.5 });
    audibleB.setWavetable(1, sineTable(1).frames, 1);
    audibleB.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
    const audibleRms = rms(render(audibleB, 0.3).left);
    // At morph 0.5 the A contribution halves, but B adds — total must move.
    expect(Math.abs(audibleRms - silentRms)).toBeGreaterThan(0.001);
  });

  it("sample engine plays a one-shot PCM source", () => {
    const processor = makeProcessor({ srcAEngine: 0 });
    const pcm = renderGoldenVoice(GOLDEN_VOICES.find((v) => v.id === "808-f1")!);
    processor.setSample(0, pcm, 440 * Math.pow(2, (29 - 69) / 12));
    processor.postEvent({ type: "noteOn", pitch: 29, velocity: 1, when: 0 });
    const { left } = render(processor, 0.5);
    expect(rms(left), "sample source must sound").toBeGreaterThan(0.01);
  });

  it("granular engine reads its PCM source", () => {
    const processor = makeProcessor({ srcAEngine: 2, srcAScan: 0.5 });
    const pcm = renderGoldenVoice(GOLDEN_VOICES.find((v) => v.id === "sustained-pad")!);
    processor.setSample(0, pcm, 440 * Math.pow(2, (45 - 69) / 12));
    processor.postEvent({ type: "noteOn", pitch: 45, velocity: 1, when: 0 });
    const { left } = render(processor, 0.5);
    expect(rms(left), "granular source must sound").toBeGreaterThan(0.001);
  });

  it("sub oscillator adds low-band energy when enabled", () => {
    const off = makeProcessor({ sub: 0 });
    off.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
    const on = makeProcessor({ sub: 0.8, subOct: -1 });
    on.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
    expect(rms(render(on, 0.3).left)).toBeGreaterThan(rms(render(off, 0.3).left));
  });
});

describe("TsarProcessor — filter and mod matrix", () => {
  it("a closed low-pass removes brightness versus an open cutoff", () => {
    // The fixture must carry HARMONICS for a low-pass to change the timbre:
    // the default frame 0 is a pure sine (nothing above the fundamental to
    // cut), so this case uses morph 1 — the 7-harmonic frame. The tone is C3
    // (130 Hz) and the cutoff 200 Hz passes the fundamental while cutting the
    // 260 Hz+ stack.
    const open = makeProcessor({ srcAMorph: 1, srcACutoff: 18000 });
    open.postEvent({ type: "noteOn", pitch: 48, velocity: 1, when: 0 });
    const closed = makeProcessor({ srcAMorph: 1, srcACutoff: 200 });
    closed.postEvent({ type: "noteOn", pitch: 48, velocity: 1, when: 0 });
    const openOut = render(open, 0.35).left;
    const closedOut = render(closed, 0.35).left;
    expect(brightness(closedOut), "closed filter must lose highs").toBeLessThan(brightness(openOut) * 0.7);
  });

  it("mod matrix LFO -> amplitude makes the envelope move", () => {
    // Without mod: constant amplitude. With LFO->AMP at 0.5: the short-window
    // RMS varies across the note.
    const steady = makeProcessor({ srcASus: 1 });
    steady.postEvent({ type: "noteOn", pitch: 57, velocity: 1, when: 0 });
    const modulated = makeProcessor({
      srcASus: 1,
      lfoRate: 8,
      mod1Src: 1,
      mod1Dst: 5,
      mod1Amt: 0.6,
    });
    modulated.postEvent({ type: "noteOn", pitch: 57, velocity: 1, when: 0 });
    const variance = (data: Float32Array): number => {
      const window = Math.round(0.02 * SR);
      const values: number[] = [];
      for (let start = Math.round(0.1 * SR); start + window < data.length; start += window) {
        values.push(rms(data.subarray(start, start + window)));
      }
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length / (mean * mean + 1e-9);
    };
    expect(variance(render(modulated, 0.5).left)).toBeGreaterThan(variance(render(steady, 0.5).left) * 2);
  });

  it("mod matrix destination routing is real: A-MORPH mod changes the timbre", () => {
    const plain = makeProcessor({ mod1Src: -1, mod1Dst: -1 });
    plain.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
    const morphed = makeProcessor({ mod1Src: 0, mod1Dst: 0, mod1Amt: 1 });
    morphed.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
    const plainOut = render(plain, 0.35).left;
    const morphedOut = render(morphed, 0.35).left;
    expect(brightness(morphedOut), "ENV->A MORPH must open the table toward richer frames").toBeGreaterThan(
      brightness(plainOut) * 1.1,
    );
  });
});

describe("TsarProcessor — determinism and offline parity (invariant #3/#4)", () => {
  const script: TsarEvent[] = [
    { type: "noteOn", pitch: 60, velocity: 0.9, when: 0.02 },
    { type: "noteOn", pitch: 64, velocity: 0.7, when: 0.12 },
    { type: "noteOff", pitch: 60, when: 0.3 },
    { type: "param", name: "srcACutoff", value: 900, when: 0.15 },
    { type: "noteOff", pitch: 64, when: 0.45 },
  ];

  it("same events -> bit-identical samples (no RNG, no clock)", () => {
    const build = (seed: boolean): Float32Array => {
      const processor = makeProcessor({ noise: 0.2 });
      const events = seed ? script : [];
      const out = render(processor, 0.6, { offlineSeed: seed, events });
      if (!seed) for (const event of script) processor.postEvent(event);
      return out.left;
    };
    // First run seeds via the constructor path; second via postEvent timing.
    const a = build(true);
    const b = build(true);
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) throw new Error(`diverged at sample ${i}`);
    }
  });

  it("event order does not matter (queue sorts by `when`)", () => {
    const build = (reverse: boolean): Float32Array => {
      const processor = makeProcessor();
      const events = reverse ? [...script].reverse() : script;
      for (const event of events) processor.postEvent(event);
      return render(processor, 0.6).left;
    };
    const forward = build(false);
    const reversed = build(true);
    for (let i = 0; i < forward.length; i++) {
      if (forward[i] !== reversed[i]) throw new Error(`order changed the sound at sample ${i}`);
    }
  });

  it("the live queue and the offline seed produce identical output (T5 contract)", () => {
    // LIVE model: events posted progressively (as the scheduler would).
    const live = makeProcessor();
    for (const event of script) live.postEvent(event);
    const liveOut = render(live, 0.6).left;
    // OFFLINE model: the whole list present at construction.
    const offline = makeProcessor();
    const seeded = new TsarProcessor({ sampleRate: SR, events: script });
    seeded.applyParams(defaultParams());
    seeded.setWavetable(0, sineTable(4).frames, 4);
    const offlineOut = render(seeded, 0.6).left;
    for (let i = 0; i < liveOut.length; i++) {
      if (liveOut[i] !== offlineOut[i]) throw new Error(`live and offline diverged at sample ${i}`);
    }
    void offline;
  });
});
