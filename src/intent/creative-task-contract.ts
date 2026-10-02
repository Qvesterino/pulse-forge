import { GENRES, type Genre } from "../ai/types";
import { isMusicalKey, MUSICAL_KEYS, type MusicalKey, type ProjectDocument } from "../project-model/types";
import type { BriefConfidence, BriefContract, BriefOrigin, BriefSection } from "./brief-contract";
import type { ParsedIntentConflictKind } from "./text-parser";
import type { IntentInput, IntentRole } from "./types";

export const CREATIVE_TASK_REQUEST_VERSION = 1 as const;
export const CREATIVE_TASK_OUTPUT_VERSION = 1 as const;
export const MAX_CREATIVE_TASK_PROMPT_LENGTH = 2_048;
export const MAX_CREATIVE_TASK_OUTPUT_LENGTH = 16_384;

const ROLES: readonly IntentRole[] = ["drums", "bass", "chords", "lead"];
const CREATIVE_FIELDS = [
  "genre",
  "style",
  "mood",
  "bpmRange",
  "key",
  "length",
  "energy",
  "density",
  "complexity",
  "variation",
  "roles",
  "preserve",
  "prohibitedRoles",
] as const;

export type CreativeTaskField = (typeof CREATIVE_FIELDS)[number];
export type CreativeTaskOperation = "generate" | "revise";

export interface CreativeTaskEvidenceV1 {
  section: BriefSection;
  origin: BriefOrigin;
  confidence: BriefConfidence;
  role?: IntentRole;
}

/**
 * Small, ephemeral, provider-neutral input for creative-task interpretation.
 * The prompt is used only for the current inference; this object must never be
 * persisted to a project, session history, preference ledger or training set.
 */
export interface CreativeTaskRequestV1 {
  version: typeof CREATIVE_TASK_REQUEST_VERSION;
  operation: CreativeTaskOperation;
  prompt: string;
  requirements: {
    bpmRange: [number, number] | null;
    key: MusicalKey | null;
    lengthSteps: number | null;
    targetRoles: IntentRole[];
  };
  preferences: {
    genre: Genre | null;
    style: string | null;
    mood: string | null;
    energy: number | null;
    density: number | null;
    complexity: number | null;
    variation: number | null;
  };
  preserveRoles: IntentRole[];
  prohibitedRoles: IntentRole[];
  unknownFields: CreativeTaskField[];
  conflicts: Array<{ role: IntentRole; kind: ParsedIntentConflictKind }>;
  projectContext: {
    tempo: number | null;
    key: MusicalKey | null;
    hasActivePattern: boolean;
    availableRoles: IntentRole[];
  };
  evidence: CreativeTaskEvidenceV1[];
}

export type CreativeTaskRequestResult =
  { ok: true; request: CreativeTaskRequestV1 } | { ok: false; reason: "prompt-too-long" | "invalid-prompt" };

/**
 * All fields in this shape are suggestions, never an executable DAW action.
 * The local resolver/UI must preserve deterministic and user-confirmed facts;
 * this schema intentionally contains no project, track, pattern or clip IDs.
 */
export interface CreativeTaskOutputV1 {
  version: typeof CREATIVE_TASK_OUTPUT_VERSION;
  status: "proposal" | "clarify" | "abstain";
  suggestions: {
    genre?: Genre;
    style?: string;
    mood?: string;
    bpmRange?: [number, number];
    key?: MusicalKey;
    lengthSteps?: number;
    energy?: number;
    density?: number;
    complexity?: number;
    variation?: number;
    targetRoles?: IntentRole[];
    preserveRoles?: IntentRole[];
    prohibitedRoles?: IntentRole[];
  };
  unknownFields: CreativeTaskField[];
  question?: string;
}

/**
 * JSON-Schema grammar sent to providers that support constrained decoding.
 * The runtime validator below remains authoritative for status-dependent
 * rules and semantic role conflicts that this portable schema cannot express.
 */
