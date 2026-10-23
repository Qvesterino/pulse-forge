import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import {
  addToGroup,
  createGroupTrack,
  removeFromGroup,
  setGroupMute,
  setGroupSolo,
} from "../src/commands/commands";
import { soloAudibility } from "../src/project-model/solo-audibility";
import { drumHitsInWindow } from "../src/project-model/groove";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * THE GROUP OWNS THE GROUP'S SOLO — a member's own state is never rewritten.
 *
 * The defect: `addToGroup` used to write `solo: true` onto a member that
 * joined a SOLOED group ("inherit the solo"). The write was never released —
 * `setGroupSolo(group, false)` only clears the group's own flag — so the member
 * stayed soloed after the group was un-soloed. A soloed track mutes every
 * unsoloed track in the project (anySolo), so joining a soloed group and then
 * un-soloing it SILENCED THE WHOLE PROJECT, with no way back but editing the
 * document by hand.
 *
 * The reason the write existed: the drum scheduler carried its OWN copy of the
 * audibility rule, and that copy did not know about groups. The two rules have
 * to be the SAME rule — the fix moves the rule into the model layer
 * (src/project-model/solo-audibility.ts) and lets both sides read it.
 *
 * These tests drive the real commands and the real audibility rule; nothing is
 * mocked, so they measure the contract rather than the implementation.
 */

function house(): ProjectDocument {
  return createProjectFromTemplate("house");
}

function firstDrumId(doc: ProjectDocument): string {
  const drum = doc.tracks.find((t) => t.kind === "drum");
  if (!drum) throw new Error("the house template must seed a drum track");
  return drum.id;
}

function otherTrackId(doc: ProjectDocument, exclude: string): string {
  const other = doc.tracks.find((t) => t.id !== exclude && t.kind !== "group");
  if (!other) throw new Error("the house template must seed another track");
  return other.id;
}

describe("group solo ownership", () => {
  it("addToGroup does not write a solo onto the member", () => {
    const doc = house();
    const withGroup = createGroupTrack(doc, "Drum Bus").execute(doc);
    const soloed = setGroupSolo(withGroup, withGroup.tracks.at(-1)!.id, true).execute(withGroup);
    const drumId = firstDrumId(soloed);

    const grouped = addToGroup(soloed, drumId, soloed.tracks.at(-1)!.id).execute(soloed);
    const member = grouped.tracks.find((t) => t.id === drumId)!;

    expect(member.solo, "the member's own solo state must not be rewritten").toBe(false);
  });

  it("un-soloing the group leaves the project audible (the defect silenced everything)", () => {
    const doc = house();
    const withGroup = createGroupTrack(doc, "Drum Bus").execute(doc);
    const groupId = withGroup.tracks.at(-1)!.id;
    const soloed = setGroupSolo(withGroup, groupId, true).execute(withGroup);
    const drumId = firstDrumId(soloed);
    const bystander = otherTrackId(soloed, drumId);

    const grouped = addToGroup(soloed, drumId, groupId).execute(soloed);
    const unSoloed = setGroupSolo(grouped, groupId, false).execute(grouped);

    const audibility = soloAudibility(unSoloed);
    expect(audibility.audible(bystander), "the bystander must still be audible").toBe(true);
    expect(audibility.audible(drumId), "the member must still be audible").toBe(true);
    expect(audibility.anySolo, "no track may stay soloed after the group is un-soloed").toBe(false);
  });

  it("leaving the group does not leave a solo behind either", () => {
    const doc = house();
    const withGroup = createGroupTrack(doc, "Drum Bus").execute(doc);
    const groupId = withGroup.tracks.at(-1)!.id;
    const soloed = setGroupSolo(withGroup, groupId, true).execute(withGroup);
    const drumId = firstDrumId(soloed);

    const grouped = addToGroup(soloed, drumId, groupId).execute(soloed);
    const left = removeFromGroup(grouped, drumId).execute(grouped);
    const member = left.tracks.find((t) => t.id === drumId)!;

    expect(member.solo, "a member that left the group carries no solo").toBe(false);
  });

  it("a member of a soloed group is audible, and a member of a muted group is not", () => {
    const doc = house();
    const withGroup = createGroupTrack(doc, "Drum Bus").execute(doc);
    const groupId = withGroup.tracks.at(-1)!.id;
    const drumId = firstDrumId(withGroup);
    const grouped = addToGroup(withGroup, drumId, groupId).execute(withGroup);

    const soloed = setGroupSolo(grouped, groupId, true).execute(grouped);
    expect(soloAudibility(soloed).audible(drumId), "the group is soloed → the member is audible").toBe(true);

    const muted = setGroupMute(grouped, groupId, true).execute(grouped);
    expect(soloAudibility(muted).audible(drumId), "the group is muted → the member is silent").toBe(false);
  });
});

describe("the drum scheduler and the mixer read the same audibility rule", () => {
  const patternOf = (doc: ProjectDocument) => {
    const pattern = doc.patterns.find((p) => p.id === doc.activePatternId) ?? doc.patterns[0];
    if (!pattern) throw new Error("the house template must seed a pattern");
    return pattern;
  };
  const hitsOf = (doc: ProjectDocument, trackId: string) => {
    const pattern = patternOf(doc);
    const hits = drumHitsInWindow(doc, pattern, 0, 0, pattern.stepCount * 120);
    return hits.filter((hit) => hit.trackId === trackId);
  };

  it("a member of a soloed group still gets its drum hits scheduled", () => {
    const doc = house();
    const withGroup = createGroupTrack(doc, "Drum Bus").execute(doc);
    const groupId = withGroup.tracks.at(-1)!.id;
    const drumId = firstDrumId(withGroup);
    const grouped = addToGroup(withGroup, drumId, groupId).execute(withGroup);
    const soloed = setGroupSolo(grouped, groupId, true).execute(grouped);

    expect(soloAudibility(soloed).audible(drumId)).toBe(true);
    expect(hitsOf(soloed, drumId).length, "the mixer says audible → the hits must be scheduled").toBeGreaterThan(0);
  });

  it("a member of a muted group gets no drum hits scheduled", () => {
    const doc = house();
    const withGroup = createGroupTrack(doc, "Drum Bus").execute(doc);
    const groupId = withGroup.tracks.at(-1)!.id;
    const drumId = firstDrumId(withGroup);
    const grouped = addToGroup(withGroup, drumId, groupId).execute(withGroup);
    const muted = setGroupMute(grouped, groupId, true).execute(grouped);

    expect(soloAudibility(muted).audible(drumId)).toBe(false);
    expect(hitsOf(muted, drumId).length, "the mixer says silent → no hits may be scheduled").toBe(0);
  });
});
