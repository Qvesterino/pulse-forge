import { describe, expect, it } from "vitest";
import { parseIntentText } from "../src/intent/text-parser";
import { normalizeIntent } from "../src/intent/normalize";
import { validateIntentSpec } from "../src/intent/schema";
import { intentHash } from "../src/intent/hash";
import { generateOptionsFromIntent, planGeneration } from "../src/intent/plan";
import { compileBriefContract, unprotectRole, type BriefStatement } from "../src/intent/brief-contract";
import { resetProducerSession, recordDecision, type ProducerSessionState } from "../src/intent/producer-session";
import { createProjectFromTemplate } from "../src/project-model/templates";

/**
 * FÁZA 1 (AI-first producer): the brief contract — POVINNÉ / PREFERENCIE /
 * ZÁKAZY / ZACHOVAŤ / NEISTÉ. Parser-level protection phrases, contract
 * compilation, per-point fixes, and the preserve enforcement path
 * (normalize → schema → hash → plan/options) are each pinned separately.
 */

const sessionWith = (decisions: Partial<Record<string, string>>): ProducerSessionState => {
  resetProducerSession();
  for (const [kind, value] of Object.entries(decisions) as [string, string][]) {
    recordDecision(kind as never, value, "test");
  }
  return {
    decisions: Object.fromEntries(Object.entries(decisions).map(([k, v]) => [k, { value: v, at: 0, from: "test" }])),
    generations: 1,
  };
};

const sectionOf = (statements: readonly BriefStatement[], section: string) =>
  statements.filter((s) => s.section === section);
const byId = (statements: readonly BriefStatement[], id: string) => statements.find((s) => s.id === id);

describe("parser: protected roles (ZACHOVAŤ)", () => {
  it("SK 'nechaj môj bass a akordy' protects instead of generating", () => {
    const { input, detected } = parseIntentText("tmavý trap, nechaj môj bass a akordy pri 140");
    expect(input.preserve).toEqual(["bass", "chords"]);
    expect(input.roles).toBeUndefined();
    expect(input.bpmRange).toEqual([140, 140]);
    expect(detected).toContain("preserve bass");
    expect(detected).toContain("preserve chords");
  });

  it("EN 'keep my drums' protects drums", () => {
    const { input } = parseIntentText("keep my drums but darker at 120");
    expect(input.preserve).toEqual(["drums"]);
    expect(input.roles).toBeUndefined();
    expect(input.bpmRange).toEqual([120, 120]);
  });

  it("'nechaj 808' protects the bass family", () => {
    const { input } = parseIntentText("drill, nechaj 808, pridaj lead");
    expect(input.preserve).toEqual(["bass"]);
    expect(input.roles).toContain("lead");
    expect(input.roles).not.toContain("bass");
  });

  it.each([
    ["leave my kick alone", ["drums"]],
    ["keep my snare", ["drums"]],
    ["keep my hi-hats", ["drums"]],
    ["leave my percussion", ["drums"]],
    ["nechaj kopák", ["drums"]],
    ["keep my 808s", ["bass"]],
  ] as const)("component alias is protected as its whole role: %s", (text, expected) => {
    const { input } = parseIntentText(text);
    expect(input.preserve).toEqual(expected);
    // A protected component must not also turn its entire role into a target.
    expect(input.roles ?? []).not.toContain(expected[0]);
  });

  it.each([
    ["no drums, add kick", "drums", "prohibition-vs-addition"],
    ["bez bicích, pridaj kopák", "drums", "prohibition-vs-addition"],
    ["keep my kick but add snare", "drums", "preserve-vs-addition"],
    ["no bass, keep my bass", "bass", "prohibition-vs-preserve"],
    ["no chords, add keys", "chords", "prohibition-vs-addition"],
    ["without lead, generate synth", "lead", "prohibition-vs-addition"],
    ["no bass, full beat", "bass", "prohibition-vs-scope"],
  ] as const)("surfaces explicit role conflict in %s", (text, role, kind) => {
    const parsed = parseIntentText(text);
    expect(parsed.conflicts).toContainEqual(expect.objectContaining({ role, kind }));
  });

  it.each([
    ["no drums", "drums"],
    ["no bass", "bass"],
    ["bez akordov", "chords"],
    ["without lead", "lead"],
  ] as const)("a hard prohibition cannot return through parser defaults: %s", (text, prohibitedRole) => {
    const parsed = parseIntentText(text);
    expect(parsed.prohibitedRoles).toContain(prohibitedRole);
    expect(parsed.input.roles).toBeDefined();
    expect(parsed.input.roles).not.toContain(prohibitedRole);
  });

  it("does not misclassify a targeted sound change as a generation conflict", () => {
    expect(parseIntentText("no bass, make the bass deeper").conflicts).toEqual([]);
  });

  it("protects the kick while still targeting an explicitly added lead", () => {
    const { input } = parseIntentText("leave my kick but add lead");
    expect(input.preserve).toEqual(["drums"]);
    expect(input.roles).toEqual(["lead"]);
  });

  it("component-level drum protection reaches the generation plan as a hard exclusion", () => {
    const doc = createProjectFromTemplate("house");
    const parsed = parseIntentText("dark trap, leave my kick alone");
    const plan = planGeneration({ ...parsed.input, seed: "preserve-kick-plan" }, doc);
    expect(plan.options.roles).not.toContain("drums");
    expect(plan.rolePlans.drums.enabled).toBe(false);
    expect(plan.rolePlans.drums.targetTrackIds).toEqual([]);
  });

  it.each([
    ["no bass", "bass"],
    ["bez akordov", "chords"],
    ["without lead", "lead"],
  ] as const)("hard role prohibition reaches the generation plan: %s", (text, prohibitedRole) => {
    const doc = createProjectFromTemplate("house");
    const parsed = parseIntentText(text);
    const plan = planGeneration({ ...parsed.input, seed: `prohibit-${prohibitedRole}` }, doc);
    expect(plan.options.roles).not.toContain(prohibitedRole);
    expect(plan.rolePlans[prohibitedRole].enabled).toBe(false);
    expect(plan.rolePlans[prohibitedRole].targetTrackIds).toEqual([]);
  });

  it("protection survives a positive generation scope", () => {
    const { input } = parseIntentText("beat only, nechaj akordy");
    expect(input.preserve).toEqual(["chords"]);
    expect(input.roles).toEqual(["drums"]);
  });

  it("'bez ďalších bicích' is recognized as a drum prohibition", () => {
    const { input, detected } = parseIntentText("142 bpm, temný trap, bez ďalších bicích; nechaj môj bass a akordy");
    expect(detected).toContain("no drums");
    expect(input.preserve).toEqual(["bass", "chords"]);
    expect(input.bpmRange).toEqual([142, 142]);
  });

  it("preserve clause does not cross a comma into the next directive", () => {
    const { input } = parseIntentText("keep my bass, drums only");
    expect(input.preserve).toEqual(["bass"]);
    expect(input.roles).toEqual(["drums"]);
  });

  it("negated preserve protects nothing", () => {
    const { input } = parseIntentText("keep bass out, dark techno");
    expect(input.preserve).toBeUndefined();
  });
});

