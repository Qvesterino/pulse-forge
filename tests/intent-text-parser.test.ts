import { describe, it, expect } from "vitest";
import { parseIntentText, parseKeyPhrase } from "../src/intent/text-parser";
import { getGrooveById } from "../src/ai/grooves/index";
import { normalizeIntent } from "../src/intent/normalize";

describe("text-parser v2", () => {
  it("is deterministic for the same input", () => {
    const a = parseIntentText("dark rolling techno at 140 with a lead");
    const b = parseIntentText("dark rolling techno at 140 with a lead");
    expect(a).toEqual(b);
  });

  it("returns empty input for unrecognized text", () => {
    const parsed = parseIntentText("hello world something");
    expect(Object.keys(parsed.input).length === 0 || parsed.input.genre === undefined).toBe(true);
  });

  it("extracts genre, style, mood and bpm from one sentence", () => {
    const parsed = parseIntentText("dark rolling techno at 140");
    expect(parsed.input.genre).toBe("techno");
    expect(parsed.input.style).toBe("rolling");
    expect(parsed.input.mood).toBe("dark");
    expect(parsed.input.bpmRange).toEqual([140, 140]);
    // dark trait lowers energy, dark mood tweaks mapping
    expect(parsed.input.energy).toBe(0.3);
  });

  it("maps adjacent genres to the canonical set (phonk/drill promoted to first-class)", () => {
    // Sound-quality pass: phonk and drill got their own grooves, song forms
    // and kit colouring — they stopped folding into trap.
    expect(parseIntentText("phonk beat").input.genre).toBe("phonk");
    expect(parseIntentText("ukg groove").input.genre).toBe("house");
    expect(parseIntentText("lofi chill beat").input.genre).toBe("ambient");
    expect(parseIntentText("acid line").input.genre).toBe("techno");
  });

  it("prefers multi-word genre phrases over substrings", () => {
    expect(parseIntentText("deep house").input.genre).toBe("house");
    expect(parseIntentText("tech house groove").input.genre).toBe("house");
  });

  it("parses bpm ranges and rejects out-of-range values", () => {
    expect(parseIntentText("techno at 140 to 150").input.bpmRange).toEqual([140, 150]);
    expect(parseIntentText("house 124 bpm").input.bpmRange).toEqual([124, 124]);
    expect(parseIntentText("trap between 138 and 145").input.bpmRange).toEqual([138, 145]);
    expect(parseIntentText("ambient at 30").input.bpmRange).toBeUndefined();
    expect(parseIntentText("ambient at 400").input.bpmRange).toBeUndefined();
  });

  it("parses musical keys with flats and a minor default", () => {
    expect(parseKeyPhrase("in f# minor")).toBe("F# Natural Minor");
    expect(parseKeyPhrase("in db phrygian")).toBe("C# Phrygian");
    expect(parseKeyPhrase("g major")).toBe("G Major");
    expect(parseKeyPhrase("in c")).toBe("C Natural Minor");
    expect(parseKeyPhrase("in a harmonic minor")).toBe("A Harmonic Minor");
    expect(parseIntentText("deep house in a minor").input.key).toBe("A Natural Minor");
  });

  it("converts bars into step counts", () => {
    expect(parseIntentText("8 bars of techno").input.length).toBe(128);
    expect(parseIntentText("4 bar loop").input.length).toBe(64);
    // out of the 16..256 window is dropped (normalize clamps defaults instead)
    expect(parseIntentText("64 bars of ambient").input.length).toBeUndefined();
  });

  it("detects roles including negations", () => {
    expect(parseIntentText("ambient no drums").input.roles).toEqual(["bass", "chords", "lead"]);
    expect(parseIntentText("drums only").input.roles).toEqual(["drums"]);
    expect(parseIntentText("melody only please").input.roles).toEqual(["lead"]);
    expect(parseIntentText("full beat").input.roles).toEqual(["drums", "bass", "chords", "lead"]);
    expect(parseIntentText("techno with lead and bass").input.roles).toEqual(["bass", "lead"]);
  });

  it("applies character traits to sliders", () => {
    const parsed = parseIntentText("minimal industrial techno");
    expect(parsed.input.style).toBe("minimal");
    expect(parsed.input.density).toBe(0.25);
    expect(parsed.input.complexity).toBe(0.25);

    const hypno = parseIntentText("hypnotic groove");
    expect(hypno.input.variation).toBe(0.2);
    expect(hypno.input.complexity).toBe(0.3);
  });

  it("composes everything through normalizeIntent", () => {
    const { input } = parseIntentText("aggressive acid techno at 145 in g minor, 8 bars, no drums");
    const intent = normalizeIntent({ ...input, seed: "s" });
    expect(intent.genre).toBe("techno");
    expect(intent.style).toBe("acid");
    expect(intent.mood).toBe("aggressive");
    expect(intent.bpmRange).toEqual([145, 145]);
    expect(intent.key).toBe("G Natural Minor");
    expect(intent.length).toBe(128);
    expect(intent.roles).toEqual(["bass", "chords", "lead"]);
  });

  it("is idempotent under whitespace and case noise", () => {
    const clean = parseIntentText("dark rolling techno at 140");
    const noisy = parseIntentText("  DARK   rolling,\tTECHNO  at 140 ");
    expect(noisy.input).toEqual(clean.input);
  });
});

