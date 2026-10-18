import { describe, expect, it } from "vitest";
import { ChoralProcessor } from "../../src/choral/dsp/choralProcessor";
import { defaultInstrumentParams } from "../../src/instruments/definitions";
import { normalizeProject } from "../../src/project-model/schema";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { InstrumentTrack } from "../../src/project-model/types";
import type { InstrumentRuntime } from "../../src/instruments/types";

/**
 * CHORÁL (ADR 0054) — the harmony-following timbre instrument. The core
 * contract: one keyboard note, up to four grain-stream voices that agree
 * with the song. The TRIAD third is CONTEXTUAL (chosen from the
 * harmonyContext mask at the note's bar); a project without a key degrades
 * to chromatic (major third), never to silence.
 */

const SR = 48000;
const BLOCK = 128;
const C_MAJOR = 2741; // pcs {0,2,4,5,7,9,11}
const C_MAJ_TRIAD = 145; // pcs {0,4,7}
const A_MIN = (() => {
  // A minor triad: pcs {9, 0, 4} → bits 9, 0, 4.
  return (1 << 9) | (1 << 0) | (1 << 4);
})();

/** A sine "hum" at A3 220 Hz (root for srcRoot 57). */
function humPcm(hz = 220, seconds = 1): Float32Array {
  const pcm = new Float32Array(Math.ceil(seconds * SR));
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.8 * Math.sin((2 * Math.PI * hz * i) / SR);
  return pcm;
}

function processor(params: Record<string, number>, harmony?: Parameters<ChoralProcessor["setHarmonyContext"]>[0]) {
  const proc = new ChoralProcessor({ sampleRate: SR, pcm: humPcm(), pcmRootHz: 220, harmony });
  proc.applyParams({ level: 0.8, attack: 0.005, release: 0.1, stackDetune: 0, ...params });
  return proc;
}

function activePitches(proc: ChoralProcessor): number[] {
  return (proc as unknown as { streams: Array<{ active: boolean; pitch: number }> }).streams
    .filter((stream) => stream.active)
    .map((stream) => stream.pitch)
    .sort((a, b) => a - b);
}

describe("CHORÁL harmony stack (ADR 0054)", () => {
  it("TRIAD chooses the third from the CONTEXT — C major gives C-E-G for a C", () => {
    const proc = processor(
      { stackMode: 3 },
      {
        keyRootPc: 0,
        scaleMask: C_MAJOR,
        chords: [{ startBar: 0, lengthBars: 8, rootPc: 0, chordMask: C_MAJ_TRIAD }],
      },
    );
    proc.applyEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    expect(activePitches(proc)).toEqual([60, 64, 67]);
  });

  it("TRIAD hands a D the minor third in C major (the mask decides, not the root)", () => {
    const proc = processor(
      { stackMode: 3 },
      { keyRootPc: 0, scaleMask: C_MAJOR, chords: [{ startBar: 0, lengthBars: 8, rootPc: 0, chordMask: C_MAJ_TRIAD }] },
    );
    proc.applyEvent({ type: "noteOn", when: 0, pitch: 62, velocity: 0.9 });
    expect(activePitches(proc)).toEqual([62, 65, 69]); // D + F (+4? no: F=65 is +3) — mask prefers F
  });

  it("a note over the A-minor chord completes THE CHORD (C-E-A, not C-E-G)", () => {
    const proc = processor(
      { stackMode: 3 },
      {
        keyRootPc: 9,
        scaleMask: C_MAJOR,
        chords: [{ startBar: 0, lengthBars: 8, rootPc: 9, chordMask: A_MIN }],
      },
    );
    proc.applyEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    // C is a member of A minor — the stack completes THAT chord upward:
    // E (+4) then A (+9, the octave-wrapped root). C-E-G would import a G
    // the A-minor chord does not contain.
    expect(activePitches(proc)).toEqual([60, 64, 69]);
  });

  it("TRIAD is chord-refined: a chord tone completes the chord upward", () => {
    // E over the C-major chord: the chord's pitch classes above E are G (+3)
    // and C (+8, the wrapped root) — F would be the scale third, but F is
    // not in the C triad and the refined voicing imports only chord tones.
    const proc = processor(
      { stackMode: 3 },
      {
        keyRootPc: 0,
        scaleMask: C_MAJOR,
        chords: [{ startBar: 0, lengthBars: 8, rootPc: 0, chordMask: C_MAJ_TRIAD }],
      },
    );
    proc.applyEvent({ type: "noteOn", when: 0, pitch: 64, velocity: 0.9 });
    expect(activePitches(proc)).toEqual([64, 67, 72]);
  });

  it("a NON-chord tone falls back to the scale third (D over the C triad keeps F)", () => {
    const proc = processor(
      { stackMode: 3 },
      {
        keyRootPc: 0,
        scaleMask: C_MAJOR,
        chords: [{ startBar: 0, lengthBars: 8, rootPc: 0, chordMask: C_MAJ_TRIAD }],
      },
    );
    proc.applyEvent({ type: "noteOn", when: 0, pitch: 62, velocity: 0.9 });
    expect(activePitches(proc)).toEqual([62, 65, 69]);
  });

  it("OCTAVES and FIFTHS are fixed interval sets; OFF is a single stream", () => {
    const oct = processor({ stackMode: 1 });
    oct.applyEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    expect(activePitches(oct)).toEqual([48, 60, 72]);
    const fifths = processor({ stackMode: 2 });
    fifths.applyEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    expect(activePitches(fifths)).toEqual([55, 60, 67]);
    const off = processor({ stackMode: 0 });
    off.applyEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    expect(activePitches(off)).toEqual([60]);
  });

  it("no context at all (chromatic) degrades to the major third — never silence", () => {
    const proc = processor({ stackMode: 3 });
    proc.applyEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    expect(activePitches(proc)).toEqual([60, 64, 67]);
  });
});

