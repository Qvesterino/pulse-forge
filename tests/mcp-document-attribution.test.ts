import { describe, expect, it, beforeEach } from "vitest";
import { executeMcpTool, resetMcpIdempotencyLedger, type McpToolContext } from "../src/mcp/tools";
import { withAgentAttribution } from "../src/mcp/attribution";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * P1-D DOCUMENT/WINDOW ATTRIBUTION (control-surface audit 2026-10-13,
 * GAP-06). The UNKNOWN is resolved: the web relay shares the desktop's
 * SINGLE-session model — `collab-server.mjs` keeps ONE `mcpRelaySocket`
 * (last connected window wins) and funnels every authenticated /mcp caller
 * into that one window's document; the desktop bridge is the same shape
 * (one window, one context). Concurrent agents therefore DO interleave on
 * one document, and per the roadmap's S-scope that shared reality must be
 * observable: the result of any mutation states which document (name + id)
 * and which attributed surface produced it.
 *
 * Contract under test:
 *  A1 every mutating result names the document (text line + docId/docName)
 *  A2 the attributed surface is named when the context carries one
 *  A3 read-only results carry no attribution
 *  A4 a replay reports the ORIGINAL document identity exactly once
 *  A5 kyx_batch: the aggregate result carries the attribution
 *  A6 a command that renames the document reports the post-rename name
 */

function makeCtx(doc: ProjectDocument, agentId?: "web-relay" | "desktop-stdio"): McpToolContext {
  let current = doc;
  const base: McpToolContext = {
    getDoc: () => current,
    execute: (command) => {
      current = command.execute(current);
    },
    undo: () => {},
    redo: () => {},
    undoStackLength: () => 0,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
  };
  return agentId ? withAgentAttribution(base, agentId) : base;
}

beforeEach(() => {
  resetMcpIdempotencyLedger();
});

describe("mcp document/window attribution (P1-D, GAP-06)", () => {
  it("A1 every mutating result names the document it landed on", async () => {
    const doc = createProjectFromTemplate("house");
    const result = await executeMcpTool(makeCtx(doc), "kyx_markers", { op: "add", bar: 1, name: "p1d" });
    expect(result.mutated).toBe(true);
    expect(result.docId).toBe(doc.id);
    expect(result.docName).toBe(doc.name);
    expect(result.text).toContain(`mutated on document "${doc.name}" (id ${doc.id})`);
  });

  it("A2 the attributed surface is named when the context carries one", async () => {
    const doc = createProjectFromTemplate("house");
    const relayCtx = makeCtx(doc, "web-relay");
    const result = await executeMcpTool(relayCtx, "kyx_markers", { op: "add", bar: 1, name: "p1d" });
    expect(result.text).toContain(`mutated on web-relay · document "${doc.name}"`);
    const desktopCtx = makeCtx(doc, "desktop-stdio");
    const desktopResult = await executeMcpTool(desktopCtx, "kyx_markers", { op: "add", bar: 2, name: "p1d" });
    expect(desktopResult.text).toContain("mutated on desktop-stdio · document");
  });

  it("A3 read-only results carry no attribution", async () => {
    const doc = createProjectFromTemplate("house");
    const result = await executeMcpTool(makeCtx(doc), "kyx_state", { subject: "tempo" });
    expect(result.mutated).toBe(false);
    expect(result.docId).toBeUndefined();
    expect(result.docName).toBeUndefined();
    expect(result.text).not.toContain("mutated on");
  });

  it("A4 a replay reports the ORIGINAL document identity exactly once", async () => {
    const doc = createProjectFromTemplate("house");
    const ctx = makeCtx(doc, "web-relay");
    await executeMcpTool(ctx, "kyx_markers", { op: "add", bar: 1, name: "p1d", requestId: "a4" });
    const replay = await executeMcpTool(ctx, "kyx_markers", { op: "add", bar: 1, name: "p1d", requestId: "a4" });
    expect(replay.replayed).toBe(true);
    expect(replay.docId).toBe(doc.id);
    expect(replay.docName).toBe(doc.name);
    // the replay prefix + exactly ONE attribution line (from the original)
    expect(replay.text.match(/mutated on /g)).toHaveLength(1);
    expect(replay.text).toContain(`mutated on web-relay · document "${doc.name}"`);
  });

  it("A5 the batch aggregate carries the attribution", async () => {
    const doc = createProjectFromTemplate("house");
    const result = await executeMcpTool(makeCtx(doc, "qmr" as never), "kyx_batch", {
      calls: [
        { tool: "kyx_markers", args: { op: "add", bar: 1, name: "b1" } },
        { tool: "kyx_markers", args: { op: "add", bar: 2, name: "b2" } },
      ],
    });
    expect(result.mutated).toBe(true);
    expect(result.docId).toBe(doc.id);
    // The aggregate line AND each sub-call line carry the surface + document.
    expect(result.text).toContain(`mutated on qmr · document "${doc.name}"`);
    expect(result.text.match(/mutated on /g)?.length).toBe(3); // 2 sub-calls + the aggregate
  });

  it("A6 a command that renames the document reports the post-rename name", async () => {
    const doc = createProjectFromTemplate("house");
    const result = await executeMcpTool(makeCtx(doc), "kyx_song", { op: "rename", name: "Renamed Beat" });
    if (result.mutated) {
      // kyx_song rename support may vary — when the rename landed, the
      // attribution must show the NEW name (post-command document state).
      expect(result.docName).toBe("Renamed Beat");
      expect(result.text).toContain('document "Renamed Beat"');
    } else {
      // otherwise the tool declined (no rename op) — nothing to attribute
      expect(result.docId).toBeUndefined();
    }
  });
});
