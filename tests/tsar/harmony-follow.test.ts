import { describe, expect, it } from "vitest";
import { TsarProcessor } from "../../src/tsar/dsp/tsarProcessor";

/**
 * TSAR harmony-follow arp (A SNAP) — the arp walk can be snapped into the
 * song's scale, or into the chord sounding at the step's bar. The HOST
 * resolves doc.key / arrangement.chords into 12-bit pitch-class masks (the
 * harmonyContext contract — the worklet carries no scale tables); a project
 * without a key yields the chromatic mask, which is a no-op.
 *
 * The snapped pitches are observed through `arpSounding` — the set of notes
 * the arp actually started (runtime-visible internals, the send-pdc probe
 * pattern).
 */

const SR = 48000;
const BLOCK = 128;
/** C major: pcs {0,2,4,5,7,9,11}. */
const C_MAJOR = 2741;
/** C minor: pcs {0,2,3,5,7,8,10}. */
const C_MINOR = 1453; // pcs {0,2,3,5,7,8,10}
/** C major triad: pcs {0,4,7}. */
const C_MAJ_TRIAD = 145;
/** F major triad: pcs {5,9,0}. */
const F_MAJ_TRIAD = 545;

function arpProcessor(params: Record<string, number>, harmony?: Parameters<TsarProcessor["setHarmonyContext"]>[0]) {
  const proc = new TsarProcessor({ sampleRate: SR, harmony });
  proc.applyParams({ arpOn: 1, level: 0.8, ...params });
  return proc;
}

/** Press held notes, force the arp onto its FIRST step, render one block. */
function fireFirstStep(proc: TsarProcessor, pitches: number[], startFrame = 0): Set<number> {
  for (const pitch of pitches) {
    (proc as unknown as { applyEvent: (e: unknown) => void }).applyEvent({ type: "noteOn", when: 0, pitch });
  }
  const inner = proc as unknown as { arpPhase: number; arpStep: number };
  inner.arpPhase = 1; // force the step on the next rendered sample
  inner.arpStep = 0;
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  proc.process(left, right, startFrame);
  return (proc as unknown as { arpSounding: Set<number> }).arpSounding;
}

const pitchClasses = (sounding: Set<number>) => [...sounding].map((pitch) => ((Math.round(pitch) % 12) + 12) % 12);

