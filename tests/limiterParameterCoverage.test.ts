import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createDefaultProject, normalizeProject } from "../src/project-model/schema";
import { addEffect, setEffectParam } from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { EFFECT_META } from "../src/effects/definitions";
import { getDrumTrack } from "../src/project-model/types";

// ═══════════════════════════════════════════════════════════
// LIMITER PARAMETER COVERAGE (2026-10-21, plugin/effect audit)
//
// THE DEFECT THIS PINS.
//
// The limiter's worklet exposed four AudioParams that the DOCUMENT never
// declared: `transientLink`, `releaseLink`, `character` and `oversample`.
// The document side declared only six ids (`ceiling`, `threshold`, `release`,
// `lookaheadMs`, `link`, `mix`), and that omission made the four controls
// unreachable in a way nothing warned about:
//
//   · the generic save path keeps only the ids present in
//     `defaultParamsOf(type)` (`project-model/schema.ts`), so the four were
//     STRIPPED on every save/reload;
//   · `setEffectParam` refused them outright — "Effect param … not defined
//     for limiter" — so the UI, MCP and automation could not reach them
//     either.
//
// They were live in the DSP and dead everywhere else: the classic silently
// dead parameter, in the one place a limiter's character control should be.
//
// WHAT IS PINNED HERE:
//
//   1. every AudioParam the limiter processor declares is either a declared
//      limiter parameter or an explicitly justified exception,
//   2. `setEffectParam` accepts and clamps all four,
//   3. the save/reload path KEEPS all four.
// ═══════════════════════════════════════════════════════════

const PROCESSOR_SOURCE = readFileSync(
  resolve(import.meta.dirname, "..", "src", "audio-worklets", "limiter-processor.js"),
  "utf8",
);

/** Every AudioParam the limiter's processor declares. */
function limiterAudioParamNames(): string[] {
  const names = new Set<string>();
  for (const match of PROCESSOR_SOURCE.matchAll(/\{\s*name:\s*"([A-Za-z0-9_]+)"/g)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

/**
 * The DSP AudioParams that are deliberately NOT document parameters. Every
 * entry MUST state a reason: an exception without a stated reason is exactly
 * the defect this file exists to prevent, so the test fails on one.
 */
const NOT_A_DOCUMENT_PARAM: Record<string, string> = {
  lookahead:
    "unit-converted — the DSP param is in SECONDS while the document param is `lookaheadMs` (milliseconds); the node adapter converts",
  deltaListen:
    "monitor-only — the processor emits input-minus-limited output for the live A/B and its own comment says it is never stored in project state",
};

/** The four controls the processor read but the document could not carry. */
const PREVIOUSLY_UNREACHABLE = ["transientLink", "releaseLink", "character", "oversample"] as const;

describe("limiter parameter coverage", () => {
  it("every limiter DSP parameter is a declared document parameter, or a justified exception", () => {
    const declared = new Set(EFFECT_META.limiter.params.map((p) => p.id));
    const missing = limiterAudioParamNames().filter((name) => !declared.has(name) && !(name in NOT_A_DOCUMENT_PARAM));
    expect(missing, `limiter DSP parameters with no document parameter: ${missing.join(", ")}`).toEqual([]);

    for (const [name, reason] of Object.entries(NOT_A_DOCUMENT_PARAM)) {
      expect(reason.length, `${name} must state why it is not a document parameter`).toBeGreaterThan(20);
    }
  });

  it("the four previously-unreachable controls are declared with a sane range", () => {
    for (const id of PREVIOUSLY_UNREACHABLE) {
      const def = EFFECT_META.limiter.params.find((p) => p.id === id);
      expect(def, `${id} must be declared in limiterParams`).toBeDefined();
      expect(def!.min).toBeLessThan(def!.max);
      expect(def!.default).toBeGreaterThanOrEqual(def!.min);
      expect(def!.default).toBeLessThanOrEqual(def!.max);
      expect(def!.description, `${id} must explain itself to an agent`).toBeTruthy();
    }
  });

  it("setEffectParam reaches all four and clamps out-of-range values", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    store.execute(addEffect(store.doc, trackId, "limiter"));
    const fx = getDrumTrack(store.doc).effects[0];
    expect(fx, "the limiter must be inserted").toBeDefined();

    store.execute(setEffectParam(store.doc, trackId, fx.id, "transientLink", 0.25));
    store.execute(setEffectParam(store.doc, trackId, fx.id, "releaseLink", 0.5));
    store.execute(setEffectParam(store.doc, trackId, fx.id, "character", 1.5));
    store.execute(setEffectParam(store.doc, trackId, fx.id, "oversample", 2));

    const params = getDrumTrack(store.doc).effects[0].params;
    expect(params.transientLink).toBeCloseTo(0.25, 6);
    expect(params.releaseLink).toBeCloseTo(0.5, 6);
    expect(params.character).toBeCloseTo(1.5, 6);
    expect(params.oversample).toBe(2);

    // Out of range clamps to the declared range instead of being accepted.
    store.execute(setEffectParam(store.doc, trackId, fx.id, "character", 99));
    expect(getDrumTrack(store.doc).effects[0].params.character).toBe(2);
  });

  it("the four controls survive a save/reload roundtrip", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    store.execute(addEffect(store.doc, trackId, "limiter"));
    const fx = getDrumTrack(store.doc).effects[0];
    store.execute(setEffectParam(store.doc, trackId, fx.id, "transientLink", 0.25));
    store.execute(setEffectParam(store.doc, trackId, fx.id, "releaseLink", 0.5));
    store.execute(setEffectParam(store.doc, trackId, fx.id, "character", 1.5));
    store.execute(setEffectParam(store.doc, trackId, fx.id, "oversample", 2));

    const reloaded = normalizeProject(store.doc);
    const params = getDrumTrack(reloaded).effects[0].params;
    expect(params.transientLink, "transientLink must survive the save path").toBeCloseTo(0.25, 6);
    expect(params.releaseLink, "releaseLink must survive the save path").toBeCloseTo(0.5, 6);
    expect(params.character, "character must survive the save path").toBeCloseTo(1.5, 6);
    expect(params.oversample, "oversample must survive the save path").toBe(2);
  });
});
