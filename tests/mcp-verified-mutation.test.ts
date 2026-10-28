import { describe, expect, it } from "vitest";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { verifiedMutation } from "../src/mcp/verified-mutation";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

/**
 * THE FALSE AI SUCCESS — the class R-02 closes.
 *
 * The MCP surface has ~90 mutation sites. Each used to report WHAT IT WAS ASKED
 * TO DO — "pasted 3 clips", "mix applied (12 decisions)", "one undo step" —
 * and nothing verified what landed. The agent was told a knob moved and never
 * saw the number, the track, or the target that did not resolve.
 *
 * The contract under test: a success claim carries a verification, and a
 * claim that the document did not move is corrected instead of believed.
 */

function makeCtx(doc: ProjectDocument): McpToolContext {
  let current = doc;
  const undoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  const redoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  return withAgentWriter({
    getDoc: () => current,
    execute: (command) => {
      current = command.execute(current);
      undoStack.push({ undo: () => command.undo(current), redo: () => command.execute(current) });
      redoStack.length = 0;
    },
    undo: () => {
      const entry = undoStack.pop();
      if (entry) {
        current = entry.undo();
        redoStack.push(entry);
      }
    },
    redo: () => {
      const entry = redoStack.pop();
      if (entry) {
        current = entry.redo();
        undoStack.push(entry);
      }
    },
    undoStackLength: () => undoStack.length,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
  });
}

describe("a mutation becomes a claim only when the document backs it", () => {
  it("a success WITHOUT a read-back gets one", async () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const result = await executeMcpTool(ctx, "kyx_mix", { genre: "house" });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("read-back:");
  });

  it("a claim of an undo step the stack never recorded is corrected", () => {
    const doc = createProjectFromTemplate("house");
    const verified = verifiedMutation({
      before: doc,
      after: doc,
      undoDepthBefore: 0,
      undoDepthAfter: 0,
      result: { text: "pasted 3 clips at bar 5 — one undo step", mutated: true },
    });
    expect(verified.mutated).toBe(false);
    expect(verified.text).not.toContain("one undo step");
    expect(verified.text).toContain("nothing changed");
  });

  it("a read-back that names the value is left alone", () => {
    const doc = createProjectFromTemplate("house");
    const after = { ...doc, name: "renamed" };
    const verified = verifiedMutation({
      before: doc,
      after,
      undoDepthBefore: 0,
      undoDepthAfter: 1,
      result: { text: "reverb mix 0.30→0.46 on Bass (one undo step)", mutated: true },
    });
    expect(verified.text).toBe("reverb mix 0.30→0.46 on Bass (one undo step)");
    expect(verified.mutated).toBe(true);
  });

  it("a mutation that folded into the previous undo step says so", () => {
    const doc = createProjectFromTemplate("house");
    const after = { ...doc, name: "renamed" };
    const verified = verifiedMutation({
      before: doc,
      after,
      undoDepthBefore: 3,
      undoDepthAfter: 3,
      result: { text: "renamed the project — one undo step", mutated: true },
    });
    expect(verified.text).toContain("folded into the previous undo step");
    expect(verified.text).not.toContain("one undo step");
  });

  it("an undo that SHRANK the stack keeps its own claim", () => {
    // kyx_undo pops the stack — the depth goes DOWN. That is not a mutation
    // that "folded into the previous undo step"; the correction must not
    // touch a claim the stack already answers.
    const doc = createProjectFromTemplate("house");
    const after = { ...doc, name: "undone" };
    const verified = verifiedMutation({
      before: doc,
      after,
      undoDepthBefore: 2,
      undoDepthAfter: 1,
      result: { text: "undo ×1 — one undo step", mutated: true },
    });
    expect(verified.text).toContain("one undo step");
    expect(verified.text).not.toContain("folded into the previous undo step");
  });

  it("a success with an identical document is NOT a success", () => {
    const doc = createProjectFromTemplate("house");
    const verified = verifiedMutation({
      before: doc,
      after: doc,
      undoDepthBefore: 1,
      undoDepthAfter: 1,
      result: { text: "mix applied (3 decisions): pump: sidechain 0.30→0.46", mutated: true },
    });
    expect(verified.mutated).toBe(false);
    expect(verified.stage).toBe("noop");
    // The truth comes FIRST; the handler's narration survives only as what it
    // REPORTED — never as an assertion that the work happened.
    expect(verified.text.startsWith("nothing changed (the document is identical)")).toBe(true);
    expect(verified.text).toContain("reported:");
    expect(verified.data).toMatchObject({ status: "unchanged", changed: false });
  });

  it("a command that ran but left the document identical keeps the mutation", () => {
    // The undo step is REAL — the command executed and can be undone. The
    // content simply did not move (a restore to the state that was already
    // there). The agent must not be told the operation did nothing.
    const doc = createProjectFromTemplate("house");
    const verified = verifiedMutation({
      before: doc,
      after: doc,
      undoDepthBefore: 2,
      undoDepthAfter: 3,
      result: { text: "restored the checkpoint — one undo step", mutated: true },
    });
    expect(verified.mutated).toBe(true);
    expect(verified.text).toContain("one undo step");
    expect(verified.text).not.toContain("nothing changed");
  });

  it("a tool that writes OUTSIDE the document keeps its claim", () => {
    // The user sample library is not the project document: an unchanged
    // document says nothing about whether the import happened.
    const doc = createProjectFromTemplate("house");
    const verified = verifiedMutation({
      before: doc,
      after: doc,
      undoDepthBefore: 0,
      undoDepthAfter: 0,
      documentMutation: false,
      result: { text: 'Imported "My Cello": 2 samples → 2 velocity layers', mutated: true },
    });
    expect(verified.mutated).toBe(true);
    expect(verified.text).toContain("Imported");
    expect(verified.text).not.toContain("nothing changed");
  });

  it("the handler's OWN read-back is not blurred by the structural one", async () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    await executeMcpTool(ctx, "kyx_fx", { action: "more", effect: "reverb", family: "drums" });
    const result = await executeMcpTool(ctx, "kyx_plugin_param", {
      op: "set",
      family: "drums",
      effect: "reverb",
      param: "mix",
      value: 0.42,
    });
    expect(result.mutated).toBe(true);
    // The value-level read-back survives...
    expect(result.text).toContain("→ 0.42");
    // ...and the structural fallback does NOT pile a second one on top.
    expect(result.text.match(/read-back:/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("an effect added at defaults says it was ADDED (F-10)", async () => {
    const ctx = makeCtx(createProjectFromTemplate("house"));
    const result = await executeMcpTool(ctx, "kyx_fx", {
      action: "more",
      effect: "reverb",
      family: "drums",
    });
    expect(result.mutated).toBe(true);
    // A transition that shows no movement ("mix 0.30→0.30") is not a
    // verification; the truth is that the effect is now on the track.
    expect(result.text).not.toMatch(/mix 0\.\d+→0\.\d+/);
    expect(result.text).toContain("added");
  });
});
