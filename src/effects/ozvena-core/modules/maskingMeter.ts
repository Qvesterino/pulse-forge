/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena — Masking Meter
//
// Visualises frequency regions where the wet signal "masks" the dry
// signal. Operates entirely from the spectrum analyzer's dry + wet
// taps: at snapshot time it computes per-bin dB difference (wet − dry)
// and returns a "masking vector" alongside the dB levels themselves.
//
// Phase 6 enhancements:
//   • `thresholdDb` is now applied in the analyze phase (not just
//     in the visual view). The returned `MaskingResult` includes
//     `problemBins` — bin indices where the mask exceeds the threshold.
//   • `source` field supports `"dryVsWet"` (current) and `"ipc"`
//     (placeholder for future VocalForge Inter-Plugin Communication;
//     see `getIpcPeers()`).
// ═══════════════════════════════════════════════════════════

import { createSpectrumAnalyzer, type SpectrumAnalyzer } from "../dsp/spectrumAnalyzer.js";
import { clamp } from "../dsp/math.js";

/** A peer plugin that can be cross-referenced for masking analysis. */
export interface MaskingIpcPeer {
  /** Stable plugin instance ID (host-allocated). */
  instanceId: number;
  /** Human-readable name (e.g. "FXEQ #2", "Bus Comp"). */
  name: string;
}

export interface MaskingParams {
  enabled: boolean;
  source: "dryVsWet" | "ipc";
  /** Ipc peer instance ID (only used when `source === "ipc"`). */
  ipcPeerId?: number;
}

export interface MaskingResult {
  /** Per-bin dB level of the dry signal (length = grid length). */
  dryDb: Float32Array;
  /** Per-bin dB level of the wet signal (length = grid length). */
  wetDb: Float32Array;
  /**
   * Per-bin masking amount in dB. Values > threshold indicate a
   * potential build-up. Negative values mean the dry dominates.
   */
  maskDb: Float32Array;
  /** Number of bins written. */
  count: number;
  /** Threshold (dB) used to flag problem bins. */
  thresholdDb: number;
  /** Bin indices where maskDb[i] > thresholdDb (problem zones). */
  problemBins: number[];
  /** Source of the dry reference ("dryVsWet" | "ipc"). */
  source: "dryVsWet" | "ipc";
  /** Mean mask value in dB (mean over all written bins). */
  meanMaskDb: number;
}

export interface MaskingMeter {
  prepare(sampleRate: number, channelCount: number): void;
  /** Feed audio: dry = the bypass signal, wet = the post-engine signal. */
  push(dry: Float32Array[], wet: Float32Array[], frameCount: number): void;
  setParams(p: MaskingParams): void;
  /** Gate the internal dry/wet analyzer taps (see PreEq.setAnalyzerEnabled). */
  setAnalyzerEnabled(on: boolean): void;
  /** Take a snapshot of dry vs wet and compute the per-bin mask. */
  snapshot(sampleRate: number, grid: Float32Array, thresholdDb?: number): MaskingResult;
  /**
   * List available IPC peers (plugins sharing the same VocalForge
   * engine instance). Phase 6 returns an empty array; full VocalForge
   * IPC integration will be added in a follow-up release.
   */
  getIpcPeers(): readonly MaskingIpcPeer[];
  reset(): void;
}

export function createMaskingMeter(): MaskingMeter {
  let analyzer: SpectrumAnalyzer = createSpectrumAnalyzer({ fftSize: 2048 });
  let analyzerEnabled = true;
  let params: MaskingParams = { enabled: false, source: "dryVsWet" };

  let dryBuf: Float32Array = new Float32Array(0);
  let wetBuf: Float32Array = new Float32Array(0);
  let maskBuf: Float32Array = new Float32Array(0);

  function ensureBufs(n: number): void {
    if (dryBuf.length < n) {
      dryBuf = new Float32Array(n);
      wetBuf = new Float32Array(n);
      maskBuf = new Float32Array(n);
    }
  }

  return {
    prepare(sr) {
      const srClamped = clamp(sr, 8000, 192000);
      analyzer = createSpectrumAnalyzer({ fftSize: 2048 });
      analyzer.setEnabled(analyzerEnabled);
      void srClamped;
    },

    push(dry, wet, frameCount) {
      analyzer.push("dry", dry, frameCount);
      analyzer.push("wet", wet, frameCount);
    },

    setParams(p) { params = { ...p }; },

    setAnalyzerEnabled(on) {
      analyzerEnabled = on;
      analyzer.setEnabled(on);
    },

    snapshot(sampleRate, grid, thresholdDb = 3) {
      ensureBufs(grid.length);
      const dryN = analyzer.snapshot("dry", dryBuf, grid, sampleRate);
      const wetN = analyzer.snapshot("wet", wetBuf, grid, sampleRate);
      const n = Math.min(dryN, wetN);
      let sum = 0;
      const problemBins: number[] = [];
      for (let i = 0; i < n; i++) {
        const m = wetBuf[i] - dryBuf[i];
        maskBuf[i] = m;
        sum += m;
        if (m > thresholdDb) problemBins.push(i);
      }
      const meanMaskDb = n > 0 ? sum / n : 0;
      return {
        dryDb: dryBuf, wetDb: wetBuf, maskDb: maskBuf,
        count: n, thresholdDb, problemBins,
        source: params.source,
        meanMaskDb,
      };
    },

    getIpcPeers() {
      // Phase 6 placeholder. Real VocalForge IPC integration will
      // populate this list from the host's plugin graph (similar to
      // iZotope Neoverb's Inter-Plugin Communication). The list is
      // currently empty so the UI can still render the "No IPC peers
      // detected" affordance without a runtime error.
      return [] as readonly MaskingIpcPeer[];
    },

    reset() { analyzer.reset(); },
  };
}
