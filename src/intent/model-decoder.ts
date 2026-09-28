import type { CompactIntentResponse } from "./dataset";
import type { IntentModelHead, IntentModelVocab } from "./model-loader-types";

export type { IntentModelHead, IntentModelVocab };

/**
 * LOCAL INTENT MODEL v1 — CANONICAL FEATURIZER + HEAD DECODER.
 *
 * The v1 student is NOT a generative LM: it is a small multi-head
 * slot-filling network trained by scripts/train-intent-model.py on the
 * engine-generated SFT corpus (the engine is the teacher). This module is
 * the SINGLE canonical contract shared by:
 *   - the trainer (python re-implements tokenize/bow — drift is caught by
 *     the validate gate, which runs THIS decoder on real ORT outputs),
 *   - scripts/validate-intent-model.mts (assembled exact/kindOK gate),
 *   - the future worker backend (wave 3) that turns head outputs into the
 *     action JSON string the resolver bridge already validates.
 *
 * Every head's class list is CLOSED and corpus-derived; the vocab artifact
 * (public/models/intent-model-v1.vocab.json, written by the trainer) pins
 * the token list AND the head layouts — this decoder reads layouts from the
 * artifact, never from hardcoded duplicates.
 *
 * Kinds outside the classifier's scope (preset, arrange, clips, compound,
 * clarify, presetUnknown — open strings or variable structures) decode to
 * an explicit ABSTAIN: null, i.e. "unsupported, fall back" — never a guess.
 */

/** Instruction tokenizer — MUST stay in sync with the python trainer. */
export function tokenizeIntentInstruction(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9%+]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** Binary presence bag-of-words over the pinned vocab. */
export function buildIntentBow(text: string, tokens: string[]): Float32Array {
  const index = new Map<string, number>();
  for (const [i, token] of tokens.entries()) index.set(token, i);
  const vector = new Float32Array(tokens.length);
  for (const token of tokenizeIntentInstruction(text)) {
    const i = index.get(token);
    if (i !== undefined) vector[i] = 1;
  }
  return vector;
}

const ABSENT = "__absent__";

/**
 * Kind-head abstention, MARGIN-based: the trained logits carry a large
 * shared offset (regularized saturation), so absolute softmax probability
 * is meaningless — the invariant signal is the gap between the top two
 * classes. A margin below this value means the model cannot tell kinds
 * apart: it ABSTAINS (decodes to null = "unsupported, fall back") instead
 * of guessing. This is the rejection option that keeps wrong-kind outputs
 * near zero — a mute must never become a delete (LOCAL-INTENT-MODEL.md §5).
 */
export const INTENT_MODEL_KIND_MARGIN = 1.0;

function topTwoGap(values: Float32Array): number {
  let best = -Infinity;
  let second = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > best) {
      second = best;
      best = values[i];
    } else if (values[i] > second) {
      second = values[i];
    }
  }
  return best - second;
}

function argmaxClass(head: IntentModelHead, scores: Float32Array): string {
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  return head.classes[best] ?? ABSENT;
}

function activeClasses(head: IntentModelHead, scores: Float32Array): string[] {
  // Canonical rule, EXACTLY the trainer's label semantics: a class is
  // active iff its logit is >= 0 (sigmoid >= 0.5). Keeping decode and
  // training labels aligned is what makes the validate gate authoritative;
  // calibration (positives crossing 0) is the trainer's job, not a
  // decoder-side heuristic.
  const active: string[] = [];
  for (let i = 0; i < head.classes.length; i++) {
    if (head.classes[i] !== ABSENT && scores[i] >= 0) active.push(head.classes[i]);
  }
  return active;
}

