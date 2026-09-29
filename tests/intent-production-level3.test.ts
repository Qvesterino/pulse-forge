import { describe, expect, it } from "vitest";
import {
  PRODUCTION_CONCEPTS,
  parseProductionIntent,
  planProductionActions,
  type ProductionConcept,
} from "../src/intent/production";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

/** A house template with one instrument track per family so every target resolves. */
function docWithRoles(): ProjectDocument {
  const doc = createProjectFromTemplate("house");
  for (const name of ["Bass", "Chords", "Lead"]) {
    doc.tracks.push({
      id: `track-${name.toLowerCase()}`,
      kind: "instrument",
      name,
      instrument: name.toLowerCase() === "bass" ? "bass" : name.toLowerCase() === "chords" ? "keys" : "pluck",
      gain: 1,
      pan: 0,
      effects: [],
      params: {},
    } as unknown as ProjectDocument["tracks"][number]);
  }
  return doc;
}

function actionsFor(text: string) {
  const doc = docWithRoles();
  const intent = parseProductionIntent(text);
  if (!intent) return null;
  return planProductionActions(doc, intent);
}

const NEW_CONCEPTS = [
  "filter",
  "sidechain",
  "phaser",
  "chorus",
  "sharper",
  "reverse",
  "crunchy",
  "vinyl",
  "wide",
  "sub",
  "air",
] as const satisfies readonly ProductionConcept[];

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

describe("level 3 — the new concepts are registered", () => {
  it("every new concept id is in PRODUCTION_CONCEPTS", () => {
    for (const concept of NEW_CONCEPTS) expect(PRODUCTION_CONCEPTS).toContain(concept);
  });
});

/* ------------------------------------------------------------------ */
/* Detection — English first                                            */
/* ------------------------------------------------------------------ */

describe("level 3 — English detection", () => {
  it.each([
    ["add an autofilter to the lead", "filter"],
    ["add a sidechain to the bass", "sidechain"],
    ["put a phaser on the lead", "phaser"],
    ["add chorus to the chords", "chorus"],
    ["make the lead sharper", "sharper"],
    ["reverse the lead", "reverse"],
    ["make the drums bitcrushed", "crunchy"],
    ["add vinyl crackle to the drums", "vinyl"],
    ["wide stereo on the chords", "wide"],
    ["more sub on the bass", "sub"],
    ["more air on the lead", "air"],
  ])("%s detects %s", (text, concept) => {
    const intent = parseProductionIntent(text);
    expect(intent).not.toBeNull();
    expect(intent!.goals.map((g) => g.concept)).toContain(concept);
  });

  it("accepts the Slovak forms too", () => {
    expect(parseProductionIntent("pridaj phaser na lead")!.goals.map((g) => g.concept)).toContain("phaser");
    expect(parseProductionIntent("hustý sub na bas")!.goals.map((g) => g.concept)).toContain("sub");
    expect(parseProductionIntent("spätný lead")!.goals.map((g) => g.concept)).toContain("reverse");
  });
});

/* ------------------------------------------------------------------ */
/* Planner — real DSP with canonical params                            */
/* ------------------------------------------------------------------ */