export const CREATIVE_TASK_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "status", "suggestions", "unknownFields"],
  properties: {
    version: { type: "integer", enum: [CREATIVE_TASK_OUTPUT_VERSION] },
    status: { type: "string", enum: ["proposal", "clarify", "abstain"] },
    suggestions: {
      type: "object",
      additionalProperties: false,
      properties: {
        genre: { type: "string", enum: [...GENRES] },
        style: { type: "string", minLength: 1, maxLength: 80 },
        mood: { type: "string", minLength: 1, maxLength: 80 },
        bpmRange: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: { type: "integer", minimum: 40, maximum: 240 },
        },
        key: { type: "string", enum: [...MUSICAL_KEYS] },
        lengthSteps: { type: "integer", minimum: 16, maximum: 256, multipleOf: 16 },
        energy: { type: "number", minimum: 0, maximum: 1 },
        density: { type: "number", minimum: 0, maximum: 1 },
        complexity: { type: "number", minimum: 0, maximum: 1 },
        variation: { type: "number", minimum: 0, maximum: 1 },
        targetRoles: {
          type: "array",
          minItems: 1,
          maxItems: ROLES.length,
          uniqueItems: true,
          items: { type: "string", enum: [...ROLES] },
        },
        preserveRoles: {
          type: "array",
          minItems: 1,
          maxItems: ROLES.length,
          uniqueItems: true,
          items: { type: "string", enum: [...ROLES] },
        },
        prohibitedRoles: {
          type: "array",
          minItems: 1,
          maxItems: ROLES.length,
          uniqueItems: true,
          items: { type: "string", enum: [...ROLES] },
        },
      },
    },
    unknownFields: {
      type: "array",
      maxItems: CREATIVE_FIELDS.length,
      uniqueItems: true,
      items: { type: "string", enum: [...CREATIVE_FIELDS] },
    },
    question: { type: "string", maxLength: 240 },
  },
} as const;

export type CreativeTaskOutputError =
  | "invalid-json"
  | "output-too-large"
  | "invalid-shape"
  | "unsupported-version"
  | "invalid-status"
  | "invalid-suggestion"
  | "invalid-unknown-field"
  | "invalid-clarification"
  | "contradictory-suggestion";

export type CreativeTaskOutputResult =
  { ok: true; output: CreativeTaskOutputV1 } | { ok: false; error: CreativeTaskOutputError };

export type CreativeTaskResolutionResult =
  | {
      ok: true;
      intent: IntentInput;
      prohibitedRoles: IntentRole[];
      appliedFields: CreativeTaskField[];
    }
  | {
      ok: false;
      reason:
        "clarification-required" | "field-not-suggested" | "conflicts-with-explicit-intent" | "target-role-unavailable";
      field?: CreativeTaskField;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function rolesOf(value: unknown): IntentRole[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > ROLES.length) return null;
  const roles: IntentRole[] = [];
  for (const role of value) {
    if (typeof role !== "string" || !ROLES.includes(role as IntentRole) || roles.includes(role as IntentRole)) {
      return null;
    }
    roles.push(role as IntentRole);
  }
  return ROLES.filter((role) => roles.includes(role));
}

function bpmRangeOf(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [low, high] = value;
  return typeof low === "number" && typeof high === "number" && Number.isInteger(low) && Number.isInteger(high)
    ? low >= 40 && high <= 240 && low <= high
      ? [low, high]
      : null
    : null;
}

function shortText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= 80 && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

function unit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function roleListFromIntent(value: unknown): IntentRole[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set(
    value.filter((role): role is IntentRole => typeof role === "string" && ROLES.includes(role as IntentRole)),
  );
  return ROLES.filter((role) => selected.has(role));
}

function unknownFieldForStatement(id: string): CreativeTaskField[] {
  switch (id) {
    case "bpm":
      return ["bpmRange"];
    case "key":
      return ["key"];
    case "length":
      return ["length"];
    case "genre":
      return ["genre"];
    case "style":
      return ["style"];
    case "mood":
      return ["mood"];
    case "character":
      return ["energy", "density", "complexity", "variation"];
    default:
      return [];
  }
}

function projectRoles(project: ProjectDocument | null): IntentRole[] {
  if (!project) return [];
  const available = new Set<IntentRole>();
  if (project.tracks.some((track) => track.kind === "drum")) available.add("drums");
  if (project.tracks.some((track) => track.kind === "instrument")) {
    available.add("bass");
    available.add("chords");
    available.add("lead");
  }
  return ROLES.filter((role) => available.has(role));
}

