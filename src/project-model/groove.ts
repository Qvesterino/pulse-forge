import type { DrumPad, DrumTrack, Pattern, ProjectDocument, StepMeta } from "./types";
import { STEP_TICKS, grooveOf } from "./types";
import { hashString, mulberry32 } from "../shared/rng";

/**
 * Shared groove engine: turns the step grid of a pattern into concrete,
 * deterministically-timed drum hits. The realtime scheduler and the offline
 * renderer BOTH consume this module, which is what guarantees that exports
 * swing, humanize and roll exactly like playback does.
 *
 * Timing layers applied to each active step (in order):
 *   1. swing       — delays odd 16th steps toward a triplet feel (0..1)
 *   2. microtiming — per-step early/late shift (-1..1)
 *   3. humanize    — seeded random timing + velocity variation
 * Probability is a seeded per-(pattern, pad, step, pass) roll, and ratchets
 * split the slot into evenly spaced retriggers with a gentle velocity decay.
 */

/** Maximum microtiming shift as a fraction of a step (±30 ticks at 16 steps). */
export const MAX_MICRO_TIMING = STEP_TICKS * 0.3;
/** Maximum humanize timing jitter as a fraction of a step. */
export const MAX_HUMANIZE_TIMING = STEP_TICKS * 0.25;
/** Maximum humanize velocity deviation (±). */
export const MAX_HUMANIZE_VELOCITY = 0.25;
/** Per-ratchet-hit velocity decay so rolls sound natural, not machine-gunned. */
export const RATCHET_DECAY = 0.88;
export const MAX_RATCHET = 8;

export interface DrumHit {
  trackId: string;
  pad: DrumPad;
  /** Absolute tick (may be fractional after groove shifts). */
  tick: number;
  velocity: number;
  /** 0 for the main hit, 1..n for ratchet retriggers. */
  ratchetIndex: number;
  /** Per-step p-lock overrides for this hit (absolute). */
  locks?: Partial<Record<import("./types").StepLockKey, number>>;
}

const mod = (value: number, m: number): number => ((value % m) + m) % m;

export function metaOf(pattern: Pattern, padId: string, stepIndex: number): StepMeta | null {
  return pattern.stepMeta?.[padId]?.[stepIndex] ?? null;
}

// ── Seeded RNG without per-hit string allocation ──────────────────────────
// The hot path (drumHitsInWindow) previously allocated a template string
// `${pattern.id}|${padId}|${stepIndex}|${pass}` per (pad × step × pass).
// We instead hash numeric ids and combine them — zero heap allocation per hit.
// Pattern/pad string hashes are cached (bounded: evicted FIFO when large).
const PATTERN_HASH_CACHE = new Map<string, number>();
const PAD_HASH_CACHE = new Map<string, number>();
const HASH_CACHE_LIMIT = 2048;

function cachedHash(cache: Map<string, number>, key: string): number {
  let h = cache.get(key);
  if (h !== undefined) return h;
  h = hashString(key);
  if (cache.size >= HASH_CACHE_LIMIT) {
    const first = cache.keys().next().value as string | undefined;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, h);
  return h;
}

function hashCombine(a: number, b: number): number {
  return Math.imul(a ^ b, 16777619) >>> 0;
}

function seededRand(pattern: Pattern, padId: string, stepIndex: number, pass: number): () => number {
  const base = hashCombine(cachedHash(PATTERN_HASH_CACHE, pattern.id), cachedHash(PAD_HASH_CACHE, padId));
  return mulberry32(hashCombine(hashCombine(base, stepIndex), pass));
}

/** Swing offset in ticks for a step index (odd 16ths are delayed). */
export function swingOffsetTicks(stepIndex: number, swing: number): number {
  if (swing <= 0) return 0;
  return stepIndex % 2 === 1 ? Math.min(1, Math.max(0, swing)) * STEP_TICKS * 0.5 : 0;
}

/**
 * Compute all drum hits of `pattern` whose final (groove-shifted) tick falls
 * inside [fromTick, toTick). `base` is the absolute tick the pattern aligns
 * to (clip start in song mode, 0 in pattern mode).
 */
