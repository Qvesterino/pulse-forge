import { describe, expect, it } from "vitest";
import { JAM_ROLES, isJamRole, normalizeJamRole, roleAllows } from "../src/collab/jamRoles";
import { YDocStore } from "../src/collab/YDocStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { setBpm, toggleStep } from "../src/commands/commands";

describe("jam role capability matrix", () => {
  it("defines the five roles", () => {
    expect(JAM_ROLES.map((r) => r.id)).toEqual(["owner", "drums", "keys", "mixer", "arranger"]);
  });

  it("owner runs everything", () => {
    for (const type of [
      "toggleStep",
      "setBpm",
      "setMasterConfig",
      "addNote",
      "autoArrangeSong",
      "someBrandNewCommand",
    ]) {
      expect(roleAllows("owner", type)).toBe(true);
    }
  });

  it("drums plays the rack but cannot touch tempo or the mix", () => {
    expect(roleAllows("drums", "toggleStep")).toBe(true);
    expect(roleAllows("drums", "setPadMod")).toBe(true);
    expect(roleAllows("drums", "applyKitToDrumTrack")).toBe(true);
    expect(roleAllows("drums", "stealGrooveIntoPattern")).toBe(true);
    expect(roleAllows("drums", "generatePattern")).toBe(true);
    expect(roleAllows("drums", "setBpm")).toBe(false);
    expect(roleAllows("drums", "setTrackParams")).toBe(false);
    expect(roleAllows("drums", "addNote")).toBe(false);
    expect(roleAllows("drums", "moveArrangementClip")).toBe(false);
  });

  it("keys owns notes and instruments only", () => {
    expect(roleAllows("keys", "addNote")).toBe(true);
    expect(roleAllows("keys", "setInstrumentParam")).toBe(true);
    expect(roleAllows("keys", "applyInstrumentPreset")).toBe(true);
    expect(roleAllows("keys", "toggleStep")).toBe(false);
    expect(roleAllows("keys", "setMasterConfig")).toBe(false);
    expect(roleAllows("keys", "createScene")).toBe(false);
  });

  it("mixer owns channels, FX and automation but not steps", () => {
    expect(roleAllows("mixer", "setTrackParams")).toBe(true);
    expect(roleAllows("mixer", "setEffectParam")).toBe(true);
    expect(roleAllows("mixer", "setMasterConfig")).toBe(true);
    expect(roleAllows("mixer", "freezeTrack")).toBe(true);
    expect(roleAllows("mixer", "toggleStep")).toBe(false);
    expect(roleAllows("mixer", "setBpm")).toBe(false);
  });

  it("arranger builds the song but cannot play the grid", () => {
    expect(roleAllows("arranger", "addArrangementClip")).toBe(true);
    expect(roleAllows("arranger", "autoArrangeSong")).toBe(true);
    expect(roleAllows("arranger", "setBpm")).toBe(true);
    expect(roleAllows("arranger", "createScene")).toBe(true);
    expect(roleAllows("arranger", "toggleStep")).toBe(false);
    expect(roleAllows("arranger", "addNote")).toBe(false);
  });

  it("housekeeping is shared and unknown commands fail closed", () => {
    for (const role of ["drums", "keys", "mixer", "arranger"] as const) {
      expect(roleAllows(role, "setProjectName")).toBe(true);
      expect(roleAllows(role, "setPadColor")).toBe(true);
      // Fail-closed: a command type on no list is owner-only.
      expect(roleAllows(role, "someBrandNewCommand")).toBe(false);
    }
  });

  it("role helpers normalize garbage to owner", () => {
    expect(isJamRole("drums")).toBe(true);
    expect(isJamRole("emperor")).toBe(false);
    expect(normalizeJamRole("mixer")).toBe("mixer");
    expect(normalizeJamRole(undefined)).toBe("owner");
    expect(normalizeJamRole("hacker")).toBe("owner");
  });
});

describe("YDocStore jam-role gate", () => {
  function makeStore(role: ReturnType<typeof normalizeJamRole> | null) {
    const doc = createProjectFromTemplate("house");
    const store = YDocStore.fromDocument(doc);
    store.roleProvider = () => role;
    return { store, doc };
  }

  it("blocks out-of-bucket commands and reports the refusal", () => {
    const blocked: string[] = [];
    const { store, doc } = makeStore("drums");
    store.onRoleBlocked = (type) => blocked.push(type);
    const bpmBefore = store.doc.bpm;
    const padId = Object.keys(doc.patterns[0].rows)[0];
    store.execute(setBpm(doc, 999));
    expect(store.doc.bpm).toBe(bpmBefore);
    expect(blocked).toEqual(["setBpm"]);
    expect(store.lastRoleBlock?.type).toBe("setBpm");
    // In-bucket command goes through and clears the block marker.
    const stepBefore = store.doc.patterns[0].rows[padId][0];
    store.execute(toggleStep(doc, padId, 0));
    expect(store.lastRoleBlock).toBeNull();
    expect(store.doc.patterns[0].rows[padId][0]).not.toBe(stepBefore);
  });

  it("a null role (solo or pre-wire) is never gated", () => {
    const { store, doc } = makeStore(null);
    store.execute(setBpm(doc, 141));
    expect(store.doc.bpm).toBe(141);
  });

  it("gate sits in front of undo — a blocked command leaves no history", () => {
    const { store, doc } = makeStore("arranger");
    const undoDepth = store.undoStackLength;
    store.execute(setBpm(doc, 150)); // arranger may set tempo
    store.execute(toggleStep(doc, Object.keys(doc.patterns[0].rows)[0], 0)); // blocked
    expect(store.undoStackLength).toBe(undoDepth + 1);
    store.undo();
    expect(store.doc.bpm).not.toBe(150);
  });
});