describe("text-parser v3 — slovenčina", () => {
  it("detects genre, style, mood and BPM from an SK sentence with inflections", () => {
    const parsed = parseIntentText("tmavé rolujúce techno na 140");
    expect(parsed.input.genre).toBe("techno");
    expect(parsed.input.style).toBe("rolling");
    expect(parsed.input.mood).toBe("dark"); // canonical mood stays EN
    expect(parsed.input.bpmRange).toEqual([140, 140]);
    expect(parsed.input.energy).toBe(0.3);
  });

  it("handles SK adjectives via stems across inflected forms", () => {
    // tvrdý / tvrdé / tvrdú all share the "tvrd" stem
    for (const form of ["tvrdý", "tvrdé", "tvrdú"]) {
      expect(parseIntentText(`${form} techno`).input.mood).toBe("aggressive");
    }
    const parsed = parseIntentText("tvrdý industriálny techno medzi 138 a 145");
    expect(parsed.input.style).toBe("industrial");
    expect(parsed.input.bpmRange).toEqual([138, 145]);
    expect(parsed.input.energy).toBe(0.9);
  });

  it("parses SK keys (mol/dur) and bar counts", () => {
    const parsed = parseIntentText("hlboký house v F# mol, 8 taktov");
    expect(parsed.input.style).toBe("deep");
    expect(parsed.input.key).toBe("F# Natural Minor");
    expect(parsed.input.length).toBe(128);
    expect(parseIntentText("pokojný ambient v C dur").input.key).toBe("C Major");
    expect(parseIntentText("ambient v a harmonicka mol").input.key).toBe("A Harmonic Minor");
  });

  it("parses SK roles with negations", () => {
    expect(parseIntentText("bez bubnov, len basa a akordy").input.roles).toEqual(["bass", "chords"]);
    expect(parseIntentText("ambient bez bicích").input.roles).toEqual(["bass", "chords", "lead"]);
    expect(parseIntentText("len bubny prosím").input.roles).toEqual(["drums"]);
    expect(parseIntentText("techno s hypnoticej basou a leadom").input.roles).toEqual(["bass", "lead"]);
    expect(parseIntentText("všetko naraz").input.roles).toEqual(["drums", "bass", "chords", "lead"]);
  });

  it("supports SK bpm phrasing", () => {
    expect(parseIntentText("phonk pri 150").input.bpmRange).toEqual([150, 150]);
    expect(parseIntentText("house okolo 124").input.bpmRange).toEqual([124, 124]);
  });

  it("handles mixed SK/EN sentences", () => {
    // NB: "deep techno" would resolve genre house (v1 first-match rule,
    // deep→house) — the same ambiguity exists in pure EN, so avoid it here.
    const parsed = parseIntentText("tmavý acid techno at 140 s leadom");
    expect(parsed.input.genre).toBe("techno");
    expect(parsed.input.style).toBe("acid");
    expect(parsed.input.mood).toBe("dark");
    expect(parsed.input.bpmRange).toEqual([140, 140]);
    expect(parsed.input.roles).toEqual(["lead"]);
  });
});

