/* eslint-disable */
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
// Ultina — Feature Extractor (v1)
//
// Extracts deterministic signal features from audio data for
// the Mix Assistant. Extends VoiceStrip's feature extractor with:
//   - Octave-band spectral profile (10 bands, 31 Hz – 16 kHz)
//   - Stereo width (M/S ratio) and correlation
//   - Transient density (onset detection via spectral flux)
//   - LUFS integrated estimate (K-weighted)
//   - Sub-bass / low-mid / mid / high-mid / high band ratios
//
// All functions are deterministic — no randomness.
// ═══════════════════════════════════════════════════════════

import type { UltinaFeatures, SpectralBand } from "./assistant.js";
import { applyHanningWindow, computeMagnitudeSpectrum, bandEnergy } from "../dsp/fft.js";

// ── Constants ────────────────────────────────────────────────

const FRAME_SIZE = 2048;
const HOP_SIZE = 1024;
const MIN_TOTAL_DURATION = 1.0; // seconds
const MIN_ANALYSIS_DURATION = 2.0; // seconds
const NOISE_FLOOR_PERCENTILE = 0.10;
const UNVOICED_THRESHOLD_RATIO = 0.08;

// Onset detection (spectral flux): flux is computed on unit-L2-normalized
// spectra, so these thresholds are level-independent.
const ONSET_HISTORY = 8;              // frames of flux history for the adaptive threshold
const MIN_ONSET_FLUX = 0.05;          // floor below the adaptive mean+2σ threshold
const ONSET_REFRACTORY_FRAMES = 3;    // min frames between counted onsets (~35–75 ms)

// Frequency band boundaries (Hz)
const RUMBLE_CUTOFF_HZ = 80;
const SIBILANCE_LOW_HZ = 4000;
const SIBILANCE_HIGH_HZ = 10000;
const HARSHNESS_LOW_HZ = 3000;
const HARSHNESS_HIGH_HZ = 5000;
const PRESENCE_LOW_HZ = 2000;
const PRESENCE_HIGH_HZ = 5000;
const AIR_LOW_HZ = 8000;

// Octave-band center frequencies (standard 1/1 octave)
const OCTAVE_CENTER_FREQS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// K-weighting filter coefficients (simplified pre-filter for LUFS)
// Stage 1: high-shelf at ~38 Hz, +12 dB
// Stage 2: high-pass at ~1500 Hz, +1.5 dB shelf
// For simplicity we use a 2-pole high-pass approximation
function kWeightedRms(samples: Float32Array, frameCount: number): number {
  // Simplified K-weighting: first-order high-pass at 100 Hz to remove LF,
  // then high-shelf boost above 1 kHz. This is an approximation — true
  // ITU-R BS.1770 uses specific biquad coefficients.
  let stateX1 = 0, stateY1 = 0;
  const a0 = 0.999; // very gentle high-pass
  const sumSq: number[] = [];
  // Process in 400ms blocks for momentary loudness, then integrate
  const blockSize = Math.max(1, Math.floor(frameCount * 0.4));
  for (let block = 0; block < frameCount; block += blockSize) {
    const end = Math.min(block + blockSize, frameCount);
    let sq = 0;
    let count = 0;
    for (let i = block; i < end; i++) {
      // Simple high-pass
      const x = samples[i];
      const y = a0 * (stateY1 + x - stateX1);
      stateX1 = x;
      stateY1 = y;
      sq += y * y;
      count++;
    }
    if (count > 0) {
      const blockRms = Math.sqrt(sq / count);
      // Gate below -70 LUFS (absolute silence threshold)
      const blockLufs = blockRms > 0 ? -0.691 + 10 * Math.log10(blockRms * blockRms + 1e-20) : -70;
      if (blockLufs > -70) {
        sumSq.push(sq / count);
      }
    }
  }
  if (sumSq.length === 0) return -70;
  const meanSq = sumSq.reduce((a, b) => a + b, 0) / sumSq.length;
  return meanSq > 0 ? -0.691 + 10 * Math.log10(meanSq + 1e-20) : -70;
}

