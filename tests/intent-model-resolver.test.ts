import { describe, it, expect, afterEach, beforeAll } from "vitest";
import {
  setIntentModelProvider,
  tryModelRoute,
  getIntentModelProvider,
  type IntentModelProvider,
} from "../src/intent/model-resolver";
import { routeIntentText } from "../src/intent/route";
import { applyFaderIntent } from "../src/intent/conversation";
import { applyExactIntentCommand } from "../src/commands/commands";
import { applyClipArrangeOps } from "../src/intent/arrangeWords";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { addArrangementClip, createScene, setSceneRole } from "../src/commands/commands";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * LOCAL INTENT MODEL — adapter bridge tests with a deterministic fake
 * provider (what a trained LFM-2.5 would emit, per model-schema.ts). These
 * pin the FULL bridge contract: validate → adapt (units/ids) → RoutedIntent
 * the standard executors consume. Safety paths (invalid output, unresolvable
 * refs, destructive ops through applier guards) are first-class cases.
 */

// The factory preset bank is a lazy chunk — preset asks need the warm.
beforeAll(async () => {
  const { warmFactoryPresets } = await import("../src/presets/factory-loader");
  await warmFactoryPresets();
});

function datasetDoc(): ProjectDocument {
  useDeterministicIds();
  resetDeterministicIds();
  let doc = createProjectFromTemplate("house");
  doc = { ...doc, arrangement: { ...doc.arrangement, clips: [] }, markers: [] };
  doc = createScene(doc, "Intro").execute(doc);
  doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "intro").execute(doc);
  doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 0, 4).execute(doc);
  doc = createScene(doc, "Drop").execute(doc);
  doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "drop").execute(doc);
  doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 4, 4).execute(doc);
  return doc;
}

/** Fake provider: instruction → canned model-form JSON (echo map). */
function fakeProvider(responses: Record<string, unknown>, fallback?: unknown): IntentModelProvider {
  return {
    id: "fake-intent",
    version: "test",
    async generate(instruction: string) {
      const hit = responses[instruction];
      if (hit != null) return JSON.stringify(hit);
      if (fallback != null) return JSON.stringify(fallback);
      throw new Error("no canned response");
    },
  };
}

afterEach(() => {
  setIntentModelProvider(null);
});

