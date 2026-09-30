import { describe, it, expect, afterEach } from "vitest";
import { setIntentModelProvider, tryModelRoute, type IntentModelProvider } from "../src/intent/model-resolver";
import { routeIntentText } from "../src/intent/route";
import { compactIntentResponse } from "../src/intent/dataset";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { addArrangementClip, createScene, setSceneRole } from "../src/commands/commands";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * WRONGKIND WAVE — regressions for the 95.4% → 100% kind-accuracy campaign.
 * Each case pins a real defect found by failure-probing the SFT eval:
 * the "add chorus send" arrange collision, the addRole/clips/compound/mix
 * resolver adapters refusing or emptying corpus-form model output, the
 * ASCII-\b SK adjective landmine, and SK target/numeric coverage gaps.
 */

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

/** Fake provider: returns the instruction itself as the model JSON. */
function echoProvider(): IntentModelProvider {
  return {
    id: "echo-intent",
    version: "test",
    async generate(instruction: string) {
      return instruction;
    },
  };
}

afterEach(() => {
  setIntentModelProvider(null);
});

describe("wrongkind wave — teacher routing", () => {
  it('"add <fx> send" routes mixer routing, never an arrange section add', () => {
    const doc = datasetDoc();
    for (const q of ["add chorus send to the bass", "add a chorus send on the drums", "pridaj chorus send na basu"]) {
      const r = compactIntentResponse(routeIntentText(q, doc));
      expect(r.kind, q).toBe("sendIntent");
    }
  });

  it("bare section adds still route arrange (the contrast class)", () => {
    const doc = datasetDoc();
    for (const q of ["add a chorus section", "add a verse after the intro", "pridaj chorus sekciu"]) {
      const r = compactIntentResponse(routeIntentText(q, doc));
      expect(r.kind, q).toBe("arrange");
    }
  });

  it("SK sidechain negation turns the pump OFF", () => {
    const doc = datasetDoc();
    const off = compactIntentResponse(routeIntentText("sidechain vypni", doc));
    expect(off.kind).toBe("mix");
    expect((off as unknown as { overrides: Record<string, string> }).overrides.pump).toBe("off");
    const on = compactIntentResponse(routeIntentText("sidechain zapni", doc));
    expect((on as unknown as { overrides: Record<string, string> }).overrides.pump).toBe("on");
  });

  it("SK loudness carries the numeric target", () => {
    const doc = datasetDoc();
    const r = compactIntentResponse(routeIntentText("hlasitosť na -8", doc));
    expect(r.kind).toBe("loudness");
    expect((r as unknown as { parse: { targetDb?: number } }).parse.targetDb).toBe(-8);
  });

  it("SK preset asks accept inflected targets (na leade / na basu)", () => {
    const doc = datasetDoc();
    for (const q of ["načítaj warm preset na leade", "načítaj preset reese na leade"]) {
      const r = compactIntentResponse(routeIntentText(q, doc));
      expect(r.kind, q).toBe("preset");
    }
  });

  it("SK production adjectives route with the named target — including diacritic stems \\b cannot see", () => {
    const doc = datasetDoc();
    const expectGoal = (q: string, target: string, concept: string) => {
      const r = compactIntentResponse(routeIntentText(q, doc));
      expect(r.kind, q).toBe("production");
      const intent = (r as { intent: { targets: string[]; goals: Array<{ concept: string }> } }).intent;
      expect(intent.targets[0], q).toBe(target);
      expect(intent.goals[0]?.concept, q).toBe(concept);
    };
    expectGoal("sprav basu širšiu", "bass", "wider");
    expectGoal("sprav bicie hlbšie", "drums", "deeper");
    expectGoal("sprav lead jasnejší", "lead", "brighter");
    expectGoal("sprav akordy teplejšie", "chords", "warmer");
    expectGoal("hlbšie bicie", "drums", "deeper");
  });

  it("mix idiom variants carry compact overrides", () => {
    const doc = datasetDoc();
    const wet = compactIntentResponse(routeIntentText("wet it up", doc));
    expect((wet as unknown as { overrides: Record<string, string> }).overrides.reverb).toBe("more");
    const dry = compactIntentResponse(routeIntentText("make it drier", doc));
    expect((dry as unknown as { overrides: Record<string, string> }).overrides.reverb).toBe("less");
  });
});

describe("wrongkind wave — resolver adapters accept the trained model form", () => {
  it("addRole resolves without demanding the new section already exist", async () => {
    setIntentModelProvider(echoProvider());
    const doc = datasetDoc();
    const route = await tryModelRoute(
      JSON.stringify({ kind: "arrange", ops: [{ op: "addRole", role: "chorus", beforeSceneId: null }] }),
      doc,
    );
    expect(route).not.toBeNull();
    expect(route?.kind).toBe("arrange");
  });

  it("engine-form clips ops (clipId + final toBar) pass through unshifted", async () => {
    setIntentModelProvider(echoProvider());
    const doc = datasetDoc();
    const clipId = doc.arrangement.clips[1]?.id;
    expect(clipId).toBeDefined();
    const route = await tryModelRoute(
      JSON.stringify({ kind: "clips", ops: [{ op: "moveClip", clipId, toBar: 15 }] }),
      doc,
    );
    expect(route).not.toBeNull();
    expect(route).toMatchObject({
      kind: "clips",
      ops: [{ op: "moveClip", clipId, toBar: 15 }],
    });
  });

  it("compound parts keep their payloads (nested teacher form)", async () => {
    setIntentModelProvider(echoProvider());
    const doc = datasetDoc();
    const route = await tryModelRoute(
      JSON.stringify({
        kind: "compound",
        parts: [
          { kind: "fader", intent: { targets: ["bass"], pads: [], direction: "set", percent: 50 } },
          { kind: "tempo", intent: { direction: "set", bpm: 140 } },
        ],
      }),
      doc,
    );
    expect(route).not.toBeNull();
    const parts = (route as { kind: string; parts: Array<Record<string, unknown>> }).parts;
    expect(parts[0]).toMatchObject({ kind: "fader", intent: { direction: "set", percent: 50 } });
    expect(parts[1]).toMatchObject({ kind: "tempo", intent: { direction: "set", bpm: 140 } });
  });

  it("nested mix overrides survive the adapter", async () => {
    setIntentModelProvider(echoProvider());
    const doc = datasetDoc();
    const route = await tryModelRoute(
      JSON.stringify({ kind: "mix", overrides: { reverb: "less" }, detected: ["drier"] }),
      doc,
    );
    expect(route).toMatchObject({ kind: "mix", overrides: { reverb: "less" } });
  });
});
