import type { ProjectDocument } from "../project-model/types";

/**
 * LOCAL INTENT MODEL — MODEL-FACING ACTION SCHEMA + CONSTRAINED DECODING.
 *
 * The model's job is deliberately MINIMAL. It never emits prose, ids, or
 * derived values — only a compact action object built from short enums and
 * integers. Everything else is ENGINE-FILLED:
 *
 *   model speaks            → engine owns
 *   ─────────────────────────────────────────────────────────────
 *   "50%" (integer)         → gain 0.75, knob 0.25 (unit translation)
 *   "bass" / "lead" (enum)  → track-id resolution (strict, no guessing)
 *   preset NAME             → fuzzy id match + unknownPreset suggestions
 *   clip REF ("intro")      → clip-id resolution against the live doc
 *   (nothing)               → detected[], matchedBy, suggestions, readbacks
 *
 * With GBNF-constrained decoding (llama.cpp-class runtimes) the model
 * PHYSICALLY CANNOT emit an action outside this schema — it is choosing
 * among legal tokens, not inventing JSON. That is what makes a 1.2B-class
 * model viable: the hard part (grammar, ids, units, side effects) is the
 * engine's, the model only classifies intent and fills slots.
 */

// ── Vocabularies (mirrors of the engine enums — single source per value) ────

export const VOCAB = {
  kind: [
    "fader",
    "exact",
    "transport",
    "save",
    "export",
    "record",
    "select",
    "preset",
    "effectIntent",
    "sendIntent",
    "bypassIntent",
    "mix",
    "loudness",
    "tempo",
    "production",
    "revise",
    "arrange",
    "clips",
    "compound",
    "clarify",
    "presetUnknown",
    "stepEdit",
    "soundSwap",
  ] as const,
  faderTarget: ["drums", "bass", "chords", "lead", "master"] as const,
  padFamily: ["kick", "snare", "clap", "hat", "perc", "tom"] as const,
  faderAmount: ["subtle", "normal", "big", "full"] as const,
  faderDirection: ["down", "up", "set"] as const,
  mixTarget: ["drums", "bass", "chords", "lead", "vocal"] as const,
  effectType: [
    "reverb",
    "delay",
    "saturation",
    "distortion",
    "chorus",
    "flanger",
    "phaser",
    "tremolo",
    "bitcrusher",
    "compressor",
    "pump",
    "eq",
  ] as const,
  effectDirection: ["more", "less", "remove", "set"] as const,
  sendDirection: ["more", "less", "set", "remove"] as const,
  productionTarget: ["drums", "bass", "lead", "chords", "kick", "snare", "hats"] as const,
  productionConcept: [
    "deeper",
    "punchier",
    "warmer",
    "darker",
    "brighter",
    "wider",
    "grittier",
    "glue",
    "lofi",
    "wobbly",
    "robotic",
    "metallic",
    "telephone",
    "tape",
    "stutter",
  ] as const,
  transportAction: ["play", "pause", "stop", "metronomeOn", "metronomeOff", "loopOn", "loopOff"] as const,
  exportFormat: ["wav", "mp3"] as const,
  exactTarget: ["drums", "bass", "lead", "chords", "mix"] as const,
  exactOp: [
    "mute",
    "solo",
    "pan",
    "gainDb",
    "transpose",
    "tempo",
    "key",
    "patternLength",
    "addTrack",
    "removeTrack",
    "renameTrack",
    "duplicateTrack",
  ] as const,
  arrangeRole: ["intro", "build", "chorus", "verse", "bridge", "drop", "break", "outro", "fill"] as const,
  arrangeOp: ["addRole", "remove", "duplicate", "reorder", "resize", "autoArrange"] as const,
  clipOp: ["copyClip", "moveClip", "resizeClip", "deleteClip"] as const,
  reviseAttribute: ["energy", "density"] as const,
  reviseDirection: ["more", "less"] as const,
  loudnessDirection: ["louder", "quieter"] as const,
};

// ── The model-facing schema, as data (drives validation AND GBNF) ───────────

export type SlotType =
  "enum" | "int" | "number" | "bool" | "scalar" | "string" | "stringArray" | "partsArray" | "enumArray" | "objArray";

export interface Slot {
  name: string;
  type: SlotType;
  /** enum values */
  values?: readonly string[];
  /** for objArray: the sub-object slots */
  slots?: Slot[];
  min?: number;
  max?: number;
  required?: boolean;
  /** read from the ROOT record instead of the nested payload */
  root?: boolean;
}

