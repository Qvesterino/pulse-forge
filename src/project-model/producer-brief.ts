import {
  isMusicalKey,
  type ProjectBriefConfidence,
  type ProjectBriefOrigin,
  type ProjectBriefRole,
  type ProjectProducerBriefFact,
  type ProjectProducerBriefV1,
} from "./types";

const BRIEF_ROLES = new Set<ProjectBriefRole>(["drums", "bass", "chords", "lead"]);
const BRIEF_FIELDS = new Set([
  "genre",
  "style",
  "mood",
  "bpmRange",
  "key",
  "length",
  "roles",
  "energy",
  "density",
  "complexity",
  "variation",
  "preserve",
  "prohibitedRoles",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roles(value: unknown): ProjectBriefRole[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > BRIEF_ROLES.size) return null;
  const result: ProjectBriefRole[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !BRIEF_ROLES.has(item as ProjectBriefRole) ||
      result.includes(item as ProjectBriefRole)
    ) {
      return null;
    }
    result.push(item as ProjectBriefRole);
  }
  return result;
}

function sanitizeFact(raw: unknown): ProjectProducerBriefFact | null {
  if (!record(raw)) return null;
  const field = raw.field;
  const section = raw.section;
  const origin = raw.origin;
  const confidence = raw.confidence;
  if (typeof field !== "string" || !BRIEF_FIELDS.has(field)) return null;
  if (origin !== "prompt" && origin !== "user") return null;
  if (confidence !== "parsed" && confidence !== "confirmed") return null;
  if ((origin === "prompt" && confidence !== "parsed") || (origin === "user" && confidence !== "confirmed"))
    return null;

  const metadata: { origin: ProjectBriefOrigin; confidence: ProjectBriefConfidence } = { origin, confidence };
  if (field === "genre" || field === "style" || field === "mood") {
    if (section !== "preference" || typeof raw.value !== "string") return null;
    const value = raw.value.trim().slice(0, 80);
    return value ? { field, section, value, ...metadata } : null;
  }
  if (field === "bpmRange") {
    if (
      section !== "hard" ||
      !Array.isArray(raw.value) ||
      raw.value.length !== 2 ||
      !raw.value.every((value) => typeof value === "number" && Number.isInteger(value) && value >= 40 && value <= 240)
    ) {
      return null;
    }
    const [low, high] = raw.value as [number, number];
    return low <= high ? { field, section, value: [low, high], ...metadata } : null;
  }
  if (field === "key") {
    return section === "hard" && isMusicalKey(raw.value) ? { field, section, value: raw.value, ...metadata } : null;
  }
  if (field === "length") {
    return section === "hard" &&
      typeof raw.value === "number" &&
      Number.isInteger(raw.value) &&
      raw.value >= 16 &&
      raw.value <= 4096 &&
      raw.value % 16 === 0
      ? { field, section, value: raw.value, ...metadata }
      : null;
  }
  if (field === "roles" || field === "preserve" || field === "prohibitedRoles") {
    const value = roles(raw.value);
    if (!value) return null;
    if (field === "roles") {
      return section === "hard" ? { field, section: "hard", value, ...metadata } : null;
    }
    if (field === "preserve") {
      return section === "preserve" ? { field, section: "preserve", value, ...metadata } : null;
    }
    return section === "prohibition" ? { field, section: "prohibition", value, ...metadata } : null;
  }
  if (field === "energy" || field === "density" || field === "complexity" || field === "variation") {
    return section === "preference" &&
      typeof raw.value === "number" &&
      Number.isFinite(raw.value) &&
      raw.value >= 0 &&
      raw.value <= 1
      ? { field, section, value: raw.value, ...metadata }
      : null;
  }
  return null;
}

/**
 * Defensively parse the project-embedded brief. It is user data: imported
 * files may be malformed, oversized or from a newer app. Unknown fields
 * (including raw prompt/audio/lyrics payloads) are dropped.
 */
export function sanitizeProjectProducerBrief(raw: unknown): ProjectProducerBriefV1 | undefined {
  if (!record(raw) || raw.version !== 1 || typeof raw.savedAt !== "string" || !Array.isArray(raw.facts))
    return undefined;
  if (raw.facts.length === 0 || raw.facts.length > 32) return undefined;
  const savedAtMs = Date.parse(raw.savedAt);
  if (!Number.isFinite(savedAtMs)) return undefined;

  const byField = new Map<string, ProjectProducerBriefFact>();
  for (const item of raw.facts) {
    const fact = sanitizeFact(item);
    if (fact) byField.set(fact.field, fact);
  }
  if (byField.size === 0) return undefined;
  return {
    version: 1,
    savedAt: new Date(savedAtMs).toISOString(),
    facts: [...byField.values()],
  };
}
