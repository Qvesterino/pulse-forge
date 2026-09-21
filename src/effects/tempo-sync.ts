/**
 * Tempo-sync for Hz-rate LFO effects (FX-ADD-REWORK-ROADMAP C2): chorus,
 * flanger, phaser, tremolo and the freqShifter sweep gain an optional
 * `sync` param — OFF keeps the user's Hz knob, a musical division locks the
 * LFO to the transport and follows BPM changes live via the engine's
 * generic `rt.syncBpm` hook.
 *
 * Division is converted to Hz on the HOST side (worklets keep Hz as their
 * rate source of truth), so no processor changes and no worklet rebuild:
 * same pattern as multiTapDelay's host-side division→seconds conversion.
 * Cycle multipliers are per beat: 1/4 = 1 cycle/beat, triplets ×3/2.
 */

export interface LfoSyncDivision {
  value: number;
  label: string;
  /** LFO cycles per beat at this division. 0 = OFF (free-running Hz). */
  mult: number;
}

export const LFO_SYNC_DIVISIONS: readonly LfoSyncDivision[] = [
  { value: 0, label: "OFF", mult: 0 },
  { value: 1, label: "1/4", mult: 1 },
  { value: 2, label: "1/8", mult: 2 },
  { value: 3, label: "1/8T", mult: 3 },
  { value: 4, label: "1/16", mult: 4 },
  { value: 5, label: "1/16T", mult: 6 },
];

/** Sanitize an untrusted sync value (instance params, presets, automation). */
export function lfoSyncIndex(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(LFO_SYNC_DIVISIONS.length - 1, Math.round(raw)));
}

/**
 * The effective LFO rate in Hz: bpm × division cycles-per-beat when synced,
 * the free-running fallback Hz when OFF (or when the tempo is unknown).
 */
export function syncedLfoHz(bpm: number, sync: number, fallbackHz: number): number {
  const index = lfoSyncIndex(sync);
  const mult = LFO_SYNC_DIVISIONS[index]?.mult ?? 0;
  if (mult <= 0 || !Number.isFinite(bpm) || bpm <= 0) return fallbackHz;
  return (bpm / 60) * mult;
}

export interface LfoSyncController {
  /**
   * Feed a param change through the controller. Handles the rate param and
   * `sync`; returns false for anything else (caller falls through to its
   * normal param path). `when` may be null for an immediate write.
   */
  parameter(id: string, value: number, when: number | null): boolean;
  /** Engine hook: the effective tempo changed — re-apply the synced rate. */
  syncBpm(bpm: number, when: number): void;
}

/**
 * Shared host-side controller for one LFO device. Wrappers hand it a write
 * callback (safeApplyAudioParam or a native param setter) and route their
 * `setParameter`/`syncBpm` through it — the sync math lives here once.
 */
export function createLfoSyncController(opts: {
  /** The AudioParam id carrying the rate ("rate", or "lfoRate" on freqShifter). */
  rateParamId: string;
  defaultRate: number;
  initialRate?: unknown;
  initialSync?: unknown;
  initialBpm?: unknown;
  /** when === null means an immediate write (no scheduling). */
  write: (paramId: string, value: number, when: number | null) => void;
}): LfoSyncController {
  const initialRate = typeof opts.initialRate === "number" && Number.isFinite(opts.initialRate);
  let rate = initialRate ? (opts.initialRate as number) : opts.defaultRate;
  let sync = lfoSyncIndex(opts.initialSync);
  const initialBpm = typeof opts.initialBpm === "number" && Number.isFinite(opts.initialBpm) && opts.initialBpm > 0;
  let bpm = initialBpm ? (opts.initialBpm as number) : 0;

  const apply = (when: number | null) => opts.write(opts.rateParamId, syncedLfoHz(bpm, sync, rate), when);

  return {
    parameter(id, value, when) {
      if (id === opts.rateParamId) {
        if (typeof value === "number" && Number.isFinite(value)) rate = value;
        apply(when);
        return true;
      }
      if (id === "sync") {
        sync = lfoSyncIndex(value);
        apply(when);
        return true;
      }
      return false;
    },
    syncBpm(next, when) {
      if (!Number.isFinite(next) || next <= 0) return;
      bpm = next;
      apply(when);
    },
  };
}
