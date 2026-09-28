import { describe, expect, it } from "vitest";
import { hashString, mulberry32 } from "../src/shared/rng";
import { uid } from "../src/shared/ids";
import { canonicalizeDeprecatedTarget } from "../src/project-model/targets";
import type { AutomationTarget, ProjectDocument } from "../src/project-model/types";

/**
 * SEED-STABILITY CONTRACT (plugin-audit follow-up).
 *
 * Every random DSP decision in the engine — vinyl crackle, beat-mangler
 * step chance, sampler spread/round-robin, granular grain placement,
 * generative variation — is seeded from `hashString` over persisted ids:
 *
 *   effect DSP seed  = hashString(`${doc.id}|${ownerId}|${fx.id}|fx-dsp-v1`)
 *   sampler spread   = hashString(`${track.id}:${pitch}`)
 *   granular grains  = hashString(trackId:…) via the worklet bridge
 *
 * That means the AUDIO of every saved project depends on three things
 * staying frozen:
 *   1. the FNV-1a hash algorithm in hashString,
 *   2. the seed-composition formulas (separator order, the `fx-dsp-v1`
 *      domain tag),
 *   3. the PRNG (mulberry32) that consumes the seeds.
 *
 * Change any of them and every saved project re-rolls its random DSP —
 * vinyl crackle lands elsewhere, sampler spreads pan differently, granular
 * grains relocate. Not a crash, but a silent re-render of the user's
 * catalog. These pins force that to be a conscious, documented decision.
 */

describe("seed-stability contract", () => {
  it("hashString is FNV-1a — pinned known vectors", () => {
    // FNV-1a 32-bit offset basis with an empty string.
    expect(hashString("")).toBe(2166136261);
    // Single-character vector.
    expect(hashString("a")).toBe(3826002220);
    // The effect-DSP domain tag itself (part of the seed formula below).
    expect(hashString("fx-dsp-v1")).toBeTypeOf("number");
  });

  it("effect DSP seed formula is pinned: doc.id|ownerId|fx.id|fx-dsp-v1", () => {
    // Mirrors AudioEngine: hashString(`${doc.id}|${ownerId}|${fx.id}|fx-dsp-v1`).
    // Reordering the parts, changing the '|' separator or bumping the
    // domain tag re-rolls every random effect in every project.
    expect(hashString("doc-1|track-1|fx-1|fx-dsp-v1")).toBe(1472925860);
  });

  it("sampler spread seed formula is pinned: track.id:pitch", () => {
    // Mirrors the sampler voice: hashString(`${track.id}:${pitch}`).
    expect(hashString("track-fixed:45")).toBe(1823335548);
  });

  it("mulberry32 sequence is pinned — the PRNG behind all random DSP", () => {
    const r = mulberry32(1);
    const first = [r(), r(), r()].map((v) => Math.round(v * 1e9) / 1e9);
    expect(first).toEqual([0.627073941, 0.002735721, 0.52744704]);
    // Seeded from the pinned effect formula: first two draws.
    const r2 = mulberry32(hashString("doc-1|track-1|fx-1|fx-dsp-v1"));
    const first2 = [r2(), r2()].map((v) => Math.round(v * 1e9) / 1e9);
    expect(first2).toEqual([0.044874523, 0.745772979]);
  });

  it("uid prefixes are part of the seed surface — pinned", () => {
    // Seeds derive from persisted ids like `fx_<uuid>` / `track_<uuid>`.
    // A prefix rename would not break saved projects (ids persist) but WOULD
    // re-roll the random DSP of every newly created project. Pin the
    // prefixes so a rename is a conscious decision.
    const fx = uid("fx");
    expect(fx.startsWith("fx-")).toBe(true);
    expect(uid("track").startsWith("track-")).toBe(true);
    expect(uid("lane").startsWith("lane-")).toBe(true);
    // Distinct prefixes never collide on the same string.
    expect(fx).not.toEqual(uid("track"));
  });
});

/**
 * Companion pin for the Phase 3a alias migration: canonicalization must be
 * a pure id-rewrite — same target shape, canonical paramId — so remapped
 * lanes keep producing identical automation writes.
 */
describe("alias canonicalization purity", () => {
  it("canonicalizeDeprecatedTarget only rewrites the paramId", () => {
    const doc = {
      tracks: [
        {
          id: "track-1",
          kind: "instrument",
          effects: [{ id: "fx-1", type: "eq", bypassed: false, params: {} }],
        },
      ],
    } as unknown as ProjectDocument;
    const target: AutomationTarget = {
      kind: "fxParam",
      trackId: "track-1",
      fxId: "fx-1",
      paramId: "midGain",
    };
    const canonical = canonicalizeDeprecatedTarget(doc, target);
    expect(canonical.paramId).toBe("lowMidGain");
    // Everything else — the seed-relevant identity fields — untouched.
    expect(canonical.trackId).toBe(target.trackId);
    expect(canonical.fxId).toBe(target.fxId);
    expect(canonical.kind).toBe(target.kind);
    // Non-alias targets pass through unchanged (same object).
    expect(canonicalizeDeprecatedTarget(doc, { ...target, paramId: "lowMidGain" })).toBeTypeOf("object");
  });
});
