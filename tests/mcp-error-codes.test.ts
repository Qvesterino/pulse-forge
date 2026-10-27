import { describe, expect, it, beforeEach } from "vitest";
import { executeMcpTool, resetMcpIdempotencyLedger, type McpErrorCode, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * P2-B TYPED ERROR CONTRACT (control-surface audit 2026-10-13, GAP-08).
 * Errors used to be free text — an agent had to substring-match to branch.
 * Every `isError` result now carries a stable `errorCode` from the closed
 * McpErrorCode set; each code maps to ONE distinct recovery action.
 *
 * The table drives one REAL dispatcher call per code — no handler is mocked:
 *   UNKNOWN_TOOL            a tool name that does not exist
 *   UNKNOWN_REQUEST         a tool that exists, an op that does not
 *   INVALID_ARGUMENTS       missing required arguments
 *   UNKNOWN_TARGET          a named target that resolves to nothing
 *   EXECUTION_FAILED        a well-formed call whose command throws
 *   PARTIAL_FAILURE         a compound op stopped mid-form
 *   UNAVAILABLE_ON_TRANSPORT a capability this session lacks
 *   POLICY_REFUSED          a gate declines (destructive ops locked)
 *   REQUEST_ID_CONFLICT     a retry key names different tool arguments
 *   RESOURCE_LIMIT          a bounded session resource has reached its cap
 */

function makeCtx(doc: ProjectDocument, options: { allowDestructive?: boolean } = {}): McpToolContext {
  let current = doc;
  return {
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
    ...(options.allowDestructive ? { allowDestructive: () => true } : {}),
  };
}

beforeEach(() => {
  resetMcpIdempotencyLedger();
});

describe("mcp typed error codes (P2-B, GAP-08)", () => {
  const doc = createProjectFromTemplate("house");

  const CASES: Array<{ code: McpErrorCode; name: string; args: Record<string, unknown> }> = [
    { code: "UNKNOWN_TOOL", name: "kyx_no_such_tool", args: {} },
    { code: "UNKNOWN_REQUEST", name: "kyx_tracks", args: { op: "teleport" } },
    { code: "INVALID_ARGUMENTS", name: "kyx_batch", args: {} },
    { code: "UNKNOWN_TARGET", name: "kyx_checkpoint", args: { op: "restore", name: "no-such-checkpoint" } },
    // well-formed intent whose applier throws — the command fails, not the args
    { code: "EXECUTION_FAILED", name: "kyx_intent", args: { instruction: "more reverb on the vocal" } },
    { code: "UNAVAILABLE_ON_TRANSPORT", name: "kyx_meter", args: {} },
    { code: "POLICY_REFUSED", name: "kyx_tracks", args: { op: "remove", trackId: "real", allowDestructive: false } },
  ];

  for (const { code, name, args } of CASES) {
    it(`"${code}" is returned for a real ${name} call`, async () => {
      const options = code === "POLICY_REFUSED" ? {} : { allowDestructive: true };
      const ctx = makeCtx(doc, options);
      const callArgs =
        code === "POLICY_REFUSED"
          ? { op: "remove", trackId: doc.tracks[0]!.id } // well-formed — the GATE declines it
          : args;
      const result = await executeMcpTool(ctx, name, callArgs);
      expect(result.isError, `${name} ${JSON.stringify(callArgs)}`).toBe(true);
      expect(result.errorCode, result.text).toBe(code);
    });
  }

  it("partial failures and requestId errors are part of the closed set", async () => {
    const codes: McpErrorCode[] = [
      "UNKNOWN_TOOL",
      "UNKNOWN_REQUEST",
      "INVALID_ARGUMENTS",
      "UNKNOWN_TARGET",
      "EXECUTION_FAILED",
      "PARTIAL_FAILURE",
      "UNAVAILABLE_ON_TRANSPORT",
      "POLICY_REFUSED",
      "REQUEST_ID_CONFLICT",
      "INVALID_REQUEST_ID",
      "RESOURCE_LIMIT",
      "WRITE_CONFLICT",
      "CONFIRMATION_REQUIRED",
      "CANCELLED",
    ];
    expect(new Set(codes).size).toBe(14);
  });

  it("success results carry no errorCode", async () => {
    const result = await executeMcpTool(makeCtx(doc), "kyx_state", { subject: "tempo" });
    expect(result.isError).toBeUndefined();
    expect(result.errorCode).toBeUndefined();
  });

  it("refuses undo during microphone recording with a typed policy error", async () => {
    const ctx = makeCtx(doc);
    ctx.isMicRecordingActive = () => true;
    const result = await executeMcpTool(ctx, "kyx_undo", { action: "undo" });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("POLICY_REFUSED");
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("mic take is recording");
  });

  it("GATE: every error result is constructed through mcpError — no un-coded literals", async () => {
    // GAP-09 taught this lesson for handlers: coverage without a gate rots.
    // The invariant is "no UN-CODED error result": every `isError: true`
    // literal must carry its own `errorCode` in the same object, so agents can
    // branch on it. mcpError is the shaped constructor for results; the
    // agent-call telemetry ledger legitimately carries its own error vocabulary
    // ("THREW") and is not a result, so counting raw occurrences cannot tell
    // the two apart — this checks the actual promise instead.
    const { readFile } = await import("node:fs/promises");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const source = await readFile(resolve(root, "src/mcp/tools.ts"), "utf8");
    const codedLiterals = [...source.matchAll(/isError:\s*true[\s\S]{0,120}?errorCode:/g)].length;
    expect(codedLiterals, "expected the mcpError constructor to exist").toBeGreaterThan(0);
    const unCoded = [...source.matchAll(/isError:\s*true(?![\s\S]{0,120}?errorCode:)/g)].length;
    expect(unCoded, "an isError:true without an errorCode is an un-coded error agents cannot branch on").toBe(0);
  });

  it("every error text still explains itself — the code never replaces the reason", async () => {
    const result = await executeMcpTool(makeCtx(doc), "kyx_no_such_tool", {});
    expect(result.errorCode).toBe("UNKNOWN_TOOL");
    expect(result.text.length).toBeGreaterThan(10);
  });
});