export function drumHitsInWindow(
  doc: ProjectDocument,
  pattern: Pattern,
  base: number,
  fromTick: number,
  toTick: number,
): DrumHit[] {
  const hits: DrumHit[] = [];
  const patternTicks = STEP_TICKS * pattern.stepCount;
  if (patternTicks <= 0 || toTick <= fromTick) return hits;

  const { swing, humanizeTiming, humanizeVelocity } = grooveOf(doc);
  const tracks = doc.tracks.filter((t): t is DrumTrack => t.kind === "drum");
  const anyTrackSolo = doc.tracks.some((t) => t.solo);

  // Iterate one extra grid step on each side so groove-shifted hits that
  // cross a window edge land in exactly one window (the [from, to) filter
  // below is the single source of truth).
  const firstGrid = base + Math.ceil((fromTick - base) / STEP_TICKS - 1e-9) * STEP_TICKS - STEP_TICKS;
  const lastGrid = base + Math.floor((toTick - base) / STEP_TICKS + 1e-9) * STEP_TICKS + STEP_TICKS;

  for (let t = firstGrid; t <= lastGrid; t += STEP_TICKS) {
    const rel = t - base;
    const stepIndex = Math.floor(mod(rel, patternTicks) / STEP_TICKS) % pattern.stepCount;
    const pass = Math.floor(rel / patternTicks);

    for (const track of tracks) {
      if (track.mute || (anyTrackSolo && !track.solo)) continue;
      const anyPadSolo = track.pads.some((p) => p.solo);
      for (const pad of track.pads) {
        const velocity = pattern.rows[pad.id]?.[stepIndex] ?? 0;
        if (velocity <= 0 || pad.mute || (anyPadSolo && !pad.solo)) continue;

        const meta = metaOf(pattern, pad.id, stepIndex);
        const rand = seededRand(pattern, pad.id, stepIndex, pass);

        const probability = meta?.probability ?? 1;
        if (probability < 1 && rand() >= clamp01(probability)) continue;

        const micro = clampRange(meta?.microtiming ?? 0, -1, 1) * MAX_MICRO_TIMING;
        const jitter = humanizeTiming > 0 ? (rand() * 2 - 1) * clamp01(humanizeTiming) * MAX_HUMANIZE_TIMING : 0;
        const tick = t + swingOffsetTicks(stepIndex, swing) + micro + jitter;
        // NOTE: no parent-level window gate here. The per-hit filter below is
        // the single source of truth. Gating the parent used to drop ratchet
        // TAILS: a parent near a window edge whose tail sub-hits cross into
        // the next window was rejected by that window's parent gate
        // (tick < fromTick) after this window had filtered the tail out —
        // the tail played nowhere. The ±1-step scan margin above already
        // covers every parent whose tail can reach this window (max tail is
        // under one step), and the seeded draws keep identical order either
        // way, so replay stays deterministic and each hit lands in exactly
        // one window.

        let finalVelocity = velocity;
        if (humanizeVelocity > 0) {
          finalVelocity += (rand() * 2 - 1) * clamp01(humanizeVelocity) * MAX_HUMANIZE_VELOCITY;
        }
        finalVelocity = clampRange(finalVelocity, 0.05, 1);
        // Per-step amount — 0..1 velocity/mod depth (ghost vs accent). Default 1.
        if (meta?.amount !== undefined) {
          finalVelocity = clampRange(finalVelocity * clamp01(meta.amount), 0.05, 1);
        }

        const ratchet = Math.min(MAX_RATCHET, Math.max(1, Math.round(meta?.ratchet ?? 1)));
        const subdivision = STEP_TICKS / ratchet;
        // Defect A.3 (performance / memory recon): every ratchet
        // sub-hit used to clone `meta.locks` via `{ ...meta.locks }`,
        // allocating one object per hit. Pattern stepMeta is treated
        // as immutable across the project (commands always build a
        // fresh doc; see `commands.ts:518, 3289, 3398` for the
        // canonical "spread the locks if present" pattern on the
        // *write* side), and downstream consumers — `Scheduler.trigger`,
        // `AudioEngine.trigger`, `rendering/renderer.ts` — only read
        // `hit.locks`. We therefore pass the reference through; the
        // hit objects are short-lived (one 25 ms window) so the
        // shared reference is GC-safe.
        const locks = meta?.locks && Object.keys(meta.locks).length > 0 ? meta.locks : undefined;
        for (let k = 0; k < ratchet; k++) {
          const hitTick = tick + k * subdivision;
          if (hitTick < fromTick || hitTick >= toTick) continue;
          hits.push({
            trackId: track.id,
            pad,
            tick: hitTick,
            velocity: k === 0 ? finalVelocity : clampRange(finalVelocity * Math.pow(RATCHET_DECAY, k), 0.05, 1),
            ratchetIndex: k,
            ...(locks ? { locks } : {}),
          });
        }
      }
    }
  }

  hits.sort((a, b) => a.tick - b.tick);
  return hits;
}

function clamp01(value: number): number {
  return clampRange(value, 0, 1);
}

function clampRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
