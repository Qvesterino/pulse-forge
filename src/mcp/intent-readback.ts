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
  return `"${track.name}"`;
}

function fxTypes(track: ProjectDocument["tracks"][number]): string[] {
  return track.effects.map((fx) => `${fx.type}${fx.bypassed ? " (bypassed)" : ""}`);
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
    if (previous.name !== track.name) lines.push(`renamed track "${previous.name}" -> "${track.name}"`);
    if (previous.kind !== track.kind) lines.push(`track ${trackLabel(track)} kind ${previous.kind} -> ${track.kind}`);
    if (previous.gain !== track.gain) lines.push(`track ${trackLabel(track)} gain ${previous.gain} -> ${track.gain}`);
    if (previous.pan !== track.pan) lines.push(`track ${trackLabel(track)} pan ${previous.pan} -> ${track.pan}`);
    if (previous.mute !== track.mute) lines.push(`track ${trackLabel(track)} mute ${previous.mute} -> ${track.mute}`);
    if (previous.solo !== track.solo) lines.push(`track ${trackLabel(track)} solo ${previous.solo} -> ${track.solo}`);
    if (!sameRef(previous.effects, track.effects)) {
      const a = fxTypes(previous);
      const b = fxTypes(track);
      if (a.join(",") !== b.join(","))
        lines.push(`track ${trackLabel(track)} FX [${a.join(", ")}] -> [${b.join(", ")}]`);
      else lines.push(`track ${trackLabel(track)} FX parameters changed`);
    }
  }
  for (const [id, track] of beforeTracks) {
    if (!afterTracks.has(id)) lines.push(`removed track ${trackLabel(track)}`);
  }

  if (before.patterns.length !== after.patterns.length) {
    lines.push(`patterns ${before.patterns.length} -> ${after.patterns.length}`);
  } else if (!sameRef(before.patterns, after.patterns)) {
    const beforeById = new Map(before.patterns.map((pattern) => [pattern.id, pattern]));
    for (const pattern of after.patterns) {
      const previous = beforeById.get(pattern.id);
      if (previous == null) continue;
      if (previous === pattern) continue;
      if (previous.name !== pattern.name) lines.push(`renamed pattern "${previous.name}" -> "${pattern.name}"`);
      if (previous.stepCount !== pattern.stepCount) {
        lines.push(`pattern "${pattern.name}" steps ${previous.stepCount} -> ${pattern.stepCount}`);
      }
      if (
        !sameRef(previous.rows, pattern.rows) ||
        !sameRef(previous.notes, pattern.notes) ||
        !sameRef(previous.stepMeta, pattern.stepMeta)
      ) {
        lines.push(`pattern "${pattern.name}" content changed`);
      }
    }
  }
  if (before.activePatternId !== after.activePatternId) {
    const active = after.patterns.find((pattern) => pattern.id === after.activePatternId);
    lines.push(`active pattern -> "${active?.name ?? after.activePatternId}"`);
  }

  if (before.scenes.length !== after.scenes.length) {
    lines.push(`scenes ${before.scenes.length} -> ${after.scenes.length}`);
  } else if (!sameRef(before.scenes, after.scenes)) {
    const beforeById = new Map(before.scenes.map((scene) => [scene.id, scene]));
    for (const scene of after.scenes) {
      const previous = beforeById.get(scene.id);
      if (previous == null || previous === scene) continue;
      if (previous.name !== scene.name) lines.push(`renamed scene "${previous.name}" -> "${scene.name}"`);
      else if (previous.intensity !== scene.intensity)
        lines.push(`scene "${scene.name}" intensity -> ${scene.intensity}`);
    }
  }

  const clipsBefore = before.arrangement.clips;
  const clipsAfter = after.arrangement.clips;
  if (clipsBefore.length !== clipsAfter.length) {
    lines.push(`scene clips ${clipsBefore.length} -> ${clipsAfter.length}`);
  } else if (!sameRef(clipsBefore, clipsAfter)) {
    const changed = clipsAfter.filter((clip, index) => clip !== clipsBefore[index]).length;
    if (changed > 0) lines.push(`${changed} scene clip(s) changed`);
  }
  const audioBefore = before.arrangement.audioClips ?? [];
  const audioAfter = after.arrangement.audioClips ?? [];
  if (audioBefore.length !== audioAfter.length) {
    lines.push(`audio clips ${audioBefore.length} -> ${audioAfter.length}`);
  } else if (!sameRef(audioBefore, audioAfter)) {
    const changed = audioAfter.filter((clip, index) => clip !== audioBefore[index]).length;
    if (changed > 0) lines.push(`${changed} audio clip(s) changed`);
  }

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
    collectionLine("midi clips", before.arrangement.midiClips ?? [], after.arrangement.midiClips ?? []),
    collectionLine(
      "automation clips",
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