// ── Pitch detection (autocorrelation) ────────────────────────

function detectPitch(data: Float32Array, sampleRate: number): number {
  const minPeriod = Math.floor(sampleRate / 500); // 500 Hz max
  const maxPeriod = Math.floor(sampleRate / 60); // 60 Hz min
  const length = Math.min(data.length, sampleRate * 2); // max 2 seconds
  if (length < minPeriod * 2) return -1;

  // Remove DC first — a constant offset autocorrelates perfectly at
  // every lag and would report ~500 Hz for a DC input.
  let mean = 0;
  for (let i = 0; i < length; i++) mean += data[i];
  mean /= length;
  const x = new Float64Array(length);
  for (let i = 0; i < length; i++) x[i] = data[i] - mean;

  let bestPeriod = 0;
  let bestCorrelation = 0;

  for (let period = minPeriod; period <= maxPeriod && period < length; period++) {
    let correlation = 0;
    let norm1 = 0;
    let norm2 = 0;
    const samples = Math.min(length - period, sampleRate);

    for (let i = 0; i < samples; i++) {
      const a = x[i];
      const b = x[i + period];
      correlation += a * b;
      norm1 += a * a;
      norm2 += b * b;
    }

    const denom = Math.sqrt(norm1 * norm2);
    if (denom > 1e-12) {
      // Symmetric normalization keeps the coefficient in [-1, 1]
      // (dividing by only the first window's energy inflated it and
      // biased toward short lags).
      const corr = correlation / denom;
      // A shorter period must be meaningfully better to replace a
      // longer one — otherwise the half period (one octave up) wins
      // ties. The scan is ascending, so later = longer.
      if (corr > bestCorrelation + 0.02) {
        bestCorrelation = corr;
        bestPeriod = period;
      }
    }
  }

  return bestPeriod > 0 && bestCorrelation > 0.5
    ? sampleRate / bestPeriod
    : -1;
}

// ── Stereo analysis ──────────────────────────────────────────

function computeStereoWidth(
  channels: Float32Array[],
  frameCount: number,
): { widthDb: number; correlation: number } {
  if (channels.length < 2) {
    return { widthDb: 0, correlation: 1 };
  }

  const left = channels[0];
  const right = channels[1];
  let midEnergy = 0;
  let sideEnergy = 0;
  let sumLR = 0;
  let sumL2 = 0;
  let sumR2 = 0;

  for (let i = 0; i < frameCount; i++) {
    const l = left[i];
    const r = right[i];
    const mid = (l + r) * 0.5;
    const side = (l - r) * 0.5;
    midEnergy += mid * mid;
    sideEnergy += side * side;
    sumLR += l * r;
    sumL2 += l * l;
    sumR2 += r * r;
  }

  midEnergy /= frameCount;
  sideEnergy /= frameCount;

  const widthDb = midEnergy > 0
    ? 10 * Math.log10((sideEnergy + 1e-20) / (midEnergy + 1e-20))
    : 0;

  const denom = Math.sqrt(sumL2 * sumR2);
  const correlation = denom > 0 ? sumLR / denom : 1;

  return { widthDb, correlation: Math.max(-1, Math.min(1, correlation)) };
}

// ── Main extraction ──────────────────────────────────────────

