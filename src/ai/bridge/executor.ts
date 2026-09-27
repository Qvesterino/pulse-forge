/**
 * Executor — the single point where a CommandBatch touches ProjectDocument.
 *
 * Responsibilities:
 *   1. Run the mockProvider (or, in future, an LLM provider) to produce a
 *      CommandBatch from the user's prompt.
 *   2. Resolve every TrackMatcher to a concrete trackId, with consistent
 *      tie-breaking (preferKind > first match by id).
 *   3. Validate parameter ranges (frequencies in 20 Hz..20 kHz, gains within
 *      sensible headroom, panning within [-1, +1]).
 *   4. Apply commands in order; abort the batch on the first failure and
 *      return a structured error.
 *   5. Wrap the resulting doc in a single snapshot() Command so the user
 *      gets exactly ONE undo entry per AI suggestion.
 *
 * The executor is the ONLY place that calls into commands.ts — recipes and
 * the mockProvider are pure and never mutate state.
 */

import { snapshot } from "../../commands/commands";
import type { Command } from "../../commands/types";
import { defaultParamsOf } from "../../effects/definitions";
import type { BridgeCommand, BridgeExecutionError, BridgeExecutionResult, TrackMatcher } from "./types";
import type { SidechainDuckCommand, CompressorCommand, InsertTransientCommand } from "./types";
import type { ReverbCommand, DelayCommand } from "./types";
import type { RecipeInput } from "./types";
import { EQ_BANDS, clampToSlot, type EqBandSlot } from "./eqSlots";
import { MAX_SENSIBLE_DUCK_DB, SIDECHAIN_RANGES, duckDepthToRatio } from "./sidechainSlots";
import { COMPRESSOR_CHARACTERS, COMPRESSOR_RANGES, tuneCharacter } from "./compressorSlots";
import { TRANSIENT_RANGES } from "./transientSlots";
import { REVERB_RANGES, DELAY_RANGES, reverbSpec, delaySpec } from "./spaceSlots";
import { generateBatch } from "./mockProvider";
import { withTrack } from "../../project-model/transform";
import type { EffectInstance, EffectType, ProjectDocument, Track, ID } from "../../project-model/types";
import { uid } from "../../shared/ids";

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Take a user prompt, generate a CommandBatch via the provider, validate,
 * apply, and wrap into a single undoable Command. Pure with respect to the
 * caller — the doc only mutates via the returned Command.
 */
export function executeCommandBatch(prompt: string, input: RecipeInput): BridgeExecutionResult {
  const generated = generateBatch(prompt, input);
  if (!generated.ok || !generated.batch) {
    return failureFromProviderReason(generated.reason ?? "no-recipe-match");
  }
  const batch = generated.batch;

  // 1) Resolve + validate every command BEFORE mutating anything. If any
  //    command is invalid, the whole batch is rejected with no side effects.
  for (let i = 0; i < batch.commands.length; i++) {
    const cmd = batch.commands[i];
    const check = validateCommand(input.doc, cmd);
    if (!check.ok) {
      return {
        ok: false,
        error: {
          code: check.code,
          message: `Command ${i + 1}/${batch.commands.length} (${cmd.kind}) on "${cmd.label}": ${check.message}`,
          hint: check.hint,
        },
      };
    }
  }

  // 2) Apply in order; abort on the first apply-time failure (defence in
  //    depth — validations should catch this earlier).
  let cur: typeof input.doc = input.doc;
  for (let i = 0; i < batch.commands.length; i++) {
    const cmd = batch.commands[i];
    try {
      cur = applyCommand(cur, cmd);
    } catch (e) {
      return {
        ok: false,
        error: {
          code: "invalid-command",
          message: `Command ${i + 1}/${batch.commands.length} (${cmd.kind}) failed: ${(e as Error).message}`,
        },
      };
    }
  }

  // 3) Wrap into a single snapshot Command — one undo entry per AI batch.
  const command: Command = snapshot("aiBridgeBatch", `AI: ${batch.label}`, input.doc, cur);

  return { ok: true, doc: cur, command };
}

// ─── Track resolution ───────────────────────────────────────────────────────

