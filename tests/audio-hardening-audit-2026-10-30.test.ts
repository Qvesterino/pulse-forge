import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { BAR_TICKS, PPQ, type ProjectDocument } from "../src/project-model/types";
import { addAudioClip } from "../src/commands/commands";
import { resumeSpanningAudioClips } from "../src/audio-engine/liveEditSync";
import type { AudioEngine } from "../src/audio-engine/AudioEngine";
import { Transport } from "../src/transport/Transport";
import { Scheduler } from "../src/scheduler/Scheduler";
import { PlaybackController } from "../src/services";
import { createVoiceCapture } from "../src/intent/voice-capture";

/**
 * AUDIO HARDENING AUDIT (2026-10-30) — regression locks for the
 * playback-seam and lifecycle defects found by the targeted engine audit:
 *
 *   1. SEEK/PLAY DOUBLE-FIRE: the spanning-clip resume pass ran with its
 *      70 ms forward slack right after scheduler.resync()/start() — the
 *      planner's next window starts AT the playhead, so every clip starting
 *      in the slack fired twice (audible flam on every playing seek).
 *      services.ts now passes forwardSlackSec 0; the doc-change path keeps
 *      the default slack (there the window start sits ~95 ms AHEAD, guarded
 *      by live-edit-sync.test.ts).
 *   2. COLLAB FOLLOW: a remote stop skipped automationReset; a remote play
 *      never resurrected frozen sources / spanning clips; a remote seek
 *      skipped panic + automationReset. The follow path now mirrors the
 *      local gestures through the same controller methods seek/playPause use.
 *   3. RESYNC STALE BOUNDARIES: resync() now cancels boundaries already
 *      armed on the old time map (the mismatch-cancel updateTickBoundaries
 *      runs one tick later was the only protection).
 *   4. SETBPM ANCHOR PAIRING: one clock read for both sides of the pair.
 *   5. VOICE-CAPTURE RESUME: a suspended context never fired
 *      onaudioprocess — capture now resumes best-effort after creation.
 *   6. SIDECHAIN/GATE WORKLETS: the k-rate coefficient hoists must stay
 *      bit-identical — pinned against an inline reference of the old
 *      per-sample math.
 */

function docWithClips(): ProjectDocument {
  const base = normalizeProject({
    ...createProjectFromTemplate("house"),
    arrangement: { clips: [] },
  });
  const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
  // Clip A spans bars 0–8 (strictly spans a mid-clip playhead); clip B starts
  // exactly at bar 4 (inside the old 70 ms resume slack after a seek there).
  const withA = addAudioClip(base, trackId, "bufSpan", 0, 8, {}).execute(base);
  const withB = addAudioClip(withA, trackId, "bufAtSeam", 4, 4, {}).execute(withA);
  return normalizeProject(withB);
}

/** Engine fake that records triggerAudioClip + lifecycle calls. */
function fakeEngine() {
  const triggered: string[] = [];
  const calls: string[] = [];
  const engine = {
    currentTime: 1,
    cancelOrphanedClipSources: () => new Set<string>(),
    transportStarted: () => calls.push("transportStarted"),
    restartFrozenSources: () => calls.push("frozen"),
    panic: () => calls.push("panic"),
    automationReset: () => calls.push("automationReset"),
    triggerAudioClip: (clip: { id: string }) => {
      calls.push("triggerAudioClip");
      triggered.push(clip.id);
    },
  } as unknown as AudioEngine;
  return { engine, triggered, calls };
}

const atBar = (bar: number): number => bar * BAR_TICKS;
const harnessTransport = (doc: ProjectDocument, position: number): Transport =>
  ({ position, secondsPerTick: 60 / (doc.bpm * PPQ) }) as unknown as Transport;

