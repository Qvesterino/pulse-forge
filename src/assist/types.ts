import type { TimeSignature } from "../project-model/types";

export type AssistOperation = "vary" | "build" | "replace" | "fill";
export type AssistTarget = "hats" | "kicks" | "snares";

/** Normalized, deterministic request shared by Assist UI preview and Apply. */
export interface AssistRequest {
  operation: AssistOperation;
  seed: string;
  amount: number;
  bars: number;
  target: AssistTarget;
  style: string;
  /**
   * The document's METER (ADR 0057 Stage 2g) — optional, and absent means
   * 4/4. The assist layer counts bars, fills the last bar and re-voices the
   * style grooves in the metre it is given, so a 6/8 document gets 6/8 bars.
   */
  timeSignature?: TimeSignature;
}

/** Bump when the deterministic Assist algorithm changes its output contract. */
export const ASSIST_ENGINE_ID = "pulse-forge.local-assist";
export const ASSIST_ENGINE_VERSION = "assist-1";

export type AssistInput = Partial<AssistRequest> & {
  operation: AssistOperation;
};
