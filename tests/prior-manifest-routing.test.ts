import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { acceptPriorManifest, type PriorKind } from "../src/ai/symbolic/prior-types";

/**
 * THE RUNTIME MUST ACCEPT THE MANIFESTS THE PRODUCT SHIPS.
 *
 * Two independent contract breaks lived on this boundary, and neither had a
 * test:
 *
 * 1. The dispatch that maps a manifest to its kind had NO arm for "drums-v3".
 *    The shipped drums v3 manifest (kind: "drums-v3", 60 features) fell
 *    through to the melodic branch, failed the melodic guard and was
 *    rejected — the drums v3 prior NEVER loaded, and the provider fell back
 *    to drums v2 without a word.
 *
 * 2. The melodic v1 manifest on disk has no `kind` field (the trainer only
 *    started writing one with v2). The drums v1 manifest has the same shape
 *    and got a legacy shim; the melodic one did not — so the runtime guard
 *    rejected the manifest the product ships, and the melodic prior degraded
 *    to the template melody on exactly the path that runs when the semantic
 *    model is unavailable.
 *
 * The test reads the REAL manifest files from public/models — the artifacts
 * the app fetches — and asks the runtime's own routing whether it accepts
 * them. It is deliberately about the ARTIFACT + the ROUTING, not about any
 * one function: a fix that added `kind` to the JSON would pass too.
 */

/** The manifest path the client fetches for each kind. */
const PATHS: Record<PriorKind, string> = {
  drums: "public/models/symbolic-prior-v1.manifest.json",
  "drums-v2": "public/models/symbolic-prior-v2.manifest.json",
  "drums-v3": "public/models/symbolic-prior-v3.manifest.json",
  melodic: "public/models/symbolic-melodic-v1.manifest.json",
  "melodic-v2": "public/models/symbolic-melodic-v2.manifest.json",
  "melodic-v3": "public/models/symbolic-melodic-v3.manifest.json",
};

/**
 * The LIVE kinds — the ones the product actually calls.
 *
 * "melodic-v3" is NOT in this list on purpose: that model was trained but
 * parked (its pre-registered gate did not pass, and `runMelodicNextV3` has no
 * caller — docs/CAMPAIGN_STATE.md). Its manifest is a parked artifact, not a
 * live one, and a contract that demands a parked artifact be wired up would
 * be manufacturing work. It is asserted separately below, as a parked model.
 */
const LIVE_KINDS: PriorKind[] = ["drums", "drums-v2", "drums-v3", "melodic", "melodic-v2"];

const readManifest = (kind: PriorKind): unknown => JSON.parse(readFileSync(PATHS[kind], "utf8"));

describe("the shipped manifests pass the runtime's own routing", () => {
  for (const kind of LIVE_KINDS) {
    it(`${kind} — ${PATHS[kind]} is accepted for its kind`, () => {
      const manifest = readManifest(kind);
      const accepted = acceptPriorManifest(kind, manifest);
      expect(accepted, `${kind}: the runtime rejected the manifest the product ships`).not.toBeNull();
      expect(accepted!.kind, `${kind}: the accepted manifest must carry its kind`).toBe(kind);
    });
  }

  it("the parked melodic-v3 model is still refused by the routing", () => {
    // Not a defect: the v3 melodic model was trained and PARKED (its
    // pre-registered gate did not pass and runMelodicNextV3 has no caller),
    // and its manifest was never given a `kind` — exactly like the v1
    // artifacts, but for a model that is not in service. The routing must
    // keep refusing it until the model is actually enabled.
    const parked = readManifest("melodic-v3");
    expect(acceptPriorManifest("melodic-v3", parked), "the parked model stays out of service").toBeNull();
  });

  it("a manifest of a DIFFERENT kind is still rejected", () => {
    const drumsV3 = readManifest("drums-v3");
    expect(acceptPriorManifest("melodic", drumsV3), "drums-v3 is not a melodic manifest").toBeNull();
    expect(acceptPriorManifest("drums-v2", drumsV3), "drums-v3 is not a drums-v2 manifest").toBeNull();
  });

  it("the v1 shim accepts a missing kind but never a foreign one", () => {
    const melodic = readManifest("melodic") as Record<string, unknown>;
    expect(melodic.kind, "the shipped melodic v1 manifest is the legacy shape").toBeUndefined();
    expect(acceptPriorManifest("melodic", { ...melodic, kind: "drums" }), "a foreign kind is refused").toBeNull();
    expect(acceptPriorManifest("melodic", { ...melodic, featureVersion: "melodic-features.v9" })).toBeNull();
  });
});
