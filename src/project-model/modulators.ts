import { hashString, mulberry32 } from "../shared/rng";
import { PPQ } from "./types";
import type { AutomationTarget, ID, Lfo, LfoKind } from "./types";

/**
 * Deterministic track-modulator math shared by the realtime scheduler, the
 * offline renderer and the schema sanitizers. Everything here is PURE: the
 * same inputs produce the same event lists regardless of query order, which
 * is what guarantees the live == offline rendering law for schedulable
 * modulators (random / step).
 */

export const STEP_MODULATOR_LENGTHS = [8, 16, 32] as const;

/** Division index (UI 1/1..1/16) → cycle length in quarter-note beats. */
const DIVISION_BEATS = [4, 2, 1, 0.5, 0.25];

export function divisionToBeats(division: number | undefined): number {
  const index = Math.max(0, Math.min(DIVISION_BEATS.length - 1, Math.round(division ?? 2)));
  return DIVISION_BEATS[index];
}

/** Cycle length of one division step / one random-hold, in project ticks. */
export function divisionTicks(division: number | undefined): number {
  return Math.max(24, Math.round(PPQ * divisionToBeats(division)));
}

export function lfoKind(lfo: Lfo): LfoKind {
  return lfo.kind ?? "osc";
}

export function lfoWave(lfo: Lfo): NonNullable<Lfo["wave"]> {
  return lfo.wave ?? "sine";
}

export function lfoRateHz(lfo: Lfo): number {
  return Math.max(0.01, lfo.rateHz ?? 2);
}

/**
 * Effective modulation target. Audio-rate bus (P2): any kind may carry a
 * generic `target`; when present it overrides the legacy `param` selector.
 * Legacy oscillators / followers without `target` keep driving Volume/Pan.
 */
export function resolveLfoTarget(lfo: Lfo): AutomationTarget {
  if (lfo.target) return lfo.target;
  return { kind: lfo.param === "pan" ? "trackPan" : "trackGain", trackId: lfo.trackId };
}

/* ---------------- value functions (stateless by design) ---------------- */

/** Seeded but stateless: any step index can be computed independently. */
export function randomHoldValue(id: string, seed: string | undefined, k: number): number {
  const rng = mulberry32(hashString(`${id}|${seed ?? ""}|${Math.floor(k)}`));
  return rng() * 2 - 1;
}

export function stepsOf(lfo: Lfo): readonly number[] {
  return Array.isArray(lfo.steps) && lfo.steps.length > 0 ? lfo.steps : DEFAULT_STEP_PATTERN;
}

export const DEFAULT_STEP_PATTERN: readonly number[] = [
  0.9, 0, -0.55, 0, 0.7, 0, -0.35, 0.15, 0.9, 0, -0.55, 0.1, 0.7, 0.2, -0.35, 0,
];

export interface ModulatorEvent {
  tick: number;
  /** Raw bipolar output −1..1 (amount NOT applied — appliers scale it). */
  value: number;
  mode: "set" | "ramp";
}

const EVENT_GUARD = 4096;

/** Raw bipolar value (−1..1, amount NOT applied) in effect at an absolute tick. */
export function modulatorPointValue(lfo: Lfo, tick: number): number {
  if (lfo.kind === "random") {
    const hold = divisionTicks(lfo.division);
    return randomHoldValue(lfo.id, lfo.seed, Math.floor(tick / hold));
  }
  if (lfo.kind === "step") {
    const hold = divisionTicks(lfo.division);
    const steps = stepsOf(lfo);
    const index = Math.floor(tick / hold);
    return steps[((index % steps.length) + steps.length) % steps.length];
  }
  return 0;
}

/**
 * Deterministic change-point stream for a schedulable modulator over
 * [fromTick, toTick]. Always starts with a "set" anchor carrying the value in
 * effect at fromTick, followed by transition events ("set" for hard holds,
 * "ramp" when the modulator glides). Events are sorted and deduplicated.
 */
