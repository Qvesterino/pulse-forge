export const WF_BASE_DELAY_SECONDS: number;
export const WF_MIN_OFFSET_SAMPLES: number;
export const WF_DRIFT_MAX_CENTS: number;
export const WF_DRIFT_RATE_HZ: number;

/**
 * Modulation amplitude in seconds needed for a given pitch deviation in cents
 * at a given rate.
 *
 * There is deliberately no base-delay factor. A continuously modulated delay
 * line shifts pitch by dD/dt, not by dD/dt/D; the latter is the granular
 * resampling law and made the control 250x too weak at a 4 ms base delay.
 */
export function wfCentsToAmplitudeSeconds(cents: number, rateHz: number): number;
/** The cents actually achievable once the swing budget applies. */
export function wfAchievableCents(cents: number, rateHz: number, maxAmplitudeSeconds: number): number;
/** Swing budget in seconds for a sample rate (ring delay minus the read floor). */
export function wfSwingBudgetSeconds(sampleRate: number): number;

export interface WowFlutterSwingPlan {
  budget: number;
  scale: number;
  wowAmp: number;
  flutterAmp: number;
  driftAmp: number;
  wowCents: number;
  flutterCents: number;
}

/** The processor's own swing allocation, plus the cents each term delivers. */
export function wfSwingPlan(params?: {
  wowDepth?: number;
  wowRate?: number;
  flutterDepth?: number;
  flutterRate?: number;
  sampleRate?: number;
}): WowFlutterSwingPlan;
