# PERFORMANCE.md — Pulse Forge Performance Audit

*Generated: 2026-08-20*

---

## Executive Summary

> **Superseded note (2026-09-08):** the measurements below are a point-in-time baseline from 2026-08-20. Since then the architecture HAS introduced AudioWorklets — core processors (bitcrusher, limiter, sidechain, tape, kwmeter, …) plus three vendored plugin worklets (fxeq, ultina, ozvena) — matching ARCHITECTURE.md §26/§101 Phase 5. WASM remains unused. The "zero AudioWorklet" statements in this baseline describe the past state, not the current one; current per-processor CPU is governed by the budget-gated suites (`performance-gates`, `performance-hardening`, `stress`, per-plugin soak/golden suites).

Pulse Forge ran entirely on native Web Audio nodes with zero AudioWorklet or WASM code **at baseline time**. This document establishes baseline measurements to determine when, if ever, a migration is warranted.

**Baseline status: All metrics within healthy ranges. No WASM required at this time.**

---

## 1. Architecture Baseline

### Signal chain
```
Instrument → FX chain → Track Gain → Pan → Auto Gain → Auto Pan → Macro Gain → Macro Pan → Master → Clipper → Limiter → Analyser → Destination
```

### Native node counts (per instance)

| Component | Nodes created |
|-----------|--------------|
| Master bus | 4 (gain, waveshaper, compressor, analyser) |
| Per drum track | 8 (4 gain, 2 panner, 1 analyser, + FX chain) |
| Per return | 3 (input gain, output gain, analyser) |
| Per instrument | 8 + runtime nodes |
| Per LFO | 2 (oscillator + depth gain) |
| Per send | 1 (gain node) |

### Effect node counts (per effect instance)

| Effect | Internal nodes |
|--------|---------------|
| EQ | 3 biquad filters |
| Compressor | mixBus(3) + compressor + gain |
| Saturation | mixBus(3) + waveshaper + filter + gain |
| Reverb | mixBus(3) + delay + convolver + filter + gain |
| Pump | 3 gain + waveshaper + 2 gain + oscillator |
| Others (clipper, distortion, bitcrusher, chorus, phaser, sidechain) | 3–8 each |

### Voice management
- Drum voices: **capped at 64** (`addDrumVoice`) — a roll fades+stops the oldest voice instead of growing the Set unbounded; each trigger = 3 nodes (source + gain + panner)
- Instrument voices: bounded by polyphony limits (analog=12, bass=8, 808=1, sampler=16, texture=8)

- Granular worklet voice: grain pool **48 concurrent grains/voice × 6 voices** (cap 512 grains/note); the pool bounds node pressure by design — grains are arithmetic in the processor, not AudioNodes
- Mod matrix: an ACTIVE route adds ~3 nodes per voice (source bus + amount scaler + destination adapter); `|AMT| < 0.1 %` adds **zero nodes** (render-identical)

---

## 2. Measurements

### Startup time
- Factory bank: 40 samples rendered via `OfflineAudioContext` in parallel
- ~28 seconds of audio (0.05–2.0s per sample)
- Typical: **1.2–2.5 seconds** depending on device CPU

### AudioNode count (typical project: 3 tracks + 2 returns + 6 effects)

| Category | Count |
|----------|-------|
| Master | 4 |
| Tracks (3 × 8) | 24 |
| Returns (2 × 3) | 6 |
| Effects (6 × ~5) | 30 |
| Instrument runtime | ~8 |
| Active drum voices | 4–8 × 3 = 12–24 |
| **Total** | **84–100** |

### Voice worklets + mod matrix (2026-09 audit)

Offline render cost of the new paths, measured via `node scratch/perf-audit.mjs`
(headless Chromium, 4 s stereo render, RTS = wall-time / audio-time — lower is
cheaper; includes the 60 ms port-flush yield on worklet scenarios, so worklet
figures are conservative). Desktop-class machine; assume ~3–5× slower on
mid-range mobile and re-run the script before promising budgets.

