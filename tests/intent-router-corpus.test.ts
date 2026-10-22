import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { routeIntentText } from "../src/intent/route";
import { ROUTE_PRECEDENCE } from "../src/intent/route-precedence";
import { ROUTE_ADJUSTMENT } from "../src/intent/apply-boundary";
import { buildCapabilityMatrix } from "../src/intent/semantics/param-registry";
import { planIntent } from "../src/intent/semantics/intent-plan";
import { gateModelRoute } from "../src/intent/model-route-gate";
import { parseFaderIntent } from "../src/intent/conversation";
import { parseEffectIntent } from "../src/intent/mix";
import { testDoc } from "./fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * F2 ADVERSARIAL ROUTER CORPUS (docs/INTENT-AUDIT-2026-10.md).
 *
 * Prompt × expected-route matrix over `routeIntentText` — the unified intent
 * bar's least-destructive priority chain (arrange → exact → fader → compound
 * → loudness → tempo/vibe → effectIntent → production → mix → revise →
 * pattern). Every entry states the route the DOCUMENTED semantics promise;
 * a red here is a finding, not noise. Selection-dependent kinds
 * (selectedStepAssist, selectedClipArrange, selectedRangeArrange,
 * checkpoints on a live session) are out of scope for this static corpus.
 */

interface Case {
  text: string;
  kind: string;
  /** Extra assertion on the routed intent (receives the whole RoutedIntent). */
  check?: (route: ReturnType<typeof routeIntentText>) => void;
  /** Use a doc with arrangement scenes (arrange/sectionFlow eligibility). */
  scenes?: boolean;
}

const doc = testDoc();
const sceneDoc: ProjectDocument = {
  ...testDoc(),
  scenes: [
    { id: "scene-intro", name: "Intro", patternId: "p1", role: "intro", intensity: 0.4 },
    { id: "scene-drop", name: "Drop A", patternId: "p2", role: "drop", intensity: 1 },
    { id: "scene-bridge", name: "Bridge", patternId: "p3", role: "bridge", intensity: 0.3 },
    { id: "scene-verse", name: "Verse 1", patternId: "p4", role: "verse", intensity: 0.6 },
    { id: "scene-chorus", name: "Chorus", patternId: "p5", role: "chorus", intensity: 0.9 },
  ],
} as unknown as ProjectDocument;

