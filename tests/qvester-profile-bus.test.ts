import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bandLevel,
  beatPulseSample,
  buildProfileFromWindow,
  dbToUnit,
  PROFILE_BUS_CHANNEL,
  PROFILE_BUS_PUBLISHER_APP,
  startQvesterProfileBus,
  windowToCurve,
  type ProfileBusCurveWindow,
} from "../src/interop/qvesterProfileBus";
import type { Services } from "../src/services";

/**
 * QVESTER audio-profile bus publisher (channel pulse_forge). The envelope
 * mirrors the Qvester contract exactly: schema "qvester.audio-profile-bus/v1"
 * under `qvester:audio-profile:v1:pulse_forge`, monotonic revision, bounded
 * profile (curves ≤600 frames, duration ≤10 s, values clamped [0,1]) — so
 * their `sanitizeAudioProfileForBus` accepts it untouched and their
 * consumers can loop the curves against their own render time.
 */

vi.stubGlobal("crypto", webcrypto);

function makeWindow(filled = 300, value = 0.5): ProfileBusCurveWindow {
  const fill = (arr: Float32Array) => {
    for (let i = 0; i < filled; i++) arr[i] = value;
    return arr;
  };
  return {
    energy: fill(new Float32Array(300)),
    beat: fill(new Float32Array(300)),
    bands: {
      bass: fill(new Float32Array(300)),
      lowMid: fill(new Float32Array(300)),
      mid: fill(new Float32Array(300)),
      highMid: fill(new Float32Array(300)),
      high: fill(new Float32Array(300)),
    },
    filled,
    durationSec: filled / 30,
  };
}

describe("profile bus sampling helpers", () => {
  it("maps the dB window onto clamped units", () => {
    expect(dbToUnit(-90)).toBe(0);
    expect(dbToUnit(-10)).toBe(1);
    expect(dbToUnit(-50)).toBeCloseTo(0.5, 5);
    expect(dbToUnit(Number.NaN)).toBe(0);
    expect(dbToUnit(-300)).toBe(0);
    expect(dbToUnit(50)).toBe(1);
  });

  it("shapes the beat pulse as a sawtooth that peaks on the grid", () => {
    expect(beatPulseSample(0)).toBe(1);
    expect(beatPulseSample(0.075)).toBeCloseTo(0.5, 5);
    expect(beatPulseSample(0.15)).toBe(0);
    expect(beatPulseSample(0.9)).toBe(0);
  });

  it("averages band bins over the clamped dB units", () => {
    const bins = new Float32Array(16);
    for (let i = 4; i < 8; i++) bins[i] = -50;
    expect(bandLevel(bins, 4, 8)).toBeCloseTo(0.5, 5);
    // bins below bin 1 are DC — never sampled
    expect(bandLevel(bins, 0, 1)).toBe(0);
  });

  it("reads the ring window oldest-first and clamps curve frames", () => {
    const ring = new Float32Array(300);
    // filled=250 (no wrap): samples 0..249
    for (let i = 0; i < 250; i++) ring[i] = i / 1000;
    const curve = windowToCurve(ring, 250);
    expect(curve.length).toBe(250);
    expect(curve[0]).toBeCloseTo(0, 5);
    expect(curve[249]).toBeCloseTo(0.249, 3);
    // wrapped: filled=400 → oldest starts at index (400 % 300)=100
    const wrapped = new Float32Array(300);
    for (let i = 0; i < 300; i++) wrapped[i] = 1;
    expect(windowToCurve(wrapped, 400).length).toBe(300);
    // oversized values clamp
    const hot = new Float32Array(300).fill(7);
    expect(windowToCurve(hot, 300).every((v) => v === 1)).toBe(true);
  });
});

