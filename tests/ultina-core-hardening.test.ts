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
} from "../src/commands/commands.js";

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
    const result = analyzeWithTarget(
      { channels: audio, sampleRate: 44100, minimumDuration: 2 },
      [0, Number.NaN, 0, 0, 0, 0, 0, 0, 0, 0],
    );
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
    // Rack params keep their rack defaults/clamps.
    expect(after.params["global.mix"]).toBe(100);
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
      [{ moduleType: "comp", enabled: true }, { moduleType: "nope", enabled: true }],
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

    engine.scheduleDeviceAutomation(
      "r1",
      "fx",
      "fx1",
      "global.mix",
      [{ tick: 0, value: 25 }],
      () => 0,
    );
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