const CASES: Case[] = [
  // ── PATTERN — generation is the default, least destructive ──────────────
  { text: "dark rolling techno at 140", kind: "pattern" },
  { text: "hard techno 150 bpm", kind: "pattern" },
  { text: "dark techno at 142 bpm", kind: "pattern" },
  { text: "trap at 140 bpm with dark lead", kind: "pattern" },
  { text: "travis scott type beat", kind: "pattern" },
  { text: "melodic techno at 128, žiadne bicie", kind: "pattern" },
  { text: "beat only, dark trap at 142", kind: "pattern" },
  { text: "house groovy 124, nechaj bass a akordy", kind: "pattern" },
  { text: "wobbly drill with a 16-bar intro and a vinyl break", kind: "pattern" },
  { text: "amber freddy typu beat", kind: "pattern" },
  { text: "asdkjh qwer zxcv", kind: "pattern" },
  { text: "lofi hip hop for studying", kind: "pattern" },

  // ── EXACT — explicit mixer commands with explicit targets ──────────────
  { text: "mute the drums", kind: "exact" },
  { text: "unmute drums", kind: "exact" },
  { text: "mute everything", kind: "exact" },
  { text: "solo the bass", kind: "exact" },
  { text: "soluj basu", kind: "exact" },
  { text: "pan the bass left 30", kind: "exact" },
  { text: "transpose the lead up one octave", kind: "exact" },
  { text: "posun lead hore o 2 semitony", kind: "exact" },
  { text: "set tempo to 142", kind: "exact" },
  { text: "hard techno tempo to 150", kind: "exact" },
  { text: "142 bpm", kind: "exact" },
  { text: "tempo 140", kind: "exact" },

  // ── FADER — a NAMED track fader ask beats the loudness loop ────────────
  { text: "zníž basu", kind: "fader" },
  { text: "zníž basu trochu", kind: "fader" },
  { text: "louder drums", kind: "fader" },
  { text: "hlasnejšie bicie", kind: "fader" },
  { text: "turn down the drums", kind: "fader" },
  { text: "hlasitosť 808s o 10 %", kind: "fader" },
  { text: "kick ťažší", kind: "fader" },
  { text: "haty tichšie", kind: "fader" },
  { text: "zníž hlasitosť basu", kind: "fader" },

  // ── COMPOUND — several clause asks in one sentence ─────────────────────
  { text: "zníž basu a zvýš lead", kind: "compound" },
  { text: "zníž tempo a zvýš lead", kind: "compound" },
  { text: "zníž tempo na 128 a zvýš lead", kind: "compound" },
  { text: "viac delayu na leade a zníž basu", kind: "compound" },

  // ── LOUDNESS — untargeted shouts and explicit LUFS targets ─────────────
  { text: "make it louder", kind: "loudness" },
  { text: "make it quieter", kind: "loudness" },
  { text: "loudness na −9", kind: "loudness" },
  { text: "loudness to -9 lufs", kind: "loudness" },
  { text: "hlasitejši", kind: "loudness" },
  { text: "potichu", kind: "loudness" },
  { text: "quieter", kind: "loudness" },

  // ── TEMPO — explicit tempo words (no genre context) ────────────────────
  { text: "tempo na 128", kind: "tempo" },
  { text: "zrýchli to", kind: "tempo" },
  { text: "pomalší", kind: "tempo" },
  { text: "slower", kind: "tempo" },
  { text: "faster", kind: "tempo" },

  // ── EFFECT INTENT — targeted effect requests beat the mix profile ──────
  { text: "viac delayu na leade", kind: "effectIntent" },
  { text: "more delay on the lead", kind: "effectIntent" },
  { text: "remove reverb from the bass", kind: "effectIntent" },
  { text: "bez reverbu na basu", kind: "effectIntent" },
  { text: "menej delayu na bicí", kind: "effectIntent" },
  { text: "huge reverb on the chords", kind: "effectIntent" },

  // ── PRODUCTION — sonic goal WITH an explicit target track ──────────────
  { text: "make the drums darker", kind: "production" },
  { text: "make the bass deeper", kind: "production" },
  { text: "dirtier lead", kind: "production" },
  { text: "brighter chords", kind: "production" },

  // ── MIX — sound processing without a named target ──────────────────────
  { text: "more reverb", kind: "mix" },
  { text: "punchier", kind: "mix" },
  { text: "darker mix", kind: "mix" },
  { text: "tmavsi zvuk", kind: "mix" },
  { text: "tmavší zvuk", kind: "mix" },
  { text: "viac dozvuku", kind: "mix" },
  { text: "bez pumpy", kind: "mix" },
  { text: "darker", kind: "mix" },

  // ── REVISE — content sliders on the last result ────────────────────────
  { text: "more energetic", kind: "revise" },
  { text: "more energic", kind: "revise" },
  { text: "calmer", kind: "revise" },
  { text: "busier", kind: "revise" },
  { text: "menej husty", kind: "revise" },
  {
    text: "make the bridge more energic",
    kind: "revise",
    check: (r) => {
      if (r.kind !== "revise") return;
      expect((r as { targetRole: string | null }).targetRole).toBe("bridge");
    },
    scenes: true,
  },
  {
    text: "refren viac energie",
    kind: "revise",
    check: (r) => {
      if (r.kind !== "revise") return;
      expect((r as { targetRole: string | null }).targetRole).toBe("chorus");
    },
    scenes: true,
  },

  // ── ARRANGE — needs scenes; least destructive wins only when parseable ─
  { text: "shorten the intro", kind: "arrange", scenes: true },
  { text: "skráť intro", kind: "arrange", scenes: true },
  { text: "add a break before the drop", kind: "arrange", scenes: true },
  { text: "pridaj break pred drop", kind: "arrange", scenes: true },
  { text: "duplicate the chorus", kind: "arrange", scenes: true },
  { text: "zdvojnásob refren", kind: "arrange", scenes: true },
  { text: "duplikuj refren", kind: "arrange", scenes: true },
  { text: "remove the bridge", kind: "arrange", scenes: true },

  // ── TRANSPORT / SAVE / EXPORT / RECORD ─────────────────────────────────
  { text: "play", kind: "transport" },
  { text: "stop", kind: "transport" },
  { text: "pause", kind: "transport" },
  { text: "save", kind: "save" },
  { text: "ulož projekt", kind: "save" },
  { text: "export wav", kind: "export" },
  { text: "exportuj mp3", kind: "export" },
  { text: "record", kind: "record" },

  // ── UNDO / QUERY ───────────────────────────────────────────────────────
  { text: "undo", kind: "undoIntent" },
  { text: "späť", kind: "undoIntent" },
  { text: "redo", kind: "undoIntent" },
  { text: "koľko trackov má projekt", kind: "queryIntent" },
  { text: "how many tracks are there", kind: "queryIntent" },

  // ── SELECT / PRESET ────────────────────────────────────────────────────
  { text: "select the lead", kind: "select" },

  // ── CLARIFY — ambiguity asks instead of guessing ───────────────────────
  { text: "zníž", kind: "clarify" },

  // ── PRIORITY ADJUDICATION — the documented least-destructive chain ─────
  // D8 RESOLVED (owner decision 2026-10-11, "genre wins"): a tone
  // comparative inside a genre prompt is a descriptive adjective — the
  // prompt generates. Bare comparatives (no genre) keep the legacy mix
  // route; explicit mix nouns (reverb/punch/pump) also stay mix with a
  // genre. The old §5.7 sentence ("comparatives = mix, period") is
  // superseded — see INTENT_ENGINE §5.7 and INTENT-AUDIT-2026-10 D8.
  { text: "darker techno at 130", kind: "pattern" },
  { text: "tmavší techno", kind: "pattern" },
  { text: "more energetic techno", kind: "pattern" },
  { text: "more reverb on the drop", kind: "effectIntent", scenes: true },
  { text: "make the drums quieter", kind: "fader" },
  { text: "shorten the intro and more energetic", kind: "arrange", scenes: true },

  // ── D7 fixed contract — a preset ask never silently becomes a new beat ──
  // In this cold-bank environment (no warmFactoryPresets in tests) targeted
  // preset asks clarify while the bank warms; target-less asks clarify the
  // family. The warm-bank routes (preset / presetUnknown) are covered by
  // the preset-intent suite — only the silent fall-through to generation
  // was the defect.
  { text: "load the trance preset on the lead", kind: "clarify" },
  { text: "načítaj preset techno na leade", kind: "clarify" },
  { text: "load preset trance", kind: "clarify" },
  { text: "load preset zz-never-exists", kind: "clarify" },
];

