import type { ProjectDocument } from "../project-model/types";

/**
 * A bounded, human-readable summary of what actually changed between two
 * documents. This is the MCP intent path's generic verification read-back:
 * it is not a replacement for the value-level read-backs (param/effect/
 * production/preset), it is the fallback that proves the document moved and
 * names the area that moved. No summary is produced for an identical
 * document — callers must report "nothing changed" instead of an undo step.
 */
export interface DocumentChangeSummary {
  changed: boolean;
  lines: string[];
}

const MAX_LINES = 6;

function sameRef(a: unknown, b: unknown): boolean {
  return a === b;
}

/**
 * One line per collection that moved — the read-back has to NAME THE AREA,
 * not just announce that something changed. An empty result means the
 * collection is byte-for-byte the same items.
 */
function collectionLine(label: string, before: readonly unknown[], after: readonly unknown[]): string | null {
  if (before.length !== after.length) return `${label} ${before.length} -> ${after.length}`;
  const changed = after.filter((item, index) => item !== before[index]).length;
  if (changed === 0) return null;
  return `${changed} ${label} item(s) changed`;
}

function trackLabel(track: ProjectDocument["tracks"][number]): string {
  return `"${track.name}" (trackId=${track.id})`;
}

function entityChangeLines<T extends { id: string }>(
  label: string,
  before: readonly T[],
  after: readonly T[],
): string[] {
  const lines: string[] = [];
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) lines.push(`removed ${label} id=${id}`);
  }
  for (const [id, item] of afterById) {
    const previous = beforeById.get(id);
    if (previous == null) lines.push(`added ${label} id=${id}`);
    else if (previous !== item) lines.push(`changed ${label} id=${id}`);
  }
  if (
    before.map((item) => item.id).join("\u0000") !== after.map((item) => item.id).join("\u0000") &&
    before.length === after.length &&
    before.every((item) => afterById.has(item.id))
  ) {
    lines.push(`${label} order changed`);
  }
  return lines;
}

function fxTypes(track: ProjectDocument["tracks"][number]): string[] {
  return track.effects.map((fx) => `${fx.type}${fx.bypassed ? " (bypassed)" : ""}`);
}

function effectChangeLines(
  track: ProjectDocument["tracks"][number],
  before: ProjectDocument["tracks"][number]["effects"],
  after: ProjectDocument["tracks"][number]["effects"],
): string[] {
  const lines: string[] = [];
  const beforeById = new Map(before.map((effect) => [effect.id, effect]));
  const afterById = new Map(after.map((effect) => [effect.id, effect]));
  for (const [fxId, effect] of beforeById) {
    if (!afterById.has(fxId)) lines.push(`track ${track.name} (${track.id}) removed ${effect.type} fxId=${fxId}`);
  }
  for (const [fxId, effect] of afterById) {
    const previous = beforeById.get(fxId);
    if (!previous) {
      lines.push(`track ${track.name} (${track.id}) added ${effect.type} fxId=${fxId}`);
      continue;
    }
    if (previous.bypassed !== effect.bypassed) {
      lines.push(
        `track ${track.name} (${track.id}) ${effect.type} fxId=${fxId} bypass ${previous.bypassed} -> ${effect.bypassed}`,
      );
    }
    let detailed = previous.bypassed !== effect.bypassed;
    for (const paramId of new Set([...Object.keys(previous.params), ...Object.keys(effect.params)])) {
      const from = previous.params[paramId];
      const to = effect.params[paramId];
      if (from === to) continue;
      detailed = true;
      lines.push(
        `track ${track.name} (${track.id}) ${effect.type} fxId=${fxId}.${paramId} ${from ?? "default"} -> ${to ?? "default"}`,
      );
    }
    if (!detailed && previous !== effect) {
      lines.push(`track ${track.name} (${track.id}) ${effect.type} fxId=${fxId} configuration changed`);
    }
  }
  if (
    before.map((fx) => fx.id).join("\u0000") !== after.map((fx) => fx.id).join("\u0000") &&
    before.length === after.length
  ) {
    lines.push(`track ${track.name} (${track.id}) FX insert order changed`);
  }
  return lines;
}

