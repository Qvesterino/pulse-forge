/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a semantics-faithful copy of the upstream DSP oracle (line endings are
 * normalized) so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena — Analyzer helpers
//
// Pure helpers shared by the Auto Cut (Pre EQ), Unmask (Reverb EQ),
// and Masking Meter analyzers. All routines operate on a pre-computed
// spectrum (in dB) and a frequency grid (in Hz).
// ═══════════════════════════════════════════════════════════

/** Return the mean dB value of `spectrum` in the frequency window [loHz, hiHz]. */
export function bandLevel(
  spectrum: Float32Array | number[],
  grid: Float32Array | number[],
  loHz: number,
  hiHz: number,
): number {
  const n = Math.min(spectrum.length, grid.length);
  if (n === 0) return -120;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const f = grid[i];
    if (f >= loHz && f <= hiHz) {
      sum += spectrum[i];
      count++;
    }
  }
  if (count === 0) {
    // Fall back to nearest sample (useful when the window is empty
    // because the grid is coarser than the requested range). Track the
    // distance and the level separately — comparing a distance against
    // a dB level would always return the first bin.
    let bestDist = Infinity;
    let best = -120;
    for (let i = 0; i < n; i++) {
      const dist = Math.min(Math.abs(grid[i] - loHz), Math.abs(grid[i] - hiHz));
      if (dist < bestDist) {
        bestDist = dist;
        best = spectrum[i];
      }
    }
    return best;
  }
  return sum / count;
}

/** Median dB value of `spectrum` (robust baseline against outliers). */
export function medianLevel(spectrum: Float32Array | number[]): number {
  const n = spectrum.length;
  if (n === 0) return -120;
  const copy = Array.from(spectrum);
  copy.sort((a, b) => a - b);
  return copy[Math.floor(n / 2)];
}

/** Soft-knee mapping from excess dB to [0, 1]. */
export function softKneeMap(excess: number, threshold: number, knee: number = 6): number {
  if (excess <= threshold) return 0;
  const t = (excess - threshold) / Math.max(1e-3, threshold + knee);
  return Math.max(0, Math.min(1, t));
}

/** Clamp a number to [0, 1]. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Clamp to [min, max]. */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
