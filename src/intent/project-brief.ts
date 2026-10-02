import {
  isMusicalKey,
  type ProjectBriefRole,
  type ProjectProducerBriefFact,
  type ProjectProducerBriefV1,
} from "../project-model/types";
import { sanitizeProjectProducerBrief } from "../project-model/producer-brief";
import type { BriefContract, BriefStatement } from "./brief-contract";
import type { IntentInput, IntentRole } from "./types";
import type { ParsedIntent, ParsedIntentConflict, ParsedIntentConflictKind } from "./text-parser";

function approvedMetadata(statement: BriefStatement): Pick<ProjectProducerBriefFact, "origin" | "confidence"> | null {
  if (statement.origin === "prompt" && statement.confidence === "parsed") {
    return { origin: "prompt", confidence: "parsed" };
  }
  if (statement.origin === "user" && statement.confidence === "confirmed") {
    return { origin: "user", confidence: "confirmed" };
  }
  return null;
}

function roleList(value: unknown): ProjectBriefRole[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const allowed = new Set<ProjectBriefRole>(["drums", "bass", "chords", "lead"]);
  const result: ProjectBriefRole[] = [];
  for (const role of value) {
    if (
      typeof role !== "string" ||
      !allowed.has(role as ProjectBriefRole) ||
      result.includes(role as ProjectBriefRole)
    ) {
      return null;
    }
    result.push(role as ProjectBriefRole);
  }
  return result;
}

/**
 * Build the deliberately small project memory from the visible, compiled
 * brief. Only explicit prompt facts and user-confirmed corrections survive;
 * defaults, session guesses, raw text, audio references and hidden model data
 * never enter the project.
 */
export function createProjectBriefFromContract(
  contract: BriefContract,
  input: IntentInput,
  savedAt = new Date().toISOString(),
): ProjectProducerBriefV1 | null {
  const statements = new Map(contract.statements.map((statement) => [statement.id, statement]));
  const facts: ProjectProducerBriefFact[] = [];
  const addString = (field: "genre" | "style" | "mood") => {
    const statement = statements.get(field);
    const metadata = statement && approvedMetadata(statement);
    const value = input[field];
    if (metadata && typeof value === "string" && value.trim()) {
      facts.push({ field, section: "preference", value: value.trim().slice(0, 80), ...metadata });
    }
  };

  const bpm = statements.get("bpm");
  const bpmMetadata = bpm && approvedMetadata(bpm);
  if (
    bpmMetadata &&
    Array.isArray(input.bpmRange) &&
    input.bpmRange.length === 2 &&
    input.bpmRange.every((value) => typeof value === "number" && Number.isInteger(value) && value >= 40 && value <= 240)
  ) {
    const [low, high] = input.bpmRange as [number, number];
    if (low <= high) facts.push({ field: "bpmRange", section: "hard", value: [low, high], ...bpmMetadata });
  }

  const key = statements.get("key");
  const keyMetadata = key && approvedMetadata(key);
  if (keyMetadata && isMusicalKey(input.key)) {
    facts.push({ field: "key", section: "hard", value: input.key, ...keyMetadata });
  }

  const length = statements.get("length");
  const lengthMetadata = length && approvedMetadata(length);
  if (
    lengthMetadata &&
    typeof input.length === "number" &&
    Number.isInteger(input.length) &&
    input.length >= 16 &&
    input.length <= 4096 &&
    input.length % 16 === 0
  ) {
    facts.push({ field: "length", section: "hard", value: input.length, ...lengthMetadata });
  }

  addString("genre");
  addString("style");
  addString("mood");

  const character = statements.get("character");
  const characterMetadata = character && approvedMetadata(character);
  if (characterMetadata) {
    for (const field of ["energy", "density", "complexity", "variation"] as const) {
      const value = input[field];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) {
        facts.push({ field, section: "preference", value, ...characterMetadata });
      }
    }
  }

  const roleStatement = statements.get("roles");
  const roleMetadata = roleStatement && approvedMetadata(roleStatement);
  const selectedRoles = roleMetadata ? roleList(input.roles) : null;
  if (roleMetadata && selectedRoles) {
    facts.push({ field: "roles", section: "hard", value: selectedRoles, ...roleMetadata });
  }

  const preserveStatements = contract.statements.filter((statement) => statement.id.startsWith("preserve-"));
  const preserveMetadata = preserveStatements.map(approvedMetadata).find((metadata) => metadata !== null) ?? null;
  const preservedRoles = preserveMetadata ? roleList(input.preserve) : null;
  if (preserveMetadata && preservedRoles) {
    facts.push({ field: "preserve", section: "preserve", value: preservedRoles, ...preserveMetadata });
  }

  const prohibitedStatements = contract.statements.filter((statement) => statement.id.startsWith("no-"));
  const prohibitedMetadata = prohibitedStatements.map(approvedMetadata).find((metadata) => metadata !== null) ?? null;
  const prohibited = roleList(prohibitedStatements.flatMap((statement) => (statement.role ? [statement.role] : [])));
  if (prohibitedMetadata && prohibited) {
    facts.push({ field: "prohibitedRoles", section: "prohibition", value: prohibited, ...prohibitedMetadata });
  }

  return sanitizeProjectProducerBrief({ version: 1, savedAt, facts }) ?? null;
}