/** Build a bounded request with no project-derived names or internal IDs. */
export function createCreativeTaskRequestV1(args: {
  operation: CreativeTaskOperation;
  prompt: string;
  intent: IntentInput;
  contract: BriefContract;
  project?: ProjectDocument | null;
  defaultRoles?: readonly IntentRole[];
}): CreativeTaskRequestResult {
  if (typeof args.prompt !== "string") return { ok: false, reason: "invalid-prompt" };
  const prompt = args.prompt.trim();
  if (prompt.length > MAX_CREATIVE_TASK_PROMPT_LENGTH) return { ok: false, reason: "prompt-too-long" };

  const intent = args.intent;
  const preserveRoles = roleListFromIntent(intent.preserve);
  const prohibitedRoles = ROLES.filter((role) =>
    args.contract.statements.some((statement) => statement.section === "prohibition" && statement.role === role),
  );
  const baseRoles = roleListFromIntent(intent.roles);
  const targetRoles = (baseRoles.length > 0 ? baseRoles : roleListFromIntent(args.defaultRoles)).filter(
    (role) => !preserveRoles.includes(role) && !prohibitedRoles.includes(role),
  );
  const rawRange = bpmRangeOf(intent.bpmRange);
  const genre =
    typeof intent.genre === "string" && GENRES.includes(intent.genre as Genre) ? (intent.genre as Genre) : null;
  const activePatternExists = Boolean(
    args.project?.patterns.some((pattern) => pattern.id === args.project?.activePatternId),
  );
  const conflicts = args.contract.conflicts.map(({ role, kind }) => ({ role, kind }));
  const unknownFields = [
    ...new Set(
      args.contract.statements
        .filter((statement) => statement.section === "unknown")
        .flatMap((statement) => unknownFieldForStatement(statement.id)),
    ),
  ];
  const evidence = args.contract.statements.map(({ section, origin, confidence, role }) => ({
    section,
    origin,
    confidence,
    ...(role ? { role } : {}),
  }));

  return {
    ok: true,
    request: {
      version: CREATIVE_TASK_REQUEST_VERSION,
      operation: args.operation,
      prompt,
      requirements: {
        bpmRange: rawRange,
        key: isMusicalKey(intent.key) ? intent.key : null,
        lengthSteps:
          typeof intent.length === "number" &&
          Number.isInteger(intent.length) &&
          intent.length >= 16 &&
          intent.length <= 256 &&
          intent.length % 16 === 0
            ? intent.length
            : null,
        targetRoles,
      },
      preferences: {
        genre,
        style: shortText(intent.style),
        mood: shortText(intent.mood),
        energy: unit(intent.energy),
        density: unit(intent.density),
        complexity: unit(intent.complexity),
        variation: unit(intent.variation),
      },
      preserveRoles,
      prohibitedRoles,
      unknownFields,
      conflicts,
      projectContext: {
        tempo:
          args.project && Number.isFinite(args.project.bpm) && args.project.bpm >= 20 && args.project.bpm <= 300
            ? args.project.bpm
            : null,
        key: args.project && isMusicalKey(args.project.key) ? args.project.key : null,
        hasActivePattern: activePatternExists,
        availableRoles: projectRoles(args.project ?? null),
      },
      evidence,
    },
  };
}

function validateSuggestions(value: unknown): CreativeTaskOutputV1["suggestions"] | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "genre",
      "style",
      "mood",
      "bpmRange",
      "key",
      "lengthSteps",
      "energy",
      "density",
      "complexity",
      "variation",
      "targetRoles",
      "preserveRoles",
      "prohibitedRoles",
    ])
  ) {
    return null;
  }
  const suggestions: CreativeTaskOutputV1["suggestions"] = {};
  if ("genre" in value) {
    if (typeof value.genre !== "string" || !GENRES.includes(value.genre as Genre)) return null;
    suggestions.genre = value.genre as Genre;
  }
  for (const field of ["style", "mood"] as const) {
    if (field in value) {
      const text = shortText(value[field]);
      if (text === null) return null;
      suggestions[field] = text;
    }
  }
  if ("bpmRange" in value) {
    const range = bpmRangeOf(value.bpmRange);
    if (!range) return null;
    suggestions.bpmRange = range;
  }
  if ("key" in value) {
    if (!isMusicalKey(value.key)) return null;
    suggestions.key = value.key;
  }
  if ("lengthSteps" in value) {
    if (
      typeof value.lengthSteps !== "number" ||
      !Number.isInteger(value.lengthSteps) ||
      value.lengthSteps < 16 ||
      value.lengthSteps > 256 ||
      value.lengthSteps % 16 !== 0
    ) {
      return null;
    }
    suggestions.lengthSteps = value.lengthSteps;
  }
  for (const field of ["energy", "density", "complexity", "variation"] as const) {
    if (field in value) {
      const amount = unit(value[field]);
      if (amount === null) return null;
      suggestions[field] = amount;
    }
  }
  for (const field of ["targetRoles", "preserveRoles", "prohibitedRoles"] as const) {
    if (field in value) {
      const roles = rolesOf(value[field]);
      if (!roles) return null;
      suggestions[field] = roles;
    }
  }
  return suggestions;
}

