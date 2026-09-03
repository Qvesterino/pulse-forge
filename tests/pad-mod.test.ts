import { describe, expect, it } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import { baseDocument } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { setPadMod } from "../src/commands/commands";
import type { DrumTrack, PadMod, ProjectDocument } from "../src/project-model/types";

function makeDrumTrack(mod: PadMod | null): DrumTrack {
  return {
    id: "drum-mod-test",
    kind: "drum",
    name: "Drums",
    gain: 0.9,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
    sends: {},
    pads: [
      {
        id: "pad-mod-0",
        name: "Test Tone",
        assetId: "test.tone",
        gain: 1,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        chokeGroup: null,
        mod,
      },
    ],
  };
}

function makeDoc(mod: PadMod | null): ProjectDocument {
  const doc = baseDocument("Pad Mod Test", 120);
  return { ...doc, tracks: [makeDrumTrack(mod)] };
}

/** Window RMS helper — used to observe amplitude wobble. */
function windowRms(data: Float32Array, start: number, length: number): number {
  let sum = 0;
  for (let i = start; i < start + length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / length);
}

function zeroCrossings(data: Float32Array, start: number, length: number): number {
  let count = 0;
  for (let i = start + 1; i < start + length; i++) {
    if (data[i - 1] <= 0 && data[i] > 0) count += 1;
  }
  return count;
}

describe.skipIf(typeof OfflineAudioContext === "undefined")("per-pad mod (voice-local LFO)", () => {
  const SR = 44100;

  function toneBuffer(ctx: BaseAudioContext, freq: number, dur: number): AudioBuffer {
    const buffer = ctx.createBuffer(1, Math.ceil(SR * dur), SR);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.5;
    return buffer;
  }

  async function renderWith(mod: PadMod | null, freq = 220): Promise<AudioBuffer> {
    const dur = 1.0;
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * dur), SR);
    const engine = new AudioEngine();
    engine.attachBank({ get: () => toneBuffer(ctx, freq, dur) } as never);
    engine.useContext(ctx);
    const doc = makeDoc(mod);
    engine.setProject(doc);
    const drum = doc.tracks[0] as DrumTrack;
    engine.trigger(drum.id, drum.pads[0], 0.05, 1);
    return ctx.startRendering();
  }

  it("gain-target LFO tremolos the voice (adjacent windows alternate)", async () => {
    const plain = (await renderWith(null)).getChannelData(0);
    const mod = (await renderWith({ target: "gain", wave: "sine", rateHz: 8, depth: 1 })).getChannelData(0);
    const win = Math.floor(SR * 0.03125); // quarter period at 8 Hz
    const rms = (data: Float32Array) =>
      Array.from({ length: 16 }, (_, i) => windowRms(data, Math.floor(SR * 0.2) + i * win, win));
    const plainSpread = Math.max(...rms(plain)) / Math.max(0.0001, Math.min(...rms(plain)));
    const modVals = rms(mod);
    const modRatio = Math.max(...modVals) / Math.max(0.0001, Math.min(...modVals));
    // Constant tone: flat envelope. Tremolo at depth 1: dips near zero.
    expect(plainSpread).toBeLessThan(1.5);
    expect(modRatio).toBeGreaterThan(2);
  });

  it("pitch-target LFO sweeps the playback rate (zero crossings wander)", async () => {
    const win = Math.floor(SR * 0.0625); // 62.5 ms analysis windows
    const start = Math.floor(SR * 0.2);
    const crossings = (data: Float32Array) =>
      Array.from({ length: 10 }, (_, i) => zeroCrossings(data, start + i * win, win));
    const spread = (data: Float32Array) => {
      const c = crossings(data);
      return Math.max(...c) - Math.min(...c);
    };
    const plain = (await renderWith(null, 440)).getChannelData(0);
    const mod = (await renderWith({ target: "pitch", wave: "sine", rateHz: 2, depth: 12 }, 440)).getChannelData(0);
    // Steady 440 Hz: ~55 crossings per window everywhere. Sweeping ±12 st: 110–880 Hz → wide wander.
    expect(spread(plain)).toBeLessThan(8);
    expect(spread(mod)).toBeGreaterThan(25);
  });

  it("filter-target LFO creates the voice filter and sweeps it", async () => {
    const mod = (await renderWith({ target: "filter", wave: "sine", rateHz: 3, depth: 4000, base: 700 }, 220)).getChannelData(0);
    let peak = 0;
    for (let i = 0; i < mod.length; i++) peak = Math.max(peak, Math.abs(mod[i]));
    // Voice still audible through the sweeping lowpass.
    expect(peak).toBeGreaterThan(0.01);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("per-pad mod model + command", () => {
  it("normalizeProject keeps a legal mod and clamps wild values", () => {
    const doc = makeDoc({ target: "pitch", wave: "square", rateHz: 3, depth: 6 });
    const norm = normalizeProject(JSON.parse(JSON.stringify(doc)));
    const pad = (norm.tracks[0] as DrumTrack).pads[0];
    expect(pad.mod).toEqual({ target: "pitch", wave: "square", rateHz: 3, depth: 6 });

    const wild = makeDoc({ target: "gain", wave: "sawtooth" as PadMod["wave"], rateHz: 999, depth: 12 });
    const normWild = normalizeProject(JSON.parse(JSON.stringify(wild)));
    const wildPad = (normWild.tracks[0] as DrumTrack).pads[0];
    expect(wildPad.mod).toMatchObject({ target: "gain", rateHz: 40, depth: 1 });
  });

  it("normalizeProject strips unknown targets and disabled mods", () => {
    const bad = makeDoc({ target: "laser" as unknown as PadMod["target"], wave: "sine", rateHz: 3, depth: 2 });
    const normBad = normalizeProject(JSON.parse(JSON.stringify(bad)));
    expect((normBad.tracks[0] as DrumTrack).pads[0].mod ?? null).toBeNull();

    const zero = makeDoc({ target: "gain", wave: "sine", rateHz: 3, depth: 0 });
    const normZero = normalizeProject(JSON.parse(JSON.stringify(zero)));
    expect((normZero.tracks[0] as DrumTrack).pads[0].mod ?? null).toBeNull();
  });

  it("setPadMod assigns and clears with undo", () => {
    const doc = makeDoc(null);
    const mod: PadMod = { target: "filter", wave: "triangle", rateHz: 1.5, depth: 2500, base: 900 };
    const cmd = setPadMod(doc, "pad-mod-0", mod);
    const next = cmd.execute(doc);
    expect(((next.tracks[0] as DrumTrack).pads[0].mod ?? null)).toEqual(mod);
    expect(((cmd.undo(next).tracks[0] as DrumTrack).pads[0].mod ?? null)).toBeNull();
    expect(() => setPadMod(doc, "missing", mod)).toThrow(/not found/);
  });
});
