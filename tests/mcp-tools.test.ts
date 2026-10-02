import { describe, it, expect } from "vitest";
import { executeMcpTool, executeMcpToolAsync, MCP_TOOLS, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { addArrangementClip, addEffectToTracks, createScene, setSceneRole, snapshot } from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { inferPadRole } from "../src/ai/pad-roles";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * MCP TOOLS — headless verification against a real ProjectStore-backed
 * context. The GOLDEN RULE under test: every tool result is a verification
 * read-back of the resulting STATE (not a dispatch echo), mutations go
 * through the deterministic command layer, and failures are honest.
 */

function makeCtx(doc: ProjectDocument, options: { allowDestructive?: boolean } = {}): McpToolContext {
  let current = doc;
  // Mirrors the REAL ProjectStore stacks: undo pops the undo stack, redo
  // pops the redo stack AND pushes the undo stack back — so the stack length
  // moves on every successful step and stays put on a no-op (the kyx_undo
  // counting relies on exactly this contract).
  const undoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  const redoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  const labels: string[] = [];
  return {
    getDoc: () => current,
    execute: (command) => {
      const prev = current;
      current = command.execute(current);
      labels.push(command.label);
      undoStack.push({ undo: () => command.undo(prev), redo: () => command.execute(current) });
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
    historyLabels: () => [...labels],
    isMicRecordingActive: () => false,
    transport: {
      play: () => {},
      stop: () => {},
      pause: () => {},
      setLoop: () => {},
      setMetronome: () => {},
    },
    ...(options.allowDestructive ? { allowDestructive: () => true } : {}),
  };
}

/** Context whose mutations land in the REAL store (structured tests read
 * store.doc afterwards — the makeCtx holder would hide them). */
function storeCtx(store: ProjectStore, options: { allowDestructive?: boolean } = {}): McpToolContext {
  return {
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
  };
}

function datasetDoc(): ProjectDocument {
  useDeterministicIds();
  resetDeterministicIds();
  let doc = createProjectFromTemplate("house");
  doc = { ...doc, arrangement: { ...doc.arrangement, clips: [] }, markers: [] };
  doc = createScene(doc, "Intro").execute(doc);
  doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "intro").execute(doc);
  doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 0, 4).execute(doc);
  doc = createScene(doc, "Drop").execute(doc);
  doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "drop").execute(doc);
  doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 4, 4).execute(doc);
  return doc;
}

function withLead(): ProjectDocument {
  const doc = datasetDoc();
  const base = createProjectFromTemplate("house");
  const baseInstrument = base.tracks.find((t) => t.kind === "instrument")!;
  // instrument "pluck": family resolution (tracksInFamily) maps it to the
  // "lead" family, and unlike the type-only "lead" kind it EXISTS in
  // INSTRUMENT_META — normalize would heal an unknown kind to 808.
  const lead = { ...baseInstrument, id: "track-lead-x", name: "Lead", instrument: "pluck" as const };
  return { ...doc, tracks: [...doc.tracks, lead] };
}

describe("mcp tools — headless execution", async () => {
  it("tool surface: the 30 documented tools", async () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "kyx_intent",
      "kyx_state",
      "kyx_undo",
      "kyx_transport",
      "kyx_export",
      "kyx_generate",
      "kyx_groove",
      "kyx_fx",
      "kyx_sections",
      "kyx_markers",
      "kyx_tracks",
      "kyx_pattern",
      "kyx_steps",
      "kyx_notes",
      "kyx_music",
      "kyx_catalog",
      "kyx_plugin_param",
      "kyx_meter",
      "kyx_automation",
      "kyx_clips",
      "kyx_batch",
      "kyx_loudness",
      "kyx_publish_gallery",
      "kyx_render_summary",
      "kyx_checkpoint",
      "kyx_mix",
      "kyx_arrange",
      "kyx_song",
      "kyx_routing",
      "kyx_takes",
    ]);
  });

  it("kyx_intent 'mute the drums' mutes the drum track and reports the read-back", async () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    const result = await executeMcpTool(ctx, "kyx_intent", { instruction: "mute the drums" });
    expect(result.mutated).toBe(true);
    const drums = doc.tracks.find((t) => t.kind === "drum")!;
    const after = ctx.getDoc().tracks.find((t) => t.id === drums.id)!;
    expect(after.mute).toBe(true);
    expect(result.text).toContain("mute");
  });

  it("kyx_intent 'set tempo to 140' lands 140; kyx_state reads it back", async () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    await executeMcpTool(ctx, "kyx_intent", { instruction: "set tempo to 140" });
    expect(ctx.getDoc().bpm).toBe(140);
    const state = await executeMcpTool(ctx, "kyx_state", { subject: "tempo" });
    expect(state.text).toContain("140");
    expect(state.mutated).toBe(false);
  });

  it("kyx_intent generation asks are REFUSED honestly (no hallucinated beats over MCP)", async () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    const result = await executeMcpTool(ctx, "kyx_intent", { instruction: "dark techno at 140" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("inside the KYX app");
  });

  it("kyx_intent SK: 'zníž basu' lowers the bass family via the command layer", async () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    const before = ctx
      .getDoc()
      .tracks.find((t) => t.kind === "instrument" && ["bass", "808"].includes(t.instrument))!.gain;
    await executeMcpTool(ctx, "kyx_intent", { instruction: "zníž basu" });
    const after = ctx
      .getDoc()
      .tracks.find((t) => t.kind === "instrument" && ["bass", "808"].includes(t.instrument))!.gain;
    expect(after).toBeLessThan(before);
  });

  it("kyx_undo undoes one step and kyx_state confirms", async () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    await executeMcpTool(ctx, "kyx_intent", { instruction: "set tempo to 140" });
    expect(ctx.getDoc().bpm).toBe(140);
    const result = await executeMcpTool(ctx, "kyx_undo", { action: "undo", steps: 1 });
    expect(result.mutated).toBe(true);
    expect(ctx.getDoc().bpm).not.toBe(140);
  });

  it("unknown tool and unknown state subject are handled honestly", async () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    expect((await executeMcpTool(ctx, "nope", {})).text).toContain("unknown tool");
    expect((await executeMcpTool(ctx, "kyx_state", { subject: "quantum" })).text.length).toBeGreaterThan(0);
  });
});

// ─── STRUCTURED TOOLS — generate/groove/fx/sections/markers/tracks ──────────

describe("mcp structured tools", async () => {
  it("kyx_generate: deterministic pattern from a spec (same seed reproduces)", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_generate", { genre: "techno", seed: "gen-a", bpm: 132 });
    expect(store.doc.bpm).toBe(132);
    const firstName = store.doc.patterns[store.doc.patterns.length - 1].name;
    const firstRows = JSON.stringify(store.doc.patterns[store.doc.patterns.length - 1].rows);

    const store2 = new ProjectStore(datasetDoc());
    const ctx2 = storeCtx(store2);
    await executeMcpTool(ctx2, "kyx_generate", { genre: "techno", seed: "gen-a", bpm: 132 });
    const rows2 = JSON.stringify(store2.doc.patterns[store2.doc.patterns.length - 1].rows);
    expect(rows2).toBe(firstRows);
    expect(store2.doc.patterns[store2.doc.patterns.length - 1].name).toBe(firstName);
  });

  it("kyx_groove global set lands absolute swing (one undo)", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_groove", { direction: "set", percent: 60 });
    expect(store.doc.groove?.swing ?? 0).toBeCloseTo(0.6, 5);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.groove?.swing ?? 0).toBe(0);
  });

  it("kyx_fx more reverb on the lead adds the instance; remove deletes it (D4-gated)", async () => {
    const store = new ProjectStore(withLead());
    const locked = storeCtx(store);
    // more/less/knob ops are NOT destructive — allowed with the gate off
    await executeMcpTool(locked, "kyx_fx", { effect: "reverb", family: "lead", action: "more" });
    const withFx = store.doc.tracks.find((t) => t.kind === "instrument" && t.name === "Lead")!;
    expect(withFx.effects.some((fx) => fx.type === "reverb")).toBe(true);
    // remove IS destructive — locked without the user's allow flag
    const refusal = await executeMcpTool(locked, "kyx_fx", { effect: "reverb", family: "lead", action: "remove" });
    expect(refusal.mutated).toBe(false);
    expect(refusal.text).toContain("locked");
    expect(store.doc.tracks.find((t) => t.name === "Lead")!.effects.length).toBe(1);
    const allowed = storeCtx(store, { allowDestructive: true });
    await executeMcpTool(allowed, "kyx_fx", { effect: "reverb", family: "lead", action: "remove" });
    expect(store.doc.tracks.find((t) => t.name === "Lead")!.effects.length).toBe(0);
    expect(store.undoStackLength).toBe(2);
  });

  it("kyx_fx bypass FLAGS the instance (never deletes); enable clears the flag", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "lead", action: "more" });
    await executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "lead", action: "bypass" });
    const flagged = store.doc.tracks.find((t) => t.name === "Lead")!.effects.find((fx) => fx.type === "reverb")!;
    expect(flagged.bypassed).toBe(true); // instance still present
    const enabled = await executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "lead", action: "enable" });
    expect(enabled.mutated).toBe(true);
    expect(store.doc.tracks.find((t) => t.name === "Lead")!.effects.find((fx) => fx.type === "reverb")!.bypassed).toBe(
      false,
    );
  });

  it("kyx_fx failures are honest results (no target), never thrown", async () => {
    const store = new ProjectStore(datasetDoc()); // no vocal track
    const result = await executeMcpTool(storeCtx(store), "kyx_fx", { effect: "reverb", family: "vocal", action: "more" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("fx op failed");
  });

  it("kyx_sections add/remove named sections through the arrange layer", async () => {
    const store = new ProjectStore(datasetDoc());
    const scenesBefore = store.doc.scenes.length;
    await executeMcpTool(storeCtx(store), "kyx_sections", { op: "add", role: "build" });
    expect(store.doc.scenes.length).toBe(scenesBefore + 1);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.scenes.length).toBe(scenesBefore);
  });

  it("kyx_markers add/remove at 1-based bars", async () => {
    const store = new ProjectStore(datasetDoc());
    await executeMcpTool(storeCtx(store), "kyx_markers", { op: "add", bar: 9, name: "Outro" });
    expect(store.doc.markers).toHaveLength(1);
    expect(store.doc.markers[0].tick).toBe(8 * 4 * 480);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.markers).toHaveLength(0);
  });

  it("kyx_tracks addInstrument/remove round-trip", async () => {
    const store = new ProjectStore(datasetDoc());
    const before = store.doc.tracks.length;
    await executeMcpTool(storeCtx(store), "kyx_tracks", { op: "addInstrument", instrument: "808" });
    expect(store.doc.tracks.length).toBe(before + 1);
    store.undo();
    expect(store.doc.tracks.length).toBe(before);
  });
});

