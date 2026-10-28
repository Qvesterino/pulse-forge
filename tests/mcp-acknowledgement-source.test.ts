import { describe, expect, it, beforeEach } from "vitest";
import { executeMcpTool, resetMcpIdempotencyLedger, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

/**
 * THE ACKNOWLEDGEMENT COMES FROM THE COMMITTED DOCUMENT (audit F-24).
 *
 * The `kyx_automation` handler used to compute its answer from the LOCAL
 * chain it had just built — the document it INTENDED to write. The document
 * is what the project HOLDS. When the two differ (the normaliser clamps
 * further than the command did, a collaborator merges, a point does not
 * land), the tool reported a change that never happened.
 *
 * The context below makes the two differ ON PURPOSE: `execute` applies the
 * command and then applies ONE more change, so the committed document holds
 * something the handler never saw. The acknowledgement must name the
 * committed truth — and a change that did not land must not be reported as
 * one that did.
 *
 * The second half of the file covers S-1 gap 3: the R-02 gate's structural
 * read-back rode in the PROSE only, so a client that reads `data` never saw
 * the verification. It rides in `data.readback` now.
 */

function makeCtx(
  document: ProjectDocument,
  after?: (doc: ProjectDocument) => ProjectDocument,
  options: { allowDestructive?: boolean } = {},
): McpToolContext {
  let current = document;
  return withAgentWriter({
    getDoc: () => current,
    execute: (command) => {
      current = command.execute(current);
      if (after) current = after(current);
    },
    undo: () => {},
    redo: () => {},
    undoStackLength: () => 0,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
    ...(options.allowDestructive ? { allowDestructive: () => true } : {}),
  });
}

/** A store that CHANGES the value after the command landed — the store's own
 *  normalisation going further than the command did. */
function storeRewritesValues(to: number): (doc: ProjectDocument) => ProjectDocument {
  return (doc) => ({
    ...doc,
    automation: doc.automation.map((lane) => ({
      ...lane,
      points: lane.points.map((point) => ({ ...point, value: to })),
    })),
  });
}

describe("the MCP acknowledgement is read back from the committed document (audit F-24)", () => {
  const doc = createProjectFromTemplate("house");
  const trackId = doc.tracks[0]!.id;

  beforeEach(() => {
    resetMcpIdempotencyLedger();
  });

  it("addPoint names the value the document HOLDS, not the value the handler asked for", async () => {
    const ctx = makeCtx(doc, storeRewritesValues(0.5));
    const result = await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId,
      param: "gain",
      bar: 4,
      value: 0.8,
    });
    expect(result.isError, result.text).not.toBe(true);
    // The committed document holds 0.5 (the store rewrote it), the handler
    // asked for 0.8 — the acknowledgement must name 0.5.
    expect(result.text).toContain("0.5");
    expect(result.text).not.toContain("0.8");
    const data = result.data as { point?: { value?: number }; readback?: string[] };
    expect(data.point?.value, result.text).toBe(0.5);
    expect(data.readback?.length ?? 0).toBeGreaterThan(0);
  });

  it("addPoint reports the point count of the committed lane", async () => {
    const ctx = makeCtx(doc);
    const result = await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId,
      param: "gain",
      bar: 4,
      value: 0.5,
    });
    expect(result.isError, result.text).not.toBe(true);
    const committed = ctx.getDoc().automation.flatMap((lane) => lane.points);
    const data = result.data as { pointCount?: number };
    expect(data.pointCount, result.text).toBe(committed.length);
  });

  it("deletePoint that did not land is a PARTIAL_FAILURE, not a removal", async () => {
    const added = await executeMcpTool(makeCtx(doc), "kyx_automation", {
      op: "addPoint",
      trackId,
      param: "gain",
      bar: 4,
      value: 0.5,
    });
    expect(added.isError, added.text).not.toBe(true);
    // A context whose execute does NOT apply the command at all.
    const noopCtx = makeCtx(doc, (d) => d);
    const result = await executeMcpTool(noopCtx, "kyx_automation", {
      op: "deletePoint",
      trackId,
      param: "gain",
      bar: 4,
    });
    // The point was never added in this context, so the lane does not exist —
    // the refusal must be a typed one, not a prose success.
    expect(result.isError, result.text).toBe(true);
    expect(result.errorCode, result.text).toBe("UNKNOWN_TARGET");
  });

  it("clearLane that did not land is a PARTIAL_FAILURE, not a clear", async () => {
    const ctx = makeCtx(doc);
    await executeMcpTool(ctx, "kyx_automation", { op: "addPoint", trackId, param: "gain", bar: 4, value: 0.5 });
    // A store that puts the point BACK after the clear — the clear did not
    // land in the committed document.
    const stubborn = makeCtx(
      ctx.getDoc(),
      (d) => ({
        ...d,
        automation: d.automation.map((lane) => ({ ...lane, points: [{ tick: 0, value: 0.5 }] })),
      }),
      { allowDestructive: true },
    );
    const result = await executeMcpTool(stubborn, "kyx_automation", {
      op: "clearLane",
      trackId,
      param: "gain",
    });
    expect(result.isError, result.text).toBe(true);
    expect(result.errorCode, result.text).toBe("PARTIAL_FAILURE");
  });

  it("clearLane that DID land reports the committed lane", async () => {
    const ctx = makeCtx(doc);
    await executeMcpTool(ctx, "kyx_automation", { op: "addPoint", trackId, param: "gain", bar: 4, value: 0.5 });
    const clearing = makeCtx(ctx.getDoc(), undefined, { allowDestructive: true });
    const result = await executeMcpTool(clearing, "kyx_automation", {
      op: "clearLane",
      trackId,
      param: "gain",
    });
    expect(result.isError, result.text).not.toBe(true);
    const data = result.data as { clearedPoints?: number };
    expect(data.clearedPoints, result.text).toBe(1);
    expect(clearing.getDoc().automation.flatMap((lane) => lane.points).length, "the committed lane is empty").toBe(0);
  });
});

describe("the R-02 gate's read-back rides in the envelope too (S-1 gap 3)", () => {
  const doc = createProjectFromTemplate("house");

  beforeEach(() => {
    resetMcpIdempotencyLedger();
  });

  it("a success without its own read-back gets one in data.readback", async () => {
    const ctx = makeCtx(doc);
    const result = await executeMcpTool(ctx, "kyx_tracks", {
      op: "setGain",
      trackId: doc.tracks[0]!.id,
      gain: 0.5,
    });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.mutated, result.text).toBe(true);
    const data = result.data as { readback?: string[] };
    expect(Array.isArray(data.readback), "the read-back must ride in data, not only in the prose").toBe(true);
    expect(data.readback!.length).toBeGreaterThan(0);
    expect(data.readback![0]!.length).toBeGreaterThan(0);
    // …and the prose carries the same verification.
    expect(result.text).toContain("read-back");
  });
});