export interface ActionSpec {
  slots: Slot[];
}

const E = (name: string, values: readonly string[], required = true, root = false): Slot => ({
  name,
  type: "enum",
  values,
  required,
  root,
});
const I = (name: string, min: number, max: number, required = false): Slot => ({
  name,
  type: "int",
  min,
  max,
  required,
});
const T = (name: string, required = true): Slot => ({ name, type: "string", required });
const B = (name: string, required = true): Slot => ({ name, type: "bool", required });
/** Free-form string array (clarify/presetUnknown suggestion lists). */
const SA = (name: string, required = true): Slot => ({ name, type: "stringArray", required });
/** Compound sub-actions: model emits JSON strings, engine-form holds objects —
 *  structural validation of each part happens in the model adapter. */
const PA = (name: string, required = true): Slot => ({ name, type: "partsArray", required });
/** Finite float within a range ("deltaDb 1.5", pan value 0.3). */
const N = (name: string, min: number, max: number, required = false): Slot => ({
  name,
  type: "number",
  min,
  max,
  required,
});
/** Boolean OR number — the exact-op `value` is bool (mute/solo) or −1..1 (pan). */
const SC = (name: string, min: number, max: number, required = false): Slot => ({
  name,
  type: "scalar",
  min,
  max,
  required,
});
const EA = (name: string, values: readonly string[], required = false): Slot => ({
  name,
  type: "enumArray",
  values,
  required,
});
const OA = (name: string, slots: Slot[], required = true): Slot => ({ name, type: "objArray", slots, required });

/** The full model-facing action schema — one spec per kind. */
export const MODEL_ACTIONS: Record<string, ActionSpec> = {
  fader: {
    slots: [
      EA("targets", VOCAB.faderTarget),
      EA("pads", VOCAB.padFamily),
      E("direction", VOCAB.faderDirection),
      I("percent", 0, 100),
      E("amount", VOCAB.faderAmount, false),
    ],
  },
  exact: {
    slots: [
      OA("ops", [
        E("kind", VOCAB.exactOp),
        // pad families included: mute/pan ops address pads; destructive ops
        // keep their parse-level guards (the applier still rejects them)
        E("target", [...VOCAB.exactTarget, "kick", "snare", "hats"], false),
        SC("value", -1, 1, false),
        N("panValue", -100, 100, false),
        I("bpm", 20, 300, false),
        N("deltaDb", -24, 24, false),
        I("semitones", -36, 36, false),
        I("steps", 16, 256, false),
        T("name", false),
      ]),
    ],
  },
  transport: { slots: [E("action", VOCAB.transportAction)] },
  save: { slots: [] },
  export: { slots: [E("format", VOCAB.exportFormat)] },
  record: { slots: [B("arm")] },
  select: { slots: [E("target", ["bass", "lead", "chords", "drums"])] },
  // `target` is OPTIONAL: the trained model drops it more often than it keeps
  // it, and the engine owns the family anyway — presetFrom infers it from the
  // matched preset's instrument family (best-scored across the three lanes).
  preset: { slots: [T("name"), E("target", ["bass", "lead", "chords"], false, true)] },
  effectIntent: {
    slots: [
      E("effectType", VOCAB.effectType),
      EA("targets", VOCAB.mixTarget),
      E("direction", VOCAB.effectDirection),
      I("percent", 0, 100),
    ],
  },
  sendIntent: {
    slots: [
      E("effectType", VOCAB.effectType),
      E("target", VOCAB.mixTarget),
      E("direction", VOCAB.sendDirection),
      I("percent", 0, 100),
    ],
  },
  bypassIntent: {
    slots: [E("effectType", VOCAB.effectType), E("target", VOCAB.mixTarget), B("bypassed")],
  },
  mix: {
    slots: [
      E("reverb", ["more", "less", "huge"], false),
      E("tone", ["dark", "bright", "warm", "cold"], false),
      E("punch", ["more", "less"], false),
      E("pump", ["on", "off"], false),
    ],
  },
  loudness: { slots: [E("direction", VOCAB.loudnessDirection), I("targetLUFS", -60, 0, false)] },
  tempo: { slots: [E("direction", ["down", "up", "set"]), I("bpm", 40, 220, false)] },
  production: {
    slots: [
      EA("targets", VOCAB.productionTarget),
      OA("goals", [E("concept", VOCAB.productionConcept), N("amount", 0, 1)]),
    ],
  },
  revise: {
    slots: [
      E("attribute", VOCAB.reviseAttribute),
      E("direction", VOCAB.reviseDirection),
      E("targetRole", VOCAB.arrangeRole, false),
    ],
  },
  arrange: {
    slots: [OA("ops", [E("op", VOCAB.arrangeOp), E("role", VOCAB.arrangeRole, false), I("bars", 1, 64, false)])],
  },
  clips: {
    slots: [
      OA("ops", [
        E("op", VOCAB.clipOp),
        // the clip REFERENCE the model can know from the text — never an id
        E("ref", VOCAB.arrangeRole, false),
        I("atBar", 1, 999, false),
        I("toBar", 1, 999, false),
        I("bars", 1, 64, false),
      ]),
    ],
  },
  compound: {
    // nested sub-actions reference the same kinds — the grammar keeps it to
    // one level (fader | tempo | effect | send | bypass | preset | exact)
    slots: [PA("parts")],
  },
  clarify: { slots: [SA("suggestions")] },
  presetUnknown: { slots: [T("name"), SA("suggestions", false)] },
  stepEdit: {
    slots: [
      E("action", ["remove", "ghost", "accent"]),
      E("family", ["kick", "snare", "clap", "hat", "perc", "tom"]),
      I("bar", 1, 64),
      I("beat", 1, 4),
    ],
  },
  soundSwap: {
    slots: [
      E("family", ["kick", "snare", "clap", "hat", "perc", "tom"]),
      E("descriptor", ["fatter", "thinner", "tighter", "darker", "brighter", "harder", "softer"]),
    ],
  },
};

