import { describe, it, expect, beforeAll } from "vitest";
import { routeIntentText } from "../src/intent/route";
import { warmFactoryPresets } from "../src/presets/factory-loader";
import { applyPresetIntentCommand, parsePresetIntent, presetReadback } from "../src/intent/preset-intent";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { createInstrumentTrack, createDrumTrack } from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc } from "./fixtures/doc";
import { KOPA_FACTORY_PRESETS } from "../src/presets/kopa-factory";
import type { InstrumentTrack, ProjectDocument } from "../src/project-model/types";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

/**
 * DRUMS preset-intent family (KOPA plan §4.1, ADR 0035) — "load the trap
 * long preset on the drums" / "načítaj trap long preset na bicie".
 *
 * The family resolves to drum-role INSTRUMENT tracks (KOPA), never the drum
 * rack: exact/fader "drums" must keep meaning the rack ("mute the drums" must
 * not touch a KOPA track). Projects without a KOPA track fail loudly.
 */

beforeAll(async () => {
  await warmFactoryPresets();
});

function withKopa(extraDrumRack = false): ProjectDocument {
  const doc = testDoc();
  let next = doc;
  next = createInstrumentTrack(next, "kopa").execute(next);
  if (extraDrumRack) next = createDrumTrack(next).execute(next);
  return next;
}

const kopaTracks = (doc: ProjectDocument): InstrumentTrack[] =>
  doc.tracks.filter((track): track is InstrumentTrack => track.kind === "instrument" && track.instrument === "kopa");

describe("drums preset intent — parsing", () => {
  it("EN: 'load the trap long preset on the drums' resolves a KOPA preset with target drums", () => {
    const parsed = parsePresetIntent("load the trap long preset on the drums");
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok) {
      expect(parsed.intent.target).toBe("drums");
      expect(parsed.intent.preset.instrument).toBe("kopa");
      expect(parsed.intent.preset.name).toBe("Trap Long");
    }
  });

  it("SK: 'načítaj trap long preset na bicie' resolves the same family (deaccented)", () => {
    const parsed = parsePresetIntent("načítaj trap long preset na bicie");
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok) {
      expect(parsed.intent.target).toBe("drums");
      expect(parsed.intent.preset.name).toBe("Trap Long");
    }
  });

  it("SK: 'na kopu' also reaches the family (kopák → kopak)", () => {
    const parsed = parsePresetIntent("načítaj drill knock preset na kopu");
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok) {
      expect(parsed.intent.target).toBe("drums");
      expect(parsed.intent.preset.instrument).toBe("kopa");
    }
  });

  it("an unknown drums name answers with KOPA suggestions, not a silent miss", () => {
    const parsed = parsePresetIntent("load the zzzblorp preset on the drums");
    expect(parsed?.ok).toBe(false);
    if (parsed && !parsed.ok) {
      expect(parsed.suggestions.length).toBeGreaterThan(0);
      const kopaNames = new Set(KOPA_FACTORY_PRESETS.map((preset) => preset.name));
      for (const suggestion of parsed.suggestions) {
        expect(kopaNames.has(suggestion), `${suggestion} is not a KOPA preset`).toBe(true);
      }
    }
  });
});

