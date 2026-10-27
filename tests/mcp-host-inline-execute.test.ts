import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";
import { ProjectStore } from "../src/store/ProjectStore";
import { setTrackParams } from "../src/commands/project";
import { createProjectFromTemplate } from "../src/project-model/templates";

/**
 * THE HOST PRECONDITION (audit F-26) — `execute` applies the command INLINE.
 *
 * The R-02 gate reads the document immediately after the handler returns and
 * compares it with the document from before. A host that DEFERS the command
 * leaves the document identical at that moment, so the gate answers "nothing
 * changed (the document is identical)" with `mutated: false` — and the
 * mutation lands afterwards. A truth gate failing OPEN is worse than no gate,
 * because it is trusted.
 *
 * The type cannot carry this precondition: TypeScript lets a Promise-returning
 * function satisfy a `void`-returning signature, so a deferred host compiles
 * cleanly. This file is the guard that stands in for the type:
 *
 *   1. the store applies inline,
 *   2. the headless host applies inline,
 *   3. no registered host's `execute` is async, awaits, or defers.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mcpDir = resolve(root, "src/mcp");

describe("the MCP host applies commands inline (audit F-26)", () => {
  it("the store applies the command before its call returns", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const trackId = store.doc.tracks[0]!.id;
    const before = store.doc;
    store.execute(setTrackParams(before, trackId, { gain: 0.42 }));
    // The document is ALREADY the new one — no flush, no tick, no await.
    expect(store.doc).not.toBe(before);
    expect(store.doc.tracks[0]!.gain).toBeCloseTo(0.42, 5);
  });

  it("the headless host's execute applies the command inline", () => {
    const host = createHeadlessMcpHost({ document: createProjectFromTemplate("house") });
    const trackId = host.store.doc.tracks[0]!.id;
    const before = host.store.doc;
    host.ctx.execute(setTrackParams(before, trackId, { gain: 0.42 }));
    expect(host.ctx.getDoc()).not.toBe(before);
    expect(host.ctx.getDoc().tracks[0]!.gain).toBeCloseTo(0.42, 5);
  });

  it("no registered host's execute is async, awaits, or defers", () => {
    const violations: string[] = [];
    const files = readdirSync(mcpDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => resolve(mcpDir, name));

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && node.name && ts.isIdentifier(node.name) && node.name.text === "execute") {
          const impl = node.initializer;
          const isFunction = ts.isArrowFunction(impl) || ts.isFunctionExpression(impl);
          if (isFunction) {
            const where = `${file.replace(root + "\\", "")}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
            if (impl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
              violations.push(`${where} — execute is async`);
            }
            const body = impl.getText(sf);
            for (const forbidden of [
              "await ",
              "Promise",
              ".then(",
              "setTimeout",
              "queueMicrotask",
              "requestAnimationFrame",
            ]) {
              if (body.includes(forbidden)) {
                violations.push(`${where} — execute contains "${forbidden.trim()}"`);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(
      violations,
      'a deferred execute makes every mutation read as "nothing changed" — the gate would fail OPEN',
    ).toEqual([]);
  });
});