function num(head: IntentModelHead, scores: Float32Array): number | null {
  const value = argmaxClass(head, scores);
  if (value === ABSENT) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Fields the ENGINE fills at runtime — stripped before exact comparison and
 * filled with stable placeholders by the decoder (model-schema contract). */
const COMPARE_STRIP_KEYS = new Set(["detected", "sourceText", "matchedBy"]);

/** Recursively canonicalize a response for byte-stable comparison: strip
 * engine-filled fields, sort arrays, sort object keys. */
export function canonicalModelJson(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalModelJson(item));
    items.sort();
    return `[${items.join(",")}]`;
  }
  if (value != null && typeof value === "object") {
    const keys = Object.keys(value)
      .filter((key) => !COMPARE_STRIP_KEYS.has(key))
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalModelJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Head output tensors → compact model-form action, or null (abstain).
 * `outputs` maps `head_<name>` to the raw scores for that head.
 */
export function decodeIntentHeads(
  outputs: Record<string, Float32Array>,
  vocab: IntentModelVocab,
): CompactIntentResponse | null {
  const head = (name: string): IntentModelHead => {
    const found = vocab.heads.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`vocab has no head "${name}"`);
    return found;
  };
  const scores = (name: string): Float32Array => {
    const values = outputs[`head_${name}`];
    if (!values) throw new Error(`outputs have no head_${name}`);
    return values;
  };
  const cls = (name: string): string => argmaxClass(head(name), scores(name));
  const opt = (name: string): string | null => {
    const value = cls(name);
    return value === ABSENT ? null : value;
  };
  const optNum = (name: string): number | null => num(head(name), scores(name));

  const kindScores = scores("kind");
  const kind = cls("kind");
  if (kind === ABSENT || kind === "abstain") return null;
  // Margin abstention: an unsure kind is an abstention, never a guess.
  if (topTwoGap(kindScores) < INTENT_MODEL_KIND_MARGIN) return null;

  const targets = activeClasses(head("targets"), scores("targets"));
  const pads = activeClasses(head("pads"), scores("pads"));

  switch (kind) {
    case "fader": {
      const direction = opt("direction");
      if (!direction) return null;
      const intent: Record<string, unknown> = { targets, pads, direction };
      const amount = opt("amount");
      if (amount) intent.amount = amount;
      const percent = optNum("percent");
      if (percent !== null) intent.percent = percent;
      return { kind: "fader", intent };
    }
    case "exact": {
      const opKind = opt("exactOp");
      if (!opKind) return null;
      const target = opt("targets_one");
      let op: Record<string, unknown>;
      if (opKind === "mute" || opKind === "solo") {
        const value = opt("boolValue");
        if (!target || !value) return null;
        op = { kind: opKind, target, value: value === "true" };
      } else if (opKind === "pan") {
        const value = optNum("panValue");
        if (!target || value === null) return null;
        op = { kind: "pan", target, value };
      } else if (opKind === "tempo") {
        const bpm = optNum("bpm");
        if (bpm === null) return null;
        op = { kind: "tempo", bpm };
      } else if (opKind === "key") {
        const key = opt("key");
        if (!key) return null;
        op = { kind: "key", key };
      } else if (opKind === "gainDb") {
        const deltaDb = optNum("deltaDb");
        if (!target || deltaDb === null) return null;
        op = { kind: "gainDb", target, deltaDb };
      } else if (opKind === "transpose") {
        const semitones = optNum("semitones");
        if (!target || semitones === null) return null;
        op = { kind: "transpose", target, semitones };
      } else if (opKind === "patternLength") {
        const steps = optNum("steps");
        if (steps === null) return null;
        op = { kind: "patternLength", steps };
      } else if (opKind === "addTrack") {
        const trackKind = opt("trackKind");
        const instrument = opt("instrument");
        if (!trackKind || !instrument) return null;
        op = { kind: "addTrack", trackKind, instrument };
      } else if (opKind === "removeTrack" || opKind === "duplicateTrack") {
        if (!target) return null;
        op = { kind: opKind, target };
      } else if (opKind === "renameTrack") {
        const name = opt("trackName");
        if (!target || !name) return null;
        op = { kind: "renameTrack", target, name };
      } else {
        return null;
      }
      return { kind: "exact", ops: [op] };
    }
    case "transport": {
      const action = opt("transportAction");
      if (!action) return null;
      return { kind: "transport", action };
    }
    case "save":
      return { kind: "save" };
    case "export": {
      const format = opt("exportFormat");
      if (!format) return null;
      return { kind: "export", format };
    }
    case "record": {
      const arm = opt("boolValue");
      if (!arm) return null;
      return { kind: "record", arm: arm === "true" };
    }
    case "select": {
      const target = opt("selectTarget");
      if (!target) return null;
      return { kind: "select", target };
    }
    case "effectIntent": {
      const effectType = opt("effectType");
      const direction = opt("direction");
      if (!effectType || !direction || targets.length === 0) return null;
      const intent: Record<string, unknown> = {
        effectType,
        targets,
        direction,
        amount: opt("amount") ?? "medium",
        detected: ["AI"],
      };
      const percent = optNum("percent");
      if (percent !== null) intent.percent = percent;
      return { kind: "effectIntent", intent };
    }
    case "sendIntent": {
      const effectType = opt("effectType");
      const direction = opt("direction");
      const target = opt("targets_one");
      if (!effectType || !direction || !target) return null;
      const intent: Record<string, unknown> = { effectType, target, direction };
      const percent = optNum("percent");
      if (percent !== null) intent.percent = percent;
      return { kind: "sendIntent", intent };
    }
    case "bypassIntent": {
      const effectType = opt("effectType");
      const target = opt("targets_one");
      const bypassed = opt("boolValue");
      if (!effectType || !target || !bypassed) return null;
      return { kind: "bypassIntent", intent: { effectType, target, bypassed: bypassed === "true" } };
    }
    case "mix": {
      const overrides: Record<string, string> = {};
      for (const [slot, key] of [
        ["mixReverb", "reverb"],
        ["mixTone", "tone"],
        ["mixPunch", "punch"],
        ["mixPump", "pump"],
      ] as const) {
        const value = opt(slot);
        if (value) overrides[key] = value;
      }
      if (Object.keys(overrides).length === 0) return null;
      return { kind: "mix", overrides, detected: ["AI"] };
    }
    case "loudness": {
      const direction = opt("direction");
      if (!direction) return null;
      const parse: Record<string, unknown> = { direction, detected: ["AI"] };
      const targetDb = optNum("targetDb");
      if (targetDb !== null) parse.targetDb = targetDb;
      return { kind: "loudness", parse };
    }
    case "tempo": {
      const direction = opt("direction");
      if (!direction) return null;
      const intent: Record<string, unknown> = { direction };
      const bpm = optNum("bpm");
      if (bpm !== null) intent.bpm = bpm;
      return { kind: "tempo", intent };
    }
    case "production": {
      const concept = opt("prodConcept");
      const amount = optNum("prodAmount");
      if (!concept || amount === null || targets.length === 0) return null;
      return {
        kind: "production",
        intent: { targets, goals: [{ concept, amount }], sourceText: "" },
      };
    }
    case "revise": {
      const attribute = opt("reviseAttribute");
      const direction = opt("direction");
      if (!attribute || !direction) return null;
      return { kind: "revise", attribute, direction, detected: ["AI"], targetRole: null };
    }
    default:
      // preset / arrange / clips / compound / clarify / presetUnknown —
      // explicitly out of the v1 classifier's scope.
      return null;
  }
}
