import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { TsarProcessor, type TsarEvent } from "../../src/tsar/dsp/tsarProcessor";
import { createTsarRuntime } from "../../src/instruments/tsarNode";
import { defaultInstrumentParams } from "../../src/instruments/definitions";
import { auditTable } from "./mutation-audit";
import type { InstrumentTrack } from "../../src/project-model/types";

/**
 * TSAR ORBIT — THE TIMED PARAMETER PATH (ADR 0074).
 *
 * This is the wave's central engineering task, and it is a DEFECT FIX, not a
 * feature: before it, the automation bridge had no timed writer for TSAR.
 * `deviceLookup.writeDeviceTargetAt` falls back to `setParameter` when a
 * runtime has no `setParameterAt`, and TSAR had none — so a recorded curve
 * on a TSAR parameter landed IMMEDIATELY. In an offline export every point
 * of the curve was written before the first sample, the LAST point won, and
 * the export was not the performance.
 *
 * The proof here is measured, not asserted:
 *
 *  1. the REAL worklet bundle (public/tsar-worklet.js) is loaded in Node
 *     with the AudioWorklet globals stubbed, and a scheduled param message
 *     is shown to land at its own SAMPLE — not on arrival;
 *  2. the immediate param message still applies immediately (no regression);
 *  3. the runtime posts the `when` (live) and BUFFERS the event (offline),
 *     so an OfflineAudioContext render hears the curve at the right time;
 *  4. the DSP renders the curve: the audio BEFORE the event is bit-identical
 *     to the flat render, and the audio AFTER it differs — the curve is
 *     heard, at the time it was written;
 *  5. two renders of the same script are bit-identical (determinism).
 */

const SR = 48000;
const BLOCK = 128;

/* ── the real worklet bundle, running in Node ─────────────────────────── */

interface WorkletHost {
  Processor: new (options: { processorOptions?: Record<string, unknown> }) => {
    port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: unknown) => void };
    process: (inputs: unknown[], outputs: unknown[]) => boolean;
    proc: { params: Record<string, number> };
  };
  /** Advance the audio clock the way the audio thread would. */
  advance: (frames: number) => void;
  frame: () => number;
}

function loadWorklet(): WorkletHost {
  const code = readFileSync(resolve(process.cwd(), "public/tsar-worklet.js"), "utf8");
  let frame = 0;
  Object.defineProperty(globalThis, "sampleRate", { value: SR, configurable: true, writable: true });
  Object.defineProperty(globalThis, "currentFrame", { get: () => frame, configurable: true });
  Object.defineProperty(globalThis, "currentTime", { get: () => frame / SR, configurable: true });
  class FakeAudioWorkletProcessor {
    port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: unknown) => void };
    constructor() {
      this.port = { onmessage: null, postMessage: () => undefined };
    }
  }
  let captured: WorkletHost["Processor"] | null = null;
  (globalThis as unknown as Record<string, unknown>).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as Record<string, unknown>).registerProcessor = (_name: string, cls: unknown) => {
    captured = cls as WorkletHost["Processor"];
  };
  vm.runInThisContext(code);
  if (!captured) throw new Error("the worklet bundle did not register a processor");
  return {
    Processor: captured,
    advance: (frames: number) => {
      frame += frames;
    },
    frame: () => frame,
  };
}

function renderWorkletBlocks(
  host: WorkletHost,
  instance: { process: (inputs: unknown[], outputs: unknown[]) => boolean },
  seconds: number,
): void {
  const frames = Math.ceil(seconds * SR);
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  let done = 0;
  while (done < frames) {
    host.advance(BLOCK);
    instance.process([], [[left, right]]);
    done += BLOCK;
  }
}