/** Strictly validate the model's typed proposal; unknown fields are rejected. */
export function validateCreativeTaskOutput(value: unknown): CreativeTaskOutputResult {
  if (!isRecord(value) || !onlyKeys(value, ["version", "status", "suggestions", "unknownFields", "question"])) {
    return { ok: false, error: "invalid-shape" };
  }
  if (value.version !== CREATIVE_TASK_OUTPUT_VERSION) return { ok: false, error: "unsupported-version" };
  if (value.status !== "proposal" && value.status !== "clarify" && value.status !== "abstain") {
    return { ok: false, error: "invalid-status" };
  }
  const suggestions = validateSuggestions(value.suggestions);
  if (!suggestions) return { ok: false, error: "invalid-suggestion" };
  if (
    !Array.isArray(value.unknownFields) ||
    value.unknownFields.length > CREATIVE_FIELDS.length ||
    value.unknownFields.some(
      (field) => typeof field !== "string" || !CREATIVE_FIELDS.includes(field as CreativeTaskField),
    ) ||
    new Set(value.unknownFields).size !== value.unknownFields.length
  ) {
    return { ok: false, error: "invalid-unknown-field" };
  }
  const question = value.question;
  if (
    question !== undefined &&
    (typeof question !== "string" || question.trim().length > 240 || /[\u0000-\u001f\u007f]/.test(question))
  ) {
    return { ok: false, error: "invalid-clarification" };
  }
  if (value.status !== "clarify" && question !== undefined) return { ok: false, error: "invalid-clarification" };
  const roleConflict =
    (suggestions.targetRoles ?? []).some(
      (role) => suggestions.preserveRoles?.includes(role) || suggestions.prohibitedRoles?.includes(role),
    ) || (suggestions.preserveRoles ?? []).some((role) => suggestions.prohibitedRoles?.includes(role));
  if (roleConflict && value.status !== "clarify") return { ok: false, error: "contradictory-suggestion" };
  if (value.status === "proposal" && Object.keys(suggestions).length === 0) {
    return { ok: false, error: "invalid-suggestion" };
  }
  if (value.status === "clarify" && (typeof question !== "string" || question.trim().length === 0)) {
    return { ok: false, error: "invalid-clarification" };
  }
  if (value.status === "abstain" && (Object.keys(suggestions).length > 0 || question !== undefined)) {
    return { ok: false, error: "invalid-shape" };
  }
  return {
    ok: true,
    output: {
      version: CREATIVE_TASK_OUTPUT_VERSION,
      status: value.status,
      suggestions,
      unknownFields: value.unknownFields as CreativeTaskField[],
      ...(typeof question === "string" ? { question: question.trim() } : {}),
    },
  };
}