/**
 * Resolve a TrackMatcher to a concrete trackId. Pure.
 *
 * Tie-breaking:
 *   1. `preferKind` matches override any other match (e.g. "snare" prefers
 *      a drum bus over an instrument track named "Snare Lead").
 *   2. Otherwise, first-match by track id order in the document.
 *
 * Returns null when nothing matches; the caller is responsible for turning
 * that into a user-facing error.
 */
export function resolveTrackMatcher(doc: { tracks: readonly Track[] }, matcher: TrackMatcher): ID | null {
  const re = matcher.regex ? new RegExp(matcher.namePattern, "i") : new RegExp(escapeRegExp(matcher.namePattern), "i");

  const candidates = doc.tracks.filter((t) => re.test(t.name));
  if (candidates.length === 0) return null;

  if (matcher.preferKind && matcher.preferKind !== "any") {
    const preferred = candidates.filter((t) => t.kind === matcher.preferKind);
    if (preferred.length > 0) return preferred[0].id;
  }
  return candidates[0].id;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Validation ──────────────────────────────────────────────────────────────

interface ValidationOk {
  ok: true;
}
interface ValidationFail {
  ok: false;
  code: BridgeExecutionError["code"];
  message: string;
  hint?: string;
}

const FREQ_MIN_HZ = 20;
const FREQ_MAX_HZ = 20000;
const Q_MIN = 0.1;
const Q_MAX = 10;
const PAN_MIN = -1;
const PAN_MAX = 1;

function validateCommand(doc: { tracks: readonly Track[] }, cmd: BridgeCommand): ValidationOk | ValidationFail {
  switch (cmd.kind) {
    case "sidechain-duck": {
      const target = resolveTrackMatcher(doc, cmd.target);
      if (!target) return trackMissing(cmd.target.namePattern);
      const source = resolveTrackMatcher(doc, cmd.source);
      if (!source) return trackMissing(cmd.source.namePattern);
      if (target === source) {
        return {
          ok: false,
          code: "validation-failed",
          message: "sidechain source and target resolve to the same track",
          hint: "A track cannot sidechain itself — pick a different source.",
        };
      }
      if (!Number.isFinite(cmd.duckDb) || cmd.duckDb < 0 || cmd.duckDb > MAX_SENSIBLE_DUCK_DB) {
        return paramRange("duckDb", cmd.duckDb, 0, MAX_SENSIBLE_DUCK_DB);
      }
      // attack/release are SECONDS in the canonical contract — a recipe that
      // writes milliseconds here would produce a multi-second time constant.
      const attack = SIDECHAIN_RANGES.attack;
      if (!Number.isFinite(cmd.attackSec) || cmd.attackSec < attack.min || cmd.attackSec > attack.max) {
        return paramRange("attackSec", cmd.attackSec, attack.min, attack.max);
      }
      const release = SIDECHAIN_RANGES.release;
      if (!Number.isFinite(cmd.releaseSec) || cmd.releaseSec < release.min || cmd.releaseSec > release.max) {
        return paramRange("releaseSec", cmd.releaseSec, release.min, release.max);
      }
      const threshold = SIDECHAIN_RANGES.threshold;
      const thrDb = cmd.thresholdDb ?? threshold.default;
      if (!Number.isFinite(thrDb) || thrDb < threshold.min || thrDb > threshold.max) {
        return paramRange("thresholdDb", thrDb, threshold.min, threshold.max);
      }
      const split = SIDECHAIN_RANGES.splitFreq;
      const splitHz = cmd.splitFreqHz ?? split.default;
      if (!Number.isFinite(splitHz) || splitHz < split.min || splitHz > split.max) {
        return paramRange("splitFreqHz", splitHz, split.min, split.max);
      }
      return { ok: true };
    }
    case "compressor": {
      const target = resolveTrackMatcher(doc, cmd.target);
      if (!target) return trackMissing(cmd.target.namePattern);
      if (!COMPRESSOR_CHARACTERS[cmd.character]) {
        return {
          ok: false,
          code: "validation-failed",
          message: `unknown compressor character "${cmd.character}"`,
          hint: `Valid characters: ${Object.keys(COMPRESSOR_CHARACTERS).join(", ")}.`,
        };
      }
      if (!Number.isFinite(cmd.intensity) || cmd.intensity < 0 || cmd.intensity > 1) {
        return paramRange("intensity", cmd.intensity, 0, 1);
      }
      if (cmd.source) {
        const source = resolveTrackMatcher(doc, cmd.source);
        if (!source) return trackMissing(cmd.source.namePattern);
        if (source === target) {
          return {
            ok: false,
            code: "validation-failed",
            message: "compressor source and target resolve to the same track",
            hint: "A track cannot pump itself — pick a different key source.",
          };
        }
      }
      // The character is only safe if every value it expands to lands inside
      // the registry whitelist — otherwise normalizeEffects clamps a value the
      // audio engine never sees.
      const spec = tuneCharacter(COMPRESSOR_CHARACTERS[cmd.character], cmd.intensity);
      const checks: Array<[keyof typeof COMPRESSOR_RANGES, number]> = [
        ["threshold", spec.thresholdDb],
        ["ratio", spec.ratio],
        ["attack", spec.attackSec],
        ["release", spec.releaseSec],
        ["knee", spec.kneeDb],
        ["detector", spec.detector],
        ["scHpf", spec.scHpfHz],
        ["autoRelease", spec.autoRelease],
        ["makeup", spec.makeupDb],
        ["mix", spec.mix],
      ];
      for (const [id, value] of checks) {
        const range = COMPRESSOR_RANGES[id];
        if (!Number.isFinite(value) || value < range.min || value > range.max) {
          return paramRange(id, value, range.min, range.max);
        }
      }
      return { ok: true };
    }
    case "reverb": {
      const target = resolveTrackMatcher(doc, cmd.target);
      if (!target) return trackMissing(cmd.target.namePattern);
      if (!Number.isFinite(cmd.intensity) || cmd.intensity < 0 || cmd.intensity > 1) {
        return paramRange("intensity", cmd.intensity, 0, 1);
      }
      // An unknown space yields null — rejected here rather than silently
      // served a default, so an invented "infinite-cave" is an error the UI
      // can explain instead of an unnoticed fallback.
      const probe = reverbSpec(cmd.space, cmd.intensity);
      if (!probe) {
        return {
          ok: false,
          code: "validation-failed",
          message: `unknown reverb space "${cmd.space}"`,
          hint: "Valid spaces: room, hall, plate, spring, cathedral.",
        };
      }
      const checks: Array<[keyof typeof REVERB_RANGES, number]> = [
        ["decay", probe.decaySec],
        ["predelay", probe.predelayMs],
        ["tone", probe.toneHz],
        ["damping", probe.dampingHz],
        ["diffusion", probe.diffusion],
        ["mod", probe.mod],
        ["mix", probe.mix],
      ];
      for (const [id, value] of checks) {
        const range = REVERB_RANGES[id];
        if (!Number.isFinite(value) || value < range.min || value > range.max) {
          return paramRange(`reverb.${id}`, value, range.min, range.max);
        }
      }
      return { ok: true };
    }
    case "delay": {
      const target = resolveTrackMatcher(doc, cmd.target);
      if (!target) return trackMissing(cmd.target.namePattern);
      if (!Number.isFinite(cmd.intensity) || cmd.intensity < 0 || cmd.intensity > 1) {
        return paramRange("intensity", cmd.intensity, 0, 1);
      }
      const probe = delaySpec(cmd.space, cmd.intensity);
      if (!probe) {
        return {
          ok: false,
          code: "validation-failed",
          message: `unknown delay space "${cmd.space}"`,
          hint: "Valid spaces: slap, pingpong, eighth, sixteenth.",
        };
      }
      const checks: Array<[keyof typeof DELAY_RANGES, number]> = [
        ["time", probe.timeMs],
        ["sync", probe.sync],
        ["pingPong", probe.pingPong],
        ["feedback", probe.feedback],
        ["tone", probe.toneHz],
        ["mix", probe.mix],
      ];
      for (const [id, value] of checks) {
        const range = DELAY_RANGES[id];
        if (!Number.isFinite(value) || value < range.min || value > range.max) {
          return paramRange(`delay.${id}`, value, range.min, range.max);
        }
      }
      return { ok: true };
    }
    case "eq-corner": {
      const target = resolveTrackMatcher(doc, cmd.target);
      if (!target) return trackMissing(cmd.target.namePattern);
      if (cmd.band !== "hp" && cmd.band !== "lp") {
        return {
          ok: false,
          code: "validation-failed",
          message: `"${cmd.band}" is not an EQ corner`,
          hint: 'Corners are "hp" and "lp". Shelves and bells use eq-carve/eq-boost.',
        };
      }
      if (!Number.isFinite(cmd.freqHz) || cmd.freqHz < FREQ_MIN_HZ || cmd.freqHz > FREQ_MAX_HZ) {
        return paramRange("freqHz", cmd.freqHz, FREQ_MIN_HZ, FREQ_MAX_HZ);
      }
      return { ok: true };
    }
    case "insert-transient": {
      const target = resolveTrackMatcher(doc, cmd.target);
      if (!target) return trackMissing(cmd.target.namePattern);
      const p = cmd.params;
      const checks: Array<[keyof typeof TRANSIENT_RANGES, number]> = [
        ["attack", p.attack],
        ["sustain", p.sustain],
        ["sensitivity", p.sensitivity],
        ["mix", p.mix],
        ["output", p.outputDb],
      ];
      for (const [id, value] of checks) {
        const range = TRANSIENT_RANGES[id];
        if (!Number.isFinite(value) || value < range.min || value > range.max) {
          return paramRange(id, value, range.min, range.max);
        }
      }
      return { ok: true };
    }
    case "eq-carve":
    case "eq-boost": {
      const target = resolveTrackMatcher(doc, cmd.target);
      if (!target) return trackMissing(cmd.target.namePattern);
      const spec = EQ_BANDS[cmd.band];
      if (!spec) {
        return {
          ok: false,
          code: "validation-failed",
          message: `unknown EQ band slot "${cmd.band}"`,
          hint: `Valid slots: ${Object.keys(EQ_BANDS).join(", ")}.`,
        };
      }
      if (!Number.isFinite(cmd.freqHz) || cmd.freqHz < FREQ_MIN_HZ || cmd.freqHz > FREQ_MAX_HZ) {
        return paramRange("freqHz", cmd.freqHz, FREQ_MIN_HZ, FREQ_MAX_HZ);
      }
      // Sign discipline: a carve must cut, a boost must lift. Guarding here
      // keeps a mis-signed recipe from silently boosting a snare it meant to
      // carve — a wrong-signed EQ move is worse than a rejected batch.
      if (spec.gainId === null) {
        return {
          ok: false,
          code: "validation-failed",
          message: `band "${cmd.band}" is a corner filter (${spec.label}) and has no gain param`,
          hint: "Use lowShelf / lowMid / highMid / highShelf for gain moves.",
        };
      }
      if (cmd.kind === "eq-carve" && cmd.gainDb > 0) {
        return signMismatch("eq-carve", cmd.gainDb);
      }
      if (cmd.kind === "eq-boost" && cmd.gainDb < 0) {
        return signMismatch("eq-boost", cmd.gainDb);
      }
      if (!Number.isFinite(cmd.gainDb) || cmd.gainDb < spec.minGainDb || cmd.gainDb > spec.maxGainDb) {
        return paramRange("gainDb", cmd.gainDb, spec.minGainDb, spec.maxGainDb);
      }
      if (spec.qId !== null && (!Number.isFinite(cmd.q) || cmd.q < Q_MIN || cmd.q > Q_MAX)) {
        return paramRange("q", cmd.q, Q_MIN, Q_MAX);
      }
      return { ok: true };
    }
    case "set-volume": {
      const target = resolveTrackMatcher(doc, cmd.target);
      if (!target) return trackMissing(cmd.target.namePattern);
      if (!Number.isFinite(cmd.volumeDb) || cmd.volumeDb < -60 || cmd.volumeDb > 12) {
        return paramRange("volumeDb", cmd.volumeDb, -60, 12);
      }
      return { ok: true };
    }
    case "set-track-pan": {
      const target = resolveTrackMatcher(doc, cmd.target);
      if (!target) return trackMissing(cmd.target.namePattern);
      if (!Number.isFinite(cmd.pan) || cmd.pan < PAN_MIN || cmd.pan > PAN_MAX) {
        return paramRange("pan", cmd.pan, PAN_MIN, PAN_MAX);
      }
      return { ok: true };
    }
  }
}

function trackMissing(namePattern: string): ValidationFail {
  return {
    ok: false,
    code: "no-track-match",
    message: `no track matches "${namePattern}"`,
    hint: "Check the track name in the mixer; the matcher is case-insensitive substring by default.",
  };
}

function paramRange(name: string, value: number, min: number, max: number): ValidationFail {
  return {
    ok: false,
    code: "validation-failed",
    message: `parameter "${name}"=${value} out of range [${min}, ${max}]`,
  };
}

function signMismatch(kind: "eq-carve" | "eq-boost", gainDb: number): ValidationFail {
  return {
    ok: false,
    code: "validation-failed",
    message: `${kind} requires a ${kind === "eq-carve" ? "negative" : "positive"} gainDb, got ${gainDb}`,
    hint: "A carve cuts (negative dB), a boost lifts (positive dB).",
  };
}

// ─── Apply ───────────────────────────────────────────────────────────────────

function applyCommand(doc: ProjectDocument, cmd: BridgeCommand): ProjectDocument {
  switch (cmd.kind) {
    case "sidechain-duck": {
      const targetId = resolveTrackMatcher(doc, cmd.target);
      const sourceId = resolveTrackMatcher(doc, cmd.source);
      if (!targetId || !sourceId) {
        throw new Error("internal: track resolution lost between validate and apply");
      }
      return insertSidechain(doc, targetId, sourceId, cmd);
    }
    case "reverb": {
      const targetId = resolveTrackMatcher(doc, cmd.target);
      if (!targetId) throw new Error("internal: track resolution lost between validate and apply");
      return applySpace(doc, targetId, cmd);
    }
    case "delay": {
      const targetId = resolveTrackMatcher(doc, cmd.target);
      if (!targetId) throw new Error("internal: track resolution lost between validate and apply");
      return applySpace(doc, targetId, cmd);
    }
    case "eq-corner": {
      const targetId = resolveTrackMatcher(doc, cmd.target);
      if (!targetId) throw new Error("internal: track resolution lost between validate and apply");
      return applyEqCorner(doc, targetId, cmd.band, cmd.freqHz);
    }
    case "insert-transient": {
      const targetId = resolveTrackMatcher(doc, cmd.target);
      if (!targetId) throw new Error("internal: track resolution lost between validate and apply");
      return applyTransient(doc, targetId, cmd);
    }
    case "compressor": {
      const targetId = resolveTrackMatcher(doc, cmd.target);
      if (!targetId) throw new Error("internal: track resolution lost between validate and apply");
      const sourceId = cmd.source ? resolveTrackMatcher(doc, cmd.source) : null;
      return applyCompressor(doc, targetId, cmd, sourceId);
    }
    case "eq-carve":
    case "eq-boost": {
      const targetId = resolveTrackMatcher(doc, cmd.target);
      if (!targetId) throw new Error("internal: track resolution lost between validate and apply");
      return applyEqMove(doc, targetId, cmd.band, cmd.freqHz, cmd.gainDb, cmd.q);
    }
    case "set-volume": {
      const targetId = resolveTrackMatcher(doc, cmd.target);
      if (!targetId) throw new Error("internal: track resolution lost between validate and apply");
      return setTrackGain(dbToGain(cmd.volumeDb), doc, targetId);
    }
    case "set-track-pan": {
      const targetId = resolveTrackMatcher(doc, cmd.target);
      if (!targetId) throw new Error("internal: track resolution lost between validate and apply");
      return setTrackPan(cmd.pan, doc, targetId);
    }
  }
}

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Insert a sidechain compressor onto the target track, keyed from source.
 *
 * Writes ONLY canonical param ids (threshold / ratio / attack / release /
 * amount / splitFreq) seeded from the registry defaults, so the instance
 * survives `normalizeEffects` and actually changes the sound. The musical
 * `duckDb` intent is translated to a ratio/amount pair — see
 * ./sidechainSlots.ts for why that translation is required.
 *
 * Reuses the last existing sidechain on the track when one is present, so a
 * second AI suggestion retunes the duck instead of stacking a second
 * compressor and doubling the pumping.
 */
function insertSidechain(doc: ProjectDocument, targetId: ID, sourceId: ID, cmd: SidechainDuckCommand): ProjectDocument {
  const { ratio, amount } = duckDepthToRatio(cmd.duckDb);
  const applySpec = (base: Record<string, number>): Record<string, number> => {
    const existingRatio = base.ratio;
    // A user who already hand-tuned RATIO knows their mix better than the
    // bridge does. Only deepen the duck — never walk a stronger existing
    // setting back to a weaker one the recipe happened to compute.
    const nextRatio =
      typeof existingRatio === "number" && Number.isFinite(existingRatio) ? Math.max(ratio, existingRatio) : ratio;
    return {
      ...base,
      threshold: cmd.thresholdDb ?? SIDECHAIN_RANGES.threshold.default,
      ratio: nextRatio,
      attack: cmd.attackSec,
      release: cmd.releaseSec,
      amount,
      splitFreq: cmd.splitFreqHz ?? SIDECHAIN_RANGES.splitFreq.default,
    };
  };
  const base = defaultParamsOf("sidechain");

  return withTrack(doc, targetId, (t) => {
    const existing = findLastIndex(t.effects, (f) => f.type === "sidechain" && f.sidechainTrackId === sourceId);
    if (existing >= 0) {
      const nextEffects = t.effects.slice();
      nextEffects[existing] = {
        ...t.effects[existing],
        params: applySpec(t.effects[existing].params),
        bypassed: false,
        sidechainTrackId: sourceId,
      };
      return { ...t, effects: nextEffects };
    }
    const fx: EffectInstance = {
      id: uid("fx"),
      type: "sidechain",
      bypassed: false,
      params: applySpec(base),
      sidechainTrackId: sourceId,
    };
    return { ...t, effects: [...t.effects, fx] };
  });
}

/**
 * Insert or retune a space effect (reverb / delay) on the target track.
 *
 * Writes only the canonical ids for the effect type, seeded from the registry
 * defaults. Retunes the last instance of the SAME type rather than stacking
 * a second one — two reverbs in series on a bass is almost never what a user
 * asked for, and it doubles the wet signal unpredictably.
 *
 * The unit split is preserved exactly (see ./spaceSlots.ts): reverb `decay`
 * goes in as SECONDS and `predelay` as MILLISECONDS, delay `time` in
 * MILLISECONDS. A synced delay also gets a legal `time` written even though
 * the worklet overrides it from BPM — normalizeEffects needs the key.
 */
function applySpace(doc: ProjectDocument, targetId: ID, cmd: ReverbCommand | DelayCommand): ProjectDocument {
  const type: EffectType = cmd.kind === "reverb" ? "reverb" : "delay";
  const params: Record<string, number> =
    cmd.kind === "reverb"
      ? (() => {
          // Validation already proved this exists; the assert keeps the
          // non-null type without a redundant table check.
          const s = reverbSpec(cmd.space, cmd.intensity);
          if (!s) throw new Error(`applySpace: unknown reverb space "${cmd.space}"`);
          return {
            ...defaultParamsOf("reverb"),
            // decaySec → `decay` (SECONDS), predelayMs → `predelay` (MILLISECONDS)
            decay: s.decaySec,
            predelay: s.predelayMs,
            tone: s.toneHz,
            damping: s.dampingHz,
            diffusion: s.diffusion,
            mod: s.mod,
            mix: s.mix,
          };
        })()
      : (() => {
          const s = delaySpec(cmd.space, cmd.intensity);
          if (!s) throw new Error(`applySpace: unknown delay space "${cmd.space}"`);
          return {
            ...defaultParamsOf("delay"),
            time: s.timeMs,
            sync: s.sync,
            pingPong: s.pingPong,
            feedback: s.feedback,
            tone: s.toneHz,
            mix: s.mix,
          };
        })();

  return withTrack(doc, targetId, (t) => {
    const existing = findLastIndex(t.effects, (f) => f.type === type);
    if (existing >= 0) {
      const nextEffects = t.effects.slice();
      nextEffects[existing] = { ...t.effects[existing], params, bypassed: false };
      return { ...t, effects: nextEffects };
    }
    const fx: EffectInstance = { id: uid("fx"), type, bypassed: false, params };
    return { ...t, effects: [...t.effects, fx] };
  });
}

/**
 * Move an EQ corner (hp / lp) on the target. Same reuse rule as
 * `applyEqMove`: the last existing `eq` instance is retuned, and a fresh one
 * is seeded from the registry defaults when the track has none.
 */
function applyEqCorner(doc: ProjectDocument, targetId: ID, band: "hp" | "lp", freqHz: number): ProjectDocument {
  const spec = EQ_BANDS[band];
  const { freqHz: snapped } = clampToSlot(spec, freqHz);
  return withTrack(doc, targetId, (t) => {
    const existingEqIdx = findLastIndex(t.effects, (fx) => fx.type === "eq");
    const next: Record<string, number> = {
      ...(existingEqIdx >= 0 ? t.effects[existingEqIdx].params : defaultParamsOf("eq")),
      [spec.freqId]: snapped,
    };
    if (existingEqIdx >= 0) {
      const nextEffects = t.effects.slice();
      nextEffects[existingEqIdx] = { ...t.effects[existingEqIdx], params: next };
      return { ...t, effects: nextEffects };
    }
    const fx: EffectInstance = { id: uid("fx"), type: "eq", bypassed: false, params: next };
    return { ...t, effects: [...t.effects, fx] };
  });
}

/**
 * Insert or retune a Transient Shaper on the target track, writing only the
 * canonical `transientParams` ids. `attack` / `sustain` are signed, so a
 * negative `sustain` shortens the body — see ./transientSlots.ts.
 */
function applyTransient(doc: ProjectDocument, targetId: ID, cmd: InsertTransientCommand): ProjectDocument {
  const p = cmd.params;
  const params: Record<string, number> = {
    ...defaultParamsOf("transient"),
    attack: p.attack,
    sustain: p.sustain,
    sensitivity: p.sensitivity,
    mix: p.mix,
    output: p.outputDb,
  };
  return withTrack(doc, targetId, (t) => {
    const existing = findLastIndex(t.effects, (f) => f.type === "transient");
    if (existing >= 0) {
      const nextEffects = t.effects.slice();
      nextEffects[existing] = { ...t.effects[existing], params, bypassed: false };
      return { ...t, effects: nextEffects };
    }
    const fx: EffectInstance = { id: uid("fx"), type: "transient", bypassed: false, params };
    return { ...t, effects: [...t.effects, fx] };
  });
}

/**
 * Insert or retune a compressor on the target track.
 *
 * Writes only canonical `compressorParams` ids seeded from the registry
 * defaults, so the instance survives `normalizeEffects` and actually
 * compresses. Unlike the sidechain path there is no `amount` param to
 * translate — the character's numbers are already in registry units, with
 * `makeup` in dB (the worklet converts to linear itself).
 *
 * Retunes rather than stacking: a second compressor on the same track would
 * compound the GR and surprise the user. When the character wants a pump and
 * the track already has a keyed compressor from another source, the new
 * source replaces the old one so the track never holds two key feeds.
 */
function applyCompressor(
  doc: ProjectDocument,
  targetId: ID,
  cmd: CompressorCommand,
  sourceId: ID | null,
): ProjectDocument {
  const spec = tuneCharacter(COMPRESSOR_CHARACTERS[cmd.character], cmd.intensity);
  const params: Record<string, number> = {
    ...defaultParamsOf("compressor"),
    threshold: spec.thresholdDb,
    ratio: spec.ratio,
    attack: spec.attackSec,
    release: spec.releaseSec,
    knee: spec.kneeDb,
    detector: spec.detector,
    scHpf: spec.scHpfHz,
    autoRelease: spec.autoRelease,
    makeup: spec.makeupDb,
    mix: spec.mix,
  };

  return withTrack(doc, targetId, (t) => {
    const existing = findLastIndex(t.effects, (f) => f.type === "compressor");
    if (existing >= 0) {
      const nextEffects = t.effects.slice();
      nextEffects[existing] = {
        ...t.effects[existing],
        params,
        bypassed: false,
        sidechainTrackId: sourceId,
      };
      return { ...t, effects: nextEffects };
    }
    const fx: EffectInstance = {
      id: uid("fx"),
      type: "compressor",
      bypassed: false,
      params,
      sidechainTrackId: sourceId,
    };
    return { ...t, effects: [...t.effects, fx] };
  });
}

/**
 * Move one band of the target track's `eq` effect.
 * Real integration, not a model-only write: the params written here are the
 * canonical ids the audio engine actually reads (`highMidFreq` /
 * `highMidGain` / `highMidQ`, …) so the change survives `normalizeEffects`
 * and reaches both the live graph and the offline renderer.
 *
 * Rules:
 *   - Reuse the LAST `eq` instance on the track if one exists (preserves the
 *     user's other band moves; a second EQ would be a redundant insert).
 *   - Otherwise insert a fresh `eq` seeded with the registry defaults, so no
 *     band is left undefined.
 *   - Frequency is snapped into the slot's legal window; a shelf/hp/lp slot
 *     ignores `q` entirely rather than writing a key it has no reader for.
 */
function applyEqMove(
  doc: ProjectDocument,
  targetId: ID,
  band: EqBandSlot,
  freqHz: number,
  gainDb: number,
  q: number,
): ProjectDocument {
  const spec = EQ_BANDS[band];
  const gainId = spec.gainId;
  if (!gainId) throw new Error(`applyEqMove: band "${band}" has no gain param`);
  const { freqHz: snapped } = clampToSlot(spec, freqHz);

  return withTrack(doc, targetId, (t) => {
    const existingEqIdx = findLastIndex(t.effects, (fx) => fx.type === "eq");
    const next: Record<string, number> = {
      ...(existingEqIdx >= 0 ? t.effects[existingEqIdx].params : defaultParamsOf("eq")),
      [spec.freqId]: snapped,
      [gainId]: gainDb,
    };
    if (spec.qId !== null) next[spec.qId] = q;

    if (existingEqIdx >= 0) {
      const nextEffects = t.effects.slice();
      nextEffects[existingEqIdx] = { ...t.effects[existingEqIdx], params: next };
      return { ...t, effects: nextEffects };
    }
    const fx: EffectInstance = { id: uid("fx"), type: "eq", bypassed: false, params: next };
    return { ...t, effects: [...t.effects, fx] };
  });
}

function findLastIndex<T>(arr: readonly T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i]!)) return i;
  }
  return -1;
}

