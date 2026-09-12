/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ultina. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden vectors
 * (tests/ultina-vectors.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ultina.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ultina — Cross-Instance Spectral Registry
//
// Enables multiple Ultina instances to share their spectral content
// so the Unmask module can see masking from ALL other instances
// on different tracks. This is Neutron's most powerful ecosystem
// feature: inter-plugin spectral communication.
//
// Architecture:
//   - SpectralRegistry (singleton): Global bus for spectral profiles
//   - BandAnalyzer: Lightweight 32-band energy analyzer (matching
//     Unmask's band frequencies)
//   - Each UltinaProcessor publishes its spectral profile each block
//   - The Unmask module queries the aggregate masker from all others
//
// REALTIME SAFETY:
//   - register/unregister happen only during prepare/dispose (not in process)
//   - publish/getAggregateMasker perform only float copies and iterations
//   - No allocations in the audio path
// ═══════════════════════════════════════════════════════════

import {
  createBiquad,
  setBandPass,
  resetBiquad,
  type BiquadState,
} from "./primitives.js";

// ── Shared band frequencies (must match Unmask's 32 bands) ──

/** Number of spectral analysis bands (matches Unmask module). */
export const SPECTRAL_BANDS = 32;

/**
 * 32 log-spaced band center frequencies from 40 Hz to 16000 Hz.
 * Must match the UnmaskModuleProcessor's BAND_FREQS exactly.
 */
export const SPECTRAL_BAND_FREQS: number[] = (() => {
  const logMin = Math.log(40);
  const logMax = Math.log(16000);
  const freqs: number[] = [];
  for (let i = 0; i < SPECTRAL_BANDS; i++) {
    const t = i / (SPECTRAL_BANDS - 1);
    freqs.push(Math.round(Math.exp(logMin + t * (logMax - logMin))));
  }
  return freqs;
})();

// ── Types ───────────────────────────────────────────────────

/**
 * Spectral profile published by each Ultina instance.
 * 32 bands of energy in dB (-200 = silence, 0 dBFS = 0 dB).
 */
export interface SpectralEntry {
  /** Unique instance identifier. */
  instanceId: string;
  /** Human-readable name (track name or instance label). */
  name: string;
  /** Per-band energy in dB. 32 bands. */
  bandLevelsDb: Float32Array;
  /** Block counter — incremented each publish. */
  blockCounter: number;
  /** Whether this instance is actively processing audio. */
  active: boolean;
  /**
   * Staleness tracking per consumer: the last blockCounter this
   * consumer observed, and how many consecutive queries it has seen
   * no progress. A publisher that stops processing (muted/stopped
   * track) freezes at its last profile and would otherwise mask the
   * ecosystem forever.
   */
  consumerStaleness: Map<string, { counter: number; stale: number }>;
}

/** Consecutive no-progress queries before an entry is considered stale.
 * Grace covers publishers on slower block cadences (e.g. analysis
 * every 4th block) at up to 8× the consumer's query rate. */
const STALE_GRACE = 8;

// ── BandAnalyzer ────────────────────────────────────────────

/**
 * Lightweight 32-band spectral analyzer using bandpass biquad filters.
 *
 * Computes per-band energy (peak envelope follower) from mono audio.
 * The filters run at the FULL sample rate — feeding a filter designed
 * for `sampleRate` with every Nth sample silently rescales its
 * frequency response by N and aliases, so the old stride-4 decimation
 * reported frequency-warped band levels. Callers that need to bound
 * CPU should invoke process() every Nth block (temporal decimation),
 * which keeps the frequency accuracy intact.
 */
export class BandAnalyzer {
  private filters: BiquadState[] = [];
  private envelopes: Float32Array = new Float32Array(SPECTRAL_BANDS);
  private bandLevelsDb: Float32Array = new Float32Array(SPECTRAL_BANDS);
  private envCoef = 0.01;

  /** Analysis Q factor (matches Unmask). */
  private static readonly Q = 3.0;

  prepare(sampleRate: number, _maxBlockSize: number): void {
    this.envCoef = 1 - Math.exp(-1 / ((50 / 1000) * sampleRate));

    // Initialize envelopes and dB levels to silence
    this.envelopes.fill(0);
    this.bandLevelsDb.fill(-200);

    this.filters = [];
    for (let i = 0; i < SPECTRAL_BANDS; i++) {
      const freq = Math.min(SPECTRAL_BAND_FREQS[i], sampleRate / 2 - 1);
      const bq = createBiquad(1);
      setBandPass(bq.coeffs, freq, BandAnalyzer.Q, sampleRate);
      this.filters.push(bq);
    }
  }

  reset(): void {
    this.envelopes.fill(0);
    this.bandLevelsDb.fill(-200);
    for (const bq of this.filters) resetBiquad(bq);
  }

  /**
   * Analyze a block of mono audio and update per-band envelopes.
   * @param input Mono audio buffer (L+R averaged recommended)
   * @param frameCount Number of valid frames
   */
  process(input: Float32Array, frameCount: number): void {
    const n = Math.min(input.length, frameCount);

    for (let b = 0; b < SPECTRAL_BANDS; b++) {
      const bq = this.filters[b];
      const c = bq.coeffs;
      let z1 = bq.z1[0];
      let z2 = bq.z2[0];
      let env = this.envelopes[b];

      for (let i = 0; i < n; i++) {
        const x = input[i];
        const y = c.b0 * x + z1;
        z1 = c.b1 * x - c.a1 * y + z2;
        z2 = c.b2 * x - c.a2 * y;
        const abs = y < 0 ? -y : y;
        env += this.envCoef * (abs - env);
      }

      bq.z1[0] = z1;
      bq.z2[0] = z2;
      this.envelopes[b] = env;
      // Non-finite state guard (see processBiquadChannel): a poisoned band
      // must not publish −200 dB (or NaN) forever via the registry.
      if (!Number.isFinite(z1) || !Number.isFinite(z2) || !Number.isFinite(env)) {
        bq.z1[0] = 0;
        bq.z2[0] = 0;
        this.envelopes[b] = 0;
      }
    }

    // Update dB levels
    for (let b = 0; b < SPECTRAL_BANDS; b++) {
      this.bandLevelsDb[b] = this.envelopes[b] > 1e-10
        ? 20 * Math.log10(this.envelopes[b])
        : -200;
    }
  }

  /**
   * Get the current per-band energy in dB.
   * Returns a reference to the internal array — do not modify.
   */
  getBandLevelsDb(): Float32Array {
    return this.bandLevelsDb;
  }
}

// ── Spectral Registry ───────────────────────────────────────

/**
 * Global singleton registry for cross-instance spectral sharing.
 *
 * Each UltinaProcessor registers on prepare, publishes its spectral
 * profile each block, and can query the aggregate masker spectrum
 * from all other instances.
 *
 * Usage:
 *   const reg = SpectralRegistry.getInstance();
 *   reg.register("instance-1", "Vocal");
 *   reg.publish("instance-1", bandLevelsDb);
 *   reg.getAggregateMasker("instance-1", outBuf);
 *   reg.unregister("instance-1");
 */
export class SpectralRegistry {
  private static instance: SpectralRegistry | null = null;

  /** Map of instanceId → SpectralEntry. */
  private entries: Map<string, SpectralEntry> = new Map();

  /** Auto-incrementing instance counter. */
  private instanceCounter = 0;

  private constructor() {}

  /** Get the singleton instance. */
  static getInstance(): SpectralRegistry {
    if (!SpectralRegistry.instance) {
      SpectralRegistry.instance = new SpectralRegistry();
    }
    return SpectralRegistry.instance;
  }

  /**
   * Generate a unique instance ID.
   * Called during processor construction.
   */
  generateId(): string {
    this.instanceCounter++;
    return `ultina-${this.instanceCounter}`;
  }

  /**
   * Register a new instance in the registry.
   * Called during prepare(), NOT from the audio thread.
   */
  register(instanceId: string, name: string = "Ultina"): void {
    this.entries.set(instanceId, {
      instanceId,
      name,
      bandLevelsDb: new Float32Array(SPECTRAL_BANDS).fill(-200),
      blockCounter: 0,
      active: true,
      consumerStaleness: new Map(),
    });
  }

  /**
   * Update the display name for an instance.
   * Called from the control thread.
   */
  setName(instanceId: string, name: string): void {
    const entry = this.entries.get(instanceId);
    if (entry) entry.name = name;
  }

  /**
   * Unregister an instance.
   * Called during dispose/reset.
   */
  unregister(instanceId: string): void {
    this.entries.delete(instanceId);
    // The unregistering instance was also a CONSUMER: drop its staleness
    // records from every surviving entry, or each live entry's
    // consumerStaleness map accumulates one dead id per churned instance for
    // the page's lifetime.
    for (const entry of this.entries.values()) {
      entry.consumerStaleness.delete(instanceId);
    }
  }

  /**
   * Publish spectral data for an instance.
   * AUDIO-THREAD SAFE: Only performs float copies, no allocation.
   *
   * @param instanceId The publishing instance
   * @param bandLevelsDb 32-band energy in dB (reference is copied)
   */
  publish(instanceId: string, bandLevelsDb: Float32Array): void {
    const entry = this.entries.get(instanceId);
    if (entry) {
      // Copy data into the entry's pre-allocated array. Fast path avoids
      // subarray() — it allocates a TypedArray view per call, once per
      // publish, on the audio thread. (set() would throw on a longer source,
      // so the truncating view remains as the defensive slow path.)
      if (bandLevelsDb.length <= SPECTRAL_BANDS) {
        entry.bandLevelsDb.set(bandLevelsDb);
      } else {
        entry.bandLevelsDb.set(bandLevelsDb.subarray(0, SPECTRAL_BANDS));
      }
      entry.blockCounter++;
      entry.active = true;
    }
  }

  /**
   * Compute the aggregate masker spectrum from all OTHER instances.
   *
   * Uses "max per band" strategy: for each band, the loudest other
   * instance determines the masking level. This represents the worst-
   * case masking from the entire ecosystem.
   *
   * AUDIO-THREAD SAFE: Iterates the map, writes to pre-allocated buffer.
   *
   * @param instanceId The querying instance (excluded from results)
   * @param out Pre-allocated Float32Array(32) to fill with aggregate dB values
   * @returns true if at least one other instance contributed data
   */
  getAggregateMasker(instanceId: string, out: Float32Array): boolean {
    // Initialize to silence
    out.fill(-200);

    let hasData = false;

    for (const [id, entry] of this.entries) {
      if (id === instanceId) continue;
      if (!entry.active) continue;

      // Staleness: skip publishers whose block counter has made no
      // progress for STALE_GRACE consecutive queries by this consumer.
      // (Their last profile is frozen — e.g. a muted track — and must
      // not keep masking the ecosystem forever.)
      let seen = entry.consumerStaleness.get(instanceId);
      if (!seen) {
        seen = { counter: -1, stale: 0 };
        entry.consumerStaleness.set(instanceId, seen);
      }
      if (entry.blockCounter === seen.counter) {
        seen.stale++;
        if (seen.stale > STALE_GRACE) continue;
      } else {
        seen.counter = entry.blockCounter;
        seen.stale = 0;
      }

      hasData = true;
      const levels = entry.bandLevelsDb;
      for (let b = 0; b < SPECTRAL_BANDS; b++) {
        if (levels[b] > out[b]) {
          out[b] = levels[b];
        }
      }
    }

    return hasData;
  }

  /**
   * Get a snapshot of all registered instances (for UI display).
   * Called from the control thread only.
   */
  listInstances(): SpectralEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Get the number of registered instances.
   */
  getInstanceCount(): number {
    return this.entries.size;
  }

  /**
   * Clear all instances (for testing).
   */
  clear(): void {
    this.entries.clear();
  }
}
