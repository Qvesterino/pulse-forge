import { describe, expect, it } from "vitest";
import { routeIntentText, parseReviseIntent } from "../src/intent/route";
import { parseComplaintIntent, diagnoseComplaint } from "../src/intent/complaints";
import { parseExactIntent } from "../src/intent/exact";
import { testDoc } from "./fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * SK VOCABULARY AUDIT (vocabulary wave 9, 2026-10-12) — real Slovak producer
 * phrases through the unified router. Each case was a FINDING of the live
 * probe (24 gaps / 44 probes) and is pinned at its FIXED behavior.
 */

const sceneDoc: ProjectDocument = {
  ...testDoc(),
  scenes: [
    { id: "s1", name: "Intro", patternId: "p1", role: "intro", intensity: 0.4 },
    { id: "s2", name: "Drop", patternId: "p2", role: "drop", intensity: 1 },
    { id: "s3", name: "Break", patternId: "p3", role: "break", intensity: 0.3 },
  ],
} as unknown as ProjectDocument;

const doc = testDoc();

const route = (text: string, scenes = false) => routeIntentText(text, scenes ? sceneDoc : doc).kind;

describe("SK vocabulary audit — transport / save / undo", () => {
  it("spusti / zastav / stopni drive the transport", () => {
    expect(route("spusti")).toBe("transport");
    expect(route("zastav")).toBe("transport");
    expect(route("stopni")).toBe("transport");
  });
  it("uloz saves; krok spat undoes", () => {
    expect(route("uloz")).toBe("save");
    expect(route("krok spat")).toBe("undoIntent");
  });
});

describe("SK vocabulary audit — tempo", () => {
  it("spomal to / zrychli / tempo dole|hore", () => {
    expect(route("spomal to")).toBe("tempo");
    expect(route("zrychli")).toBe("tempo");
    expect(route("tempo dole")).toBe("tempo");
    expect(route("tempo hore")).toBe("tempo");
  });
});

describe("SK vocabulary audit — fader / exact", () => {
  it("pad/track faders with SK stems", () => {
    expect(route("stis lead")).toBe("fader");
    expect(route("daj bicie hlasnejsie")).toBe("fader");
    expect(route("kick hore")).toBe("fader");
    expect(route("808 dole")).toBe("fader");
  });
  it("mutni / zapni / panuj s číslom", () => {
    expect(route("mutni lead")).toBe("exact");
    expect(route("zapni basu")).toBe("exact");
    expect(route("panuj lead dolava 30")).toBe("exact");
  });
  it("SK transpose without a count is ONE unit", () => {
    const plan = parseExactIntent("posun basu o oktavu nizsie");
    expect(plan?.ops[0]).toMatchObject({ kind: "transpose", target: "bass", semitones: -12 });
    expect(route("posun basu o oktavu nizsie")).toBe("exact");
  });
});

describe("SK vocabulary audit — mix / loudness", () => {
  it("kompresia belongs to the punch lane", () => {
    expect(route("viac kompresie")).toBe("mix");
    expect(route("suchsi mix")).toBe("mix");
    expect(route("svetlejsi zvuk")).toBe("mix");
  });
  it("loudness shouts", () => {
    expect(route("celkovo tichsie")).toBe("loudness");
    expect(route("urob to hlasnejsie")).toBe("loudness");
  });
});

describe("SK vocabulary audit — effects / production", () => {
  it("targeted effects", () => {
    expect(route("pridaj delay na lead")).toBe("effectIntent");
    expect(route("odober reverb z basu")).toBe("effectIntent");
    expect(route("menej saturacie na bicich")).toBe("effectIntent");
  });
  it("production concepts with SK stems", () => {
    expect(route("sprav basu hlbsiu")).toBe("production");
    expect(route("hatsy jasnejsie")).toBe("production");
    // "bubny tazsie" → the FADER wins by priority (named target + up stem);
    // the grittier reading stays reachable via "make the drums grittier".
    expect(route("bubny tazsie")).toBe("fader");
  });
});

describe("SK vocabulary audit — revise", () => {
  it("energetickejsie / hustejsie / pokojnejsie", () => {
    expect(parseReviseIntent("energetickejsie")).toMatchObject({ attribute: "energy", direction: "more" });
    expect(parseReviseIntent("hustejsie")).toMatchObject({ attribute: "density", direction: "more" });
    expect(parseReviseIntent("pokojnejsie")).toMatchObject({ attribute: "energy", direction: "less" });
    expect(route("energetickejsie")).toBe("revise");
    expect(route("hustejsie")).toBe("revise");
    expect(route("pokojnejsie")).toBe("revise");
  });
});

describe("SK vocabulary audit — queries / arrange", () => {
  it("tempo/key questions", () => {
    expect(route("ake je tempo")).toBe("queryIntent");
    expect(route("aky je kluc")).toBe("queryIntent");
  });
  it("arrange ops on scenes", () => {
    expect(route("presun intro na koniec", true)).toBe("arrange");
    expect(route("vymaz break", true)).toBe("arrange");
  });
});

describe("SK vocabulary audit — complaints (listening loop)", () => {
  it("section + family complaints parse with the new stems", () => {
    expect(parseComplaintIntent("drop posobi prazdno")).toMatchObject({ kind: "empty", role: "drop" });
    expect(parseComplaintIntent("bicie su slabe")).toMatchObject({ kind: "thin", family: "drums" });
    expect(parseComplaintIntent("bicie su blatiste")).toMatchObject({ kind: "muddy", family: "drums" });
    expect(parseComplaintIntent("lead krici")).toMatchObject({ kind: "harsh", family: "lead" });
    // PADS count as families: a kick/snare complaint targets the drum track.
    expect(parseComplaintIntent("kick je mrtvy")).toMatchObject({ kind: "noPunch", family: "kick" });
    expect(parseComplaintIntent("bicie su dute")).toMatchObject({ kind: "muddy", family: "drums" });
    expect(parseComplaintIntent("nic sa nedeje v drope")).toMatchObject({ kind: "empty", role: "drop" });
  });

  it("every parsed complaint produces an executable proposal", () => {
    const parsed = parseComplaintIntent("kick je mrtvy");
    expect(parsed).not.toBeNull();
    const diagnosis = diagnoseComplaint(parsed as NonNullable<typeof parsed>);
    expect(diagnosis?.proposals.length).toBeGreaterThan(0);
    // the proposal instruction routes back through the production path
    const instruction = (diagnosis as { proposals: { instruction: string }[] }).proposals[0].instruction;
    expect(routeIntentText(instruction, doc).kind).toBe("production");
  });
});

describe("SK vocabulary audit — moods stay generation", () => {
  it("mood adjectives never hijack the route", () => {
    expect(route("smutne techno")).toBe("pattern");
    expect(route("hypnoticky house")).toBe("pattern");
  });
});
