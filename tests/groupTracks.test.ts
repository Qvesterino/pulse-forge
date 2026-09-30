import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { createGroupTrack, addToGroup, removeFromGroup, deleteTrack } from "../src/commands/commands";
import { createGroupTrackModel } from "../src/project-model/schema";
import { normalizeProject } from "../src/project-model/schema";
import { trackBadge } from "../src/ui/TrackTabs";
import { soloAudibility } from "../src/audio-engine/AudioEngine";

describe("GroupTrack", () => {
  it("createGroupTrackModel creates a group with correct defaults", () => {
    const g = createGroupTrackModel("Drums");
    expect(g.kind).toBe("group");
    expect(g.name).toBe("Drums");
    expect(g.gain).toBe(0.9);
    expect(g.mute).toBe(false);
    expect(g.effects).toEqual([]);
    expect(g.sends).toEqual({});
  });

  it("createGroupTrack command adds a group to the project", () => {
    const doc = createProjectFromTemplate("house");
    const cmd = createGroupTrack(doc);
    const next = cmd.execute(doc);
    const groups = next.tracks.filter((t) => t.kind === "group");
    expect(groups.length).toBe(1);
    expect(groups[0].name).toBe("Group 1");
  });

  it("addToGroup sets groupId on a drum track", () => {
    const doc = createProjectFromTemplate("house");
    const group = createGroupTrackModel("Drums");
    const withGroup = { ...doc, tracks: [...doc.tracks, group] };
    const drumTrack = withGroup.tracks.find((t) => t.kind === "drum")!;
    const cmd = addToGroup(withGroup, drumTrack.id, group.id);
    const next = cmd.execute(withGroup);
    const updated = next.tracks.find((t) => t.id === drumTrack.id);
    expect(updated).toBeDefined();
    expect("groupId" in updated! && updated.groupId).toBe(group.id);
  });

  it("addToGroup sets groupId on an instrument track", () => {
    const doc = createProjectFromTemplate("house");
    const group = createGroupTrackModel("Synths");
    const withGroup = { ...doc, tracks: [...doc.tracks, group] };
    const instTrack = withGroup.tracks.find((t) => t.kind === "instrument")!;
    const cmd = addToGroup(withGroup, instTrack.id, group.id);
    const next = cmd.execute(withGroup);
    const updated = next.tracks.find((t) => t.id === instTrack.id);
    expect(updated).toBeDefined();
    expect("groupId" in updated! && updated.groupId).toBe(group.id);
  });

  it("addToGroup undo removes groupId", () => {
    const doc = createProjectFromTemplate("house");
    const group = createGroupTrackModel("Drums");
    const withGroup = { ...doc, tracks: [...doc.tracks, group] };
    const drumTrack = withGroup.tracks.find((t) => t.kind === "drum")!;
    const cmd = addToGroup(withGroup, drumTrack.id, group.id);
    const next = cmd.execute(withGroup);
    const undone = cmd.undo(next);
    const restored = undone.tracks.find((t) => t.id === drumTrack.id);
    expect(restored).toBeDefined();
    expect((restored! as { groupId?: string }).groupId).toBeUndefined();
  });

  it("removeFromGroup clears groupId", () => {
    const doc = createProjectFromTemplate("house");
    const group = createGroupTrackModel("Drums");
    const drumTrack = doc.tracks.find((t) => t.kind === "drum")!;
    const withGroup = {
      ...doc,
      tracks: doc.tracks.map((t) => (t.id === drumTrack.id ? { ...t, groupId: group.id } : t)),
    };
    const cmd = removeFromGroup(withGroup, drumTrack.id);
    const next = cmd.execute(withGroup);
    const updated = next.tracks.find((t) => t.id === drumTrack.id);
    expect(updated).toBeDefined();
    expect(!("groupId" in updated!) || updated.groupId).toBeUndefined();
  });

  it("deleteTrack orphans children when deleting a group", () => {
    const doc = createProjectFromTemplate("house");
    const group = createGroupTrackModel("Drums");
    const drumTrack = doc.tracks.find((t) => t.kind === "drum")!;
    const withGroup = {
      ...doc,
      tracks: [...doc.tracks, group].map((t) => (t.id === drumTrack.id ? { ...t, groupId: group.id } : t)),
    };
    const cmd = deleteTrack(withGroup, group.id);
    const next = cmd.execute(withGroup);
    // Group should be removed
    expect(next.tracks.find((t) => t.id === group.id)).toBeUndefined();
    // Drum track should have groupId cleared
    const orphaned = next.tracks.find((t) => t.id === drumTrack.id);
    expect(orphaned).toBeDefined();
    expect(!("groupId" in orphaned!) || orphaned.groupId).toBeUndefined();
  });

  it("normalizeProject validates groupId references", () => {
    const doc = createProjectFromTemplate("house");
    const drumTrack = doc.tracks.find((t) => t.kind === "drum")!;
    const withBadGroup = {
      ...doc,
      tracks: doc.tracks.map((t) => (t.id === drumTrack.id ? { ...t, groupId: "nonexistent-group" } : t)),
    };
    const normalized = normalizeProject(withBadGroup);
    const updated = normalized.tracks.find((t) => t.id === drumTrack.id);
    expect(updated).toBeDefined();
    expect(!("groupId" in updated!) || updated.groupId).toBeUndefined();
  });

  it("normalizeProject handles group tracks", () => {
    const doc = createProjectFromTemplate("house");
    const group = createGroupTrackModel("Test");
    const withGroup = { ...doc, tracks: [...doc.tracks, group] };
    const normalized = normalizeProject(withGroup);
    const g = normalized.tracks.find((t) => t.kind === "group");
    expect(g).toBeDefined();
    expect(g!.effects).toEqual([]);
    expect(g!.sends).toEqual({});
  });

  it("group track badge is GRP", () => {
    const g = createGroupTrackModel("Test");
    expect(trackBadge(g)).toBe("GRP");
  });
});

