import { canonicalJson } from "../ai/evaluation";
import { hashString } from "../shared/rng";
import type { IntentSpec } from "./types";

export function canonicalizeIntent(intent: IntentSpec): string {
  return canonicalJson(intent);
}

export function intentHash(intent: IntentSpec): string {
  return hashString(canonicalizeIntent(intent)).toString(16).padStart(8, "0");
}
