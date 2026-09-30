import type { ProjectDocument } from "../project-model/types";
import type { RoutedIntent } from "./route";
import { routeIntentText } from "./route";
import { validateModelAction } from "./model-schema";
import { resolvePresetByName } from "./preset-intent";
import type { PresetTargetFamily } from "./preset-intent";
import { resolveClipRef, resolveSceneTarget, type ArrangeOp, type ClipArrangeOp } from "./arrangeWords";
import type { FaderIntent, TempoIntent } from "./conversation";
import type { EffectIntent, SendIntent, BypassIntent } from "./mix";
import type { ExactOp, ExactTarget } from "./exact";
import type { MusicalKey } from "../project-model/types";
import type { ProductionIntent } from "./production";

/**
 * LOCAL INTENT MODEL — ADAPTER BRIDGE (pipeline step [C]→[D]).
 *
 * When the deterministic parsers come up empty, the local model (LFM-2.5
 * class, GBNF-constrained) gets the instruction and emits a MODEL-FORM
 * action (schema of model-schema.ts). This module turns that into a real
 * RoutedIntent the existing executors consume unchanged:
 *
 *   - validateModelAction gates structure (grammar already limits the model;
 *     the validator is the runtime net for non-grammar runtimes)
 *   - model units → engine units (panValue 30 → 0.3, toBar 9 → 0-based 8)
 *   - names/refs → ids (preset NAME → factory id, clip REF → clip id)
 *   - derived fields are ENGINE-built (detected[], labels) — the model
 *     never emits them
 *   - clarify suggestions from the model are VERIFIED executable before
 *     they are offered (each chip must re-route to a real command)
 *
 * The provider is injectable: tests use deterministic fakes, the real
 * loader (manifest #1 in the src/ai pattern) plugs in with zero changes
 * here. Nothing in this module touches audio state — the output is a route,
 * and the executors keep their clamps, strict resolution and undo.
 */

export interface IntentModelProvider {
  id: string;
  version: string;
  /**
   * Emit the model-form action JSON for one instruction. Rejects/throws on
   * failure — timeout and circuit breaking belong to the loader, mirroring
   * the ranker/prior worker contract.
   */
  generate(instruction: string, doc: ProjectDocument): Promise<string>;
}

// Module-level registry (the yDocHelpers pattern): the loader registers on
// boot; tests register fakes. Absent provider → tryModelRoute resolves null
// instantly and the panel path is unchanged.
let provider: IntentModelProvider | null = null;

export function setIntentModelProvider(next: IntentModelProvider | null): void {
  provider = next;
}

export function getIntentModelProvider(): IntentModelProvider | null {
  return provider;
}

const deaccent = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

// ── Per-kind adapters: model record → engine payload ────────────────────────

type ModelAction = Record<string, unknown>;

function faderFrom(m: ModelAction): RoutedIntent {
  const intent: FaderIntent = {
    targets: (m.targets as FaderIntent["targets"]) ?? [],
    pads: (m.pads as FaderIntent["pads"]) ?? [],
    direction: m.direction as FaderIntent["direction"],
    ...(m.percent != null ? { percent: m.percent as number } : {}),
    ...(m.amount != null ? { amount: m.amount as FaderIntent["amount"] } : {}),
  };
  return { kind: "fader", intent };
}

function exactFrom(m: ModelAction): RoutedIntent {
  const raw = (m.ops as ModelAction[]) ?? [];
  const ops: ExactOp[] = [];
  for (const rawOp of raw) {
    const kind = rawOp.kind as string;
    const target = rawOp.target as ExactTarget | undefined;
    if (kind === "tempo") ops.push({ kind, bpm: Number(rawOp.bpm ?? 120) });
    else if (kind === "key") ops.push({ kind, key: String(rawOp.key ?? "C Major") as MusicalKey });
    else if (kind === "patternLength") ops.push({ kind, steps: Number(rawOp.steps ?? 16) });
    else if (kind === "addTrack")
      ops.push({
        kind,
        trackKind: "drums" === target ? "drum" : "instrument",
        instrument: (rawOp.instrument as "analog") ?? "analog",
      });
    else if (kind === "renameTrack") ops.push({ kind, target: target ?? "bass", name: String(rawOp.name ?? "") });
    else if (kind === "removeTrack" || kind === "duplicateTrack") ops.push({ kind, target: target ?? "bass" });
    else if (kind === "gainDb") ops.push({ kind, target: target ?? "mix", deltaDb: Number(rawOp.deltaDb ?? 0) });
    else if (kind === "transpose")
      ops.push({ kind, target: target ?? "lead", semitones: Number(rawOp.semitones ?? 0) });
    else if (kind === "pan") {
      // panValue is the model's −100..100 form; `value` is already −1..1
      const byPan = rawOp.panValue != null ? Number(rawOp.panValue) / 100 : null;
      const value = byPan != null ? byPan : Number(rawOp.value ?? 0);
      ops.push({ kind, target: target ?? "bass", value: Math.max(-1, Math.min(1, value)) });
    } else {
      ops.push({ kind: kind as "mute" | "solo", target: target ?? "drums", value: rawOp.value === true });
    }
  }
  const label = ops.map((op) => op.kind).join(", ");
  return { kind: "exact", plan: { label: `AI: ${label}`, ops } };
}