describe("contract compilation", () => {
  it("roadmap golden: hard / prohibition / preserve land in their sections", () => {
    const parsed = parseIntentText("142 bpm, temný trap, bez ďalších bicích; nechaj môj bass a akordy");
    const contract = compileBriefContract(parsed);
    const hard = sectionOf(contract.statements, "hard").map((s) => s.id);
    expect(hard).toContain("bpm");
    expect(byId(contract.statements, "bpm")?.label).toBe("142 BPM");
    const prohibitions = sectionOf(contract.statements, "prohibition");
    expect(prohibitions.map((s) => s.id)).toContain("no-drums");
    const preserve = sectionOf(contract.statements, "preserve").map((s) => s.role);
    expect(preserve).toEqual(["bass", "chords"]);
    // Protected roles are NOT in the generation set.
    const roles = byId(contract.statements, "roles");
    expect(roles?.label).not.toContain("basu");
    expect(roles?.label).not.toContain("akordy");
  });

  it.each([
    ["no drums", "no-drums", "drums"],
    ["no bass", "no-bass", "bass"],
    ["bez akordov", "no-chords", "chords"],
    ["without lead", "no-lead", "lead"],
  ] as const)("contract exposes the hard role prohibition: %s", (text, id, role) => {
    const contract = compileBriefContract(parseIntentText(text));
    expect(byId(contract.statements, id)).toMatchObject({ section: "prohibition", role });
    expect(byId(contract.statements, "roles")?.label).not.toContain(
      { drums: "bicie", bass: "basu", chords: "akordy", lead: "lead" }[role],
    );
  });

  it("unknown bpm/key surface as NEISTÉ, session fills them as inferred suggestions", () => {
    const bare = compileBriefContract(parseIntentText("nejaký beat"), {});
    expect(byId(bare.statements, "bpm")?.confidence).toBe("unknown");
    expect(byId(bare.statements, "key")?.confidence).toBe("unknown");
    expect(byId(bare.statements, "bpm")?.patch).toBeNull();

    const suggested = compileBriefContract(parseIntentText("nejaký beat"), {
      session: sessionWith({ bpm: "132", key: "E Natural Minor" }),
    });
    const bpm = byId(suggested.statements, "bpm");
    expect(bpm?.origin).toBe("session");
    expect(bpm?.confidence).toBe("inferred");
    expect(bpm?.patch).toEqual({ bpmRange: [128, 136] });
    expect(byId(suggested.statements, "key")?.patch).toEqual({ key: "E Natural Minor" });
  });

  it("genre falls back visibly: default without session, one-click suggestion with it", () => {
    const bare = compileBriefContract(parseIntentText("rýchle, agresívne"), {});
    const bareGenre = byId(bare.statements, "genre");
    expect(bareGenre?.origin).toBe("default");
    expect(bareGenre?.label).toContain("predvolené");

    const suggested = compileBriefContract(parseIntentText("rýchle, agresívne"), {
      session: sessionWith({ genre: "trap" }),
    });
    const genre = byId(suggested.statements, "genre");
    expect(genre?.patch).toEqual({ genre: "trap" });
  });

  it("parsed length + character + mood read as preferences/hard facts", () => {
    const parsed = parseIntentText("temný drill 8 taktov, hustý, pri 142");
    const contract = compileBriefContract(parsed);
    expect(byId(contract.statements, "length")?.label).toBe("8 taktov");
    expect(byId(contract.statements, "character")).toBeDefined();
  });

  it("user corrections replace parsed values and carry explicit provenance", () => {
    const parsed = parseIntentText("dark trap at 142");
    const contract = compileBriefContract(parsed, { corrections: { bpmRange: [128, 128], genre: "house" } });
    const bpm = byId(contract.statements, "bpm");
    const genre = byId(contract.statements, "genre");
    expect(bpm).toMatchObject({ label: "128 BPM", origin: "user", confidence: "confirmed" });
    expect(genre).toMatchObject({ label: "žáner: house", origin: "user", confidence: "confirmed" });
  });

  it("corrected generation roles are reflected as user-confirmed facts", () => {
    const parsed = parseIntentText("dark trap");
    const contract = compileBriefContract(parsed, {
      defaultRoles: ["drums", "bass"],
      corrections: { roles: ["drums", "lead"] },
    });
    expect(byId(contract.statements, "roles")).toMatchObject({
      label: "generovať: bicie, lead",
      origin: "user",
      confidence: "confirmed",
    });
  });

  it("publishes a readable conflict and clears preserve conflicts after explicit unprotect", () => {
    const parsed = parseIntentText("keep my kick but add snare");
    const conflicted = compileBriefContract(parsed);
    expect(conflicted.conflicts[0]?.label).toMatch(/zachovať bicie.*pridať ďalšie/i);

    const corrections = unprotectRole(parsed.input, "drums", ["drums", "bass"]);
    const resolved = compileBriefContract(parsed, { corrections });
    expect(resolved.conflicts).toEqual([]);
    expect(byId(resolved.statements, "preserve-drums")).toBeUndefined();
  });

  it("explains a hard prohibition conflicting with an explicit full-beat scope", () => {
    const contract = compileBriefContract(parseIntentText("no bass, full beat"));
    expect(contract.conflicts[0]?.label).toMatch(/zákaz generovania basy.*rozsah/i);
  });

  it("resolves a scope conflict when a user correction excludes the prohibited role", () => {
    const parsed = parseIntentText("no bass, full beat");
    const contract = compileBriefContract(parsed, { corrections: { roles: ["drums", "chords"] } });
    expect(contract.conflicts).toEqual([]);
    expect(byId(contract.statements, "roles")?.label).not.toContain("basu");
  });

  it("shows which active-pattern track a protected melodic role resolves to", () => {
    const doc = createProjectFromTemplate("house");
    const parsed = parseIntentText("nechaj akordy");
    const withProject = compileBriefContract(parsed, { project: doc });
    expect(byId(withProject.statements, "preserve-chords")).toMatchObject({
      confidence: "parsed",
      label: expect.stringContaining("track „Chords“, aktívny pattern"),
    });
  });

  it("does not claim an absent melodic source track can be preserved", () => {
    const doc = createProjectFromTemplate("empty");
    const parsed = parseIntentText("nechaj akordy");
    const withProject = compileBriefContract(parsed, { project: doc });
    expect(byId(withProject.statements, "preserve-chords")).toMatchObject({
      confidence: "inferred",
      label: expect.stringContaining("instrument track chýba"),
    });
  });

  it("compilation is deterministic", () => {
    const parsed = parseIntentText("dark trap at 142, keep my bass");
    const a = compileBriefContract(parsed, { session: sessionWith({ bpm: "140" }) });
    const b = compileBriefContract(parsed, { session: sessionWith({ bpm: "140" }) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("empty prompt still compiles (never blocks generation)", () => {
    const contract = compileBriefContract(null, {});
    expect(contract.statements.length).toBeGreaterThan(0);
    expect(sectionOf(contract.statements, "unknown").length).toBeGreaterThan(0);
  });
});

describe("per-point fixes", () => {
  it("unprotectRole returns the role to the generation set", () => {
    const patch = unprotectRole({ roles: ["drums"], preserve: ["bass", "chords"] }, "bass", ["drums", "bass"]);
    expect(patch.roles).toEqual(["drums", "bass"]);
    expect(patch.preserve).toEqual(["chords"]);
  });

  it("unprotecting the last role emits an explicit empty list to clear the parsed preserve", () => {
    const patch = unprotectRole({ preserve: ["bass"] }, "bass", ["drums", "bass"]);
    expect(patch.roles).toEqual(["drums", "bass"]);
    expect(patch.preserve).toEqual([]);
  });

  it("unprotectRole patch clears the original preserve when shallow-merged", () => {
    const parsed = parseIntentText("keep my bass");
    const patch = unprotectRole(parsed.input, "bass", ["drums", "bass"]);
    expect({ ...parsed.input, ...patch }.preserve).toEqual([]);
  });

  it("unprotecting a prohibited role does not silently re-add it to generation", () => {
    const parsed = parseIntentText("no drums, keep my kick");
    const patch = unprotectRole(parsed.input, "drums", ["drums", "bass"], ["drums"]);
    expect(patch.preserve).toEqual([]);
    expect(patch.roles).not.toContain("drums");
    expect(compileBriefContract(parsed, { corrections: patch }).conflicts).toEqual([]);
  });

  it("an applied fix normalizes into the spec (BPM override)", () => {
    const spec = normalizeIntent({
      bpmRange: [142, 142],
      ...unprotectRole({ preserve: ["bass"] }, "bass", ["drums", "bass"]),
    });
    expect(spec.roles).toContain("bass");
    expect(spec.preserve).toBeUndefined();
  });
});

describe("preserve through normalize → schema → hash → plan", () => {
  it("normalize sanitizes to canonical role order and omits empty", () => {
    const spec = normalizeIntent({ preserve: ["lead", "drums", "guitar" as never] });
    expect(spec.preserve).toEqual(["drums", "lead"]);
    const empty = normalizeIntent({ preserve: [] });
    expect(Object.keys(empty)).not.toContain("preserve");
  });

  it("schema validates preserve", () => {
    expect(validateIntentSpec(normalizeIntent({ preserve: ["bass"] }))).toEqual([]);
    const bad = { ...normalizeIntent({}), preserve: ["guitar"] };
    expect(validateIntentSpec(bad).length).toBeGreaterThan(0);
  });

  it("preserve participates in the intent hash", () => {
    const without = normalizeIntent({});
    const withPreserve = normalizeIntent({ preserve: ["bass"] });
    expect(intentHash(withPreserve)).not.toBe(intentHash(without));
  });

  it("plan/options exclude protected roles from generation", () => {
    const doc = createProjectFromTemplate("house");
    const spec = normalizeIntent({ roles: ["drums", "bass", "chords"], preserve: ["bass"] });
    const options = generateOptionsFromIntent(spec);
    expect(options.roles).toEqual(["drums", "chords"]);

    const plan = planGeneration(spec, doc);
    expect(plan.rolePlans.bass.enabled).toBe(false);
    expect(plan.rolePlans.bass.targetTrackIds).toEqual([]);
    expect(plan.rolePlans.drums.enabled).toBe(true);
    expect(plan.rolePlans.chords.enabled).toBe(true);
  });

  it("generation with preserve leaves the protected role out of the proposal set", () => {
    const spec = normalizeIntent({ roles: ["drums", "bass"], preserve: ["bass"], seed: "contract-test" });
    const options = generateOptionsFromIntent(spec);
    expect(options.roles).toEqual(["drums"]);
    expect(spec.roles).toEqual(["drums", "bass"]);
  });
});