export function modulatorEventsInRange(lfo: Lfo, fromTick: number, toTick: number): ModulatorEvent[] {
  if (lfo.kind !== "random" && lfo.kind !== "step") return [];
  const from = Math.max(0, Math.floor(fromTick));
  const to = Math.max(from, Math.ceil(toTick));
  const hold = divisionTicks(lfo.division);
  const glides = lfo.kind === "random" ? lfo.snh === "glide" : (lfo.glideSec ?? 0) > 0.0005;

  const events: ModulatorEvent[] = [{ tick: from, value: round4(modulatorPointValue(lfo, from)), mode: "set" }];
  let firstBoundary = Math.floor(from / hold) * hold;
  if (firstBoundary <= from) firstBoundary += hold;
  let previous = events[0];
  for (let boundary = firstBoundary; boundary <= to; boundary += hold) {
    if (events.length >= EVENT_GUARD) break;
    const value = round4(modulatorPointValue(lfo, boundary));
    // Identical consecutive holds/ramps are identity writes — collapse them.
    // A later real transition still ramps from the last emitted point, whose
    // value equals the skipped plateau, so the interpolation shape is exact.
    if (Math.abs(previous.value - value) < 1e-6) continue;
    events.push({ tick: boundary, value, mode: glides ? "ramp" : "set" });
    previous = events[events.length - 1];
  }
  return events;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/* ---------------- sanitizers (schema layer) ---------------- */

const LFO_KINDS: ReadonlySet<string> = new Set(["osc", "random", "step", "envFollower"]);
const LFO_PARAM_VALUES: ReadonlySet<string> = new Set(["gain", "pan"]);
const LFO_WAVE_VALUES: ReadonlySet<string> = new Set(["sine", "triangle", "square", "sawUp", "sawDown"]);
const RATE_MODES: ReadonlySet<string> = new Set(["hz", "sync"]);

function clampRange(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, numeric));
}

function pickEnum<T extends string>(value: unknown, allowed: ReadonlySet<string>, fallback: T): T {
  return typeof value === "string" && allowed.has(value) ? (value as T) : fallback;
}

function sanitizeTarget(raw: unknown, hostTrackId: ID): AutomationTarget | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Partial<AutomationTarget>;
  if (
    (candidate.kind !== "trackGain" &&
      candidate.kind !== "trackPan" &&
      candidate.kind !== "fxParam" &&
      candidate.kind !== "instParam") ||
    typeof candidate.trackId !== "string" ||
    candidate.trackId === ""
  )
    return undefined;
  const target: AutomationTarget = { kind: candidate.kind, trackId: candidate.trackId };
  if (target.kind === "fxParam" || target.kind === "instParam") {
    if (typeof candidate.paramId !== "string" || candidate.paramId === "") return undefined;
    target.paramId = candidate.paramId;
    if (target.kind === "fxParam") {
      if (typeof candidate.fxId !== "string" || candidate.fxId === "") return undefined;
      target.fxId = candidate.fxId;
    }
  }
  void hostTrackId;
  return target;
}

/**
 * Normalize a persisted modulator entry. Returns null when the entry is not
 * salvageable (unknown shape, dangling references).
 */
export function sanitizeLfo(raw: unknown, trackIds: Set<string>): Lfo | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Partial<Lfo> & Record<string, unknown>;
  if (
    typeof input.id !== "string" ||
    input.id === "" ||
    typeof input.trackId !== "string" ||
    !trackIds.has(input.trackId)
  ) {
    return null;
  }
  const kind = pickEnum<LfoKind>(input.kind, LFO_KINDS, "osc");
  const id: string = input.id;
  const trackId: string = input.trackId;
  const sanitized = buildSanitizedLfo(input, kind, trackIds, id, trackId);
  // Identity preservation: already-canonical entries must survive
  // normalization BY REFERENCE so idempotent normalizeProject keeps `===`
  // (templates test asserts normalize leaves canonical documents untouched).
  if (lfoShallowEquals(sanitized as unknown as Record<string, unknown>, input)) {
    return input as Lfo;
  }
  return sanitized;
}

