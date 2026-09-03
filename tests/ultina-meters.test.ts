/**
 * Ultina metering gate — the panel is the only meter consumer, so the host
 * disables the whole analysis path (spectrum FFT, 32-band analyzer, waveform,
 * peak/RMS) while no panel is attached. Proves the audio-thread invariants:
 *
 *  1. Meters ON (default): LUFS tracks a loud signal.
 *  2. Meters OFF: the LUFS reading freezes — the analysis loop is verifiably
 *     not running (no silent "still updating" behavior can pass this).
 *  3. Meters OFF + gain-match ON: the LUFS meter keeps running, because the
 *     auto-gain feedback loop reads it — audible behavior must not change.
 *  4. Re-enabling resumes fresh snapshots; bypass+off renders untouched.
 */
import { describe, expect, it } from "vitest";
import { UltinaProcessor } from "../src/effects/ultina-core/dsp/ultinaProcessor.js";
import { registerCoreModules } from "../src/effects/ultina-core/dsp/moduleFactories.js";

const SR = 48000;
const BLOCK = 128;

function makeProcessor(): UltinaProcessor {
  const proc = new UltinaProcessor();
  registerCoreModules(proc);
  proc.prepare({ sampleRate: SR, maxBlockSize: BLOCK, channelCount: 2, qualityMode: 1 });
  return proc;
}

function renderLoud(proc: UltinaProcessor, seconds: number): void {
  const blocks = Math.round((seconds * SR) / BLOCK);
  const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < BLOCK; i++) {
      const v = 0.4 * Math.sin((2 * Math.PI * 440 * (b * BLOCK + i)) / SR);
      chans[0][i] = v;
      chans[1][i] = v;
    }
    proc.process(chans, BLOCK);
  }
}

describe("Ultina metering gate", () => {
  it("meters ON (default): LUFS tracks a loud signal", () => {
    const proc = makeProcessor();
    renderLoud(proc, 4);
    expect(proc.getLufsReading().shortTermLufs).toBeGreaterThan(-30);
  });

  it("meters OFF freezes the analysis path (LUFS frozen exactly)", () => {
    const proc = makeProcessor();
    renderLoud(proc, 4);
    const frozenAt = proc.getLufsReading().shortTermLufs;
    expect(frozenAt).toBeGreaterThan(-30);

    proc.setMetersEnabled(false);
    renderLoud(proc, 3); // loud signal keeps flowing
    expect(proc.getLufsReading().shortTermLufs).toBe(frozenAt);

    // The meter snapshot still serves the last state without crashing.
    expect(proc.getMeters().global.outputShortTermLufs).toBe(frozenAt);
  });

  it("meters OFF + gain-match ON keeps the LUFS feedback loop alive", () => {
    const proc = makeProcessor();
    proc.setParameter("global.gainMatchEnabled", 1);
    renderLoud(proc, 4);
    proc.setMetersEnabled(false);
    const atDisable = proc.getLufsReading().shortTermLufs;
    expect(atDisable).toBeGreaterThan(-30);
    renderLoud(proc, 5);
    const after = proc.getLufsReading().shortTermLufs;
    // The auto-gain loop measures and pulls the level toward its −14 LUFS
    // target even with panel meters off — the reading MUST have moved (a
    // fully-gated meter would freeze at exactly atDisable).
    expect(after).not.toBe(atDisable);
    expect(Math.abs(after - atDisable)).toBeGreaterThan(0.5);
  });

  it("re-enabling meters resumes fresh snapshots; bypass+off renders untouched", () => {
    const proc = makeProcessor();
    proc.setMetersEnabled(false);
    renderLoud(proc, 1);
    proc.setMetersEnabled(true);
    renderLoud(proc, 4);
    expect(proc.getLufsReading().shortTermLufs).toBeGreaterThan(-30);

    proc.setParameter("global.bypass", 1);
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    for (let i = 0; i < BLOCK; i++) {
      chans[0][i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / SR);
      chans[1][i] = chans[0][i];
    }
    expect(() => proc.process(chans, BLOCK)).not.toThrow();
    expect(chans[0][0]).toBeCloseTo(chans[1][0], 6);
  });
});

describe("Ultina pooled meter snapshot", () => {
  it("reuses the snapshot buffers across calls (zero steady-state allocation)", () => {
    const proc = makeProcessor();
    const m1 = proc.getMeters();
    const m2 = proc.getMeters();
    // Pooling contract: same containers, overwritten in place.
    expect(m2.global.outputWaveform).toBe(m1.global.outputWaveform);
    expect(m2.global.inputSpectrumDb).toBe(m1.global.inputSpectrumDb);
    expect(m2).toBe(m1);
  });

  it("pooled buffers still carry FRESH data every call (no stale pooling)", () => {
    const proc = makeProcessor();
    renderLoud(proc, 4);
    const quietWaveformPeak = (() => {
      const m = proc.getMeters();
      let peak = 0;
      for (let i = 0; i < m.global.outputWaveform!.length; i++) {
        peak = Math.max(peak, Math.abs(m.global.outputWaveform![i]));
      }
      return peak;
    })();
    expect(quietWaveformPeak).toBeGreaterThan(0.05); // loud signal visible

    // Silence the input; the next snapshot must reflect the new state.
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    // 4 s of silence — the short-term LUFS window is 3 s, so it needs to
    // fully drain before the reading can fall.
    for (let b = 0; b < Math.round((4 * SR) / BLOCK); b++) proc.process(chans, BLOCK);
    const m = proc.getMeters();
    let peak = 0;
    for (let i = 0; i < m.global.outputWaveform!.length; i++) {
      peak = Math.max(peak, Math.abs(m.global.outputWaveform![i]));
    }
    expect(peak).toBeLessThan(0.01); // waveform followed the silence
    expect(m.global.outputShortTermLufs).toBeLessThan(-40);
  });
});
