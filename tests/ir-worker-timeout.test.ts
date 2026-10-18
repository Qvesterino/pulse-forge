import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EFFECT_DEFS } from "../src/effects/registry";
import type { EffectInstance } from "../src/project-model/types";

/**
 * IR WORKER TIMEOUT GATE (browser lifecycle audit 2026-10-18, follow-up)
 *
 * The fallback convolver's IR worker is fire-and-forget: a worker that dies
 * WITHOUT firing `error` (killed under memory pressure, module torn down after
 * a long idle) left `convolver.buffer` unset forever — the reverb rendered DRY
 * with nothing to observe. The factory now bounds the wait and swaps in the
 * deterministic sync impulse, and re-arms the bound for every decay request
 * (a worker that answered once can die before the next reply).
 *
 * The test drives the REAL factory through `EFFECT_DEFS.reverb` with a fake
 * context (the worklet is not ready, so the fallback path is selected) and
 * captures the convolver it creates.
 */

type Param = {
  value: number;
  setTargetAtTime: (value: number, when: number, constant: number) => void;
  setValueAtTime: (value: number, when: number) => void;
};

function param(initial = 0): Param {
  let value = initial;
  return {
    get value() {
      return value;
    },
    set value(next: number) {
      value = next;
    },
    setTargetAtTime(next: number) {
      value = next;
    },
    setValueAtTime(next: number) {
      value = next;
    },
  };
}

interface FakeNode {
  connect: (destination?: FakeNode) => FakeNode;
  disconnect: () => void;
  gain: Param;
  frequency: Param;
  delayTime: Param;
  type: string;
  buffer: unknown;
}

function fakeNode(): FakeNode {
  const node: FakeNode = {
    gain: param(1),
    frequency: param(1000),
    delayTime: param(0),
    type: "lowpass",
    buffer: null,
    connect(destination?: FakeNode) {
      return destination ?? node;
    },
    disconnect() {},
  };
  return node;
}

function fakeContext() {
  const convolvers: FakeNode[] = [];
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    createGain: fakeNode,
    createDelay: fakeNode,
    createBiquadFilter: fakeNode,
    createConvolver: () => {
      const node = fakeNode();
      convolvers.push(node);
      return node;
    },
    createBuffer: (channels: number, length: number, rate: number) => ({
      length,
      sampleRate: rate,
      numberOfChannels: channels,
      getChannelData: () => new Float32Array(length),
      copyToChannel() {},
    }),
  };
  return { ctx, convolvers };
}

interface FakeWorkerInstance {
  postMessage: (message: unknown) => void;
  terminate: () => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  terminated: number;
  posted: unknown[];
}

class FakeWorker implements FakeWorkerInstance {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = 0;
  posted: unknown[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated += 1;
  }
}

const INSTANCE: EffectInstance = {
  id: "audit-reverb",
  type: "reverb",
  bypassed: false,
  params: { decay: 1.2, mix: 0.4 },
};

const TIMEOUT_MS = 5_000;

function build() {
  const { ctx, convolvers } = fakeContext();
  const runtime = EFFECT_DEFS.reverb.factory(ctx as unknown as BaseAudioContext, INSTANCE, { bpm: 120 });
  const worker = FakeWorker.instances[0]!;
  const convolver = convolvers[0]!;
  return { runtime, worker, convolver };
}

beforeEach(() => {
  FakeWorker.instances = [];
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { Worker?: unknown }).Worker;
});

describe("fallback reverb IR worker timeout", () => {
  it("a silent worker gets the deterministic sync impulse after the bound", () => {
    const { runtime, worker, convolver } = build();
    expect(runtime.degraded).toBe(true);
    expect(convolver.buffer, "no impulse should exist before the worker replies").toBeNull();

    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    expect(convolver.buffer, "a hung IR worker must not leave the reverb dry forever").not.toBeNull();
    expect(worker.terminated, "the hung worker must be terminated").toBe(1);
  });

  it("a reply lands immediately and the bound is cleared (no late overwrite)", () => {
    const { runtime, worker, convolver } = build();
    const left = new Float32Array(64).fill(0.25);
    const right = new Float32Array(64).fill(-0.25);
    worker.onmessage?.({ data: { left, right, length: 64 } });
    expect((convolver.buffer as { length?: number }).length).toBe(64);

    vi.advanceTimersByTime(TIMEOUT_MS * 4);
    expect((convolver.buffer as { length?: number }).length, "a cleared timer must not overwrite the reply").toBe(64);
    expect(worker.terminated).toBe(0);

    runtime.dispose();
    expect(worker.terminated).toBe(1);
  });

  it("dispose clears the bound: no impulse is written after teardown", () => {
    const { runtime, worker, convolver } = build();
    runtime.dispose();
    expect(worker.terminated).toBe(1);

    vi.advanceTimersByTime(TIMEOUT_MS * 4);
    expect(convolver.buffer, "a disposed effect must not be revived by a stale timer").toBeNull();
    expect(worker.terminated).toBe(1);
  });
});
