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
}

/** Bump when the deterministic Assist algorithm changes its output contract. */
export const ASSIST_ENGINE_ID = "pulse-forge.local-assist";
export const ASSIST_ENGINE_VERSION = "assist-1";

export type AssistInput = Partial<AssistRequest> & {
  operation: AssistOperation;
};