// ── Validation (dependency-free — runs at runtime on model output) ──────────

export interface ValidationResult {
  valid: boolean;
  /** required-slot problems the model must fix */
  errors: string[];
  /** engine-filled/extra keys — allowed, but the engine ignores them */
  extras: string[];
}

function validateSlotValue(value: unknown, slot: Slot, path: string, errors: string[]): void {
  if (value == null) {
    if (slot.required) errors.push(`${path}: missing ${slot.name}`);
    return;
  }
  switch (slot.type) {
    case "enum":
      if (typeof value !== "string" || !(slot.values ?? []).includes(value)) {
        errors.push(`${path}: ${slot.name} must be one of ${(slot.values ?? []).join("|")}`);
      }
      return;
    case "enumArray":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !(slot.values ?? []).includes(v))) {
        errors.push(`${path}: ${slot.name} must be an array of ${(slot.values ?? []).join("|")}`);
      }
      return;
    case "int": {
      const min = slot.min ?? Number.NEGATIVE_INFINITY;
      const max = slot.max ?? Number.POSITIVE_INFINITY;
      if (typeof value !== "number" || !Number.isInteger(value)) {
        errors.push(`${path}: ${slot.name} must be an integer`);
      } else if (value < min || value > max) {
        errors.push(`${path}: ${slot.name} out of range ${min}..${max}`);
      }
      return;
    }
    case "number":
    case "scalar": {
      const min = slot.min ?? Number.NEGATIVE_INFINITY;
      const max = slot.max ?? Number.POSITIVE_INFINITY;
      const isNumber = typeof value === "number" && Number.isFinite(value);
      const isBool = typeof value === "boolean";
      if (slot.type === "scalar" ? !(isBool || isNumber) : !isNumber) {
        errors.push(`${path}: ${slot.name} must be ${slot.type === "scalar" ? "a boolean or number" : "a number"}`);
      } else if (isNumber && (value < min || value > max)) {
        errors.push(`${path}: ${slot.name} out of range ${min}..${max}`);
      }
      return;
    }
    case "string":
      if (typeof value !== "string" || value.trim() === "") {
        errors.push(`${path}: ${slot.name} must be a non-empty string`);
      }
      return;
    case "bool":
      if (typeof value !== "boolean") errors.push(`${path}: ${slot.name} must be a boolean`);
      return;
    case "stringArray":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        errors.push(`${path}: ${slot.name} must be an array of strings`);
      }
      return;
    case "partsArray":
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((v) => typeof v !== "string" && typeof v !== "object")
      ) {
        errors.push(`${path}: ${slot.name} must be a non-empty array of sub-actions`);
      }
      return;
    case "objArray":
      if (!Array.isArray(value)) {
        errors.push(`${path}: ${slot.name} must be an array`);
        return;
      }
      for (const [index, item] of value.entries()) {
        if (item == null || typeof item !== "object") {
          errors.push(`${path}: ${slot.name}[${index}] must be an object`);
          continue;
        }
        for (const sub of slot.slots ?? []) {
          const subValue = (item as Record<string, unknown>)[sub.name];
          if (subValue == null) continue; // sub-slots are optional by default
          validateSlotValue(subValue, sub, `${path}.${slot.name}[${index}]`, errors);
        }
      }
      return;
  }
}