function setTrackGain(gainLinear: number, doc: ProjectDocument, trackId: ID): ProjectDocument {
  const clamped = clamp(gainLinear, 0, 4);
  return withTrack(doc, trackId, (t) => ({ ...t, gain: clamped }));
}

function setTrackPan(pan: number, doc: ProjectDocument, trackId: ID): ProjectDocument {
  return withTrack(doc, trackId, (t) => ({ ...t, pan: clamp(pan, -1, 1) }));
}

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

// ─── Error mapping ───────────────────────────────────────────────────────────

/**
 * TEST-ONLY: expose the per-command validator so the bridge specs can assert
 * rejection rules (sign discipline, corner filters, ranges) without smuggling
 * an invalid command through a recipe. Mirrors the
 * `__snapshotVerificationFallbacks` test-hook convention in commands.ts.
 */
export function __validateBridgeCommandForTest(
  doc: ProjectDocument,
  cmd: BridgeCommand,
): { ok: true } | { ok: false; code: BridgeExecutionError["code"]; message: string; hint?: string } {
  return validateCommand(doc, cmd);
}

function failureFromProviderReason(
  reason: "empty-prompt" | "no-recipe-match" | "recipe-applied-no-commands",
): BridgeExecutionResult {
  switch (reason) {
    case "empty-prompt":
      return { ok: false, error: { code: "validation-failed", message: "empty prompt" } };
    case "no-recipe-match":
      return {
        ok: false,
        error: {
          code: "no-recipe-match",
          message: "I don't know how to do that yet — try rephrasing or pick a recipe from the suggestions.",
        },
      };
    case "recipe-applied-no-commands":
      return {
        ok: false,
        error: {
          code: "no-track-match",
          message: "recipe matched but the project has no tracks this suggestion applies to",
          hint: "Check that the relevant tracks exist (e.g. a snare and a hi-hat for masking fixes).",
        },
      };
  }
}
