import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";
import { MCP_TOOLS, resetMcpCheckpoints, resetMcpIdempotencyLedger } from "../src/mcp/tools";
import {
  AGENT_AUDIT_KEY,
  TOOL_RISK,
  agentTrustSnapshot,
  currentAgentSession,
  readAgentAudit,
  resetAgentTrustForTests,
  subscribeAgentTrust,
  summarizeToolArgs,
  toolAnnotations,
} from "../src/mcp/agentTrust";
import { jobSnapshot, resetJobCenterForTests } from "../src/services/jobCenter";
import { createDefaultProject } from "../src/project-model/schema";

/**
 * AGENT TRUST LAYER (Wave 1/A) — risk classification, session checkpoints and
 * the local audit log. These run through the REAL headless MCP host, so the
 * assertions enter the same wrapper every transport uses.
 */

function host() {
  return createHeadlessMcpHost({ document: createDefaultProject() });
}

beforeEach(() => {
  localStorage.clear();
  resetAgentTrustForTests();
  resetMcpIdempotencyLedger();
  resetMcpCheckpoints();
  resetJobCenterForTests();
});

afterEach(() => {
  localStorage.clear();
});

describe("tool risk classification", () => {
  it("classifies every MCP tool exactly once (a new tool cannot ship unclassified)", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(TOOL_RISK[name], `${name} has no risk entry`).toBeDefined();
    }
    const extras = Object.keys(TOOL_RISK).filter((name) => !names.includes(name));
    expect(extras, "risk entries that no longer match a tool").toEqual([]);
  });

  it("exposes MCP annotations derived from the risk table", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.annotations, `${tool.name} annotations`).toEqual(toolAnnotations(tool.name));
    }
    expect(MCP_TOOLS.find((tool) => tool.name === "kyx_state")?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(MCP_TOOLS.find((tool) => tool.name === "kyx_tracks")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(MCP_TOOLS.find((tool) => tool.name === "kyx_export")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });
});

describe("agent audit log", () => {
  it("audits reads without starting a session", async () => {
    const h = host();
    const result = await h.call("kyx_state", { subject: "summary" });
    expect(result.mutated).toBe(false);
    expect(currentAgentSession()).toBeNull();
    const log = readAgentAudit();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ tool: "kyx_state", risk: "read", mutated: false, isError: false, depth: 0 });
    expect(localStorage.getItem(AGENT_AUDIT_KEY)).toContain("kyx_state");
  });

  it("records error results with their typed error code", async () => {
    const h = host();
    const result = await h.call("kyx_not_a_tool", {});
    expect(result.isError).toBe(true);
    const log = readAgentAudit();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ tool: "kyx_not_a_tool", isError: true, mutated: false });
    expect(log[0]!.errorCode).toBeTruthy();
  });

  it("audits dry-runs as non-mutating and never starts a session", async () => {
    const h = host();
    const before = h.store.doc.markers.length;
    const preview = await h.call("kyx_markers", { op: "add", name: "dry", dryRun: true });
    expect(preview.mutated).toBe(false);
    expect(preview.dryRun).toBe(true);
    expect(h.store.doc.markers.length).toBe(before);
    expect(currentAgentSession()).toBeNull();
    expect(readAgentAudit()[0]).toMatchObject({ tool: "kyx_markers", dryRun: true, mutated: false });
  });

  it("audits idempotent replays without re-running the mutation", async () => {
    const h = host();
    await h.call("kyx_markers", { op: "add", bar: 1, requestId: "req-1" });
    const replay = await h.call("kyx_markers", { op: "add", bar: 1, requestId: "req-1" });
    expect(replay.replayed).toBe(true);
    expect(currentAgentSession()!.mutations).toBe(1);
    const replays = readAgentAudit().filter((entry) => entry.replayed === true);
    expect(replays).toHaveLength(1);
    expect(replays[0]!.mutated).toBe(false);
  });

  it("notifies subscribers and keeps a stable snapshot shape", async () => {
    const before = agentTrustSnapshot();
    let notifications = 0;
    const unsubscribe = subscribeAgentTrust(() => {
      notifications += 1;
    });
    const h = host();
    await h.call("kyx_state", { subject: "summary" });
    expect(notifications).toBeGreaterThan(0);
    expect(agentTrustSnapshot().entries).toHaveLength(1);
    expect(agentTrustSnapshot().revision).toBeGreaterThan(before.revision);
    unsubscribe();
  });

  it("summarizes args without storing payloads", () => {
    const summary = summarizeToolArgs({
      op: "add",
      notes: new Array(500).fill({ pitch: 60 }),
      prompt: "x".repeat(400),
      requestId: "req-1",
    });
    expect(summary).toContain('op="add"');
    expect(summary).toContain("notes=[500]");
    expect(summary).not.toContain("requestId");
    expect(summary.length).toBeLessThanOrEqual(220);
    expect(summarizeToolArgs(null)).toBe("");
  });
});

