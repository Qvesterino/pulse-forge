/**
 * bench-hotpath — measures whether the A.3 / A.4 / B.7 / C.5 hot-path
 * optimisations actually pay off, using old-vs-new implementations measured
 * side-by-side in the SAME process (same V8, same heap, same JIT state).
 *
 * Method: for each defect we re-implement the PRE-fix algorithm verbatim
 * (extracted from git history) as a local `*_legacy()` function, then
 * interleave A/B rounds so thermal drift and GC timing bias hit both sides
 * equally. We report median-of-rounds, not a single sample, and we report
 * the allocation delta too — the whole point of these fixes was to stop
 * allocating, so time alone would understate the win.
 *
 * Run:  npx vite-node scripts/bench-hotpath.ts
 *       npx vite-node scripts/bench-hotpath.ts --iterations 15
 */
import { PerformanceObserver } from "node:perf_hooks";
import { noteEventsInWindow } from "../src/project-model/events";
import { MeterRing } from "../src/audio-engine/MeterRing";
import { createProjectFromTemplate, emptyPattern, note, withNotes } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { snapshot } from "../src/commands/commands";
import { STEP_TICKS, grooveOf } from "../src/project-model/types";
import { mulberry32 } from "../src/shared/rng";
import type { DrumTrack, Pattern, ProjectDocument } from "../src/project-model/types";
import type { DeltaOp } from "../src/commands/docDelta";
import { computeDocDelta, applyDocDelta, deepEqualRef } from "../src/commands/docDelta";

const args = process.argv.slice(2);
function flagValue(name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i === args.length - 1) return fallback;
  const parsed = Number(args[i + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const ITERATIONS = flagValue("iterations", 9);
const WARMUP = 2;

// ─── GC observer (scoped, so the microbench never leaves a listener behind) ──

let gcCount = 0;
let gcTimeMs = 0;
let observingGc = false;

function startGcObserver(): void {
  if (observingGc) return;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gcCount++;
        gcTimeMs += entry.duration;
      }
    });
    obs.observe({ entryTypes: ["gc"] });
    observingGc = true;
  } catch {
    // Some Node builds disallow the 'gc' entry type. We degrade to
    // allocation-delta measurement only — see `collect`.
  }
}

function resetGc(): void {
  gcCount = 0;
  gcTimeMs = 0;
}

async function collect<T>(fn: () => T): Promise<{ value: T; ms: number }> {
  // Force a full GC before the timed run where exposed, so we measure the
  // steady-state cost of `fn` rather than whatever garbage the previous
  // round left behind.
  const g = globalThis as unknown as { gc?: () => void };
  if (g.gc) g.gc();
  const t0 = performance.now();
  const value = fn();
  const ms = performance.now() - t0;
  return { value, ms };
}

interface ABLegacy {
  name: string;
  msCurrent: number;
  msLegacy: number;
  bytesCurrent: number;
  bytesLegacy: number;
  gcCurrent: number;
  gcLegacy: number;
  speedup: number;
  allocDelta: number;
}

/**
 * Batched allocation probe. `heapUsed` growth across K calls (results
 * discarded, so nothing is retained) divided by K is the per-call allocation
 * rate — the standard way to measure this without a heap profiler. GC events
 * observed during the batch are collected too: more GC on one side is
 * independent evidence that the other side is cheaper.
 */
const ALLOC_BATCH = 200;

async function measureAlloc(fn: () => unknown): Promise<{ bytesPerCall: number; gcPerBatch: number }> {
  const g = globalThis as unknown as { gc?: () => void };
  if (g.gc) g.gc();
  resetGc();
  const before = process.memoryUsage().heapUsed;
  let sink: unknown;
  for (let i = 0; i < ALLOC_BATCH; i++) sink = fn();
  // Keep the last result alive so nothing is optimistically elided, but
  // don't retain the whole batch.
  void sink;
  const bytesPerCall = (process.memoryUsage().heapUsed - before) / ALLOC_BATCH;
  return { bytesPerCall, gcPerBatch: gcCount / ALLOC_BATCH };
}

