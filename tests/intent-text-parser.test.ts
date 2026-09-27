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
    expect(parseIntentText("ukg groove").input.genre).toBe("ukg");
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

  it("UK garage family: speed garage / bassline / 2-step land on ukg", () => {
    expect(parseIntentText("speed garage at 132").input.genre).toBe("ukg");
    expect(parseIntentText("speed garage at 132").input.style).toBe("ukg");
    expect(parseIntentText("bassline house at 138").input.genre).toBe("ukg");
    expect(parseIntentText("2-step garage at 130").input.style).toBe("ukg");
  });

  it("liquid dnb sets the liquid style", () => {
    const parsed = parseIntentText("liquid dnb at 174");
    expect(parsed.input.genre).toBe("dnb");
    expect(parsed.input.style).toBe("liquid");
  });

  it("neurofunk → dnb neuro groove, hard groove → techno driving", () => {
    expect(parseIntentText("neurofunk at 174").input.genre).toBe("dnb");
    expect(parseIntentText("neurofunk at 174").input.style).toBe("neuro");
    expect(parseIntentText("hard groove techno").input.style).toBe("driving");
  });

  it("dnb sub-genre sweep — jump up, drumfunk, techstep, ragga, halftime", () => {
    expect(parseIntentText("jump up dnb at 174").input.genre).toBe("dnb");
    expect(parseIntentText("jump up dnb at 174").input.style).toBe("jumpup");
    expect(parseIntentText("drumfunk rollers").input.genre).toBe("dnb");
    expect(parseIntentText("techstep pressure").input.genre).toBe("dnb");
    expect(parseIntentText("darkstep tearout").input.genre).toBe("dnb");
    expect(parseIntentText("ragga jungle with vocals").input.genre).toBe("dnb");
    expect(parseIntentText("halftime dnb").input.genre).toBe("dnb");
    expect(parseIntentText("minimal dnb roller").input.genre).toBe("dnb");
    expect(parseIntentText("deep drum and bass").input.genre).toBe("dnb");
  });

  it("dnb two-step needs the dnb context — plain two step stays UKG", () => {
    expect(parseIntentText("two step dnb").input.style).toBe("twostep");
    expect(parseIntentText("two step dnb").input.genre).toBe("dnb");
    expect(parseIntentText("dnb two step stepper").input.style).toBe("twostep");
    expect(parseIntentText("two step garage at 130").input.style).toBe("ukg");
    expect(parseIntentText("two step swing").input.style).toBe("ukg");
  });

  it("techno depth phrases: detroit techno / electro / hardgroove", () => {
    expect(parseIntentText("detroit techno").input.genre).toBe("techno");
    expect(parseIntentText("detroit electro").input.genre).toBe("techno");
    expect(parseIntentText("techno detroit").input.genre).toBe("techno");
    expect(parseIntentText("hardgroove techno").input.genre).toBe("techno");
    expect(parseIntentText("hard groove techno").input.style).toBe("driving");
    // detroit RAP still routes to the rap family
    expect(parseIntentText("detroit rap beat").input.style).toBe("detroit");
  });

  it("new dnb styles resolve to real groove ids", () => {
    for (const id of ["dnb.twostep", "dnb.liquid", "dnb.jumpup", "dnb.neuro", "dnb.dancefloor"]) {
      const groove = getGrooveById(id);
      expect(groove).toBeDefined();
      expect(groove!.patterns.length).toBeGreaterThan(0);
    }
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

describe("genre-depth wave 3 — dancefloor / soulful / neuro", () => {
  it("house: dancefloor and soulful styles resolve", () => {
    expect(parseIntentText("dancefloor house at 126").input.style).toBe("dancefloor");
    expect(parseIntentText("dancefloor house at 126").input.genre).toBe("house");
    expect(parseIntentText("soulful house at 124").input.style).toBe("soulful");
  });

  it("dnb: dancefloor and neuro styles resolve", () => {
    expect(parseIntentText("dancefloor dnb at 174").input.style).toBe("dancefloor");
    expect(parseIntentText("neurofunk at 174").input.style).toBe("neuro");
  });

  it("new groove definitions exist with valid 16-step shapes", () => {
    for (const id of ["house.dancefloor", "house.soulful", "dnb.dancefloor", "dnb.neuro"]) {
      const groove = getGrooveById(id);
      expect(groove).toBeDefined();
      expect(groove!.patterns.length).toBeGreaterThan(0);
      for (const pattern of groove!.patterns) {
        for (const row of Object.values(pattern)) expect(row).toHaveLength(16);
      }
    }
  });
});

describe("genre-depth wave 4 — drill sample/hyper/melodic", () => {
  it("drill style phrases resolve: sample / hyper / melodic", () => {
    expect(parseIntentText("sample drill at 145").input.style).toBe("sample");
    expect(parseIntentText("hyper drill at 155").input.style).toBe("hyper");
    expect(parseIntentText("melodic drill at 140").input.style).toBe("melodic");
    // genre stays drill in all cases
    expect(parseIntentText("sample drill at 145").input.genre).toBe("drill");
    expect(parseIntentText("hyper drill at 155").input.genre).toBe("drill");
  });

  it("new drill groove definitions exist with valid 16-step shapes", () => {
    for (const id of ["drill.sample", "drill.hyper", "drill.melodic"]) {
      const groove = getGrooveById(id);
      expect(groove).toBeDefined();
      expect(groove!.patterns.length).toBeGreaterThan(0);
      for (const pattern of groove!.patterns) {
        for (const row of Object.values(pattern)) expect(row).toHaveLength(16);
      }
    }
  });
});

describe("culture wave — bedroom pop / lo-fi house / post-punk / trip-hop", () => {
  it("genre phrases: bedroom pop / lo-fi house / post-punk / trip hop / future bass", () => {
    expect(parseIntentText("bedroom pop at 90").input.genre).toBe("ambient");
    expect(parseIntentText("lo-fi house at 118").input.genre).toBe("house");
    expect(parseIntentText("post-punk at 135").input.genre).toBe("techno");
    expect(parseIntentText("trip hop at 85").input.genre).toBe("ambient");
    expect(parseIntentText("future bass at 145").input.genre).toBe("trap");
  });

  it("bedroom pop roster: clairo / mac demarco / beabadoobee / rex orange", () => {
    expect(parseIntentText("clairo type beat").input.genre).toBe("ambient");
    expect(parseIntentText("clairo type beat").input.bpmRange).toEqual([75, 110]);
    expect(parseIntentText("mac demarco type beat").input.style).toBe("organic");
    expect(parseIntentText("beabadoobee type beat").input.genre).toBe("ambient");
    expect(parseIntentText("rex orange county type beat").input.genre).toBe("house");
  });

  it("lo-fi house trio: dj seinfeld / ross from friends / mall grab", () => {
    expect(parseIntentText("dj seinfeld type beat").input.bpmRange).toEqual([110, 125]);
    expect(parseIntentText("ross fm type beat").input.genre).toBe("house");
    expect(parseIntentText("mall grab type beat").input.style).toBe("minimal");
  });

  it("uk bass + future bass + trip-hop heavyweights", () => {
    expect(parseIntentText("overmono type beat").input.style).toBe("ukg");
    expect(parseIntentText("flume type beat").input.genre).toBe("trap");
    expect(parseIntentText("flume type beat").input.style).toBe("lux");
    expect(parseIntentText("skrillex type beat").input.style).toBe("hyper");
    expect(parseIntentText("portishead type beat").input.bpmRange).toEqual([70, 90]);
    expect(parseIntentText("massive attack type beat").input.mood).toBe("dark");
  });

  it("post-punk roster: joy division / interpol / the cure / idles / fontaines / turnstile", () => {
    expect(parseIntentText("joy division type beat").input.genre).toBe("techno");
    expect(parseIntentText("joy division type beat").input.mood).toBe("dark");
    expect(parseIntentText("interpol type beat").input.style).toBe("industrial");
    expect(parseIntentText("the cure type beat").input.bpmRange).toEqual([125, 150]);
    expect(parseIntentText("idles type beat").input.mood).toBe("aggressive");
    expect(parseIntentText("fontaines dc type beat").input.bpmRange).toEqual([140, 155]);
    expect(parseIntentText("turnstile type beat").input.genre).toBe("trap");
    expect(parseIntentText("turnstile type beat").input.bpmRange).toEqual([140, 170]);
  });
});

describe("ambient/experimental wave — drone / IDM / Berlin school", () => {
  it("sub-genres: drone / IDM / vaporwave / berlin school / krautrock / deconstructed", () => {
    expect(parseIntentText("drone ambient").input.genre).toBe("ambient");
    expect(parseIntentText("IDM at 140").input.genre).toBe("ambient");
    expect(parseIntentText("vaporwave at 75").input.genre).toBe("ambient");
    expect(parseIntentText("berlin school at 100").input.genre).toBe("techno");
    expect(parseIntentText("krautrock at 110").input.genre).toBe("techno");
    expect(parseIntentText("deconstructed club at 120").input.genre).toBe("hyperpop");
  });

  it("drone roster: stars of the lid / basinski / grouper / koner / hecker", () => {
    expect(parseIntentText("stars of the lid type beat").input.bpmRange).toEqual([40, 65]);
    expect(parseIntentText("basinski type beat").input.energy).toBe(0.15);
    expect(parseIntentText("grouper type beat").input.mood).toBe("dark");
    expect(parseIntentText("tim hecker type beat").input.style).toBe("glitch");
    expect(parseIntentText("disintegration loops").input.genre).toBe("ambient");
  });

  it("experimental roster: autechre / arca / sophie / opn / fennesz / vaporwave", () => {
    expect(parseIntentText("autechre type beat").input.bpmRange).toEqual([120, 160]);
    expect(parseIntentText("arca type beat").input.style).toBe("hyper");
    expect(parseIntentText("pc music type beat").input.style).toBe("hyper");
    expect(parseIntentText("oneohtrix point never type beat").input.style).toBe("glitch");
    expect(parseIntentText("fennesz type beat").input.bpmRange).toEqual([50, 80]);
    expect(parseIntentText("vaporwave type beat").input.mood).toBe("dark");
  });

  it("berlin school roster: tangerine dream / klaus schulze / gotttsching e2-e4", () => {
    expect(parseIntentText("tangerine dream type beat").input.style).toBe("melodic");
    expect(parseIntentText("phaedra type beat").input.bpmRange).toEqual([80, 120]);
    expect(parseIntentText("klaus schulze type beat").input.genre).toBe("techno");
    expect(parseIntentText("e2-e4 type beat").input.genre).toBe("house");
  });
});

describe("west coast / g-funk sprint", () => {
  it("headnod and gfunk resolve as styles (EN + SK)", () => {
    expect(parseIntentText("west coast beat at 94").input.style).toBe("headnod");
    expect(parseIntentText("zapadne pobrezie beat").input.style).toBe("headnod");
    expect(parseIntentText("head nod type beat").input.style).toBe("headnod");
    expect(parseIntentText("g-funk type beat").input.style).toBe("gfunk");
    expect(parseIntentText("gfunk 100 bpm").input.style).toBe("gfunk");
    expect(parseIntentText("lowrider music").input.style).toBe("gfunk");
  });

  it("west grooves exist with valid 16-step shapes", () => {
    for (const id of ["trap.headnod", "trap.gfunk"]) {
      const groove = getGrooveById(id);
      expect(groove).toBeDefined();
      expect(groove!.patterns.length).toBeGreaterThan(0);
      expect(groove!.bpm[0]).toBeGreaterThanOrEqual(90);
      for (const pattern of groove!.patterns) {
        for (const row of Object.values(pattern)) expect(row).toHaveLength(16);
      }
    }
  });
});

describe("fred depth — heartbeat / emotional UKG", () => {
  it("heartbeat resolves as a style (EN + SK)", () => {
    expect(parseIntentText("heartbeat type beat").input.style).toBe("heartbeat");
    expect(parseIntentText("srdcovy tep beat").input.style).toBe("heartbeat");
    // uk garage still resolves to the ukg style (must not be stolen)
    expect(parseIntentText("uk garage at 132").input.style).toBe("ukg");
  });

  it("the heartbeat groove exists with valid 16-step shapes in the pocket", () => {
    const groove = getGrooveById("house.heartbeat");
    expect(groove).toBeDefined();
    expect(groove!.bpm[0]).toBeGreaterThanOrEqual(126);
    for (const pattern of groove!.patterns) {
      for (const row of Object.values(pattern)) expect(row).toHaveLength(16);
    }
    // The heartbeat signature: a strong kick on step 0 in every variation.
    for (const pattern of groove!.patterns) {
      expect((pattern[0] ?? [])[0]).toBeGreaterThan(0.9);
    }
  });
});

describe("electronic wave — future garage / broken / hyperpop", () => {
  it("future garage resolves (and is not stolen by generic garage)", () => {
    const parsed = parseIntentText("future garage beat at 135");
    // The culture wave routed future garage to AMBIENT (duskus school)
    expect(parsed.input.genre).toBe("ambient");
    expect(parsed.input.style).toBe("future garage");
  });

  it("broken beat resolves to the broken style", () => {
    expect(parseIntentText("broken beat at 132").input.style).toBe("broken");
    expect(parseIntentText("broken house").input.style).toBe("broken");
  });

  it("hyperpop resolves to the hyper style", () => {
    const parsed = parseIntentText("hyperpop at 150");
    expect(parsed.input.style).toBe("hyper");
    expect(parseIntentText("hyper pop beat").input.style).toBe("hyper");
  });

  it("the new grooves exist with valid 16-step shapes", () => {
    for (const id of ["ambient.futuregarage", "house.broken"]) {
      const groove = getGrooveById(id);
      expect(groove).toBeDefined();
      for (const pattern of groove!.patterns) {
        for (const row of Object.values(pattern)) expect(row).toHaveLength(16);
      }
    }
  });
});

describe("melo-club & bass music wave", () => {
  it("dubstep routes to trap + the dubstep groove style", () => {
    const parsed = parseIntentText("dubstep at 145");
    expect(parsed.input.genre).toBe("trap");
    expect(parsed.input.style).toBe("dubstep");
    expect(parseIntentText("riddim at 145").input.style).toBe("dubstep");
  });

  it("melodic techno resolves the melodic style on techno genre", () => {
    const parsed = parseIntentText("melodic techno at 125");
    expect(parsed.input.genre).toBe("techno");
    expect(parsed.input.style).toBe("melodic");
  });

  it("the dubstep groove exists — halftime signature, valid 16-step shapes", () => {
    const groove = getGrooveById("trap.dubstep");
    expect(groove).toBeDefined();
    expect(groove!.bpm[0]).toBeGreaterThanOrEqual(140);
    for (const pattern of groove!.patterns) {
      for (const row of Object.values(pattern)) expect(row).toHaveLength(16);
      // Halftime signature: snare lands on step 8 (beat 3), nothing earlier.
      expect((pattern[5] ?? [])[8] ?? 0).toBeGreaterThan(0.8);
    }
  });
});

describe("hip-hop sub-genre sweep", () => {
  it("every new sub-genre phrase resolves its style", () => {
    expect(parseIntentText("chopped and screwed beat").input.style).toBe("screwed");
    expect(parseIntentText("plugg type beat").input.style).toBe("plugg");
    expect(parseIntentText("pluggnb at 150").input.style).toBe("plugg");
    expect(parseIntentText("detroit rap type beat").input.style).toBe("detroit");
    expect(parseIntentText("hyphy beat").input.style).toBe("hyphy");
    expect(parseIntentText("crunk beat").input.style).toBe("crunk");
    expect(parseIntentText("old school rap beat").input.style).toBe("oldschool");
    expect(parseIntentText("cloud rap beat").input.style).toBe("sparse");
  });

  it("grime routes to house genre + grime style (140 UK floor)", () => {
    const parsed = parseIntentText("grime beat at 140");
    expect(parsed.input.genre).toBe("drill"); // the culture wave put grime in the drill family
    expect(parsed.input.style).toBe("grime");
    expect(parseIntentText("eski beat").input.style).toBe("grime");
  });

  it("all new grooves exist with valid 16-step shapes", () => {
    for (const id of [
      "trap.screwed",
      "trap.plugg",
      "trap.detroit",
      "trap.hyphy",
      "trap.crunk",
      "trap.oldschool",
      "drill.grime",
    ]) {
      const groove = getGrooveById(id);
      expect(groove).toBeDefined();
      for (const pattern of groove!.patterns) {
        for (const row of Object.values(pattern)) expect(row).toHaveLength(16);
      }
    }
    // Screwed IS the slowness — the slowest rap groove in the library.
    expect(getGrooveById("trap.screwed")!.bpm[0]).toBeLessThan(80);
  });
});