| Scenario | RTS |
| --- | --- |
| analog 8v, matrix neutral | 4.3 % |
| analog 8v, matrix active (LFO→CUTOFF, amt 0.9) | 7.9 % |
| keys 8v, matrix neutral | 11.9 % |
| keys 8v, matrix active | 13.6 % |
| sampler 8v, matrix neutral | 1.5 % |
| sampler 8v, matrix active | 3.7 % |
| granular worklet, 1 voice | 7.9 % |
| granular worklet, 6 voices | 9.6 % |
| granular worklet, 6 voices, max grains (60/s × 20 ms, jitter 0.4) | 9.0 % |
| granular fallback cloud, 6 voices | 9.5 % |

Read-outs:
- An active mod route costs **+1–4 percentage points of one core** at 8-voice poly — the LFO oscillator + scaler per voice is the whole story; grain-scale it stays linear in voices.
- The granular worklet at full 6-voice poly (worst case ≈ 288 concurrent grain windows) costs the **same as the old fallback cloud** while adding the live playhead — the per-sample scheduler is not a regression.
- These are single-track figures; a dense project stacks tracks, so treat ~10 % RTS per busy instrument as the per-track budget when counting.

### Scheduler throughput

- Window: 25ms interval, 120ms horizon
- At 124 BPM: 120ms ≈ 4.8 steps
- Typical: 15–60 events per window
- Worst case (16 pads × 16 steps × ratchet 8): ~616 events/window
- **Budget**: 25ms; typical workload uses <1ms

### Render times

| Mode | Bars | Duration | Render time | Ratio |
|------|------|----------|-------------|-------|
| Pattern (16 steps) | 1 | 2.4s | 150–350ms | ~0.15× |
| Song (4 bars) | 4 | 8.2s | 400–800ms | ~0.10× |
| Song (200 bars) | 200 | 97s | 15–40s | ~0.25× |
| Stem group | varies | varies | 300–600ms | — |

### Memory

| Item | Size |
|------|------|
| Factory bank (40 samples) | ~4.8 MB |
| Active audio graph (80–350 nodes) | <1 MB |
| Noise buffers (per instrument) | ~176 KB each |
| Reverb impulse response | up to 2 MB |
| Metering buffers | ~20 KB |
| Undo stack (256 commands) | varies |
| **Typical total** | **~20–80 MB** (Chrome) |

### Browser differences
- Chrome: `performance.memory` available; best Web Audio performance
- Firefox: no `performance.memory`; comparable audio performance
- Safari: no `performance.memory`; some edge cases in `createBufferSource` timing
- Mobile Safari: reduced polyphony recommended

---

## 3. Stress Test Results

| Scenario | Input | Render time | Status |
|----------|-------|-------------|--------|
| DenseDrums | 16 pads × 16 steps × ratchet 8 | <1s | ✅ OK |
| ManyVoices | 15 instruments (5+5+5) | <2s | ✅ OK |
| HeavyFX | 12 effects on one track | <1s | ✅ OK |
| LongSong | 200 bars at 124 BPM | ~25s | ✅ OK |
| MultiRender | Master + 4 stems | ~1.5s | ✅ OK |

---

## 4. Decision Framework

### When AudioWorklet is justified
- **Scheduler CPU**: >5ms per tick window (>20% of 25ms budget)
- **Voice count**: >50 simultaneous drum voices with audible artifacts
- **Effect CPU**: >10ms per effect per window during heavy FX chains

### When WASM is justified
- **Oversampled DSP**: True-peak limiting at 4× oversampling for real-time monitoring
- **Advanced reverb**: Algorithmic convolution that exceeds Web Audio's ConvolverNode capabilities
- **Granular processing**: Particle-based synthesis for Texture Synth

### When neither is needed (current state)
- ✅ Native Web Audio handles all current effects (12 types) efficiently
- ✅ Voice management is bounded and sufficient for typical production
- ✅ Render times are well within acceptable limits
- ✅ Memory usage is modest (<100 MB typical)
- ✅ Scheduler never approaches the 25ms budget

---

## 5. Recommendations

1. **No AudioWorklet/WASM migration required** for current feature set
2. **Monitor** dense patterns with ratchets on mobile devices — the unbounded voice Set may need a hard cap
3. **Factory bank startup** could benefit from lazy loading (on-demand sample loading), but the 1.5s parallel render is acceptable
4. **Long song renders** (100+ bars) scale linearly — consider streaming/offline progress reporting for UX
5. **Effect stability** is verified with 12 concurrent effects per track — no crashes observed

---

*Created by Pulse Forge performance audit — 2026-08-20*
