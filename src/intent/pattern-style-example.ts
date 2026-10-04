import { DEFAULT_GENERATE_OPTIONS, GENRES } from "../ai/types";
import type { Pattern, ProjectDocument } from "../project-model/types";
import type { StyleExampleV1 } from "./style-example-ledger";

const STEPS_PER_BAR = 16;

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function genreFrom(value: unknown): string | null {
  return typeof value === "string" && (GENRES as readonly string[]).includes(value) ? value : null;
}

function genreFromTags(tags: readonly string[] | undefined): string | null {
  for (const tag of tags ?? []) {
    const found = genreFrom(tag.trim().toLowerCase());
    if (found) return found;
  }
  return null;
}

function normalizedContentHash(doc: ProjectDocument, pattern: Pattern): string {
  const pads = doc.tracks.filter((track) => track.kind === "drum").flatMap((track) => track.pads);
  const rows = pads.map((pad) => pattern.rows[pad.id] ?? []);
  const notes = doc.tracks
    .filter((track) => track.kind === "instrument")
    .flatMap((track) => pattern.notes[track.id] ?? [])
    .map(({ pitch, start, duration, velocity }) => [pitch, start, duration, velocity])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
  const stepMeta = pads.map((pad) =>
    Object.entries(pattern.stepMeta?.[pad.id] ?? {})
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([step, meta]) => [step, meta]),
  );
  return stableHash(JSON.stringify([pattern.stepCount, rows, notes, stepMeta]));
}

/**
 * Extract a compact, deterministic style summary from a pattern. No project
 * or note payload is retained in the user-level ledger.
 */
export function patternStyleExampleFromProject(
  doc: ProjectDocument,
  pattern: Pattern,
  intentGenre?: string | null,
): StyleExampleV1 | null {
  const pads = doc.tracks.filter((track) => track.kind === "drum").flatMap((track) => track.pads);
  const drumHits: Array<{ padIndex: number; step: number; velocity: number }> = [];
  pads.forEach((pad, padIndex) => {
    (pattern.rows[pad.id] ?? []).forEach((velocity, step) => {
      if (Number.isFinite(velocity) && velocity > 0) drumHits.push({ padIndex, step, velocity });
    });
  });

  const noteEvents = doc.tracks
    .filter((track) => track.kind === "instrument")
    .flatMap((track) => pattern.notes[track.id] ?? []);
  if (drumHits.length === 0 && noteEvents.length === 0) return null;

  const stepCount = Math.max(1, pattern.stepCount);
  const velocities =
    drumHits.length > 0 ? drumHits.map((hit) => hit.velocity) : noteEvents.map((note) => note.velocity);
  const velocityScale = Math.max(...velocities) <= 1 ? 1 : 127;
  const energy = clamp01(
    velocities.reduce((sum, velocity) => sum + velocity, 0) / Math.max(1, velocities.length) / velocityScale,
  );
  const density =
    drumHits.length > 0 ? clamp01(drumHits.length / (stepCount * 2)) : clamp01(noteEvents.length / stepCount);
  const offbeatRatio = drumHits.length > 0 ? drumHits.filter((hit) => hit.step % 4 !== 0).length / drumHits.length : 0;
  const metaCount = drumHits.filter(({ padIndex, step }) => {
    const padId = pads[padIndex]?.id;
    const meta = padId ? pattern.stepMeta?.[padId]?.[step] : undefined;
    return Boolean(meta && ((meta.ratchet ?? 1) > 1 || (meta.probability ?? 1) < 1 || (meta.microtiming ?? 0) !== 0));
  }).length;
  const velocityMean = velocities.reduce((sum, velocity) => sum + velocity, 0) / velocities.length;
  const velocitySpread =
    Math.sqrt(velocities.reduce((sum, velocity) => sum + (velocity - velocityMean) ** 2, 0) / velocities.length) /
    velocityScale;
  const complexity = clamp01(
    (offbeatRatio + (drumHits.length > 0 ? metaCount / drumHits.length : 0) + velocitySpread) / 3,
  );

  const barCount = Math.ceil(stepCount / STEPS_PER_BAR);
  const barHitCounts = Array.from(
    { length: barCount },
    (_, bar) => drumHits.filter((hit) => Math.floor(hit.step / STEPS_PER_BAR) === bar).length,
  );
  const variation =
    barHitCounts.length > 1
      ? clamp01(
          barHitCounts.slice(1).reduce((sum, count, index) => sum + Math.abs(count - barHitCounts[index]!), 0) /
            ((barHitCounts.length - 1) * Math.max(1, pads.length * STEPS_PER_BAR)),
        )
      : 0.5;

  const genre =
    genreFrom(pattern.generation?.genre) ??
    genreFrom(intentGenre) ??
    genreFromTags(doc.tags) ??
    DEFAULT_GENERATE_OPTIONS.genre;
  const styleSlug =
    pattern.generation?.style
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) ?? "";
  const rawGrooveId = pattern.generation?.grooveId ?? (styleSlug ? `${genre}.${styleSlug}` : "");
  const grooveId = /^[a-zA-Z0-9._:-]{0,128}$/.test(rawGrooveId) ? rawGrooveId : "";
  const contentHash = normalizedContentHash(doc, pattern);

  return {
    version: 1,
    contentHash,
    savedAt: Date.now(),
    genre,
    grooveId,
    energy,
    density,
    complexity,
    variation,
  };
}
