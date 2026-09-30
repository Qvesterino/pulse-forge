import { describe, it, expect } from "vitest";
import { executeMcpTool, MCP_TOOLS, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { addArrangementClip, createScene, setSceneRole } from "../src/commands/commands";
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
  const lead = { ...baseInstrument, id: "track-lead-x", name: "Lead" };
  return { ...doc, tracks: [...doc.tracks, lead] };
}

describe("mcp tools — headless execution", () => {
  it("tool surface: the 13 documented tools", () => {
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
      "kyx_catalog",
      "kyx_plugin_param",
      "kyx_meter",
    ]);
  });

  it("kyx_intent 'mute the drums' mutes the drum track and reports the read-back", () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    const result = executeMcpTool(ctx, "kyx_intent", { instruction: "mute the drums" });
    expect(result.mutated).toBe(true);
    const drums = doc.tracks.find((t) => t.kind === "drum")!;
    const after = ctx.getDoc().tracks.find((t) => t.id === drums.id)!;
    expect(after.mute).toBe(true);
    expect(result.text).toContain("mute");
  });

  it("kyx_intent 'set tempo to 140' lands 140; kyx_state reads it back", () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    executeMcpTool(ctx, "kyx_intent", { instruction: "set tempo to 140" });
    expect(ctx.getDoc().bpm).toBe(140);
    const state = executeMcpTool(ctx, "kyx_state", { subject: "tempo" });
    expect(state.text).toContain("140");
    expect(state.mutated).toBe(false);
  });

  it("kyx_intent generation asks are REFUSED honestly (no hallucinated beats over MCP)", () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    const result = executeMcpTool(ctx, "kyx_intent", { instruction: "dark techno at 140" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("inside the KYX app");
  });

  it("kyx_intent SK: 'zníž basu' lowers the bass family via the command layer", () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    const before = ctx
      .getDoc()
      .tracks.find((t) => t.kind === "instrument" && ["bass", "808"].includes(t.instrument))!.gain;
    executeMcpTool(ctx, "kyx_intent", { instruction: "zníž basu" });
    const after = ctx
      .getDoc()
      .tracks.find((t) => t.kind === "instrument" && ["bass", "808"].includes(t.instrument))!.gain;
    expect(after).toBeLessThan(before);
  });

  it("kyx_undo undoes one step and kyx_state confirms", () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    executeMcpTool(ctx, "kyx_intent", { instruction: "set tempo to 140" });
    expect(ctx.getDoc().bpm).toBe(140);
    const result = executeMcpTool(ctx, "kyx_undo", { action: "undo", steps: 1 });
    expect(result.mutated).toBe(true);
    expect(ctx.getDoc().bpm).not.toBe(140);
  });

  it("unknown tool and unknown state subject are handled honestly", () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    expect(executeMcpTool(ctx, "nope", {}).text).toContain("unknown tool");
    expect(executeMcpTool(ctx, "kyx_state", { subject: "quantum" }).text.length).toBeGreaterThan(0);
  });
});

// ─── STRUCTURED TOOLS — generate/groove/fx/sections/markers/tracks ──────────