export function extractFeatures(
  channels: Float32Array[],
  sampleRate: number,
): UltinaFeatures {
  // ── Empty input ──
  if (channels.length === 0 || channels[0].length === 0) {
    return emptyFeatures("No audio data provided");
  }

  const frameCount = channels[0].length;
  const duration = frameCount / sampleRate;
  const numChannels = channels.length;

  // ── Ragged channel lengths ──
  // Reading past a shorter channel's end yields undefined → every
  // downstream sum becomes NaN and silently poisons the classifier,
  // proposals, and hashes. Reject instead.
  for (let c = 1; c < numChannels; c++) {
    if (channels[c].length !== frameCount) {
      return emptyFeatures(
        `Channel length mismatch: channel 0 has ${frameCount} frames, channel ${c} has ${channels[c].length}`,
      );
    }
  }

  // ── Duration check ──
  if (duration < MIN_TOTAL_DURATION) {
    return emptyFeatures(
      `Insufficient duration: ${duration.toFixed(1)}s (minimum ${MIN_TOTAL_DURATION}s)`,
    );
  }

  // ── Check for all-zero input ──
  let hasNonZero = false;
  for (let c = 0; c < numChannels && !hasNonZero; c++) {
    for (let i = 0; i < frameCount; i++) {
      if (channels[c][i] !== 0) {
        hasNonZero = true;
        break;
      }
    }
  }

  if (!hasNonZero) {
    return emptyFeatures("All-zero input: no audio signal detected");
  }

  // ── Mix to mono for analysis ──
  const mono = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let c = 0; c < numChannels; c++) {
      sum += channels[c][i];
    }
    mono[i] = sum / numChannels;
  }

  // ── Peak, RMS, clipping ──
  let peakLevel = 0;
  let sumOfSquares = 0;
  let clipCount = 0;

  for (let i = 0; i < frameCount; i++) {
    const abs = Math.abs(mono[i]);
    if (abs > peakLevel) peakLevel = abs;
    if (abs >= 1.0) clipCount++;
    sumOfSquares += mono[i] * mono[i];
  }

  const rmsLevel = Math.sqrt(sumOfSquares / frameCount);
  const shortTermLoudness = rmsLevel > 0
    ? 20 * Math.log10(rmsLevel) - 0.691
    : -70;
  const crestFactorDb = rmsLevel > 0
    ? 20 * Math.log10(peakLevel / rmsLevel)
    : 0;

  // ── LUFS integrated (K-weighted) ──
  const lufsIntegrated = kWeightedRms(mono, frameCount);

  // ── Stereo analysis ──
  const stereo = computeStereoWidth(channels, frameCount);

  // ── Short-time frame analysis ──
  const numFrames = Math.max(1, Math.floor((frameCount - FRAME_SIZE) / HOP_SIZE) + 1);
  const frameRmsValues: number[] = [];
  let totalBandEnergy = 0;
  let totalLowBandEnergy = 0;
  let totalSubBassEnergy = 0;
  let totalLowMidEnergy = 0;
  let totalMidEnergy = 0;
  let totalHighMidEnergy = 0;
  let totalHighEnergy = 0;
  let totalSibilanceEnergy = 0;
  let totalHarshnessEnergy = 0;
  let totalPresenceEnergy = 0;
  let totalAirEnergy = 0;
  let voicedFrames = 0;
  let totalSpectralTilt = 0;
  let spectralTiltCount = 0;

  // Spectral flux for transient detection
  let prevMagnitudes: Float64Array | null = null;
  let totalSpectralFlux = 0;
  let fluxCount = 0;
  let onsetCount = 0;

  // Onset detection state: adaptive threshold over a short flux
  // history + a refractory gap so multi-frame onsets count once.
  const onsetFluxHistory = new Float64Array(ONSET_HISTORY);
  let onsetHistoryPos = 0;
  let onsetFramesSinceLast = ONSET_REFRACTORY_FRAMES;

  // Accumulate octave-band energies
  const octaveEnergies = new Array(OCTAVE_CENTER_FREQS.length).fill(0);

  for (let f = 0; f < numFrames; f++) {
    const start = f * HOP_SIZE;
    const length = Math.min(FRAME_SIZE, frameCount - start);

    if (length < FRAME_SIZE) break;

    // Frame RMS
    let frameRms = 0;
    for (let i = 0; i < length; i++) {
      frameRms += mono[start + i] * mono[start + i];
    }
    frameRms = Math.sqrt(frameRms / length);
    frameRmsValues.push(frameRms);

    // Spectral analysis
    const windowed = mono.slice(start, start + length);
    applyHanningWindow(windowed);
    const magnitudes = computeMagnitudeSpectrum(windowed);

    const totalE = bandEnergy(magnitudes, sampleRate, 20, sampleRate / 2);
    const lowE = bandEnergy(magnitudes, sampleRate, 20, RUMBLE_CUTOFF_HZ);
    const subBassE = bandEnergy(magnitudes, sampleRate, 20, 60);
    const lowMidE = bandEnergy(magnitudes, sampleRate, 60, 250);
    const midE = bandEnergy(magnitudes, sampleRate, 250, 2000);
    const highMidE = bandEnergy(magnitudes, sampleRate, 2000, 6000);
    const highE = bandEnergy(magnitudes, sampleRate, 6000, sampleRate / 2);
    const sibE = bandEnergy(magnitudes, sampleRate, SIBILANCE_LOW_HZ, SIBILANCE_HIGH_HZ);
    const harshE = bandEnergy(magnitudes, sampleRate, HARSHNESS_LOW_HZ, HARSHNESS_HIGH_HZ);
    const presE = bandEnergy(magnitudes, sampleRate, PRESENCE_LOW_HZ, PRESENCE_HIGH_HZ);
    const airE = bandEnergy(magnitudes, sampleRate, AIR_LOW_HZ, sampleRate / 2);

    totalBandEnergy += totalE;
    totalLowBandEnergy += lowE;
    totalSubBassEnergy += subBassE;
    totalLowMidEnergy += lowMidE;
    totalMidEnergy += midE;
    totalHighMidEnergy += highMidE;
    totalHighEnergy += highE;
    totalSibilanceEnergy += sibE;
    totalHarshnessEnergy += harshE;
    totalPresenceEnergy += presE;
    totalAirEnergy += airE;

    // Octave bands
    for (let o = 0; o < OCTAVE_CENTER_FREQS.length; o++) {
      const center = OCTAVE_CENTER_FREQS[o];
      octaveEnergies[o] += bandEnergy(
        magnitudes, sampleRate,
        Math.max(20, center / Math.SQRT2),
        center * Math.SQRT2,
      );
    }

    // Voiced/unvoiced heuristic
    if (frameRms > UNVOICED_THRESHOLD_RATIO * peakLevel) {
      voicedFrames++;
    }

    // Spectral tilt
    if (totalE > 0) {
      const tilt = Math.log10((airE + 1e-20) / (lowE + 1e-20));
      totalSpectralTilt += tilt;
      spectralTiltCount++;
    }

    // Spectral flux (transient detection)
    if (prevMagnitudes) {
      // Normalize both spectra to unit L2 norm first: raw FFT
      // magnitudes scale with amplitude (~amplitude·N/4), so a fixed
      // absolute threshold crossed on ANY audible change at normal
      // levels (and on nothing at quiet levels).
      let frameEnergy = 0;
      const half0 = Math.min(magnitudes.length, prevMagnitudes.length);
      for (let b = 0; b < half0; b++) frameEnergy += magnitudes[b] * magnitudes[b];
      const frameNorm = Math.sqrt(frameEnergy);
      if (frameNorm > 1e-10) {
        let flux = 0;
        for (let b = 0; b < half0; b++) {
          const m = magnitudes[b] / frameNorm;
          const diff = m - prevMagnitudes[b];
          if (diff > 0) flux += diff * diff; // only positive differences (onsets)
        }
        flux = Math.sqrt(flux / half0);
        totalSpectralFlux += flux;
        fluxCount++;

        // Adaptive threshold: mean + 2σ of the recent flux history
        // (plus a small floor), with a refractory gap so one physical
        // onset spanning several frames counts once.
        let histSum = 0;
        for (let fh = 0; fh < ONSET_HISTORY; fh++) histSum += onsetFluxHistory[fh];
        const histMean = histSum / ONSET_HISTORY;
        let histVar = 0;
        for (let fh = 0; fh < ONSET_HISTORY; fh++) {
          const d = onsetFluxHistory[fh] - histMean;
          histVar += d * d;
        }
        const histStd = Math.sqrt(histVar / ONSET_HISTORY);
        const threshold = Math.max(MIN_ONSET_FLUX, histMean + 2 * histStd);

        if (onsetFramesSinceLast >= ONSET_REFRACTORY_FRAMES && flux > threshold) {
          onsetCount++;
          onsetFramesSinceLast = 0;
        } else {
          onsetFramesSinceLast++;
        }
        onsetFluxHistory[onsetHistoryPos] = flux;
        onsetHistoryPos = (onsetHistoryPos + 1) % ONSET_HISTORY;
      }

      // Store the normalized spectrum for the next frame's diff.
      const normalized = new Float64Array(half0);
      for (let b = 0; b < half0; b++) normalized[b] = magnitudes[b] / frameNorm;
      prevMagnitudes = normalized;
    } else {
      // First frame: just store its normalized spectrum.
      let frameEnergy = 0;
      for (let b = 0; b < magnitudes.length; b++) frameEnergy += magnitudes[b] * magnitudes[b];
      const frameNorm = Math.sqrt(frameEnergy);
      if (frameNorm > 1e-10) {
        const normalized = new Float64Array(magnitudes.length);
        for (let b = 0; b < magnitudes.length; b++) normalized[b] = magnitudes[b] / frameNorm;
        prevMagnitudes = normalized;
      }
    }
  }

  // ── Derived features ──
  const voicedRatio = numFrames > 0 ? voicedFrames / numFrames : 0;

  // Noise floor: RMS of quietest 10% of frames
  const sortedRms = [...frameRmsValues].sort((a, b) => a - b);
  const noiseFloorCount = Math.max(1, Math.floor(sortedRms.length * NOISE_FLOOR_PERCENTILE));
  let noiseFloorSum = 0;
  for (let i = 0; i < noiseFloorCount; i++) {
    noiseFloorSum += sortedRms[i];
  }
  const noiseFloorRms = noiseFloorCount > 0 ? noiseFloorSum / noiseFloorCount : 0;
  const noiseFloorDb = noiseFloorRms > 0 ? 20 * Math.log10(noiseFloorRms) : -96;

  // Rumble level
  const rumbleEnergy = totalBandEnergy > 0 ? totalLowBandEnergy / totalBandEnergy : 0;
  const rumbleLevelDb = rumbleEnergy > 0 ? 10 * Math.log10(rumbleEnergy) - 40 : -96;

  // Band ratios
  const subBassRatio = totalBandEnergy > 0 ? totalSubBassEnergy / totalBandEnergy : 0;
  const lowMidRatio = totalBandEnergy > 0 ? totalLowMidEnergy / totalBandEnergy : 0;
  const midRatio = totalBandEnergy > 0 ? totalMidEnergy / totalBandEnergy : 0;
  const highMidRatio = totalBandEnergy > 0 ? totalHighMidEnergy / totalBandEnergy : 0;
  const highRatio = totalBandEnergy > 0 ? totalHighEnergy / totalBandEnergy : 0;
  const sibilanceRatio = totalBandEnergy > 0 ? totalSibilanceEnergy / totalBandEnergy : 0;
  const harshnessIndicator = totalBandEnergy > 0 ? totalHarshnessEnergy / totalBandEnergy : 0;

  // Spectral tilt
  const spectralTilt = spectralTiltCount > 0 ? totalSpectralTilt / spectralTiltCount : 0;

  // Dynamic range: 95th - 10th percentile of frame RMS in dB
  const p95Index = Math.floor(sortedRms.length * 0.95);
  const p10Index = Math.floor(sortedRms.length * 0.10);
  const p95Rms = sortedRms[Math.min(p95Index, sortedRms.length - 1)];
  const p10Rms = sortedRms[p10Index] || sortedRms[0];
  const dynamicRangeDb = (p95Rms > 0 && p10Rms > 0)
    ? 20 * Math.log10(p95Rms / p10Rms)
    : 0;

  // Spectral flux average
  const spectralFlux = fluxCount > 0 ? totalSpectralFlux / fluxCount : 0;

  // Transient density (onsets per second)
  const transientDensity = duration > 0 ? onsetCount / duration : 0;

  // Build octave-band spectral profile
  const octaveTotal = octaveEnergies.reduce((a, b) => a + b, 0);
  const spectralProfile: SpectralBand[] = OCTAVE_CENTER_FREQS.map((center, i) => ({
    freqLow: Math.max(20, center / Math.SQRT2),
    freqHigh: center * Math.SQRT2,
    ratio: octaveTotal > 0 ? octaveEnergies[i] / octaveTotal : 0,
  }));

  // Pitch detection
  let fundamentalRange: { low: number; high: number } | null = null;
  if (voicedRatio > 0.2) {
    const segStart = Math.floor(frameCount * 0.2);
    const segLength = Math.min(frameCount - segStart, Math.floor(sampleRate * 2));
    if (segLength > 0) {
      const segment = mono.slice(segStart, segStart + segLength);
      const pitch = detectPitch(segment, sampleRate);
      if (pitch > 0) {
        fundamentalRange = {
          low: Math.max(50, pitch * 0.9),
          high: Math.min(600, pitch * 1.1),
        };
      }
    }
  }

  // ── Validity ──
  const valid = duration >= MIN_ANALYSIS_DURATION;
  let invalidReason: string | null = null;

  if (!valid) {
    invalidReason = `Insufficient duration: ${duration.toFixed(1)}s (minimum ${MIN_ANALYSIS_DURATION}s)`;
  }

  return {
    peakLevel,
    clipCount,
    rmsLevel,
    shortTermLoudness,
    lufsIntegrated,
    crestFactorDb,
    dynamicRangeDb,
    noiseFloorDb,
    rumbleLevelDb,
    subBassRatio,
    lowMidRatio,
    midRatio,
    highMidRatio,
    highRatio,
    sibilanceRatio,
    spectralTilt,
    harshnessIndicator,
    spectralProfile,
    voicedRatio,
    fundamentalRange,
    stereoWidthDb: stereo.widthDb,
    correlation: stereo.correlation,
    transientDensity,
    spectralFlux,
    analyzedDuration: duration,
    valid,
    invalidReason,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function emptyFeatures(reason: string): UltinaFeatures {
  const base = createEmptyFeaturesInternal();
  base.invalidReason = reason;
  return base;
}

function createEmptyFeaturesInternal(): UltinaFeatures {
  return {
    peakLevel: 0,
    clipCount: 0,
    rmsLevel: 0,
    shortTermLoudness: -70,
    lufsIntegrated: -70,
    crestFactorDb: 0,
    dynamicRangeDb: 0,
    noiseFloorDb: -96,
    rumbleLevelDb: -96,
    subBassRatio: 0,
    lowMidRatio: 0,
    midRatio: 0,
    highMidRatio: 0,
    highRatio: 0,
    sibilanceRatio: 0,
    spectralTilt: 0,
    harshnessIndicator: 0,
    spectralProfile: [],
    voicedRatio: 0,
    fundamentalRange: null,
    stereoWidthDb: 0,
    correlation: 1,
    transientDensity: 0,
    spectralFlux: 0,
    analyzedDuration: 0,
    valid: false,
    invalidReason: "No analysis performed",
  };
}
