import type { Command } from "./types";
import type { LiveSet, LiveSetPad, ProjectDocument } from "../project-model/types";
import { normalizeProject } from "../project-model/schema";
import { uid } from "../shared/ids";
import { snapshot } from "./core";

const LOOP_BARS = new Set<LiveSet["loopBars"]>([1, 2, 4, 8, 16]);

function requiredSet(doc: ProjectDocument, setId: string): LiveSet {
  const set = doc.liveSets?.find((item) => item.id === setId);
  if (!set) throw new Error(`Live Set ${setId} not found`);
  return set;
}

export function createLiveSet(doc: ProjectDocument, name = "Live Set"): Command {
  if ((doc.liveSets?.length ?? 0) >= 32) throw new Error("A project can hold up to 32 Live Sets");
  const trimmed = name.trim().slice(0, 64) || `Live Set ${(doc.liveSets?.length ?? 0) + 1}`;
  const set: LiveSet = { id: uid("liveSet"), name: trimmed, loopBars: 4, pads: [] };
  const next = normalizeProject({
    ...doc,
    liveSets: [...(doc.liveSets ?? []), set],
    activeLiveSetId: set.id,
  });
  return snapshot("createLiveSet", `Create ${trimmed}`, doc, next);
}

export function renameLiveSet(doc: ProjectDocument, setId: string, name: string): Command {
  requiredSet(doc, setId);
  const trimmed = name.trim().slice(0, 64);
  if (!trimmed) throw new Error("Live Set name cannot be empty");
  const next = normalizeProject({
    ...doc,
    liveSets: doc.liveSets!.map((set) => (set.id === setId ? { ...set, name: trimmed } : set)),
  });
  return snapshot("renameLiveSet", `Rename Live Set to ${trimmed}`, doc, next);
}

export function duplicateLiveSet(doc: ProjectDocument, setId: string): Command {
  const source = requiredSet(doc, setId);
  if ((doc.liveSets?.length ?? 0) >= 32) throw new Error("A project can hold up to 32 Live Sets");
  const copy: LiveSet = {
    ...source,
    id: uid("liveSet"),
    name: `${source.name} copy`.slice(0, 64),
    pads: source.pads.map((pad) => ({ ...pad })),
  };
  const next = normalizeProject({
    ...doc,
    liveSets: [...(doc.liveSets ?? []), copy],
    activeLiveSetId: copy.id,
  });
  return snapshot("duplicateLiveSet", `Duplicate ${source.name}`, doc, next);
}

export function deleteLiveSet(doc: ProjectDocument, setId: string): Command {
  const removed = requiredSet(doc, setId);
  const liveSets = doc.liveSets!.filter((set) => set.id !== setId);
  const activeLiveSetId = doc.activeLiveSetId === setId ? liveSets[0]?.id : doc.activeLiveSetId;
  // `AudioClip.liveSetId` + `livePadSlot` are a cross-reference HELD BY ANOTHER
  // ENTITY (the clip was launched from a pad of this set). They are NOT
  // cleared here: `normalizeArrangementDomain` owns that rule, and since this
  // command ends in `normalizeProject` the saved document is clean either way.
  // Falsifying a command-level copy of the cleanup left the suite green — the
  // normalizer caught it — which is exactly the two-implementations-of-one-rule
  // shape that lets the weaker copy rot unnoticed. One owner, provably
  // load-bearing (see `.artifacts/falsify-audit15-risks.mjs`, M8).
  const nextDoc: ProjectDocument = { ...doc, liveSets };
  if (activeLiveSetId) nextDoc.activeLiveSetId = activeLiveSetId;
  else delete nextDoc.activeLiveSetId;
  const next = normalizeProject(nextDoc);
  return snapshot("deleteLiveSet", `Delete Live Set ${removed.name}`, doc, next);
}

export function selectLiveSet(doc: ProjectDocument, setId: string): Command {
  requiredSet(doc, setId);
  return snapshot("selectLiveSet", `Select Live Set ${requiredSet(doc, setId).name}`, doc, {
    ...doc,
    activeLiveSetId: setId,
  });
}

export function setLiveSetOptions(
  doc: ProjectDocument,
  setId: string,
  patch: { trackId?: string | null; loopBars?: LiveSet["loopBars"] },
): Command {
  const set = requiredSet(doc, setId);
  const trackId = patch.trackId === null ? undefined : (patch.trackId ?? set.trackId);
  if (trackId && !doc.tracks.some((track) => track.id === trackId && track.kind !== "generative")) {
    throw new Error(`Live Set destination track ${trackId} is not audio-capable`);
  }
  const loopBars = patch.loopBars ?? set.loopBars;
  if (!LOOP_BARS.has(loopBars)) throw new Error(`Unsupported Live Set loop length ${loopBars}`);
  const liveSets = doc.liveSets!.map((item) => {
    if (item.id !== setId) return item;
    const nextSet: LiveSet = { ...item, loopBars };
    if (trackId) nextSet.trackId = trackId;
    else delete nextSet.trackId;
    return nextSet;
  });
  const next = normalizeProject({ ...doc, liveSets });
  return snapshot("setLiveSetOptions", `Update ${set.name} launch settings`, doc, next);
}

export function assignLivePad(doc: ProjectDocument, setId: string, pad: LiveSetPad | null, slot?: number): Command {
  const set = requiredSet(doc, setId);
  const padSlot = pad?.slot ?? slot;
  if (!Number.isInteger(padSlot) || padSlot! < 0 || padSlot! >= 16) throw new Error("Live Pad slot must be 0–15");
  if (pad && (!pad.bufferId.trim() || !pad.name.trim())) throw new Error("Live Pad needs an audio asset and a name");
  const pads = set.pads.filter((item) => item.slot !== padSlot);
  if (pad) pads.push({ ...pad, slot: padSlot! });
  pads.sort((a, b) => a.slot - b.slot);
  const liveSets = doc.liveSets!.map((item) => (item.id === setId ? { ...item, pads } : item));
  const next = normalizeProject({ ...doc, liveSets });
  const label = pad ? `Assign ${pad.name} to Live Pad ${padSlot! + 1}` : `Clear Live Pad ${padSlot! + 1}`;
  return snapshot("assignLivePad", label, doc, next);
}
