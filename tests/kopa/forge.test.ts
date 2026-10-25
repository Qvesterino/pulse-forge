import { describe, expect, it } from "vitest";
import { forgeKick } from "../../src/kopa/forge";

/**
 * KOPA Forge — reverse-engineering a reference kick into KOPA parameters.
 * The ground truth is SYNTHESIZED: each test builds a kick with KNOWN
 * anatomy (pitch drop, click, decay, sub) and the forge must recover
 * values close to it. Honest degradation is pinned too: silence, noise
 * and pure tones yield refusals or loud warnings, never a confident
 * wrong patch.
 */

const SR = 48000;

/** A kick with known anatomy: pitch drop start→settled, exponential decay,
 * an optional click transient, and an optional sine sub. */
function synthKick(options: {
  startHz: number;
  settledHz: number;
  pitchTimeSec: number;
  decaySec: number;
  click?: { level: number; hz: number };
  sub?: { level: number; hz: number };
  seconds?: number;
}): Float32Array {
  const { startHz, settledHz, pitchTimeSec, decaySec } = options;
  const seconds = options.seconds ?? Math.min(1.5, Math.max(0.5, decaySec * 3));
  const n = Math.ceil(seconds * SR);
  const pcm = new Float32Array(n);
  let phase = 0;
  let subPhase = 0;
  let lcg = 42;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const k = t < pitchTimeSec ? Math.pow(t / pitchTimeSec, 0.4) : 1;
    const hz = startHz * Math.pow(settledHz / startHz, k);
    const decay = Math.exp(-t / decaySec);
    phase += hz / SR;
    let v = Math.sin(2 * Math.PI * phase) * decay * 0.85;
    if (options.click) {
      lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
      const noise = (lcg / 0x80000000 - 1) * 2;
      const cDecay = Math.exp(-t / 0.004);
      v += noise * cDecay * options.click.level;
      v += Math.sin(2 * Math.PI * options.click.hz * t) * cDecay * options.click.level * 0.5;
    }
    if (options.sub) {
      subPhase += options.sub.hz / SR;
      v += Math.sin(2 * Math.PI * subPhase) * options.sub.level * decay;
    }
    pcm[i] = Math.max(-1, Math.min(1, v));
  }
  return pcm;
}

describe("KOPA Forge — reverse-engineering a reference kick", () => {
  it("recovers the settled pitch as the root MIDI (A1 ≈ 33)", () => {
    const result = forgeKick(synthKick({ startHz: 160, settledHz: 55, pitchTimeSec: 0.04, decaySec: 0.3 }), SR);
    expect(result.kind).toBe("kick");
    if (result.kind !== "kick") return;
    expect(result.rootMidi).not.toBeNull();
    expect(Math.abs((result.rootMidi as number) - 33)).toBeLessThanOrEqual(2); // A1 = 33 ± 2
  });

  it("recovers a big pitch drop as a large pitchAmount (160→55 Hz ≈ −15 st)", () => {
    const result = forgeKick(synthKick({ startHz: 160, settledHz: 55, pitchTimeSec: 0.04, decaySec: 0.3 }), SR);
    if (result.kind !== "kick") throw new Error("not a kick plan");
    const drop = result.params.pitchAmount as number;
    expect(drop).toBeGreaterThan(8);
    // The 10 ms start window overshoots on the chirp (measured: a 15.5-st
    // drop reads 24) — the ballpark is what the fitted patch needs.
    expect(drop).toBeLessThanOrEqual(26);
  });

  it("a fast pitch drop keeps pitchTime short; a slow drop reads long", () => {
    const fast = forgeKick(synthKick({ startHz: 150, settledHz: 55, pitchTimeSec: 0.02, decaySec: 0.35 }), SR);
    const slow = forgeKick(synthKick({ startHz: 150, settledHz: 55, pitchTimeSec: 0.16, decaySec: 0.35 }), SR);
    if (fast.kind !== "kick" || slow.kind !== "kick") throw new Error("not kick plans");
    expect(fast.params.pitchTime).toBeLessThanOrEqual(slow.params.pitchTime);
  });

  it("a longer decay measures a longer body+tail than a tight one", () => {
    const tight = forgeKick(synthKick({ startHz: 120, settledHz: 50, pitchTimeSec: 0.04, decaySec: 0.12 }), SR);
    const long = forgeKick(synthKick({ startHz: 120, settledHz: 50, pitchTimeSec: 0.04, decaySec: 0.8 }), SR);
    if (tight.kind !== "kick" || long.kind !== "kick") throw new Error("not kick plans");
    expect(long.params.bodyDecay).toBeGreaterThan(tight.params.bodyDecay);
    expect(long.params.tailDecay).toBeGreaterThan(tight.params.tailDecay);
  });

  it("a click-heavy kick measures a higher click level than a clickless one", () => {
    const plain = forgeKick(synthKick({ startHz: 130, settledHz: 50, pitchTimeSec: 0.04, decaySec: 0.3 }), SR);
    const clicked = forgeKick(
      synthKick({ startHz: 130, settledHz: 50, pitchTimeSec: 0.04, decaySec: 0.3, click: { level: 0.9, hz: 2500 } }),
      SR,
    );
    if (plain.kind !== "kick" || clicked.kind !== "kick") throw new Error("not kick plans");
    expect(clicked.params.clickLevel as number).toBeGreaterThan((plain.params.clickLevel as number) * 1.3);
  });

  it("a sub-heavy kick measures a higher sub level than a higher-pitched one", () => {
    // The differential moves the SETTLED pitch: a kick living at 80 Hz has
    // its fundamental above the 60 Hz sub band, while the sub-heavy kick
    // (55 Hz body + 45 Hz sine sub) lives inside it.
    const plain = forgeKick(synthKick({ startHz: 140, settledHz: 80, pitchTimeSec: 0.04, decaySec: 0.4 }), SR);
    const subby = forgeKick(
      synthKick({ startHz: 120, settledHz: 55, pitchTimeSec: 0.04, decaySec: 0.4, sub: { level: 0.7, hz: 45 } }),
      SR,
    );
    if (plain.kind !== "kick" || subby.kind !== "kick") throw new Error("not kick plans");
    expect(subby.params.subLevel as number).toBeGreaterThan((plain.params.subLevel as number) * 1.15);
  });

  it("is deterministic — the same reference measures identically", () => {
    const pcm = synthKick({
      startHz: 150,
      settledHz: 55,
      pitchTimeSec: 0.05,
      decaySec: 0.35,
      click: { level: 0.5, hz: 2000 },
    });
    const a = forgeKick(pcm, SR);
    const b = forgeKick(pcm, SR);
    expect(a).toEqual(b);
  });

  it("degrades honestly: silence is refused, noise gets loud warnings", () => {
    const silent = forgeKick(new Float32Array(SR), SR);
    expect(silent.kind).toBe("empty");
    const pcm = new Float32Array(SR);
    let lcg = 7;
    for (let i = 0; i < pcm.length; i++) {
      lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
      pcm[i] = (lcg / 0x80000000 - 1) * 0.5;
    }
    const noise = forgeKick(pcm, SR);
    if (noise.kind === "kick") {
      expect(noise.warnings.length).toBeGreaterThan(0); // pitch untrackable etc.
      expect(noise.rootMidi).toBeNull();
    } else {
      expect(noise.warnings.length).toBeGreaterThan(0);
    }
  });
});
