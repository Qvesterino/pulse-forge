/**
 * Clip groups + clip lock (schema v15) — edit ergonomics over BOTH clip
 * systems.
 *
 * GROUPS: a clip belongs to at most ONE group (`groupClips` moves membership),
 * a group dies with its last member. Groups are pure edit ergonomics — no
 * audio semantics, no scheduling role; the gesture layer expands block moves
 * to members, which is the entire runtime effect.
 *
 * LOCK: `locked` is enforced at COMMAND level — the choke point every entry
 * point (UI, MCP, intent) shares. Direct editing verbs (move/resize/trim/
 * split/slip/stretch/delete) refuse locked clips; non-destructive verbs
 * (mute, duplicate, selection) stay allowed. Compound/whole-range operations
 * are lock-aware only for their TARGET clip in v1 — the ripple tail and
 * range operations flowing around a locked clip are a documented boundary.
 */
import type { Command } from "./types";
import type { ArrangementClip, AudioClip, ClipGroup, ProjectDocument } from "../project-model/types";
import { uid } from "../shared/ids";
import { snapshot } from "./core";

/** Live ids from BOTH clip systems, in selection order. */
function routeSelection(doc: ProjectDocument, clipIds: readonly string[]): string[] {
  const arrangementIds = new Set(doc.arrangement.clips.map((c) => c.id));
  const audioIds = new Set((doc.arrangement.audioClips ?? []).map((c) => c.id));
  return clipIds.filter((id) => arrangementIds.has(id) || audioIds.has(id));
}

/** Strip the given ids from every group; groups that end up empty are dropped. */
export function clipGroupsWithoutIds(
  groups: ClipGroup[] | undefined,
  removed: readonly string[],
): ClipGroup[] | undefined {
  return withoutIds(groups, removed);
}

function withoutIds(groups: ClipGroup[] | undefined, removed: readonly string[]): ClipGroup[] | undefined {
  if (!groups || removed.length === 0) return groups;
  const dead = new Set(removed);
  const next = groups
    .map((group) => ({ ...group, clipIds: group.clipIds.filter((id) => !dead.has(id)) }))
    .filter((group) => group.clipIds.length > 0);
  return next;
}

export function groupClips(doc: ProjectDocument, clipIds: readonly string[], name?: string): Command {
  const members = routeSelection(doc, clipIds);
  if (members.length < 2) throw new Error("Select at least two clips to group");
  // One-group-per-clip: membership moves out of every other group.
  const others = withoutIds(doc.arrangement.clipGroups, members) ?? [];
  const group: ClipGroup = {
    id: uid("clipGroup"),
    ...(name && name.trim() !== "" ? { name: name.trim() } : {}),
    clipIds: members,
  };
  const next: ProjectDocument = {
    ...doc,
    arrangement: { ...doc.arrangement, clipGroups: [...others, group] },
  };
  return snapshot("groupClips", name ? `Group clips as "${group.name}"` : `Group ${members.length} clips`, doc, next);
}

export function ungroupClips(doc: ProjectDocument, clipIds: readonly string[]): Command {
  const nextGroups = withoutIds(doc.arrangement.clipGroups, routeSelection(doc, clipIds));
  if (jsonEqualGroups(nextGroups, doc.arrangement.clipGroups)) {
    return snapshot("ungroupClips", "Ungroup clips (no-op)", doc, doc);
  }
  const next: ProjectDocument = {
    ...doc,
    arrangement: { ...doc.arrangement, clipGroups: nextGroups },
  };
  return snapshot("ungroupClips", "Ungroup clips", doc, next);
}

export function setClipsLocked(doc: ProjectDocument, clipIds: readonly string[], locked: boolean): Command {
  const ids = new Set(routeSelection(doc, clipIds));
  if (ids.size === 0) return snapshot("setClipsLocked", "Lock clips (no-op)", doc, doc);
  const arrangement = doc.arrangement.clips.some((c) => ids.has(c.id) && (c.locked === true) !== locked);
  const audio = (doc.arrangement.audioClips ?? []).some((c) => ids.has(c.id) && (c.locked === true) !== locked);
  if (!arrangement && !audio) return snapshot("setClipsLocked", locked ? "Lock clips (no-op)" : "Unlock clips (no-op)", doc, doc);
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: doc.arrangement.clips.map((c) => (ids.has(c.id) ? { ...c, locked: locked === true } : c)),
      audioClips: (doc.arrangement.audioClips ?? []).map((c) => (ids.has(c.id) ? { ...c, locked: locked === true } : c)),
    },
  };
  return snapshot("setClipsLocked", `${locked ? "Lock" : "Unlock"} ${ids.size} ${ids.size === 1 ? "clip" : "clips"}`, doc, next);
}

function jsonEqualGroups(a: ClipGroup[] | undefined, b: ClipGroup[] | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Shared guard for the direct editing verbs. Call right after the clip lookup. */
export function assertClipEditable(clip: Pick<ArrangementClip | AudioClip, "locked">, verb: string): void {
  if (clip.locked) throw new Error(`Clip is locked — unlock it to ${verb}`);
}