export interface ProjectBriefIntentPatch {
  input: IntentInput;
  prohibitedRoles: IntentRole[];
}

/** Convert saved, structured facts back into a patch; provenance stays in the project brief. */
export function projectBriefIntentPatch(brief: ProjectProducerBriefV1): ProjectBriefIntentPatch {
  const input: IntentInput = {};
  const prohibitedRoles: IntentRole[] = [];
  for (const fact of brief.facts) {
    switch (fact.field) {
      case "genre":
      case "style":
      case "mood":
      case "bpmRange":
      case "key":
      case "length":
      case "energy":
      case "density":
      case "complexity":
      case "variation":
      case "roles":
      case "preserve":
        input[fact.field] = fact.value as never;
        break;
      case "prohibitedRoles":
        prohibitedRoles.push(...fact.value);
        break;
    }
  }
  return { input, prohibitedRoles };
}

/**
 * Inherit saved facts only where the current prompt did not provide a value.
 * Project protection rules are additive unless the user explicitly corrects
 * them in the visible brief editor.
 */
export function projectBriefCorrectionsFor(
  parsed: ParsedIntent | null,
  brief: ProjectProducerBriefV1 | null | undefined,
): IntentInput {
  if (!brief) return {};
  const saved = projectBriefIntentPatch(brief).input;
  const explicit = parsed?.input ?? {};
  const corrections: IntentInput = {};
  for (const [field, value] of Object.entries(saved)) {
    if (field === "preserve") continue;
    if (!Object.prototype.hasOwnProperty.call(explicit, field)) {
      (corrections as Record<string, unknown>)[field] = value;
    }
  }
  const inheritedPreserve = saved.preserve ?? [];
  if (inheritedPreserve.length > 0) {
    corrections.preserve = [...new Set([...inheritedPreserve, ...(explicit.preserve ?? [])])];
  }
  return corrections;
}

function conflict(role: IntentRole, kind: ParsedIntentConflictKind): ParsedIntentConflict {
  return { id: `project-brief-${kind}-${role}`, role, kind };
}

/** Detect only explicit current-prompt directives that collide with saved hard rules. */
export function projectBriefConflictsFor(
  parsed: ParsedIntent | null,
  brief: ProjectProducerBriefV1 | null | undefined,
): ParsedIntentConflict[] {
  if (!parsed || !brief) return [];
  const saved = projectBriefIntentPatch(brief);
  const currentRoles = parsed.input.roles ?? [];
  const currentPreserve = parsed.input.preserve ?? [];
  const found = new Map<string, ParsedIntentConflict>();
  const add = (role: IntentRole, kind: ParsedIntentConflictKind) => {
    const entry = conflict(role, kind);
    found.set(`${entry.kind}:${entry.role}`, entry);
  };
  for (const role of saved.input.preserve ?? []) {
    if (currentRoles.includes(role)) add(role, "preserve-vs-addition");
    if (parsed.prohibitedRoles.includes(role)) add(role, "prohibition-vs-preserve");
  }
  for (const role of saved.prohibitedRoles) {
    if (currentRoles.includes(role)) add(role, "prohibition-vs-addition");
    if (currentPreserve.includes(role)) add(role, "prohibition-vs-preserve");
  }
  return [...found.values()];
}

/** Retain the saved project rules in the parser-shaped contract consumed by the brief compiler. */
export function parsedWithProjectBrief(
  parsed: ParsedIntent | null,
  brief: ProjectProducerBriefV1 | null | undefined,
): ParsedIntent | null {
  if (!brief) return parsed;
  const saved = projectBriefIntentPatch(brief);
  const additionalConflicts = projectBriefConflictsFor(parsed, brief);
  if (!parsed) {
    return {
      input: {},
      detected: ["saved project brief"],
      prohibitedRoles: saved.prohibitedRoles,
      conflicts: additionalConflicts,
    };
  }
  const conflicts = new Map<string, ParsedIntentConflict>();
  for (const item of [...parsed.conflicts, ...additionalConflicts]) conflicts.set(`${item.kind}:${item.role}`, item);
  return {
    ...parsed,
    prohibitedRoles: [...new Set([...saved.prohibitedRoles, ...parsed.prohibitedRoles])],
    conflicts: [...conflicts.values()],
  };
}

/** Merge a newly saved brief into this project's existing facts by field. */
export function mergeProjectProducerBrief(
  previous: ProjectProducerBriefV1 | undefined,
  next: ProjectProducerBriefV1,
  savedAt = new Date().toISOString(),
): ProjectProducerBriefV1 {
  const facts = new Map(previous?.facts.map((fact) => [fact.field, fact]) ?? []);
  for (const fact of next.facts) facts.set(fact.field, fact);
  const merged = sanitizeProjectProducerBrief({ version: 1, savedAt, facts: [...facts.values()] });
  if (!merged) throw new Error("Cannot merge an empty or invalid Producer Brief.");
  return merged;
}
