import { describe, expect, it } from "vitest";
import { forgeCandidates, candidateSummary, defaultCandidate } from "../../src/tsar/forge-candidates";
import { goldenVoices, GOLDEN_VOICES, TSAR_GOLDEN_SAMPLE_RATE } from "./golden-voices";

/**
 * WAVE 3 — SAMPLE FORGE CANDIDATES (docs/FLAGSHIP-PLUGINS-IMPLEMENTATION-ROADMAP.md,
 * TSAR plan R3).
 *
 * The KPI contract:
 *  - ONE import, SEVERAL honest readings — the sampler always, the tuned
 *    reading only when the source has a root worth tuning to, the texture
 *    only when the source has a body to spread;
 *  - DETERMINISM: the same PCM gives the same candidates, in the same order;
 *  - HONESTY: an unpitched or unreadable source gets NO root, and a weak
 *    reading is never presented as a precise pitch;
 *  - every candidate carries its evidence and the reason for its engine.
 */

const SR = TSAR_GOLDEN_SAMPLE_RATE;

describe("forgeCandidates — one import, several readings", () => {
  it("always offers the playable reading for any audible source", () => {
    for (const voice of GOLDEN_VOICES) {
      const set = forgeCandidates(goldenVoices.get(voice.id)!, SR);
      expect(set.candidates.length, `${voice.id} must offer at least the playable reading`).toBeGreaterThan(0);
      const ids = set.candidates.map((c) => c.id);
      expect(ids, `${voice.id} must offer the sampler`).toContain("sampler");
    }
  });

  it("offers the tuned reading only for a source with a readable root", () => {
    for (const voice of GOLDEN_VOICES) {
      const set = forgeCandidates(goldenVoices.get(voice.id)!, SR);
      const tuned = set.candidates.find((c) => c.engine === "wavetable");
      if (voice.rootMidi === null) {
        // The unpitched source must NOT be offered a tuned reading: there
        // is no root to tune to, and promising one would be a lie.
        expect(tuned, `${voice.id} is unpitched — no tuned reading may be offered`).toBeUndefined();
      } else {
        expect(tuned, `${voice.id} has a root — the tuned reading must be offered`).toBeDefined();
        // The DRIFTING pad glides across ±1.5 semitones by design, so no
        // single instant is its "true" root and the detector's midpoint read
        // is a legitimate instant reading. The same tolerance the Forge's own
        // KPI test uses (tests/tsar/forge.test.ts:27) applies here.
        const tolerance = voice.id === "sustained-pad" ? 1 : 0;
        expect(Math.abs(tuned!.rootMidi! - voice.rootMidi!)).toBeLessThanOrEqual(tolerance);
      }
    }
  });

  it("offers the texture reading for sustained material", () => {
    const set = forgeCandidates(goldenVoices.get("sustained-pad")!, SR);
    expect(set.candidates.map((c) => c.id)).toContain("granular");
  });

  it("the readings are ordered by generality: playable first", () => {
    const set = forgeCandidates(goldenVoices.get("saw-c3")!, SR);
    expect(set.candidates[0]!.id).toBe("sampler");
    expect(defaultCandidate(set)!.id).toBe("sampler");
  });

  it("each reading differs in the params it writes, not only in its label", () => {
    const set = forgeCandidates(goldenVoices.get("sustained-pad")!, SR);
    const sampler = set.candidates.find((c) => c.engine === "sampler")!;
    const granular = set.candidates.find((c) => c.engine === "granular")!;
    expect(sampler.params.srcAEngine).toBe(0);
    expect(granular.params.srcAEngine).toBe(2);
    // The texture reading must actually configure the grain cloud, or the
    // engine switch alone would not change the sound.
    expect(granular.params.srcAGrainSize).toBeGreaterThan(0);
    expect(sampler.params.srcAGrainSize).toBeUndefined();
  });

  it("the tuned reading sets the root only when the reading is reliable", () => {
    const set = forgeCandidates(goldenVoices.get("saw-c3")!, SR);
    const tuned = set.candidates.find((c) => c.engine === "wavetable")!;
    expect(tuned.rootReliable).toBe(true);
    // saw-c3 does not drift, so here the reading must be exact.
    expect(tuned.params.srcARoot).toBe(voice_root("saw-c3"));
  });
});