describe("drums preset intent — application", () => {
  it("the fold lands the preset on the KOPA track only (drum rack untouched), one undo", () => {
    const store = new ProjectStore(withKopa(true));
    const rack = store.doc.tracks.find((track) => track.kind === "drum");
    const rackBefore = JSON.stringify(rack);
    const route = routeIntentText("load the trap long preset on the drums", store.doc);
    expect(route.kind).toBe("preset");
    if (route.kind !== "preset") throw new Error("expected preset route");
    store.execute(applyPresetIntentCommand(store.doc, route.intent));

    const kopas = kopaTracks(store.doc);
    expect(kopas).toHaveLength(1);
    expect(kopas[0]!.presetId).toBe(route.intent.preset.id);
    expect(store.undoStackLength).toBe(1);
    // The drum rack did NOT receive an instrument preset.
    const rackAfter = store.doc.tracks.find((track) => track.kind === "drum");
    expect(JSON.stringify(rackAfter)).toBe(rackBefore);

    store.undo();
    expect(kopaTracks(store.doc)[0]!.presetId ?? null).toBe(null);
  });

  it("every KOPA track gets the preset (family-wide fold, one snapshot)", () => {
    const store = new ProjectStore(withKopa());
    store.replaceDoc(createInstrumentTrack(store.doc, "kopa").execute(store.doc));
    const route = routeIntentText("load the techno punch preset on the drums", store.doc);
    if (route.kind !== "preset") throw new Error("expected preset route");
    store.execute(applyPresetIntentCommand(store.doc, route.intent));
    const kopas = kopaTracks(store.doc);
    expect(kopas).toHaveLength(2);
    for (const track of kopas) expect(track.presetId).toBe(route.intent.preset.id);
    expect(store.undoStackLength).toBe(1);
  });

  it("a project without a KOPA track fails loudly (never touches the drum rack)", () => {
    const doc = testDoc();
    const route = routeIntentText("load the trap long preset on the drums", doc);
    expect(route.kind).toBe("preset");
    if (route.kind !== "preset") throw new Error("expected preset route");
    expect(() => applyPresetIntentCommand(doc, route.intent)).toThrow(/no track matches the "drums" family/);
  });

  it("readback verifies the presetId landed on the KOPA track", () => {
    const doc = withKopa();
    const route = routeIntentText("load the house thump preset on the drums", doc);
    if (route.kind !== "preset") throw new Error("expected preset route");
    const after = applyPresetIntentCommand(doc, route.intent).execute(doc);
    expect(presetReadback(after, route.intent)).toContain("✓");
  });
});

describe("drums preset intent — exact ops stay on the drum rack", () => {
  it("resolveExactTargetTracks('drums') still means drum tracks only", async () => {
    const { resolveExactTargetTracks } = await import("../src/commands/intentRouting");
    const doc = withKopa(true);
    const ids = resolveExactTargetTracks(doc, "drums");
    const kinds = ids.map((id) => doc.tracks.find((track) => track.id === id)?.kind);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) expect(kind).toBe("drum");
  });

  it("mute the drums does not mute the KOPA track", async () => {
    const { parseExactIntent } = await import("../src/intent/exact");
    const { applyExactIntentCommand } = await import("../src/commands/intentRouting");
    const doc = withKopa(true);
    const parsed = parseExactIntent("mute the drums");
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error("expected exact parse");
    const after = applyExactIntentCommand(doc, parsed).execute(doc);
    expect(kopaTracks(after)[0]!.mute).toBe(false);
  });
});

describe("drums preset intent — MCP loadPreset family:drums", () => {
  function makeCtx(doc: ProjectDocument): McpToolContext {
    let current = doc;
    return withAgentWriter({
      getDoc: () => current,
      execute: (command) => {
        current = command.execute(current);
      },
      undo: () => undefined,
      redo: () => undefined,
      undoStackLength: () => 0,
      historyLabels: () => [],
      isMicRecordingActive: () => false,
      transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
    });
  }

  it("loadPreset family:'drums' lands a KOPA preset and reads back per track", async () => {
    const ctx = makeCtx(withKopa());
    const r = await executeMcpTool(ctx, "kyx_tracks", {
      op: "loadPreset",
      presetName: "Trap Long",
      family: "drums",
    });
    expect(r.mutated).toBe(true);
    expect(r.text).toContain("Trap Long");
    expect(r.text).toContain("✓");
    expect(kopaTracks(ctx.getDoc())[0]!.presetId).toContain("kopa");
  });

  it("loadPreset family:'drums' on a project without KOPA fails honestly (no mutation)", async () => {
    const doc = testDoc();
    const ctx = makeCtx(doc);
    const r = await executeMcpTool(ctx, "kyx_tracks", {
      op: "loadPreset",
      presetName: "Trap Long",
      family: "drums",
    });
    expect(r.mutated).toBe(false);
    expect(r.text).toMatch(/no track matches/);
  });

  it("listPresets family:'drums' lists KOPA presets fitting-first", async () => {
    const ctx = makeCtx(withKopa());
    const r = await executeMcpTool(ctx, "kyx_tracks", { op: "listPresets", family: "drums" });
    expect(r.text).toContain("Trap Long");
    expect(r.text).toContain("Techno Punch");
  });
});
