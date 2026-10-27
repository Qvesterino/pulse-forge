import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { INTENT_COMMAND_ROUTE_KINDS } from "../src/intent/command-for-route";
import { executeMcpTool, resetMcpIdempotencyLedger, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * HCP-04-01 — the MCP intent surface used to report a FALSE SUCCESS.
 *
 * `buildIntentCommand` has a branch per route kind it can execute. A route
 * kind WITHOUT a branch fell through to `default: return null`, and the MCP
 * executor answered that null with
 *
 *   "intent understood but nothing changed (already matches or no target)"
 *   stage: "noop"
 *
 * — a declared no-op, i.e. a SUCCESS-shaped answer. The document did not
 * already match: the capability simply had no builder over MCP. Measured
 * 2026-10-27: "restore checkpoint" (route kind `checkpointIntent`) answered
 * exactly that.
 *
 * Two gates:
 *   1. the source gate — the exported kind set must match the switch, so a
 *      new branch cannot be added without telling the executor about it
 *      (same "the source is the gate" pattern as ADR 0070);
 *   2. the behaviour gate — an unwired route kind must come back as a
 *      REFUSAL with a code, never as a no-op.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The route kinds the switch in `buildIntentCommand` actually handles. */
function routeKindsInTheSwitch(): string[] {
  const file = resolve(root, "src/intent/command-for-route.ts");
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const kinds: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "buildIntentCommand" && node.body) {
      const walk = (n: ts.Node): void => {
        if (ts.isCaseClause(n) && ts.isStringLiteral(n.expression)) kinds.push(n.expression.text);
        ts.forEachChild(n, walk);
      };
      walk(node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return kinds;
}

function makeCtx(doc: ProjectDocument): McpToolContext {
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
    allowDestructive: () => true,
  };
}

beforeEach(() => {
  resetMcpIdempotencyLedger();
});

describe("HCP-04-01 — an unwired intent route kind must not read as a success", () => {
  it("the exported kind set matches the switch in buildIntentCommand", () => {
    const inSwitch = routeKindsInTheSwitch().sort();
    expect(inSwitch.length, "the switch must have branches").toBeGreaterThan(10);
    expect([...INTENT_COMMAND_ROUTE_KINDS].sort()).toEqual(inSwitch);
  });

  it("a route kind with no builder comes back as a refusal, not as a no-op", async () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const result = await executeMcpTool(ctx, "kyx_intent", { instruction: "restore checkpoint" });

    // It used to answer: stage "noop", "intent understood but nothing changed
    // (already matches or no target)" — a success-shaped answer for a call
    // that could never happen.
    expect(result.stage).not.toBe("noop");
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("UNAVAILABLE_ON_TRANSPORT");
    expect(result.text).toContain("checkpointIntent");
    expect(result.mutated).toBe(false);
  });

  it("a route kind WITH a builder keeps its honest no-op", async () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    // The applier runs and finds no target — a real no-op, still a no-op.
    const result = await executeMcpTool(ctx, "kyx_intent", { instruction: "swap the snare to something fatter" });
    expect(result.stage).toBe("noop");
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("nothing changed");
  });
});
