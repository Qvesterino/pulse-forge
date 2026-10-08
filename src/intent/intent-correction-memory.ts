import type { IntentInput } from "./types";
import type { IntentRole } from "./types";
import { GENRES } from "../ai/types";
import { PRODUCTION_PROFILES } from "../project-model/types";
import type { IntentCorrectionEvent, ProducerMemoryEvent } from "./producer-memory-core";

export interface IntentCorrectionSuggestion {
  field: IntentCorrectionEvent["field"];
  predictedValue: IntentCorrectionEvent["predictedValue"];
  confirmedValue: IntentCorrectionEvent["confirmedValue"];
  confirmationCount: number;
  conflicted: boolean;
  lastConfirmedAt: number;
}

function explicitInInput(field: IntentCorrectionEvent["field"], input: IntentInput): boolean {
  switch (field) {
    case "genre":
      return typeof input.genre === "string";
    case "style":
      return typeof input.style === "string";
    case "productionProfile":
      return typeof input.productionProfile === "string";
    case "mood":
      return typeof input.mood === "string";
    case "energy":
      return typeof input.energy === "number";
    case "density":
      return typeof input.density === "number";
    case "complexity":
      return typeof input.complexity === "number";
    case "variation":
      return typeof input.variation === "number";
    case "bpm":
      return Array.isArray(input.bpmRange);
    case "role":
      return Array.isArray(input.roles);
  }
}

/** Latest repeated correction per field, limited to the same coarse intent context. */
export function intentCorrectionSuggestions(
  events: readonly ProducerMemoryEvent[],
  contextKey: string,
  parsedInput: IntentInput,
): IntentCorrectionSuggestion[] {
  const corrections = events
    .filter(
      (event): event is IntentCorrectionEvent =>
        event.type === "intent-correction" &&
        event.contextKey === contextKey &&
        !explicitInInput(event.field, parsedInput),
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const byField = new Map<IntentCorrectionEvent["field"], IntentCorrectionEvent[]>();
  for (const event of corrections) {
    const history = byField.get(event.field) ?? [];
    history.push(event);
    byField.set(event.field, history);
  }

  return [...byField.entries()]
    .map(([field, history]) => {
      const latest = history[history.length - 1];
      if (!latest) return null;
      let confirmationCount = 0;
      let predictedValue = latest.predictedValue;
      for (let index = history.length - 1; index >= 0; index--) {
        const event = history[index];
        if (!event || event.confirmedValue !== latest.confirmedValue) break;
        confirmationCount++;
        predictedValue = event.predictedValue;
      }
      return {
        field,
        predictedValue,
        confirmedValue: latest.confirmedValue,
        confirmationCount,
        conflicted: new Set(history.map((event) => event.confirmedValue)).size > 1,
        lastConfirmedAt: latest.createdAt,
      } satisfies IntentCorrectionSuggestion;
    })
    .filter((suggestion): suggestion is IntentCorrectionSuggestion => suggestion !== null)
    .sort((a, b) => b.lastConfirmedAt - a.lastConfirmedAt);
}

/** Convert a confirmed memory item back into a one-field intent patch. */
export function patchForIntentCorrection(suggestion: IntentCorrectionSuggestion): IntentInput | null {
  const value = suggestion.confirmedValue;
  switch (suggestion.field) {
    case "genre":
      return typeof value === "string" && GENRES.includes(value as (typeof GENRES)[number])
        ? { genre: value as (typeof GENRES)[number] }
        : null;
    case "style":
      return typeof value === "string" ? { style: value } : null;
    case "productionProfile":
      return typeof value === "string" && PRODUCTION_PROFILES.includes(value as (typeof PRODUCTION_PROFILES)[number])
        ? { productionProfile: value as (typeof PRODUCTION_PROFILES)[number] }
        : null;
    case "mood":
      return typeof value === "string" ? { mood: value } : null;
    case "energy":
      return typeof value === "number" ? { energy: value } : null;
    case "density":
      return typeof value === "number" ? { density: value } : null;
    case "complexity":
      return typeof value === "number" ? { complexity: value } : null;
    case "variation":
      return typeof value === "number" ? { variation: value } : null;
    case "bpm":
      return typeof value === "number" ? { bpmRange: [value, value] } : null;
    case "role":
      return value === "drums" || value === "bass" || value === "chords" || value === "lead"
        ? { roles: [value satisfies IntentRole] }
        : null;
  }
}
