import { describe, expect, it } from "vitest";
import { applyEffectIntent, type EffectIntent } from "../src/intent/mix";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { addEffectToTracks } from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import type { EffectType, ProjectDocument } from "../src/project-model/types";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

/**
 * A TYPE-LEVEL effect remove must not need a primary knob.
 *
 * The knob guard used to run BEFORE the remove branch, so every effect
 * without a primary knob (43 of the 57 registered types - eq, saturation,
 * ozvena, ...) threw "no knob mapped for effect X" instead of taking the
 * instance out. The UI's intent bar had no try/catch on that branch, so the
 * error escaped the click handler: no status, no error, NOTHING happened.
 *
 * The knob is still required where the knob is the thing that moves: a
 * "more"/"less" ask and an absolute "set" of the knob's own range.
 */

function docWithEffect(effect: EffectType): { doc: ProjectDocument; trackId: string } {
  const doc = createProjectFromTemplate("house");
  const trackId = doc.tracks.find((track) => track.kind === "instrument")!.id;
  return { doc: addEffectToTracks(doc, [trackId], effect).execute(doc), trackId };
}

function removeIntent(effect: EffectType, trackId: string): EffectIntent {
  return {
    effectType: effect,
    targets: [],
    trackIds: [trackId],
    direction: "remove",
    amount: "medium",
    detected: ["test"],
  };
}

function makeCtx(store: ProjectStore, options: { allowDestructive?: boolean } = {}): McpToolContext {
  return withAgentWriter({
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: {
      play: () => {},
      stop: () => {},
      pause: () => {},
      setLoop: () => {},
      setMetronome: () => {},
    },
    ...(options.allowDestructive ? { allowDestructive: () => true } : {}),
  });
}

describe("a type-level effect remove needs no primary knob", () => {
  it("takes out an effect that has no knob of its own", () => {
    const { doc, trackId } = docWithEffect("eq");
    expect(doc.tracks.find((track) => track.id === trackId)!.effects.some((fx) => fx.type === "eq")).toBe(true);

    const next = applyEffectIntent(doc, removeIntent("eq", trackId)).execute(doc);

    expect(next.tracks.find((track) => track.id === trackId)!.effects.some((fx) => fx.type === "eq")).toBe(false);
  });

  it("still refuses a knob-turning ask on an effect without a knob", () => {
    const { doc, trackId } = docWithEffect("eq");
    const intent: EffectIntent = {
      effectType: "eq",
      targets: [],
      trackIds: [trackId],
      direction: "more",
      amount: "medium",
      detected: ["test"],
    };
    expect(() => applyEffectIntent(doc, intent)).toThrow(/no knob mapped/);
  });

  it("removes a knobless effect through the MCP tool", async () => {
    const { doc, trackId } = docWithEffect("eq");
    const store = new ProjectStore(doc);
    const result = await executeMcpTool(makeCtx(store, { allowDestructive: true }), "kyx_fx", {
      effect: "eq",
      trackId,
      action: "remove",
    });
    expect(result.isError).toBeFalsy();
    expect(result.mutated).toBe(true);
    expect(store.doc.tracks.find((track) => track.id === trackId)!.effects.some((fx) => fx.type === "eq")).toBe(false);
  });
});
