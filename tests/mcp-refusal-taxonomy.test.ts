import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { executeMcpTool, resetMcpIdempotencyLedger, type McpErrorCode, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * THE REFUSAL TAXONOMY (audit F-05) — the complementary half of the gate that
 * already exists in `tests/mcp-error-codes.test.ts`.
 *
 * That gate counts `isError: true` LITERALS and requires each to carry an
 * `errorCode`. It cannot see a refusal that is not an error at all — and a
 * refusal that is not an error is the hole F-05 measured. The MCP surface had
 * 191 results that changed no document and said NOTHING about what they were:
 * a refusal, a no-op, or a fact about the runtime. The dispatch guessed
 * "read" for all of them, so a call that never happened reached the agent
 * looking like a successful read.
 *
 * THE RULE, in one sentence:
 *
 *   A result that did not change the document DECLARES its disposition —
 *   `isError` + a code (a REFUSAL), or `stage` (a no-op, or a non-document
 *   fact). A result that declares neither is an untyped refusal.
 *
 * The rule is enforced twice: statically (the gate below — a handler that
 * forgets is caught in CI) and at the dispatch perimeter (a call that reaches
 * the surface without a declaration is named as a failure, not as a read).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mcpDir = resolve(root, "src/mcp");

/** The closed code set — the same list `tests/mcp-error-codes.test.ts` pins. */
const TAXONOMY: readonly McpErrorCode[] = [
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
  "WRITE_CONFLICT",
  "CONFIRMATION_REQUIRED",
  "RESOURCE_LIMIT",
];

function isFalseLiteral(node: ts.Node): boolean {
  return node.kind === ts.SyntaxKind.FalseKeyword || (ts.isIdentifier(node) && node.text === "false");
}

/** Every object-literal `return` in the file, with its property names. */
function scanReturns(file: string): Array<{ line: number; props: Set<string> }> {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Array<{ line: number; props: Set<string> }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      const props = new Set<string>();
      let mutatedFalse = false;
      for (const p of node.expression.properties) {
        if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
        const name = p.name && ts.isIdentifier(p.name) ? p.name.text : null;
        if (!name) continue;
        props.add(name);
        if (name === "mutated") {
          const init = ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer;
          if (init && isFalseLiteral(init)) mutatedFalse = true;
        }
      }
      if (mutatedFalse) {
        found.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          props,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const mcpFiles = readdirSync(mcpDir)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => resolve(mcpDir, name));

describe("the MCP refusal taxonomy (audit F-05)", () => {
  describe("GATE — the source declares the disposition", () => {
    it("every result that changed no document declares isError or a stage", () => {
      const violations: string[] = [];
      for (const file of mcpFiles) {
        for (const site of scanReturns(file)) {
          const declares = site.props.has("isError") || site.props.has("stage");
          if (!declares) {
            violations.push(`${file.replace(root + "\\", "")}:${site.line} declares neither isError nor stage`);
          }
        }
      }
      expect(
        violations,
        "a result that changed no document and declares nothing is an untyped refusal — the agent cannot tell it from a success",
      ).toEqual([]);
    });

    it("every mcpError() call uses a code from the closed taxonomy", () => {
      const violations: string[] = [];
      for (const file of mcpFiles) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/mcpError\(\s*"([A-Z_]+)"/g)) {
          if (!(TAXONOMY as readonly string[]).includes(match[1]!)) {
            violations.push(`${file.replace(root + "\\", "")}: mcpError("${match[1]}")`);
          }
        }
      }
      expect(violations, "an error code outside the closed set cannot be branched on by an agent").toEqual([]);
    });

    it("the taxonomy itself is closed and unique", () => {
      expect(new Set(TAXONOMY).size).toBe(TAXONOMY.length);
    });
  });

  describe("RUNTIME — a refusal is machine-detectable", () => {
    const doc = createProjectFromTemplate("house");

    function makeCtx(document: ProjectDocument): McpToolContext {
      let current = document;
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
      };
    }

    beforeEach(() => {
      resetMcpIdempotencyLedger();
    });

    it("F-05: a stale target on kyx_automation is an ERROR with a code, not a prose refusal", async () => {
      // This is the exact row the audit measured as "unset (not an error)".
      const result = await executeMcpTool(makeCtx(doc), "kyx_automation", {
        op: "listTargets",
        trackId: "no-such-track",
      });
      expect(result.isError, result.text).toBe(true);
      expect(result.errorCode, result.text).toBe("UNKNOWN_TARGET");
      expect(result.mutated).toBe(false);
    });

    it("a missing argument on kyx_automation is INVALID_ARGUMENTS", async () => {
      const result = await executeMcpTool(makeCtx(doc), "kyx_automation", { op: "listTargets" });
      expect(result.isError, result.text).toBe(true);
      expect(result.errorCode, result.text).toBe("INVALID_ARGUMENTS");
    });

    it("an unknown op on kyx_automation is UNKNOWN_REQUEST", async () => {
      const result = await executeMcpTool(makeCtx(doc), "kyx_automation", {
        op: "no-such-op",
        trackId: doc.tracks[0]!.id,
        param: "gain",
      });
      expect(result.isError, result.text).toBe(true);
      expect(result.errorCode, result.text).toBe("UNKNOWN_REQUEST");
    });

    it("a legitimate READ is not a refusal — it says stage 'read'", async () => {
      const result = await executeMcpTool(makeCtx(doc), "kyx_automation", {
        op: "listTargets",
        trackId: doc.tracks[0]!.id,
      });
      expect(result.isError, result.text).not.toBe(true);
      expect(result.errorCode).toBeUndefined();
      expect(result.stage, result.text).toBe("read");
    });

    it("a legitimate NO-OP is not a refusal — it says stage 'noop'", async () => {
      const ctx = makeCtx(doc);
      const track = doc.tracks[0]!;
      const gain = track.gain > 0.5 ? 0.5 : 0.6;
      const first = await executeMcpTool(ctx, "kyx_tracks", { op: "setGain", trackId: track.id, gain });
      expect(first.isError, first.text).not.toBe(true);
      const second = await executeMcpTool(ctx, "kyx_tracks", { op: "setGain", trackId: track.id, gain });
      expect(second.isError, second.text).not.toBe(true);
      expect(second.mutated, second.text).toBe(false);
      expect(second.stage, "a run that changed nothing must say so").toBe("noop");
    });
  });
});