describe("model resolver — happy paths", () => {
  it("novel fader phrasing the regex layer misses routes through the model", async () => {
    const doc = datasetDoc();
    // "ease the bass down a touch" — nothing in the deterministic vocab
    expect(routeIntentText("ease the bass down a touch", doc).kind).toBe("pattern");
    setIntentModelProvider(
      fakeProvider({
        "ease the bass down a touch": { kind: "fader", targets: ["bass"], direction: "down", amount: "subtle" },
      }),
    );
    const route = await tryModelRoute("ease the bass down a touch", doc);
    expect(route?.kind).toBe("fader");
    if (route?.kind !== "fader") throw new Error("expected fader");
    expect(route.intent).toMatchObject({ targets: ["bass"], direction: "down", amount: "subtle" });
    // the adapted route executes through the standard executor
    const next = applyFaderIntent(doc, route.intent)!.execute(doc);
    const bass = next.tracks.find((t) => t.kind === "instrument")!;
    expect(bass.gain).toBeLessThan(doc.tracks.find((t) => t.kind === "instrument")!.gain);
  });

  it("NESTED teacher-form emission unwraps to flat before adaptation (SFT corpus shape)", async () => {
    const doc = datasetDoc();
    // the SFT corpus stores {kind, intent:{...}} (compactIntentResponse) — a
    // fine-tuned model reproduces that shape; the adapters read FLAT records.
    // Before the unwrap guard this passed validation and adapted against the
    // empty root — a silent all-slots-missing fader.
    setIntentModelProvider(
      fakeProvider({
        "ease the bass down a touch": {
          kind: "fader",
          intent: { targets: ["bass"], pads: [], direction: "down", amount: "subtle" },
        },
      }),
    );
    const route = await tryModelRoute("ease the bass down a touch", doc);
    expect(route?.kind).toBe("fader");
    if (route?.kind !== "fader") throw new Error("expected fader");
    expect(route.intent).toMatchObject({ targets: ["bass"], direction: "down", amount: "subtle" });
    const next = applyFaderIntent(doc, route.intent)!.execute(doc);
    const bass = next.tracks.find((t) => t.kind === "instrument")!;
    expect(bass.gain).toBeLessThan(doc.tracks.find((t) => t.kind === "instrument")!.gain);
  });

  it("model percent is an integer; the adapter keeps engine semantics (50 → 0.75)", async () => {
    const doc = datasetDoc();
    setIntentModelProvider(
      fakeProvider({ "park the bass at half": { kind: "fader", targets: ["bass"], direction: "set", percent: 50 } }),
    );
    const route = await tryModelRoute("park the bass at half", doc);
    if (route?.kind !== "fader") throw new Error("expected fader");
    expect(route.intent.percent).toBe(50);
    const next = applyFaderIntent(doc, route.intent)!.execute(doc);
    expect(next.tracks.find((t) => t.kind === "instrument")!.gain).toBeCloseTo(0.75, 5);
  });

  it("preset by NAME resolves to the factory id; unknown name → presetUnknown", async () => {
    const doc = datasetDoc();
    setIntentModelProvider(
      fakeProvider({
        "give me that warm sub sound on the low end": { kind: "preset", name: "Warm Sub", target: "bass" },
        "load the blorptar preset on the bass": { kind: "preset", name: "blorptar", target: "bass" },
      }),
    );
    const hit = await tryModelRoute("give me that warm sub sound on the low end", doc);
    expect(hit?.kind).toBe("preset");
    if (hit?.kind !== "preset") throw new Error("expected preset");
    expect(hit.intent.preset.name).toBe("Warm Sub");
    expect(hit.intent.matchedBy).toBe("exact");

    const miss = await tryModelRoute("load the blorptar preset on the bass", doc);
    expect(miss?.kind).toBe("presetUnknown");
    if (miss?.kind !== "presetUnknown") throw new Error("expected presetUnknown");
    expect(miss.suggestions.length).toBeGreaterThan(0);
  });

  it("clip REF (role) + 1-based toBar adapt to the engine's clipId/0-based bar", async () => {
    const doc = datasetDoc();
    setIntentModelProvider(
      fakeProvider({
        "double the intro section at bar nine": { kind: "clips", ops: [{ op: "copyClip", ref: "intro", toBar: 9 }] },
      }),
    );
    const route = await tryModelRoute("double the intro section at bar nine", doc);
    expect(route?.kind).toBe("clips");
    if (route?.kind !== "clips") throw new Error("expected clips");
    expect(route.ops[0]).toMatchObject({ op: "copyClip", toBar: 8 });
    const next = applyClipArrangeOps(doc, route.ops)!.execute(doc);
    expect(next.arrangement.clips).toHaveLength(3);
    expect(next.arrangement.clips.some((c) => c.startBar === 8)).toBe(true);
  });

  it("exact pan: model panValue −100..100 → engine −1..1", async () => {
    const doc = datasetDoc();
    setIntentModelProvider(
      fakeProvider({
        "shove the low end slightly left": { kind: "exact", ops: [{ kind: "pan", target: "bass", panValue: 30 }] },
      }),
    );
    const route = await tryModelRoute("shove the low end slightly left", doc);
    if (route?.kind !== "exact") throw new Error("expected exact");
    expect(route.plan.ops[0]).toMatchObject({ kind: "pan", value: 0.3 });
    const next = applyExactIntentCommand(doc, route.plan).execute(doc);
    expect(next.tracks.find((t) => t.kind === "instrument")!.pan).toBeCloseTo(0.3, 5);
  });

  it("compound parts (JSON strings) adapt recursively into one compound route", async () => {
    const doc = datasetDoc();
    setIntentModelProvider(
      fakeProvider({
        "calm the drums and lift the top line": {
          kind: "compound",
          parts: [
            JSON.stringify({ kind: "fader", targets: ["drums"], direction: "down" }),
            JSON.stringify({ kind: "fader", targets: ["lead"], direction: "up" }),
          ],
        },
      }),
    );
    const route = await tryModelRoute("calm the drums and lift the top line", doc);
    expect(route?.kind).toBe("compound");
    if (route?.kind !== "compound") throw new Error("expected compound");
    expect(route.parts).toHaveLength(2);
    expect(route.parts[0]).toMatchObject({ kind: "fader" });
    expect(route.parts[1]).toMatchObject({ kind: "fader", intent: { targets: ["lead"] } });
  });

  it("clarify suggestions from the model are verified executable (pattern junk filtered)", async () => {
    const doc = datasetDoc();
    setIntentModelProvider(
      fakeProvider({
        "fix the drums maybe?": {
          kind: "clarify",
          suggestions: ["mute the drums", "make me a dark techno beat", "garbage phrase"],
        },
      }),
    );
    const route = await tryModelRoute("fix the drums maybe?", doc);
    expect(route?.kind).toBe("clarify");
    if (route?.kind !== "clarify") throw new Error("expected clarify");
    expect(route.suggestions).toEqual(["mute the drums"]); // only executable survives
  });
});

