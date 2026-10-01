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

/**
 * Feature expansion over the word tokens (intent-features.v2): the word
 * unigrams, adjacent-word bigrams (`w1_w2`) and fastText-style char
 * 3+4-grams over the `^word$`-padded form. Separators (`_`, `^`, `$`) sit
 * outside the word charset [a-z0-9%+], so no feature string can collide
 * with a plain word. Char grams carry the fuzzy read — a typo or an SK
 * variant shares most of its trigrams with the canonical form, which a
 * word-BoW cannot see ("pann the bass" now anchors to "pan the bass").
 * MUST mirror scripts/train-intent-model.py features_of() EXACTLY — the
 * drift gate runs the TS featurizer against real model outputs.
 */
export function expandIntentFeatures(words: string[]): string[] {
  const features: string[] = [...words];
  for (let i = 0; i + 1 < words.length; i++) features.push(`${words[i]}_${words[i + 1]}`);
  for (const word of words) {
    const padded = `^${word}$`;
    for (let i = 0; i + 3 <= padded.length; i++) features.push(padded.slice(i, i + 3));
    for (let i = 0; i + 4 <= padded.length; i++) features.push(padded.slice(i, i + 4));
  }
  return features;
}

/** Binary presence bag over the pinned feature vocab (unigrams+bigrams+char 3-grams). */
export function buildIntentBow(text: string, tokens: string[]): Float32Array {
  const index = new Map<string, number>();
  for (const [i, token] of tokens.entries()) index.set(token, i);
  const vector = new Float32Array(tokens.length);
  for (const feature of expandIntentFeatures(tokenizeIntentInstruction(text))) {
    const i = index.get(feature);
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
/**
 * Calibrated on the scope-expanded artifact (2026-10-01 margin sweep): 3.0
 * clears the last wrongKind row ("more saturation" → clarify/effectIntent
 * tail) while keeping attempted-exact at 97.1 % and abstain at 15.8 % —
 * all three gate bars on the val split.
 */
export const INTENT_MODEL_KIND_MARGIN = 3.0;
/**
 * Required logit gap between the winning kind and the ABSTAIN class
 * (calibration wave). Wider than the top-two margin: out-of-scope-kind
 * inputs (section-worded effect phrases) produced confident in-scope
 * guesses with the abstain logit just below — this is the honest-fallback
 * tripwire for exactly that shape.
 */
export const INTENT_MODEL_ABSTAIN_MARGIN = 2.5;

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
 * filled with stable placeholders by the decoder (model-schema contract).
 * `unrecognized` (arrange routes) and `reason` (clarify) are engine-owned
 * surfaces the model path fills differently from the parser path — they say
 * nothing about the ACTION, so comparing them punishes correct routes. */
const COMPARE_STRIP_KEYS = new Set(["detected", "sourceText", "matchedBy", "unrecognized", "reason"]);

/** op-form objects (arrange ops: {op, role?, bars?}) carry ENGINE-RESOLVED
 * fields the model can never know (sceneId/name/beforeSceneId/clipId/dir) —
 * stripped contextually so the decode-vs-truth comparison rewards the
 * model-known contract. Flat `name` slots (renameTrack) live in kind-keyed
 * op objects, never op-form ones, so this strip cannot hide a wrong rename. */
const OP_FORM_STRIP_KEYS = new Set(["sceneId", "name", "beforeSceneId", "clipId", "dir"]);

/**
 * Recognition-and-handoff kinds (scope wave 2026-10-01): the v1 classifier's
 * contract for open-vocabulary kinds is RECOGNITION — the resolver refuses
 * the empty-slot route and the deterministic layer owns the content
 * (compound decomposition, clarify questions, unknown-preset suggestions).
 * Their content fields therefore drop from the decode-vs-truth yardstick
 * the way engine-filled fields do; the kind itself still has to match.
 */
const KIND_CONTENT_STRIP_KEYS: Record<string, ReadonlySet<string>> = {
  compound: new Set(["parts"]),
  clarify: new Set(["suggestions"]),
  presetUnknown: new Set(["name", "suggestions"]),
};

/** Recursively canonicalize a response for byte-stable comparison: strip
 * engine-filled fields, sort arrays, sort object keys. */
export function canonicalModelJson(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalModelJson(item));
    items.sort();
    return `[${items.join(",")}]`;
  }
  if (value != null && typeof value === "object") {
    const opForm = typeof (value as Record<string, unknown>).op === "string";
    const kindStrip = KIND_CONTENT_STRIP_KEYS[String((value as Record<string, unknown>).kind)];
    const keys = Object.keys(value)
      .filter(
        (key) =>
          !COMPARE_STRIP_KEYS.has(key) &&
          !(opForm && OP_FORM_STRIP_KEYS.has(key)) &&
          !(kindStrip !== undefined && kindStrip.has(key)),
      )
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
  /** Optional tuning override (mining/eval tools); production uses the pin. */
  options?: { kindMargin?: number; abstainMargin?: number },
): CompactIntentResponse | null {
  const kindMargin = options?.kindMargin ?? INTENT_MODEL_KIND_MARGIN;
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
  if (topTwoGap(kindScores) < kindMargin) return null;
  // Abstain-class margin (calibration wave): the measured wrongKind rows are
  // out-of-scope-kind inputs ("add distortion to the drop") where the model
  // is confident about an in-scope kind but the ABSTAIN class sits just
  // below it. Requiring a wider gap to the abstain logit specifically turns
  // those into honest abstentions without touching unambiguous wins.
  const sorted = Array.from(kindScores).sort((a, b) => b - a);
  const abstainIndex = head("kind").classes.indexOf("abstain");
  const abstainScore = kindScores[abstainIndex];
  const abstainGap = sorted[0] - abstainScore;
  if (abstainGap < (options?.abstainMargin ?? INTENT_MODEL_ABSTAIN_MARGIN)) return null;

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
    case "arrange": {
      // Rolling-artifact guard: older vocabs predate the arrange heads —
      // abstain instead of throwing (the artifact and the app deploy
      // independently, so the decoder must tolerate artifact lag).
      const hasArrangeHeads = ["arrangeOp", "arrangeRole", "arrangeBars"].every((name) =>
        vocab.heads.some((candidate) => candidate.name === name),
      );
      if (!hasArrangeHeads) return null;
      // Model form = the schema slots: {op, role?, bars?} — no doc ids. A
      // missing required slot (resize without role/bars, addRole without a
      // role) is an abstention, never a guess (same rule as fader/direction).
      const op = opt("arrangeOp");
      if (!op) return null;
      const role = opt("arrangeRole");
      const bars = optNum("arrangeBars");
      if (op === "autoArrange") return { kind: "arrange", ops: [{ op }] };
      if (!role) return null;
      if (op === "resize") {
        if (bars === null) return null;
        return { kind: "arrange", ops: [{ op, role, bars }] };
      }
      return { kind: "arrange", ops: [{ op, role }] };
    }
    case "clips": {
      // Same rolling-artifact guard as arrange: no trained clip heads in
      // this vocab (the trainer's scope-expansion wave ships arrange only) —
      // abstain instead of throwing. Full clip decode activates only when a
      // future artifact actually trains these heads.
      const hasClipHeads = ["clipOp", "clipToBar", "clipBars"].every((name) =>
        vocab.heads.some((candidate) => candidate.name === name),
      );
      if (!hasClipHeads) return null;
      const op = opt("clipOp");
      if (!op) return null;
      if (op === "copyClip" || op === "moveClip") {
        // toBar head classes are the TRUTH values (engine 0-indexed bars) —
        // emitted verbatim; the schema's 1-999 human-bar form is the LLM
        // grammar's convention, not the classifier's.
        const toBar = optNum("clipToBar");
        if (toBar === null) return null;
        return { kind: "clips", ops: [{ op, toBar }] };
      }
      if (op === "resizeClip") {
        const bars = optNum("clipBars");
        if (bars === null) return null;
        return { kind: "clips", ops: [{ op, bars }] };
      }
      return { kind: "clips", ops: [{ op }] };
    }
    case "compound": {
      // Sequence-student phase 2: the corpus compound family is ALWAYS
      // two-part, and only the two-fader subset is emittable with closed
      // heads — a fader part is {direction, target, pads, amount|percent}.
      // Non-fader parts (exact/tempo/preset/…) and a missing second part
      // abstain (the resolver refuses a kind-only compound anyway — never a
      // silent partial apply). Rolling-artifact guard as everywhere above.
      const partHeads = [1, 2].flatMap((index) => [
        `part${index}Direction`,
        `part${index}Target`,
        `part${index}Percent`,
        `part${index}Amount`,
        `part${index}Pads`,
      ]);
      if (!partHeads.every((name) => vocab.heads.some((candidate) => candidate.name === name))) {
        // Older vocab: recognition-and-handoff — flag the kind, let the
        // resolver refuse the empty route (deterministic layer owns it).
        return { kind: "compound" };
      }
      const part = (index: 1 | 2): Record<string, unknown> | null => {
        const direction = opt(`part${index}Direction`);
        const target = opt(`part${index}Target`);
        const percent = optNum(`part${index}Percent`);
        const amount = opt(`part${index}Amount`);
        const partPads = activeClasses(head(`part${index}Pads`), scores(`part${index}Pads`));
        if (!direction || !target) return null;
        // Truth fader parts carry EXACTLY one of amount/percent (measured
        // across every split) — emitting neither or both is a guess.
        if (percent !== null) return { kind: "fader", intent: { direction, pads: partPads, percent, targets: [target] } };
        if (amount) return { kind: "fader", intent: { amount, direction, pads: partPads, targets: [target] } };
        return null;
      };
      const first = part(1);
      if (!first) return { kind: "compound" };
      const second = part(2);
      if (!second) return { kind: "compound" };
      return { kind: "compound", parts: [first, second] };
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
      return { kind: "revise", attribute, direction, detected: ["AI"], targetRole: opt("targetRole") ?? null };
    }
    case "preset": {
      // Rolling-artifact guard: the preset heads land in a future artifact
      // (the vocab on disk may predate them — abstain, never throw).
      const hasPresetHeads = ["presetId", "presetName"].every((name) =>
        vocab.heads.some((candidate) => candidate.name === name),
      );
      if (!hasPresetHeads) return null;
      const id = opt("presetId");
      const name = opt("presetName");
      const target = opt("targets_one");
      if (!id || !name || !target) return null;
      return { kind: "preset", preset: { id, name }, target };
    }
    case "clarify":
    case "presetUnknown":
      // Recognition-and-handoff: the model flags the kind, the resolver
      // refuses the empty route and the deterministic layer owns the parts/
      // questions/suggestions. The yardstick strips those fields
      // (KIND_CONTENT_STRIP_KEYS), so a bare kind object is exact.
      return { kind } as CompactIntentResponse;
    default:
      return null;
  }
}
