import { GENRES } from "../ai/types";
import { isMusicalKey } from "../project-model/types";
import { INTENT_SCHEMA_VERSION, type IntentInput, type IntentSpec, type IntentRole } from "./types";

const ROLES: readonly IntentRole[] = ["drums", "bass", "chords", "lead"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUnit(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isRole(value: unknown): value is IntentRole {
  return typeof value === "string" && ROLES.includes(value as IntentRole);
}

/** Validate the normalized contract, without mutating or applying defaults. */
export function validateIntentSpec(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["intent must be an object"];
  if (value.version !== INTENT_SCHEMA_VERSION) errors.push("unsupported intent schema version");
  if (!GENRES.includes(value.genre as typeof GENRES[number])) errors.push("genre is invalid");
  if (value.style !== null && typeof value.style !== "string") errors.push("style must be string or null");
  if (value.mood !== null && typeof value.mood !== "string") errors.push("mood must be string or null");
  for (const field of ["energy", "density", "complexity", "variation"] as const) {
    if (!isUnit(value[field])) errors.push(`${field} must be between 0 and 1`);
  }
  if (typeof value.seed !== "string") errors.push("seed must be a string");
  if (value.key !== null && !isMusicalKey(value.key)) errors.push("key is invalid");
  if (value.bpmRange !== null) {
    if (!Array.isArray(value.bpmRange) || value.bpmRange.length !== 2 || !value.bpmRange.every(isFiniteNumber)) {
      errors.push("bpmRange must be a two-number tuple or null");
    }
  }
  if (!isFiniteNumber(value.length) || !Number.isInteger(value.length) || value.length < 16 || value.length % 16 !== 0) {
    errors.push("length must be a positive multiple of 16");
  }
  if (!Array.isArray(value.roles) || value.roles.length === 0 || !value.roles.every(isRole)) errors.push("roles are invalid");
  if (!isRecord(value.targetTracks)) errors.push("targetTracks must be an object");
  if (!isRecord(value.constraints)) errors.push("constraints must be an object");
  if (!isRecord(value.controls)) errors.push("controls must be an object");
  if (isRecord(value.controls)) {
    if (!isUnit(value.controls.ghostWeight)) errors.push("controls.ghostWeight must be between 0 and 1");
    if (!isUnit(value.controls.microWeight)) errors.push("controls.microWeight must be between 0 and 1");
    if (!isUnit(value.controls.velocityVariation)) errors.push("controls.velocityVariation must be between 0 and 1");
    if (!isFiniteNumber(value.controls.temperature) || value.controls.temperature < 0.2 || value.controls.temperature > 2) {
      errors.push("controls.temperature must be between 0.2 and 2");
    }
  }
  if (value.replaceMode !== "new" && value.replaceMode !== "replace") errors.push("replaceMode is invalid");
  if (typeof value.applyGrooveSettings !== "boolean") errors.push("applyGrooveSettings must be boolean");
  return errors;
}

export function isIntentSpec(value: unknown): value is IntentSpec {
  return validateIntentSpec(value).length === 0;
}

export function assertIntentSpec(value: unknown): asserts value is IntentSpec {
  const errors = validateIntentSpec(value);
  if (errors.length > 0) throw new Error(`Invalid IntentSpec: ${errors.join(", ")}`);
}

/** Keep schema parsing explicit for callers receiving JSON or provider data. */
export function parseIntentSpec(value: unknown): IntentSpec {
  assertIntentSpec(value);
  return value;
}

export function isIntentInput(value: unknown): value is IntentInput {
  return isRecord(value);
}
