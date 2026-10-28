import { describe, expect, it, vi } from "vitest";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import {
  analyzeBufferMetrics,
  formatRenderSummary,
  mcpRenderSummary,
  type RenderSummaryData,
} from "../src/mcp/render-summary";
import { addArrangementClip } from "../src/commands/commands";
import { arrangementSecondsBetweenTicks } from "../src/project-model/scene-time";
import { ticksPerBar } from "../src/project-model/schema";
import { testDoc } from "./fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * E1 (MUG-01) — full-mix RANGE measurement on kyx_render_summary.
 *
 * "Is the drop louder than the chorus?" needs the master (and strips)
 * measured INSIDE a tick window. The contract under test: the timeline is
 * rendered from 0 through the window end and only the MEASUREMENT is sliced
 * — tails and notes started before the window stay in the numbers (the same
 * rule the track-window path pins). Bars are 1-based inclusive sugar over
 * ticks; ticks and bars must never be mixed; pattern-mode docs refuse
 * honestly.
 *
 * WHAT THIS FILE DOES NOT VERIFY, stated plainly: a real offline render. No
 * vitest spec renders audio (renderProject needs a real OfflineAudioContext;
 * audible parity belongs to the real-browser gate). The renderProject mock
 * returns buffers with KNOWN per-segment amplitudes, so these specs pin the
 * slicing math, the bars→ticks translation, the coverage guard and the
 * full-window parity contract against known answers instead.
 */

const SR = 44100;

const mocks = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("../src/rendering/renderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rendering/renderer")>();
  return { ...actual, renderProject: mocks.render };
});

function docWithClips(): ProjectDocument {
  const base = testDoc();
  const sceneId = base.scenes[0]!.id;
  return addArrangementClip(base, sceneId, 0, 8).execute(base);
}

function secAt(doc: ProjectDocument, tick: number): number {
  return arrangementSecondsBetweenTicks(doc.arrangement.clips, doc.scenes, 0, tick, doc.bpm, ticksPerBar(doc));
}

function makeStereoBuffer(lengthSamples: number, segments: Array<{ fromSec: number; toSec: number; level: number }>) {
  const left = new Float32Array(lengthSamples);
  const right = new Float32Array(lengthSamples);
  for (const segment of segments) {
    const from = Math.round(segment.fromSec * SR);
    const to = Math.min(lengthSamples, Math.round(segment.toSec * SR));
    for (let i = from; i < to; i += 1) {
      left[i] = segment.level;
      right[i] = segment.level;
    }
  }
  return {
    length: lengthSamples,
    sampleRate: SR,
    numberOfChannels: 2,
    getChannelData: (channel: number) => (channel === 0 ? left : right),
  };
}

function makeCtx(currentDoc: ProjectDocument, hook?: McpToolContext["renderSummary"]): McpToolContext {
  return {
    getDoc: () => currentDoc,
    execute: () => undefined,
    undo: () => undefined,
    redo: () => undefined,
    undoStackLength: () => 0,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
    ...(hook ? { renderSummary: hook } : {}),
  } as never;
}

function makeServices(doc: ProjectDocument) {
  return {
    store: { getDoc: () => doc, getRevision: () => 7 },
    bank: { add: vi.fn(), remove: vi.fn(), get: vi.fn() },
  } as never;
}