/**
 * Validate a MODEL-emitted action against the schema. Extra keys are
 * allowed-but-reported (the engine ignores them); missing or out-of-domain
 * required slots are hard errors. `kind` must be a known action kind.
 */
export function validateModelAction(action: unknown): ValidationResult {
  const errors: string[] = [];
  const extras: string[] = [];
  if (action == null || typeof action !== "object") {
    return { valid: false, errors: ["action must be an object"], extras };
  }
  const record = action as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !(kind in MODEL_ACTIONS)) {
    return { valid: false, errors: [`unknown kind: ${String(kind)}`], extras };
  }
  // Kinds whose payload nests under a wrapper key (fader/effectIntent/send/
  // tempo/production/bypassIntent → `intent`; preset → `preset`; loudness →
  // `parse`) validate against the nested object; flat kinds (exact/export/
  // select/transport/…) validate against the record itself.
  const nestedKey = ["intent", "preset", "parse"].find((key) => record[key] != null && typeof record[key] === "object");
  const payload = (nestedKey != null ? record[nestedKey] : record) as Record<string, unknown>;
  for (const slot of MODEL_ACTIONS[kind].slots) {
    const source = slot.root === true ? record : payload;
    validateSlotValue(source[slot.name], slot, kind, errors);
  }
  const known = new Set(["intent", "preset", "parse", ...MODEL_ACTIONS[kind].slots.map((slot) => slot.name)]);
  for (const key of Object.keys(record)) {
    if (key !== "kind" && !known.has(key)) extras.push(`${kind}.${key}`);
  }
  return { valid: errors.length === 0, errors, extras };
}

// ── GBNF constrained-decoding grammar (llama.cpp-class runtimes) ────────────

function gbnfEnum(name: string, values: readonly string[]): string {
  return `${name} ::= ${values.map((value) => `"${value}"`).join(" | ")}`;
}

function gbnfSlot(kind: string, slot: Slot): string[] {
  const rule = `${kind}-${slot.name}`;
  switch (slot.type) {
    case "enum":
      return [gbnfEnum(rule, slot.values ?? [])];
    case "enumArray": {
      const item = `${rule}-item`;
      return [gbnfEnum(item, slot.values ?? []), `${rule} ::= "[" ws ( ${item} ( "," ws ${item} )* )? "]"`];
    }
    case "int": {
      const digits = String(Math.max(1, Math.abs(slot.max ?? 100))).length;
      return [`${rule} ::= [0-9]{1,${Math.max(1, digits)}}`];
    }
    case "number":
      return [`${rule} ::= "-"? [0-9]+ ("." [0-9]+)?`];
    case "scalar":
      return [`${rule} ::= "true" | "false" | "-"? [0-9]+ ("." [0-9]+)?`];
    case "string":
      return [`${rule} ::= "\\"" ( [^"\\\\] )* "\\""`];
    case "stringArray":
    case "partsArray":
      // partsArray: the model emits each sub-action as a JSON-encoded string
      return [
        `${rule} ::= "[" ws ( ${rule}-str ( "," ws ${rule}-str )* )? "]"`,
        `${rule}-str ::= "\\"" ( [^"\\\\] )* "\\"`,
      ];
    case "bool":
      return [`${rule} ::= "true" | "false"`];
    case "objArray": {
      const obj = `${rule}-obj`;
      const lines: string[] = [];
      for (const sub of slot.slots ?? []) lines.push(...gbnfSlot(`${rule}`, sub));
      const members = (slot.slots ?? [])
        .map((sub) => `"\\"${sub.name}\\"" ws ":" ws ${rule}-${sub.name}`)
        .join(' ws "," ws ');
      lines.push(`${obj} ::= "{" ws ( ${members} )? ws "}"`);
      lines.push(`${rule} ::= "[" ws ( ${obj} ( "," ws ${obj} )* )? "]"`);
      return lines;
    }
  }
}