describe("F2 adversarial router corpus (INTENT-AUDIT-2026-10)", () => {
  for (const c of CASES) {
    const target = c.scenes ? sceneDoc : doc;
    it(`"${c.text}" → ${c.kind}${c.scenes ? " [scenes]" : ""}`, () => {
      const route = routeIntentText(c.text, target);
      expect(route.kind).toBe(c.kind);
      c.check?.(route);
    });
  }

  it("corpus size stays honest (≥ 100 cases)", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(100);
  });
});

/**
 * PRECEDENCE CONTRACT (2026-10-21).
 *
 * The table in `src/intent/route-precedence.ts` is the readable contract; this
 * suite pins the winners for the stages whose ORDER has actually mattered, and
 * guards the bug-prone relative positions both behaviorally and at the source
 * level. A reorder that keeps the table but changes the chain fails here.
 */
describe("route precedence contract", () => {
  interface PrecedenceCase {
    stage: string;
    text: string;
    kind: string;
    scenes?: boolean;
  }

  const CASES: PrecedenceCase[] = [
    { stage: "safety-fences", text: "don't make the bass quieter", kind: "clarify" },
    { stage: "transport-session", text: "stop", kind: "transport" },
    { stage: "undo-query", text: "undo that", kind: "undoIntent" },
    { stage: "undo-query", text: "how many tracks are there", kind: "queryIntent" },
    { stage: "complaint", text: "the lead is harsh", kind: "complaintIntent" },
    { stage: "descriptive-decline", text: "the bass is quieter than the lead", kind: "clarify" },
    // The two measured wrong-target bugs: param must beat tempo and fader.
    { stage: "param", text: "much faster compressor attack on the drums", kind: "paramIntent" },
    { stage: "param", text: "lower filter cutoff on the lead", kind: "paramIntent" },
    { stage: "studio-words", text: "more swing on the drums", kind: "grooveIntent" },
    { stage: "clips-arrange", text: "shorten the intro to 2 bars", kind: "arrange", scenes: true },
    { stage: "compound", text: "mute the drums and set tempo to 140", kind: "compound" },
    { stage: "exact", text: "mute the drums", kind: "exact" },
    { stage: "select-preset-scene", text: "select the bass", kind: "select" },
    {
      stage: "select-preset-scene",
      text: "set the drop intensity to 80%",
      kind: "sceneIntensity",
      scenes: true,
    },
    { stage: "send", text: "more reverb send on the lead", kind: "sendIntent" },
    { stage: "fader", text: "turn down the bass", kind: "fader" },
    { stage: "loudness-tempo", text: "make it louder", kind: "loudness" },
    { stage: "loudness-tempo", text: "zníž tempo", kind: "tempo" },
    { stage: "bypass", text: "bypass the delay on the lead", kind: "bypassIntent" },
    { stage: "effect", text: "even less reverb on the bass", kind: "effectIntent" },
    { stage: "production-mix", text: "make the bass warmer", kind: "production" },
    { stage: "production-mix", text: "make the mix brighter", kind: "mix" },
    { stage: "revise", text: "more energetic", kind: "revise" },
    { stage: "clarification", text: "make the reverb tail a little longer", kind: "clarify" },
    { stage: "pattern", text: "a beat that is dark and warm", kind: "pattern" },
  ];

  it("every declared stage is either exercised or explicitly context-only", () => {
    const stageById = new Map(ROUTE_PRECEDENCE.map((stage) => [stage.id, stage]));
    const covered = new Set<string>();
    for (const entry of CASES) {
      const stage = stageById.get(entry.stage);
      expect(stage, `unknown stage ${entry.stage}`).toBeDefined();
      const route = routeIntentText(entry.text, entry.scenes ? sceneDoc : doc);
      expect(route.kind, entry.text).toBe(entry.kind);
      covered.add(entry.stage);
    }
    for (const stage of ROUTE_PRECEDENCE) {
      if (stage.contextOnly) continue;
      expect(covered.has(stage.id), `stage ${stage.id} has no precedence case`).toBe(true);
    }
  });

  it("every route kind is classified in both contracts", () => {
    const inPrecedence = new Set(ROUTE_PRECEDENCE.flatMap((stage) => stage.kinds));
    for (const kind of Object.keys(ROUTE_ADJUSTMENT) as Array<keyof typeof ROUTE_ADJUSTMENT>) {
      expect(inPrecedence.has(kind), `route kind ${kind} has no precedence stage`).toBe(true);
    }
  });

  it("the bug-prone order is explicit in the table", () => {
    const at = (id: string): number => {
      const index = ROUTE_PRECEDENCE.findIndex((stage) => stage.id === id);
      expect(index, id).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at("safety-fences")).toBeLessThan(at("descriptive-decline"));
    expect(at("descriptive-decline")).toBeLessThan(at("param"));
    expect(at("param")).toBeLessThan(at("fader"));
    expect(at("param")).toBeLessThan(at("loudness-tempo"));
    expect(at("compound")).toBeLessThan(at("exact"));
    expect(at("exact")).toBeLessThan(at("fader"));
    expect(at("clips-arrange")).toBeLessThan(at("compound"));
    expect(at("clarification")).toBeLessThan(at("pattern"));
  });

  it("the implementation order still matches the contract", () => {
    const source = readFileSync("src/intent/route.ts", "utf8");
    const body = source.slice(source.indexOf("export function routeIntentText"));
    const at = (needle: string): number => {
      const index = body.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const safety = at("NEGATED_MUTATION_COMMAND.test(text)");
    const descriptive = at("isDescriptiveStatement(text)");
    const param = at("const paramIntent = parseParamIntent(text)");
    const compound = at("const compound = parseCompoundIntent(text)");
    const exact = at("const exact = parseExactIntent(text)");
    const fader = at("const fader = parseFaderIntent(text)");
    const tempo = at("const tempo = parseTempoIntent(text)");
    expect(safety).toBeLessThan(descriptive);
    expect(descriptive).toBeLessThan(param);
    expect(param).toBeLessThan(compound);
    expect(compound).toBeLessThan(exact);
    expect(exact).toBeLessThan(fader);
    expect(param).toBeLessThan(tempo);
    expect(fader).toBeLessThan(tempo);
  });
});

/**
 * DETERMINISTIC SCOREBOARD (2026-10-22).
 *
 * A repeatable precision report over the deterministic layer: route, target,
 * direction, degree/quantity and plan executability across every param family,
 * fader, effect and a negative/safety corpus. It is a corpus test, not a
 * benchmark: a failure is a finding, and the printed JSON is the scoreboard a
 * human can diff between sessions.
 */
describe("deterministic intent scoreboard", () => {
  const LEVELS: ReadonlyArray<readonly [number, string]> = [
    [1, "barely"],
    [2, "a touch"],
    [3, "slightly"],
    [4, "somewhat"],
    [5, "much"],
    [6, "a lot"],
    [7, "as much as possible"],
  ];

  interface Expected {
    kind: string;
    effectType?: string;
    paramId?: string;
    direction?: "up" | "down" | "more" | "less";
    degree?: number;
    target?: string;
    mutates: boolean;
  }

  const targetFromExample = (text: string): string | undefined => {
    if (/\bon the 808\b/.test(text)) return "bass";
    if (/\bon the drums\b/.test(text)) return "drums";
    if (/\bon the chords\b/.test(text)) return "chords";
    if (/\bon the lead\b/.test(text)) return "lead";
    return undefined;
  };

  const routes = (route: ReturnType<typeof routeIntentText>): string[] => {
    if (route.kind === "paramIntent" || route.kind === "effectIntent") return route.intent.targets;
    if (route.kind === "exact") {
      return route.plan.ops.flatMap((op) => ("target" in op && typeof op.target === "string" ? [op.target] : []));
    }
    if (route.kind === "fader") return [...route.intent.targets, ...(route.intent.pads ?? [])];
    return [];
  };

  it("scores the deterministic corpus at 100% and prints the report", () => {
    const doc = testDoc();
    const metrics = {
      cases: 0,
      route: 0,
      target: 0,
      direction: 0,
      degree: 0,
      plan: 0,
      safety: 0,
      failures: [] as string[],
    };
    const check = (text: string, expected: Expected): void => {
      metrics.cases += 1;
      const route = routeIntentText(text, doc);
      const plan = planIntent(doc, route);
      if (route.kind !== expected.kind) {
        metrics.failures.push(`${text}: route ${route.kind} != ${expected.kind}`);
        return;
      }
      metrics.route += 1;
      if (expected.target && !routes(route).includes(expected.target)) {
        metrics.failures.push(`${text}: target ${routes(route).join("+") || "-"} missing ${expected.target}`);
        return;
      }
      metrics.target += 1;
      if (expected.direction) {
        const actual =
          route.kind === "paramIntent"
            ? route.intent.mode
            : route.kind === "effectIntent"
              ? route.intent.direction
              : route.kind === "fader"
                ? route.intent.direction
                : undefined;
        if (actual !== expected.direction) {
          metrics.failures.push(`${text}: direction ${actual} != ${expected.direction}`);
          return;
        }
      }
      metrics.direction += 1;
      if (expected.degree != null) {
        const actual =
          route.kind === "paramIntent" || route.kind === "effectIntent" || route.kind === "fader"
            ? route.intent.degree?.level
            : undefined;
        if (actual !== expected.degree) {
          metrics.failures.push(`${text}: degree ${actual} != ${expected.degree}`);
          return;
        }
      }
      metrics.degree += 1;
      if (expected.kind === "paramIntent" && route.kind === "paramIntent") {
        if (route.intent.effectType !== expected.effectType || route.intent.paramId !== expected.paramId) {
          metrics.failures.push(
            `${text}: param ${route.intent.effectType}.${route.intent.paramId} != ${expected.effectType}.${expected.paramId}`,
          );
          return;
        }
      }
      if (expected.kind === "effectIntent" && route.kind === "effectIntent") {
        if (route.intent.effectType !== expected.effectType) {
          metrics.failures.push(`${text}: effect ${route.intent.effectType} != ${expected.effectType}`);
          return;
        }
      }
      if (expected.mutates) {
        if (!plan.executable || !plan.mutates || plan.steps.length === 0) {
          metrics.failures.push(`${text}: plan not executable/mutating (${plan.warnings.join("; ")})`);
          return;
        }
      } else {
        if (plan.mutates) {
          metrics.failures.push(`${text}: negative case mutated`);
          return;
        }
        metrics.safety += 1;
      }
      metrics.plan += 1;
    };

    // Param families × both directions × all seven levels.
    for (const row of buildCapabilityMatrix().filter((entry) => entry.exposedBy === "param")) {
      for (const direction of ["more", "less"] as const) {
        for (const [level, word] of LEVELS) {
          const text = row.examples[direction].replace("${degree}", word);
          check(text, {
            kind: "paramIntent",
            effectType: row.effectType,
            paramId: row.paramId,
            direction,
            degree: level,
            target: targetFromExample(text),
            mutates: true,
          });
        }
      }
    }

    // Fader up/down × all seven levels.
    for (const [level, word] of LEVELS) {
      check(`turn down the master ${word}`, {
        kind: "fader",
        direction: "down",
        degree: level,
        target: "master",
        mutates: true,
      });
      check(`turn up the master ${word}`, {
        kind: "fader",
        direction: "up",
        degree: level,
        target: "master",
        mutates: true,
      });
    }

    // Effect primary knob × both directions × all seven levels.
    for (const [level, word] of LEVELS) {
      check(`${word} more reverb on the pads`, {
        kind: "effectIntent",
        effectType: "reverb",
        direction: "more",
        degree: level,
        target: "chords",
        mutates: true,
      });
      check(`${word} less reverb on the pads`, {
        kind: "effectIntent",
        effectType: "reverb",
        direction: "less",
        degree: level,
        target: "chords",
        mutates: true,
      });
    }

    // Exact operations stay exact.
    check("lower the drums by 2 db", { kind: "exact", target: "drums", mutates: true });
    check("mute the drums", { kind: "exact", target: "drums", mutates: true });
    check("set tempo to 140", { kind: "exact", mutates: true });

    // Safety corpus: descriptions, negation, hypothetical and unresolvable
    // references must never mutate.
    for (const text of [
      "the bass is quieter than the lead",
      "the pads have too much reverb",
      "don't make the bass quieter",
      "the bass is as quiet as possible",
      "make the reverb tail a little longer",
      "the mix is significantly louder than the reference",
      "the bass is much less loud than the lead",
    ]) {
      check(text, { kind: "clarify", mutates: false });
    }

    console.log(
      "INTENT_SCOREBOARD " +
        JSON.stringify({
          cases: metrics.cases,
          routeAccuracy: Number((metrics.route / metrics.cases).toFixed(4)),
          targetAccuracy: Number((metrics.target / metrics.cases).toFixed(4)),
          directionAccuracy: Number((metrics.direction / metrics.cases).toFixed(4)),
          degreeAccuracy: Number((metrics.degree / metrics.cases).toFixed(4)),
          planAccuracy: Number((metrics.plan / metrics.cases).toFixed(4)),
          safety: Number((metrics.safety / 7).toFixed(4)),
          failures: metrics.failures.length,
        }),
    );
    expect(metrics.failures).toEqual([]);
    expect(metrics.cases).toBeGreaterThanOrEqual(250);
  });
});

/**
 * D (2026-10-22) — the deterministic layer gates every model proposal.
 *
 * The model is a fallback, not an authority: it may not overrule a specific
 * rule route, mutate from a description, or propose a mutation whose plan is
 * not executable. These tests use real parsed routes, not hand-built shapes.
 */
describe("model route gate", () => {
  const doc = testDoc();
  const fader = parseFaderIntent("turn down the bass")!;
  const effect = parseEffectIntent("slightly more reverb on the pads")!;
  const pattern = routeIntentText("a beat that is dark and warm", doc);

  it("rejects a model mutation from a description", () => {
    expect(gateModelRoute("the bass is quieter than the lead", { kind: "fader", intent: fader }, doc)).toBeNull();
  });

  it("returns the specific deterministic route instead of the model's", () => {
    const gated = gateModelRoute("turn down the bass", { kind: "effectIntent", intent: effect }, doc);
    expect(gated?.kind).toBe("fader");
  });

  it("accepts a model mutation only when its plan is executable", () => {
    expect(pattern.kind).toBe("pattern");
    const gated = gateModelRoute("a beat that is dark and warm", { kind: "effectIntent", intent: effect }, doc);
    expect(gated?.kind).toBe("effectIntent");

    // "on the lead" names no track in the house fixture: no executable plan.
    const noTarget = parseEffectIntent("more reverb on the lead")!;
    expect(gateModelRoute("a beat that is dark and warm", { kind: "effectIntent", intent: noTarget }, doc)).toBeNull();
  });

  it("rejects model generation and accepts a read-only answer", () => {
    expect(gateModelRoute("a beat that is dark and warm", pattern, doc)).toBeNull();
    expect(
      gateModelRoute("a beat that is dark and warm", { kind: "clarify", reason: "x", suggestions: [] }, doc)?.kind,
    ).toBe("clarify");
  });
});