describe("soloAudibility (group solo semantics)", () => {
  function soloProjectDoc() {
    const base = createProjectFromTemplate("house");
    const groupA = { ...createGroupTrackModel("A"), id: "grp-a" };
    const groupB = { ...createGroupTrackModel("B"), id: "grp-b" };
    const drum = base.tracks.find((t) => t.kind === "drum")!;
    const inst = base.tracks.find((t) => t.kind === "instrument")!;
    return {
      ...base,
      tracks: [
        groupA,
        groupB,
        { ...drum, id: "t-drum", groupId: "grp-a" },
        { ...inst, id: "t-inst", groupId: "grp-a" },
        { ...inst, id: "t-inst-b", groupId: "grp-b" },
      ],
    };
  }

  it("everything is audible when nothing is soloed", () => {
    const solo = soloAudibility(soloProjectDoc());
    expect(solo.anySolo).toBe(false);
    for (const id of ["grp-a", "grp-b", "t-drum", "t-inst", "t-inst-b"]) {
      expect(solo.audible(id)).toBe(true);
    }
  });

  it("soloing a child keeps it audible THROUGH its group (regression: the group used to mute itself)", () => {
    const doc = soloProjectDoc();
    const soloed = { ...doc, tracks: doc.tracks.map((t) => (t.id === "t-drum" ? { ...t, solo: true } : t)) };
    const solo = soloAudibility(soloed);
    expect(solo.anySolo).toBe(true);
    expect(solo.audible("t-drum")).toBe(true);
    expect(solo.audible("grp-a")).toBe(true); // group must pass the soloed child through
    expect(solo.audible("t-inst")).toBe(false); // sibling muted
    expect(solo.audible("grp-b")).toBe(false);
    expect(solo.audible("t-inst-b")).toBe(false);
  });

  it("soloing a group keeps its members audible and mutes the rest", () => {
    const doc = soloProjectDoc();
    const soloed = { ...doc, tracks: doc.tracks.map((t) => (t.id === "grp-a" ? { ...t, solo: true } : t)) };
    const solo = soloAudibility(soloed);
    expect(solo.audible("grp-a")).toBe(true);
    expect(solo.audible("t-drum")).toBe(true); // member of the soloed group
    expect(solo.audible("t-inst")).toBe(true);
    expect(solo.audible("grp-b")).toBe(false);
    expect(solo.audible("t-inst-b")).toBe(false);
  });

  it("a group solo does not leak into ungrouped tracks", () => {
    const base = soloProjectDoc();
    const doc = {
      ...base,
      tracks: [
        ...base.tracks,
        { ...base.tracks.find((t) => t.id === "t-inst")!, id: "t-ungrouped", groupId: undefined },
      ],
    };
    const soloed = { ...doc, tracks: doc.tracks.map((t) => (t.id === "grp-a" ? { ...t, solo: true } : t)) };
    const solo = soloAudibility(soloed);
    expect(solo.audible("t-ungrouped")).toBe(false);
  });

  it("mute wins over solo at the same node", () => {
    const doc = soloProjectDoc();
    const muted = {
      ...doc,
      tracks: doc.tracks.map((t) => {
        if (t.id === "t-drum") return { ...t, solo: true };
        if (t.id === "grp-a") return { ...t, mute: true };
        return t;
      }),
    };
    const solo = soloAudibility(muted);
    // Group mute now silences its members (1 gesto na 8) — linked mixer
    expect(solo.audible("t-drum")).toBe(false); // group muted → member inaudible even if soloed
    expect(solo.audible("grp-a")).toBe(false); // but the muted group gate is closed
  });

  it("unknown track ids report not audible", () => {
    const solo = soloAudibility(soloProjectDoc());
    expect(solo.audible("nope")).toBe(false);
  });

  /**
   * MULTIPLE SIMULTANEOUS SOLOS (audit 2026-09-30).
   *
   * Every case above drives the audibility matrix with a SINGLE solo. Real
   * sessions solo two buses at once ("let me hear drums and bass"), which is
   * the case the objective calls out explicitly. `soloAudibility` derives
   * `anySolo` plus two Sets (soloed groups, groups with a soloed child) and
   * answers per track, so the risk is that the union is computed from one solo
   * rather than all of them — a bug that would leave the second soloed bus
   * silent while the UI showed both buttons lit.
   */
  describe("multiple simultaneous solos", () => {
    const soloIds = (ids: string[]) => {
      const doc = soloProjectDoc();
      return soloAudibility({ ...doc, tracks: doc.tracks.map((t) => (ids.includes(t.id) ? { ...t, solo: true } : t)) });
    };

    it("two groups soloed at once: both buses and all members stay audible", () => {
      const solo = soloIds(["grp-a", "grp-b"]);
      expect(solo.anySolo).toBe(true);
      for (const id of ["grp-a", "grp-b", "t-drum", "t-inst", "t-inst-b"]) {
        expect(solo.audible(id), `${id} must survive two simultaneous group solos`).toBe(true);
      }
    });

    it("a soloed child in each group: both groups pass their own child through", () => {
      const solo = soloIds(["t-drum", "t-inst-b"]);
      expect(solo.audible("grp-a"), "group A must pass its soloed child through").toBe(true);
      expect(solo.audible("grp-b"), "group B must pass its soloed child through").toBe(true);
      expect(solo.audible("t-drum")).toBe(true);
      expect(solo.audible("t-inst-b")).toBe(true);
      // The sibling in the soloed group is NOT resurrected by its neighbour.
      expect(solo.audible("t-inst"), "an unsoloed sibling stays muted").toBe(false);
    });

    it("a group plus a loose child: the loose solo does not silence the soloed group", () => {
      const doc = soloProjectDoc();
      const solo = soloAudibility({
        ...doc,
        tracks: doc.tracks.map((t) => {
          if (t.id === "grp-a") return { ...t, solo: true };
          if (t.id === "t-inst-b") return { ...t, solo: true };
          return t;
        }),
      });
      expect(solo.audible("grp-a")).toBe(true);
      expect(solo.audible("t-drum")).toBe(true);
      expect(solo.audible("t-inst")).toBe(true);
      expect(solo.audible("t-inst-b")).toBe(true);
      // grp-b is NOT soloed, but it carries the soloed child t-inst-b, and the
      // documented rule is that a group is audible when it — or any of its
      // members — is soloed. It must pass the signal through, or the soloed
      // child would be inaudible (the pre-fix "soloing a child muted the
      // group" regression).
      expect(solo.audible("grp-b"), "a group must pass through its soloed child").toBe(true);
    });

    it("clearing ONE of two solos restores only that bus's material", () => {
      const doc = soloProjectDoc();
      const both = soloAudibility({
        ...doc,
        tracks: doc.tracks.map((t) => (t.id === "grp-a" || t.id === "grp-b" ? { ...t, solo: true } : t)),
      });
      expect(both.audible("t-inst-b")).toBe(true);

      // Release grp-b; its member must fall silent again while grp-a holds.
      const one = soloAudibility({
        ...doc,
        tracks: doc.tracks.map((t) => (t.id === "grp-a" ? { ...t, solo: true } : t)),
      });
      expect(one.audible("t-inst-b"), "releasing a solo must restore the global mute").toBe(false);
      expect(one.audible("t-drum")).toBe(true);
      expect(one.audible("grp-a")).toBe(true);
    });

    it("a group mute still silences its members under a simultaneous solo elsewhere", () => {
      const doc = soloProjectDoc();
      const solo = soloAudibility({
        ...doc,
        tracks: doc.tracks.map((t) => {
          if (t.id === "grp-a") return { ...t, mute: true };
          if (t.id === "t-inst-b") return { ...t, solo: true };
          return t;
        }),
      });
      expect(solo.audible("t-drum"), "a muted group stays muted while another bus is soloed").toBe(false);
      expect(solo.audible("t-inst-b"), "the other solo still passes through").toBe(true);
    });
  });
});
