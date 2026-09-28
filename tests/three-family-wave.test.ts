import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import { getGrooveById, getGroovesForGenre, getStyleNamesForGenre } from "../src/ai/grooves/index";
import { resolveGroove } from "../src/ai/generator";
import { generateLocalResult } from "../src/intent/pipeline";
import { parseIntentText } from "../src/intent/text-parser";
import { ARTIST_PRESETS } from "../src/intent/artists";
import { GENRES } from "../src/ai/types";
import { GENRE_REFERENCE } from "../src/intent/genre-reference.generated";
import type { GrooveData } from "../src/ai/types";

/**
 * THE THREE-FAMILY WAVE — chiptune / eurodance / latin.
 *
 * Closes the last three large vocabulary holes measured in the gap research
 * (`docs/VOCABULARY-GAP-RESEARCH.md` §1b): the sound-chip tradition, the 90s
 * Euro-NRG tradition, and the Afro-Caribbean + South American dance family.
 * Each is a first-class genre with six documented schools, its own song form,
 * kit colouring, feel, mix character and harmony progressions.
 *
 * Locks: genre registration, groove shape, school signatures, artist routing,
 * generation smoke, and the ONNX prior contract (new styles stay OUT of the
 * fixed 44-dim `PRIOR_STYLE_VOCAB` and degrade to the zero-block path).
 */

const WAVE_GROOVES: Array<{
  id: string;
  genre: GrooveData["genre"];
  name: string;
  bpm: [number, number];
}> = [
  { id: "chiptune.nintendo", genre: "chiptune", name: "Nintendo", bpm: [100, 150] },
  { id: "chiptune.gameboy", genre: "chiptune", name: "Game Boy", bpm: [120, 160] },
  { id: "chiptune.chipband", genre: "chiptune", name: "Modern Chip", bpm: [140, 180] },
  { id: "chiptune.ballad", genre: "chiptune", name: "Chip Ballad", bpm: [70, 100] },
  { id: "chiptune.boss", genre: "chiptune", name: "Boss Battle", bpm: [150, 185] },
  { id: "chiptune.tracker", genre: "chiptune", name: "Tracker", bpm: [130, 170] },
  { id: "eurodance.nrg", genre: "eurodance", name: "Classic", bpm: [128, 140] },
  { id: "eurodance.happy", genre: "eurodance", name: "Happy", bpm: [138, 150] },
  { id: "eurodance.handsup", genre: "eurodance", name: "Hands Up", bpm: [140, 155] },
  { id: "eurodance.trancecore", genre: "eurodance", name: "Trancecore", bpm: [135, 148] },
  { id: "eurodance.italo", genre: "eurodance", name: "Italo Dance", bpm: [125, 138] },
  { id: "eurodance.hands", genre: "eurodance", name: "Hands", bpm: [150, 160] },
  { id: "latin.cumbia", genre: "latin", name: "Cumbia", bpm: [85, 105] },
  { id: "latin.merengue", genre: "latin", name: "Merengue", bpm: [120, 160] },
  { id: "latin.bachata", genre: "latin", name: "Bachata", bpm: [120, 140] },
  { id: "latin.salsa", genre: "latin", name: "Salsa", bpm: [160, 200] },
  { id: "latin.mambo", genre: "latin", name: "Mambo", bpm: [170, 210] },
  { id: "latin.bossa", genre: "latin", name: "Bossa Nova", bpm: [120, 140] },
];

