/**
 * AUDITION-FIRST CANDIDATE BUDGET (Wave A).
 *
 * WHY THIS EXISTS
 * ---------------
 * The taste loop has exactly one fuel: the user choosing between alternatives.
 * If a run produces a single candidate there is nothing to audition, nothing to
 * vote on, and the preference model never learns. The studio therefore asks for
 * a MULTI-candidate bank by default — and this module owns that default so it
 * is one documented decision instead of three scattered literals.
 *
 * THE LEAN PATH IS DELIBERATE, NOT ACCIDENTAL
 * -------------------------------------------
 * A single-candidate run is a real product loss (no audition, no signal), so it
 * is reserved for genuinely constrained devices, and the two pressure signals
 * are treated DIFFERENTLY because they mean different things:
 *
 *   - `saveData` (metered/slow connection) → keep the 3 deterministic
 *     candidates, but drop the symbolic-prior candidates: those try to fetch
 *     and run the ONNX model, and a metered connection must not pay for that.
 *     Auditioning stays intact; only the model traffic goes away.
 *   - `deviceMemory <= 2` (very low memory) → lean: one candidate, no symbolic
 *     candidates. Three rendered candidates plus a model is not a fair ask of
 *     such a device; the deterministic single pick is what it can actually run.
 *
 * `deviceMemory <= 4` is NOT used here even though the semantic client opts out
 * at that threshold: refusing a ~118 MB model download is cheap, refusing the
 * candidate bank would remove the product's core interaction on a device that
 * still runs the audio engine fine.
 */

export interface CandidateBudget {
  candidateCount: number;
  symbolicCandidates: number;
  /** True when the lean single-candidate path was chosen. */
  lean: boolean;
}

/** The studio default: a real bank to audition, plus model candidates. */
export const AUDITION_CANDIDATE_COUNT = 3;
export const AUDITION_SYMBOLIC_CANDIDATES = 2;
/** The constrained-device path: deterministic single pick, no model traffic. */
export const LEAN_CANDIDATE_COUNT = 1;
export const LEAN_SYMBOLIC_CANDIDATES = 0;
/** Memory ceiling (GB, as `navigator.deviceMemory` reports it) for the lean path. */
export const LEAN_DEVICE_MEMORY_GB = 2;

export interface CandidateBudgetEnv {
  /** `navigator.deviceMemory` when the browser reports it. */
  deviceMemory?: number | undefined;
  /** `navigator.connection.saveData`. */
  saveData?: boolean | undefined;
}

/** Read the pressure signals defensively — none of them is guaranteed. */
export function candidateBudgetEnv(): CandidateBudgetEnv {
  const nav = navigator as { connection?: { saveData?: boolean }; deviceMemory?: number };
  return {
    deviceMemory: typeof nav.deviceMemory === "number" && nav.deviceMemory > 0 ? nav.deviceMemory : undefined,
    saveData: nav.connection?.saveData === true ? true : undefined,
  };
}

/**
 * Decide the candidate budget. Pure — the caller passes the environment so the
 * decision is testable without touching globals.
 */
export function intentCandidateBudget(env: CandidateBudgetEnv = candidateBudgetEnv()): CandidateBudget {
  // A zero/negative reading is not a real pressure signal (the env probe
  // already filters it) — treating nonsense as "very low memory" would send a
  // working device down the lean path for no reason.
  if (env.deviceMemory !== undefined && env.deviceMemory > 0 && env.deviceMemory <= LEAN_DEVICE_MEMORY_GB) {
    return { candidateCount: LEAN_CANDIDATE_COUNT, symbolicCandidates: LEAN_SYMBOLIC_CANDIDATES, lean: true };
  }
  if (env.saveData === true) {
    return { candidateCount: AUDITION_CANDIDATE_COUNT, symbolicCandidates: LEAN_SYMBOLIC_CANDIDATES, lean: false };
  }
  return { candidateCount: AUDITION_CANDIDATE_COUNT, symbolicCandidates: AUDITION_SYMBOLIC_CANDIDATES, lean: false };
}