describe("full-mix range measurement (E1)", () => {
  it("measures ONLY the window: a loud pre-roll must not leak into the range numbers", async () => {
    const doc = docWithClips();
    const barUnit = ticksPerBar(doc);
    const startTick = barUnit;
    const endTick = 3 * barUnit; // bars 2..3 (1-based, inclusive both ends)
    const startSec = secAt(doc, startTick);
    const endSec = secAt(doc, endTick);
    mocks.render.mockResolvedValue(
      makeStereoBuffer(Math.ceil(endSec * SR), [
        { fromSec: 0, toSec: startSec, level: 0.5 },
        { fromSec: startSec, toSec: endSec, level: 0.05 },
      ]),
    );

    const data = await mcpRenderSummary(makeServices(doc), { scope: "master", startTick, endTick });

    expect(data.scope).toBe("range");
    expect(data.range?.window).toEqual({ startTick, endTick });
    expect(data.range?.timing.startSec).toBeCloseTo(startSec, 6);
    expect(data.range?.timing.durationSec).toBeCloseTo(endSec - startSec, 6);
    expect(data.range?.freshness).toBe("current");
    expect(data.range?.signalStage.id).toBe("song-range");
    // The window holds 0.05 (−26 dBFS peak). Measuring the whole buffer
    // would report the 0.5 pre-roll (−6 dBFS) — the exact chorus-vs-verse
    // confusion this mode exists to kill.
    expect(data.master?.peakDb).toBeCloseTo(-26.02, 0);
    expect(data.master?.lufs).not.toBeNull();
    expect(mocks.render).toHaveBeenCalledTimes(1);
  });

  it("slices the strips with the same window (scope all)", async () => {
    const doc = docWithClips();
    const barUnit = ticksPerBar(doc);
    const startTick = barUnit;
    const endTick = 3 * barUnit;
    const startSec = secAt(doc, startTick);
    const endSec = secAt(doc, endTick);
    mocks.render.mockResolvedValue(
      makeStereoBuffer(Math.ceil(endSec * SR), [
        { fromSec: 0, toSec: startSec, level: 0.5 },
        { fromSec: startSec, toSec: endSec, level: 0.05 },
      ]),
    );

    const data = await mcpRenderSummary(makeServices(doc), { scope: "all", startTick, endTick });
    expect(data.strips.length).toBeGreaterThan(0);
    for (const strip of data.strips) expect(strip.peakDb).toBeCloseTo(-26.02, 0);
  });

  it("a full-window range equals the whole-buffer measurement (parity contract)", async () => {
    const doc = docWithClips();
    const barUnit = ticksPerBar(doc);
    const endTick = 8 * barUnit;
    const endSec = secAt(doc, endTick);
    const buffer = makeStereoBuffer(Math.ceil(endSec * SR), [{ fromSec: 0, toSec: endSec, level: 0.4 }]);
    mocks.render.mockResolvedValue(buffer);

    const data = await mcpRenderSummary(makeServices(doc), { scope: "master", startTick: 0, endTick });
    const whole = analyzeBufferMetrics(buffer);
    expect(data.master?.peakDb).toBe(whole.peakDb);
    expect(data.master?.lufs).toBe(whole.lufs);
    expect(data.master?.crestDb).toBe(whole.crestDb);
  });

  it("refuses honestly on a pattern-mode project (no arrangement to slice)", async () => {
    const plain = testDoc();
    await expect(
      mcpRenderSummary(makeServices(plain), { scope: "master", startTick: 0, endTick: 1920 }),
    ).rejects.toThrow(/arrangement clips/);
  });

  it("dispatch translates 1-based inclusive bars to ticks and reports the range", async () => {
    const doc = docWithClips();
    const barUnit = ticksPerBar(doc);
    const hook = vi.fn(async () => ({ scope: "range", strips: [], master: null, referenceLufs: -14 }) as never);
    const result = await executeMcpTool(makeCtx(doc, hook), "kyx_render_summary", { fromBar: 2, toBar: 3 });
    expect(hook).toHaveBeenCalledWith({ scope: "all", startTick: barUnit, endTick: 3 * barUnit }, expect.anything());
    expect(result.isError).not.toBe(true);
  });

  it("refuses mixed window forms and the bar sugar on track analysis", async () => {
    const doc = docWithClips();
    const hook = vi.fn(async () => ({ scope: "all", strips: [], master: null, referenceLufs: -14 }) as never);

    const mixed = await executeMcpTool(makeCtx(doc, hook), "kyx_render_summary", {
      fromBar: 2,
      startTick: 0,
      endTick: 10,
    });
    expect(mixed.isError).toBe(true);
    expect(mixed.errorCode).toBe("INVALID_ARGUMENTS");

    const trackWithBars = await executeMcpTool(makeCtx(doc, hook), "kyx_render_summary", {
      trackId: "t1",
      fromBar: 2,
      toBar: 3,
    });
    expect(trackWithBars.isError).toBe(true);
    expect(trackWithBars.errorCode).toBe("INVALID_ARGUMENTS");
    expect(hook).not.toHaveBeenCalled();
  });

  it("formatRenderSummary renders the range header with timing and freshness", () => {
    const text = formatRenderSummary({
      scope: "range",
      strips: [{ id: "t1", name: "Drums", kind: "drum", lufs: -9.5, peakDb: -3, crestDb: 8, durationSec: 4 }],
      master: { lufs: -12.2, peakDb: -1, crestDb: 7.5, durationSec: 4 },
      referenceLufs: -14,
      range: {
        window: { startTick: 1920, endTick: 5760 },
        timing: { startSec: 2, endSec: 6, durationSec: 4, startSample: 88200, endSample: 264600, sampleRate: SR },
        projectRevision: 7,
        revisionAfterRender: 7,
        freshness: "current",
        signalStage: {
          id: "song-range",
          includes: "the full mix through the master chain, timeline rendered from 0",
          excludes: "nothing — audio before the window is rendered, only the measurement is sliced",
        },
        caveats: [{ code: "freshness-unknown", detail: "test caveat" }],
      },
    });
    expect(text).toContain("range: ticks 1920..5760");
    expect(text).toContain("4.000 s");
    expect(text).toContain("song-range");
    expect(text).toContain("7 → 7 (current)");
    expect(text).toContain("caveat: freshness-unknown");
    expect(text).toContain("MASTER");
  });
});
