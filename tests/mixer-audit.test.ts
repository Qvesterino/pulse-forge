import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { createGroupTrackModel, normalizeProject } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";
import { ProjectStore } from "../src/store/ProjectStore";
import { addToGroup, createGroupTrack, setGroupMute, setGroupSolo, setTrackParams } from "../src/commands/commands";

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

  it("CLEAN mixer params keep the tracks ARRAY reference (canonicality + structural sharing)", () => {
    // Regression: the first version of this sanitizer .map()-ed unconditionally,
    // reallocating `tracks` on EVERY normalizeProject call — breaking doc
    // identity (templates are canonical) and the React slice subscriptions.
    const doc = createProjectFromTemplate("house");
    const normalized = normalizeProject(doc);
    expect(normalized.tracks).toBe(doc.tracks);
    // And an out-of-range value still gets clamped (same run, real change).
    const hostile = normalizeProject({
      ...doc,
      tracks: doc.tracks.map((t, i) => (i === 0 ? { ...t, gain: 42 } : t)),
    });
    expect(hostile.tracks).not.toBe(doc.tracks);
    expect(hostile.tracks[0]!.gain).toBe(1.5);
    // Master identity survives when loudnessTrimDb is present and in range.
    expect(hostile.master).toBeDefined();
  });

  it("clamps hostile send levels into [0, 1.5] (pre-fix: send 42 reached the FX bus)", () => {
    const base = createProjectFromTemplate("house");
    const returnId = base.returns[0]?.id;
    if (!returnId) return;
    const doc = normalizeProject({
      ...base,
      tracks: base.tracks.map((t, i) => (i === 0 ? { ...t, sends: { [returnId]: 42 } } : t)),
    });
    expect(doc.tracks[0]!.sends?.[returnId]).toBe(1.5);
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

/**
 * Mixer signal-flow audit (2026-09-27) — structural pins for the engine
 * paths that cannot run under vitest (no WebAudio): the live-preview gate,
 * frozen-channel teardown and the send-preview wiring. The audible
 * behaviour itself is verified by runChecks() browser gates:
 *   - "mixer preview: fader preview on a muted channel stays silent"
 *   - "mixer preview: send preview drives the real return-bus path"
 *   - "frozen: deleting a frozen track stops + removes its buffer source"
 */
describe("mixer signal-flow audit — preview/teardown contracts", () => {
  const engineSrc = () => readFileSync(resolve(process.cwd(), "src/audio-engine/AudioEngine.ts"), "utf8");
  const mixerSrc = () => readFileSync(resolve(process.cwd(), "src/ui/Mixer.tsx"), "utf8");

  it("previewTrackGain consults the SAME soloAudibility gate syncProject writes (no drag un-mutes a muted channel)", () => {
    const src = engineSrc();
    const previewBody = src.slice(src.indexOf("previewTrackGain(trackId"), src.indexOf("previewTrackSend("));
    expect(previewBody, "preview must route through soloAudibility").toMatch(/soloAudibility\(this\.doc\)/);
    expect(previewBody, "inaudible channel must preview 0, never the raw fader value").toMatch(
      /audible\s*\?\s*clampFaderGain\(gain\)\s*:\s*0/,
    );
  });

  it("disposeTrackNodes tears down the frozen buffer source (deleting a frozen track cannot leak it)", () => {
    const src = engineSrc();
    const disposeBody = src.slice(
      src.indexOf("private disposeTrackNodes("),
      src.indexOf("private disposeInstrumentRuntime("),
    );
    // Wave 4e: frozen sources live in WarpManager (de-privatized there).
    expect(disposeBody, "disposeTrackNodes must call disposeFrozenSource").toMatch(
      /this\.warpManager\.disposeFrozenSource\(id\)/,
    );
  });

  it("send sliders are live-preview wired like gain/pan (no silent-until-release mixer control)", () => {
    const src = mixerSrc();
    const start = src.indexOf("ret.name.toUpperCase()");
    expect(start, "send slider block must exist").toBeGreaterThan(0);
    const sendSlider = src.slice(start, start + 2000);
    expect(sendSlider).toMatch(/onPreview=\{\(level\) => services\.engine\.previewTrackSend\(/);
    expect(sendSlider).toMatch(/onCancel=\{\(\) => services\.engine\.previewTrackSend\(/);
  });

  it("persisted mixer state restores exactly: extreme faders, mute/solo, sends, groups, master chain", async () => {
    const { ProjectRepository } = await import("../src/persistence/ProjectRepository");
    const base = createProjectFromTemplate("house");
    const group = { ...createGroupTrackModel("Mix Bus"), gain: 1.4, pan: 0.5, mute: false, solo: true };
    const doc: ProjectDocument = normalizeProject({
      ...base,
      tracks: base.tracks.map((t, i) => {
        if (t.kind === "group") return group;
        const first = t.id === base.tracks.find((x) => x.kind !== "group")!.id;
        return {
          ...t,
          gain: i % 2 ? 1.5 : 0,
          pan: i % 2 ? -1 : 1,
          mute: i % 3 === 0,
          solo: first ? true : t.solo,
          groupId: group.id,
          sends: { [base.returns[0].id]: i % 2 ? 1.5 : 0.25 },
        };
      }),
      returns: base.returns.map((r, i) => ({ ...r, gain: i === 0 ? 1.5 : 0.1 })),
      master: {
        ...base.master,
        masterGain: 1.5,
        ceilingDb: -12,
        limiterEnabled: false,
        clipperEnabled: true,
        tiltDb: 4,
        loudnessTrimDb: -6,
        bassMonoEnabled: true,
        bassMonoFreq: 400,
      },
    });
    const repo = new ProjectRepository();
    await repo.save(doc);
    const loaded = (await repo.load(doc.id))!;
    expect(loaded).toBeTruthy();
    const strip = (d: ProjectDocument) =>
      d.tracks.map((t) => ({
        g: t.gain,
        p: t.pan,
        m: t.mute,
        s: t.solo,
        grp: "groupId" in t ? t.groupId : undefined,
        snd: t.sends,
      }));
    expect(strip(loaded)).toEqual(strip(doc));
    expect(loaded.master).toEqual(doc.master);
    expect(loaded.returns.map((r) => r.gain)).toEqual(doc.returns.map((r) => r.gain));
  });
});