describe("profile builder (their contract shape)", () => {
  it("produces a bounded, contract-shaped profile", () => {
    const window = makeWindow(300);
    const profile = buildProfileFromWindow(window, { bpm: 124, beatPhase: 0.3, latestBands: { bass: 0.7 } });
    expect(profile.bpm).toBe(124);
    expect(profile.duration).toBeLessThanOrEqual(10);
    expect(profile.sampleRate).toBe(30);
    expect(profile.energyCurve.length).toBeLessThanOrEqual(600);
    expect(profile.beatCurve.length).toBe(profile.energyCurve.length);
    expect(profile.beatPhase).toBeGreaterThanOrEqual(0);
    expect(profile.beatPhase).toBeLessThanOrEqual(1);
    expect(profile.bands.bass).toBe(0.7);
    for (const curve of Object.values(profile.bandCurves)) {
      expect(curve.length).toBeLessThanOrEqual(600);
      expect(curve.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
    }
  });

  it("sanitizes a hostile window (NaN samples, overfilled) without poison", () => {
    const window = makeWindow(300, Number.NaN);
    window.filled = 500; // overfilled on purpose — builder must clamp to 300 frames
    const profile = buildProfileFromWindow(window, { bpm: Number.NaN, beatPhase: 2, latestBands: {} });
    expect(profile.bpm).toBe(0);
    expect(profile.beatPhase).toBe(1);
    expect(profile.energyCurve.length).toBe(300);
    expect(profile.energyCurve.every((v) => v === 0)).toBe(true);
  });
});

describe("live publisher (channel pulse_forge)", () => {
  let storage: Record<string, string>;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "performance",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
    storage = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => {
        storage[k] = v;
      },
      removeItem: (k: string) => {
        delete storage[k];
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function fakeServices(playing: boolean) {
    let playingNow = playing;
    const services = {
      transport: {
        get playing() {
          return playingNow;
        },
        get position() {
          return 480 * 2.25; // 2.25 beats → phase 0.25
        },
      },
      engine: {
        getMasterLevels: () => ({
          left: { rms: 0.1, peak: 0.2, rmsDb: -20, peakDb: -14 },
          right: { rms: 0.1, peak: 0.2, rmsDb: -20, peakDb: -14 },
          correlation: 1,
        }),
        getMasterSpectrogramAnalyser: () => {
          // 2048 bins at −30 dB → every band reads a flat 0.75 unit
          const analyser = {
            frequencyBinCount: 2048,
            context: { sampleRate: 48000 },
            getFloatFrequencyData: (arr: Float32Array) => arr.fill(-30),
          };
          return analyser as unknown as AnalyserNode;
        },
      },
      store: { getDoc: () => ({ bpm: 124, name: "House Beat" }) },
      setPlaying(v: boolean) {
        playingNow = v;
      },
    } as unknown as Services;
    return { services, setPlaying: (v: boolean) => (playingNow = v) };
  }

  it("publishes bounded envelopes under qvester:audio-profile:v1:pulse_forge while playing", async () => {
    const { services } = fakeServices(true);
    const handle = startQvesterProfileBus(services);
    // advance RAF: 33ms gate → ~30 samples/s; 2s window minimum + 3s publish gate
    for (let t = 0; t <= 6_000; t += 33) {
      await vi.advanceTimersByTimeAsync(33);
    }
    const raw = storage["qvester:audio-profile:v1:pulse_forge"];
    expect(raw).toBeDefined();
    const envelope = JSON.parse(raw!);
    expect(envelope.schema).toBe("qvester.audio-profile-bus/v1");
    expect(envelope.channel).toBe(PROFILE_BUS_CHANNEL);
    expect(envelope.publisherApp).toBe(PROFILE_BUS_PUBLISHER_APP);
    expect(envelope.revision).toBeGreaterThanOrEqual(1);
    expect(envelope.profile.bpm).toBe(124);
    expect(envelope.profile.duration).toBeGreaterThanOrEqual(2);
    expect(envelope.profile.energyCurve.length).toBeGreaterThan(0);
    handle.stop();
  });

  it("does not publish while the transport is paused", async () => {
    const { services } = fakeServices(false);
    const handle = startQvesterProfileBus(services);
    for (let t = 0; t <= 6_000; t += 33) {
      await vi.advanceTimersByTimeAsync(33);
    }
    expect(storage["qvester:audio-profile:v1:pulse_forge"]).toBeUndefined();
    handle.stop();
  });

  it("bumps the revision monotonically across publishes", async () => {
    const { services } = fakeServices(true);
    const handle = startQvesterProfileBus(services);
    const revisions: number[] = [];
    for (let t = 0; t <= 12_000; t += 33) {
      await vi.advanceTimersByTimeAsync(33);
      const raw = storage["qvester:audio-profile:v1:pulse_forge"];
      if (raw) {
        const rev = JSON.parse(raw).revision as number;
        if (revisions[revisions.length - 1] !== rev) revisions.push(rev);
      }
    }
    expect(revisions.length).toBeGreaterThanOrEqual(2);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    handle.stop();
  });

  it("stop clears the channel (documented publisher sign-out)", async () => {
    const { services } = fakeServices(true);
    const handle = startQvesterProfileBus(services);
    for (let t = 0; t <= 6_000; t += 33) {
      await vi.advanceTimersByTimeAsync(33);
    }
    expect(storage["qvester:audio-profile:v1:pulse_forge"]).toBeDefined();
    handle.stop();
    expect(storage["qvester:audio-profile:v1:pulse_forge"]).toBeUndefined();
  });
});
