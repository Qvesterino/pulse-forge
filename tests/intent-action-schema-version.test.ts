import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_SCHEMA_VERSION, migrateModelAction, toGbnfGrammar } from "../src/intent/model-schema";

/**
 * P3-D VERSIONED ACTION SCHEMA (control-surface audit 2026-10-13, roadmap
 * P3-D). The model manifest pins the grammar the v16 artifact was TRAINED
 * against (grammarSha256) and the loader refuses drift at load time — but
 * nothing guarded it at TEST time, so a vocabulary edit would only surface
 * when a user's browser refused the model. Two pins here:
 *
 *  G1 sha256(toGbnfGrammar()) === the deployed manifest's grammarSha256 —
 *     any grammar-affecting edit fails THIS suite in CI, long before a
 *     model refuses to load. When a retrain intentionally changes the
 *     vocabulary, this pin and the manifest are re-pinned in the SAME
 *     commit (the established intent-model-wave discipline).
 *  G2 the version envelope never leaks into the grammar — the version
 *     travels beside the action, not inside the constrained decoding.
 *
 * Plus the migration hook contract: unversioned envelopes are v1 (every
 * deployed model emits them), a current version passes, a FUTURE version
 * refuses with an update hint, garbage refuses.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(resolve(root, "public/models/intent-model-v1.manifest.json"), "utf8"),
) as { grammarSha256: string };

describe("P3-D versioned action schema", () => {
  it("G1: toGbnfGrammar() is byte-identical to the deployed manifest pin — VERIFIED OPEN 2026-10-14 (owner: intent-model wave)", () => {
    // This pin is RED at HEAD — intentionally left red as the owned signal:
    // concurrent waves (dc510c22 "ale však hej" + the param-intent work)
    // grew MODEL VOCAB without re-pinning public/models/
    // intent-model-v1.manifest.json, so manifestGrammarDrift (verified with
    // the loader's own algorithm) now refuses the shipped artifact at every
    // browser load. TWO remedies, the wave's call:
    //   re-pin   — ONLY if the artifact's training corpus already matches
    //              the current vocabulary;
    //   retrain  — the disciplined path when the vocab moved past the
    //              corpus (the established "retrain POVINNÝ" rule).
    // THIS test must go green again with whichever remedy lands.
    const digest = createHash("sha256").update(toGbnfGrammar()).digest("hex");
    expect(
      digest,
      `grammar drift — manifest pins ${manifest.grammarSha256.slice(0, 12)}…, this build generates ${digest.slice(0, 12)}…`,
    ).toBe(manifest.grammarSha256.toLowerCase());
  });

  it("G2: the version envelope key does not leak into the constrained grammar", () => {
    expect(toGbnfGrammar().includes("actionSchemaVersion")).toBe(false);
  });

  it("an unversioned envelope (every deployed model) migrates as v1", () => {
    const action = { kind: "exact", op: "mute", target: "drums", value: true };
    const out = migrateModelAction(action);
    expect(out).toEqual({ action, version: 1 });
  });

  it("a current-version envelope passes through", () => {
    const action = { kind: "exact", op: "mute", target: "drums", value: true, actionSchemaVersion: 1 };
    const out = migrateModelAction(action);
    expect(out).toEqual({ action, version: 1 });
  });

  it("a FUTURE version refuses with an update hint — never silently mis-migrated", () => {
    const out = migrateModelAction({ kind: "exact", actionSchemaVersion: 99 });
    expect("refusal" in out && out.refusal).toContain("newer than this build understands");
    expect("refusal" in out && out.refusal).toContain("update KYX");
  });

  it("garbage versions refuse", () => {
    for (const bad of [0, -3, 1.5, "two", null]) {
      const out = migrateModelAction({ kind: "exact", actionSchemaVersion: bad });
      expect("refusal" in out, String(bad)).toBe(true);
    }
  });

  it("non-object actions refuse", () => {
    expect("refusal" in migrateModelAction(null)).toBe(true);
    expect("refusal" in migrateModelAction("mute drums")).toBe(true);
  });
});