// ─── MODEL-DRIVABILITY WAVE — pattern select, structured steps, D4 gate ─────

/** The pad id whose inferred role matches the family (the tool uses the
 * same inference — tests must not assume kit layout). */
function padIdForFamily(doc: ProjectDocument, family: string): string | null {
  for (const track of doc.tracks) {
    if (track.kind !== "drum") continue;
    const found = track.pads.find((pad, index) => inferPadRole(pad.name, index) === family);
    if (found) return found.id;
  }
  return null;
}

describe("mcp model-drivability wave", async () => {
  it("kyx_steps add lands exact 16th steps in ONE undo step; remove/undo restores", async () => {
    const store = new ProjectStore(datasetDoc());
    const kickPad = padIdForFamily(store.doc, "kick");
    expect(kickPad).toBeTruthy();
    const originalStep0 = store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!.rows[kickPad!]?.[0] ?? 0;
    const ctx = storeCtx(store);
    const result = await executeMcpTool(ctx, "kyx_steps", {
      op: "add",
      family: "kick",
      steps: [1, 5],
      velocity: 0.9,
    });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("kick add");
    expect(result.text).toContain("one undo step");
    const pattern = store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!;
    expect(pattern.rows[kickPad!]?.[0]).toBeCloseTo(0.9, 5);
    expect(pattern.rows[kickPad!]?.[4]).toBeCloseTo(0.9, 5);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    const restored = store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!;
    expect(restored.rows[kickPad!]?.[0] ?? 0).toBe(originalStep0);
  });

  it("kyx_steps ghost lands soft velocity + 0.5 probability only on empty steps", async () => {
    const store = new ProjectStore(datasetDoc());
    const kickPad = padIdForFamily(store.doc, "kick")!;
    const pattern = store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!;
    const occupied = (pattern.rows[kickPad] ?? []).findIndex((v) => v > 0);
    // one occupied step + one guaranteed-empty step far away
    const emptyStep = pattern.stepCount - 1;
    const result = await executeMcpTool(storeCtx(store), "kyx_steps", {
      op: "ghost",
      family: "kick",
      steps: occupied >= 0 ? [occupied + 1, emptyStep + 1] : [emptyStep + 1],
    });
    expect(result.mutated).toBe(true);
    const after = store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!;
    expect(after.rows[kickPad]?.[emptyStep]).toBeCloseTo(0.35, 5);
    expect(after.stepMeta?.[kickPad]?.[emptyStep]?.probability).toBe(0.5);
    if (occupied >= 0) {
      // ghost must NOT overwrite the existing hit
      expect(after.rows[kickPad]?.[occupied]).toBe(pattern.rows[kickPad]?.[occupied]);
    }
  });

  it("kyx_steps clearPad empties the family; out-of-range steps are refused honestly", async () => {
    const store = new ProjectStore(datasetDoc());
    const kickPad = padIdForFamily(store.doc, "kick")!;
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_steps", { op: "add", family: "kick", steps: [1, 3, 5] });
    const cleared = await executeMcpTool(ctx, "kyx_steps", { op: "clearPad", family: "kick" });
    expect(cleared.mutated).toBe(true);
    const pattern = store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!;
    expect((pattern.rows[kickPad] ?? []).every((v) => v === 0)).toBe(true);

    const refused = await executeMcpTool(storeCtx(store), "kyx_steps", {
      op: "add",
      family: "kick",
      steps: [999],
    });
    expect(refused.mutated).toBe(false);
    expect(refused.text).toContain("no valid steps");
  });

  it("kyx_pattern lists and selects by 1-based index or name; unknown is honest", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const list = await executeMcpTool(ctx, "kyx_pattern", { op: "list" });
    expect(list.mutated).toBe(false);
    expect(list.text).toContain("ACTIVE");

    const already = await executeMcpTool(ctx, "kyx_pattern", { op: "select", pattern: "1" });
    expect(already.mutated).toBe(false);
    expect(already.text).toContain("already the active pattern");

    // a second pattern (generation) → select by 1-based index, then by name
    await executeMcpTool(ctx, "kyx_generate", { genre: "techno", seed: "second" });
    expect(store.doc.patterns.length).toBe(2);
    const select = await executeMcpTool(ctx, "kyx_pattern", { op: "select", pattern: "1" });
    expect(select.mutated).toBe(true);
    expect(store.doc.activePatternId).toBe(store.doc.patterns[0].id);
    const secondName = store.doc.patterns[1].name;
    const byName = await executeMcpTool(ctx, "kyx_pattern", { op: "select", pattern: secondName });
    expect(byName.mutated).toBe(true);
    expect(store.doc.activePatternId).toBe(store.doc.patterns[1].id);

    const missing = await executeMcpTool(ctx, "kyx_pattern", { op: "select", pattern: "quantum" });
    expect(missing.mutated).toBe(false);
    expect(missing.text).toContain('no pattern "quantum"');
  });

  it("kyx_state pattern/history/scenes subjects read the real state", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_steps", { op: "add", family: "kick", steps: [3] });
    const pattern = await executeMcpTool(ctx, "kyx_state", { subject: "pattern" });
    expect(pattern.text).toContain("active:");
    expect(pattern.text).toContain("kick:");
    // grid shows the 1-based step the tool just wrote
    expect(pattern.text).toContain("3");

    const history = await executeMcpTool(ctx, "kyx_state", { subject: "history" });
    expect(history.text).toContain("MCP steps");

    const scenes = await executeMcpTool(ctx, "kyx_state", { subject: "scenes" });
    expect(scenes.text).toContain("Intro");
    expect(scenes.text).toContain("intro");

    const overview = await executeMcpTool(ctx, "kyx_state", { subject: "overview" });
    expect(overview.text).toContain("active pattern:");
  });

  it("D4 gate: destructive ops refuse while locked, run once allowed", async () => {
    const doc = datasetDoc();
    const locked = makeCtx(doc);
    const refusal = await executeMcpTool(locked, "kyx_tracks", { op: "remove", family: "drums" });
    expect(refusal.mutated).toBe(false);
    expect(refusal.text).toContain("destructive MCP ops are locked");
    expect(doc.tracks.length).toBe(datasetDoc().tracks.length);

    const sectionRefusal = await executeMcpTool(locked, "kyx_sections", { op: "remove", role: "intro" });
    expect(sectionRefusal.text).toContain("locked");

    const allowed = storeCtx(new ProjectStore(datasetDoc()), { allowDestructive: true });
    const removed = await executeMcpTool(allowed, "kyx_tracks", { op: "remove", family: "drums" });
    expect(removed.mutated).toBe(true);
    expect(removed.text).toContain("removed");
  });

  it("kyx_generate honors bars (length) — 2 bars land 32 steps", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const result = await executeMcpTool(ctx, "kyx_generate", { genre: "techno", seed: "len", bars: 2 });
    expect(result.mutated).toBe(true);
    const pattern = store.doc.patterns[store.doc.patterns.length - 1];
    expect(pattern.stepCount).toBe(32);
    expect(result.text).toContain("2 bar");
  });
});

// ─── AUDIT REPAIRS — D4 gate reach, honest failures, atomicity, read-back ───

