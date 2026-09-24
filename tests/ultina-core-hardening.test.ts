/**
 * Ultina hardening regression suite — one test per confirmed defect fixed in
 * the 2026-09 hardening pass (DSP + host). Each test pins the FIXED behavior
 * and fails on the pre-fix code path.
 *
 * Covered:
 *  1. Clipper knee > 6 dB (negative kneeStart mapped near-zero inputs to
 *     ~0.2 garbage and produced Infinity in the reduction meter).
 *  2. EQ learn band selectivity (guards the per-band pristine-copy contract
 *     that keeps bandpass filters from cascading).
 *  3. Auto-gain startup delay re-arms on disabled→enabled (stale-LUFS guard).
 *  4. SpectralRegistry: unregister removes the consumer's staleness records
 *     from surviving entries (unbounded map growth on instance churn).
 *  5. Gate: close threshold above open threshold no longer chatters.
 *  6. Unmask: sidechain shorter than the block no longer poisons gains.
 *  7. MaskingMeter: per-block envelope coefficient + pooled result.
 *  8. mixAssistant/targetLibrary: non-finite target-curve entries sanitized.
 *  9. Project load retains deep plugin params (ultina/fxeq/ozvena) — the
 *     normalizeEffects rack-only strip was silent data loss.
 * 10. applyUltinaPreset / applyUltinaProposal validate+clamp every value.
 * 11. AudioEngine: fxParam + gain automation reaches group-bus chains.
 */
import { describe, expect, it } from "vitest";
import { UltinaProcessor } from "../src/effects/ultina-core/dsp/ultinaProcessor.js";
import { registerCoreModules } from "../src/effects/ultina-core/dsp/moduleFactories.js";
import { EqLearn, EQ_LEARN_FREQS } from "../src/effects/ultina-core/dsp/eqLearn.js";
import { AutoGainController } from "../src/effects/ultina-core/dsp/autoGain.js";
import { SpectralRegistry } from "../src/effects/ultina-core/dsp/spectralRegistry.js";
import { MaskingMeter } from "../src/effects/ultina-core/dsp/maskingMeter.js";
import { MultibandProcessor } from "../src/effects/ultina-core/dsp/multiband.js";
import { dbToLinear } from "../src/effects/ultina-core/dsp/primitives.js";
import { analyzeWithTarget } from "../src/effects/ultina-core/analysis/mixAssistant.js";
import { createCustomTarget } from "../src/effects/ultina-core/analysis/targetLibrary.js";
import { AudioEngine } from "../src/audio-engine/AudioEngine.js";
import { createDefaultProject, normalizeProject } from "../src/project-model/schema.js";
import type { ProjectDocument, Track, EffectInstance } from "../src/project-model/types.js";
import {
  addEffect,
  setUltinaParam,
  setFxEqParam,
  applyUltinaPreset,
  applyUltinaProposal,
  applyFxEqPreset,
  applyOzvenaStatePatch,
  loadUltinaAbSlot,
  loadEffectAbSlot,
  setDeviceState,
  addAutomationLane,
  addAutomationPoint,
  moveAutomationPoint,
  addSceneAutomation,
  addSceneAutomationPoint,
} from "../src/commands/commands.js";
import {
  buildDefaultParams as buildUltinaDefaultParams,
  tryGetParamDef as tryGetUltinaDef,
} from "../src/effects/ultina-core/contracts/parameterSchema.js";
import {
  ultinaLaneParams,
  ultinaLaneRange,
  ultinaOptionGroups,
  formatUltinaParam,
} from "../src/effects/ultinaAutomation.js";

const SR = 48000;
const BLOCK = 128;

function makeProcessor(): UltinaProcessor {
  const proc = new UltinaProcessor();
  registerCoreModules(proc);
  proc.prepare({ sampleRate: SR, maxBlockSize: BLOCK, channelCount: 2, qualityMode: 1 });
  return proc;
}

function enableInGraph(proc: UltinaProcessor, moduleType: string): void {
  proc.getGraphRuntime().setModuleEnabled(moduleType as never, true);
  proc.setParameter(`${moduleType}.enabled`, 1);
}

function sine(chans: Float32Array[], blockIndex: number, freq: number, amp: number): void {
  for (let i = 0; i < BLOCK; i++) {
    const t = (blockIndex * BLOCK + i) / SR;
    const v = amp * Math.sin(2 * Math.PI * freq * t);
    chans[0][i] = v;
    chans[1][i] = v;
  }
}

/** Look up the first instrument track of a doc (tests always have one). */
function firstInstrumentTrack(doc: ProjectDocument): Track {
  const inst = doc.tracks.find((t) => t.kind === "instrument");
  if (!inst) throw new Error("test doc has no instrument track");
  return inst;
}

function findEffect(track: Track, type: string): EffectInstance {
  const fx = track.effects.find((f) => f.type === type);
  if (!fx) throw new Error(`test track has no ${type} effect`);
  return fx;
}

// ── 1. Clipper knee ─────────────────────────────────────────