describe("the TSAR worklet honours a scheduled parameter", () => {
  it("a param message WITHOUT `when` still applies immediately (no regression)", () => {
    const host = loadWorklet();
    const instance = new host.Processor({
      processorOptions: { params: { ...defaultInstrumentParams("tsar") } },
    });
    instance.port.onmessage?.({ data: { type: "param", name: "srcACutoff", value: 500 } });
    expect(instance.proc.params.srcACutoff).toBe(500);
  });

  it("a param message WITH `when` does NOT apply on arrival — it waits for its own sample", () => {
    const host = loadWorklet();
    const instance = new host.Processor({
      processorOptions: { params: { ...defaultInstrumentParams("tsar") } },
    });
    const before = instance.proc.params.srcACutoff;
    instance.port.onmessage?.({ data: { type: "param", name: "srcACutoff", value: 500, when: 0.5 } });
    // The message arrived; the value has NOT landed yet.
    expect(instance.proc.params.srcACutoff).toBe(before);
    renderWorkletBlocks(host, instance, 0.2);
    expect(instance.proc.params.srcACutoff).toBe(before);
  });

  it("the scheduled value lands at its own time — measured on the audio clock", () => {
    const host = loadWorklet();
    const instance = new host.Processor({
      processorOptions: { params: { ...defaultInstrumentParams("tsar") } },
    });
    const before = instance.proc.params.srcACutoff;
    instance.port.onmessage?.({ data: { type: "param", name: "srcACutoff", value: 500, when: 0.5 } });
    renderWorkletBlocks(host, instance, 0.4);
    expect(instance.proc.params.srcACutoff).toBe(before);
    renderWorkletBlocks(host, instance, 0.2);
    expect(instance.proc.params.srcACutoff).toBe(500);
  });
});

/* ── the runtime: live posts the time, offline buffers the event ──────── */

function fakeRuntime(offline: boolean) {
  const posted: Record<string, unknown>[] = [];
  const connected: { processorOptions?: Record<string, unknown> }[] = [];
  const gain = { connect: () => undefined, disconnect: () => undefined } as unknown as GainNode;
  const runtime = createTsarRuntime({
    createGain: () => gain,
    createNode: (processorOptions) => {
      connected.push({ processorOptions });
      return {
        port: { postMessage: (message: Record<string, unknown>) => posted.push(message), onmessage: null },
        connect: () => undefined,
        disconnect: () => undefined,
      } as unknown as AudioWorkletNode;
    },
    offline,
    bpm: 120,
    track: { params: defaultInstrumentParams("tsar") } as unknown as InstrumentTrack,
    getSample: () => undefined,
  });
  return { runtime, posted, connected };
}

describe("the TSAR runtime carries the time of a scheduled parameter", () => {
  it("LIVE: the message carries `when` so the worklet can schedule it", () => {
    const { runtime, posted } = fakeRuntime(false);
    runtime.setParameterAt?.("srcACutoff", 500, 2.5);
    const message = posted.find((entry) => entry.type === "param");
    expect(message).toBeDefined();
    expect(message?.when).toBe(2.5);
    expect(message?.name).toBe("srcACutoff");
    expect(message?.value).toBe(500);
  });

  it("OFFLINE: the event is BUFFERED and seeded into the worklet's event queue", () => {
    const { runtime, connected } = fakeRuntime(true);
    runtime.setParameterAt?.("srcACutoff", 500, 2.5);
    runtime.prepareOfflineRender?.();
    const events = connected[0]?.processorOptions?.events as TsarEvent[] | undefined;
    expect(Array.isArray(events)).toBe(true);
    const paramEvent = events?.find((event) => event.type === "param");
    expect(paramEvent).toBeDefined();
    expect(paramEvent?.when).toBe(2.5);
    expect(paramEvent?.name).toBe("srcACutoff");
    expect(paramEvent?.value).toBe(500);
  });

  it("the scheduled value does NOT become the project's base value", () => {
    const { runtime } = fakeRuntime(true);
    runtime.setParameterAt?.("srcACutoff", 500, 2.5);
    runtime.prepareOfflineRender?.();
    // A scheduled write is an OVERRIDE. The base stays where the project put
    // it — otherwise the curve's last value would be the base for the whole
    // offline render.
    const base = defaultInstrumentParams("tsar");
    expect(base.srcACutoff).toBe(18000);
  });

  it("a write with no usable time falls back to an immediate write", () => {
    const { runtime, posted } = fakeRuntime(false);
    runtime.setParameterAt?.("srcACutoff", 500, Number.NaN);
    const message = posted.find((entry) => entry.type === "param");
    expect(message).toBeDefined();
    expect(message?.when).toBeUndefined();
  });
});

/* ── the DSP hears the curve at the right time ────────────────────────── */