describe("agent session checkpoints", () => {
  it("takes exactly ONE checkpoint before the first mutation of a session", async () => {
    const h = host();
    await h.call("kyx_markers", { op: "add", bar: 1, name: "a" });
    const session = currentAgentSession();
    expect(session).not.toBeNull();
    expect(session!.mutations).toBe(1);
    expect(session!.calls).toBe(1);

    const firstList = await h.call("kyx_checkpoint", { op: "list" });
    expect(firstList.text).toContain("agent-session-");

    await h.call("kyx_markers", { op: "add", bar: 2, name: "b" });
    expect(currentAgentSession()!.mutations).toBe(2);
    const secondList = await h.call("kyx_checkpoint", { op: "list" });
    const checkpointCount = (secondList.text.match(/agent-session-/g) ?? []).length;
    expect(checkpointCount, "one checkpoint per session, not one per call").toBe(1);
  });

  it("restores a session checkpoint as one undoable step", async () => {
    const h = host();
    const markersBefore = h.store.doc.markers.length;
    await h.call("kyx_markers", { op: "add", bar: 1, name: "a" });
    expect(h.store.doc.markers.length).toBe(markersBefore + 1);
    const session = currentAgentSession()!;

    const restore = await h.call("kyx_checkpoint", { op: "restore", name: session.checkpointName });
    expect(restore.mutated).toBe(true);
    expect(h.store.doc.markers.length).toBe(markersBefore);
    // One undo step returns to the post-agent state (the restore is a command).
    h.store.undo();
    expect(h.store.doc.markers.length).toBe(markersBefore + 1);
  });

  it("does not start a session for checkpoint save/list/diff (restore still does)", async () => {
    const h = host();
    await h.call("kyx_checkpoint", { op: "save", name: "clean-house" });
    expect(currentAgentSession()).toBeNull();
    await h.call("kyx_checkpoint", { op: "list" });
    await h.call("kyx_checkpoint", { op: "diff", name: "clean-house" });
    expect(currentAgentSession()).toBeNull();
    // The audit still records the STATIC class — a client reading the tool
    // list must see that kyx_checkpoint can restore.
    expect(readAgentAudit().every((entry) => entry.risk === "mutate")).toBe(true);
    // Restore changes the document — the session (and its checkpoint) starts.
    await h.call("kyx_checkpoint", { op: "restore", name: "clean-house" });
    expect(currentAgentSession()).not.toBeNull();
    expect(currentAgentSession()!.mutations).toBe(1);
  });

  it("starts a fresh session (and checkpoint) when the agent changes", async () => {
    const h = host();
    await h.call("kyx_markers", { op: "add", bar: 1 });
    const first = currentAgentSession()!;
    const other = createHeadlessMcpHost({ document: h.store.doc, agentId: "web-relay" });
    await other.call("kyx_markers", { op: "add", bar: 2 });
    const second = currentAgentSession()!;
    expect(second.id).not.toBe(first.id);
    expect(second.agent).toBe("web-relay");
  });
});

describe("job center integration", () => {
  it("registers long-running agent calls as jobs and settles them honestly", async () => {
    const h = host();
    const result = await h.call("kyx_render_summary", {});
    // The headless transport has no render capability — the call must refuse
    // AND the job must not sit "running" after the refusal.
    expect(result.isError).toBe(true);
    const jobs = jobSnapshot().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "agent", status: "failed" });
    expect(jobSnapshot().runningCount).toBe(0);
  });

  it("does not create jobs for fast edit calls", async () => {
    const h = host();
    await h.call("kyx_markers", { op: "add", bar: 1 });
    expect(jobSnapshot().jobs).toHaveLength(0);
  });
});
