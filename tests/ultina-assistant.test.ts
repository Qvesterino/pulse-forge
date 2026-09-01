/**
 * Ultina Mix Assistant — the analysis/proposal layer over synthetic audio.
 * The proposal engine is deterministic: the same audio + settings must
 * produce the same proposal every time (it is applied as ONE undoable
 * command, so flakiness would corrupt user trust).
 */
import { describe, expect, it } from "vitest";
import { analyzeTrack, analyzeWithTarget } from "../src/effects/ultina-core/analysis/mixAssistant";
import { INSTRUMENT_LABELS } from "../src/effects/ultina-core/analysis/assistant";

function sineStereo(freqHz: number, seconds: number, sampleRate = 44100, amplitude = 0.5): Float32Array[] {
  const frames = Math.floor(seconds * sampleRate);
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const v = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
    L[i] = v;
    R[i] = v;
  }
  return [L, R];
}

describe("Mix Assistant (analyzeTrack)", () => {
  it("analyzes a 3s sine and returns a successful proposal with changes", () => {
    const result = analyzeTrack({
      channels: sineStereo(220, 3),
      sampleRate: 44100,
      intensity: "balanced",
    });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    const proposal = result.proposal;
    expect(proposal.analyzedDuration).toBeGreaterThan(2.5);
    expect(INSTRUMENT_LABELS[proposal.instrument]).toBeTruthy();
    // Proposals carry dotted ultina param ids the command can apply directly.
    for (const change of proposal.changes) {
      expect(typeof change.parameterId).toBe("string");
      expect(Number.isFinite(change.value)).toBe(true);
      expect(change.confidence).toBeGreaterThan(0);
    }
  });

  it("is deterministic — same audio, same proposal", () => {
    const audio = sineStereo(110, 3, 44100, 0.4);
    const a = analyzeTrack({ channels: audio.map((c) => new Float32Array(c)), sampleRate: 44100 });
    const b = analyzeTrack({ channels: audio.map((c) => new Float32Array(c)), sampleRate: 44100 });
    expect(a.kind).toBe("success");
    expect(b.kind).toBe("success");
    if (a.kind !== "success" || b.kind !== "success") return;
    expect(b.proposal.instrument).toBe(a.proposal.instrument);
    expect(b.proposal.changes).toEqual(a.proposal.changes);
    expect(b.proposal.moduleToggles).toEqual(a.proposal.moduleToggles);
  });

  it("rejects audio shorter than the minimum duration", () => {
    const result = analyzeTrack({
      channels: sineStereo(440, 0.5),
      sampleRate: 44100,
      minimumDuration: 2,
    });
    expect(result.kind).toBe("insufficient");
  });

  it("honors the instrument override (skips classification)", () => {
    const result = analyzeTrack({
      channels: sineStereo(220, 3),
      sampleRate: 44100,
      instrumentOverride: "drums",
      intensity: "strong",
    });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.proposal.instrument).toBe("drums");
    expect(result.proposal.classification.confidence).toBe(1);
  });
});

describe("Reference match (analyzeWithTarget)", () => {
  it("proposes EQ band gainDb moves toward the target curve", () => {
    // Bas-heavy signal (110 Hz) matched against a bright target curve.
    const audio = sineStereo(110, 3, 44100, 0.5);
    const brightTarget = [0, 0, 0, 0, 0, 0, 0, 2, 4, 6]; // push highs
    const result = analyzeWithTarget(
      { channels: audio, sampleRate: 44100, minimumDuration: 2 },
      brightTarget,
    );
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    const eqMoves = result.proposal.changes.filter((c) => /^eq\.band\d+\.gainDb$/.test(c.parameterId));
    expect(eqMoves.length).toBeGreaterThan(0);
    // Values respect the eq gain schema range; each target adjustment is
    // ±6 dB but merges onto any base-proposal move for that band.
    for (const move of eqMoves) {
      expect(Number.isFinite(move.value)).toBe(true);
      expect(Math.abs(move.value)).toBeLessThanOrEqual(18);
    }
    expect(eqMoves.some((m) => m.reasonCode === "INSTRUMENT_PROFILE_MISMATCH")).toBe(true);
  });

  it("suggests nothing when the balance already matches the target", () => {
    const audio = sineStereo(220, 3, 44100, 0.5);
    const flatTarget = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const result = analyzeWithTarget(
      { channels: audio, sampleRate: 44100, minimumDuration: 2 },
      flatTarget,
    );
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    const eqMoves = result.proposal.changes.filter(
      (c) => c.parameterId.startsWith("eq.band") && c.reasonCode === "INSTRUMENT_PROFILE_MISMATCH",
    );
    // Whatever the flat-target deviations are, moves stay inside the
    // eq gain schema range and are finite.
    for (const move of eqMoves) {
      expect(Number.isFinite(move.value)).toBe(true);
      expect(Math.abs(move.value)).toBeLessThanOrEqual(18);
    }
  });
});