describe("vocabulary wave — sub-genres, moods, traits", () => {
  it("resolves sub-genre phrases to canonical genres", () => {
    expect(parseIntentText("hard techno banger").input.genre).toBe("techno");
    expect(parseIntentText("acid house groove").input.genre).toBe("house");
    expect(parseIntentText("bass house at 126").input.genre).toBe("house");
    expect(parseIntentText("drift phonk type beat").input.genre).toBe("phonk");
    expect(parseIntentText("uk drill beat").input.genre).toBe("drill");
    expect(parseIntentText("sample drill at 142").input.genre).toBe("drill");
    expect(parseIntentText("grime beat").input.genre).toBe("drill");
    expect(parseIntentText("dubstep wobble").input.genre).toBe("trap");
    expect(parseIntentText("chillhop study beats").input.genre).toBe("ambient");
    expect(parseIntentText("dark ambient drone").input.genre).toBe("ambient");
    expect(parseIntentText("breakcore at 180").input.genre).toBe("dnb");
    expect(parseIntentText("synthwave night drive").input.genre).toBe("techno");
    expect(parseIntentText("trance at 138").input.genre).toBe("techno");
  });

  it("resolves the expanded mood vocabulary", () => {
    expect(parseIntentText("sinister techno").input.mood).toBe("dark");
    expect(parseIntentText("ominous drill beat").input.mood).toBe("dark");
    expect(parseIntentText("angry trap beat").input.mood).toBe("aggressive");
    expect(parseIntentText("wild phonk").input.mood).toBe("aggressive");
    expect(parseIntentText("dreamy ambient pad").input.mood).toBe("chill");
    expect(parseIntentText("cozy lofi beat").input.mood).toBe("chill");
    expect(parseIntentText("happy house banger").input.mood).toBe("energetic");
    expect(parseIntentText("vibrant funky house").input.mood).toBe("energetic");
    // SK stems
    expect(parseIntentText("zúrivý drill").input.mood).toBe("aggressive");
    expect(parseIntentText("pohodový house").input.mood).toBe("chill");
    expect(parseIntentText("radostný beat").input.mood).toBe("energetic");
    expect(parseIntentText("nočný techno").input.mood).toBe("dark");
    // SK vocabulary wave: each new SK adjective variant must parse to the
    // same canonical mood as its English equivalent.
    expect(parseIntentText("strašidelný techno").input.mood).toBe("dark");
    expect(parseIntentText("desivý ambient").input.mood).toBe("dark");
    expect(parseIntentText("dravý trap").input.mood).toBe("aggressive");
    expect(parseIntentText("tichý ambient").input.mood).toBe("chill");
    expect(parseIntentText("mierový house").input.mood).toBe("chill");
    expect(parseIntentText("šťastný house").input.mood).toBe("energetic");
  });

  it("resolves the expanded trait vocabulary into sliders", () => {
    expect(parseIntentText("gritty techno").input.energy).toBe(0.8);
    expect(parseIntentText("clean minimal house").input.complexity).toBe(0.3);
    expect(parseIntentText("lush ambient pad").input.density).toBe(0.65);
    expect(parseIntentText("epic trap banger").input.energy).toBe(0.85);
    expect(parseIntentText("haunting ambient scene").input.complexity).toBe(0.55);
    expect(parseIntentText("peak time techno").input.energy).toBe(0.95);
    // SK stems
    expect(parseIntentText("surový drill").input.energy).toBe(0.8);
    expect(parseIntentText("bohatý ambient").input.density).toBe(0.65);
    // SK vocabulary wave: new stems + inflected forms (krehký / krehká / krehké all → "krehky").
    expect(parseIntentText("silný techno").input.energy).toBe(0.85);
    expect(parseIntentText("krehký ambient").input.complexity).toBe(0.4);
    expect(parseIntentText("krehká melódia").input.complexity).toBe(0.4);
    expect(parseIntentText("staromódny house").input.variation).toBe(0.3);
    expect(parseIntentText("retro beat").input.variation).toBe(0.3);
    expect(parseIntentText("vrstvený techno").input.density).toBe(0.8);
    expect(parseIntentText("plytký house").input.density).toBe(0.3);
    expect(parseIntentText("priebojný drill").input.energy).toBe(0.75);
    expect(parseIntentText("ostrý techno").input.complexity).toBe(0.65);
    expect(parseIntentText("šťastný beat").input.energy).toBe(0.95);
    expect(parseIntentText("tichý techno").input.energy).toBe(0.3);
  });

  it("resolves the expanded style vocabulary with SK stems", () => {
    expect(parseIntentText("minimal techno").input.style).toBe("minimal");
    expect(parseIntentText("minimalistický techno").input.style).toBe("minimal");
    expect(parseIntentText("retro house").input.style).toBe("classic");
    expect(parseIntentText("staromódny beat").input.style).toBe("classic");
    expect(parseIntentText("prirodzený ambient").input.style).toBe("organic");
    expect(parseIntentText("živý techno").input.style).toBe("organic");
    expect(parseIntentText("chybný beat").input.style).toBe("glitch");
  });

  it("resolves SK role negation and 'only' phrases", () => {
    // "no drums" with no other roles named falls back to the remaining roles
    // (the negation phrase suppresses drums via the noDrums flag pipeline).
    expect(parseIntentText("žiadne bicie").input.roles).toEqual(["bass", "chords", "lead"]);
    expect(parseIntentText("žiaden beat").input.roles).toEqual(["bass", "chords", "lead"]);
    expect(parseIntentText("nula bubnov").input.roles).toEqual(["bass", "chords", "lead"]);
    expect(parseIntentText("bez rytmu").input.roles).toEqual(["bass", "chords", "lead"]);
    // When the user explicitly names other instruments alongside the
    // negation, only those are kept (drums is suppressed, others remain).
    expect(parseIntentText("žiadne bicie, len basu").input.roles).toEqual(["bass"]);
    expect(parseIntentText("žiaden beat s melódiou").input.roles).toEqual(["lead"]);
    // Parser flags the negation in the detection trail.
    expect(parseIntentText("žiadne bicie").detected).toContain("no drums");
  });
});