async function ab(name: string, currentFn: () => unknown, legacyFn: () => unknown): Promise<ABLegacy> {
  // Warm both sides so neither pays first-call compilation cost.
  for (let i = 0; i < WARMUP; i++) {
    currentFn();
    legacyFn();
  }
  const curSamples: number[] = [];
  const legSamples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    // Alternate order each round so a systematic bias cancels out.
    const a = await collect(i % 2 === 0 ? currentFn : legacyFn);
    const b = await collect(i % 2 === 0 ? legacyFn : currentFn);
    const cur = i % 2 === 0 ? a : b;
    const leg = i % 2 === 0 ? b : a;
    curSamples.push(cur.ms);
    legSamples.push(leg.ms);
  }
  const curAlloc = await measureAlloc(currentFn);
  const legAlloc = await measureAlloc(legacyFn);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const msCurrent = median(curSamples);
  const msLegacy = median(legSamples);
  return {
    name,
    msCurrent,
    msLegacy,
    bytesCurrent: curAlloc.bytesPerCall,
    bytesLegacy: legAlloc.bytesPerCall,
    gcCurrent: curAlloc.gcPerBatch,
    gcLegacy: legAlloc.gcPerBatch,
    speedup: msLegacy / msCurrent,
    allocDelta: legAlloc.bytesPerCall - curAlloc.bytesPerCall,
  };
}

// ─── B.7: meter history ring buffer ────────────────────────────────────────

/** Pre-fix meter history: `number[]` with spread-push + splice-on-overshoot. */
class LegacyMeterHistory {
  private l: number[] = [];
  private r: number[] = [];
  constructor(
    private maxSamples: number,
  ) {}
  push(bufL: Float32Array, bufR: Float32Array): void {
    this.l.push(...bufL);
    this.r.push(...bufR);
    if (this.l.length > this.maxSamples) {
      this.l.splice(0, this.l.length - this.maxSamples);
      this.r.splice(0, this.r.length - this.maxSamples);
    }
  }
  /** Pre-fix window extraction — slice + Float32Array.from. */
  window(seconds: number, sampleRate: number): [Float32Array, Float32Array] {
    const length = Math.min(this.l.length, Math.max(1, Math.round(seconds * sampleRate)));
    return [Float32Array.from(this.l.slice(-length)), Float32Array.from(this.r.slice(-length))];
  }
  reset(): void {
    this.l = [];
    this.r = [];
  }
}

function benchB7(): Promise<ABLegacy> {
  const SAMPLE_RATE = 44100;
  const CHUNK = new Float32Array(2048);
  for (let i = 0; i < CHUNK.length; i++) CHUNK[i] = Math.sin(i / 64);
  // Production shape: a full 3.2 s meter window already filled, then more
  // chunks arrive — this is where the legacy splice actually runs.
  const maxSamples = Math.ceil(SAMPLE_RATE * 3.2);

  let ring = new MeterRing(Math.ceil(96000 * 3.2));
  // Pre-fill both so `length > maxSamples` on the first push.
  for (let i = 0; i < Math.ceil((maxSamples / CHUNK.length) * 1.1); i++) ring.push(CHUNK);

  const legacy = new LegacyMeterHistory(maxSamples);
  for (let i = 0; i < Math.ceil((maxSamples / CHUNK.length) * 1.1); i++) legacy.push(CHUNK, CHUNK);

  return ab(
    "B.7  meter history push + window (0.4 s momentary + 3 s short-term)",
    () => {
      ring.push(CHUNK);
      ring.lastN(Math.round(0.4 * SAMPLE_RATE));
      ring.lastN(Math.round(3 * SAMPLE_RATE));
    },
    () => {
      legacy.push(CHUNK, CHUNK);
      legacy.window(0.4, SAMPLE_RATE);
      legacy.window(3, SAMPLE_RATE);
    },
  );
}

// ─── A.3: drumHitsInWindow p-lock clone ────────────────────────────────────

/**
 * Faithful mirror of `drumHitsInWindow` with ONE switchable line: whether
 * `meta.locks` is cloned per sub-hit (pre-fix) or passed by reference
 * (post-fix). Everything else — the grid scan, per-track solo map, seeded
 * probability rolls, swing, microtiming, humanize, ratchet decay, sample-id
 * resolution and the final sort — is byte-for-byte the shipped algorithm.
 *
 * The first version of this bench compared the real `drumHitsInWindow`
 * against a stripped-down loop and reported a fake 4.4x regression. The
 * real function does ~15x more work per call than that stub, so the
 * comparison measured the missing groove math, not the lock clone. An
 * A/B harness is only meaningful when both sides run the same work.
 */