describe("mcp audit repairs", async () => {
  it("kyx_undo redo counts honestly: empty redo stack → ×0, never ×N", async () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    const result = await executeMcpTool(ctx, "kyx_undo", { action: "redo", steps: 5 });
    expect(result.text).toBe("redo ×0");
    expect(result.mutated).toBe(false);
  });

  it("kyx_undo undo stops at the stack bottom (1 entry, ask 5 → ×1)", async () => {
    const ctx = makeCtx(datasetDoc());
    await executeMcpTool(ctx, "kyx_intent", { instruction: "set tempo to 140" });
    const result = await executeMcpTool(ctx, "kyx_undo", { action: "undo", steps: 5 });
    expect(result.text).toBe("undo ×1");
  });

  it("D4 gate: intent PHRASING cannot bypass the destructive lock", async () => {
    const doc = datasetDoc();
    const locked = makeCtx(doc);
    const trackRefusal = await executeMcpTool(locked, "kyx_intent", { instruction: "delete the drums track" });
    expect(trackRefusal.mutated).toBe(false);
    expect(trackRefusal.text).toContain("locked");
    expect(locked.getDoc().tracks.length).toBe(datasetDoc().tracks.length);

    // FX-instance removal phrased naturally is equally gated
    const fxLocked = makeCtx(withLead());
    await executeMcpTool(fxLocked, "kyx_intent", { instruction: "more reverb on the lead" });
    const fxRefusal = await executeMcpTool(fxLocked, "kyx_intent", { instruction: "remove the reverb from the lead" });
    expect(fxRefusal.text).toContain("locked");
    expect(fxLocked.getDoc().tracks.some((t) => t.effects.some((fx) => fx.type === "reverb"))).toBe(true);
  });

  it("kyx_intent bare transport words dispatch to the transport", async () => {
    const doc = datasetDoc();
    const stopped: string[] = [];
    const ctx = makeCtx(doc);
    // reuse the ctx but observe the transport — rebuild with a recording stop
    const observing: McpToolContext = {
      ...ctx,
      transport: {
        play: () => {},
        stop: () => stopped.push("stop"),
        pause: () => {},
        setLoop: () => {},
        setMetronome: () => {},
      },
    };
    const result = await executeMcpTool(observing, "kyx_intent", { instruction: "stop" });
    expect(stopped).toEqual(["stop"]);
    expect(result.mutated).toBe(false);
  });

  it("kyx_intent queries read back without mutating", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const result = await executeMcpTool(ctx, "kyx_intent", { instruction: "what tempo" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("BPM");
    expect(store.undoStackLength).toBe(0);
  });

  it("kyx_intent undo counting is honest (2 asked, 1 available → ×1)", async () => {
    const ctx = makeCtx(datasetDoc());
    await executeMcpTool(ctx, "kyx_intent", { instruction: "set tempo to 140" });
    const result = await executeMcpTool(ctx, "kyx_intent", { instruction: "undo two steps" });
    expect(result.text).toBe("undo ×1");
    expect(result.mutated).toBe(true);
  });

  it("kyx_intent applier failures return honest text instead of throwing", async () => {
    const store = new ProjectStore(datasetDoc()); // no vocal track
    const result = await executeMcpTool(storeCtx(store), "kyx_intent", {
      instruction: "more reverb on the vocal",
    });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("intent failed");
  });

  it("kyx_tracks remove folds N deletions into ONE undo step", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store, { allowDestructive: true });
    await executeMcpTool(ctx, "kyx_tracks", { op: "addDrum" }); // → 2 drum tracks
    const drumCount = store.doc.tracks.filter((t) => t.kind === "drum").length;
    expect(drumCount).toBeGreaterThanOrEqual(2);
    const before = store.doc.tracks.length;

    const result = await executeMcpTool(ctx, "kyx_tracks", { op: "remove", family: "drums" });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("one undo step");
    expect(store.doc.tracks.length).toBe(before - drumCount);

    store.undo(); // ONE undo restores every removed drum track
    expect(store.doc.tracks.length).toBe(before);
  });

  it("kyx_state tracks includes mixer values (gain/pan/mute/solo) for read-after-write", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_intent", { instruction: "mute the drums" });
    const state = await executeMcpTool(ctx, "kyx_state", { subject: "tracks" });
    expect(state.text).toContain("gain");
    expect(state.text).toContain("pan");
    expect(state.text).toContain("muted");
  });

  it("kyx_transport loopOn PRESERVES the existing loop range", async () => {
    const loopCalls: Array<[boolean, number, number]> = [];
    const ctx = makeCtx(datasetDoc());
    const observing: McpToolContext = {
      ...ctx,
      transport: {
        play: () => {},
        stop: () => {},
        pause: () => {},
        setLoop: (enabled, start, end) => loopCalls.push([enabled, start, end]),
        setMetronome: () => {},
        loopStart: 1920,
        loopEnd: 7680,
      },
    };
    await executeMcpTool(observing, "kyx_transport", { action: "loopOn" });
    expect(loopCalls).toEqual([[true, 1920, 7680]]); // not the 0..4-bar reset
  });

  it("kyx_transport loopOn falls back to 4 bars when no loop exists", async () => {
    const loopCalls: Array<[boolean, number, number]> = [];
    const ctx = makeCtx(datasetDoc());
    const observing: McpToolContext = {
      ...ctx,
      transport: {
        play: () => {},
        stop: () => {},
        pause: () => {},
        setLoop: (enabled, start, end) => loopCalls.push([enabled, start, end]),
        setMetronome: () => {},
        loopStart: 0,
        loopEnd: 0,
      },
    };
    await executeMcpTool(observing, "kyx_transport", { action: "loopOn" });
    expect(loopCalls).toEqual([[true, 0, 4 * 4 * 480]]);
  });
});

// ─── P0 WAVE — catalog, plugin params, trackId addressing, meters ───────────

describe("mcp P0 wave — self-description + precision", async () => {
  it("kyx_catalog lists effects with knob markers; instruments list the kinds", async () => {
    const ctx = makeCtx(datasetDoc());
    const effects = await executeMcpTool(ctx, "kyx_catalog", { subject: "effects" });
    expect(effects.mutated).toBe(false);
    expect(effects.text).toContain("reverb — Reverb");
    expect(effects.text).toContain("[knob: mix]");
    expect(effects.text).toContain("eq");
    expect(effects.text).toContain("no single knob");

    const instruments = await executeMcpTool(ctx, "kyx_catalog", { subject: "instruments" });
    expect(instruments.text).toContain("808");
    expect(instruments.text).toContain("analog");
  });

  it("kyx_catalog subject:effect exposes the full param table (min/max/default/unit)", async () => {
    const ctx = makeCtx(datasetDoc());
    const reverb = await executeMcpTool(ctx, "kyx_catalog", { subject: "effect", effect: "reverb" });
    expect(reverb.text).toContain("primary knob (kyx_fx more/less): mix");
    expect(reverb.text).toMatch(/mix "MIX": 0 \.\. 1, default 0\.\d+/);

    const eq = await executeMcpTool(ctx, "kyx_catalog", { subject: "effect", effect: "eq" });
    expect(eq.text).toContain("no single primary knob");
    expect(eq.text).toContain("hpFreq");

    const unknown = await executeMcpTool(ctx, "kyx_catalog", { subject: "effect", effect: "quantum" });
    expect(unknown.mutated).toBe(false);
    expect(unknown.text).toContain('unknown effect "quantum"');
  });

  it("kyx_plugin_param set lands an absolute native value with read-back (one undo)", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "lead", action: "more" });
    const result = await executeMcpTool(ctx, "kyx_plugin_param", {
      op: "set",
      family: "lead",
      effect: "reverb",
      param: "mix",
      value: 0.42,
    });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("mix 0.");
    expect(result.text).toContain("→ 0.42");
    expect(result.text).toContain("one undo step");
    const lead = store.doc.tracks.find((t) => t.name === "Lead")!;
    expect(lead.effects.find((fx) => fx.type === "reverb")!.params.mix).toBeCloseTo(0.42, 5);
    store.undo();
    expect(store.undoStackLength).toBe(1); // the kyx_fx more
  });

  it("kyx_plugin_param set clamps honestly and refuses unknown params/instances", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "lead", action: "more" });

    const clamped = await executeMcpTool(ctx, "kyx_plugin_param", {
      op: "set",
      family: "lead",
      effect: "reverb",
      param: "mix",
      value: 42, // way out of 0..1
    });
    expect(clamped.mutated).toBe(true);
    expect(clamped.text).toContain("clamped to 0..1");
    expect(store.doc.tracks.find((t) => t.name === "Lead")!.effects[0].params.mix).toBe(1);

    const unknownParam = await executeMcpTool(ctx, "kyx_plugin_param", {
      op: "set",
      family: "lead",
      effect: "reverb",
      param: "quantum",
      value: 1,
    });
    expect(unknownParam.mutated).toBe(false);
    expect(unknownParam.text).toContain('unknown param "quantum"');
    expect(unknownParam.text).toContain("parameters:");

    const missingInstance = await executeMcpTool(ctx, "kyx_plugin_param", {
      op: "set",
      family: "lead",
      effect: "delay",
      param: "mix",
      value: 0.5,
    });
    expect(missingInstance.mutated).toBe(false);
    expect(missingInstance.text).toContain("no delay instance");

    await executeMcpTool(ctx, "kyx_fx", { effect: "delay", family: "lead", action: "more" });
    const missingSecond = await executeMcpTool(ctx, "kyx_plugin_param", {
      op: "set",
      family: "lead",
      effect: "delay",
      instance: 2,
      param: "mix",
      value: 0.5,
    });
    expect(missingSecond.mutated).toBe(false);
    expect(missingSecond.text).toContain("instance #2 does not exist");
  });

  it("kyx_plugin_param list reads current chain values; NaN value refused", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "lead", action: "more" });
    const list = await executeMcpTool(ctx, "kyx_plugin_param", { op: "list", family: "lead" });
    expect(list.mutated).toBe(false);
    expect(list.text).toContain("reverb#1");
    expect(list.text).toMatch(/mix=\d/);

    const nan = await executeMcpTool(ctx, "kyx_plugin_param", {
      op: "set",
      family: "lead",
      effect: "reverb",
      param: "mix",
      value: "not-a-number",
    });
    expect(nan.mutated).toBe(false);
    expect(nan.text).toContain("finite number");
  });

  it("trackId addressing: kyx_fx and kyx_plugin_param hit ONE exact track", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    const state = await executeMcpTool(ctx, "kyx_state", { subject: "tracks" });
    expect(state.text).toMatch(/id=track-lead-x/); // ids in read-back

    const result = await executeMcpTool(ctx, "kyx_fx", {
      effect: "delay",
      action: "more",
      trackId: "track-lead-x",
    });
    expect(result.mutated).toBe(true);
    expect(store.doc.tracks.find((t) => t.id === "track-lead-x")!.effects.some((fx) => fx.type === "delay")).toBe(true);

    const param = await executeMcpTool(ctx, "kyx_plugin_param", {
      op: "set",
      trackId: "track-lead-x",
      effect: "delay",
      param: "mix",
      value: 0.3,
    });
    expect(param.mutated).toBe(true);

    const missing = await executeMcpTool(ctx, "kyx_fx", { effect: "delay", action: "more", trackId: "t-quantum" });
    expect(missing.mutated).toBe(false);
    expect(missing.text).toContain("fx op failed");
  });

  it("kyx_tracks remove/rename honor trackId; groups are refused honestly", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store, { allowDestructive: true });
    const renamed = await executeMcpTool(ctx, "kyx_tracks", { op: "rename", trackId: "track-lead-x", name: "Syn Lead" });
    expect(renamed.mutated).toBe(true);
    expect(store.doc.tracks.find((t) => t.id === "track-lead-x")!.name).toBe("Syn Lead");

    const removed = await executeMcpTool(ctx, "kyx_tracks", { op: "remove", trackId: "track-lead-x" });
    expect(removed.mutated).toBe(true);
    expect(store.doc.tracks.some((t) => t.id === "track-lead-x")).toBe(false);
    store.undo();
    expect(store.doc.tracks.some((t) => t.id === "track-lead-x")).toBe(true);

    // a group track is not addressable by kyx_tracks
    const doc = store.doc;
    const group = doc.tracks.find((t) => t.kind === "group");
    if (group) {
      const refused = await executeMcpTool(ctx, "kyx_tracks", { op: "remove", trackId: group.id });
      expect(refused.mutated).toBe(false);
      expect(refused.text).toContain("group tracks are not addressable");
    }
  });

  it("kyx_fx refuses knob-less effects honestly (eq never had a primary knob)", async () => {
    const store = new ProjectStore(datasetDoc());
    const result = await executeMcpTool(storeCtx(store), "kyx_fx", { effect: "eq", family: "drums", action: "more" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("no single primary knob");
    expect(result.text).toContain("kyx_plugin_param");
  });

  it("kyx_meter honestly refuses without a hook and reads a live snapshot", async () => {
    const store = new ProjectStore(datasetDoc());
    const bare = await executeMcpTool(storeCtx(store), "kyx_meter", {});
    expect(bare.mutated).toBe(false);
    expect(bare.text).toContain("not available");

    const dead: McpToolContext = { ...storeCtx(store), meters: () => null };
    const deadResult = await executeMcpTool(dead, "kyx_meter", {});
    expect(deadResult.text).toContain("engine is not running");

    const ctx: McpToolContext = {
      ...storeCtx(store),
      meters: () => ({
        master: {
          truePeakDb: -0.5,
          rmsDb: -14.2,
          lufsMomentary: -15.1,
          lufsShortTerm: -15.4,
          lufsIntegrated: -16.0,
          correlation: 0.87,
          clipping: false,
        },
        tracks: [{ id: "t1", name: "Drums", peakDb: 0.4, rmsDb: -10.1, clipping: true }],
      }),
    };
    const all = await executeMcpTool(ctx, "kyx_meter", {});
    expect(all.mutated).toBe(false);
    expect(all.text).toContain("truePeak -0.5 dBFS");
    expect(all.text).toContain("LUFS-M -15.1");
    expect(all.text).not.toContain("true peak ≥ 0 dBFS"); // master NOT clipping in this fixture
    expect(all.text).toContain("Drums (id=t1)");
    expect(all.text).toContain("⚠ CLIPPING"); // the clipping track is flagged

    const fixture = ctx.meters!();
    const hot: McpToolContext = {
      ...ctx,
      meters: () => ({
        master: { ...fixture!.master, truePeakDb: 0.6, clipping: true },
        tracks: [],
      }),
    };
    const hotResult = await executeMcpTool(hot, "kyx_meter", { scope: "master" });
    expect(hotResult.text).toContain("⚠ CLIPPING (true peak ≥ 0 dBFS)");

    const masterOnly = await executeMcpTool(ctx, "kyx_meter", { scope: "master" });
    expect(masterOnly.text).toContain("master:");
    expect(masterOnly.text).not.toContain("Drums (id=t1)");
  });
});