/** Parse bounded JSON from a provider; failures remain data, never exceptions. */
export function parseCreativeTaskOutputJson(raw: string): CreativeTaskOutputResult {
  if (raw.length > MAX_CREATIVE_TASK_OUTPUT_LENGTH) return { ok: false, error: "output-too-large" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  return validateCreativeTaskOutput(value);
}

function suggestionValue(output: CreativeTaskOutputV1, field: CreativeTaskField): unknown {
  switch (field) {
    case "length":
      return output.suggestions.lengthSteps;
    case "roles":
      return output.suggestions.targetRoles;
    case "preserve":
      return output.suggestions.preserveRoles;
    case "prohibitedRoles":
      return output.suggestions.prohibitedRoles;
    default:
      return output.suggestions[field];
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

/**
 * Materialize only fields the user explicitly approved. Model suggestions
 * cannot override parsed/project/user facts, and role safety conflicts fail
 * atomically instead of silently narrowing or expanding generation scope.
 */
export function resolveApprovedCreativeTaskOutput(args: {
  output: CreativeTaskOutputV1;
  intent: IntentInput;
  availableRoles: readonly IntentRole[];
  existingProhibitedRoles?: readonly IntentRole[];
  approvedFields: readonly string[];
}): CreativeTaskResolutionResult {
  if (args.output.status !== "proposal") return { ok: false, reason: "clarification-required" };
  const approved: CreativeTaskField[] = [];
  for (const field of args.approvedFields) {
    if (!isCreativeTaskField(field) || approved.includes(field) || suggestionValue(args.output, field) === undefined) {
      return { ok: false, reason: "field-not-suggested", ...(isCreativeTaskField(field) ? { field } : {}) };
    }
    approved.push(field);
  }

  const intent: IntentInput = { ...args.intent };
  const approvedSet = new Set(approved);
  const suggestedProhibitions = approvedSet.has("prohibitedRoles")
    ? (args.output.suggestions.prohibitedRoles ?? [])
    : [];
  const suggestedPreserve = approvedSet.has("preserve") ? (args.output.suggestions.preserveRoles ?? []) : [];
  const prohibitedRoles = ROLES.filter((role) =>
    new Set([...(args.existingProhibitedRoles ?? []), ...suggestedProhibitions]).has(role),
  );
  const preservedRoles = ROLES.filter((role) =>
    new Set([...(Array.isArray(args.intent.preserve) ? args.intent.preserve : []), ...suggestedPreserve]).has(role),
  );
  const proposedTargetRoles = args.output.suggestions.targetRoles;
  const baseTargetRoles = roleListFromIntent(args.intent.roles);
  if (approved.includes("roles") && Object.prototype.hasOwnProperty.call(args.intent, "roles")) {
    const suggestedRoles = proposedTargetRoles ?? [];
    if (!sameValue(baseTargetRoles, suggestedRoles)) {
      return { ok: false, reason: "conflicts-with-explicit-intent", field: "roles" };
    }
  }
  const effectiveTargetRoles = approved.includes("roles") ? (proposedTargetRoles ?? []) : baseTargetRoles;
  if (approved.includes("roles") && effectiveTargetRoles.some((role) => !args.availableRoles.includes(role))) {
    return { ok: false, reason: "target-role-unavailable", field: "roles" };
  }
  if (effectiveTargetRoles.some((role) => preservedRoles.includes(role) || prohibitedRoles.includes(role))) {
    return {
      ok: false,
      reason: "conflicts-with-explicit-intent",
      field: effectiveTargetRoles.some((role) => preservedRoles.includes(role)) ? "preserve" : "prohibitedRoles",
    };
  }
  if (preservedRoles.some((role) => prohibitedRoles.includes(role))) {
    return { ok: false, reason: "conflicts-with-explicit-intent", field: "preserve" };
  }
  if (approved.includes("prohibitedRoles") && prohibitedRoles.some((role) => baseTargetRoles.includes(role))) {
    return { ok: false, reason: "conflicts-with-explicit-intent", field: "prohibitedRoles" };
  }

  const appliedFields: CreativeTaskField[] = [];
  for (const field of approved) {
    if (field === "roles" || field === "preserve" || field === "prohibitedRoles") continue;
    const value = suggestionValue(args.output, field);
    const intentKey = field === "length" ? "length" : field;
    if (Object.prototype.hasOwnProperty.call(args.intent, intentKey)) {
      if (!sameValue(args.intent[intentKey], value)) {
        return { ok: false, reason: "conflicts-with-explicit-intent", field };
      }
      continue;
    }
    (intent as Record<string, unknown>)[intentKey] = value;
    appliedFields.push(field);
  }
  if (approved.includes("roles") && !Object.prototype.hasOwnProperty.call(args.intent, "roles")) {
    intent.roles = proposedTargetRoles;
    appliedFields.push("roles");
  }
  if (approved.includes("preserve")) {
    intent.preserve = preservedRoles;
    appliedFields.push("preserve");
  }
  if (approved.includes("prohibitedRoles")) appliedFields.push("prohibitedRoles");

  return { ok: true, intent, prohibitedRoles, appliedFields };
}

/** Type guard for callers building explicit allowlisted task patches. */
export function isCreativeTaskField(value: string): value is CreativeTaskField {
  return CREATIVE_FIELDS.includes(value as CreativeTaskField);
}