/**
 * Deterministic GBNF grammar constraining model output to the action
 * schema. Feed it to llama.cpp-class runtimes (the `grammar` sampling
 * parameter) and the model can only emit schema-legal JSON — the core
 * enabler for a 1.2B-class model: constrained decoding turns open-ended
 * generation into slot selection among legal tokens.
 *
 * Member order follows each kind's slot order; optional slots may be
 * omitted entirely (the engine treats absent == default). Regenerated on
 * every call from MODEL_ACTIONS — a vocab change updates the grammar with
 * the same commit as the parsers.
 */
export function toGbnfGrammar(): string {
  const lines: string[] = ["root ::= " + VOCAB.kind.map((kind) => kind).join(" | "), "ws ::= [ \\t\\n]*"];
  for (const kind of VOCAB.kind) {
    const spec = MODEL_ACTIONS[kind];
    const body =
      `"kind" ws ":" ws "${kind}"` +
      spec.slots.map((slot) => `, ws "${slot.name}" ws ":" ws ${kind}-${slot.name}`).join("");
    lines.push(`${kind} ::= "{" ws ${body} ws "}"`);
    for (const slot of spec.slots) lines.push(...gbnfSlot(kind, slot));
  }
  return lines.join("\n");
}

/**
 * Engine-side resolution the model never performs: preset name → fuzzy id
 * match (parsePresetIntent semantics), clip ref ("intro"/"bar 3"/"second")
 * → clip id (resolveClipTarget semantics), fader percent → absolute gain,
 * effect percent → knob units. The functions live in their intent modules;
 * this constant pins the contract in one place for the integration layer.
 */
export const ENGINE_FILLED_FIELDS: readonly string[] = [
  "detected",
  "matchedBy",
  "sourceText",
  "suggestions",
  "reason",
  "clipId",
  "presetId",
];

/** Runtime guard used by the future local-model resolver (loader wave). */
export function validateModelOutputForDoc(action: unknown, _doc: ProjectDocument): ValidationResult {
  // target-family resolution against the doc happens in the adapters; the
  // schema-level check is doc-independent by design
  return validateModelAction(action);
}

// ── JSON Schema (Ollama structured outputs / JSON-schema runtimes) ──────────

type JsonObjectSchema = Record<string, unknown>;

function slotToJsonSchema(slot: Slot): JsonObjectSchema {
  switch (slot.type) {
    case "enum":
      return { type: "string", enum: [...(slot.values ?? [])] };
    case "enumArray":
      return { type: "array", items: { type: "string", enum: [...(slot.values ?? [])] } };
    case "int":
      return { type: "integer", minimum: slot.min ?? -1e9, maximum: slot.max ?? 1e9 };
    case "number":
      return { type: "number", minimum: slot.min ?? -1e9, maximum: slot.max ?? 1e9 };
    case "scalar":
      return { anyOf: [{ type: "boolean" }, { type: "number", minimum: slot.min ?? -1e9, maximum: slot.max ?? 1e9 }] };
    case "string":
      return { type: "string" };
    case "stringArray":
      return { type: "array", items: { type: "string" } };
    case "partsArray":
      // sub-actions as JSON-encoded strings (mirrors the GBNF string-array form)
      return { type: "array", items: { type: "string" } };
    case "bool":
      return { type: "boolean" };
    case "objArray": {
      const properties: Record<string, JsonObjectSchema> = {};
      for (const sub of slot.slots ?? []) properties[sub.name] = slotToJsonSchema(sub);
      return { type: "array", items: { type: "object", properties, additionalProperties: false } };
    }
  }
}

/**
 * The model-facing action schema as a JSON Schema (discriminated anyOf, one
 * branch per kind) — the input format for Ollama structured outputs and
 * other JSON-schema-constrained runtimes. GBNF (`toGbnfGrammar`) and this
 * function express the SAME MODEL_ACTIONS; a vocab change moves both with
 * the same commit. Flat per-kind objects — the resolver adapters read flat
 * records, and `validateModelAction` accepts flat wrapper kinds too.
 */
export function toJsonObjectSchema(): JsonObjectSchema {
  const branches: JsonObjectSchema[] = [];
  for (const kind of VOCAB.kind) {
    const spec = MODEL_ACTIONS[kind];
    const properties: Record<string, JsonObjectSchema> = { kind: { const: kind } };
    const required: string[] = ["kind"];
    for (const slot of spec.slots) {
      properties[slot.name] = slotToJsonSchema(slot);
      if (slot.required) required.push(slot.name);
    }
    branches.push({ type: "object", properties, required, additionalProperties: false });
  }
  return { anyOf: branches };
}