// ─── P1 WAVE — transport reads, seek, loop region ───────────────────────────

describe("mcp P1 transport — reads + seek + loop region", async () => {
  /** A transport fake carrying the FULL live-read surface. */
  function fullTransport(overrides: Partial<McpToolContext["transport"]> = {}): McpToolContext["transport"] {
    return {
      play: () => {},
      stop: () => {},
      pause: () => {},
      setLoop: () => {},
      setMetronome: () => {},
      position: 2 * 1920 + 480, // bar 3, beat 2
      playing: true,
      paused: false,
      loopEnabled: true,
      loopStart: 1920,
      loopEnd: 7680,
      metronome: false,
      seek: () => {},
      ...overrides,
    };
  }

  it("kyx_transport state reads position/playing/loop/metronome read-only", async () => {
    const ctx = makeCtx(datasetDoc());
    const observing: McpToolContext = { ...ctx, transport: fullTransport() };
    const result = await executeMcpTool(observing, "kyx_transport", { action: "state" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("position bar 3 beat 2 (tick 4320)");
    expect(result.text).toContain("playing");
    expect(result.text).toContain("loop on (bars 2–4)");
    expect(result.text).toContain("metronome off");
  });

  it("kyx_transport state degrades honestly on a bare fake (no read accessors)", async () => {
    const ctx = makeCtx(datasetDoc()); // minimal transport fake
    const result = await executeMcpTool(ctx, "kyx_transport", { action: "state" });
    expect(result.mutated).toBe(false);
    expect(result.text).toBe("position unknown"); // the complete honest output
  });

  it("kyx_transport seek jumps by 1-based bar (+ optional beat) and reports the landing", async () => {
    const seeks: number[] = [];
    const ctx = makeCtx(datasetDoc());
    const observing: McpToolContext = {
      ...ctx,
      transport: fullTransport({ seek: (tick) => seeks.push(tick), playing: false }),
    };
    const result = await executeMcpTool(observing, "kyx_transport", { action: "seek", bar: 5 });
    expect(seeks).toEqual([4 * 1920]);
    expect(result.text).toContain("seek → bar 5 (tick 7680)");

    const withBeat = await executeMcpTool(observing, "kyx_transport", { action: "seek", bar: 2, beat: 3 });
    expect(seeks).toEqual([4 * 1920, 1920 + 2 * 480]);
    expect(withBeat.text).toContain("bar 2 beat 3");
    expect(withBeat.text).toContain("stopped");
  });

  it("kyx_transport seek validates input and refuses without a seek-capable transport", async () => {
    const ctx = makeCtx(datasetDoc());
    const missing = await executeMcpTool(ctx, "kyx_transport", { action: "seek", bar: 5 });
    expect(missing.mutated).toBe(false);
    expect(missing.text).toContain("seek is not available");

    const full = makeCtx(datasetDoc());
    const observing: McpToolContext = { ...full, transport: fullTransport() };
    for (const bad of [{}, { bar: 0 }, { bar: -3 }, { bar: "quantum" }]) {
      const refused = await executeMcpTool(observing, "kyx_transport", { action: "seek", ...bad });
      expect(refused.mutated).toBe(false);
      expect(refused.text).toContain("1-based bar");
    }
  });

  it("kyx_transport loopRegion sets the loop by inclusive 1-based bars", async () => {
    const loopCalls: Array<[boolean, number, number]> = [];
    let loop: [number, number] = [1920, 7680];
    const ctx = makeCtx(datasetDoc());
    const observing: McpToolContext = {
      ...ctx,
      transport: {
        ...fullTransport(),
        get loopStart() {
          return loop[0];
        },
        get loopEnd() {
          return loop[1];
        },
        setLoop: (enabled, start, end) => {
          loopCalls.push([enabled, start, end]);
          loop = [start, end];
        },
      },
    };
    const result = await executeMcpTool(observing, "kyx_transport", { action: "loopRegion", startBar: 5, endBar: 9 });
    expect(result.mutated).toBe(false);
    expect(loopCalls).toEqual([[true, 4 * 1920, 9 * 1920]]);
    expect(result.text).toContain("loop region: bars 5–9");
    expect(result.text).toContain("loop on (bars 5–9)");

    for (const bad of [{}, { startBar: 3 }, { startBar: 5, endBar: 5 }, { startBar: 9, endBar: 5 }]) {
      const refused = await executeMcpTool(observing, "kyx_transport", { action: "loopRegion", ...bad });
      expect(refused.mutated).toBe(false);
      expect(refused.text).toContain("loopRegion needs");
    }
  });

  it("base transport actions end their read-back with the resulting state (verify-by-read)", async () => {
    const ctx = makeCtx(datasetDoc());
    const observing: McpToolContext = { ...ctx, transport: fullTransport() };
    const result = await executeMcpTool(observing, "kyx_transport", { action: "metronomeOn" });
    expect(result.text).toMatch(/^transport: metronomeOn · /);
    expect(result.text).toContain("position bar 3 beat 2");
  });

  it("loop-end-of-content semantics: loopEnd <= start reads as 'to end of content'", async () => {
    const ctx = makeCtx(datasetDoc());
    const observing: McpToolContext = {
      ...ctx,
      transport: fullTransport({ loopStart: 1920, loopEnd: 0 }),
    };
    const result = await executeMcpTool(observing, "kyx_transport", { action: "state" });
    expect(result.text).toContain("loop on (to end of content)");
  });
});

// ─── P1 WAVE — send-level reads (kyx_state sends) ───────────────────────────

describe("mcp P1 sends — the read half of the send routing", async () => {
  it("kyx_state sends lists returns (id/gain/fx) and per-track send levels", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const result = await executeMcpTool(ctx, "kyx_state", { subject: "sends" });
    expect(result.mutated).toBe(false);
    // default returns with their faders + fx
    expect(result.text).toMatch(/returns: Reverb \(id=return-[\w-]+, gain 0\.90, fx: reverb\)/);
    expect(result.text).toContain("Delay");
    expect(result.text).toContain("NY Comp");
    // every track maps into every return, zeros included (a "send X" loop
    // must see the 0 it is about to raise)
    expect(result.text).toMatch(/Drums \(id=[\w-]+\): Reverb 0 · Delay 0 · NY Comp 0/);
  });

  it("send round-trip: NL send intent lands, kyx_state sends verifies the level", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_intent", { instruction: "more reverb send on the lead" });
    const result = await executeMcpTool(ctx, "kyx_state", { subject: "sends", family: "lead" });
    // the send the intent raised is visible with its landed value
    expect(result.text).toMatch(/Lead \(id=track-lead-x\): Reverb 0\.1/);
    // write-side family resolution: "lead" = the Lead track only (no drums)
    expect(result.text).not.toContain("Drums (id=");
    // family "bass" resolves through the instrument kind to the 808 track
    const bass = await executeMcpTool(ctx, "kyx_state", { subject: "sends", family: "bass" });
    expect(bass.text).toContain("808 (id=");
    expect(bass.text).not.toContain("Lead (id=");
  });

  it("sends read includes group tracks (routing state, not just mixer members)", async () => {
    const doc = datasetDoc();
    const group = doc.tracks.find((t) => t.kind === "group");
    if (!group) return; // template without a group — nothing to pin
    const store = new ProjectStore(doc);
    const result = await executeMcpTool(storeCtx(store), "kyx_state", { subject: "sends" });
    expect(result.text).toContain(`${group.name} (id=${group.id}):`);
  });

  it("a project without returns reads honestly", async () => {
    const doc = datasetDoc();
    const bare = { ...doc, returns: [] };
    const result = await executeMcpTool(makeCtx(bare), "kyx_state", { subject: "sends" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("returns: none");
    expect(result.text).toContain("no send buses");
  });

  it("unfiltered reads past 8 tracks carry a truncation note", async () => {
    const doc = datasetDoc();
    const base = doc.tracks.find((t) => t.kind === "instrument")!;
    const extra = Array.from({ length: 8 }, (_, i) => ({ ...base, id: `track-x-${i}`, name: `Pad ${i}` }));
    const fat = { ...doc, tracks: [...doc.tracks, ...extra] };
    const result = await executeMcpTool(makeCtx(fat), "kyx_state", { subject: "sends" });
    expect(result.text).toContain("more track(s) (filter with family)");
  });
});

// ─── P1 WAVE — automation surface (kyx_automation + subject:automation) ─────

describe("mcp P1 automation — lanes, points, FX targeting", async () => {
  it("addPoint creates the lane on demand and lands the clamped native value (one undo)", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    const result = await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId: "track-lead-x",
      param: "gain",
      bar: 5,
      beat: 3,
      value: 0.4,
    });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("Lead · Volume");
    expect(result.text).toContain("5.3=0.4");
    expect(result.text).toContain("one undo step");
    const lead = store.doc.tracks.find((t) => t.id === "track-lead-x")!;
    const lane = store.doc.automation.find((l) => l.target.kind === "trackGain" && l.target.trackId === lead.id)!;
    expect(lane.points).toEqual([{ tick: 4 * 1920 + 2 * 480, value: 0.4 }]);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.automation).toHaveLength(0);
  });

  it("addPoint on an FX parameter targets the typed instance and clamps out-of-range", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "lead", action: "more" });
    const landed = await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId: "track-lead-x",
      effect: "reverb",
      param: "decay",
      bar: 2,
      value: 999,
    });
    expect(landed.mutated).toBe(true);
    expect(landed.text).toContain("Lead · reverb · decay");
    expect(landed.text).toContain("clamped into 0.1..20");
    const lane = store.doc.automation.find((l) => l.target.kind === "fxParam")!;
    expect(lane.points[0].value).toBe(20);
    expect(lane.target.fxId).toBe(store.doc.tracks.find((t) => t.id === "track-lead-x")!.effects[0].id);
  });

  it("kyx_state subject:automation reads lanes back with points and ranges", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_automation", { op: "addPoint", trackId: "track-lead-x", param: "gain", bar: 1, value: 1 });
    await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId: "track-lead-x",
      param: "gain",
      bar: 9,
      value: 0.5,
    });
    const read = await executeMcpTool(ctx, "kyx_state", { subject: "automation" });
    expect(read.mutated).toBe(false);
    expect(read.text).toMatch(/1\. Lead · Volume \(lane [\w-]+\) — 2 pts, range 0\.\.1\.5: 1\.1=1, 9\.1=0\.5/);

    const filtered = await executeMcpTool(ctx, "kyx_state", { subject: "automation", family: "bass" });
    expect(filtered.text).toContain("no automation lanes match family");

    // write-side family resolution: the 808 lane passes the "bass" filter
    const doc = store.doc;
    const bass808 = doc.tracks.find((t) => t.kind === "instrument" && t.instrument === "808");
    if (bass808) {
      await executeMcpTool(ctx, "kyx_automation", { op: "addPoint", trackId: bass808.id, param: "gain", bar: 2, value: 0.9 });
      const bassLanes = await executeMcpTool(ctx, "kyx_state", { subject: "automation", family: "bass" });
      expect(bassLanes.text).toContain(`${bass808.name} · Volume`);
      expect(bassLanes.text).not.toContain("Lead · Volume");
      // pad families still reach the drum track
      await executeMcpTool(ctx, "kyx_automation", { op: "addPoint", family: "drums", param: "gain", bar: 2, value: 0.9 });
      const kitLanes = await executeMcpTool(ctx, "kyx_state", { subject: "automation", family: "kick" });
      expect(kitLanes.text).toContain("Drums · Volume");
    }
  });

  it("deletePoint removes the point nearest the anchor bar", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId: "track-lead-x",
      param: "gain",
      bar: 3,
      value: 0.7,
    });
    await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId: "track-lead-x",
      param: "gain",
      bar: 8,
      value: 0.3,
    });
    const removed = await executeMcpTool(ctx, "kyx_automation", {
      op: "deletePoint",
      trackId: "track-lead-x",
      param: "gain",
      bar: 8,
    });
    expect(removed.mutated).toBe(true);
    expect(removed.text).toContain("removed point 8.1=0.3");
    const lane = store.doc.automation[0];
    expect(lane.points).toHaveLength(1);
    expect(lane.points[0].tick).toBe(2 * 1920);
  });

  it("deletePoint honestly refuses when no point is within a bar", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId: "track-lead-x",
      param: "gain",
      bar: 3,
      value: 0.7,
    });
    const far = await executeMcpTool(ctx, "kyx_automation", {
      op: "deletePoint",
      trackId: "track-lead-x",
      param: "gain",
      bar: 12,
    });
    expect(far.mutated).toBe(false);
    expect(far.text).toContain("no automation point within a bar");
  });

  it("clearLane and removeLane are D4-gated and work once allowed", async () => {
    const store = new ProjectStore(withLead());
    const locked = storeCtx(store);
    await executeMcpTool(storeCtx(store), "kyx_automation", {
      op: "addPoint",
      trackId: "track-lead-x",
      param: "gain",
      bar: 3,
      value: 0.7,
    });

    const clearRefused = await executeMcpTool(locked, "kyx_automation", {
      op: "clearLane",
      trackId: "track-lead-x",
      param: "gain",
    });
    expect(clearRefused.text).toContain("locked");
    const removeRefused = await executeMcpTool(locked, "kyx_automation", {
      op: "removeLane",
      trackId: "track-lead-x",
      param: "gain",
    });
    expect(removeRefused.text).toContain("locked");
    expect(store.doc.automation[0].points).toHaveLength(1);

    const allowed = storeCtx(store, { allowDestructive: true });
    const cleared = await executeMcpTool(allowed, "kyx_automation", {
      op: "clearLane",
      trackId: "track-lead-x",
      param: "gain",
    });
    expect(cleared.mutated).toBe(true);
    expect(cleared.text).toContain("cleared 1 point(s)");
    expect(store.doc.automation).toHaveLength(1); // lane survives, points gone
    expect(store.doc.automation[0].points).toHaveLength(0);

    const removed = await executeMcpTool(allowed, "kyx_automation", {
      op: "removeLane",
      trackId: "track-lead-x",
      param: "gain",
    });
    expect(removed.mutated).toBe(true);
    expect(store.doc.automation).toHaveLength(0);
  });

  it("honest failures: missing instance, unknown track, bad param, missing bar/value", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    const noInstance = await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId: "track-lead-x",
      effect: "chorus",
      param: "mix",
      bar: 1,
      value: 0.5,
    });
    expect(noInstance.mutated).toBe(false);
    expect(noInstance.text).toContain("no chorus instance");

    const badTrack = await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId: "t-quantum",
      param: "gain",
      bar: 1,
      value: 1,
    });
    expect(badTrack.text).toContain('no track or return with id "t-quantum"');

    const badParam = await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId: "track-lead-x",
      param: "quantum",
      bar: 1,
      value: 1,
    });
    expect(badParam.text).toContain("param must be 'gain' or 'pan'");

    const noBar = await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId: "track-lead-x",
      param: "gain",
      value: 1,
    });
    expect(noBar.text).toContain("1-based bar is required");

    const noValue = await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId: "track-lead-x",
      param: "gain",
      bar: 1,
    });
    expect(noValue.text).toContain("finite NATIVE value");
    expect(noValue.text).toContain("0..1.5");
  });

  it("pan lanes validate −1..1 via the shared target validation", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    const result = await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId: "track-lead-x",
      param: "pan",
      bar: 4,
      value: -3,
    });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("Lead · Pan");
    expect(result.text).toContain("clamped into -1..1");
    const lane = store.doc.automation.find((l) => l.target.kind === "trackPan")!;
    expect(lane.points[0].value).toBe(-1);
  });
});