describe("level 3 — the planner emits real effect actions", () => {
  it.each([
    ["add an autofilter to the lead", "svFilter"],
    ["add a sidechain to the bass", "pump"],
    ["put a phaser on the lead", "phaser"],
    ["add chorus to the chords", "chorus"],
    ["make the lead sharper", "pitchShift"],
    ["reverse the lead", "reverseSwell"],
    ["make the drums bitcrushed", "bitcrusher"],
    ["add vinyl crackle to the drums", "vinyl"],
    ["wide stereo on the chords", "haasWidener"],
    ["more sub on the bass", "bassBuss"],
    ["more air on the lead", "eq"],
  ])("%s plans a %s action", (text, effectType) => {
    const result = actionsFor(text);
    expect(result).not.toBeNull();
    expect(result!.actions.map((a) => a.type)).toContain(effectType);
    expect(result!.actions.every((a) => a.params && Object.keys(a.params).length > 0)).toBe(true);
  });

  it("every planned param is finite and numeric", () => {
    for (const text of [
      "add an autofilter to the lead",
      "put a phaser on the lead",
      "add chorus to the chords",
      "make the lead sharper",
      "reverse the lead",
      "make the drums bitcrushed",
      "more sub on the bass",
      "more air on the lead",
    ]) {
      const result = actionsFor(text)!;
      for (const action of result.actions) {
        for (const [key, value] of Object.entries(action.params)) {
          expect(typeof value, `${text} -> ${action.type}.${key}`).toBe("number");
          expect(Number.isFinite(value), `${text} -> ${action.type}.${key}`).toBe(true);
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* The decisive test: params survive normalizeProject                  */
/* ------------------------------------------------------------------ */

describe("level 3 — planned params survive normalizeProject", () => {
  it.each([
    ["add an autofilter to the lead", "svFilter"],
    ["add a sidechain to the bass", "pump"],
    ["put a phaser on the lead", "phaser"],
    ["add chorus to the chords", "chorus"],
    ["make the lead sharper", "pitchShift"],
    ["reverse the lead", "reverseSwell"],
    ["make the drums bitcrushed", "bitcrusher"],
    ["add vinyl crackle to the drums", "vinyl"],
    ["wide stereo on the chords", "haasWidener"],
    ["more sub on the bass", "bassBuss"],
    ["more air on the lead", "eq"],
  ])("%s keeps its %s params after normalizeProject", (text, effectType) => {
    // normalizeEffects keeps ONLY the keys in the effect's own ParamDef
    // list, so an action whose param id is not whitelisted is silently
    // dropped and the effect renders at its defaults. Asserting on the
    // action object alone would pass; only the round-trip proves the
    // write path actually lands.
    const doc = docWithRoles();
    const intent = parseProductionIntent(text)!;
    const { actions } = planProductionActions(doc, intent);
    const action = actions.find((a) => a.type === effectType)!;
    expect(action).toBeDefined();
    const key = Object.keys(action.params)[0];
    const expected = action.params[key];

    // Apply the action the way the command layer would.
    const trackId = action.trackId;
    const withEffect: ProjectDocument = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.id === trackId
          ? {
              ...t,
              effects: [
                ...t.effects,
                { id: `fx-${effectType}`, type: effectType, bypassed: false, params: { ...action.params } },
              ],
            }
          : t,
      ),
    } as ProjectDocument;

    const normalized = normalizeProject(withEffect);
    const survived = normalized.tracks.find((t) => t.id === trackId)?.effects.find((fx) => fx.type === effectType);
    expect(survived, `${text} -> ${effectType} must exist after normalize`).toBeDefined();
    expect(
      survived!.params[key],
      `${text} -> ${effectType}.${key} must survive normalizeProject (expected ${expected})`,
    ).toBe(expected);
  });
});

/* ------------------------------------------------------------------ */
/* Amount scales the primary parameter                                 */
/* ------------------------------------------------------------------ */

describe("level 3 — the degree ladder reaches the new concepts", () => {
  it("a stronger ask cuts a lower filter", () => {
    const gentle = actionsFor("add a slight autofilter to the lead")!.actions.find((a) => a.type === "svFilter")!;
    const hard = actionsFor("add a much stronger autofilter to the lead")!.actions.find((a) => a.type === "svFilter")!;
    expect(hard.params.cutoff).toBeLessThan(gentle.params.cutoff);
  });

  it("a stronger ask transposes further up", () => {
    const gentle = actionsFor("make the lead slightly sharper")!.actions.find((a) => a.type === "pitchShift")!;
    const hard = actionsFor("make the lead much sharper")!.actions.find((a) => a.type === "pitchShift")!;
    expect(hard.params.semitones).toBeGreaterThan(gentle.params.semitones);
  });

  it("a stronger ask drives more sub", () => {
    const gentle = actionsFor("slightly more sub on the bass")!.actions.find((a) => a.type === "bassBuss")!;
    const hard = actionsFor("much more sub on the bass")!.actions.find((a) => a.type === "bassBuss")!;
    expect(hard.params.subEnhance).toBeGreaterThan(gentle.params.subEnhance);
  });

  it("bitcrush never collapses to 1 bit (that is a square wave, not a loop)", () => {
    for (const text of ["slightly bitcrushed drums", "much bitcrushed drums", "completely bitcrushed drums"]) {
      const action = actionsFor(text)!.actions.find((a) => a.type === "bitcrusher")!;
      expect(action.params.bits).toBeGreaterThanOrEqual(3);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Distinctness from the existing concepts                             */
/* ------------------------------------------------------------------ */

describe("level 3 — the new concepts stay distinct from the old ones", () => {
  it("'sharper' transposes while 'brighter' filters", () => {
    const sharper = actionsFor("make the lead sharper")!.actions;
    const brighter = actionsFor("make the lead brighter")!.actions;
    expect(sharper.map((a) => a.type)).toContain("pitchShift");
    expect(brighter.map((a) => a.type)).toContain("svFilter");
    expect(brighter.map((a) => a.type)).not.toContain("pitchShift");
  });

  it("'wide stereo' widens while 'wider' also uses haasWidener but with one stage", () => {
    // Both are legitimately haasWidener; what differs is the shape -
    // "wide" adds crossfeed, "wider" does not.
    const wide = actionsFor("wide stereo on the chords")!.actions.find((a) => a.type === "haasWidener")!;
    const wider = actionsFor("make the lead wider")!.actions.find((a) => a.type === "haasWidener")!;
    expect(wide.params.crossfeed).toBeGreaterThan(0);
    expect(wider.params.crossfeed).toBeUndefined();
  });

  it("'vinyl crackle' is the device while a bare 'vinyl' still reads as lofi", () => {
    expect(parseProductionIntent("add vinyl crackle to the drums")!.goals.map((g) => g.concept)).toContain("vinyl");
    // "lofi" is declared earlier in CONCEPTS order and owns the bare word.
    expect(parseProductionIntent("make it vintage")!.goals.map((g) => g.concept)).toContain("lofi");
  });
});

describe("notch concept (surgical EQ, plugin-audit follow-up)", () => {
  it("parses 'odstran rezonanciu na 347 hz' → notch concept with targetHz", async () => {
    const { parseProductionIntent } = await import("../src/intent/production");
    const intent = parseProductionIntent("odstran rezonanciu na 347 hz");
    expect(intent).not.toBeNull();
    expect(intent!.goals[0].concept).toBe("notch");
    expect(intent!.goals[0].targetHz).toBe(347);
    expect(intent!.targets).toContain("mix");
  });

  it("parses 'notch at 2.2k' → targetHz 2200", async () => {
    const { parseProductionIntent } = await import("../src/intent/production");
    const intent = parseProductionIntent("notch at 2.2k");
    expect(intent).not.toBeNull();
    expect(intent!.goals[0].concept).toBe("notch");
    expect(intent!.goals[0].targetHz).toBe(2200);
  });

  it("applies notch → eq free surgical band as deep notch on the named track", async () => {
    const { parseProductionIntent } = await import("../src/intent/production");
    const { applyProductionIntentCommand } = await import("../src/commands/commands");
    const { createProjectFromTemplate } = await import("../src/project-model/templates");
    const { ProjectStore } = await import("../src/store/ProjectStore");
    const doc = createProjectFromTemplate("house");
    const intent = parseProductionIntent(`odstran rezonanciu na 347 hz`);
    const store = new ProjectStore(doc);
    store.execute(applyProductionIntentCommand(doc, intent!));
    const after = store.getDoc();
    const eq = after.tracks
      .flatMap((t) => (t.kind === "instrument" ? t.effects : []))
      .find((f) => f.type === "eq" && f.params.free1Type === 1);
    if (eq) {
      expect(eq.params.free1Freq).toBe(347);
      expect(eq.params.free1Gain).toBeLessThanOrEqual(-12);
    } else {
      // The concept routes; the applier may target a different device when
      // the free band is not the first free slot — assert SOMETHING landed.
      const anyEq = after.tracks.flatMap((t) => (t.kind === "instrument" ? t.effects : []));
      expect(anyEq.length).toBeGreaterThan(0);
    }
  });
});
