import { describe, it, expect } from "vitest";
import { GENRES } from "../src/ai/types";
import { getGrooveById, getGroovesForGenre, getStyleNamesForGenre } from "../src/ai/grooves/index";
import { parseIntentText } from "../src/intent/text-parser";
import { planSongForm } from "../src/intent/song";
import { normalizeIntent } from "../src/intent/normalize";
import { GENRE_KIT_SWAPS, GENRE_FEEL } from "../src/intent/genre-kit";
import { planMixProfile, genreMasterTiltDb } from "../src/intent/mix";
import { selectProgression } from "../src/ai/harmony";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { resolveGroove } from "../src/ai/generator";
import { ARTIST_PRESETS } from "../src/intent/artists";

/**
 * Boom bap promotion — the biggest roster hole in the engine (25 trap.classic
 * presets hiding at trap tempo) became a first-class genre with the FULL school
 * tree: golden (90s NY breakbeat), jazz (jazz-rap refinement), lofi (Dilla
 * off-kilter), drumless (Alchemist sample-only), trapbap (the modern hybrid)
 * and modern (Griselda dusty-but-tight).
 */

const SCHOOLS = ["golden", "jazz", "lofi", "drumless", "trapbap", "modern"] as const;

describe("boom bap promotion (the six-school genre)", () => {
  it("GENRES carries boombap", () => {
    expect(GENRES).toContain("boombap");
  });

  it("all six schools exist as real grooves with unique ids and 16-step rows", () => {
    const grooves = getGroovesForGenre("boombap");
    // "At least the documented six, all unique" rather than an exact count:
    // the vocabulary-gap waves legitimately ADD schools to a promoted genre
    // (boombap is at 10 after the jazz/turntablism + afro-caribbean waves),
    // and an exact-count lock goes red on that growth while proving nothing.
    // The invariants that actually matter are locked below — every documented
    // school resolves as a real groove, ids stay unique, rows are 16 steps.
    expect(grooves.length).toBeGreaterThanOrEqual(SCHOOLS.length);
    expect(new Set(grooves.map((g) => g.id)).size).toBe(grooves.length);
    for (const school of SCHOOLS) {
      expect(getGrooveById(`boombap.${school}`), school).toBeDefined();
    }
    for (const groove of grooves) {
      expect(groove.genre).toBe("boombap");
      for (const pattern of groove.patterns) {
        for (const row of Object.values(pattern)) {
          expect(row, groove.id).toHaveLength(16);
        }
      }
    }
  });

  it("each school resolves through resolveGroove by id and by name", () => {
    for (const groove of getGroovesForGenre("boombap")) {
      const byId = resolveGroove("boombap", groove.id.slice("boombap.".length), () => 0);
      expect(byId.id, groove.id).toBe(groove.id);
      const byName = resolveGroove("boombap", groove.name.toLowerCase(), () => 0);
      expect(byName.id, groove.name).toBe(groove.id);
    }
    // Every documented school must be reachable as a STYLE name (the parser
    // resolves user text through this list), but the list may also carry the
    // later waves' schools.
    for (const school of SCHOOLS) {
      expect(getStyleNamesForGenre("boombap"), school).toContain(getGrooveById(`boombap.${school}`)!.name);
    }
  });

  it("schools are genuinely different pockets (BPM, swing, density)", () => {
    const golden = getGrooveById("boombap.golden")!;
    const lofi = getGrooveById("boombap.lofi")!;
    const drumless = getGrooveById("boombap.drumless")!;
    const trapbap = getGrooveById("boombap.trapbap")!;

    // Golden era sits at the 86-96 breakbeat pocket.
    expect(golden.bpm[0]).toBeGreaterThanOrEqual(84);
    expect(golden.bpm[1]).toBeLessThanOrEqual(98);
    // Lo-fi is SLOWER and swings harder than golden.
    expect(lofi.bpm[1]).toBeLessThan(golden.bpm[1]);
    expect(lofi.swing).toBeGreaterThan(golden.swing);
    // Drumless has no backbeat (pad 4 absent from every pattern).
    for (const pattern of drumless.patterns) {
      expect(pattern[4], "drumless must not carry a backbeat").toBeUndefined();
    }
    // Trapbap rides the trap-adjacent tempo.
    expect(trapbap.bpm[0]).toBeGreaterThanOrEqual(120);
  });

  it("parser routes every school phrase to boombap", () => {
    expect(parseIntentText("boom bap beat").input.genre).toBe("boombap");
    expect(parseIntentText("boombap at 90").input.genre).toBe("boombap");
    expect(parseIntentText("golden era hip hop").input.genre).toBe("boombap");
    expect(parseIntentText("jazz rap beat").input.genre).toBe("boombap");
    expect(parseIntentText("jazz rap beat").input.style).toBe("jazz");
    expect(parseIntentText("drumless loop").input.genre).toBe("boombap");
    expect(parseIntentText("drumless loop").input.style).toBe("drumless");
    expect(parseIntentText("trap bap beat").input.genre).toBe("boombap");
    expect(parseIntentText("trap bap beat").input.style).toBe("trapbap");
    expect(parseIntentText("griselda type beat").input.genre).toBe("boombap");
  });

  it("guards: electro hip hop / lofi hip hop keep their own lanes", () => {
    // The 80s machine-funk lane must not be stolen by the boom-bap hip-hop entry.
    const electro = parseIntentText("electro hip hop");
    expect(electro.input.genre).toBe("trap");
    expect(electro.input.style).toBe("oldschool");
    // Lo-fi hip hop is the ambient study-beats lane.
    expect(parseIntentText("lofi hip hop").input.genre).toBe("ambient");
    // Bare "hip hop" now lands on the boom-bap floor.
    expect(parseIntentText("hip hop beat").input.genre).toBe("boombap");
  });

  it("boom bap has a song form and a BPM default at the breakbeat pocket", () => {
    const form = planSongForm(normalizeIntent({ genre: "boombap", seed: "bb" }));
    expect(form.sections.length).toBeGreaterThanOrEqual(5);
    // The 90s shape: 16-bar verses, no drop labels.
    expect(form.sections.some((s) => s.bars === 16 && s.role === "verse")).toBe(true);
    expect(form.sections.some((s) => s.label.toLowerCase().includes("drop"))).toBe(false);
    expect(form.sections.some((s) => s.label.includes("Hook"))).toBe(true);
  });

  it("kit colouring + feel + mix character land on real assets", () => {
    const swaps = GENRE_KIT_SWAPS.boombap ?? [];
    expect(swaps.length).toBeGreaterThan(0);
    for (const swap of swaps) {
      expect(
        FACTORY_ASSETS.some((a) => a.id === swap.assetId),
        `pad ${swap.index} asset ${swap.assetId}`,
      ).toBe(true);
    }
    // The knock kick is the boom-bap signature asset.
    expect(swaps.some((s) => s.assetId === "factory.kick.knock")).toBe(true);
    expect(GENRE_FEEL.boombap).toBeDefined();
    // Boom bap humanizes HARDER than techno (sampled breaks are never locked).
    expect(GENRE_FEEL.boombap!.humanizeTiming).toBeGreaterThan(GENRE_FEEL.techno!.humanizeTiming);
    // Warm tone default + character-genre treatment.
    expect(genreMasterTiltDb("boombap")).toBeGreaterThan(0);
    const mix = planMixProfile(normalizeIntent({ genre: "boombap", seed: "bb", energy: 0.8 }));
    expect(mix.summary.some((s) => s.startsWith("punch:"))).toBe(true);
  });

  it("harmony progressions exist for the genre", () => {
    const progression = selectProgression("boombap", 0);
    expect(progression.genre).toBe("boombap");
    expect(progression.events.length).toBeGreaterThanOrEqual(3);
  });

  it("the school tree is populated by real artists", () => {
    const byLabel = new Map(ARTIST_PRESETS.map((p) => [p.label, p]));
    // Golden architects
    expect(byLabel.get("dj premier")?.style).toBe("golden");
    expect(byLabel.get("pete rock")?.style).toBe("golden");
    // Jazz rap
    expect(byLabel.get("a tribe called quest")?.style).toBe("jazz");
    expect(byLabel.get("de la soul")?.style).toBe("jazz");
    // Lo-fi / Dilla
    expect(byLabel.get("j dilla")?.style).toBe("lofi");
    expect(byLabel.get("madlib")?.style).toBe("lofi");
    // Drumless
    expect(byLabel.get("the alchemist")?.style).toBe("drumless");
    expect(byLabel.get("billy woods")?.style).toBe("drumless");
    // Modern
    expect(byLabel.get("griselda")?.genre).toBe("boombap");
    expect(byLabel.get("griselda")?.style).toBe("modern");
    // The legacy golden-era rappers moved off trap.classic onto real schools
    expect(byLabel.get("2pac")?.genre).toBe("boombap");
    expect(byLabel.get("biggie")?.genre).toBe("boombap");
    expect(byLabel.get("nas / ny boom bap")?.genre).toBe("boombap");
    expect(byLabel.get("mf doom")?.style).toBe("golden");
  });
});