describe("model resolver — safety paths", () => {
  it("no provider registered → null (panel behavior unchanged)", async () => {
    const doc = datasetDoc();
    expect(getIntentModelProvider()).toBeNull();
    expect(await tryModelRoute("anything", doc)).toBeNull();
  });

  it("provider throw / invalid JSON / schema-invalid output → null, never a crash", async () => {
    const doc = datasetDoc();
    setIntentModelProvider({
      id: "broken",
      version: "x",
      generate: async () => {
        throw new Error("model exploded");
      },
    });
    expect(await tryModelRoute("x", doc)).toBeNull();

    setIntentModelProvider(fakeProvider({}, { kind: "not-json" }));
    expect(await tryModelRoute("x", doc)).toBeNull();

    setIntentModelProvider(fakeProvider({}, "this is not json at all"));
    expect(await tryModelRoute("x", doc)).toBeNull();

    setIntentModelProvider(fakeProvider({}, { kind: "fader", targets: ["bass"], direction: "sideways" }));
    expect(await tryModelRoute("x", doc)).toBeNull();

    setIntentModelProvider(fakeProvider({}, { kind: "fader", targets: ["bass"], direction: "set", percent: 250 }));
    expect(await tryModelRoute("x", doc)).toBeNull();
  });

  it("unresolvable clip ref → null (the model never guesses an id)", async () => {
    const doc = datasetDoc();
    setIntentModelProvider(
      fakeProvider({}, { kind: "clips", ops: [{ op: "deleteClip", ref: "outro" }] }), // no outro scene
    );
    expect(await tryModelRoute("kill the outro clip", doc)).toBeNull();
  });

  it("MODEL-EMITTED destructive op still hits the strict applier guard", async () => {
    const doc = datasetDoc();
    const drumsOnly: ProjectDocument = { ...doc, tracks: doc.tracks.filter((t) => t.kind === "drum") };
    // the model says "delete the lead track" — schema-legal, but the doc has
    // no lead family: the applier must throw loudly, not delete a stand-in
    setIntentModelProvider(fakeProvider({}, { kind: "exact", ops: [{ kind: "removeTrack", target: "lead" }] }));
    const route = await tryModelRoute("delete the lead track", drumsOnly);
    expect(route?.kind).toBe("exact"); // the route is structurally fine…
    expect(() => applyExactIntentCommand(drumsOnly, route!.kind === "exact" ? route.plan : null!)).toThrow(
      /no track matches/,
    );
  });

  it("model fader on a doc without the family returns the route; the executor nulls (no guessed track)", async () => {
    const doc = datasetDoc();
    const drumsOnly: ProjectDocument = { ...doc, tracks: doc.tracks.filter((t) => t.kind === "drum") };
    setIntentModelProvider(fakeProvider({}, { kind: "fader", targets: ["bass"], direction: "down" }));
    const route = await tryModelRoute("tame the sub", drumsOnly);
    expect(route?.kind).toBe("fader");
    expect(applyFaderIntent(drumsOnly, route!.kind === "fader" ? route.intent : null!)).toBeNull();
  });
});