export function summarizeDocumentChange(before: ProjectDocument, after: ProjectDocument): DocumentChangeSummary {
  if (before === after) return { changed: false, lines: [] };
  const lines: string[] = [];

  if (before.bpm !== after.bpm) lines.push(`tempo ${before.bpm} -> ${after.bpm} BPM`);
  if (before.key !== after.key) lines.push(`key ${before.key ?? "none"} -> ${after.key ?? "none"}`);
  if (JSON.stringify(before.timeSignature) !== JSON.stringify(after.timeSignature)) {
    const a = before.timeSignature;
    const b = after.timeSignature;
    lines.push(`meter ${a.numerator}/${a.denominator} -> ${b.numerator}/${b.denominator}`);
  }
  if (before.name !== after.name) lines.push(`project name "${before.name}" -> "${after.name}"`);

  const beforeTracks = new Map(before.tracks.map((track) => [track.id, track]));
  const afterTracks = new Map(after.tracks.map((track) => [track.id, track]));
  for (const [id, track] of afterTracks) {
    const previous = beforeTracks.get(id);
    if (previous == null) {
      lines.push(`added track ${trackLabel(track)} (${track.kind})`);
      continue;
    }
    if (previous === track) continue;
    if (previous.name !== track.name)
      lines.push(`renamed track trackId=${track.id} "${previous.name}" -> "${track.name}"`);
    if (previous.kind !== track.kind) lines.push(`track ${trackLabel(track)} kind ${previous.kind} -> ${track.kind}`);
    if (previous.gain !== track.gain) lines.push(`track ${trackLabel(track)} gain ${previous.gain} -> ${track.gain}`);
    if (previous.pan !== track.pan) lines.push(`track ${trackLabel(track)} pan ${previous.pan} -> ${track.pan}`);
    if (previous.mute !== track.mute) lines.push(`track ${trackLabel(track)} mute ${previous.mute} -> ${track.mute}`);
    if (previous.solo !== track.solo) lines.push(`track ${trackLabel(track)} solo ${previous.solo} -> ${track.solo}`);
    if (!sameRef(previous.effects, track.effects)) {
      const effectLines = effectChangeLines(track, previous.effects, track.effects);
      if (effectLines.length > 0) lines.push(...effectLines);
      else {
        const a = fxTypes(previous);
        const b = fxTypes(track);
        lines.push(`track ${trackLabel(track)} FX [${a.join(", ")}] -> [${b.join(", ")}]`);
      }
    }
  }
  for (const [id, track] of beforeTracks) {
    if (!afterTracks.has(id)) lines.push(`removed track ${trackLabel(track)}`);
  }

  lines.push(...entityChangeLines("pattern", before.patterns, after.patterns));
  if (before.activePatternId !== after.activePatternId) {
    const active = after.patterns.find((pattern) => pattern.id === after.activePatternId);
    lines.push(`active pattern -> "${active?.name ?? after.activePatternId}"`);
  }

  lines.push(...entityChangeLines("scene", before.scenes, after.scenes));

  const clipsBefore = before.arrangement.clips;
  const clipsAfter = after.arrangement.clips;
  lines.push(...entityChangeLines("scene clip", clipsBefore, clipsAfter));
  const audioBefore = before.arrangement.audioClips ?? [];
  const audioAfter = after.arrangement.audioClips ?? [];
  lines.push(...entityChangeLines("audio clip", audioBefore, audioAfter));

  if (before.markers.length !== after.markers.length) {
    lines.push(`markers ${before.markers.length} -> ${after.markers.length}`);
  } else if (!sameRef(before.markers, after.markers)) {
    lines.push("markers changed");
  }

  if (before.automation.length !== after.automation.length) {
    lines.push(`automation lanes ${before.automation.length} -> ${after.automation.length}`);
  } else if (!sameRef(before.automation, after.automation)) {
    lines.push("automation points changed");
  }

  if (!sameRef(before.master, after.master)) lines.push("master chain changed");
  if (!sameRef(before.returns, after.returns)) lines.push("return buses changed");

  // The rest of the document — the areas a read-back used to stay silent
  // about, so a mutation there produced "something changed" and nothing more.
  const collections = [
    collectionLine("scene automation", before.sceneAutomation, after.sceneAutomation),
    collectionLine("macros", before.macros, after.macros),
    collectionLine("LFOs", before.lfos, after.lfos),
    collectionLine("live sets", before.liveSets ?? [], after.liveSets ?? []),
    ...entityChangeLines("MIDI clip", before.arrangement.midiClips ?? [], after.arrangement.midiClips ?? []),
    ...entityChangeLines(
      "automation clip",
      before.arrangement.automationClips ?? [],
      after.arrangement.automationClips ?? [],
    ),
    collectionLine("take groups", before.arrangement.takeGroups ?? [], after.arrangement.takeGroups ?? []),
    collectionLine("transitions", before.arrangement.transitions ?? [], after.arrangement.transitions ?? []),
    collectionLine("chords", before.arrangement.chords ?? [], after.arrangement.chords ?? []),
    collectionLine("clip groups", before.arrangement.clipGroups ?? [], after.arrangement.clipGroups ?? []),
  ].filter((line): line is string => line !== null);
  lines.push(...collections);

  if (before.groove !== after.groove) lines.push("groove changed");
  if (JSON.stringify(before.tags ?? []) !== JSON.stringify(after.tags ?? [])) lines.push("project tags changed");

  const visible = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) visible.push(`... and ${lines.length - MAX_LINES} more change(s)`);
  // The document moved but nothing above says where — say THAT instead of
  // handing the agent an empty read-back.
  if (visible.length === 0) visible.push("document metadata changed");
  return { changed: true, lines: visible };
}