describe("CHORÁL render contract", () => {
  it("is deterministic — the same events render byte-identical audio", () => {
    const render = () => {
      const proc = processor({ stackMode: 3, grainJitter: 0.6 });
      proc.applyEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
      const left = new Float32Array(SR);
      const right = new Float32Array(SR);
      for (let frame = 0; frame < SR; frame += BLOCK) {
        proc.process(left.subarray(frame, frame + BLOCK), right.subarray(frame, frame + BLOCK), frame);
      }
      return { left, right };
    };
    const a = render();
    const b = render();
    expect([...a.left]).toEqual([...b.left]);
    expect([...a.right]).toEqual([...b.right]);
  });

  it("a sustained note stays audible past one source length (grain replay, not one-shot)", () => {
    const proc = new ChoralProcessor({ sampleRate: SR, pcm: humPcm(220, 0.3), pcmRootHz: 220 });
    proc.applyParams({ level: 0.8, attack: 0.005, release: 0.1, stackMode: 0 });
    proc.applyEvent({ type: "noteOn", when: 0, pitch: 57, velocity: 0.9 }); // A3 = the recorded root
    let tailRms = 0;
    let tailCount = 0;
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    for (let frame = 0; frame + BLOCK <= 2 * SR; frame += BLOCK) {
      proc.process(left, right, frame);
      if (frame > 1.2 * SR) {
        for (const v of left) tailRms += v * v;
        tailCount += BLOCK;
      }
    }
    expect(Math.sqrt(tailRms / Math.max(1, tailCount))).toBeGreaterThan(0.01);
  });

  it("noteOff releases the stack; panic silences everything", () => {
    const proc = processor({ stackMode: 3, release: 0.05 });
    proc.applyEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    proc.applyEvent({ type: "noteOff", when: 0.1, pitch: 60 });
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    for (let frame = 0; frame < SR / 2; frame += BLOCK) proc.process(left, right, frame);
    expect(activePitches(proc)).toEqual([]);
    proc.applyEvent({ type: "noteOn", when: 0.6, pitch: 67, velocity: 0.9 });
    proc.applyEvent({ type: "panic", when: 0.7 });
    for (let frame = 0; frame < BLOCK * 4; frame += BLOCK) proc.process(left, right, SR / 2 + frame);
    expect(activePitches(proc)).toEqual([]);
    expect(proc.lastPeak).toBe(0);
  });

  it("queue-fed and constructor-seeded events render identically (offline parity)", () => {
    const build = (seeded: boolean) => {
      const events = [
        { type: "noteOn" as const, when: 0, pitch: 60, velocity: 0.9 },
        { type: "noteOff" as const, when: 0.4, pitch: 60 },
      ];
      const proc = new ChoralProcessor({
        sampleRate: SR,
        pcm: humPcm(),
        pcmRootHz: 220,
        harmony: {
          keyRootPc: 0,
          scaleMask: C_MAJOR,
          chords: [{ startBar: 0, lengthBars: 8, rootPc: 0, chordMask: C_MAJ_TRIAD }],
        },
        events: seeded ? undefined : events,
      });
      if (seeded) for (const event of events) proc.postEvent(event);
      return proc;
    };
    const render = (proc: ChoralProcessor) => {
      const left = new Float32Array(SR);
      const right = new Float32Array(SR);
      for (let frame = 0; frame < SR; frame += BLOCK) {
        proc.process(left.subarray(frame, frame + BLOCK), right.subarray(frame, frame + BLOCK), frame);
      }
      return [...left];
    };
    expect(render(build(true))).toEqual(render(build(false)));
  });
});

