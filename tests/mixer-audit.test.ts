import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addToGroup,
  createGroupTrack,
  setGroupMute,
  setGroupSolo,
  setTrackParams,
} from "../src/commands/commands";

/**
 * AUDIT 04 — Mixer regression invariants
 * (prompts/daw_qa_reliability_vault/04-mixer-audit.md).
 *
 * Engine graph wiring (sends/groups/returns build) was covered by the
 * earlier reliability pass; this suite pins the Audit-04 fixes: mixer
 * parameter sanitization, group mute/solo without member-state destruction,
 * identical-value no-ops, and the loudnessTrimDb-preserving master rebuild.
 */

function hostileDoc(mixer: Record<string, unknown>): ProjectDocument {
  const base = createProjectFromTemplate("house");
  return normalizeProject({
    ...base,
    tracks: base.tracks.map((t, i) => (i === 0 ? ({ ...t, ...mixer } as typeof t) : t)),
  });
}

describe("normalizeProject — mixer parameter sanitization (audit 04)", () => {
  it("clamps an out-of-range gain instead of blasting it through the engine", () => {
    const doc = hostileDoc({ gain: 999 });
    expect(doc.tracks[0]!.gain).toBe(1.5);
    expect(doc.tracks[1]!.gain).toBeLessThanOrEqual(1.5);
  });

  it("heals NON-FINITE gain/pan (pre-fix: setTargetAtTime threw mid-syncProject)", () => {
    const doc = hostileDoc({ gain: Number.NaN, pan: Number.POSITIVE_INFINITY });
    expect(doc.tracks[0]!.gain).toBe(0.9);
    expect(doc.tracks[0]!.pan).toBe(0);
    expect(Number.isFinite(doc.tracks[0]!.gain)).toBe(true);
  });

  it("coerces mute/solo to strict booleans and clamps pan to [-1, 1]", () => {
    const doc = hostileDoc({ pan: -7, mute: "yes" as unknown as boolean, solo: 1 as unknown as boolean });
    expect(doc.tracks[0]!.pan).toBe(-1);
    // STRICT boolean coercion — truthy-but-not-true values are not "on".
    expect(doc.tracks[0]!.mute).toBe(false);
    expect(doc.tracks[0]!.solo).toBe(false);
  });

  it("clamps hostile send levels into [0, 1] (pre-fix: send 42 reached the FX bus)", () => {
    const base = createProjectFromTemplate("house");
    const returnId = base.returns[0]?.id;
    if (!returnId) return;
    const doc = normalizeProject({
      ...base,
      tracks: base.tracks.map((t, i) => (i === 0 ? { ...t, sends: { [returnId]: 42 } } : t)),
    });
    expect(doc.tracks[0]!.sends?.[returnId]).toBe(1);
  });

  it("master rebuild preserves loudnessTrimDb (pre-fix: silently reset to 0)", () => {
    const base = createProjectFromTemplate("house");
    const doc = normalizeProject({
      ...base,
      master: {
        ...base.master,
        loudnessTrimDb: -3,
        bassMonoFreq: 9999, // one out-of-range field forces the rebuild path
      },
    });
    expect(doc.master.loudnessTrimDb).toBe(-3);
    expect(doc.master.bassMonoFreq).toBe(400);
  });
});

describe("setTrackParams — clamps + identity no-op (audit 04)", () => {
  it("clamps gain/pan and rejects non-finite values at the command boundary", () => {
    const base = createProjectFromTemplate("house");
    const s = new ProjectStore(base);
    const trackId = base.tracks[0]!.id;
    s.execute(setTrackParams(s.getDoc(), trackId, { gain: 500, pan: -20 }));
    const t = s.getDoc().tracks[0]!;
    expect(t.gain).toBe(1.5);
    expect(t.pan).toBe(-1);
    s.execute(setTrackParams(s.getDoc(), trackId, { gain: Number.NaN }));
    expect(Number.isFinite(s.getDoc().tracks[0]!.gain)).toBe(true);
  });

  it("an identical-value commit is a no-op (no undo entry, no doc change)", () => {
    const base = createProjectFromTemplate("house");
    const s = new ProjectStore(base);
    const trackId = base.tracks[0]!.id;
    const before = s.getDoc();
    const beforeDepth = s.undoStackLength;
    s.execute(setTrackParams(s.getDoc(), trackId, { gain: before.tracks[0]!.gain }));
    expect(s.getDoc()).toBe(before); // identity preserved — nothing happened
    expect(s.undoStackLength).toBe(beforeDepth);
  });
});

describe("group mute/solo — member state preservation (audit 04)", () => {
  function groupFixture() {
    const base = createProjectFromTemplate("house");
    const s = new ProjectStore(base);
    s.execute(createGroupTrack(s.getDoc()));
    const group = s.getDoc().tracks.find((t) => t.kind === "group")!;
    const drum = s.getDoc().tracks.find((t) => t.kind === "drum")!;
    s.execute(addToGroup(s.getDoc(), drum.id, group.id));
    const member = s.getDoc().tracks.find((t) => t.id === drum.id)!;
    return { s, group, member };
  }

  it("un-muting the group does NOT resurrect a member the user muted individually", () => {
    const { s, group, member } = groupFixture();
    // Member individually muted BEFORE the group mute.
    s.execute(setTrackParams(s.getDoc(), member.id, { mute: true }));
    s.execute(setGroupMute(s.getDoc(), group.id, true));
    expect(s.getDoc().tracks.find((t) => t.id === member.id)!.mute).toBe(true);
    s.execute(setGroupMute(s.getDoc(), group.id, false));
    const after = s.getDoc().tracks.find((t) => t.id === member.id)!;
    expect(after.mute, "pre-existing individual mute must survive the group cycle").toBe(true);
  });

  it("group solo write touches only the group (members keep their own solo flags)", () => {
    const { s, group, member } = groupFixture();
    s.execute(setGroupSolo(s.getDoc(), group.id, true));
    expect(s.getDoc().tracks.find((t) => t.id === group.id)!.solo).toBe(true);
    expect(s.getDoc().tracks.find((t) => t.id === member.id)!.solo).toBe(false);
  });
});