function presetFrom(m: ModelAction): RoutedIntent {
  const name = String(m.name ?? "");
  const want = deaccent(name).replace(/\s+/g, " ").trim();
  const target = m.target as PresetTargetFamily | undefined;
  // The trained model frequently drops the root `target` — the engine owns
  // the family anyway (the preset's instrument decides where it may land).
  // With an explicit target resolve inside it; without, resolve against each
  // family and keep the best score (the family-instrument bonus breaks ties).
  if (target != null) {
    const resolved = resolvePresetByName(name, want, target);
    if (resolved.ok) return { kind: "preset", intent: resolved.intent };
    return { kind: "presetUnknown", name, suggestions: resolved.suggestions };
  }
  let best: { intent: PresetIntent; rank: number } | null = null;
  let fallbackSuggestions: string[] = [];
  for (const family of ["bass", "chords", "lead"] as const) {
    const resolved = resolvePresetByName(name, want, family);
    if (resolved.ok) {
      const rank = resolved.intent.matchedBy === "exact" ? 3 : resolved.intent.matchedBy === "prefix" ? 2 : 1;
      if (best === null || rank > best.rank) best = { intent: resolved.intent, rank };
    } else if (fallbackSuggestions.length === 0) {
      fallbackSuggestions = resolved.suggestions;
    }
  }
  if (best) return { kind: "preset", intent: best.intent };
  return { kind: "presetUnknown", name, suggestions: fallbackSuggestions };
}

function effectFrom(m: ModelAction): RoutedIntent {
  const intent: EffectIntent = {
    effectType: m.effectType as EffectIntent["effectType"],
    targets: (m.targets as EffectIntent["targets"]) ?? [],
    direction: m.direction as EffectIntent["direction"],
    amount: "medium",
    ...(m.percent != null ? { percent: m.percent as number } : {}),
    detected: ["AI"],
  };
  return { kind: "effectIntent", intent };
}

function mixFrom(m: ModelAction): RoutedIntent {
  const overrides: Record<string, string> = {};
  // The corpus teaches the compact teacher form ({kind, overrides:{...}}) —
  // "overrides" is not a wrapper key, so the flat-record adapters see the
  // payload only if we look for it here. Flat emissions (schema form) read
  // from the root as before.
  const nested = (m.overrides as Record<string, unknown> | undefined) ?? {};
  for (const key of ["reverb", "tone", "punch", "pump"]) {
    const value = nested[key] ?? m[key];
    if (value != null) overrides[key] = String(value);
  }
  return { kind: "mix", overrides, detected: ["AI"] };
}

function productionFrom(m: ModelAction, instruction: string): RoutedIntent {
  const intent: ProductionIntent = {
    targets: (m.targets as ProductionIntent["targets"]) ?? [],
    goals: ((m.goals as ModelAction[]) ?? []).map((goal) => ({
      concept: goal.concept as ProductionIntent["goals"][number]["concept"],
      amount: Number(goal.amount ?? 0.7),
    })),
    sourceText: instruction,
  };
  return { kind: "production", intent };
}

function arrangeFrom(doc: ProjectDocument, m: ModelAction): RoutedIntent | null {
  const raw = (m.ops as ModelAction[]) ?? [];
  const ops: ArrangeOp[] = [];
  for (const rawOp of raw) {
    const op = rawOp.op as string;
    if (op === "autoArrange") {
      ops.push({ op: "autoArrange" });
      continue;
    }
    const role = rawOp.role as ArrangeOp extends { role: infer R } ? R : never;
    // addRole names the NEW section — by definition absent from the doc, so
    // resolving it against existing scenes would refuse every (correct) route
    if (op === "addRole") {
      if (role == null) return null;
      ops.push({ op, role, beforeSceneId: null });
      continue;
    }
    const scene = resolveSceneTarget(doc, String(rawOp.role ?? ""), [role as never]);
    if (!scene) return null; // unresolvable role — refuse the whole route
    if (op === "remove" || op === "duplicate")
      ops.push({ op, sceneId: scene.id, role: scene.role ?? null, name: scene.name });
    else if (op === "resize")
      ops.push({ op, sceneId: scene.id, role: scene.role ?? null, name: scene.name, bars: Number(rawOp.bars ?? 4) });
    else if (op === "reorder") ops.push({ op: "reorder", sceneId: scene.id, dir: "later" });
    else return null;
  }
  if (ops.length === 0) return null;
  return { kind: "arrange", ops, unrecognized: [] };
}