function mirrorDrumHits(
  doc: ProjectDocument,
  pattern: Pattern,
  base: number,
  fromTick: number,
  toTick: number,
  cloneLocks: boolean,
): unknown[] {
  const hits: unknown[] = [];
  const patternTicks = STEP_TICKS * pattern.stepCount;
  if (patternTicks <= 0 || toTick <= fromTick) return hits;

  const { swing, humanizeTiming, humanizeVelocity } = grooveOf(doc);
  const tracks = doc.tracks.filter((t): t is DrumTrack => t.kind === "drum");
  const anyTrackSolo = doc.tracks.some((t) => t.solo);

  const firstGrid = base + Math.ceil((fromTick - base) / STEP_TICKS - 1e-9) * STEP_TICKS - STEP_TICKS;
  const lastGrid = base + Math.floor((toTick - base) / STEP_TICKS + 1e-9) * STEP_TICKS + STEP_TICKS;

  const anyPadSoloByTrack = new Map<string, boolean>();
  for (const track of tracks) anyPadSoloByTrack.set(track.id, track.pads.some((p) => p.solo));

  const mod = (n: number, m: number): number => ((n % m) + m) % m;
  const clampRange = (v: number, lo: number, hi: number): number =>
    !Number.isFinite(v) ? lo : Math.min(hi, Math.max(lo, v));
  const clamp01 = (v: number): number => clampRange(v, 0, 1);

  for (let t = firstGrid; t <= lastGrid; t += STEP_TICKS) {
    const rel = t - base;
    const stepIndex = Math.floor(mod(rel, patternTicks) / STEP_TICKS) % pattern.stepCount;
    const pass = Math.floor(rel / patternTicks);
    for (const track of tracks) {
      if (track.mute || (anyTrackSolo && !track.solo)) continue;
      const anyPadSolo = anyPadSoloByTrack.get(track.id) ?? false;
      for (const pad of track.pads) {
        const velocity = pattern.rows[pad.id]?.[stepIndex] ?? 0;
        if (velocity <= 0 || pad.mute || (anyPadSolo && !pad.solo)) continue;
        const meta = pattern.stepMeta?.[pad.id]?.[stepIndex];
        const rand = mulberry32(stepIndex * 2654435761 + (pass | 0));
        const probability = meta?.probability ?? 1;
        if (probability < 1 && rand() >= clamp01(probability)) continue;
        const micro = clampRange(meta?.microtiming ?? 0, -1, 1) * (STEP_TICKS * 0.3);
        const jitter = humanizeTiming > 0 ? (rand() * 2 - 1) * clamp01(humanizeTiming) * (STEP_TICKS * 0.25) : 0;
        const tick = t + (stepIndex % 2 === 1 ? clamp01(swing) * STEP_TICKS * 0.5 : 0) + micro + jitter;
        let finalVelocity = velocity;
        if (humanizeVelocity > 0) finalVelocity += (rand() * 2 - 1) * clamp01(humanizeVelocity) * 0.25;
        finalVelocity = clampRange(finalVelocity, 0.05, 1);
        if (meta?.amount !== undefined) finalVelocity = clampRange(finalVelocity * clamp01(meta.amount), 0.05, 1);
        const ratchet = Math.min(8, Math.max(1, Math.round(meta?.ratchet ?? 1)));
        const subdivision = STEP_TICKS / ratchet;
        const stepOrdinal = Math.round(t / STEP_TICKS);
        // ── THE ONLY DIFFERING LINE ──
        const locks =
          cloneLocks && meta?.locks && Object.keys(meta.locks).length > 0
            ? { ...meta.locks }
            : meta?.locks && Object.keys(meta.locks).length > 0
              ? meta.locks
              : undefined;
        for (let k = 0; k < ratchet; k++) {
          const hitTick = tick + k * subdivision;
          if (hitTick < fromTick || hitTick >= toTick) continue;
          const hitVelocity = k === 0 ? finalVelocity : clampRange(finalVelocity * Math.pow(0.88, k), 0.05, 1);
          hits.push({
            trackId: track.id,
            pad,
            tick: hitTick,
            velocity: hitVelocity,
            ratchetIndex: k,
            ...(locks ? { locks } : {}),
            ...(stepOrdinal + k ? { sampleId: `${pad.id}:${(stepOrdinal + k) % 2}` } : {}),
          });
        }
      }
    }
  }
  return hits.sort((a, b) => (a as { tick: number }).tick - (b as { tick: number }).tick);
}

