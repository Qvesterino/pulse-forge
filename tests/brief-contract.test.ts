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

  it("preserve statement flags a missing project track honestly", () => {
    const doc = createProjectFromTemplate("house");
    const parsed = parseIntentText("nechaj akordy");
    const withProject = compileBriefContract(parsed, { project: doc });
    expect(byId(withProject.statements, "preserve-chords")?.confidence).toBe("parsed");
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

  it("unprotecting the last protected role drops the field entirely", () => {
    const patch = unprotectRole({ preserve: ["bass"] }, "bass", ["drums", "bass"]);
    expect(patch.roles).toEqual(["drums", "bass"]);
    expect(patch.preserve).toBeUndefined();
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