// ─── P1 WAVE — mixer setters, clips, awaited export ─────────────────────────

describe("mcp P1 mixer — absolute setters with verify-by-read", async () => {
  it("setGain via gainDb lands the linear value and reports dB", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    const result = await executeMcpTool(ctx, "kyx_tracks", { op: "setGain", trackId: "track-lead-x", gainDb: -6 });
    expect(result.mutated).toBe(true);
    expect(result.text).toMatch(/Lead: gain 0\.501 \(-6\.0 dB\)/);
    const lead = store.doc.tracks.find((t) => t.id === "track-lead-x")!;
    expect(lead.gain).toBeCloseTo(10 ** (-6 / 20), 3);
  });

  it("setGain accepts linear gain and clamps out-of-range", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_tracks", { op: "setGain", trackId: "track-lead-x", gain: 42 });
    const lead = store.doc.tracks.find((t) => t.id === "track-lead-x")!;
    expect(lead.gain).toBe(1.5); // 20·log10(1.5) ≈ +3.5 dB ceiling

    const refused = await executeMcpTool(ctx, "kyx_tracks", { op: "setGain", trackId: "track-lead-x" });
    expect(refused.mutated).toBe(false);
    expect(refused.text).toContain("setGain needs gainDb");
  });

  it("setPan/setMute/setSolo land and read back; family applies to all matches", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const pan = await executeMcpTool(ctx, "kyx_tracks", { op: "setPan", family: "drums", pan: 0.5 });
    expect(pan.text).toMatch(/Drums: pan 0\.50 \(R\)/);
    const mute = await executeMcpTool(ctx, "kyx_tracks", { op: "setMute", family: "drums", value: true });
    expect(mute.text).toContain("Drums: mute on");
    expect(store.doc.tracks.find((t) => t.kind === "drum")!.mute).toBe(true);
    const solo = await executeMcpTool(ctx, "kyx_tracks", { op: "setSolo", trackId: store.doc.tracks[1].id, value: true });
    expect(solo.text).toContain("solo on");

    const badPan = await executeMcpTool(ctx, "kyx_tracks", { op: "setPan", family: "drums" });
    expect(badPan.mutated).toBe(false);
    expect(badPan.text).toContain("setPan needs pan");
  });

  it("a set that changes nothing reports honestly (mutated=false)", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const result = await executeMcpTool(ctx, "kyx_tracks", { op: "setMute", family: "drums", value: false });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("nothing changed");
  });
});