function clipsFrom(doc: ProjectDocument, m: ModelAction): RoutedIntent | null {
  const raw = (m.ops as ModelAction[]) ?? [];
  const ops: ClipArrangeOp[] = [];
  for (const rawOp of raw) {
    // Two contracts meet here: the SFT corpus teaches ENGINE-form ops (final
    // clipId, 0-based toBar — exactly what the command layer consumes), while
    // the model schema's ref-form (role word + 1-based bars) is what a
    // few-shot/schema-guided model emits. Accept both: a clipId that exists
    // in the live doc is authoritative; otherwise resolve ref/atBar — and
    // only the ref-echo path applies the 1-based → 0-based shift.
    const directId = typeof rawOp.clipId === "string" ? rawOp.clipId : "";
    const direct = directId !== "" && doc.arrangement.clips.some((clip) => clip.id === directId);
    const clipId = direct
      ? directId
      : resolveClipRef(doc, String(rawOp.ref ?? ""), rawOp.atBar != null ? Number(rawOp.atBar) : undefined);
    if (!clipId) return null; // clip gone / ref unresolvable — no guessing
    const rawToBar = rawOp.toBar != null ? Number(rawOp.toBar) : null;
    const toBar = rawToBar == null ? 0 : direct ? Math.max(0, rawToBar) : Math.max(0, rawToBar - 1);
    if (rawOp.op === "copyClip") ops.push({ op: "copyClip", clipId, toBar });
    else if (rawOp.op === "moveClip") ops.push({ op: "moveClip", clipId, toBar });
    else if (rawOp.op === "resizeClip") ops.push({ op: "resizeClip", clipId, bars: Number(rawOp.bars ?? 4) });
    else ops.push({ op: "deleteClip", clipId });
  }
  if (ops.length === 0) return null;
  return { kind: "clips", ops };
}

// Model kinds that may nest inside a compound part (strings of sub-JSON).
const COMPOUNDABLE = new Set(["fader", "tempo", "effectIntent", "sendIntent", "bypassIntent", "preset", "exact"]);

function compoundFrom(doc: ProjectDocument, m: ModelAction, instruction: string): RoutedIntent | null {
  const rawParts = (m.parts as unknown[]) ?? [];
  const parts: RoutedIntent extends never ? never : Extract<RoutedIntent, { kind: "compound" }>["parts"] = [];
  for (const rawPart of rawParts) {
    let sub: unknown;
    try {
      sub = typeof rawPart === "string" ? JSON.parse(rawPart) : rawPart;
    } catch {
      return null;
    }
    if (sub == null || typeof sub !== "object") return null;
    const rawRecord = sub as ModelAction;
    // SAME NESTED-UNWRAP GUARD as the top-level bridge: corpus-trained parts
    // arrive in the compact teacher form ({kind, intent:{...}} — and exact
    // parts as {kind, plan:{label, ops}}), the adapters read flat records —
    // adapting a nested part against its root produced silently EMPTY slot
    // bags (kind right, payload gone) or a validation abstain on `plan`.
    const wrapperKey = ["intent", "preset", "parse", "plan"].find(
      (key) => rawRecord[key] != null && typeof rawRecord[key] === "object",
    );
    const record: ModelAction =
      wrapperKey != null ? { kind: rawRecord.kind, ...(rawRecord[wrapperKey] as ModelAction) } : rawRecord;
    const kind = String(record.kind ?? "");
    if (!COMPOUNDABLE.has(kind)) return null;
    const validation = validateModelAction(record);
    if (!validation.valid) return null;
    const adapted = adaptRecord(doc, record, instruction, kind);
    if (adapted == null) return null;
    // wrap the flat route into the compound part of the same name
    if (adapted.kind === "fader") parts.push({ kind: "fader", intent: adapted.intent });
    else if (adapted.kind === "tempo") parts.push({ kind: "tempo", intent: adapted.intent });
    else if (adapted.kind === "effectIntent") parts.push({ kind: "effect", intent: adapted.intent });
    else if (adapted.kind === "sendIntent") parts.push({ kind: "send", intent: adapted.intent });
    else if (adapted.kind === "bypassIntent") parts.push({ kind: "bypass", intent: adapted.intent });
    else if (adapted.kind === "preset") parts.push({ kind: "preset", intent: adapted.intent });
    else if (adapted.kind === "exact") parts.push({ kind: "exact", plan: adapted.plan });
    else return null;
  }
  if (parts.length === 0) return null;
  return { kind: "compound", parts };
}