describe("audio hardening audit 2026-10-30 — resume slack", () => {
  it("forwardSlackSec 0 (seek/play path) does NOT resume a clip starting exactly at the playhead — the planner's next window owns it", () => {
    const doc = docWithClips();
    const { engine, triggered } = fakeEngine();
    resumeSpanningAudioClips({
      engine,
      transport: harnessTransport(doc, atBar(4)),
      getDoc: () => doc,
      forwardSlackSec: 0,
    });
    // Clip A (bars 0–8) strictly spans bar 4 → resumed from the playhead.
    // Clip B (starts AT bar 4) must be left to the scheduler window — it
    // fires at its exact boundary time; resuming it here too was the flam.
    expect(triggered).toHaveLength(1);
    expect(triggered[0]).toBe(doc.arrangement.audioClips!.find((c) => c.bufferId === "bufSpan")!.id);
  });

  it("the DEFAULT slack (doc-change path) still resumes a clip starting just past the playhead — the split-seam contract is unchanged", () => {
    const doc = docWithClips();
    const { engine, triggered } = fakeEngine();
    resumeSpanningAudioClips({
      engine,
      transport: harnessTransport(doc, atBar(4)),
      getDoc: () => doc,
    });
    // Both the spanning clip AND the at-seam clip (startTick < pos + slack)
    // are resumed: in the doc-change path the scheduler window sits ~95 ms
    // ahead of the playhead, so nothing here can be double-fired.
    expect(triggered).toHaveLength(2);
  });
});

function makeSchedulerHarness(bpm = 120) {
  const doc = normalizeProject(createProjectFromTemplate("house"));
  let audioTime = 10;
  const transport = new Transport({ now: () => audioTime }, bpm);
  const scheduler = new Scheduler({
    getProject: () => doc,
    getTransport: () => transport,
    getAudioTime: () => audioTime,
    getMode: () => "pattern",
    trigger: () => {},
    noteOn: () => {},
    metronomeClick: () => {},
    applyAutomation: () => {},
    applyPatternLaunch: () => {},
  });
  const tick = () => (scheduler as unknown as { tick: () => void }).tick();
  return { scheduler, transport, tick, at: (t: number) => (audioTime = t) };
}

describe("audio hardening audit 2026-10-30 — scheduler resync vs armed tick boundaries", () => {
  it("cancels a boundary already ARMED on the old time map (listener sees cancelled:true)", () => {
    const h = makeSchedulerHarness();
    h.transport.play(0);
    const seen: Array<{ cancelled?: true }> = [];
    // Tick 50 sits inside the first window's horizon (0.12 s ≈ 115 ticks at
    // 120 bpm) — the first tick arms it and fires the listener once.
    h.scheduler.subscribeTickBoundary(50, (boundary) => seen.push(boundary));
    h.at(10);
    h.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cancelled).toBeUndefined();
    // Seek: the time map is re-anchored, so the armed audio time is stale.
    h.transport.seek(2000);
    h.scheduler.resync();
    expect(seen).toHaveLength(2);
    expect(seen[1]!.cancelled).toBe(true);
  });

  it("leaves an UNARMED future boundary alone — it re-arms on the new time map", () => {
    const h = makeSchedulerHarness();
    h.transport.play(0);
    const seen: Array<{ tick: number; cancelled?: true }> = [];
    // Tick 2100 is beyond the pre-seek horizon (10 + 2100/960 ≈ 12.19 s) —
    // the first tick does not arm it.
    h.scheduler.subscribeTickBoundary(2100, (boundary) => seen.push(boundary));
    h.at(10);
    h.tick();
    expect(seen).toHaveLength(0);
    h.transport.seek(2000);
    h.scheduler.resync();
    expect(seen).toHaveLength(0);
    // The next window after the seek re-arms it against the NEW time map
    // (10.02 + 100/960 ≈ 10.12 s is inside the 0.12 s horizon).
    h.at(10.02);
    h.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cancelled).toBeUndefined();
    h.scheduler.stop();
  });
});

describe("audio hardening audit 2026-10-30 — transport setBpm re-anchor", () => {
  it("re-anchors while playing without moving the playhead: the post-change map continues the pre-change position", () => {
    let t = 10;
    const transport = new Transport({ now: () => t }, 120);
    transport.play(0);
    t = 11;
    const before = transport.position; // exactly 1 s at 120 bpm = 960 ticks
    transport.setBpm(90);
    expect(transport.position).toBeCloseTo(before, 6);
    t = 12; // one more second at the NEW tempo: 720 ticks at 90 bpm
    expect(transport.position).toBeCloseTo(960 + 720, 6);
  });
});