describe("mcp P1 clips — structured arrangement edits", async () => {
  it("list shows sorted clips with scene names and the audio summary", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const result = await executeMcpTool(ctx, "kyx_clips", { op: "list" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain('"Intro" bars 1–4');
    expect(result.text).toContain('"Drop" bars 5–8');
  });

  it("move/resize/duplicate address the clip covering the anchor bar", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const moved = await executeMcpTool(ctx, "kyx_clips", { op: "move", bar: 6, toBar: 12 });
    expect(moved.mutated).toBe(true);
    expect(moved.text).toContain('moved "Drop" bars 5–8 → starts at bar 12');
    const clip = store.doc.arrangement.clips.find((c) => c.startBar === 11)!;
    expect(clip).toBeTruthy();

    const resized = await executeMcpTool(ctx, "kyx_clips", { op: "resize", bar: 12, bars: 8 });
    expect(resized.mutated).toBe(true);
    expect(store.doc.arrangement.clips.find((c) => c.startBar === 11)!.lengthBars).toBe(8);

    const duplicated = await executeMcpTool(ctx, "kyx_clips", { op: "duplicate", bar: 12 });
    expect(duplicated.mutated).toBe(true);
    expect(store.doc.arrangement.clips).toHaveLength(3);
  });

  it("delete is D4-gated; honest failures for missing clip and bad args", async () => {
    const store = new ProjectStore(datasetDoc());
    const locked = storeCtx(store);
    const refused = await executeMcpTool(locked, "kyx_clips", { op: "delete", bar: 6 });
    expect(refused.text).toContain("locked");

    const allowed = storeCtx(new ProjectStore(datasetDoc()), { allowDestructive: true });
    const removed = await executeMcpTool(allowed, "kyx_clips", { op: "delete", bar: 6 });
    expect(removed.mutated).toBe(true);
    expect(removed.text).toContain('deleted "Drop" bars 5–8');

    const noClip = await executeMcpTool(storeCtx(new ProjectStore(datasetDoc())), "kyx_clips", {
      op: "move",
      bar: 50,
      toBar: 2,
    });
    expect(noClip.mutated).toBe(false);
    expect(noClip.text).toContain("no arrangement clip covers bar 50");

    const noArgs = await executeMcpTool(storeCtx(new ProjectStore(datasetDoc())), "kyx_clips", { op: "move", bar: 6 });
    expect(noArgs.text).toContain("move needs toBar");
  });
});

describe("mcp P1 export — the awaited completion report", async () => {
  it("executeMcpToolAsync awaits the export hook and returns the report", async () => {
    const ctx = makeCtx(datasetDoc());
    const observing: McpToolContext = {
      ...ctx,
      export: async (request) => `fake-export-${request.format} (12.3s, 2.05 MB)`,
    };
    const result = await executeMcpToolAsync(observing, "kyx_export", { format: "wav" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("export WAV complete — fake-export-wav (12.3s, 2.05 MB)");

    const mp3 = await executeMcpToolAsync(observing, "kyx_export", { format: "mp3" });
    expect(mp3.text).toContain("export MP3 complete");
  });

  it("export failures surface as honest isError results", async () => {
    const ctx = makeCtx(datasetDoc());
    const failing: McpToolContext = {
      ...ctx,
      export: async () => {
        throw new Error("no audio context");
      },
    };
    const result = await executeMcpToolAsync(failing, "kyx_export", { format: "wav" });
    expect(result.mutated).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("export failed: no audio context");

    const bare = await executeMcpToolAsync(makeCtx(datasetDoc()), "kyx_export", { format: "wav" });
    expect(bare.text).toContain("not available");
  });

  it("non-export tools flow through the async wrapper unchanged", async () => {
    const ctx = makeCtx(datasetDoc());
    const result = await executeMcpToolAsync(ctx, "kyx_intent", { instruction: "set tempo to 141" });
    expect(result.mutated).toBe(true);
    expect(ctx.getDoc().bpm).toBe(141);
  });
});

// ─── RESOURCES (MCP capability) — passive reads over the hidden channel ─────

describe("mcp resources", async () => {
  it("the five kyx://project/* resources read live state without mutating", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    for (const uri of [
      "kyx://project/overview",
      "kyx://project/pattern",
      "kyx://project/mix",
      "kyx://project/arrangement",
      "kyx://project/history",
    ]) {
      const result = await executeMcpTool(ctx, "__kyx_resource", { uri });
      expect(result.mutated).toBe(false);
      expect(result.isError).toBeUndefined();
      expect(result.text.length).toBeGreaterThan(0);
    }
    expect((await executeMcpTool(ctx, "__kyx_resource", { uri: "kyx://project/overview" })).text).toContain("BPM");
    expect((await executeMcpTool(ctx, "__kyx_resource", { uri: "kyx://project/arrangement" })).text).toContain("markers:");
  });

  it("an unknown resource is an honest isError; the channel is hidden from MCP_TOOLS", async () => {
    const ctx = makeCtx(datasetDoc());
    const missing = await executeMcpTool(ctx, "__kyx_resource", { uri: "kyx://nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("unknown resource");
    expect(MCP_TOOLS.map((tool) => tool.name)).not.toContain("__kyx_resource");
  });
});

// ─── P2 WAVE — batch, envelopes, movePoint, audio clips, loudness ───────────

describe("mcp P2 batch — transactional multi-call", async () => {
  function framedCtx(store: ProjectStore, options: { allowDestructive?: boolean } = {}): McpToolContext {
    const ctx = storeCtx(store, options);
    return {
      ...ctx,
      beginUndoFrame: (label) => store.beginUndoFrame(label),
      endUndoFrame: () => store.endUndoFrame(),
    };
  }

  it("folds all mutations into ONE undo entry when frames are supported", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = framedCtx(store);
    const result = await executeMcpTool(ctx, "kyx_batch", {
      calls: [
        { tool: "kyx_intent", args: { instruction: "set tempo to 130" } },
        { tool: "kyx_tracks", args: { op: "setPan", family: "drums", pan: 0.4 } },
        { tool: "kyx_groove", args: { direction: "set", percent: 55 } },
      ],
    });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("ONE undo step for the whole batch");
    expect(store.doc.bpm).toBe(130);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.bpm).not.toBe(130);
    const drums = store.doc.tracks.find((t) => t.kind === "drum")!;
    expect(drums.pan).toBe(0);
  });

  it("per-call failures never abort the batch; summary reports what landed", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = framedCtx(store);
    const result = await executeMcpTool(ctx, "kyx_batch", {
      calls: [
        { tool: "kyx_intent", args: { instruction: "set tempo to 132" } },
        { tool: "kyx_fx", args: { effect: "reverb", family: "vocal", action: "more" } },
        { tool: "kyx_tracks", args: { op: "setMute", family: "drums", value: true } },
      ],
    });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("3 call(s): 2 mutated, 1 failed");
    expect(store.doc.bpm).toBe(132);
    expect(store.doc.tracks.find((t) => t.kind === "drum")!.mute).toBe(true);
    const data = result.data as { results: Array<{ text: string }>; failures: number };
    expect(data.failures).toBe(1);
    expect(data.results[1].text).toContain("fx op failed");
  });

  it("without frame support it degrades honestly (per-call undo steps)", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const result = await executeMcpTool(ctx, "kyx_batch", {
      calls: [
        { tool: "kyx_intent", args: { instruction: "set tempo to 135" } },
        { tool: "kyx_intent", args: { instruction: "mute the drums" } },
      ],
    });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("no undo-frame support");
    expect(store.undoStackLength).toBe(2);
  });

  it("refuses async tools inside the batch and oversized batches", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = framedCtx(store);
    const withAsync = await executeMcpTool(ctx, "kyx_batch", {
      calls: [
        { tool: "kyx_intent", args: { instruction: "set tempo to 140" } },
        { tool: "kyx_export", args: { format: "wav" } },
        { tool: "kyx_loudness", args: { op: "measure" } },
      ],
    });
    expect(withAsync.text).toContain("runs standalone");

    const oversized = await executeMcpTool(ctx, "kyx_batch", {
      calls: Array.from({ length: 11 }, (_, i) => ({
        tool: "kyx_intent",
        args: { instruction: `set tempo to ${100 + i}` },
      })),
    });
    expect(oversized.mutated).toBe(false);
    expect(oversized.text).toContain("capped at 10");
  });
});

describe("mcp P2 envelopes — machine-readable results", async () => {
  it("kyx_transport state carries the structured position/loop data", async () => {
    const ctx = makeCtx(datasetDoc());
    const observing: McpToolContext = {
      ...ctx,
      transport: {
        play: () => {},
        stop: () => {},
        pause: () => {},
        setLoop: () => {},
        setMetronome: () => {},
        position: 2 * 1920 + 480,
        playing: true,
        paused: false,
        loopEnabled: true,
        loopStart: 1920,
        loopEnd: 7680,
        metronome: false,
      },
    };
    const result = await executeMcpTool(observing, "kyx_transport", { action: "state" });
    const data = result.data as {
      bar: number;
      beat: number;
      playing: boolean;
      loop: { startBar: number; endBar: number };
    };
    expect(data.bar).toBe(3);
    expect(data.beat).toBe(2);
    expect(data.playing).toBe(true);
    expect(data.loop.startBar).toBe(2);
    expect(data.loop.endBar).toBe(4);
  });

  it("kyx_meter passes the live snapshot through as data", async () => {
    const store = new ProjectStore(datasetDoc());
    const snapshot = {
      master: {
        truePeakDb: -1,
        rmsDb: -12,
        lufsMomentary: -14,
        lufsShortTerm: -14.2,
        lufsIntegrated: -15,
        correlation: 0.9,
        clipping: false,
      },
      tracks: [{ id: "t1", name: "Drums", peakDb: -3, rmsDb: -11, clipping: false }],
    };
    const ctx: McpToolContext = { ...storeCtx(store), meters: () => snapshot };
    const result = await executeMcpTool(ctx, "kyx_meter", {});
    expect(result.data).toEqual(snapshot);
  });

  it("kyx_clips list carries structured clip ids/bars", async () => {
    const store = new ProjectStore(datasetDoc());
    const result = await executeMcpTool(storeCtx(store), "kyx_clips", { op: "list" });
    const data = result.data as {
      arrangementClips: Array<{ scene: string; startBar: number; lengthBars: number }>;
      audioClipCount: number;
    };
    expect(data.arrangementClips).toHaveLength(2);
    expect(data.arrangementClips[0]).toMatchObject({ scene: "Intro", startBar: 1, lengthBars: 4 });
  });
});