function clarifyFrom(doc: ProjectDocument, m: ModelAction): RoutedIntent | null {
  const suggestions = ((m.suggestions as string[]) ?? []).filter((suggestion) => {
    const route = routeIntentText(suggestion, doc);
    return route.kind !== "pattern" && route.kind !== "clarify";
  });
  if (suggestions.length === 0) return null; // nothing executable to offer
  return { kind: "clarify", reason: "AI navrhuje — vyber:", suggestions: suggestions.slice(0, 4) };
}

function adaptRecord(
  doc: ProjectDocument,
  record: ModelAction,
  instruction: string,
  kind: string,
): RoutedIntent | null {
  switch (kind) {
    case "fader":
      return faderFrom(record);
    case "exact":
      return exactFrom(record);
    case "transport":
      return { kind: "transport", action: record.action as never };
    case "save":
      return { kind: "save" };
    case "export":
      return { kind: "export", format: record.format as "wav" | "mp3" };
    case "record":
      return { kind: "record", arm: record.arm === true };
    case "select":
      return { kind: "select", target: record.target as never };
    case "preset":
      return presetFrom(record);
    case "effectIntent":
      return effectFrom(record);
    case "sendIntent":
      return {
        kind: "sendIntent",
        intent: {
          effectType: record.effectType as SendIntent["effectType"],
          target: record.target as SendIntent["target"],
          direction: record.direction as SendIntent["direction"],
          ...(record.percent != null ? { percent: record.percent as number } : {}),
        } as SendIntent,
      };
    case "bypassIntent":
      return {
        kind: "bypassIntent",
        intent: {
          effectType: record.effectType as BypassIntent["effectType"],
          target: record.target as BypassIntent["target"],
          bypassed: record.bypassed === true,
        } as BypassIntent,
      };
    case "mix":
      return mixFrom(record);
    case "loudness":
      return {
        kind: "loudness",
        parse: {
          direction: record.direction as "louder" | "quieter",
          ...(record.targetLUFS != null ? { targetDb: record.targetLUFS as number } : {}),
          detected: ["AI"],
        },
      };
    case "tempo": {
      const intent: TempoIntent = {
        direction: record.direction as TempoIntent["direction"],
        ...(record.bpm != null ? { bpm: record.bpm as number } : {}),
      };
      return { kind: "tempo", intent };
    }
    case "production":
      return productionFrom(record, instruction);
    case "revise":
      return {
        kind: "revise",
        attribute: record.attribute as "energy" | "density",
        direction: record.direction as "more" | "less",
        detected: ["AI"],
        targetRole: (record.targetRole as string | null) ?? null,
      };
    case "arrange":
      return arrangeFrom(doc, record);
    case "clips":
      return clipsFrom(doc, record);
    case "compound":
      return compoundFrom(doc, record, instruction);
    case "clarify":
      return clarifyFrom(doc, record);
    default:
      return null;
  }
}

/**
 * The bridge entry point. Null means "the model had nothing usable" — the
 * caller falls back to today's behavior (clarify/generation) unchanged.
 * Never throws: a provider failure is a miss, not a crash.
 */
export async function tryModelRoute(instruction: string, doc: ProjectDocument): Promise<RoutedIntent | null> {
  const active = provider;
  if (!active) return null;
  let raw: string;
  try {
    raw = await active.generate(instruction, doc);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // NESTED-UNWRAP GUARD: the SFT corpus teaches the compact teacher form
  // ({kind, intent:{...}} for wrapper kinds), while the adapters read FLAT
  // records. A nested emission used to pass validation (the validator
  // checks the nested payload) and then adapt against the EMPTY root — a
  // silent all-slots-missing action. Unwrap to flat before both.
  if (parsed != null && typeof parsed === "object") {
    const record = parsed as ModelAction;
    const nestedKey = ["intent", "preset", "parse"].find(
      (key) => record[key] != null && typeof record[key] === "object",
    );
    if (nestedKey != null) {
      parsed = { kind: record.kind, ...(record[nestedKey] as ModelAction) };
    }
  }
  const validation = validateModelAction(parsed);
  if (!validation.valid) return null;
  const record = parsed as ModelAction;
  return adaptRecord(doc, record, instruction, String(record.kind));
}