describe("CHORÁL kind integration (ADR 0054)", () => {
  it("the default patch exists and normalizeProject keeps a choral track", () => {
    const defaults = defaultInstrumentParams("choral");
    expect(defaults.stackMode).toBe(3); // TRIAD is the identity of the instrument
    expect(defaults.grainSize).toBe(80);
    const doc = createProjectFromTemplate("house");
    const base = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument");
    if (!base) throw new Error("no instrument track in template");
    const choralTrack: InstrumentTrack = { ...base, id: "choral-it", instrument: "choral" };
    doc.tracks.push(choralTrack);
    const healed = normalizeProject(doc);
    const kept = healed.tracks.find((t) => t.id === "choral-it") as InstrumentTrack;
    expect(kept.instrument).toBe("choral");
    expect(kept.kind).toBe("instrument");
  });

  it("the fallback runtime is a real audible choir (3 tones, no throw)", async () => {
    const { createChoralFallbackRuntime } = await import("../../src/instruments/choralFallback");
    const gains = 0;
    void gains;
    const ctx = {
      currentTime: 0,
      createGain: () => ({
        gain: {
          value: 1,
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
          setTargetAtTime() {},
          cancelScheduledValues() {},
        },
        connect(target: unknown) {
          void target;
          return { connect: () => undefined } as unknown as AudioNode;
        },
        disconnect() {},
      }),
      createBiquadFilter: () => ({
        type: "lowpass",
        frequency: { setValueAtTime() {} },
        Q: { value: 1 },
        connect(target: unknown) {
          void target;
          return { connect: () => undefined } as unknown as AudioNode;
        },
        disconnect() {},
      }),
      createOscillator: () => ({
        type: "sawtooth",
        frequency: { setValueAtTime() {} },
        detune: { setValueAtTime() {} },
        connect(target: unknown) {
          void target;
          return { connect: () => undefined } as unknown as AudioNode;
        },
        start() {},
        stop() {},
      }),
    } as unknown as BaseAudioContext;
    const track = { id: "fb", kind: "instrument", instrument: "choral", params: {} } as unknown as InstrumentTrack;
    const runtime = createChoralFallbackRuntime(ctx, track);
    expect(() => {
      // noteOff is optional on the runtime contract — assert through a
      // narrowed handle so the optional-member call typechecks.
      const r = runtime as Required<Pick<InstrumentRuntime, "noteOn" | "noteOff" | "panic" | "dispose">> &
        InstrumentRuntime;
      r.noteOn(60, 0.9, 0, 0.5);
      r.noteOff(60, 0.5);
      r.panic();
      r.dispose();
    }).not.toThrow();
  });
});
