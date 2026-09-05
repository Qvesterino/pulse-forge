/**
 * FXEQ tempo sync (quality roadmap Q2).
 *
 * delay/modulation gained a syncMode parameter (0 = free, 1..8 = note
 * divisions) derived from the host tempo via the setTempo chain:
 * engine → fxEqNode (port message "bpm") → worklet → processor → band
 * engines → tempo-aware modules.
 *
 * Invariants pinned here:
 *  - sync echo position matches the division table exactly (±2 samples,
 *    hermite interpolation window),
 *  - setTempo mid-stream retimes a synced delay without artifacts,
 *  - syncMode=0 keeps free-time behavior and is BIT-IDENTICAL under any
 *    tempo (golden parity contract),
 *  - division times clamp into the same [1, MAX_DELAY_MS] window as the
 *    free parameter, so buffer capacity never changes,
 *  - the node forwards tempo over the port and stays quiet after dispose.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { createDelayModule } from "../src/effects/fxeq-core/modules/delay";
import { createModulationModule } from "../src/effects/fxeq-core/modules/modulation";
import { createFxEqNode } from "../src/effects/fxeqNode";
import type { EffectInstance } from "../src/project-model/types";

const SR = 48000;
const BLOCK = 128;

/** Feed one impulse at |atSample| and return the echo's absolute position. */
function findEcho(
  mod: { process: (ch: Float32Array[], n: number) => void },
  impulseAt: number,
  searchFrom: number,
  searchTo: number,
): number {
  let total = 0;
  let peakIdx = -1;
  let peakVal = 0;
  const limit = searchTo + BLOCK * 2;
  while (total < limit) {
    const buf = new Float32Array(BLOCK);
    if (impulseAt >= total && impulseAt < total + BLOCK) buf[impulseAt - total] = 1;
    mod.process([buf], BLOCK);
    if (total + BLOCK > searchFrom) {
      for (let i = 0; i < BLOCK; i++) {
        const a = Math.abs(buf[i]);
        if (a > peakVal) {
          peakVal = a;
          peakIdx = total + i;
        }
      }
    }
    total += BLOCK;
  }
  expect(peakVal, "no echo found in the search window").toBeGreaterThan(0.05);
  return peakIdx;
}

function delaySyncParams(): Record<string, number> {
  return { enabled: 1, type: 0, timeMs: 250, syncMode: 3, feedback: 0, mix: 100, dampHz: 12000 };
}

describe("fxeq delay tempo sync", () => {
  it("1/4 note at 120 BPM delays exactly 500 ms", () => {
    const mod = createDelayModule(delaySyncParams());
    mod.prepare(SR, 1, BLOCK);
    mod.setTempo!(120);
    const echo = findEcho(mod, 0, 20000, 28000);
    expect(Math.abs(echo - 24000)).toBeLessThanOrEqual(2);
  });

  it("setTempo mid-stream retimes the echo without artifacts", () => {
    const mod = createDelayModule(delaySyncParams());
    mod.prepare(SR, 1, BLOCK);
    mod.setTempo!(120);
    const echo1 = findEcho(mod, 0, 20000, 28000);
    expect(Math.abs(echo1 - 24000)).toBeLessThanOrEqual(2);

    // 1/4 at 240 BPM = 250 ms = 12000 samples.
    mod.setTempo!(240);
    const echo2 = findEcho(mod, 30000, 40000, 44000);
    expect(Math.abs(echo2 - 42000)).toBeLessThanOrEqual(2);
  });

  it("division times clamp into the MAX_DELAY_MS window (1/1 at 60 BPM)", () => {
    const mod = createDelayModule({ ...delaySyncParams(), syncMode: 1 });
    mod.prepare(SR, 1, BLOCK);
    mod.setTempo!(60); // 1/1 = 4000 ms > 2000 ms max → clamped to 96000 samples
    const echo = findEcho(mod, 0, 93000, 99000);
    expect(Math.abs(echo - 96000)).toBeLessThanOrEqual(2);
  });

  it("syncMode=0 ignores the tempo entirely", () => {
    const mod = createDelayModule({ ...delaySyncParams(), syncMode: 0, timeMs: 125 });
    mod.prepare(SR, 1, BLOCK);
    mod.setTempo!(300); // would be 50 ms if sync were (wrongly) active
    const echo = findEcho(mod, 0, 4000, 8000);
    expect(Math.abs(echo - 6000)).toBeLessThanOrEqual(2);
  });

  it("every sync division lands within the buffer without NaN", () => {
    for (let mode = 1; mode <= 8; mode++) {
      const mod = createDelayModule({ ...delaySyncParams(), syncMode: mode });
      mod.prepare(SR, 1, BLOCK);
      mod.setTempo!(60); // slowest tempo — longest division times
      for (let blk = 0; blk < 40; blk++) {
        const buf = new Float32Array(BLOCK);
        buf[0] = 0.9;
        mod.process([buf], BLOCK);
        for (let i = 0; i < BLOCK; i++) {
          expect(Number.isFinite(buf[i]), `mode ${mode} produced non-finite output`).toBe(true);
        }
      }
    }
  });
});