describe("mcp P2 automation movePoint", async () => {
  it("moves the nearest point by bar/beat and reports the landing", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId: "track-lead-x",
      param: "gain",
      bar: 3,
      value: 0.9,
    });
    const moved = await executeMcpTool(ctx, "kyx_automation", {
      op: "movePoint",
      trackId: "track-lead-x",
      param: "gain",
      bar: 3,
      newBar: 7,
      newBeat: 3,
    });
    expect(moved.mutated).toBe(true);
    expect(moved.text).toContain("3.1=0.9 → 7.3=0.9");
    const lane = store.doc.automation[0];
    expect(lane.points).toEqual([{ tick: 6 * 1920 + 2 * 480, value: 0.9 }]);
  });

  it("moves value-only and clamps honestly", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_automation", {
      op: "addPoint",
      trackId: "track-lead-x",
      param: "gain",
      bar: 2,
      value: 0.5,
    });
    const moved = await executeMcpTool(ctx, "kyx_automation", {
      op: "movePoint",
      trackId: "track-lead-x",
      param: "gain",
      bar: 2,
      value: 99,
    });
    expect(moved.mutated).toBe(true);
    expect(moved.text).toContain("value clamped into range");
    expect(store.doc.automation[0].points[0].value).toBe(1.5);
  });
});

describe("mcp P2 audio clips — structured track-lane edits", async () => {
  function withAudioClip(): ProjectDocument {
    const doc = datasetDoc();
    const drum = doc.tracks.find((t) => t.kind === "drum")!;
    const clip = {
      id: "audio-clip-1",
      trackId: drum.id,
      bufferId: "factory.kick.main",
      startBar: 0,
      lengthBars: 4,
      offsetSec: 0,
      trimStart: 0,
      trimEnd: 0,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      stretchRate: 1,
      reverse: false,
    };
    return { ...doc, arrangement: { ...doc.arrangement, audioClips: [clip] } } as ProjectDocument;
  }

  it("audioList details every track-lane clip with ids and values", async () => {
    const result = await executeMcpTool(makeCtx(withAudioClip()), "kyx_clips", { op: "audioList" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("Drums (id=audio-clip-1): bars 1–4 · gain 1.00");
    const data = result.data as { clips: Array<{ id: string; gain: number }> };
    expect(data.clips[0].id).toBe("audio-clip-1");
  });

  it("audioUpdate lands gain/fades on the clip covering the anchor bar", async () => {
    const doc = withAudioClip();
    const ctx = makeCtx(doc);
    const result = await executeMcpTool(ctx, "kyx_clips", {
      op: "audioUpdate",
      family: "drums",
      bar: 2,
      gain: 0.8,
      fadeIn: 0.05,
      fadeOut: 0.2,
    });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("gain 0.8, fadeIn 0.05, fadeOut 0.2");
    const clip = ctx.getDoc().arrangement.audioClips![0];
    expect(clip.gain).toBe(0.8);
    expect(clip.fadeIn).toBe(0.05);
  });

  it("audioSplit cuts the clip at the anchor bar; audioMove relocates", async () => {
    const doc = withAudioClip();
    const ctx = makeCtx(doc);
    const split = await executeMcpTool(ctx, "kyx_clips", { op: "audioSplit", family: "drums", bar: 3 });
    expect(split.mutated).toBe(true);
    expect(ctx.getDoc().arrangement.audioClips).toHaveLength(2);

    const moved = await executeMcpTool(ctx, "kyx_clips", { op: "audioMove", family: "drums", bar: 1, toBar: 9 });
    expect(moved.mutated).toBe(true);
    expect(ctx.getDoc().arrangement.audioClips!.some((c) => c.startBar === 8)).toBe(true);
  });

  it("audioDelete is D4-gated; honest failures for missing clips and bad args", async () => {
    const locked = makeCtx(withAudioClip());
    const refused = await executeMcpTool(locked, "kyx_clips", { op: "audioDelete", family: "drums", bar: 2 });
    expect(refused.text).toContain("locked");

    const noClip = await executeMcpTool(makeCtx(withAudioClip()), "kyx_clips", {
      op: "audioUpdate",
      family: "bass",
      bar: 2,
      gain: 1,
    });
    expect(noClip.mutated).toBe(false);
    expect(noClip.text).toContain("no audio clip on 808 covers bar 2");

    const noPatch = await executeMcpTool(makeCtx(withAudioClip()), "kyx_clips", {
      op: "audioUpdate",
      family: "drums",
      bar: 2,
    });
    expect(noPatch.text).toContain("needs at least one of");
  });
});

describe("mcp P2 loudness — the render-backed loop", async () => {
  it("measure reads integrated LUFS; match runs the loop through ctx.execute", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const observing: McpToolContext = {
      ...ctx,
      measureLoudness: async () => ({ integrated: -16.2, measured: true }),
      applyLoudness: async ({ targetDb }) => ({
        ok: true as const,
        command: snapshot("loudnessTest", "Loudness trim", store.doc, {
          ...store.doc,
          master: { ...store.doc.master, loudnessTrimDb: -1.5 },
        }),
        report: { measuredBefore: -16.2, measuredAfter: targetDb ?? -14, trim: -1.5, target: targetDb ?? -14 },
      }),
    };
    const measured = await executeMcpToolAsync(observing, "kyx_loudness", { op: "measure" });
    expect(measured.mutated).toBe(false);
    expect(measured.text).toContain("-16.2 LUFS");
    expect((measured.data as { integratedLufs: number }).integratedLufs).toBe(-16.2);

    const matched = await executeMcpToolAsync(observing, "kyx_loudness", { op: "match", targetDb: -14 });
    expect(matched.mutated).toBe(true);
    expect(matched.text).toContain("-16.2 → -14 LUFS (trim -1.5 dB");
    expect(store.doc.master.loudnessTrimDb).toBe(-1.5);
  });

  it("honest refusals without hooks and honest failures from the loop", async () => {
    const bare = await executeMcpToolAsync(storeCtx(new ProjectStore(datasetDoc())), "kyx_loudness", { op: "measure" });
    expect(bare.text).toContain("not available");

    const failing: McpToolContext = {
      ...storeCtx(new ProjectStore(datasetDoc())),
      applyLoudness: async () => ({
        ok: false as const,
        error: "could not measure loudness — the render was too quiet or empty",
      }),
    };
    const failed = await executeMcpToolAsync(failing, "kyx_loudness", { op: "match", direction: "louder" });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("too quiet");
  });
});

// ─── MODEL-LEVEL WAVE — routing, takes, per-instance FX + reorder ───────────

describe("mcp routing — the group graph", async () => {
  it("list maps every track to its destination with a structured envelope", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const result = await executeMcpTool(ctx, "kyx_routing", { op: "list" });
    expect(result.mutated).toBe(false);
    expect(result.text).toMatch(/Drums \(id=[\w-]+\) → master/);
    expect(result.text).toContain("returns (send buses → master)");
    const data = result.data as {
      routes: Array<{ track: string; destination: string }>;
      groups: Array<{ name: string }>;
    };
    expect(data.routes.length).toBe(store.doc.tracks.filter((t) => t.kind !== "group").length);
  });

  it("createGroup (with name) + addToGroup + removeFromGroup round-trip in one undo each", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const created = await executeMcpTool(ctx, "kyx_routing", { op: "createGroup", name: "Drum Bus" });
    expect(created.mutated).toBe(true);
    expect(created.text).toContain('created group "Drum Bus"');
    const group = store.doc.tracks.find((t) => t.kind === "group" && t.name === "Drum Bus")!;
    expect(group).toBeTruthy();

    const added = await executeMcpTool(ctx, "kyx_routing", { op: "addToGroup", family: "drums", groupName: "Drum Bus" });
    expect(added.mutated).toBe(true);
    expect(added.text).toContain("Drums → Drum Bus");
    const drums = store.doc.tracks.find((t) => t.kind === "drum")!;
    expect(drums.groupId).toBe(group.id);

    const listed = await executeMcpTool(ctx, "kyx_routing", { op: "list" });
    expect(listed.text).toContain(`group Drum Bus (id=${group.id}): 1 member(s) — Drums`);

    const removed = await executeMcpTool(ctx, "kyx_routing", { op: "removeFromGroup", family: "drums" });
    expect(removed.mutated).toBe(true);
    expect(store.doc.tracks.find((t) => t.kind === "drum")!.groupId).toBeUndefined();
  });

  it("honest failures: unknown group, unknown group name, track not in a group", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const noGroup = await executeMcpTool(ctx, "kyx_routing", { op: "addToGroup", family: "drums", groupName: "Quantum" });
    expect(noGroup.mutated).toBe(false);
    expect(noGroup.text).toContain("target group not found");

    const notInGroup = await executeMcpTool(ctx, "kyx_routing", { op: "removeFromGroup", family: "drums" });
    expect(notInGroup.mutated).toBe(false);
    expect(notInGroup.text).toContain("nothing changed");
  });
});