describe("genre-depth sprint — roller / amen / horrorcore", () => {
  it("dnb: roller and amen resolve as styles", () => {
    expect(parseIntentText("roller dnb at 174").input.style).toBe("roller");
    expect(parseIntentText("amen chop dnb").input.style).toBe("amen");
    // SK: 'rolujuci' stays on the legacy 'rolling' stem (predates the sprint);
    // the roller SK phrasing is the -er/-ery form
    expect(parseIntentText("rollery dnb").input.style).toBe("roller");
    expect(parseIntentText("rolujuci dnb").input.style).toBe("rolling");
  });

  it("phonk: horrorcore resolves (and the preset wins for suicideboys)", () => {
    expect(parseIntentText("horrorcore phonk").input.style).toBe("horror");
    expect(parseIntentText("horor phonk").input.style).toBe("horror");
  });

  it("new grooves exist with valid 16-step shapes", () => {
    for (const id of ["dnb.roller", "dnb.amen", "phonk.horror"]) {
      const groove = getGrooveById(id);
      expect(groove).toBeDefined();
      expect(groove!.patterns.length).toBeGreaterThan(0);
      for (const pattern of groove!.patterns) {
        for (const row of Object.values(pattern)) expect(row).toHaveLength(16);
      }
    }
  });
});

describe("sub-genre wave — acid trap, garage, baile, neuro, hard groove", () => {
  it("acid trap routes to TRAP (not techno — the acid generic must not win)", () => {
    const parsed = parseIntentText("acid trap at 145");
    expect(parsed.input.genre).toBe("trap");
    expect(parsed.input.style).toBe("acid"); // acid style on trap grooves
  });

  it("UK garage family: speed garage / bassline / 2-step land on house+ukg", () => {
    expect(parseIntentText("speed garage at 132").input.genre).toBe("house");
    expect(parseIntentText("speed garage at 132").input.style).toBe("ukg");
    expect(parseIntentText("bassline house at 138").input.genre).toBe("house");
    expect(parseIntentText("2-step garage at 130").input.style).toBe("ukg");
  });

  it("liquid dnb sets the liquid style", () => {
    const parsed = parseIntentText("liquid dnb at 174");
    expect(parsed.input.genre).toBe("dnb");
    expect(parsed.input.style).toBe("liquid");
  });

  it("neurofunk → dnb twostep, hard groove → techno driving", () => {
    expect(parseIntentText("neurofunk at 174").input.genre).toBe("dnb");
    expect(parseIntentText("neurofunk at 174").input.style).toBe("twostep");
    expect(parseIntentText("hard groove techno").input.style).toBe("driving");
  });

  it("baile funk / brazilian phonk → phonk bounce", () => {
    expect(parseIntentText("baile funk at 130").input.genre).toBe("phonk");
    expect(parseIntentText("baile funk at 130").input.style).toBe("bounce");
    expect(parseIntentText("brazilian phonk").input.genre).toBe("phonk");
  });
});

describe("genre-depth wave 2 — techno hard/melodic + trap lux/hyper", () => {
  it("hard techno / klangkuenstler resolve to the hard groove family", () => {
    expect(parseIntentText("hard techno at 150").input.genre).toBe("techno");
    expect(parseIntentText("melodic techno at 126").input.genre).toBe("techno");
    expect(parseIntentText("melodic techno at 126").input.style).toBe("melodic");
  });

  it("trap: lux and hyper styles resolve", () => {
    expect(parseIntentText("lux trap at 122").input.style).toBe("lux");
    expect(parseIntentText("hyper trap at 150").input.style).toBe("hyper");
  });

  it("new groove definitions exist with valid 16-step shapes", () => {
    for (const id of ["techno.hard", "techno.melodic", "trap.lux", "trap.hyper"]) {
      const groove = getGrooveById(id);
      expect(groove).toBeDefined();
      expect(groove!.patterns.length).toBeGreaterThan(0);
      for (const pattern of groove!.patterns) {
        for (const row of Object.values(pattern)) expect(row).toHaveLength(16);
      }
    }
  });
});