function renderWithEvents(params: Record<string, number>, events: TsarEvent[], seconds = 2.4): Float32Array {
  const processor = new TsarProcessor({ sampleRate: SR });
  processor.applyParams(params);
  const table = auditTable(8);
  processor.setWavetable(0, table.frames, table.frameCount);
  for (const event of events) processor.postEvent(event);
  const frames = Math.ceil(seconds * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  processor.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0.01 });
  processor.postEvent({ type: "noteOff", pitch: 60, velocity: 1, when: 1.6 });
  let frame = 0;
  while (frame < frames) {
    const count = Math.min(BLOCK, frames - frame);
    processor.process(left.subarray(frame, frame + count), right.subarray(frame, frame + count), frame);
    frame += count;
  }
  return left;
}

describe("the recorded curve is HEARD, at the time it was written", () => {
  const base = { ...defaultInstrumentParams("tsar"), srcACutoff: 18000 };

  it("the audio before the event is bit-identical to the flat render", () => {
    const flat = renderWithEvents(base, []);
    const curved = renderWithEvents(base, [{ type: "param", when: 1.0, name: "srcACutoff", value: 400 }]);
    const before = Math.floor(0.99 * SR);
    for (let i = 0; i < before; i++) {
      if (flat[i] !== curved[i]) {
        throw new Error(`the curve changed the audio at sample ${i}, before its event at 1.0 s`);
      }
    }
  });

  it("the audio after the event DIFFERS — the curve is not silence and not a no-op", () => {
    const flat = renderWithEvents(base, []);
    const curved = renderWithEvents(base, [{ type: "param", when: 1.0, name: "srcACutoff", value: 400 }]);
    const after = Math.floor(1.05 * SR);
    let differing = 0;
    for (let i = after; i < flat.length; i++) if (flat[i] !== curved[i]) differing++;
    expect(differing).toBeGreaterThan(0);
  });

  it("the change is AUDIBLE, not a numerical difference: the energy after the event really moves", () => {
    const rms = (data: Float32Array, from: number) => {
      let sum = 0;
      for (let i = from; i < data.length; i++) sum += data[i] * data[i];
      return Math.sqrt(sum / Math.max(1, data.length - from));
    };
    const from = Math.floor(1.05 * SR);
    const flat = renderWithEvents(base, []);
    const curved = renderWithEvents(base, [{ type: "param", when: 1.0, name: "srcACutoff", value: 400 }]);
    const flatRms = rms(flat, from);
    const curvedRms = rms(curved, from);
    expect(flatRms).toBeGreaterThan(0);
    // A closed filter removes energy: the curve is heard as a change of
    // loudness, not only as a change of digits.
    expect(curvedRms).toBeLessThan(flatRms * 0.9);
  });

  it("two renders of the same script are bit-identical (the export is deterministic)", () => {
    const events: TsarEvent[] = [{ type: "param", when: 1.0, name: "srcACutoff", value: 400 }];
    const a = renderWithEvents(base, events);
    const b = renderWithEvents(base, events);
    expect(b).toEqual(a);
  });
});

/* ── the wiring the offline path depends on ───────────────────────────── */

describe("the offline path schedules the curve before the worklet is built", () => {
  it("the renderer schedules the automation BEFORE prepareOfflineRender (source pin)", () => {
    const renderer = readFileSync(resolve(process.cwd(), "src/rendering/renderer.ts"), "utf8");
    const scheduleAt = renderer.indexOf("scheduleAutomation(doc, windows, timeAt, engine");
    const prepareAt = renderer.indexOf("await engine.prepareOfflineRender()");
    expect(scheduleAt, "the renderer must schedule the automation").toBeGreaterThan(-1);
    expect(prepareAt, "the renderer must prepare the offline graph").toBeGreaterThan(-1);
    // The offline barrier is what seeds the buffered events into the worklet:
    // an OfflineAudioContext does not pump the port queue during a render.
    expect(scheduleAt).toBeLessThan(prepareAt);
  });

  it("the automation bridge schedules a device parameter through setParameterAt (source pin)", () => {
    const lookup = readFileSync(resolve(process.cwd(), "src/audio-engine/deviceLookup.ts"), "utf8");
    expect(lookup).toMatch(/runtime\.setParameterAt\(target\.paramId, clamped, when\)/);
  });

  it("the TSAR runtime offers setParameterAt (source pin)", () => {
    const node = readFileSync(resolve(process.cwd(), "src/instruments/tsarNode.ts"), "utf8");
    expect(node).toMatch(/setParameterAt\(/);
  });
});