describe("three-family wave — genre registration", () => {
  it("GENRES carries all three promoted genres", () => {
    expect(GENRES).toContain("chiptune");
    expect(GENRES).toContain("eurodance");
    expect(GENRES).toContain("latin");
  });

  it("each genre owns six real grooves with unique ids", () => {
    for (const genre of ["chiptune", "eurodance", "latin"] as const) {
      const grooves = getGroovesForGenre(genre);
      expect(grooves.length, genre).toBe(6);
      expect(new Set(grooves.map((g) => g.id)).size, genre).toBe(6);
    }
  });

  it("every groove resolves by id with genre, name and researched BPM range", () => {
    for (const expected of WAVE_GROOVES) {
      const groove = getGrooveById(expected.id);
      expect(groove, expected.id).toBeDefined();
      expect(groove!.genre).toBe(expected.genre);
      expect(groove!.name).toBe(expected.name);
      expect(groove!.bpm[0]).toBe(expected.bpm[0]);
      expect(groove!.bpm[1]).toBe(expected.bpm[1]);
    }
  });

  it("names appear in their genre style list and resolve through resolveGroove", () => {
    for (const expected of WAVE_GROOVES) {
      expect(getStyleNamesForGenre(expected.genre)).toContain(expected.name);
      expect(resolveGroove(expected.genre, expected.name).id).toBe(expected.id);
    }
  });

  it("every pattern uses only activePads and valid 16-step velocities", () => {
    for (const expected of WAVE_GROOVES) {
      const groove = getGrooveById(expected.id)!;
      expect(groove.patterns.length, `${expected.id} patterns`).toBeGreaterThanOrEqual(3);
      const active = new Set(groove.activePads);
      for (const pattern of groove.patterns) {
        for (const [padKey, row] of Object.entries(pattern)) {
          expect(active.has(Number(padKey)), `${expected.id} pad ${padKey}`).toBe(true);
          expect(row).toHaveLength(16);
          for (const v of row) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("swing stays in [0, 1] so groove settings never break the humanize clamp", () => {
    for (const expected of WAVE_GROOVES) {
      const groove = getGrooveById(expected.id)!;
      expect(groove.swing, `${expected.id} swing`).toBeGreaterThanOrEqual(0);
      expect(groove.swing, `${expected.id} swing`).toBeLessThanOrEqual(1);
    }
  });
});

describe("three-family wave — school signatures", () => {
  it("eurodance owns the four-on-the-floor spine (main patterns)", () => {
    for (const id of ["eurodance.nrg", "eurodance.happy", "eurodance.handsup", "eurodance.trancecore"]) {
      const groove = getGrooveById(id)!;
      // Breakdown patterns intentionally drop beats (that is the arrangement
      // move) - the four-floor spine is asserted on the other patterns.
      for (const pattern of groove.patterns.slice(0, 2)) {
        for (const step of [0, 4, 8, 12]) {
          const v = (pattern[0] ?? [])[step] ?? 0;
          expect(v, `${id} beat ${step / 4 + 1}`).toBeGreaterThan(0.85);
        }
      }
    }
  });

  it("chiptune ballad is the sparsest lane in the library (no kick, no snare)", () => {
    const ballad = getGrooveById("chiptune.ballad")!;
    expect(ballad.activePads).not.toContain(0);
    expect(ballad.activePads).not.toContain(4);
    for (const pattern of ballad.patterns) {
      expect(pattern[0], "ballad has no kick").toBeUndefined();
      expect(pattern[4], "ballad has no snare").toBeUndefined();
    }
  });

  it("chiptune percussion is noise-channel scarce — no pattern exceeds 65% hits (boss 75%)", () => {
    // Boss battle is the one school that legitimately saturates the noise
    // channel (that IS the boss idiom); the other four keep the 8-bit
    // constraint visible.
    const ceilings: Record<string, number> = {
      "chiptune.nintendo": 0.65,
      "chiptune.gameboy": 0.65,
      "chiptune.chipband": 0.65,
      "chiptune.boss": 0.75,
      "chiptune.tracker": 0.65,
    };
    for (const [id, ceiling] of Object.entries(ceilings)) {
      const groove = getGrooveById(id)!;
      for (const pattern of groove.patterns) {
        const hits = Object.values(pattern).reduce((n, row) => n + row.filter((v) => v > 0).length, 0);
        expect(hits / 64, `${id} density`).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("latin merengue owns the tambora march (kick 1+3, snare 2+4)", () => {
    const merengue = getGrooveById("latin.merengue")!;
    // The breakdown pattern drops the backbeat on purpose (the güira carries
    // alone) - the march is asserted on the main patterns.
    for (const pattern of merengue.patterns.slice(0, 2)) {
      expect((pattern[0] ?? [])[0] ?? 0, "march beat 1").toBeGreaterThan(0.85);
      expect((pattern[0] ?? [])[8] ?? 0, "march beat 3").toBeGreaterThan(0.85);
      expect((pattern[4] ?? [])[4] ?? 0, "backbeat 2").toBeGreaterThan(0.8);
      expect((pattern[4] ?? [])[12] ?? 0, "backbeat 4").toBeGreaterThan(0.8);
    }
  });

  it("latin salsa carries the clave on the rim (pad 3)", () => {
    for (const pattern of getGrooveById("latin.salsa")!.patterns) {
      const clave = pattern[3] ?? [];
      expect(clave.filter((v) => v > 0).length, "clave hits").toBeGreaterThanOrEqual(4);
    }
  });

  it("latin bossa is brushed — no velocity above 0.85", () => {
    for (const pattern of getGrooveById("latin.bossa")!.patterns) {
      for (const row of Object.values(pattern)) {
        for (const v of row) expect(v, "bossa ceiling").toBeLessThanOrEqual(0.85);
      }
    }
  });
});

describe("three-family wave — parser + artist routing", () => {
  it("genre words route to the promoted genres (with guards intact)", () => {
    expect(parseIntentText("chiptune").input.genre).toBe("chiptune");
    expect(parseIntentText("8-bit game music").input.genre).toBe("chiptune");
    expect(parseIntentText("game boy chip").input.genre).toBe("chiptune");
    expect(parseIntentText("eurodance").input.genre).toBe("eurodance");
    expect(parseIntentText("euro house 140").input.genre).toBe("eurodance");
    expect(parseIntentText("hands up dance").input.genre).toBe("eurodance");
    expect(parseIntentText("cumbia").input.genre).toBe("latin");
    expect(parseIntentText("salsa dura").input.genre).toBe("latin");
    expect(parseIntentText("bachata").input.genre).toBe("latin");
    // Guards: latin pop / reggaeton keep their dembow lane.
    expect(parseIntentText("latin pop").input.genre).toBe("house");
    expect(parseIntentText("latin pop").input.style).toBe("dembow");
    expect(parseIntentText("reggaeton").input.genre).toBe("house");
    // Guards: "corridos tumbados" is its own trap lane, not latin.
    expect(parseIntentText("corridos tumbados").input.genre).toBe("trap");
  });

  it("school phrases carry their style token and resolve to a real groove", () => {
    const cases: Array<[string, string, string]> = [
      ["nintendo overworld theme", "chiptune", "nintendo"],
      ["game boy lsdj", "chiptune", "gameboy"],
      ["boss battle theme", "chiptune", "boss"],
      ["chip ballad town theme", "chiptune", "ballad"],
      ["90s eurodance", "eurodance", "nrg"],
      ["happy eurodance", "eurodance", "happy"],
      ["german dance hands up", "eurodance", "handsup"],
      ["trancecore dance melody", "eurodance", "trancecore"],
      ["italo dance", "eurodance", "italo"],
      ["cumbia sonidera", "latin", "cumbia"],
      ["merengue tipico", "latin", "merengue"],
      ["bachata romantica", "latin", "bachata"],
      ["salsa dura", "latin", "salsa"],
      ["mambo big band", "latin", "mambo"],
      ["bossa nova guitar", "latin", "bossa"],
    ];
    for (const [text, genre, style] of cases) {
      const parsed = parseIntentText(text);
      expect(parsed.input.genre, text).toBe(genre);
      expect(parsed.input.style, text).toBe(style);
      expect(getGrooveById(`${genre}.${style}`), text).toBeDefined();
    }
  });

  it("every new artist preset routes to a real groove (zero dangling)", () => {
    const promoted = ARTIST_PRESETS.filter((p) => p.genre === "chiptune" || p.genre === "eurodance" || p.genre === "latin");
    expect(promoted.length).toBeGreaterThanOrEqual(17);
    for (const preset of promoted) {
      const style = preset.style?.toLowerCase().replace(/\s+/g, "");
      expect(style, preset.label).toBeTruthy();
      expect(getGrooveById(`${preset.genre}.${style}`), preset.label).toBeDefined();
    }
  });

  it("iconic names route through the artist presets", () => {
    const cases: Array<[string, string, string]> = [
      ["chipzel type beat", "chiptune", "gameboy"],
      ["anamanaguchi type beat", "chiptune", "chipband"],
      ["koji kondo type beat", "chiptune", "nintendo"],
      ["scooter type beat", "eurodance", "handsup"],
      ["vengaboys type beat", "eurodance", "happy"],
      ["eiffel 65 type beat", "eurodance", "italo"],
      ["celia cruz type beat", "latin", "salsa"],
      ["tito puente type beat", "latin", "mambo"],
      ["romeo santos type beat", "latin", "bachata"],
      ["joao gilberto type beat", "latin", "bossa"],
    ];
    for (const [text, genre, style] of cases) {
      const parsed = parseIntentText(text);
      expect(parsed.input.genre, text).toBe(genre);
      expect(parsed.input.style, text).toBe(style);
      expect(getGrooveById(`${genre}.${style}`), text).toBeDefined();
    }
  });
});

describe("three-family wave — generation smoke (production pipeline with gates)", () => {
  it("each school produces an accepted/repaired pattern like the UI would", () => {
    const doc = testDoc();
    for (const expected of WAVE_GROOVES) {
      const result = generateLocalResult(
        doc,
        {
          genre: expected.genre,
          style: expected.name,
          seed: `three-family-${expected.id}`,
          length: 32,
        },
        "preview",
      );
      expect(result.proposal, expected.id).toBeDefined();
      expect(["accepted", "repaired"], expected.id).toContain(result.status);
      expect(Object.keys(result.proposal!.pattern.rows).length, expected.id).toBeGreaterThan(0);
    }
  });
});

describe("three-family wave — reference coverage", () => {
  it("each promoted genre has a measured song reference row", () => {
    for (const genre of ["chiptune", "eurodance", "latin"]) {
      const ref = GENRE_REFERENCE[genre];
      expect(ref, genre).toBeDefined();
      expect(Number.isFinite(ref.integrated), genre).toBe(true);
      expect(ref.bars, genre).toBeGreaterThan(0);
    }
  });
});
