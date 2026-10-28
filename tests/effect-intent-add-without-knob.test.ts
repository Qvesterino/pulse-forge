import { describe, expect, it } from "vitest";
import { applyEffectIntent, type EffectIntent } from "../src/intent/mix";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { defaultParamsOf, EFFECT_META, EFFECT_PRIMARY_KNOB } from "../src/effects/definitions";
import { addEffectToTracks } from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc } from "./fixtures/doc";
import type { EffectType, ProjectDocument } from "../src/project-model/types";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

/**
 * F-17 — an ADD ask on an effect without a primary knob must not be refused.
 *
 * The knob guard ran BEFORE the add branch, so "add eq on the bass" (the
 * parser's default direction is "more", mix.ts) threw "no knob mapped for
 * effect eq" even though the add itself never needs a knob: the instance is
 * created with its own defaults. A knob ask on an instance that is ALREADY
 * present still refuses honestly, and an absolute "set" still refuses - the
 * ask carries a number no knob here can take.
 */

function knoblessTypes(): EffectType[] {
  return (Object.keys(EFFECT_META) as EffectType[]).filter((type) => !EFFECT_PRIMARY_KNOB[type]);
}

function instrumentTrackId(doc: ProjectDocument): string {
  return doc.tracks.find((track) => track.kind === "instrument")!.id;
}

function moreIntent(effect: EffectType, trackId: string): EffectIntent {
  return {
    effectType: effect,
    targets: [],
    trackIds: [trackId],
    direction: "more",
    amount: "medium",
    detected: ["test"],
  };
}

function makeCtx(store: ProjectStore): McpToolContext {
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
    allowDestructive: () => true,
  });
}

describe("an add ask on a knob-less effect adds the instance", () => {
  it("census: every knob-less effect type is addable by a knob-shaped ask", () => {
    const types = knoblessTypes();
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      const doc = testDoc();
      const trackId = instrumentTrackId(doc);
      const command = applyEffectIntent(doc, moreIntent(type, trackId));
      const next = command.execute(doc);
      const fx = next.tracks.find((track) => track.id === trackId)!.effects.find((effect) => effect.type === type);
      expect(fx, `${type} must land on the track`).toBeDefined();
      const defaults = defaultParamsOf(type);
      for (const [paramId, value] of Object.entries(fx!.params)) {
        expect(value, `${type}.${paramId} keeps its default`).toBe(defaults[paramId]);
      }
      // The label must not claim a knob turn that did not happen.
      expect(command.label, `${type} label`).not.toMatch(/\bmore\b|\bless\b/);
      expect(command.label, `${type} label`).toContain(`+${type}`);
    }
  });

  it("still refuses a knob ask on an instance that is already present", () => {
    const doc = testDoc();
    const trackId = instrumentTrackId(doc);
    const withEq = addEffectToTracks(doc, [trackId], "eq").execute(doc);
    expect(() => applyEffectIntent(withEq, moreIntent("eq", trackId))).toThrow(/no knob mapped/);
  });

  it("still refuses an absolute set on a knob-less effect that is absent", () => {
    const doc = testDoc();
    const trackId = instrumentTrackId(doc);
    const intent: EffectIntent = {
      effectType: "eq",
      targets: [],
      trackIds: [trackId],
      direction: "set",
      percent: 40,
      amount: "medium",
      detected: ["test"],
    };
    expect(() => applyEffectIntent(doc, intent)).toThrow(/no knob mapped/);
  });

  it("a knob-ful fresh add still turns the knob (reverb mix leaves its default)", () => {
    const doc = testDoc();
    const trackId = instrumentTrackId(doc);
    const command = applyEffectIntent(doc, moreIntent("reverb", trackId));
    const next = command.execute(doc);
    const fx = next.tracks.find((track) => track.id === trackId)!.effects.find((effect) => effect.type === "reverb");
    expect(fx).toBeDefined();
    expect(fx!.params.mix).not.toBe(defaultParamsOf("reverb").mix);
  });

  it("the add reaches the MCP tool: kyx_intent 'add eq on the 808'", async () => {
    const doc = testDoc();
    const track = doc.tracks.find((candidate) => candidate.kind === "instrument" && /808|bas/i.test(candidate.name));
    expect(track, "test doc has an 808/bass instrument track").toBeDefined();
    const store = new ProjectStore(doc);
    const result = await executeMcpTool(makeCtx(store), "kyx_intent", { instruction: "add eq on the 808" });
    expect(result.isError).toBeFalsy();
    expect(result.mutated).toBe(true);
    expect(
      store.doc.tracks.find((candidate) => candidate.id === track!.id)!.effects.some((effect) => effect.type === "eq"),
    ).toBe(true);
  });
});