describe("TSAR harmony-follow arp (A SNAP)", () => {
  it("SCALE mode snaps every step into the project's scale", () => {
    // C#, D# are outside C major — nearest in-scale tones are C and D/E.
    const proc = arpProcessor({ arpSnap: 1 }, { keyRootPc: 0, scaleMask: C_MAJOR, chords: [] });
    const sounding = fireFirstStep(proc, [61]);
    // C# is equidistant from C and D — the tie resolves UPWARD by contract.
    expect([...sounding]).toEqual([62]);
  });

  it("SCALE mode walks a chromatically-pressed pool without leaving the scale", () => {
    const pressed = [61, 63, 65]; // C#, D#, F — D# must not survive
    const seen: number[] = [];
    let forced = 0;
    for (let step = 0; step < pressed.length; step++) {
      const proc2 = arpProcessor({ arpSnap: 1 }, { keyRootPc: 0, scaleMask: C_MAJOR, chords: [] });
      for (const pitch of pressed) {
        (proc2 as unknown as { applyEvent: (e: unknown) => void }).applyEvent({ type: "noteOn", when: 0, pitch });
      }
      const inner = proc2 as unknown as { arpPhase: number; arpStep: number };
      inner.arpPhase = 1;
      inner.arpStep = forced;
      proc2.process(new Float32Array(BLOCK), new Float32Array(BLOCK), 0);
      seen.push(...pitchClasses((proc2 as unknown as { arpSounding: Set<number> }).arpSounding));
      forced += 1;
    }
    const allowed = new Set([0, 2, 4, 5, 7, 9, 11]);
    expect(seen.length).toBeGreaterThan(0);
    for (const pc of seen) expect(allowed.has(pc)).toBe(true);
  });

  it("CHORD mode snaps into the chord sounding at the step's bar (scale fallback outside chords)", () => {
    const harmony = {
      keyRootPc: 0,
      scaleMask: C_MAJOR,
      chords: [
        { startBar: 0, lengthBars: 4, rootPc: 0, chordMask: C_MAJ_TRIAD },
        { startBar: 4, lengthBars: 4, rootPc: 5, chordMask: F_MAJ_TRIAD },
      ],
    };
    // Bar 1 (inside C major): E stays E (chord tone), C# → C.
    const inC = arpProcessor({ arpSnap: 2 }, harmony);
    expect([...fireFirstStep(inC, [64], 1 * 240 * (SR / 120))]).toEqual([64]);
    const cSharp = arpProcessor({ arpSnap: 2 }, harmony);
    expect([...fireFirstStep(cSharp, [61], 1 * 240 * (SR / 120))]).toEqual([60]);
    // Bar 5 (inside F major): E → F, G → A.
    const inF = arpProcessor({ arpSnap: 2 }, harmony);
    expect([...fireFirstStep(inF, [64], 5 * 240 * (SR / 120))]).toEqual([65]);
    const inF2 = arpProcessor({ arpSnap: 2 }, harmony);
    expect([...fireFirstStep(inF2, [67], 5 * 240 * (SR / 120))]).toEqual([69]);
  });

  it("FREE mode (default) and a chromatic mask leave every pitch untouched", () => {
    const free = arpProcessor({}); // no arpSnap → FREE
    expect([...fireFirstStep(free, [61, 63])]).toEqual([61]);
    const chromatic = arpProcessor({ arpSnap: 1 }, { keyRootPc: 0, scaleMask: 0xfff, chords: [] });
    expect([...fireFirstStep(chromatic, [61])]).toEqual([61]);
    // No harmony at all (host without a document) — chromatic by contract.
    const none = arpProcessor({ arpSnap: 1 });
    expect([...fireFirstStep(none, [61])]).toEqual([61]);
  });

  it("C minor scale snaps differently than C major (the mask, not the root, decides)", () => {
    const major = arpProcessor({ arpSnap: 1 }, { keyRootPc: 0, scaleMask: C_MAJOR, chords: [] });
    expect([...fireFirstStep(major, [63])]).toEqual([64]); // D# → nearest in-scale: E (δ1 up)
    const minor = arpProcessor({ arpSnap: 1 }, { keyRootPc: 0, scaleMask: C_MINOR, chords: [] });
    expect([...fireFirstStep(minor, [63])]).toEqual([63]); // D# = Eb, in C minor
  });

  it("the worklet entry validates the harmony payload before the DSP sees it", async () => {
    class FakePort {
      onmessage: ((e: unknown) => void) | null = null;
      postMessage() {}
    }
    class FakeProcessor {
      port = new FakePort();
    }
    const registered = new Map<string, any>();
    const previous = {
      sampleRate: (globalThis as unknown as { sampleRate?: number }).sampleRate,
      processor: (globalThis as unknown as { AudioWorkletProcessor?: unknown }).AudioWorkletProcessor,
      register: (globalThis as unknown as { registerProcessor?: unknown }).registerProcessor,
    };
    (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
    (globalThis as unknown as { currentFrame: number }).currentFrame = 0;
    (globalThis as unknown as { currentTime: number }).currentTime = 0;
    (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeProcessor;
    (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: any) =>
      registered.set(name, cls);
    try {
      await import("../../src/tsar-worklet.entry.js");
      const instance = new (registered.get("tsar-processor") as any)({
        processorOptions: { params: { arpOn: 1, arpSnap: 2, level: 0.8 }, harmony: { garbage: true } },
      });
      // Malformed payload → chromatic default (safe degradation, no throw).
      instance.port.onmessage?.({ data: { type: "harmony", harmony: null } });
      instance.port.onmessage?.({
        data: { type: "harmony", harmony: { keyRootPc: 0, scaleMask: C_MAJOR, chords: [{ startBar: "x" }] } },
      });
      // A well-formed context applies.
      instance.port.onmessage?.({
        data: {
          type: "harmony",
          harmony: {
            keyRootPc: 0,
            scaleMask: C_MAJOR,
            chords: [{ startBar: 0, lengthBars: 8, rootPc: 0, chordMask: C_MAJ_TRIAD }],
          },
        },
      });
      for (const pitch of [61]) {
        instance.proc.applyEvent({ type: "noteOn", when: 0, pitch });
      }
      const inner = instance.proc as unknown as { arpPhase: number; arpStep: number };
      inner.arpPhase = 1;
      inner.arpStep = 0;
      instance.process([], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]]);
      // Inside the C-major chord at bar 0: C# snaps to C.
      expect([...(instance.proc as unknown as { arpSounding: Set<number> }).arpSounding]).toEqual([60]);
    } finally {
      (globalThis as unknown as { sampleRate?: number }).sampleRate = previous.sampleRate;
      (globalThis as unknown as { AudioWorkletProcessor?: unknown }).AudioWorkletProcessor = previous.processor;
      (globalThis as unknown as { registerProcessor?: unknown }).registerProcessor = previous.register;
    }
  });
});