describe("audio hardening audit 2026-10-30 — seek realignment and collab-follow resurrection", () => {
  function makeController() {
    const doc = docWithClips();
    const { engine, triggered, calls } = fakeEngine();
    let audioTime = 10;
    const transport = new Transport({ now: () => audioTime }, doc.bpm);
    const scheduler = new Scheduler({
      getProject: () => doc,
      getTransport: () => transport,
      getAudioTime: () => audioTime,
      getMode: () => "pattern",
      trigger: () => {},
      noteOn: () => {},
      metronomeClick: () => {},
      applyAutomation: () => {},
      applyPatternLaunch: () => {},
    });
    const playback = new PlaybackController(
      engine,
      transport,
      scheduler,
      { mode: "pattern" },
      () => doc,
      () => {},
    );
    return { playback, transport, triggered, calls, at: (t: number) => (audioTime = t) };
  }

  it("seek while playing runs the full realignment: panic, automationReset, transportStarted, frozen restart — in that order", () => {
    const h = makeController();
    h.transport.play(0);
    h.at(11);
    h.playback.seek(atBar(4));
    expect(h.transport.playing).toBe(true);
    const first = h.calls.indexOf("panic");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf("automationReset")).toBeGreaterThan(first);
    expect(h.calls.indexOf("transportStarted")).toBeGreaterThan(h.calls.indexOf("automationReset"));
    expect(h.calls.indexOf("frozen")).toBeGreaterThan(h.calls.indexOf("transportStarted"));
  });

  it("the seek's spanning-clip resume passes NO forward slack: a clip starting at the seek target is not double-fired", () => {
    const h = makeController();
    h.transport.play(0);
    h.at(11);
    h.playback.seek(atBar(4));
    // Only clip A (strictly spanning bar 4) is resumed by the realignment;
    // clip B starting AT bar 4 belongs to the scheduler's next window.
    expect(h.triggered).toHaveLength(1);
  });

  it("resurrectAudioAfterStart (the remote-play follow path) re-arms transportStarted + frozen sources + mid-clip resumes", () => {
    const h = makeController();
    h.transport.play(atBar(2), { leadIn: false });
    h.playback.resurrectAudioAfterStart();
    expect(h.calls).toContain("transportStarted");
    expect(h.calls).toContain("frozen");
    // The spanning clip over bar 2 is resumed with no forward slack.
    expect(h.triggered).toHaveLength(1);
  });
});