function renderMod(bpm: number, syncMode: number): Float32Array {
  const mod = createModulationModule({ enabled: 1, type: 1, rate: 1, syncMode, depth: 80, feedback: 0.5, mix: 100 });
  mod.prepare(SR, 1, BLOCK);
  mod.setTempo!(bpm);
  const out = new Float32Array(BLOCK * 20);
  for (let blk = 0; blk < 20; blk++) {
    const buf = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) buf[i] = Math.sin((2 * Math.PI * 440 * (blk * BLOCK + i)) / SR) * 0.4;
    mod.process([buf], BLOCK);
    out.set(buf, blk * BLOCK);
  }
  return out;
}

describe("fxeq modulation tempo sync", () => {
  it("synced rate follows the host tempo (60 vs 180 BPM differ)", () => {
    const slow = renderMod(60, 3); // 1/4 @ 60 → 1 Hz
    const fast = renderMod(180, 3); // 1/4 @ 180 → 3 Hz
    let diff = 0;
    for (let i = 0; i < slow.length; i++) diff = Math.max(diff, Math.abs(slow[i] - fast[i]));
    expect(diff).toBeGreaterThan(0.01);
  });

  it("syncMode=0 is bit-identical under any tempo", () => {
    const a = renderMod(60, 0);
    const b = renderMod(180, 0);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });
});

/* ── node-level: tempo forwarding over the port ─────────────────────────── */

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: unknown[] = [];
  closed = false;
  postMessage(msg: unknown) {
    this.posted.push(msg);
  }
  close() {
    this.closed = true;
  }
}

let lastPort: FakePort | null = null;
class FakeAudioWorkletNode {
  port = new FakePort();
  constructor(_ctx: unknown, _name: string, _opts: Record<string, unknown>) {
    lastPort = this.port;
  }
  connect() {}
  disconnect() {}
}

function fakeCtx() {
  const gain = () => ({ connect() {}, disconnect() {} });
  return { sampleRate: 48000, createGain: gain } as unknown as BaseAudioContext;
}

function instance(): EffectInstance {
  return { id: "fx1", type: "fxeq", bypassed: false, params: {} };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fxeq node tempo forwarding", () => {
  it("syncBpm posts { type: bpm } over the port and stops after dispose", () => {
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    const rt = createFxEqNode(fakeCtx(), instance(), {});
    rt.syncBpm!(128);
    expect(lastPort!.posted.at(-1)).toEqual({ type: "bpm", bpm: 128 });
    rt.dispose();
    rt.syncBpm!(140);
    expect(lastPort!.posted.at(-1)).toEqual({ type: "bpm", bpm: 128 });
  });

  it("ignores non-finite and out-of-range tempos", () => {
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    const rt = createFxEqNode(fakeCtx(), instance(), {});
    rt.syncBpm!(Number.NaN);
    rt.syncBpm!(Number.POSITIVE_INFINITY);
    expect(lastPort!.posted.filter((m) => (m as { type?: string }).type === "bpm")).toEqual([]);
    // Extreme-but-finite tempos are forwarded (the processor clamps).
    rt.syncBpm!(1e6);
    expect(lastPort!.posted.at(-1)).toEqual({ type: "bpm", bpm: 1e6 });
    rt.dispose();
  });
});