function benchA3(): Promise<ABLegacy> {
  const doc = createProjectFromTemplate("techno");
  const drums = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
  const kickId = drums.pads[0].id;
  const PATTERN_STEPS = 64;
  // Groove on, so the mirror exercises the same probability/swing/humanize
  // work the shipped function does — otherwise the clone line is swamped.
  const seeded: ProjectDocument = {
    ...doc,
    groove: { ...doc.groove, humanizeTiming: 0.4, humanizeVelocity: 0.3, swing: 0.15 },
    patterns: doc.patterns.map((p) => {
      const rows = { ...p.rows };
      const stepMeta: NonNullable<typeof p.stepMeta> = {};
      rows[kickId] = new Array<number>(p.stepCount).fill(0);
      for (let step = 0; step < Math.min(p.stepCount, PATTERN_STEPS); step++) {
        rows[kickId][step] = 0.8;
        stepMeta[kickId] = stepMeta[kickId] ?? {};
        // Ratchet every 4th step so the clone ran multiple times per step.
        stepMeta[kickId][step] = {
          ratchet: step % 4 === 0 ? 3 : 1,
          probability: 0.9,
          locks: { pitch: step % 5, gain: 0.4 + (step % 3) / 10 },
        };
      }
      return { ...p, rows, stepMeta };
    }),
  };
  const normalized = normalizeProject(seeded);
  const pattern = normalized.patterns[0];
  const ticks = pattern.stepCount * STEP_TICKS;

  const currentRun = () => mirrorDrumHits(normalized, pattern, 0, 0, ticks, false);
  const legacyRun = () => mirrorDrumHits(normalized, pattern, 0, 0, ticks, true);

  return ab("A.3  drumHitsInWindow p-lock clone (64 steps, ratchet+p-locks)", currentRun, legacyRun);
}

// ─── A.4: noteEventsInWindow sort comparator ───────────────────────────────

function benchA4(): Promise<ABLegacy> {
  const doc = createProjectFromTemplate("house");
  const drums = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
  const trackIds = ["trk-8fa31c", "trk-0be24d", "trk-91c7aa", "trk-4d0e1b", "trk-77b3f2", "trk-2c6e90"];
  let pattern = emptyPattern("bench", [drums], 16);
  for (const [i, id] of trackIds.entries()) {
    pattern = withNotes(
      pattern,
      id,
      Array.from({ length: 8 }, (_, n) => note(48 + (i % 12), n * STEP_TICKS, STEP_TICKS * 2, 0.7)),
    );
  }
  const ticks = 16 * STEP_TICKS;

  // Legacy: localeCompare on the tie-break axis, exactly as pre-fix.
  const legacyRun = () => {
    const events = noteEventsInWindow(pattern, 0, 0, ticks);
    return events.sort(
      (a, b) => a.tick - b.tick || String(a.trackId).localeCompare(String(b.trackId)) || a.note.pitch - b.note.pitch,
    );
  };
  const currentRun = () => noteEventsInWindow(pattern, 0, 0, ticks);

  return ab("A.4  noteEventsInWindow sort (6 tracks × 8 notes = 48 events)", currentRun, legacyRun);
}

// ─── C.5: snapshot() delta self-verification ──────────────────────────────

/** Pre-fix snapshot(): always computes the two applyDocDelta + deepEqualRef checks. */
function legacySnapshot(prev: ProjectDocument, next: ProjectDocument) {
  const forward = computeDocDelta(prev, next);
  const backward = computeDocDelta(next, prev);
  const verified =
    deepEqualRef(applyDocDelta(prev, forward.ops), next) && deepEqualRef(applyDocDelta(next, backward.ops), prev);
  if (!verified) return { execute: () => next, undo: () => prev };
  return {
    execute: (d: ProjectDocument) => applyDocDelta(d, forward.ops as DeltaOp[]),
    undo: (d: ProjectDocument) => applyDocDelta(d, backward.ops as DeltaOp[]),
  };
}