describe("audio hardening audit 2026-10-30 — voice capture resume", () => {
  interface FakeCtx {
    state: string;
    resume: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }
  const created: FakeCtx[] = [];

  class FakeAudioContext {
    state: string;
    destination = {};
    sampleRate = 48000;
    resume = vi.fn(() => Promise.resolve());
    close = vi.fn(() => Promise.resolve());
    createMediaStreamSource = () => ({ connect: (n: unknown) => n, disconnect: () => {} });
    createScriptProcessor = () => ({ onaudioprocess: null, connect: (n: unknown) => n, disconnect: () => {} });
    createGain = () => ({ gain: {}, connect: (n: unknown) => n, disconnect: () => {} });
    constructor(state: string) {
      this.state = state;
      created.push(this);
    }
  }

  afterEach(() => {
    created.length = 0;
    vi.unstubAllGlobals();
  });

  async function bootCapture(contextState: string) {
    const StatefulFake = class extends FakeAudioContext {
      constructor() {
        super(contextState);
      }
    };
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
    });
    vi.stubGlobal("AudioContext", StatefulFake);
    const capture = createVoiceCapture();
    const started = await capture.start();
    return { capture, started };
  }

  it("resumes a context the autoplay policy left suspended — otherwise onaudioprocess never fires", async () => {
    const { started } = await bootCapture("suspended");
    expect(started).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]!.state).toBe("suspended");
    expect(created[0]!.resume).toHaveBeenCalledTimes(1);
  });

  it("does not force a resume when the context is already running", async () => {
    const { started } = await bootCapture("running");
    expect(started).toBe(true);
    expect(created[0]!.resume).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Worklet parity: the k-rate hoists in sidechain/gate must be bit-identical
// to the previous per-sample math. The reference below IS the old math.
// ---------------------------------------------------------------------------

const WORKLET_DIR = resolve(__dirname, "../src/audio-worklets");
const SR = 48000;

function loadProcessorClass(file: string): new () => {
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean;
} {
  const source = readFileSync(resolve(WORKLET_DIR, file), "utf8");
  const registered: Array<new () => unknown> = [];
  const host = new Function("registerProcessor", "AudioWorkletProcessor", "globalThis", source);
  host(
    (_name: string, Class: new () => unknown) => registered.push(Class),
    class {
      port = { postMessage: () => {} };
    },
    globalThis,
  );
  if (registered.length === 0) throw new Error(`${file} registered no processor`);
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  return registered[registered.length - 1] as never;
}

/** Deterministic pseudo-random signal with a slow envelope (both gate branches run). */
function seededSignal(seed: number, length: number): Float32Array {
  const out = new Float32Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const noise = (s / 0xffffffff) * 2 - 1;
    const env = 0.5 + 0.5 * Math.sin((2 * Math.PI * i) / 900);
    out[i] = noise * env;
  }
  return out;
}

describe("audio hardening audit 2026-10-30 — sidechain/gate hoist parity", () => {
  it("sidechain: hoisted k-rate coefficients are bit-identical to the previous per-sample math (full-band + split)", () => {
    const Sidechain = loadProcessorClass("sidechain-processor.js");
    const len = 512;
    const main = [seededSignal(1, len), seededSignal(2, len)];
    const side = [seededSignal(3, len)];

    // Reference: the OLD implementation, copied verbatim. The parameters are
    // read from the SAME Float32Arrays the processor gets — a float64 literal
    // (0.01) differs from its float32 storage in the last bits and the
    // envelope drifts, which is exactly what this parity test must not allow.
    const params = {
      threshold: new Float32Array([-18]),
      ratio: new Float32Array([4]),
      attack: new Float32Array([0.01]),
      release: new Float32Array([0.15]),
      amount: new Float32Array([1]),
      splitFreq: new Float32Array([0]),
    };
    const reference = (splitFreqOverride?: number): Float32Array[] => {
      const thresh = params.threshold[0]!;
      const rat = params.ratio[0]!;
      const att = params.attack[0]!;
      const rel = params.release[0]!;
      const amt = params.amount[0]!;
      const splitFreq = splitFreqOverride ?? 0;
      const out = [new Float32Array(len), new Float32Array(len)];
      const SQRT2 = 1.4142135623730951;
      const lp = [
        { x1: 0, x2: 0, y1: 0, y2: 0 },
        { x1: 0, x2: 0, y1: 0, y2: 0 },
      ];
      let lpB0 = 0,
        lpB1 = 0,
        lpB2 = 0,
        lpA1 = 0,
        lpA2 = 0;
      const splitActive = splitFreq > 10;
      if (splitActive) {
        const K = Math.tan((Math.PI * splitFreq) / SR);
        const K2 = K * K;
        const a0 = 1 + SQRT2 * K + K2;
        lpB0 = K2 / a0;
        lpB1 = (2 * K2) / a0;
        lpB2 = K2 / a0;
        lpA1 = (2 * (K2 - 1)) / a0;
        lpA2 = (1 - SQRT2 * K + K2) / a0;
      }
      const lpFilter = (x: number, st: { x1: number; x2: number; y1: number; y2: number }): number => {
        const y = lpB0 * x + lpB1 * st.x1 + lpB2 * st.x2 - lpA1 * st.y1 - lpA2 * st.y2;
        st.x2 = st.x1;
        st.x1 = x;
        st.y2 = st.y1;
        st.y1 = y;
        if (Math.abs(st.x1) < 1e-20) st.x1 = 0;
        if (Math.abs(st.x2) < 1e-20) st.x2 = 0;
        if (Math.abs(st.y1) < 1e-20) st.y1 = 0;
        if (Math.abs(st.y2) < 1e-20) st.y2 = 0;
        if (Math.abs(y) < 1e-20) return 0;
        return y;
      };
      let env = 0;
      for (let i = 0; i < len; i++) {
        const sidePeak = Math.abs(side[0]![i]!);
        const attCoef = Math.exp(-1 / (SR * Math.max(0.0002, att)));
        const relCoef = Math.exp(-1 / (SR * Math.max(0.001, rel)));
        env = sidePeak > env ? attCoef * env + (1 - attCoef) * sidePeak : relCoef * env + (1 - relCoef) * sidePeak;
        if (Math.abs(env) < 1e-20) env = 0;
        const envDb = 20 * Math.log10(Math.max(env, 1e-7));
        const threshDb = 20 * Math.log10(Math.max(Math.pow(10, thresh / 20), 1e-7));
        const overDb = Math.max(0, envDb - threshDb);
        const reductionDb = overDb * (1 - 1 / Math.max(1, rat));
        const reduction = Math.pow(10, -reductionDb / 20);
        const gain = Math.max(0, 1 - amt * (1 - reduction));
        for (let ch = 0; ch < 2; ch++) {
          const x = main[ch]![i]!;
          if (splitActive) {
            const low = lpFilter(x, lp[ch]!);
            out[ch]![i] = low * gain + (x - low);
          } else {
            out[ch]![i] = x * gain;
          }
        }
      }
      return out;
    };

    for (const splitFreq of [0, 120]) {
      const instance = new Sidechain();
      const channels = [new Float32Array(len), new Float32Array(len)];
      // outputs is an array of OUTPUTS, each an array of CHANNELS.
      instance.process([main, side], [channels], {
        ...params,
        splitFreq: new Float32Array([splitFreq]),
      });
      const ref = reference(splitFreq);
      for (let ch = 0; ch < 2; ch++) {
        for (let i = 0; i < len; i++) {
          expect(channels[ch]![i]).toBe(ref[ch]![i]!);
        }
      }
    }
  });

  it("gate: hoisted envelope coefficients are bit-identical to the previous per-sample math", () => {
    const Gate = loadProcessorClass("gate-processor.js");
    const len = 512;
    const input = [seededSignal(7, len), seededSignal(8, len)];

    // Reference: the OLD implementation, copied verbatim. Parameters are read
    // from the SAME Float32Arrays the processor gets (float32 storage vs
    // float64 literals — see the sidechain note above).
    const gateParams = {
      threshold: new Float32Array([-30]),
      hysteresis: new Float32Array([0.3]),
      lookahead: new Float32Array([0]),
      attack: new Float32Array([0.002]),
      hold: new Float32Array([0.05]),
      release: new Float32Array([0.08]),
      range: new Float32Array([-48]),
      mix: new Float32Array([1]),
    };
    const reference = (): Float32Array[] => {
      const threshold = gateParams.threshold[0]!;
      const hysteresis = gateParams.hysteresis[0]!;
      const lookahead = gateParams.lookahead[0]!;
      const attack = gateParams.attack[0]!;
      const hold = gateParams.hold[0]!;
      const release = gateParams.release[0]!;
      const range = gateParams.range[0]!;
      const mix = gateParams.mix[0]!;
      const out = [new Float32Array(len), new Float32Array(len)];
      let envelope = 0;
      let wasOpen = false;
      let holdSamples = 0;
      let gain = 0;
      const lookaheadSamples = Math.round(SR * 0.0025);
      const audioRing = new Float32Array(lookaheadSamples * 2);
      const gainRing = new Float32Array(lookaheadSamples);
      let audioRingIdx = 0;
      for (let i = 0; i < len; i++) {
        let peak = 0;
        for (let ch = 0; ch < 2; ch++) peak = Math.max(peak, Math.abs(input[ch]![i]!));
        const envCoef = Math.exp(-1 / (SR * (peak > envelope ? Math.max(0.0001, attack) : Math.max(0.001, release))));
        envelope = envCoef * envelope + (1 - envCoef) * peak;
        if (Math.abs(envelope) < 1e-20) envelope = 0;
        const envDb = 20 * Math.log10(Math.max(envelope, 1e-7));
        const closeDb = threshold - Math.max(0, Math.min(1, hysteresis)) * 12;
        if (envDb >= threshold) {
          wasOpen = true;
          holdSamples = Math.max(holdSamples, Math.round(hold * SR));
        } else if (envDb < closeDb) {
          wasOpen = false;
          holdSamples = Math.max(0, holdSamples - 1);
        }
        const target = holdSamples > 0 || wasOpen ? 1 : Math.pow(10, range / 20);
        if (lookahead >= 0.5 && target > gain) {
          gain = target;
        } else {
          const step =
            target > gain
              ? 1 / Math.max(1, SR * Math.max(0.0001, attack))
              : 1 / Math.max(1, SR * Math.max(0.001, release));
          gain += (target - gain) * Math.min(1, step);
        }
        if (Math.abs(gain) < 1e-20) gain = 0;
        for (let ch = 0; ch < 2; ch++) {
          const ringIdx = ch * lookaheadSamples + audioRingIdx;
          const delayed = audioRing[ringIdx]!;
          const raw = input[ch]![i]!;
          audioRing[ringIdx] = raw;
          const delayedGain = gainRing[audioRingIdx]!;
          out[ch]![i] = delayed * (1 + ((lookahead >= 0.5 ? gain : delayedGain) - 1) * mix);
        }
        gainRing[audioRingIdx] = gain;
        audioRingIdx = (audioRingIdx + 1) % lookaheadSamples;
      }
      return out;
    };

    const instance = new Gate();
    const channels = [new Float32Array(len), new Float32Array(len)];
    instance.process([input], [channels], gateParams);
    const ref = reference();
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < len; i++) {
        expect(channels[ch]![i]).toBe(ref[ch]![i]!);
      }
    }
  });
});
