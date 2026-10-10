import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KopaProcessor, type KopaEvent } from "../../src/kopa/dsp/kopaProcessor";
import { kopaParams } from "../../src/instruments/definitions";

/**
 * KOPA offline parity (KOPA plan §3.5).
 *
 * The real OfflineAudioContext parity run lives in the browser gate
 * (`npm run test:browser` — the instrument parity corpus null-tests every
 * registry member). This suite is the part that can run on EVERY commit:
 *
 *  1. TWO full processor renders of the same event script are sample-identical
 *     (the shared live/offline interpreter has no hidden state),
 *  2. the queue seeded at construction and the queue filled live apply at the
 *     exact same sample boundaries (bit-identity, not "close enough"),
 *  3. the renderer barrier contract: `renderProject` prepares the offline
 *     graph BEFORE `startRendering()`, and the KOPA runtime seeds its events
 *     through `processorOptions` in that same barrier (source pins).
 */

const SR = 48000;
const BLOCK = 128;

function defaultParams(overrides: Record<string, number> = {}): Record<string, number> {
  return { ...Object.fromEntries(kopaParams.map((param) => [param.id, param.default])), ...overrides };
}

const SCRIPT: KopaEvent[] = [
  { type: "noteOn", pitch: 36, velocity: 1, when: 0.0 },
  { type: "noteOn", pitch: 43, velocity: 0.7, when: 0.5 },
  { type: "noteOff", pitch: 36, when: 0.6 },
  { type: "param", when: 0.7, name: "drive", value: 0.9 },
  { type: "noteOn", pitch: 38, velocity: 1, when: 1.0 },
  { type: "noteOff", pitch: 43, when: 1.1 },
  { type: "panic", when: 1.4 },
];

function renderFull(events: KopaEvent[], seed: boolean): { left: Float32Array; right: Float32Array } {
  const processor = seed ? new KopaProcessor({ sampleRate: SR, events }) : new KopaProcessor({ sampleRate: SR });
  processor.applyParams(defaultParams());
  const frames = Math.ceil(1.6 * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  if (!seed) for (const event of events) processor.postEvent(event);
  let frame = 0;
  while (frame < frames) {
    const count = Math.min(BLOCK, frames - frame);
    processor.process(left.subarray(frame, frame + count), right.subarray(frame, frame + count), frame);
    frame += count;
  }
  return { left, right };
}

describe("KOPA offline parity", () => {
  it("two renders of the same script are bit-identical (deterministic engine)", () => {
    const a = renderFull(SCRIPT, false);
    const b = renderFull(SCRIPT, false);
    expect(b.left).toEqual(a.left);
    expect(b.right).toEqual(a.right);
  });

  it("constructor-seeded events and live-posted events render bit-identically", () => {
    const live = renderFull(SCRIPT, false);
    const seeded = renderFull(SCRIPT, true);
    expect(seeded.left).toEqual(live.left);
    expect(seeded.right).toEqual(live.right);
  });

  it("a different event script produces different audio (the identity is not vacuous)", () => {
    const a = renderFull(SCRIPT, true);
    const shifted = renderFull(
      SCRIPT.map((event) => ({ ...event, when: event.when + 0.013 })),
      true,
    );
    let differing = 0;
    for (let i = 0; i < a.left.length; i++) if (a.left[i] !== shifted.left[i]) differing++;
    expect(differing).toBeGreaterThan(0);
  });

  it("renderer barrier: prepareOfflineRender runs before startRendering (source pin)", () => {
    const renderer = readFileSync(resolve(process.cwd(), "src/rendering/renderer.ts"), "utf8");
    const prepareAt = renderer.indexOf("await engine.prepareOfflineRender()");
    const startAt = renderer.indexOf("startRendering()");
    expect(prepareAt, "renderer must call engine.prepareOfflineRender()").toBeGreaterThan(-1);
    expect(startAt, "renderer must call startRendering()").toBeGreaterThan(-1);
    expect(prepareAt).toBeLessThan(startAt);
  });

  it("KOPA runtime seeds processorOptions events in the offline barrier (source pin)", () => {
    const node = readFileSync(resolve(process.cwd(), "src/instruments/kopaNode.ts"), "utf8");
    expect(node).toMatch(/prepareOfflineRender/);
    expect(node).toMatch(/events: pendingEvents\.slice\(\)/);
    // The registry only takes the worklet path when the module is ready.
    const registry = readFileSync(resolve(process.cwd(), "src/instruments/registry.ts"), "utf8");
    expect(registry).toMatch(/isWorkletReady\("kopa", ctx\)/);
    expect(registry).toMatch(/createKopaRuntime\(\{/);
  });
});