describe("forgeCandidates — determinism", () => {
  it("the same PCM gives the same candidates, in the same order", () => {
    for (const voice of GOLDEN_VOICES) {
      const pcm = goldenVoices.get(voice.id)!;
      const a = forgeCandidates(pcm, SR);
      const b = forgeCandidates(pcm, SR);
      expect(a.candidates, `${voice.id} must be deterministic`).toEqual(b.candidates);
    }
  });

  it("the candidates do not depend on the slot they target", () => {
    const pcm = goldenVoices.get("saw-c3")!;
    const inA = forgeCandidates(pcm, SR, { slot: 0 });
    const inB = forgeCandidates(pcm, SR, { slot: 1 });
    expect(inA.candidates.map((c) => c.id)).toEqual(inB.candidates.map((c) => c.id));
    // ...but the params are written into the slot the candidate targets.
    expect(inA.candidates[0]!.params.srcAEngine).toBeDefined();
    expect(inA.candidates[0]!.params.srcBEngine).toBeUndefined();
    expect(inB.candidates[0]!.params.srcBEngine).toBeDefined();
    expect(inB.candidates[0]!.params.srcAEngine).toBeUndefined();
  });
});

describe("forgeCandidates — honesty", () => {
  it("an unreadable source gets no candidates and no invented root", () => {
    const set = forgeCandidates(new Float32Array(SR), SR);
    expect(set.candidates).toEqual([]);
    expect(set.plan.rootMidi).toBeNull();
    expect(set.warnings.join(" ")).toMatch(/silent/);
  });

  it("an empty buffer does not throw", () => {
    expect(() => forgeCandidates(new Float32Array(0), SR)).not.toThrow();
    expect(forgeCandidates(new Float32Array(0), SR).candidates).toEqual([]);
  });

  it("an unpitched source keeps its root null and warns", () => {
    const set = forgeCandidates(goldenVoices.get("noise-burst")!, SR);
    for (const candidate of set.candidates) {
      expect(candidate.rootMidi).toBeNull();
      expect(candidate.rootReliable).toBe(false);
      expect(candidate.params.srcARoot).toBeUndefined();
    }
  });

  it("a weak reading is never written as the patch root", () => {
    // A candidate whose root was read weakly must leave the root alone.
    const set = forgeCandidates(goldenVoices.get("noise-burst")!, SR);
    for (const candidate of set.candidates) {
      if (!candidate.rootReliable) {
        expect(candidate.params.srcARoot, "a weak root must not be written").toBeUndefined();
      }
    }
  });

  it("every candidate carries a reason and, when it has no root, a warning", () => {
    for (const voice of GOLDEN_VOICES) {
      const set = forgeCandidates(goldenVoices.get(voice.id)!, SR);
      for (const candidate of set.candidates) {
        expect(candidate.reason.length, `${voice.id}/${candidate.id} must explain itself`).toBeGreaterThan(0);
        if (candidate.rootMidi === null) {
          expect(candidate.warnings.length, `${voice.id}/${candidate.id} must warn about the missing root`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("the summary states a weak reading as weak", () => {
    const set = forgeCandidates(goldenVoices.get("noise-burst")!, SR);
    const summary = candidateSummary(set.candidates[0]!);
    expect(summary).toMatch(/no root detected/i);
  });
});

describe("forgeCandidates — the reading follows the measurement", () => {
  it("a one-shot is played with a decaying envelope, not a held one", () => {
    const set = forgeCandidates(goldenVoices.get("808-f1")!, SR);
    const sampler = set.candidates.find((c) => c.engine === "sampler")!;
    expect(sampler.sustained).toBe(false);
    expect(sampler.params.srcASus).toBe(0);
    expect(sampler.params.srcARel).toBeGreaterThan(0);
  });

  it("a sustained source is played with a hold", () => {
    const set = forgeCandidates(goldenVoices.get("saw-c3")!, SR);
    const sampler = set.candidates.find((c) => c.engine === "sampler")!;
    expect(sampler.sustained).toBe(true);
    expect(sampler.params.srcASus).toBeGreaterThan(0);
  });

  it("the grain size fits inside the source it reads", () => {
    const set = forgeCandidates(goldenVoices.get("sustained-pad")!, SR);
    const granular = set.candidates.find((c) => c.engine === "granular")!;
    const sourceSec = set.plan.envelope.attackSec + set.plan.envelope.releaseSec;
    expect(granular.params.srcAGrainSize!).toBeLessThanOrEqual(Math.max(0.005, sourceSec / 2) + 1e-9);
    expect(granular.params.srcAGrainSize!).toBeGreaterThan(0);
  });
});

/** The ground-truth root of a golden voice. */
function voice_root(id: string): number {
  const voice = GOLDEN_VOICES.find((v) => v.id === id)!;
  return voice.rootMidi!;
}