describe("mcp structured tools", () => {
  it("kyx_generate: deterministic pattern from a spec (same seed reproduces)", () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    executeMcpTool(ctx, "kyx_generate", { genre: "techno", seed: "gen-a", bpm: 132 });
    expect(store.doc.bpm).toBe(132);
    const firstName = store.doc.patterns[store.doc.patterns.length - 1].name;
    const firstRows = JSON.stringify(store.doc.patterns[store.doc.patterns.length - 1].rows);

    const store2 = new ProjectStore(datasetDoc());
    const ctx2 = storeCtx(store2);
    executeMcpTool(ctx2, "kyx_generate", { genre: "techno", seed: "gen-a", bpm: 132 });
    const rows2 = JSON.stringify(store2.doc.patterns[store2.doc.patterns.length - 1].rows);
    expect(rows2).toBe(firstRows);
    expect(store2.doc.patterns[store2.doc.patterns.length - 1].name).toBe(firstName);
  });

  it("kyx_groove global set lands absolute swing (one undo)", () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    executeMcpTool(ctx, "kyx_groove", { direction: "set", percent: 60 });
    expect(store.doc.groove?.swing ?? 0).toBeCloseTo(0.6, 5);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.groove?.swing ?? 0).toBe(0);
  });

  it("kyx_fx more reverb on the lead adds the instance; remove deletes it (D4-gated)", () => {
    const store = new ProjectStore(withLead());
    const locked = storeCtx(store);
    // more/less/knob ops are NOT destructive — allowed with the gate off
    executeMcpTool(locked, "kyx_fx", { effect: "reverb", family: "lead", action: "more" });
    const withFx = store.doc.tracks.find((t) => t.kind === "instrument" && t.name === "Lead")!;
    expect(withFx.effects.some((fx) => fx.type === "reverb")).toBe(true);
    // remove IS destructive — locked without the user's allow flag
    const refusal = executeMcpTool(locked, "kyx_fx", { effect: "reverb", family: "lead", action: "remove" });
    expect(refusal.mutated).toBe(false);
    expect(refusal.text).toContain("locked");
    expect(store.doc.tracks.find((t) => t.name === "Lead")!.effects.length).toBe(1);
    const allowed = storeCtx(store, { allowDestructive: true });
    executeMcpTool(allowed, "kyx_fx", { effect: "reverb", family: "lead", action: "remove" });
    expect(store.doc.tracks.find((t) => t.name === "Lead")!.effects.length).toBe(0);
    expect(store.undoStackLength).toBe(2);
  });

  it("kyx_fx bypass FLAGS the instance (never deletes); enable clears the flag", () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "lead", action: "more" });
    executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "lead", action: "bypass" });
    const flagged = store.doc.tracks.find((t) => t.name === "Lead")!.effects.find((fx) => fx.type === "reverb")!;
    expect(flagged.bypassed).toBe(true); // instance still present
    const enabled = executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "lead", action: "enable" });
    expect(enabled.mutated).toBe(true);
    expect(store.doc.tracks.find((t) => t.name === "Lead")!.effects.find((fx) => fx.type === "reverb")!.bypassed).toBe(
      false,
    );
  });

  it("kyx_fx failures are honest results (no target), never thrown", () => {
    const store = new ProjectStore(datasetDoc()); // no vocal track
    const result = executeMcpTool(storeCtx(store), "kyx_fx", { effect: "reverb", family: "vocal", action: "more" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("fx op failed");
  });

  it("kyx_sections add/remove named sections through the arrange layer", () => {
    const store = new ProjectStore(datasetDoc());
    const scenesBefore = store.doc.scenes.length;
    executeMcpTool(storeCtx(store), "kyx_sections", { op: "add", role: "build" });
    expect(store.doc.scenes.length).toBe(scenesBefore + 1);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.scenes.length).toBe(scenesBefore);
  });

  it("kyx_markers add/remove at 1-based bars", () => {
    const store = new ProjectStore(datasetDoc());
    executeMcpTool(storeCtx(store), "kyx_markers", { op: "add", bar: 9, name: "Outro" });
    expect(store.doc.markers).toHaveLength(1);
    expect(store.doc.markers[0].tick).toBe(8 * 4 * 480);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.markers).toHaveLength(0);
  });

  it("kyx_tracks addInstrument/remove round-trip", () => {
    const store = new ProjectStore(datasetDoc());
    const before = store.doc.tracks.length;
    executeMcpTool(storeCtx(store), "kyx_tracks", { op: "addInstrument", instrument: "808" });
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

describe("mcp model-drivability wave", () => {
  it("kyx_steps add lands exact 16th steps in ONE undo step; remove/undo restores", () => {
    const store = new ProjectStore(datasetDoc());
    const kickPad = padIdForFamily(store.doc, "kick");
    expect(kickPad).toBeTruthy();
    const originalStep0 = store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!.rows[kickPad!]?.[0] ?? 0;
    const ctx = storeCtx(store);
    const result = executeMcpTool(ctx, "kyx_steps", {
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

  it("kyx_steps ghost lands soft velocity + 0.5 probability only on empty steps", () => {
    const store = new ProjectStore(datasetDoc());
    const kickPad = padIdForFamily(store.doc, "kick")!;
    const pattern = store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!;
    const occupied = (pattern.rows[kickPad] ?? []).findIndex((v) => v > 0);
    // one occupied step + one guaranteed-empty step far away
    const emptyStep = pattern.stepCount - 1;
    const result = executeMcpTool(storeCtx(store), "kyx_steps", {
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

  it("kyx_steps clearPad empties the family; out-of-range steps are refused honestly", () => {
    const store = new ProjectStore(datasetDoc());
    const kickPad = padIdForFamily(store.doc, "kick")!;
    const ctx = storeCtx(store);
    executeMcpTool(ctx, "kyx_steps", { op: "add", family: "kick", steps: [1, 3, 5] });
    const cleared = executeMcpTool(ctx, "kyx_steps", { op: "clearPad", family: "kick" });
    expect(cleared.mutated).toBe(true);
    const pattern = store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!;
    expect((pattern.rows[kickPad] ?? []).every((v) => v === 0)).toBe(true);

    const refused = executeMcpTool(storeCtx(store), "kyx_steps", {
      op: "add",
      family: "kick",
      steps: [999],
    });
    expect(refused.mutated).toBe(false);
    expect(refused.text).toContain("no valid steps");
  });

  it("kyx_pattern lists and selects by 1-based index or name; unknown is honest", () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const list = executeMcpTool(ctx, "kyx_pattern", { op: "list" });
    expect(list.mutated).toBe(false);
    expect(list.text).toContain("ACTIVE");

    const already = executeMcpTool(ctx, "kyx_pattern", { op: "select", pattern: "1" });
    expect(already.mutated).toBe(false);
    expect(already.text).toContain("already the active pattern");

    // a second pattern (generation) → select by 1-based index, then by name
    executeMcpTool(ctx, "kyx_generate", { genre: "techno", seed: "second" });
    expect(store.doc.patterns.length).toBe(2);
    const select = executeMcpTool(ctx, "kyx_pattern", { op: "select", pattern: "1" });
    expect(select.mutated).toBe(true);
    expect(store.doc.activePatternId).toBe(store.doc.patterns[0].id);
    const secondName = store.doc.patterns[1].name;
    const byName = executeMcpTool(ctx, "kyx_pattern", { op: "select", pattern: secondName });
    expect(byName.mutated).toBe(true);
    expect(store.doc.activePatternId).toBe(store.doc.patterns[1].id);

    const missing = executeMcpTool(ctx, "kyx_pattern", { op: "select", pattern: "quantum" });
    expect(missing.mutated).toBe(false);
    expect(missing.text).toContain('no pattern "quantum"');
  });

  it("kyx_state pattern/history/scenes subjects read the real state", () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    executeMcpTool(ctx, "kyx_steps", { op: "add", family: "kick", steps: [3] });
    const pattern = executeMcpTool(ctx, "kyx_state", { subject: "pattern" });
    expect(pattern.text).toContain("active:");
    expect(pattern.text).toContain("kick:");
    // grid shows the 1-based step the tool just wrote
    expect(pattern.text).toContain("3");

    const history = executeMcpTool(ctx, "kyx_state", { subject: "history" });
    expect(history.text).toContain("MCP steps");

    const scenes = executeMcpTool(ctx, "kyx_state", { subject: "scenes" });
    expect(scenes.text).toContain("Intro");
    expect(scenes.text).toContain("intro");

    const overview = executeMcpTool(ctx, "kyx_state", { subject: "overview" });
    expect(overview.text).toContain("active pattern:");
  });

  it("D4 gate: destructive ops refuse while locked, run once allowed", () => {
    const doc = datasetDoc();
    const locked = makeCtx(doc);
    const refusal = executeMcpTool(locked, "kyx_tracks", { op: "remove", family: "drums" });
    expect(refusal.mutated).toBe(false);
    expect(refusal.text).toContain("destructive MCP ops are locked");
    expect(doc.tracks.length).toBe(datasetDoc().tracks.length);

    const sectionRefusal = executeMcpTool(locked, "kyx_sections", { op: "remove", role: "intro" });
    expect(sectionRefusal.text).toContain("locked");

    const allowed = storeCtx(new ProjectStore(datasetDoc()), { allowDestructive: true });
    const removed = executeMcpTool(allowed, "kyx_tracks", { op: "remove", family: "drums" });
    expect(removed.mutated).toBe(true);
    expect(removed.text).toContain("removed");
  });

  it("kyx_generate honors bars (length) — 2 bars land 32 steps", () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const result = executeMcpTool(ctx, "kyx_generate", { genre: "techno", seed: "len", bars: 2 });
    expect(result.mutated).toBe(true);
    const pattern = store.doc.patterns[store.doc.patterns.length - 1];
    expect(pattern.stepCount).toBe(32);
    expect(result.text).toContain("2 bar");
  });
});

// ─── AUDIT REPAIRS — D4 gate reach, honest failures, atomicity, read-back ───

describe("mcp audit repairs", () => {
  it("kyx_undo redo counts honestly: empty redo stack → ×0, never ×N", () => {
    const doc = datasetDoc();
    const ctx = makeCtx(doc);
    const result = executeMcpTool(ctx, "kyx_undo", { action: "redo", steps: 5 });
    expect(result.text).toBe("redo ×0");
    expect(result.mutated).toBe(false);
  });

  it("kyx_undo undo stops at the stack bottom (1 entry, ask 5 → ×1)", () => {
    const ctx = makeCtx(datasetDoc());
    executeMcpTool(ctx, "kyx_intent", { instruction: "set tempo to 140" });
    const result = executeMcpTool(ctx, "kyx_undo", { action: "undo", steps: 5 });
    expect(result.text).toBe("undo ×1");
  });

  it("D4 gate: intent PHRASING cannot bypass the destructive lock", () => {
    const doc = datasetDoc();
    const locked = makeCtx(doc);
    const trackRefusal = executeMcpTool(locked, "kyx_intent", { instruction: "delete the drums track" });
    expect(trackRefusal.mutated).toBe(false);
    expect(trackRefusal.text).toContain("locked");
    expect(locked.getDoc().tracks.length).toBe(datasetDoc().tracks.length);

    // FX-instance removal phrased naturally is equally gated
    const fxLocked = makeCtx(withLead());
    executeMcpTool(fxLocked, "kyx_intent", { instruction: "more reverb on the lead" });
    const fxRefusal = executeMcpTool(fxLocked, "kyx_intent", { instruction: "remove the reverb from the lead" });
    expect(fxRefusal.text).toContain("locked");
    expect(fxLocked.getDoc().tracks.some((t) => t.effects.some((fx) => fx.type === "reverb"))).toBe(true);
  });

  it("kyx_intent bare transport words dispatch to the transport", () => {
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
    const result = executeMcpTool(observing, "kyx_intent", { instruction: "stop" });
    expect(stopped).toEqual(["stop"]);
    expect(result.mutated).toBe(false);
  });

  it("kyx_intent queries read back without mutating", () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const result = executeMcpTool(ctx, "kyx_intent", { instruction: "what tempo" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("BPM");
    expect(store.undoStackLength).toBe(0);
  });

  it("kyx_intent undo counting is honest (2 asked, 1 available → ×1)", () => {
    const ctx = makeCtx(datasetDoc());
    executeMcpTool(ctx, "kyx_intent", { instruction: "set tempo to 140" });
    const result = executeMcpTool(ctx, "kyx_intent", { instruction: "undo two steps" });
    expect(result.text).toBe("undo ×1");
    expect(result.mutated).toBe(true);
  });

  it("kyx_intent applier failures return honest text instead of throwing", () => {
    const store = new ProjectStore(datasetDoc()); // no vocal track
    const result = executeMcpTool(storeCtx(store), "kyx_intent", {
      instruction: "more reverb on the vocal",
    });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("intent failed");
  });

  it("kyx_tracks remove folds N deletions into ONE undo step", () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store, { allowDestructive: true });
    executeMcpTool(ctx, "kyx_tracks", { op: "addDrum" }); // → 2 drum tracks
    const drumCount = store.doc.tracks.filter((t) => t.kind === "drum").length;
    expect(drumCount).toBeGreaterThanOrEqual(2);
    const before = store.doc.tracks.length;

    const result = executeMcpTool(ctx, "kyx_tracks", { op: "remove", family: "drums" });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("one undo step");
    expect(store.doc.tracks.length).toBe(before - drumCount);

    store.undo(); // ONE undo restores every removed drum track
    expect(store.doc.tracks.length).toBe(before);
  });

  it("kyx_state tracks includes mixer values (gain/pan/mute/solo) for read-after-write", () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    executeMcpTool(ctx, "kyx_intent", { instruction: "mute the drums" });
    const state = executeMcpTool(ctx, "kyx_state", { subject: "tracks" });
    expect(state.text).toContain("gain");
    expect(state.text).toContain("pan");
    expect(state.text).toContain("muted");
  });

  it("kyx_transport loopOn PRESERVES the existing loop range", () => {
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
    executeMcpTool(observing, "kyx_transport", { action: "loopOn" });
    expect(loopCalls).toEqual([[true, 1920, 7680]]); // not the 0..4-bar reset
  });

  it("kyx_transport loopOn falls back to 4 bars when no loop exists", () => {
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
    executeMcpTool(observing, "kyx_transport", { action: "loopOn" });
    expect(loopCalls).toEqual([[true, 0, 4 * 4 * 480]]);
  });
});

// ─── P0 WAVE — catalog, plugin params, trackId addressing, meters ───────────

describe("mcp P0 wave — self-description + precision", () => {
  it("kyx_catalog lists effects with knob markers; instruments list the kinds", () => {
    const ctx = makeCtx(datasetDoc());
    const effects = executeMcpTool(ctx, "kyx_catalog", { subject: "effects" });
    expect(effects.mutated).toBe(false);
    expect(effects.text).toContain("reverb — Reverb");
    expect(effects.text).toContain("[knob: mix]");
    expect(effects.text).toContain("eq");
    expect(effects.text).toContain("no single knob");

    const instruments = executeMcpTool(ctx, "kyx_catalog", { subject: "instruments" });
    expect(instruments.text).toContain("808");
    expect(instruments.text).toContain("analog");
  });

  it("kyx_catalog subject:effect exposes the full param table (min/max/default/unit)", () => {
    const ctx = makeCtx(datasetDoc());
    const reverb = executeMcpTool(ctx, "kyx_catalog", { subject: "effect", effect: "reverb" });
    expect(reverb.text).toContain("primary knob (kyx_fx more/less): mix");
    expect(reverb.text).toMatch(/mix "MIX": 0 \.\. 1, default 0\.\d+/);

    const eq = executeMcpTool(ctx, "kyx_catalog", { subject: "effect", effect: "eq" });
    expect(eq.text).toContain("no single primary knob");
    expect(eq.text).toContain("hpFreq");

    const unknown = executeMcpTool(ctx, "kyx_catalog", { subject: "effect", effect: "quantum" });
    expect(unknown.mutated).toBe(false);
    expect(unknown.text).toContain('unknown effect "quantum"');
  });

  it("kyx_plugin_param set lands an absolute native value with read-back (one undo)", () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "lead", action: "more" });
    const result = executeMcpTool(ctx, "kyx_plugin_param", {
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

  it("kyx_plugin_param set clamps honestly and refuses unknown params/instances", () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "lead", action: "more" });

    const clamped = executeMcpTool(ctx, "kyx_plugin_param", {
      op: "set",
      family: "lead",
      effect: "reverb",
      param: "mix",
      value: 42, // way out of 0..1
    });
    expect(clamped.mutated).toBe(true);
    expect(clamped.text).toContain("clamped to 0..1");
    expect(store.doc.tracks.find((t) => t.name === "Lead")!.effects[0].params.mix).toBe(1);

    const unknownParam = executeMcpTool(ctx, "kyx_plugin_param", {
      op: "set",
      family: "lead",
      effect: "reverb",
      param: "quantum",
      value: 1,
    });
    expect(unknownParam.mutated).toBe(false);
    expect(unknownParam.text).toContain('unknown param "quantum"');
    expect(unknownParam.text).toContain("parameters:");

    const missingInstance = executeMcpTool(ctx, "kyx_plugin_param", {
      op: "set",
      family: "lead",
      effect: "delay",
      param: "mix",
      value: 0.5,
    });
    expect(missingInstance.mutated).toBe(false);
    expect(missingInstance.text).toContain("no delay instance");

    executeMcpTool(ctx, "kyx_fx", { effect: "delay", family: "lead", action: "more" });
    const missingSecond = executeMcpTool(ctx, "kyx_plugin_param", {
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

  it("kyx_plugin_param list reads current chain values; NaN value refused", () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "lead", action: "more" });
    const list = executeMcpTool(ctx, "kyx_plugin_param", { op: "list", family: "lead" });
    expect(list.mutated).toBe(false);
    expect(list.text).toContain("reverb#1");
    expect(list.text).toMatch(/mix=\d/);

    const nan = executeMcpTool(ctx, "kyx_plugin_param", {
      op: "set",
      family: "lead",
      effect: "reverb",
      param: "mix",
      value: "not-a-number",
    });
    expect(nan.mutated).toBe(false);
    expect(nan.text).toContain("finite number");
  });

  it("trackId addressing: kyx_fx and kyx_plugin_param hit ONE exact track", () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    const state = executeMcpTool(ctx, "kyx_state", { subject: "tracks" });
    expect(state.text).toMatch(/id=track-lead-x/); // ids in read-back

    const result = executeMcpTool(ctx, "kyx_fx", {
      effect: "delay",
      action: "more",
      trackId: "track-lead-x",
    });
    expect(result.mutated).toBe(true);
    expect(store.doc.tracks.find((t) => t.id === "track-lead-x")!.effects.some((fx) => fx.type === "delay")).toBe(true);

    const param = executeMcpTool(ctx, "kyx_plugin_param", {
      op: "set",
      trackId: "track-lead-x",
      effect: "delay",
      param: "mix",
      value: 0.3,
    });
    expect(param.mutated).toBe(true);

    const missing = executeMcpTool(ctx, "kyx_fx", { effect: "delay", action: "more", trackId: "t-quantum" });
    expect(missing.mutated).toBe(false);
    expect(missing.text).toContain("fx op failed");
  });

  it("kyx_tracks remove/rename honor trackId; groups are refused honestly", () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store, { allowDestructive: true });
    const renamed = executeMcpTool(ctx, "kyx_tracks", { op: "rename", trackId: "track-lead-x", name: "Syn Lead" });
    expect(renamed.mutated).toBe(true);
    expect(store.doc.tracks.find((t) => t.id === "track-lead-x")!.name).toBe("Syn Lead");

    const removed = executeMcpTool(ctx, "kyx_tracks", { op: "remove", trackId: "track-lead-x" });
    expect(removed.mutated).toBe(true);
    expect(store.doc.tracks.some((t) => t.id === "track-lead-x")).toBe(false);
    store.undo();
    expect(store.doc.tracks.some((t) => t.id === "track-lead-x")).toBe(true);

    // a group track is not addressable by kyx_tracks
    const doc = store.doc;
    const group = doc.tracks.find((t) => t.kind === "group");
    if (group) {
      const refused = executeMcpTool(ctx, "kyx_tracks", { op: "remove", trackId: group.id });
      expect(refused.mutated).toBe(false);
      expect(refused.text).toContain("group tracks are not addressable");
    }
  });

  it("kyx_fx refuses knob-less effects honestly (eq never had a primary knob)", () => {
    const store = new ProjectStore(datasetDoc());
    const result = executeMcpTool(storeCtx(store), "kyx_fx", { effect: "eq", family: "drums", action: "more" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("no single primary knob");
    expect(result.text).toContain("kyx_plugin_param");
  });

  it("kyx_meter honestly refuses without a hook and reads a live snapshot", () => {
    const store = new ProjectStore(datasetDoc());
    const bare = executeMcpTool(storeCtx(store), "kyx_meter", {});
    expect(bare.mutated).toBe(false);
    expect(bare.text).toContain("not available");

    const dead: McpToolContext = { ...storeCtx(store), meters: () => null };
    const deadResult = executeMcpTool(dead, "kyx_meter", {});
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
    const all = executeMcpTool(ctx, "kyx_meter", {});
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
    const hotResult = executeMcpTool(hot, "kyx_meter", { scope: "master" });
    expect(hotResult.text).toContain("⚠ CLIPPING (true peak ≥ 0 dBFS)");

    const masterOnly = executeMcpTool(ctx, "kyx_meter", { scope: "master" });
    expect(masterOnly.text).toContain("master:");
    expect(masterOnly.text).not.toContain("Drums (id=t1)");
  });
});

// ─── P1 WAVE — transport reads, seek, loop region ───────────────────────────

describe("mcp P1 transport — reads + seek + loop region", () => {
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

  it("kyx_transport state reads position/playing/loop/metronome read-only", () => {
    const ctx = makeCtx(datasetDoc());
    const observing: McpToolContext = { ...ctx, transport: fullTransport() };
    const result = executeMcpTool(observing, "kyx_transport", { action: "state" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("position bar 3 beat 2 (tick 4320)");
    expect(result.text).toContain("playing");
    expect(result.text).toContain("loop on (bars 2–4)");
    expect(result.text).toContain("metronome off");
  });

  it("kyx_transport state degrades honestly on a bare fake (no read accessors)", () => {
    const ctx = makeCtx(datasetDoc()); // minimal transport fake
    const result = executeMcpTool(ctx, "kyx_transport", { action: "state" });
    expect(result.mutated).toBe(false);
    expect(result.text).toBe("position unknown"); // the complete honest output
  });

  it("kyx_transport seek jumps by 1-based bar (+ optional beat) and reports the landing", () => {
    const seeks: number[] = [];
    const ctx = makeCtx(datasetDoc());
    const observing: McpToolContext = {
      ...ctx,
      transport: fullTransport({ seek: (tick) => seeks.push(tick), playing: false }),
    };
    const result = executeMcpTool(observing, "kyx_transport", { action: "seek", bar: 5 });
    expect(seeks).toEqual([4 * 1920]);
    expect(result.text).toContain("seek → bar 5 (tick 7680)");

    const withBeat = executeMcpTool(observing, "kyx_transport", { action: "seek", bar: 2, beat: 3 });
    expect(seeks).toEqual([4 * 1920, 1920 + 2 * 480]);
    expect(withBeat.text).toContain("bar 2 beat 3");
    expect(withBeat.text).toContain("stopped");
  });

  it("kyx_transport seek validates input and refuses without a seek-capable transport", () => {
    const ctx = makeCtx(datasetDoc());
    const missing = executeMcpTool(ctx, "kyx_transport", { action: "seek", bar: 5 });
    expect(missing.mutated).toBe(false);
    expect(missing.text).toContain("seek is not available");

    const full = makeCtx(datasetDoc());
    const observing: McpToolContext = { ...full, transport: fullTransport() };
    for (const bad of [{}, { bar: 0 }, { bar: -3 }, { bar: "quantum" }]) {
      const refused = executeMcpTool(observing, "kyx_transport", { action: "seek", ...bad });
      expect(refused.mutated).toBe(false);
      expect(refused.text).toContain("1-based bar");
    }
  });

  it("kyx_transport loopRegion sets the loop by inclusive 1-based bars", () => {
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
    const result = executeMcpTool(observing, "kyx_transport", { action: "loopRegion", startBar: 5, endBar: 9 });
    expect(result.mutated).toBe(false);
    expect(loopCalls).toEqual([[true, 4 * 1920, 9 * 1920]]);
    expect(result.text).toContain("loop region: bars 5–9");
    expect(result.text).toContain("loop on (bars 5–9)");

    for (const bad of [{}, { startBar: 3 }, { startBar: 5, endBar: 5 }, { startBar: 9, endBar: 5 }]) {
      const refused = executeMcpTool(observing, "kyx_transport", { action: "loopRegion", ...bad });
      expect(refused.mutated).toBe(false);
      expect(refused.text).toContain("loopRegion needs");
    }
  });

  it("base transport actions end their read-back with the resulting state (verify-by-read)", () => {
    const ctx = makeCtx(datasetDoc());
    const observing: McpToolContext = { ...ctx, transport: fullTransport() };
    const result = executeMcpTool(observing, "kyx_transport", { action: "metronomeOn" });
    expect(result.text).toMatch(/^transport: metronomeOn · /);
    expect(result.text).toContain("position bar 3 beat 2");
  });

  it("loop-end-of-content semantics: loopEnd <= start reads as 'to end of content'", () => {
    const ctx = makeCtx(datasetDoc());
    const observing: McpToolContext = {
      ...ctx,
      transport: fullTransport({ loopStart: 1920, loopEnd: 0 }),
    };
    const result = executeMcpTool(observing, "kyx_transport", { action: "state" });
    expect(result.text).toContain("loop on (to end of content)");
  });
});

// ─── P1 WAVE — send-level reads (kyx_state sends) ───────────────────────────

describe("mcp P1 sends — the read half of the send routing", () => {
  it("kyx_state sends lists returns (id/gain/fx) and per-track send levels", () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = storeCtx(store);
    const result = executeMcpTool(ctx, "kyx_state", { subject: "sends" });
    expect(result.mutated).toBe(false);
    // default returns with their faders + fx
    expect(result.text).toMatch(/returns: Reverb \(id=return-[\w-]+, gain 0\.90, fx: reverb\)/);
    expect(result.text).toContain("Delay");
    expect(result.text).toContain("NY Comp");
    // every track maps into every return, zeros included (a "send X" loop
    // must see the 0 it is about to raise)
    expect(result.text).toMatch(/Drums \(id=[\w-]+\): Reverb 0 · Delay 0 · NY Comp 0/);
  });

  it("send round-trip: NL send intent lands, kyx_state sends verifies the level", () => {
    const store = new ProjectStore(withLead());
    const ctx = storeCtx(store);
    executeMcpTool(ctx, "kyx_intent", { instruction: "more reverb send on the lead" });
    const result = executeMcpTool(ctx, "kyx_state", { subject: "sends", family: "lead" });
    // the send the intent raised is visible with its landed value
    expect(result.text).toMatch(/Lead \(id=track-lead-x\): Reverb 0\.1/);
    // drum tracks always pass the family filter (fxChain convention — the
    // kit carries the pad families)
    expect(result.text).toContain("Drums");
  });

  it("sends read includes group tracks (routing state, not just mixer members)", () => {
    const doc = datasetDoc();
    const group = doc.tracks.find((t) => t.kind === "group");
    if (!group) return; // template without a group — nothing to pin
    const store = new ProjectStore(doc);
    const result = executeMcpTool(storeCtx(store), "kyx_state", { subject: "sends" });
    expect(result.text).toContain(`${group.name} (id=${group.id}):`);
  });

  it("a project without returns reads honestly", () => {
    const doc = datasetDoc();
    const bare = { ...doc, returns: [] };
    const result = executeMcpTool(makeCtx(bare), "kyx_state", { subject: "sends" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("returns: none");
    expect(result.text).toContain("no send buses");
  });

  it("unfiltered reads past 8 tracks carry a truncation note", () => {
    const doc = datasetDoc();
    const base = doc.tracks.find((t) => t.kind === "instrument")!;
    const extra = Array.from({ length: 8 }, (_, i) => ({ ...base, id: `track-x-${i}`, name: `Pad ${i}` }));
    const fat = { ...doc, tracks: [...doc.tracks, ...extra] };
    const result = executeMcpTool(makeCtx(fat), "kyx_state", { subject: "sends" });
    expect(result.text).toContain("more track(s) (filter with family)");
  });
});