function buildSanitizedLfo(
  input: Partial<Lfo> & Record<string, unknown>,
  kind: LfoKind,
  trackIds: Set<string>,
  id: string,
  trackId: string,
): Lfo {
  const sanitized: Lfo = {
    id,
    trackId,
    kind: kind === "osc" ? undefined : kind,
    param: pickEnum<"gain" | "pan">(input.param, LFO_PARAM_VALUES, "gain"),
    amount: clampRange(input.amount, 0, 1, 0.3),
  };
  if (kind === "envFollower") {
    const sourceTrackId =
      typeof input.sourceTrackId === "string" && trackIds.has(input.sourceTrackId) ? input.sourceTrackId : trackId;
    sanitized.sourceTrackId = sourceTrackId;
    sanitized.attackMs = clampRange(input.attackMs, 1, 500, 12);
    sanitized.releaseMs = clampRange(input.releaseMs, 10, 2000, 180);
    sanitized.sensitivity = clampRange(input.sensitivity, 0.2, 3, 1.5);
    sanitized.polarity = input.polarity === 1 ? 1 : -1;
    const tgt = sanitizeTarget(input.target, trackId);
    if (tgt) sanitized.target = tgt;
    return sanitized;
  }
  sanitized.rateMode = pickEnum<"hz" | "sync">(input.rateMode, RATE_MODES, "sync");
  sanitized.rateHz = clampRange(input.rateHz, 0.05, 30, 2);
  sanitized.division = clampRange(input.division, 0, 4, 2);
  if (kind === "osc") {
    sanitized.wave = pickEnum<NonNullable<Lfo["wave"]>>(input.wave, LFO_WAVE_VALUES, "sine");
    const tgt = sanitizeTarget(input.target, trackId);
    if (tgt) sanitized.target = tgt;
    return sanitized;
  }
  if (kind === "random") {
    sanitized.snh = pickEnum<"hold" | "glide">(input.snh, new Set(["hold", "glide"]), "hold");
    sanitized.seed = typeof input.seed === "string" && input.seed !== "" ? input.seed.slice(0, 64) : fallbackSeed(id);
    sanitized.target = sanitizeTarget(input.target, trackId);
    return sanitized;
  }
  // step
  sanitized.steps = sanitizeSteps(input.steps);
  sanitized.glideSec = clampRange(input.glideSec, 0, 0.5, 0.02);
  sanitized.target = sanitizeTarget(input.target, trackId);
  return sanitized;
}

/** Compares sanitized vs original ignoring `undefined` slots; arrays by JSON. */
function lfoShallowEquals(a: Record<string, unknown>, b: unknown): boolean {
  if (!b || typeof b !== "object") return false;
  const other = b as Record<string, unknown>;
  const aKeys = Object.keys(a).filter((key) => a[key] !== undefined);
  const bKeys = Object.keys(other).filter((key) => other[key] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const av = a[key];
    const bv = other[key];
    if (Array.isArray(av) || Array.isArray(bv)) {
      if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
      continue;
    }
    if (av && typeof av === "object") {
      if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
      continue;
    }
    if (av !== bv) return false;
  }
  return true;
}

/** Normalize step arrays to the nearest supported length (ties snap up), clamped bipolar values. */
export function sanitizeSteps(raw: unknown): number[] {
  const source = Array.isArray(raw) ? raw : [];
  if (source.length === 0) {
    // Nothing usable in the document — fall back to the musical default groove.
    return [...DEFAULT_STEP_PATTERN];
  }
  const sourceLength = source.length;
  let targetLength: number = STEP_MODULATOR_LENGTHS[0];
  let bestDelta = Math.abs(targetLength - sourceLength);
  for (const length of STEP_MODULATOR_LENGTHS) {
    const delta = Math.abs(length - sourceLength);
    if (delta < bestDelta || (delta === bestDelta && length > targetLength)) {
      targetLength = length;
      bestDelta = delta;
    }
  }
  const steps: number[] = [];
  for (let i = 0; i < targetLength; i++) {
    const value =
      typeof source[i % Math.max(1, source.length)] === "number" && Number.isFinite(source[i % source.length])
        ? (source[i % source.length] as number)
        : 0;
    steps.push(Math.round(Math.min(1, Math.max(-1, value)) * 1000) / 1000);
  }
  return steps;
}

export function fallbackSeed(id: string): string {
  return `auto-${hashString(id).toString(36)}`;
}

/* ---------------- step gate (effect) pattern ---------------- */

/** Classic trance-gate starting pattern (16 steps, 0..1 open amounts). */
export const DEFAULT_GATE_PATTERN: readonly number[] = [
  1, 0.55, 0.85, 0.4, 1, 0.5, 0.8, 0.35, 1, 0.55, 0.85, 0.4, 1, 0.5, 0.8, 0.35,
];

/** Normalize a step-gate pattern: 8/16/32 length (ties snap up), 0..1 values. */
export function sanitizeGateSteps(raw: unknown): number[] {
  const source = Array.isArray(raw) ? raw : [];
  if (source.length === 0) {
    return [...DEFAULT_GATE_PATTERN];
  }
  let targetLength: number = STEP_MODULATOR_LENGTHS[0];
  let bestDelta = Math.abs(targetLength - source.length);
  for (const length of STEP_MODULATOR_LENGTHS) {
    const delta = Math.abs(length - source.length);
    if (delta < bestDelta || (delta === bestDelta && length > targetLength)) {
      targetLength = length;
      bestDelta = delta;
    }
  }
  const steps: number[] = [];
  for (let i = 0; i < targetLength; i++) {
    const value =
      typeof source[i % source.length] === "number" && Number.isFinite(source[i % source.length])
        ? (source[i % source.length] as number)
        : 0;
    steps.push(Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000);
  }
  return steps;
}