function benchC5(): Promise<ABLegacy> {
  const doc = createProjectFromTemplate("house");
  const drums = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
  const padId = drums.pads[0].id;
  const patternId = doc.patterns[0].id;

  // A representative single-step mutation: what a step click or a velocity
  // drag produces 30-60×/second in a live session.
  const prev = doc;
  const next: ProjectDocument = {
    ...prev,
    patterns: prev.patterns.map((p) => {
      if (p.id !== patternId) return p;
      const row = [...(p.rows[padId] ?? new Array<number>(p.stepCount).fill(0))];
      row[0] = Math.min(1, (row[0] ?? 0) + 0.1);
      return { ...p, rows: { ...p.rows, [padId]: row } };
    }),
  };

  // The optimised path only skips the verify in production. The bench
  // forces production so we measure the shipped behaviour, and separately
  // measures the dev path so we can report the verification cost that CI
  // still pays.
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  const currentRun = () => snapshot("bench", "bench", prev, next);
  const legacyRun = () => legacySnapshot(prev, next);

  const result = ab("C.5  snapshot() on a single-step edit (production mode)", currentRun, legacyRun);
  return result.finally(() => {
    process.env.NODE_ENV = prevNodeEnv;
  });
}

// ─── Report ───────────────────────────────────────────────────────────────

function fmt(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return "n/a";
  if (Math.abs(n) < 0.001) return n.toExponential(2);
  return n.toFixed(digits);
}

function fmtBytes(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${(n / 1024).toFixed(2)} KiB`;
}

async function main(): Promise<void> {
  startGcObserver();
  const gcSupported = observingGc;
  console.log(`\nPulse Forge hot-path benchmark — ${ITERATIONS} iterations/round (median reported), ${WARMUP} warmup`);
  console.log(`Node ${process.version} · ${process.arch} · GC observer: ${gcSupported ? "on" : "unavailable"}`);
  console.log("=".repeat(112));

  const benches = [benchB7(), benchA3(), benchA4(), benchC5()];
  const results: ABLegacy[] = [];
  for (const p of benches) results.push(await p);

  console.log(
    `${"defect".padEnd(66)}${"pre-fix".padStart(12)}${"optimised".padStart(12)}${"speedup".padStart(11)}${"alloc Δ/call".padStart(14)}`,
  );
  console.log("-".repeat(112));
  for (const r of results) {
    const speedupLabel = r.speedup >= 1.005 ? `${r.speedup.toFixed(2)}×` : `0.${Math.round(r.speedup * 100)}×`;
    console.log(
      `${r.name.padEnd(66)}${`${fmt(r.msLegacy, 4)} ms`.padStart(12)}${`${fmt(r.msCurrent, 4)} ms`.padStart(12)}${speedupLabel.padStart(11)}${fmtBytes(r.allocDelta).padStart(14)}`,
    );
  }
  console.log("-".repeat(112));

  if (gcSupported) {
    console.log("\nGC events per call (averaged over the allocation batch):");
    for (const r of results) {
      console.log(
        `  ${r.name.padEnd(66)}${`legacy ${fmt(r.gcLegacy, 4)}`.padStart(14)}${`optimised ${fmt(r.gcCurrent, 4)}`.padStart(14)}`,
      );
    }
  }

  const wins = results.filter((r) => r.speedup > 1.02);
  const losses = results.filter((r) => r.speedup < 0.98);
  console.log("\nVerdict:");
  if (wins.length === 0) {
    console.log("  No measurable win on any defect — the fixes are in the noise on this workload.");
  } else {
    for (const r of wins) {
      console.log(
        `  ✓ ${r.name.split("  ")[0]} ${r.speedup.toFixed(2)}× faster, ${fmtBytes(r.allocDelta)} less allocated per op`,
      );
    }
  }
  for (const r of losses) {
    console.log(`  ✗ ${r.name.split("  ")[0]} REGRESSED ${(1 / r.speedup).toFixed(2)}× — investigate`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