describe("mcp takes — the comp workflow", async () => {
  function withTakes(): ProjectDocument {
    const doc = datasetDoc();
    const drum = doc.tracks.find((t) => t.kind === "drum")!;
    const mkClip = (id: string, takeId: string) => ({
      id,
      trackId: drum.id,
      bufferId: `buf-${takeId}`,
      takeGroupId: "tg-1",
      takeId,
      startBar: 0,
      lengthBars: 4,
      offsetSec: 0,
      trimStart: 0,
      trimEnd: 0,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      stretchRate: 1,
      reverse: false,
    });
    return {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        audioClips: [mkClip("ac-t1", "take-1"), mkClip("ac-t2", "take-2")],
        takeGroups: [{ id: "tg-1", trackId: drum.id, activeTakeId: "take-1" }],
      },
    } as ProjectDocument;
  }

  it("list shows the active take and the alternatives with a structured envelope", async () => {
    const result = await executeMcpTool(makeCtx(withTakes()), "kyx_takes", { op: "list" });
    expect(result.mutated).toBe(false);
    expect(result.text).toMatch(
      /Drums \(group id=tg-1\): ACTIVE take take-1 · take take-1 ×1 clip\(s\), take take-2 ×1 clip\(s\)/,
    );
    const data = result.data as { groups: Array<{ id: string; activeTakeId: string; takes: Record<string, number> }> };
    expect(data.groups[0].activeTakeId).toBe("take-1");
    expect(data.groups[0].takes["take-2"]).toBe(1);
  });

  it("activate is the comp pick — reversible, validated, honest on no-ops", async () => {
    const doc = withTakes();
    const ctx = makeCtx(doc);
    const activated = await executeMcpTool(ctx, "kyx_takes", { op: "activate", groupId: "tg-1", takeId: "take-2" });
    expect(activated.mutated).toBe(true);
    expect(activated.text).toContain("take take-2 is now ACTIVE");
    expect(ctx.getDoc().arrangement.takeGroups![0].activeTakeId).toBe("take-2");
    ctx.undo();
    expect(ctx.getDoc().arrangement.takeGroups![0].activeTakeId).toBe("take-1");

    const already = await executeMcpTool(ctx, "kyx_takes", { op: "activate", groupId: "tg-1", takeId: "take-1" });
    expect(already.mutated).toBe(false);
    expect(already.text).toContain("already the active comp");

    const unknown = await executeMcpTool(ctx, "kyx_takes", { op: "activate", groupId: "tg-1", takeId: "take-quantum" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("take op failed");
  });

  it("deleteTake (D4) removes an inactive take's clips; the ACTIVE take is protected", async () => {
    const locked = makeCtx(withTakes());
    const gateRefusal = await executeMcpTool(locked, "kyx_takes", { op: "deleteTake", groupId: "tg-1", takeId: "take-2" });
    expect(gateRefusal.text).toContain("locked");

    const doc = withTakes();
    const ctx = makeCtx(doc, { allowDestructive: true });
    const activeRefusal = await executeMcpTool(ctx, "kyx_takes", { op: "deleteTake", groupId: "tg-1", takeId: "take-1" });
    expect(activeRefusal.isError).toBe(true);
    expect(activeRefusal.text).toContain("ACTIVE comp");

    await executeMcpTool(ctx, "kyx_takes", { op: "deleteTake", groupId: "tg-1", takeId: "take-2" });
    expect(ctx.getDoc().arrangement.audioClips!.some((clip) => clip.takeId === "take-2")).toBe(false);
    expect(ctx.getDoc().arrangement.takeGroups).toHaveLength(1);
  });

  it("prunes the group when the deleted take was the last one", async () => {
    const doc = withTakes();
    const ctx = makeCtx(doc, { allowDestructive: true });
    await executeMcpTool(ctx, "kyx_takes", { op: "activate", groupId: "tg-1", takeId: "take-2" });
    await executeMcpTool(ctx, "kyx_takes", { op: "deleteTake", groupId: "tg-1", takeId: "take-1" });
    expect(ctx.getDoc().arrangement.audioClips!.filter((clip) => clip.takeGroupId === "tg-1")).toHaveLength(1);
    expect(ctx.getDoc().arrangement.takeGroups).toHaveLength(1);
  });
});

describe("mcp fx instances — per-instance ops + chain reorder", async () => {
  it("instance scopes remove to ONE instance; without it all are removed", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store, { allowDestructive: true });
    await executeMcpTool(ctx, "kyx_fx", { effect: "delay", family: "lead", action: "more" });
    store.execute(addEffectToTracks(store.doc, ["track-lead-x"], "delay")); // a second instance
    await executeMcpTool(ctx, "kyx_plugin_param", {
      op: "set",
      trackId: "track-lead-x",
      effect: "delay",
      instance: 2,
      param: "mix",
      value: 0.9,
    });
    expect(
      store.doc.tracks.find((t) => t.id === "track-lead-x")!.effects.filter((fx) => fx.type === "delay"),
    ).toHaveLength(2);

    const one = await executeMcpTool(ctx, "kyx_fx", { action: "remove", effect: "delay", family: "lead", instance: 1 });
    expect(one.mutated).toBe(true);
    expect(one.text).toContain("removed delay#1");
    const afterOne = store.doc.tracks.find((t) => t.id === "track-lead-x")!;
    expect(afterOne.effects.filter((fx) => fx.type === "delay")).toHaveLength(1);
    expect(afterOne.effects.find((fx) => fx.type === "delay")!.params.mix).toBeCloseTo(0.9, 2); // instance #2 survived

    await executeMcpTool(ctx, "kyx_fx", { action: "remove", effect: "delay", family: "lead" });
    expect(
      store.doc.tracks.find((t) => t.id === "track-lead-x")!.effects.filter((fx) => fx.type === "delay"),
    ).toHaveLength(0);
  });

  it("instance scopes bypass/enable; already-matching state is an honest no-op", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "lead", action: "more" });
    store.execute(addEffectToTracks(store.doc, ["track-lead-x"], "reverb"));
    const bypassed = await executeMcpTool(ctx, "kyx_fx", { action: "bypass", effect: "reverb", family: "lead", instance: 1 });
    expect(bypassed.mutated).toBe(true);
    expect(bypassed.text).toContain("reverb#1 bypassed");
    expect(store.doc.tracks.find((t) => t.id === "track-lead-x")!.effects[0].bypassed).toBe(true);

    const again = await executeMcpTool(ctx, "kyx_fx", { action: "bypass", effect: "reverb", family: "lead", instance: 1 });
    expect(again.mutated).toBe(false);
    expect(again.text).toContain("already bypassed");

    const enabled = await executeMcpTool(ctx, "kyx_fx", { action: "enable", effect: "reverb", family: "lead", instance: 1 });
    expect(enabled.mutated).toBe(true);
    expect(store.doc.tracks.find((t) => t.id === "track-lead-x")!.effects[0].bypassed).toBe(false);
  });

  it("reorder moves an instance by direction and by absolute position", async () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "lead", action: "more" });
    await executeMcpTool(ctx, "kyx_fx", { effect: "delay", family: "lead", action: "more" });
    const earlier = await executeMcpTool(ctx, "kyx_fx", {
      action: "reorder",
      effect: "delay",
      family: "lead",
      direction: "earlier",
    });
    expect(earlier.mutated).toBe(true);
    expect(store.doc.tracks.find((t) => t.id === "track-lead-x")!.effects.map((fx) => fx.type)).toEqual([
      "delay",
      "reverb",
    ]);

    const positioned = await executeMcpTool(ctx, "kyx_fx", {
      action: "reorder",
      effect: "reverb",
      family: "lead",
      position: 1,
    });
    expect(positioned.mutated).toBe(true);
    expect(store.doc.tracks.find((t) => t.id === "track-lead-x")!.effects.map((fx) => fx.type)).toEqual([
      "reverb",
      "delay",
    ]);

    const missing = await executeMcpTool(ctx, "kyx_fx", {
      action: "reorder",
      effect: "chorus",
      family: "lead",
      direction: "later",
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("no chorus instance");
  });
});

// ─── FINISHING WAVE — export options, send buses, take delete, marker rename ─

describe("mcp finishing — export render options", async () => {
  it("the async executor passes sampleRate/bitDepth/stems through the request", async () => {
    const ctx = makeCtx(datasetDoc());
    const seen: Array<Record<string, unknown>> = [];
    const observing: McpToolContext = {
      ...ctx,
      export: async (request) => {
        seen.push(request as unknown as Record<string, unknown>);
        return "done";
      },
    };
    await executeMcpToolAsync(observing, "kyx_export", { format: "wav", sampleRate: 48000, bitDepth: 24 });
    expect(seen[0]).toEqual({ format: "wav", sampleRate: 48000, bitDepth: 24 });

    await executeMcpToolAsync(observing, "kyx_export", { format: "wav", stems: "all" });
    expect(seen[1]).toEqual({ format: "wav", stems: "all" });

    await executeMcpToolAsync(observing, "kyx_export", { format: "mp3", stems: "quantum", sampleRate: 123 });
    expect(seen[2]).toEqual({ format: "mp3" });
  });
});

describe("mcp finishing — send buses over kyx_routing", async () => {
  it("createReturn + setSend + setReturnGain land real values with read-backs", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const created = await executeMcpTool(ctx, "kyx_routing", { op: "createReturn", name: "Plate" });
    expect(created.mutated).toBe(true);
    expect(created.text).toContain('created return bus "Plate"');
    const plate = store.doc.returns.find((r) => r.name === "Plate")!;
    expect(plate).toBeTruthy();

    const send = await executeMcpTool(ctx, "kyx_routing", {
      op: "setSend",
      family: "drums",
      returnName: "Plate",
      level: 0.6,
    });
    expect(send.mutated).toBe(true);
    expect(send.text).toMatch(/Drums → Plate 0\.6/);
    const drums = store.doc.tracks.find((t) => t.kind === "drum")!;
    expect(drums.sends[plate.id]).toBe(0.6);

    const gain = await executeMcpTool(ctx, "kyx_routing", { op: "setReturnGain", returnName: "Plate", gain: 1.2 });
    expect(gain.mutated).toBe(true);
    expect(store.doc.returns.find((r) => r.name === "Plate")!.gain).toBe(1.2);
  });

  it("clamps and reports honestly", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const noLevel = await executeMcpTool(ctx, "kyx_routing", { op: "setSend", family: "drums", returnName: "Reverb" });
    expect(noLevel.mutated).toBe(false);
    expect(noLevel.text).toContain("setSend needs level");

    const badReturn = await executeMcpTool(ctx, "kyx_routing", { op: "setReturnGain", returnName: "Quantum", gain: 1 });
    expect(badReturn.mutated).toBe(false);
    expect(badReturn.text).toContain("no return bus matches");
  });
});

describe("mcp finishing — marker rename", async () => {
  it("renames the marker nearest the anchor bar", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_markers", { op: "add", bar: 5, name: "Old Name" });
    const renamed = await executeMcpTool(ctx, "kyx_markers", { op: "rename", bar: 5, name: "Drop Start" });
    expect(renamed.mutated).toBe(true);
    expect(renamed.text).toContain('renamed marker "Old Name" → "Drop Start"');
    expect(store.doc.markers[0].name).toBe("Drop Start");

    const noName = await executeMcpTool(ctx, "kyx_markers", { op: "rename", bar: 5 });
    expect(noName.mutated).toBe(false);
    expect(noName.text).toContain("rename needs a name");
  });
});