describe("clipper: knee beyond 6 dB stays monotonic and bounded", () => {
  it("a −40 dBFS signal is not amplified to garbage with knee=12 dB (P1)", () => {
    const proc = makeProcessor();
    enableInGraph(proc, "clipper");
    proc.setParameters({
      "clipper.ceilingDb": -1,
      "clipper.kneeDb": 12, // > 6.02 dB made kneeStart negative (broken regime)
      "clipper.driveDb": 0,
      "clipper.oversampling": 0,
      "clipper.bandCount": 1,
      "clipper.mix": 100,
    });
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    let maxAbs = 0;
    let nonFinite = 0;
    let tailSumSq = 0;
    let tailN = 0;
    const blocks = 120;
    for (let b = 0; b < blocks; b++) {
      sine(chans, b, 440, 0.01); // −40 dBFS
      proc.process(chans, BLOCK);
      if (b >= blocks - 16) {
        for (let i = 0; i < BLOCK; i++) {
          tailSumSq += chans[0][i] * chans[0][i];
          tailN++;
        }
      }
      for (let i = 0; i < BLOCK; i++) {
        if (!Number.isFinite(chans[0][i])) nonFinite++;
        const a = Math.abs(chans[0][i]);
        if (a > maxAbs) maxAbs = a;
      }
    }
    expect(nonFinite).toBe(0);
    // Ceiling is enforced on the final output.
    expect(maxAbs).toBeLessThanOrEqual(dbToLinear(-1) * 1.001);
    // The wide soft knee COMPRESSES; it must never massively AMPLIFY a
    // quiet signal (pre-fix: −40 dBFS in → ≈−17 dBFS crossover garbage).
    const inRms = 0.01 * Math.SQRT1_2;
    const outRms = Math.sqrt(tailSumSq / tailN);
    expect(outRms / inRms).toBeLessThan(2);
  });

  it("clippingReductionDb meter stays finite (pre-fix: Infinity via |out|=0)", () => {
    const proc = makeProcessor();
    enableInGraph(proc, "clipper");
    proc.setParameters({
      "clipper.ceilingDb": -1,
      "clipper.kneeDb": 12,
      "clipper.oversampling": 0,
      "clipper.bandCount": 1,
      "clipper.mix": 100,
    });
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    for (let b = 0; b < 60; b++) {
      // Sweep amplitudes through the whole knee region, including tiny ones.
      sine(chans, b, 440, 0.0005 + (b / 60) * 0.9);
      proc.process(chans, BLOCK);
      const meters = proc.getMeters().modules.clipper as { clippingReductionDb: number[] };
      for (const v of meters.clippingReductionDb) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

// ── 2. EQ learn band selectivity ─────────────────────────────

describe("eqLearn: per-band analysis stays selective", () => {
  it("a 1 kHz sine reports the 1 kHz band as the loudest (no filter cascade)", () => {
    const learn = new EqLearn();
    learn.prepare(SR, BLOCK);
    const buf = new Float32Array(BLOCK);
    for (let b = 0; b < Math.round(SR / BLOCK); b++) {
      for (let i = 0; i < BLOCK; i++) {
        buf[i] = 0.4 * Math.sin((2 * Math.PI * 1000 * (b * BLOCK + i)) / SR);
      }
      learn.process(buf, BLOCK);
    }
    const res = learn.getResult();
    expect(res.bandLevels.every(Number.isFinite)).toBe(true);
    let best = 0;
    for (let b = 1; b < res.bandLevels.length; b++) {
      if (res.bandLevels[b] > res.bandLevels[best]) best = b;
    }
    // The winning band center must be near 1 kHz (a cascaded filter chain —
    // the regression this guards against — smears the argmax away).
    expect(EQ_LEARN_FREQS[best]).toBeGreaterThan(600);
    expect(EQ_LEARN_FREQS[best]).toBeLessThan(1600);
  });
});

// ── 3. Auto-gain re-arm ──────────────────────────────────────

describe("autoGain: startup delay re-arms on re-enable", () => {
  it("gain stays ~0 for the startup window after a disabled→enabled transition", () => {
    const ag = new AutoGainController();
    ag.prepare(SR, BLOCK);
    ag.setTargetLufs(-14);

    // Enabled from creation: after 1.5 s the controller is active. Signal
    // (−10 LUFS) is LOUDER than target (−14) → error is negative → the
    // correction ramps negative (turn it down).
    ag.setEnabled(true);
    let g = 0;
    for (let b = 0; b < Math.round((1.5 * SR) / BLOCK); b++) g = ag.process(-10, BLOCK);
    expect(g).toBeLessThan(-0.1); // integrating the −4 dB error by now
    expect(ag.getReading().active).toBe(true);

    // Disabled: gain decays away (2 s ≫ the 2 s smoother constant).
    ag.setEnabled(false);
    for (let b = 0; b < Math.round((2 * SR) / BLOCK); b++) g = ag.process(-10, BLOCK);
    expect(Math.abs(g)).toBeLessThan(0.02);

    // Re-enabled: the startup delay must re-arm (the LUFS window may be
    // stale). Pre-fix, msSinceStart kept growing and the integrator engaged
    // against the stale reading immediately — gain grew to ≈−0.3 dB within
    // the window. Post-fix the only residual is the smoother's pre-existing
    // decay tail, which keeps SHRINKING.
    ag.setEnabled(true);
    expect(ag.getReading().active).toBe(false); // inside the 1 s delay again
    let windowMax = 0;
    for (let b = 0; b < Math.round((0.5 * SR) / BLOCK); b++) {
      g = ag.process(-10, BLOCK);
      windowMax = Math.max(windowMax, Math.abs(g));
    }
    expect(ag.getReading().active).toBe(false); // still inside the delay
    expect(windowMax).toBeLessThan(0.3); // no fresh integration (pre-fix ≈0.3+)
    expect(Math.abs(g)).toBeLessThan(0.05); // tail still decaying, not growing
  });
});

// ── 4. Spectral registry staleness cleanup ───────────────────

describe("spectralRegistry: unregister cleans consumer staleness records", () => {
  it("a churned consumer leaves no records behind on live entries", () => {
    const reg = SpectralRegistry.getInstance();
    reg.clear();
    reg.register("A");
    reg.register("B");
    reg.publish("B", new Float32Array(32).fill(-50));
    const out = new Float32Array(32);
    expect(reg.getAggregateMasker("A", out)).toBe(true);
    out.fill(-200); // second query creates/uses A's staleness record on B
    reg.getAggregateMasker("A", out);

    const bEntry = reg.listInstances().find((e) => e.instanceId === "B")!;
    expect(bEntry.consumerStaleness.get("A")).toBeDefined();

    reg.unregister("A");
    const bAfter = reg.listInstances().find((e) => e.instanceId === "B")!;
    expect(bAfter.consumerStaleness.get("A")).toBeUndefined();
    reg.clear();
  });
});

// ── 5. Gate hysteresis ───────────────────────────────────────

describe("gate: close threshold above open threshold is clamped", () => {
  it("an inverted hysteresis pair no longer chatters the gate state", () => {
    const proc = makeProcessor();
    enableInGraph(proc, "gate");
    proc.setParameters({
      "gate.rangeDb": -20,
      "gate.attackMs": 1,
      "gate.releaseMs": 50,
      // Inverted on purpose (open −40, close −20): the schema allows both.
      "gate.band0.openThresholdDb": -40,
      "gate.band0.closeThresholdDb": -20,
      "gate.mix": 100,
      "gate.bandCount": 1,
    });
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const observed: number[] = [];
    for (let b = 0; b < 60; b++) {
      sine(chans, b, 440, 0.032); // −30 dBFS — above open, below close
      proc.process(chans, BLOCK);
      if (b >= 40) {
        // The module's meter payload exposes per-band state as bandState.
        const meters = proc.getMeters().modules.gate as { bandState: number[] };
        observed.push(meters.bandState[0]);
      }
    }
    // Signal is above the open threshold → the gate must be stably OPEN or
    // HOLDING (GateState.Open = 2, Holding = 3). Pre-fix the inverted
    // thresholds made the state machine oscillate through Closed/Closing.
    expect(observed.every((s) => s === 2 || s === 3)).toBe(true);
  });
});

// ── 6. Unmask short sidechain ────────────────────────────────

describe("unmask: sidechain shorter than the block", () => {
  it("a 64-frame sidechain channel against a 128-frame block stays finite and audible", () => {
    const proc = makeProcessor();
    enableInGraph(proc, "unmask");
    proc.setParameters({
      "unmask.amount": 10, // gentle correction — output must remain audible
      "unmask.maskingThresholdDb": -40,
      "unmask.sidechainEnabled": 1,
      "unmask.responseSpeedHz": 20,
      "unmask.mix": 100,
      "unmask.ecosystemEnabled": 0,
    });
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const shortSc = [new Float32Array(64), new Float32Array(64)];
    for (let i = 0; i < 64; i++) shortSc[0][i] = shortSc[1][i] = 0.2;
    let nonFinite = 0;
    let tailSumSq = 0;
    let tailN = 0;
    for (let b = 0; b < 80; b++) {
      sine(chans, b, 440, 0.4);
      proc.process(chans, BLOCK, shortSc);
      if (b >= 64) {
        for (let i = 0; i < BLOCK; i++) {
          if (!Number.isFinite(chans[0][i])) nonFinite++;
          tailSumSq += chans[0][i] * chans[0][i];
          tailN++;
        }
      }
    }
    expect(nonFinite).toBe(0);
    // Pre-fix: out-of-range copy wrote NaN into the analysis buffer → NaN
    // gains → sanitized output = digital silence.
    expect(Math.sqrt(tailSumSq / tailN)).toBeGreaterThan(1e-3);
  });
});

// ── 7. Masking meter envelope + pooling ──────────────────────

describe("MaskingMeter: block-scaled envelope and pooled result", () => {
  it("the 50 ms envelope settles within ~100 ms, not ~6 s", () => {
    const mm = new MaskingMeter();
    mm.prepare(SR, BLOCK);
    const main = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) main[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    const sc = new Float32Array(BLOCK); // silent sidechain
    let res = mm.analyze(main, sc, BLOCK);
    for (let b = 1; b < 60; b++) res = mm.analyze(main, sc, BLOCK);
    // 60 blocks ≈ 160 ms ≈ 3 time constants → within a few dB of steady
    // state. Pre-fix the per-sample coefficient was applied once per block
    // (≈128× too slow): the band read ≈ −35 dB or lower.
    const band1k = res.mainLevels[3]; // bands: 100, 250, 500, 1000, …
    expect(band1k).toBeGreaterThan(-12);
    expect(Number.isFinite(res.levels[3])).toBe(true);
  });

  it("analyze() returns the pooled object (overwrite contract)", () => {
    const mm = new MaskingMeter();
    mm.prepare(SR, BLOCK);
    const a = new Float32Array(BLOCK);
    const b = new Float32Array(BLOCK);
    const r1 = mm.analyze(a, b, BLOCK);
    const r2 = mm.analyze(a, b, BLOCK);
    expect(r2).toBe(r1); // same object — zero steady-state allocation
  });
});

// ── 8. Analysis-layer sanitization ───────────────────────────

describe("analysis: non-finite target curves cannot poison proposals", () => {
  const audio = (() => {
    const len = Math.round(2.5 * 44100);
    const c = new Float32Array(len);
    for (let i = 0; i < len; i++) c[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / 44100);
    return [c, c];
  })();

  it("createCustomTarget sanitizes non-finite curve entries", () => {
    const t = createCustomTarget("bad", [0, Number.NaN, Infinity, -3, 0, 0, 0, 0, 0, 0]);
    expect(t.curve.every((v) => Number.isFinite(v))).toBe(true);
    expect(t.curve[1]).toBe(0);
    expect(t.curve[2]).toBe(0);
  });

  it("analyzeWithTarget with a NaN entry yields finite proposal values", () => {
    const result = analyzeWithTarget({ channels: audio, sampleRate: 44100, minimumDuration: 2 }, [
      0,
      Number.NaN,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    for (const c of result.proposal.changes) {
      // Pre-fix: deviation NaN → adjustment NaN → NaN proposal values.
      expect(Number.isFinite(c.value)).toBe(true);
      // EQ band gains specifically stay inside their schema range.
      if (/^eq\.band\d+\.gainDb$/.test(c.parameterId)) {
        expect(Math.abs(c.value)).toBeLessThanOrEqual(18);
      }
    }
  });
});

// ── 8b. Sculptor silent-band guard ───────────────────────────

describe("sculptor: silent bands get no correction", () => {
  it("digital silence produces a flat (all-zero) correction curve", () => {
    const proc = makeProcessor();
    enableInGraph(proc, "sculptor");
    proc.setParameters({
      "sculptor.amount": 100,
      "sculptor.dryWet": 100,
      "sculptor.targetProfile": 0,
    });
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)]; // silence
    for (let b = 0; b < Math.round((1.5 * SR) / BLOCK); b++) {
      proc.process(chans, BLOCK);
    }
    const meters = proc.getMeters().modules.sculptor as { spectralCurveDb: Float32Array | null };
    expect(meters.spectralCurveDb).not.toBeNull();
    for (const g of meters.spectralCurveDb!) {
      // Pre-fix: every band measured −200 dB → the relative-level math
      // clamped to a full correction boost, EQ-ing pure silence.
      expect(Math.abs(g)).toBeLessThan(0.5);
    }
  });

  it("a sparse low spectrum does not drag active bands to the −12 dB limit", () => {
    const proc = makeProcessor();
    enableInGraph(proc, "sculptor");
    proc.setParameters({
      "sculptor.amount": 100,
      "sculptor.dryWet": 100,
      "sculptor.targetProfile": 3, // flat-ish piano target
    });
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    for (let b = 0; b < Math.round((1.5 * SR) / BLOCK); b++) {
      for (let i = 0; i < BLOCK; i++) {
        const t = (b * BLOCK + i) / SR;
        const v =
          0.1 * (Math.sin(2 * Math.PI * 80 * t) + Math.sin(2 * Math.PI * 170 * t) + Math.sin(2 * Math.PI * 350 * t));
        chans[0][i] = v;
        chans[1][i] = v;
      }
      proc.process(chans, BLOCK);
    }
    const meters = proc.getMeters().modules.sculptor as { spectralCurveDb: Float32Array | null };
    expect(meters.spectralCurveDb).not.toBeNull();
    // High bands are silent and must not participate in avgDb. Before the
    // fix, the dead −200 dB bands pulled the active low band to max cut.
    expect(meters.spectralCurveDb![0]).toBeGreaterThan(-10);
    expect(meters.spectralCurveDb![1]).toBeGreaterThan(-10);
  });
});

// ── 8c. Multiband T/S channel isolation ─────────────────────

describe("multiband: stereo transient/sustain keeps channel state isolated", () => {
  it("silence on R stays silent after L has excited the crossover", () => {
    const mb = new MultibandProcessor();
    mb.prepare(SR, 2, BLOCK, 2);
    mb.setCrossover(0, 1000);
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    for (let b = 0; b < 24; b++) {
      sine([left, right], b, 220, 0.4);
      right.fill(0);
      mb.process([left, right], BLOCK, () => {}, "sustain");
    }
    left.fill(0);
    right.fill(0);
    mb.process([left, right], BLOCK, () => {}, "sustain");
    let maxRight = 0;
    for (const sample of right) maxRight = Math.max(maxRight, Math.abs(sample));
    expect(maxRight).toBeLessThan(1e-7);
  });
});

// ── 9. Deep plugin params survive project normalization ──────

describe("normalizeProject: flagship deep params survive load", () => {
  it("ultina module params survive a save→load round trip", () => {
    const base = createDefaultProject();
    const inst = firstInstrumentTrack(base);
    const withFx = addEffect(base, inst.id, "ultina").execute(base);
    const fx = findEffect(firstInstrumentTrack(withFx), "ultina");
    const tuned = setUltinaParam(withFx, inst.id, fx.id, "eq.band3.gainDb", -6).execute(withFx);

    // JSON round trip (IndexedDB persistence path), then normalize on load.
    const loaded = normalizeProject(JSON.parse(JSON.stringify(tuned)));
    const after = findEffect(firstInstrumentTrack(loaded), "ultina");
    expect(after.params["eq.band3.gainDb"]).toBe(-6);
    // Rack params keep their rack defaults/clamps — session A6 unified the
    // flagship mixes to 0..1, so the legacy 0..100 default rescales on load.
    expect(after.params["global.mix"]).toBe(1);
  });

  it("unknown ids are dropped and out-of-range values clamped on restore", () => {
    const base = createDefaultProject();
    const inst = firstInstrumentTrack(base);
    const withFx = addEffect(base, inst.id, "ultina").execute(base);
    const fx = findEffect(firstInstrumentTrack(withFx), "ultina");
    const poisoned = JSON.parse(JSON.stringify(withFx)) as ProjectDocument;
    const track = poisoned.tracks.find((t) => t.id === inst.id)!;
    const target = track.effects.find((e) => e.id === fx.id)!;
    // Simulate corrupted stored state: out-of-range, unknown, and null
    // (JSON's NaN) entries.
    (target.params as Record<string, number | null>)["comp.thresholdDb"] = null;
    target.params["eq.band0.q"] = 999; // out of range → clamp to 24
    target.params["bogus.param"] = 5; // unknown id → dropped
    const loaded = normalizeProject(poisoned);
    const after = findEffect(firstInstrumentTrack(loaded), "ultina");
    expect(after.params["eq.band0.q"]).toBe(24);
    expect(after.params["bogus.param"]).toBeUndefined();
    expect(after.params["comp.thresholdDb"]).toBe(-20); // schema default
  });

  it("fxeq and ozvena deep params survive too (sibling pattern)", () => {
    const base = createDefaultProject();
    const inst = firstInstrumentTrack(base);
    const withFxEq = addEffect(base, inst.id, "fxeq").execute(base);
    const fxEq = findEffect(firstInstrumentTrack(withFxEq), "fxeq");
    const tuned = setFxEqParam(withFxEq, inst.id, fxEq.id, "band1.satDriveDb", 6).execute(withFxEq);

    const withOz = addEffect(tuned, inst.id, "ozvena").execute(tuned);
    const ozTuned = JSON.parse(JSON.stringify(withOz)) as ProjectDocument;
    const ozTrack = ozTuned.tracks.find((t) => t.id === inst.id)!;
    const oz = ozTrack.effects.find((e) => e.type === "ozvena")!;
    oz.params["engines.e1.enabled"] = 0;

    const loaded = normalizeProject(ozTuned);
    const track = loaded.tracks.find((t) => t.id === inst.id)!;
    expect(track.effects.find((f) => f.type === "fxeq")!.params["band1.satDriveDb"]).toBe(6);
    expect(track.effects.find((f) => f.type === "ozvena")!.params["engines.e1.enabled"]).toBe(0);
  });
});

// ── 10. Preset / proposal validation ─────────────────────────

describe("applyUltinaPreset / applyUltinaProposal: validate and clamp", () => {
  function withUltina() {
    const base = createDefaultProject();
    const inst = firstInstrumentTrack(base);
    const withFx = addEffect(base, inst.id, "ultina").execute(base);
    const fx = findEffect(firstInstrumentTrack(withFx), "ultina");
    return { doc: withFx, instId: inst.id, fxId: fx.id };
  }

  it("preset values are clamped and unknown ids dropped", () => {
    const { doc, instId, fxId } = withUltina();
    const next = applyUltinaPreset(doc, instId, fxId, "hostile", {
      "eq.band0.gainDb": 999, // → clamp 18
      "eq.band0.q": 0.5,
      "not.a.param": 7, // → dropped
    }).execute(doc);
    const fx = findEffect(firstInstrumentTrack(next), "ultina");
    expect(fx.params["eq.band0.gainDb"]).toBe(18);
    expect(fx.params["eq.band0.q"]).toBe(0.5);
    expect(fx.params["not.a.param"]).toBeUndefined();
  });

  it("proposal toggles and changes route through the schema", () => {
    const { doc, instId, fxId } = withUltina();
    const next = applyUltinaProposal(
      doc,
      instId,
      fxId,
      "test proposal",
      [
        { moduleType: "comp", enabled: true },
        { moduleType: "nope", enabled: true },
      ],
      [
        { parameterId: "comp.thresholdDb", value: -999 }, // → clamp -60
        { parameterId: "hacker.param", value: 1 }, // → dropped
      ],
    ).execute(doc);
    const fx = findEffect(firstInstrumentTrack(next), "ultina");
    expect(fx.params["comp.enabled"]).toBe(1);
    expect(fx.params["nope.enabled"]).toBeUndefined();
    expect(fx.params["comp.thresholdDb"]).toBe(-60);
    expect(fx.params["hacker.param"]).toBeUndefined();
  });
});

// ── 12. Canonical undo: full-map commands revert DSP-visible deep params ──
//
// The engine's syncFxParams pushes ONLY doc-present keys to the effect
// runtime. A preset/slot/proposal EXECUTE writes a full canonical param
// map (schema defaults + overrides); if UNDO restored the raw previous
// partial map (a fresh instance carries just the rack params), every deep
// param the gesture wrote stayed stuck in the worklet at its gesture value
// while the document — and the panel reading it — showed the default.
// Undo must therefore restore a canonical map: plugin defaults overlaid
// with the previous partial values.

describe("canonical undo: full-map plugin commands revert DSP-visible deep params", () => {
  function withFx(type: "ultina" | "fxeq" | "ozvena") {
    const base = createDefaultProject();
    const inst = firstInstrumentTrack(base);
    const withFxD = addEffect(base, inst.id, type).execute(base);
    const fx = findEffect(firstInstrumentTrack(withFxD), type);
    return { doc: withFxD, instId: inst.id, fxId: fx.id };
  }

  function effectOf(doc: ProjectDocument, type: string): EffectInstance {
    return findEffect(firstInstrumentTrack(doc), type);
  }

  it("applyUltinaPreset undo restores schema defaults for preset-written deep keys", () => {
    const { doc, instId, fxId } = withFx("ultina");
    const preset = { "comp.thresholdDb": -50, "eq.band0.gainDb": 6 };
    const cmd = applyUltinaPreset(doc, instId, fxId, "p", preset);
    const executed = cmd.execute(doc);
    expect(effectOf(executed, "ultina").params["comp.thresholdDb"]).toBe(-50);
    const undone = cmd.undo(executed);
    const params = effectOf(undone, "ultina").params;
    // Pre-fix: both keys were ABSENT from the partial undo map, so the DSP
    // kept -50 dB / +6 dB forever while the doc claimed defaults.
    expect(params["comp.thresholdDb"]).toBe(tryGetUltinaDef("comp.thresholdDb")!.defaultValue);
    expect(params["eq.band0.gainDb"]).toBe(0);
    // Every key the execute wrote is present after undo → the engine diff
    // reverts each one in the DSP.
    for (const id of Object.keys(effectOf(executed, "ultina").params)) {
      expect(params[id]).toBeDefined();
    }
  });

  it("applyUltinaProposal undo reverts proposal-added deep keys to defaults", () => {
    const { doc, instId, fxId } = withFx("ultina");
    const cmd = applyUltinaProposal(doc, instId, fxId, "assist", [], [{ parameterId: "comp.thresholdDb", value: -18 }]);
    const executed = cmd.execute(doc);
    expect(effectOf(executed, "ultina").params["comp.thresholdDb"]).toBe(-18);
    const undone = cmd.undo(executed);
    expect(effectOf(undone, "ultina").params["comp.thresholdDb"]).toBe(
      tryGetUltinaDef("comp.thresholdDb")!.defaultValue,
    );
  });

  it("loadUltinaAbSlot undo restores a canonical full map", () => {
    const { doc, instId, fxId } = withFx("ultina");
    const withState = setDeviceState(doc, instId, fxId, {
      kind: "ultina-ab-v1",
      data: { slots: { B: { "comp.thresholdDb": -45 } }, active: "A" },
    }).execute(doc);
    const cmd = loadUltinaAbSlot(withState, instId, fxId, "B");
    const executed = cmd.execute(withState);
    expect(effectOf(executed, "ultina").params["comp.thresholdDb"]).toBe(-45);
    const undone = cmd.undo(executed);
    expect(effectOf(undone, "ultina").params["comp.thresholdDb"]).toBe(
      tryGetUltinaDef("comp.thresholdDb")!.defaultValue,
    );
  });

  it("loadEffectAbSlot undo restores a canonical full map (generic flagship path)", () => {
    const { doc, instId, fxId } = withFx("ultina");
    const withState = setDeviceState(doc, instId, fxId, {
      kind: "effect-ab-v1",
      data: { slots: { B: { "eq.band3.q": 8 } }, active: "A" },
    }).execute(doc);
    const cmd = loadEffectAbSlot(withState, instId, fxId, "B");
    const executed = cmd.execute(withState);
    expect(effectOf(executed, "ultina").params["eq.band3.q"]).toBe(8);
    const undone = cmd.undo(executed);
    expect(effectOf(undone, "ultina").params["eq.band3.q"]).toBe(tryGetUltinaDef("eq.band3.q")!.defaultValue);
  });

  it("applyFxEqPreset undo restores band-schema defaults (sibling pattern)", () => {
    const { doc, instId, fxId } = withFx("fxeq");
    const cmd = applyFxEqPreset(doc, instId, fxId, "p", { "band2.satDriveDb": 12 });
    const executed = cmd.execute(doc);
    expect(effectOf(executed, "fxeq").params["band2.satDriveDb"]).toBe(12);
    const undone = cmd.undo(executed);
    expect(effectOf(undone, "fxeq").params["band2.satDriveDb"]).toBe(6);
  });

  it("applyOzvenaStatePatch undo restores the deep state tree (sibling pattern)", () => {
    const { doc, instId, fxId } = withFx("ozvena");
    const cmd = applyOzvenaStatePatch(doc, instId, fxId, "patch", { "duck.thresholdDb": -30 });
    const executed = cmd.execute(doc);
    expect(effectOf(executed, "ozvena").params["duck.thresholdDb"]).toBe(-30);
    const undone = cmd.undo(executed);
    // Pre-fix: the patch-written path vanished from the doc while the
    // worklet's state tree kept the patched value.
    expect(effectOf(undone, "ozvena").params["duck.thresholdDb"]).toBeDefined();
  });

  it("the canonical ultina undo map agrees with the vendored schema for every id", () => {
    const defaults = buildUltinaDefaultParams();
    for (const id of Object.keys(defaults)) {
      expect(defaults[id]).toBe(tryGetUltinaDef(id)!.defaultValue);
    }
  });
});

// ── 11. Group-bus automation reaches the chain ───────────────

describe("AudioEngine: automation resolves group-bus chains", () => {
  it("scheduleDeviceAutomation reaches an fx runtime on a group track", () => {
    const engine = new AudioEngine();
    const calls: string[] = [];
    const rt = {
      setParameterAt: (id: string, v: number, when: number) => calls.push(`${id}@${v}:${when}`),
      setParameter: (id: string, v: number) => calls.push(`${id}=${v}`),
    };
    const groups = (engine as unknown as { groupNodes: Map<string, unknown> }).groupNodes;
    groups.set("g1", { fx: { runtimes: new Map([["fx1", rt]]) } });

    engine.scheduleDeviceAutomation(
      "g1",
      "fx",
      "fx1",
      "global.mix",
      [
        { tick: 0, value: 50 },
        { tick: 480, value: 80 },
      ],
      (t) => t / 960,
    );
    // Pre-fix: trackNodes-only lookup silently dropped group-bus lanes.
    expect(calls).toEqual(["global.mix@50:0", "global.mix@80:0.5"]);
  });

  it("scheduleDeviceAutomation falls back to return-track chains", () => {
    const engine = new AudioEngine();
    const calls: string[] = [];
    const rt = { setParameterAt: (id: string, v: number) => calls.push(`${id}@${v}`) };
    const returns = (engine as unknown as { returnNodes: Map<string, unknown> }).returnNodes;
    returns.set("r1", { fx: { runtimes: new Map([["fx1", rt]]) } });

    engine.scheduleDeviceAutomation("r1", "fx", "fx1", "global.mix", [{ tick: 0, value: 25 }], () => 0);
    expect(calls).toEqual(["global.mix@25"]);
  });

  it("applyAutomation drives fxParam and modAutoGain on group buses", () => {
    const engine = new AudioEngine();
    const gainCalls: string[] = [];
    const rt = { setParameter: (id: string, v: number) => gainCalls.push(`${id}=${v}`) };
    const groups = (engine as unknown as { groupNodes: Map<string, unknown> }).groupNodes;
    groups.set("g1", {
      fx: { runtimes: new Map([["fx1", rt]]) },
      modAutoGain: { gain: { setTargetAtTime: (v: number, t: number) => gainCalls.push(`g:${v}@${t}`) } },
      modAutoPan: { pan: { setTargetAtTime: () => {} } },
    });
    (engine as unknown as { ctx: unknown }).ctx = { currentTime: 10 };
    (engine as unknown as { doc: unknown }).doc = {
      automation: [
        {
          target: { kind: "fxParam", trackId: "g1", fxId: "fx1", paramId: "global.mix" },
          points: [{ tick: 0, value: 42 }],
        },
        {
          target: { kind: "trackGain", trackId: "g1" },
          points: [{ tick: 0, value: 0.5 }],
        },
      ],
    };
    engine.applyAutomation(0, 480, (t) => t, 0);
    expect(gainCalls).toContain("global.mix=42");
    expect(gainCalls.some((c) => c.startsWith("g:0.5@"))).toBe(true);
  });
});

// ── 12. Deep-parameter automation lanes (roadmap phase U1) ────

describe("automation lanes: Ultina deep params clamp at the command boundary", () => {
  interface SimpleLane {
    id: string;
    target: { kind: string; trackId: string; fxId?: string; paramId?: string };
    points: { tick: number; value: number }[];
  }

  function withUltinaLane(paramId: string) {
    const base = createDefaultProject();
    const inst = firstInstrumentTrack(base);
    const withFx = addEffect(base, inst.id, "ultina").execute(base);
    const fx = findEffect(firstInstrumentTrack(withFx), "ultina");
    const doc = addAutomationLane(withFx, {
      kind: "fxParam",
      trackId: inst.id,
      fxId: fx.id,
      paramId,
    }).execute(withFx);
    const lane = doc.automation[doc.automation.length - 1] as SimpleLane;
    return { doc, laneId: lane.id };
  }

  it("addAutomationPoint clamps an out-of-range deep value (999 → 18)", () => {
    const { doc, laneId } = withUltinaLane("eq.band3.gainDb");
    const next = addAutomationPoint(doc, laneId, 240, 999).execute(doc);
    const lane = next.automation.find((l) => l.id === laneId)!;
    expect(lane.points.at(-1)!.value).toBe(18);
  });

  it("moveAutomationPoint clamps a dragged deep value", () => {
    const { doc, laneId } = withUltinaLane("comp.thresholdDb");
    const seeded = addAutomationPoint(doc, laneId, 0, -20).execute(doc);
    const moved = moveAutomationPoint(seeded, laneId, 0, { tick: 240, value: -999 }).execute(seeded);
    const lane = moved.automation.find((l) => l.id === laneId)!;
    expect(lane.points[0].value).toBe(-60);
  });

  it("a non-finite deep value falls back to the schema default", () => {
    const { doc, laneId } = withUltinaLane("comp.thresholdDb");
    const next = addAutomationPoint(doc, laneId, 0, Number.NaN).execute(doc);
    const lane = next.automation.find((l) => l.id === laneId)!;
    expect(lane.points.at(-1)!.value).toBe(-20);
  });

  it("scene automation points clamp through the same boundary", () => {
    const base = createDefaultProject();
    const inst = firstInstrumentTrack(base);
    const withFx = addEffect(base, inst.id, "ultina").execute(base);
    const fx = findEffect(firstInstrumentTrack(withFx), "ultina");
    const withLane = addSceneAutomation(withFx, withFx.scenes[0].id, {
      kind: "fxParam",
      trackId: inst.id,
      fxId: fx.id,
      paramId: "eq.band0.q",
    }).execute(withFx);
    const sceneLane = withLane.sceneAutomation[withLane.sceneAutomation.length - 1];
    const next = addSceneAutomationPoint(withLane, sceneLane.id, 96, 999).execute(withLane);
    const after = next.sceneAutomation.find((l) => l.id === sceneLane.id)!;
    expect(after.points.at(-1)!.value).toBe(24);
  });

  it("non-Ultina fx params clamp through the registry def", () => {
    const base = createDefaultProject();
    const inst = firstInstrumentTrack(base);
    const withFx = addEffect(base, inst.id, "limiter").execute(base);
    const fx = findEffect(firstInstrumentTrack(withFx), "limiter");
    const doc = addAutomationLane(withFx, {
      kind: "fxParam",
      trackId: inst.id,
      fxId: fx.id,
      paramId: "threshold",
    }).execute(withFx);
    const lane = doc.automation[doc.automation.length - 1] as SimpleLane;
    const next = addAutomationPoint(doc, lane.id, 0, 999).execute(doc);
    const after = next.automation.find((l) => l.id === lane.id)!;
    expect(after.points.at(-1)!.value).toBe(0); // limiter threshold range is −24..0
  });

  it("trackGain lanes keep their own 0..1.5 domain (no fx clamp)", () => {
    const base = createDefaultProject();
    const trackId = base.tracks[0].id;
    const doc = addAutomationLane(base, { kind: "trackGain", trackId }).execute(base);
    const lane = doc.automation[doc.automation.length - 1] as SimpleLane;
    const next = addAutomationPoint(doc, lane.id, 0, 1.2).execute(doc);
    const after = next.automation.find((l) => l.id === lane.id)!;
    expect(after.points.at(-1)!.value).toBe(1.2);
  });
});

describe("ultinaAutomation: lane surface helpers", () => {
  it("exposes only automatable schema params with module grouping", () => {
    const params = ultinaLaneParams();
    expect(params.length).toBeGreaterThan(100);
    expect(params.every((p) => p.id.includes("."))).toBe(true);
    expect(params.some((p) => p.id === "comp.thresholdDb")).toBe(true);
    expect(params.some((p) => p.id === "eq.band3.gainDb")).toBe(true);
    // Non-automatable params (learn toggles, A/B slot) never surface.
    expect(params.some((p) => p.id === "global.abSlot")).toBe(false);
    expect(params.some((p) => p.id === "eq.learnActive")).toBe(false);
  });

  it("laneRange matches the vendored schema and formats dB", () => {
    const range = ultinaLaneRange("eq.band3.gainDb");
    expect(range).not.toBeNull();
    expect(range!.min).toBe(-18);
    expect(range!.max).toBe(18);
    expect(range!.format(-6)).toBe("-6.0 dB");
    expect(ultinaLaneRange("not.a.param")).toBeNull();
  });

  it("option groups are module-grouped and filterable", () => {
    const all = ultinaOptionGroups("fx1", "");
    const modules = all.map((g) => g.module);
    expect(modules).toContain("Ultina · Comp".replace("Ultina · ", ""));
    const compGroup = all.find((g) => g.options.some((o) => o.value === "fxParam:fx1:comp.thresholdDb"));
    expect(compGroup).toBeDefined();
    const filtered = ultinaOptionGroups("fx1", "threshold");
    const values = filtered.flatMap((g) => g.options.map((o) => o.value));
    expect(values).toContain("fxParam:fx1:comp.thresholdDb");
    expect(values).not.toContain("fxParam:fx1:comp.attackMs");
  });

  it("formats the common units the lane readout shows", () => {
    expect(formatUltinaParam("hz", 2500)).toBe("2.5 kHz");
    expect(formatUltinaParam("ms", 100)).toBe("100 ms");
    expect(formatUltinaParam("percent", 50)).toBe("50%");
    expect(formatUltinaParam("ratio", 3)).toBe("3.00:1");
    expect(formatUltinaParam("boolean", 1)).toBe("ON");
    expect(formatUltinaParam("db", Number.NaN)).toBe("–");
  });
});

// ── 13. Live drag preview plumbing (roadmap phase U2) ─────────

describe("AudioEngine.previewFxParam: fire-and-forget runtime write", () => {
  it("reaches the track runtime without touching the document", () => {
    const engine = new AudioEngine();
    const calls: string[] = [];
    const rt = { setParameter: (id: string, v: number) => calls.push(`${id}=${v}`) };
    const tracks = (engine as unknown as { trackNodes: Map<string, unknown> }).trackNodes;
    tracks.set("t1", { fx: { runtimes: new Map([["fx1", rt]]) } });

    engine.previewFxParam("t1", "fx1", "comp.thresholdDb", -18.5);
    expect(calls).toEqual(["comp.thresholdDb=-18.5"]);
  });

  it("resolves group and return chains like the meters accessor", () => {
    const engine = new AudioEngine();
    const calls: string[] = [];
    const rt = { setParameter: (id: string) => calls.push(id) };
    (engine as unknown as { groupNodes: Map<string, unknown> }).groupNodes.set("g1", {
      fx: { runtimes: new Map([["fx1", rt]]) },
    });
    const returns = (engine as unknown as { returnNodes: Map<string, unknown> }).returnNodes;
    returns.set("r1", { fx: { runtimes: new Map([["fx1", rt]]) } });

    engine.previewFxParam("g1", "fx1", "global.mix", 50);
    engine.previewFxParam("r1", "fx1", "global.mix", 60);
    expect(calls).toEqual(["global.mix", "global.mix"]);
  });

  it("is a silent no-op when no runtime exists (panel open before chain build)", () => {
    const engine = new AudioEngine();
    expect(() => engine.previewFxParam("missing", "fx1", "global.mix", 1)).not.toThrow();
  });
});

// ── 14. Latency-compensated mix & HQ oversampling (roadmap phase U3) ──

describe("U3: hybrid crossover mix is latency-compensated", () => {
  /** Comp configured: 2 bands, hybrid crossover, ratio 1 (zero gain
   *  reduction → wet path = delayed input exactly), params per test. */
  function makeHybridComp(qualityMode: number): UltinaProcessor {
    const proc = makeProcessor();
    enableInGraph(proc, "comp");
    proc.setParameters({
      "comp.bandCount": 2,
      "comp.crossoverMode": 1, // hybrid FIR — 31-sample wet latency
      "comp.ratio": 1, // slope 0 → no gain reduction
      "comp.thresholdDb": 0,
      "comp.makeupDb": 0,
      "global.qualityMode": qualityMode,
    });
    return proc;
  }

  it("delta listen on a unity hybrid comp reads ~0 (no delayed-copy echo)", () => {
    const proc = makeHybridComp(1);
    proc.setParameter("comp.delta", 1);
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    let tailSumSq = 0;
    let tailN = 0;
    const blocks = 120;
    for (let b = 0; b < blocks; b++) {
      sine(chans, b, 440, 0.3);
      proc.process(chans, BLOCK);
      if (b >= blocks - 16) {
        for (let i = 0; i < BLOCK; i++) {
          tailSumSq += chans[0][i] * chans[0][i];
          tailN++;
        }
      }
    }
    // Pre-fix: delta = delayedWet − undelayedDry = the 31-sample difference
    // of a 440 Hz sine (loud). Post-fix the delta is numerically ~0.
    const tailRms = Math.sqrt(tailSumSq / tailN);
    expect(tailRms).toBeLessThan(1e-5);
  });

  it("mix = 0 through a unity hybrid comp returns the input delayed by the reported latency", () => {
    const proc = makeHybridComp(1);
    proc.setParameter("comp.mix", 0);
    // The hybrid crossover (and its latency) materializes on the first
    // processed block — warm up before reading it.
    const warm = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    for (let b = 0; b < 8; b++) {
      sine(warm, b, 997, 0.3);
      proc.process(warm, BLOCK);
    }
    const latency = proc.getLatencySamples();
    expect(latency).toBe(31); // 63-tap FIR → (63−1)/2

    const total = 3 * SR;
    const input = new Float32Array(total);
    for (let i = 0; i < total; i++) input[i] = 0.3 * Math.sin((2 * Math.PI * 997 * i) / SR);
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const out = new Float32Array(total);
    for (let off = 0; off < total; off += BLOCK) {
      chans[0].set(input.subarray(off, off + BLOCK));
      chans[1].set(input.subarray(off, off + BLOCK));
      proc.process(chans, BLOCK);
      out.set(chans[0].subarray(0, BLOCK), off);
    }
    // out[n] must equal in[n − 31] once the FIR settles.
    let maxErr = 0;
    for (let n = latency + 4096; n < total; n++) {
      maxErr = Math.max(maxErr, Math.abs(out[n] - input[n - latency]));
    }
    expect(maxErr).toBeLessThan(1e-4);
  });
});

describe("U3: HQ quality mode oversamples the comp gain path", () => {
  it("reports +4 samples latency and stays finite under deep compression", () => {
    const proc = makeProcessor();
    enableInGraph(proc, "comp");
    proc.setParameters({
      "comp.bandCount": 2,
      "comp.crossoverMode": 1,
      "comp.ratio": 20,
      "comp.thresholdDb": -40,
      "comp.attackMs": 0.5,
      "global.qualityMode": 2, // hq → gain-path oversampling
    });
    const inLat = proc.getLatencySamples();
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    let nonFinite = 0;
    for (let b = 0; b < 120; b++) {
      sine(chans, b, 440, 0.4);
      proc.process(chans, BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        if (!Number.isFinite(chans[0][i])) nonFinite++;
      }
    }
    expect(nonFinite).toBe(0);
    // The worklet re-posts latency on its meter cadence; the raw accessor
    // must already include the oversampler's 4 samples.
    const outLat = proc.getLatencySamples();
    expect(outLat).toBe(31 + 4);
    void inLat;
  });

  it("hq + all modules under deep settings stays far inside the audio budget", () => {
    // Load-stable gate (fxeq-performance-gates precedent): the old absolute
    // `perBlockMs < 5` bound assumed an idle CI machine — under parallel
    // load the same DSP measured 10.5 ms/block and flaked. A ratio against
    // a passthrough baseline measured in the SAME process normalizes machine
    // speed; best-of-3 run medians ride out bursty scheduler noise.
    // Calibration (2026-09-12): idle ratio ≈ 18.5× (63 µs / 1177 µs);
    // under 6-way CPU oversubscription ≈ 34.7× (67 µs / 2326 µs — longer
    // blocks are preempted more, so the ratio inflates ~1.9×; budget 40
    // clears that while catching a ≥2.2× loaded-path regression on an idle
    // machine — stricter than the "10×+" intent of the old absolute gate.
    const measure = (loaded: boolean): number => {
      const proc = makeProcessor();
      if (loaded) {
        for (const m of ["eq", "comp", "gate", "exciter", "transient", "clipper", "density", "sculptor", "unmask"]) {
          enableInGraph(proc, m);
        }
        proc.setParameters({ "global.qualityMode": 2 });
      }
      const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      const fill = (b: number) => {
        for (let i = 0; i < BLOCK; i++) {
          const t = (b * BLOCK + i) / SR;
          const v = 0.4 * Math.sin(2 * Math.PI * 440 * t);
          chans[0][i] = v;
          chans[1][i] = v;
        }
      };
      for (let b = 0; b < 200; b++) {
        fill(b);
        proc.process(chans, BLOCK);
      }
      let bestMedianUs = Infinity;
      for (let run = 0; run < 3; run++) {
        const perBlockUs: number[] = [];
        for (let b = 0; b < 300; b++) {
          fill(b);
          const t0 = performance.now();
          proc.process(chans, BLOCK);
          perBlockUs.push((performance.now() - t0) * 1000);
        }
        perBlockUs.sort((a, b) => a - b);
        const median = perBlockUs[perBlockUs.length >> 1];
        if (median < bestMedianUs) bestMedianUs = median;
      }
      return bestMedianUs;
    };

    const passthroughUs = measure(false);
    const loadedUs = measure(true);
    const ratio = loadedUs / passthroughUs;
    // Audio budget at 48 kHz is ~2.9 ms per 128-frame block; the ratio form
    // keeps that intent without depending on machine load.
    expect(
      ratio,
      `full-graph hq block is ${ratio.toFixed(1)}× passthrough (budget 40×) — ` +
        `passthrough=${passthroughUs.toFixed(0)}µs loaded=${loadedUs.toFixed(0)}µs/block`,
    ).toBeLessThan(40);
  });
});

// ── 15. Phase module latency semantics (roadmap phase U4) ────

describe("U4: phase module latency + per-channel compensation", () => {
  function makePhase(): UltinaProcessor {
    const proc = makeProcessor();
    enableInGraph(proc, "phase");
    return proc;
  }

  it("reports scalar latency: 0 for a pure one-sided shift, +1 with rotation", () => {
    const proc = makePhase();
    proc.setParameters({ "phase.timeShiftMs": 5, "phase.rotationDegrees": 0 });
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    for (let b = 0; b < 8; b++) {
      sine(chans, b, 997, 0.3);
      proc.process(chans, BLOCK);
    }
    // One-sided shift: the common (host-compensable) part is 0 — the offset
    // is the creative feature and is NOT transport latency.
    expect(proc.getLatencySamples()).toBe(0);

    proc.setParameter("phase.rotationDegrees", 45);
    for (let b = 0; b < 4; b++) {
      sine(chans, b, 997, 0.3);
      proc.process(chans, BLOCK);
    }
    // All-pass group delay is 1 sample while a rotation is active.
    expect(proc.getLatencySamples()).toBe(1);
  });

  it("rotation 0 adds no degenerate z^-1 delay (output is the pure shifted input)", () => {
    const proc = makePhase();
    proc.setParameters({
      "phase.timeShiftMs": 2, // → 96 samples @ 48 kHz, shift applied to L
      "phase.rotationDegrees": 0,
      "phase.mix": 100,
    });
    const shiftSamples = Math.round((2 * SR) / 1000);
    const total = SR;
    const input = new Float32Array(total);
    // 4 kHz: the module's 20 Hz DC blocker is transparent this far above its
    // cutoff, so the output can be compared against the raw input.
    for (let i = 0; i < total; i++) input[i] = 0.4 * Math.sin((2 * Math.PI * 4000 * i) / SR);
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const outL = new Float32Array(total);
    const outR = new Float32Array(total);
    for (let off = 0; off < total; off += BLOCK) {
      chans[0].set(input.subarray(off, off + BLOCK));
      chans[1].set(input.subarray(off, off + BLOCK));
      proc.process(chans, BLOCK);
      outL.set(chans[0].subarray(0, BLOCK), off);
      outR.set(chans[1].subarray(0, BLOCK), off);
    }
    // L is the shifted copy of the input (DC blocker ≈ identity on AC);
    // R must be the UNDELAYED input — proof the degenerate z⁻¹ is gone
    // (pre-fix R carried a stray 1-sample delay) and no all-pass colors.
    let maxErrR = 0;
    for (let n = 4096; n < total; n++) maxErrR = Math.max(maxErrR, Math.abs(outR[n] - input[n]));
    expect(maxErrR).toBeLessThan(0.01);
    let maxErrL = 0;
    for (let n = shiftSamples + 4096; n < total; n++) {
      maxErrL = Math.max(maxErrL, Math.abs(outL[n] - input[n - shiftSamples]));
    }
    expect(maxErrL).toBeLessThan(0.01);
  });

  it("delta listen on a pure time shift reads ~0 on BOTH channels (per-channel compensation)", () => {
    const proc = makePhase();
    proc.setParameters({
      "phase.timeShiftMs": 3,
      "phase.mix": 100,
      "phase.delta": 1,
      "phase.rotationDegrees": 0,
    });
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    let tailSumSq = 0;
    let tailN = 0;
    const blocks = 150;
    // 4 kHz keeps the DC blocker's own wet-vs-dry contribution negligible;
    // the pre-fix delayed-copy echo at this frequency and 3 ms shift is
    // ~0.25 RMS, so the 0.02 bound cleanly separates the two regimes.
    for (let b = 0; b < blocks; b++) {
      sine(chans, b, 4000, 0.3);
      proc.process(chans, BLOCK);
      if (b >= blocks - 16) {
        for (let i = 0; i < BLOCK; i++) {
          tailSumSq += chans[0][i] * chans[0][i] + chans[1][i] * chans[1][i];
          tailN += 2;
        }
      }
    }
    // Pre-fix: delta = delayedWet(shifted L) − undelayedDry → a loud 3 ms
    // difference tone on the shifted channel. Post-fix the dry copy is
    // delayed per channel, so the delta is numerically ~0 everywhere.
    expect(Math.sqrt(tailSumSq / tailN)).toBeLessThan(0.02);
  });

  it("delta compensation remains coherent at a 10 ms shift", () => {
    const proc = makePhase();
    proc.setParameters({
      "phase.timeShiftMs": 10,
      "phase.mix": 100,
      "phase.delta": 1,
      "phase.rotationDegrees": 0,
    });
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    let sumSq = 0;
    let n = 0;
    const blocks = 180;
    for (let b = 0; b < blocks; b++) {
      sine(chans, b, 4000, 0.3);
      proc.process(chans, BLOCK);
      if (b >= blocks - 16) {
        for (let i = 0; i < BLOCK; i++) {
          sumSq += chans[0][i] * chans[0][i] + chans[1][i] * chans[1][i];
          n += 2;
        }
      }
    }
    // The old maxBlockSize+64 ring clamped the dry copy to 192 samples;
    // 10 ms is 480 samples at 48 kHz and exposed a loud delayed-copy comb.
    expect(Math.sqrt(sumSq / n)).toBeLessThan(0.02);
  });
});

// ── 16. Module re-prepare crossover restoration ─────────────

describe("multiband modules: re-prepare restores crossover coefficients", () => {
  it("re-preparing comp does not turn a 2-band unity chain into +6 dB", () => {
    const proc = makeProcessor();
    enableInGraph(proc, "comp");
    proc.setParameters({
      "comp.bandCount": 2,
      "comp.crossoverHz1": 1000,
      "comp.band0.thresholdDb": 0,
      "comp.band1.thresholdDb": 0,
      "comp.ratio": 1,
      "comp.mix": 100,
    });
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    for (let b = 0; b < 24; b++) {
      sine(chans, b, 440, 0.1);
      proc.process(chans, BLOCK);
    }

    // This is the lifecycle used by a host after a sample-rate/block-size
    // change. The parameter caches must not suppress the crossover redesign.
    proc.prepare({ sampleRate: SR, maxBlockSize: BLOCK, channelCount: 2, qualityMode: 1 });
    let sumSq = 0;
    let n = 0;
    for (let b = 0; b < 12; b++) {
      sine(chans, b, 440, 0.1);
      proc.process(chans, BLOCK);
      if (b >= 4) {
        for (let i = 0; i < BLOCK; i++) {
          sumSq += chans[0][i] * chans[0][i];
          n++;
        }
      }
    }
    const outRms = Math.sqrt(sumSq / n);
    expect(outRms).toBeLessThan(0.12);
    expect(outRms).toBeGreaterThan(0.05);
  });
});

// ── 16. Exciter Tone functional + LUFS stale marking (post-publish prep) ──

describe("U-P: exciter Tone knob is functional and rate/OS invariant", () => {
  /** Tilt = dB difference between the module's response at 6 kHz vs 80 Hz.
   *  Runs the exciter with all saturation amounts at 0 — pure tone section. */
  function tiltDb(sampleRate: number, oversampling: number): number {
    const proc = new UltinaProcessor();
    registerCoreModules(proc);
    proc.prepare({ sampleRate, maxBlockSize: BLOCK, channelCount: 2, qualityMode: 1 });
    enableInGraph(proc, "exciter");
    proc.setParameters({
      "exciter.tube": 0,
      "exciter.warm": 0,
      "exciter.tape": 0,
      "exciter.retro": 0,
      "exciter.overdrive": 0,
      "exciter.scream": 0,
      "exciter.clipper": 0,
      "exciter.scratch": 0,
      "exciter.toneSlider": 100, // +6 dB high shelf, corner 200 Hz
      "exciter.oversampling": oversampling,
      "exciter.mix": 100,
      "exciter.bandCount": 1,
    });
    const measure = (freq: number): number => {
      const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      const blocks = 160;
      let inSumSq = 0;
      let outSumSq = 0;
      let n = 0;
      for (let b = 0; b < blocks; b++) {
        for (let i = 0; i < BLOCK; i++) {
          const t = (b * BLOCK + i) / sampleRate;
          const v = 0.25 * Math.sin(2 * Math.PI * freq * t);
          chans[0][i] = v;
          chans[1][i] = v;
        }
        proc.process(chans, BLOCK);
        if (b >= 64) {
          for (let i = 0; i < BLOCK; i++) {
            inSumSq += chans[0][i] * chans[0][i];
            n++;
          }
          for (let i = 0; i < BLOCK; i++) outSumSq += chans[1][i] * chans[1][i];
        }
      }
      void inSumSq;
      return 20 * Math.log10((Math.sqrt(outSumSq / n) / 0.25) * Math.SQRT2);
    };
    return measure(6000) - measure(80);
  }

  it("positive Tone tilts the high band up (knob is functional, not a level trim)", () => {
    const tilt = tiltDb(SR, 0);
    // Post-fix: 6 kHz sits far above the 200 Hz corner → ~+6 dB shelf minus
    // the corner-summed low remainder; 80 Hz sits at/below it → ~0 dB.
    // Pre-fix the crossover was transparent: tilt ≈ 0 dB at both.
    expect(tilt).toBeGreaterThan(3);
  });

  it("the tilt is identical across sample rates (44.1 vs 96 kHz)", () => {
    const tilt48 = tiltDb(48000, 0);
    const tilt96 = tiltDb(96000, 0);
    expect(Math.abs(tilt48 - tilt96)).toBeLessThan(0.5);
  });

  it("the tilt is identical with oversampling on vs off", () => {
    const tiltOff = tiltDb(SR, 0);
    const tiltOn = tiltDb(SR, 1);
    expect(Math.abs(tiltOff - tiltOn)).toBeLessThan(0.5);
  });
});

describe("U-P: LUFS meter reports silence after a long feed gap", () => {
  it("getMeters shows -70 until the short-term window turns over", () => {
    const proc = makeProcessor();
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    // Fill the meter: 4 s of signal with meters on.
    proc.setMetersEnabled(true);
    for (let b = 0; b < Math.round((4 * SR) / BLOCK); b++) {
      sine(chans, b, 997, 0.3);
      proc.process(chans, BLOCK);
    }
    const live = proc.getMeters().global.outputShortTermLufs;
    expect(live).toBeGreaterThan(-40); // real reading

    // Gap: 4 s processed with meters off and gain-match off (> 3 s window).
    proc.setMetersEnabled(false);
    for (let b = 0; b < Math.round((4 * SR) / BLOCK); b++) {
      sine(chans, b, 997, 0.3);
      proc.process(chans, BLOCK);
    }
    // Pre-fix the panel would show a plausible but STALE number on reopen.
    expect(proc.getMeters().global.outputShortTermLufs).toBe(-70);

    // Re-enable: still -70 until the 3 s window turns over with fresh data.
    proc.setMetersEnabled(true);
    for (let b = 0; b < Math.round((0.5 * SR) / BLOCK); b++) {
      sine(chans, b, 997, 0.3);
      proc.process(chans, BLOCK);
    }
    expect(proc.getMeters().global.outputShortTermLufs).toBe(-70);

    // After a full window of fresh blocks the reading returns.
    for (let b = 0; b < Math.round((3 * SR) / BLOCK); b++) {
      sine(chans, b, 997, 0.3);
      proc.process(chans, BLOCK);
    }
    expect(proc.getMeters().global.outputShortTermLufs).toBeGreaterThan(-40);
  });
});
