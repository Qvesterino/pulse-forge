// Source-grep regression for the PDC export barrier (Wave 2).
//
// The offline renderer must call engine.prepareOfflineRender() BEFORE
// OfflineAudioContext.startRendering(). The barrier settles the async
// worklet latency reports (main-thread tasks startRendering does not wait
// for) and switches PDC delay writes from the live glide to exact
// setValueAtTime. A regression here reintroduces two export defects at
// once: the whole file misaligned against look-ahead chains (delay still
// 0 at render start) or the head of the file gliding into alignment over
// ~100 ms of rendered audio.
//
// Guards:
//   1. BARRIER EXISTS  - renderer.ts calls engine.prepareOfflineRender().
//   2. ORDERING        - the call precedes the startRendering() expression.
//   3. AWAITED         - the barrier is awaited (the settle is macrotask-
//                        based; a fire-and-forget call settles nothing).
//   4. ENGINE CONTRACT - AudioEngine exposes prepareOfflineRender and the
//                        syncPdc lock flag pair (exact mode + render lock).
//
// Risk rationale: 0 source changes. Source-grep regression only.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RENDERER = resolve(process.cwd(), "src/rendering/renderer.ts");
const ENGINE = resolve(process.cwd(), "src/audio-engine/AudioEngine.ts");

let rendererLines: string[] = [];
let engineText = "";

beforeAll(() => {
  rendererLines = readFileSync(RENDERER, "utf8").split(/\r?\n/);
  engineText = readFileSync(ENGINE, "utf8");
});

describe("renderer PDC export barrier (source-grep)", () => {
  it("renderer calls engine.prepareOfflineRender()", () => {
    const hits = rendererLines.filter((l) => /engine\.prepareOfflineRender\(\)/.test(l));
    expect(hits.length).toBe(1);
  });

  it("barrier is awaited inside the try and precedes startRendering()", () => {
    const barrierIdx = rendererLines.findIndex((l) => /await\s+engine\.prepareOfflineRender\(\)/.test(l));
    const renderIdx = rendererLines.findIndex((l) => /ctx\.startRendering\(\)/.test(l));
    expect(barrierIdx).toBeGreaterThanOrEqual(0);
    expect(renderIdx).toBeGreaterThan(barrierIdx);
    // Inside the pre-render try: the cancellation window comment sits above.
    const windowIdx = rendererLines.findIndex((l) => /Last cancellation window before the un-abortable render/.test(l));
    expect(barrierIdx).toBeGreaterThan(windowIdx);
  });

  it("AudioEngine implements the barrier contract", () => {
    expect(engineText).toMatch(/async prepareOfflineRender\(\): Promise<void>/);
    expect(engineText).toMatch(/private offlineExactPdc = false/);
    expect(engineText).toMatch(/private offlineRenderLocked = false/);
    // Exact writes FIRST, then the final sizing pass, then the lock — the
    // arm-before-write ordering is the contract (a mid-glide final write
    // would defeat the barrier).
    const prepare = engineText.slice(engineText.indexOf("async prepareOfflineRender"));
    const exactIdx = prepare.indexOf("this.offlineExactPdc = true");
    const syncIdx = prepare.indexOf("this.syncPdc()");
    const lockIdx = prepare.indexOf("this.offlineRenderLocked = true");
    expect(exactIdx).toBeGreaterThanOrEqual(0);
    expect(syncIdx).toBeGreaterThan(exactIdx);
    expect(lockIdx).toBeGreaterThan(syncIdx);
  });

  it("syncPdc honors both flags (exact mode + render lock)", () => {
    const sync = engineText.slice(engineText.indexOf("private syncPdc()"));
    expect(sync.slice(0, 800)).toMatch(/if \(this\.offlineRenderLocked\) return/);
    expect(sync).toMatch(/if \(this\.offlineExactPdc\) delay\?\.delayTime\.setValueAtTime/);
  });
});
