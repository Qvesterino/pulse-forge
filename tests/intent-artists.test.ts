import { describe, it, expect } from "vitest";
import { matchArtistPreset } from "../src/intent/artists";
import { parseIntentText } from "../src/intent/text-parser";
import { getGrooveById } from "../src/ai/grooves/index";
import { normalizeIntent } from "../src/intent/normalize";
import { parseReviseIntent, routeIntentText, REVISE_DELTA } from "../src/intent/route";
import { testDoc } from "./fixtures/doc";
import { generateAsyncResult } from "../src/intent/pipeline";

describe("artist type-beat presets (C1)", () => {
  it("travis scott type beat → trap/rolling/dark with researched BPM", () => {
    const parsed = parseIntentText("travis scott type beat");
    expect(parsed.input.genre).toBe("trap");
    expect(parsed.input.style).toBe("rolling");
    expect(parsed.input.mood).toBe("dark");
    expect(parsed.input.bpmRange).toEqual([130, 140]);
    expect(parsed.input.energy).toBe(0.7);
    expect(parsed.detected).toContain("♪ travis scott");
  });

  it("works without the 'type beat' phrase and with SK filler", () => {
    expect(parseIntentText("travis scott beat").input.genre).toBe("trap");
    expect(parseIntentText("nieco ako metro boomin prosim").input.mood).toBe("dark");
  });

  it("explicit text words override the preset base", () => {
    const parsed = parseIntentText("travis scott type beat bright");
    // bright → mood energetic + energy trait 0.95 beat the preset's dark/0.7
    expect(parsed.input.mood).toBe("energetic");
    expect(parsed.input.energy).toBe(0.95);
    // genre/style from the preset survive (text added no genre word)
    expect(parsed.input.genre).toBe("trap");
  });

  it("covers rage, boom bap and drill references", () => {
    expect(parseIntentText("rage beat").input.mood).toBe("aggressive");
    expect(parseIntentText("rage beat").input.bpmRange).toEqual([150, 165]);
    expect(parseIntentText("southstar type beat").input.style).toBe("bouncy");
    expect(parseIntentText("kanye type beat").input.style).toBe("classic");
    expect(parseIntentText("kanye type beat").input.bpmRange).toEqual([86, 92]);
  });

  it("drill resolves to the drill genre (first-class since the sound-quality pass)", () => {
    // History: drill→techno was a tempo-proximity bug, fixed to trap family;
    // now drill has its own grooves/kit, so it stays drill.
    expect(parseIntentText("uk drill beat").input.genre).toBe("drill");
    expect(parseIntentText("central cee type beat").input.genre).toBe("drill");
  });

  it("no artist → no chip, parsing unchanged", () => {
    const parsed = parseIntentText("dark rolling techno at 140");
    expect(parsed.detected.some((d) => d.startsWith("♪"))).toBe(false);
    expect(parsed.input.genre).toBe("techno");
    expect(matchArtistPreset(" dark rolling techno at 140 ")).toBeNull();
  });

  it("matcher is deterministic", () => {
    expect(matchArtistPreset(" travis scott type beat ")).toEqual(matchArtistPreset("travis scott"));
  });
});

describe("revise intent (C2)", () => {
  it("parses the user's exact phrasings EN and SK", () => {
    expect(parseReviseIntent("more energetic")).toEqual({
      attribute: "energy",
      direction: "more",
      detected: [],
      targetRole: null,
    });
    expect(parseReviseIntent("more energic")?.attribute).toBe("energy");
    expect(parseReviseIntent("menej husty")).toEqual({
      attribute: "density",
      direction: "less",
      detected: [],
      targetRole: null,
    });
    expect(parseReviseIntent("busier drums")?.attribute).toBe("density");
    expect(parseReviseIntent("calmer")).toEqual({
      attribute: "energy",
      direction: "less",
      detected: [],
      targetRole: null,
    });
  });

  it("non-revise text returns null", () => {
    expect(parseReviseIntent("dark rolling techno at 140")).toBeNull();
    expect(parseReviseIntent("travis scott type beat")).toBeNull();
  });

  it("router priorities: punch stays MIX, energy comparatives become REVISE, plain adjectives stay PATTERN", () => {
    const doc = testDoc();
    expect(routeIntentText("more punch", doc).kind).toBe("mix");
    expect(routeIntentText("darker", doc).kind).toBe("mix");
    expect(routeIntentText("more energetic", doc).kind).toBe("revise");
    expect(routeIntentText("dark techno", doc).kind).toBe("pattern");
    const revise = routeIntentText("viac energie", doc);
    expect(revise.kind).toBe("revise");
    if (revise.kind === "revise") {
      expect(revise.attribute).toBe("energy");
      expect(revise.direction).toBe("more");
    }
  });
});

describe("revise execution — same seed identity (C2)", () => {
  it("same seed + shifted slider = same beat family, different content", async () => {
    const doc = testDoc();
    const base = normalizeIntent({ genre: "trap", seed: "revise-me", energy: 0.5, length: 16 });
    const shifted = normalizeIntent({
      genre: "trap",
      seed: "revise-me",
      energy: Math.max(0, Math.min(1, 0.5 + REVISE_DELTA)),
      length: 16,
    });
    const resultA = await generateAsyncResult(doc, base, { mode: "apply" });
    const resultB = await generateAsyncResult(doc, shifted, { mode: "apply" });
    if (!resultA.proposal || !resultB.proposal) {
      throw new Error("both deterministic intent generations must produce a proposal");
    }
    // identity: the SAME generation seed
    expect(resultB.plan.intent.seed).toBe(resultA.plan.intent.seed);
    // character: the slider actually moved, content changed
    expect(resultB.plan.intent.energy).toBeCloseTo(0.65, 5);
    expect(resultA.proposal.pattern.generation?.outputContentHash).not.toBe(
      resultB.proposal.pattern.generation?.outputContentHash,
    );
    // determinism: same inputs reproduce the same hashes
    const resultB2 = await generateAsyncResult(doc, shifted, { mode: "apply" });
    expect(resultB2.proposal!.pattern.generation?.outputContentHash).toBe(
      resultB.proposal!.pattern.generation?.outputContentHash,
    );
  });
});

describe("targeted section revise (C3)", () => {
  it("role words make the revise TARGETED", () => {
    expect(parseReviseIntent("make bridge more energic")).toEqual({
      attribute: "energy",
      direction: "more",
      detected: ["bridge §"],
      targetRole: "bridge",
    });
    expect(parseReviseIntent("sprav most menej husty")?.targetRole).toBe("bridge");
    expect(parseReviseIntent("chorus busier")?.targetRole).toBe("chorus");
    // global revise stays global
    expect(parseReviseIntent("more energetic")?.targetRole).toBeNull();
    // plain role word without comparative is NOT a revise
    expect(parseReviseIntent("bridge")).toBeNull();
  });

  it("router keeps the role through routing", () => {
    const doc = testDoc();
    const route = routeIntentText("make bridge more energic", doc);
    expect(route.kind).toBe("revise");
    if (route.kind === "revise") {
      expect(route.targetRole).toBe("bridge");
      expect(route.attribute).toBe("energy");
    }
  });
});

describe("expanded artist roster (vocabulary wave)", () => {
  it("maps techno references to peak-time/hard variants", () => {
    const charlotte = parseIntentText("charlotte de witte type beat");
    expect(charlotte.input.genre).toBe("techno");
    expect(charlotte.input.style).toBe("driving");
    expect(charlotte.input.mood).toBe("aggressive");
    expect(charlotte.input.bpmRange).toEqual([145, 152]);
    expect(parseIntentText("ben klock type beat").input.style).toBe("minimal");
    expect(parseIntentText("sara landry type beat").input.bpmRange).toEqual([148, 155]);
    expect(parseIntentText("boris brejcha type beat").input.bpmRange).toEqual([120, 126]);
  });

  it("maps trap references including the opium rage cluster", () => {
    expect(parseIntentText("future type beat").input.style).toBe("rolling");
    expect(parseIntentText("gunna type beat").input.mood).toBe("chill");
    const ken = parseIntentText("ken carson type beat");
    expect(ken.input.genre).toBe("trap");
    expect(ken.input.mood).toBe("aggressive");
    expect(ken.input.bpmRange).toEqual([150, 165]);
    expect(parseIntentText("zaytoven type beat").input.style).toBe("classic");
    expect(parseIntentText("chief keef type beat").input.genre).toBe("drill");
  });

  it("maps phonk, dnb, ambient and house references", () => {
    const kordhell = parseIntentText("kordhell type beat");
    expect(kordhell.input.genre).toBe("phonk");
    expect(kordhell.input.style).toBe("drift");
    expect(kordhell.input.bpmRange).toEqual([150, 165]);
    expect(parseIntentText("dj smokey type beat").input.style).toBe("memphis");
    expect(parseIntentText("sub focus type beat").input.genre).toBe("dnb");
    expect(parseIntentText("hedex type beat").input.style).toBe("jumpup");
    const eno = parseIntentText("brian eno type beat");
    expect(eno.input.genre).toBe("ambient");
    expect(eno.input.bpmRange).toEqual([60, 80]);
    expect(parseIntentText("aphex twin type beat").input.style).toBe("glitch");
    expect(parseIntentText("keinemusik type beat").input.style).toBe("afro");
    expect(parseIntentText("dom dolla type beat").input.bpmRange).toEqual([124, 127]);
    expect(parseIntentText("trance type beat").input.genre).toBe("techno");
  });

  it("explicit words still override the expanded presets", () => {
    const bright = parseIntentText("charlotte de witte type beat chill");
    expect(bright.input.mood).toBe("chill");
    expect(bright.input.genre).toBe("techno");
  });
});

describe("target-roster presets (genre-depth sprint)", () => {
  it("suicideboys → phonk/memphis/dark with the horrorcore tempo", () => {
    const parsed = parseIntentText("suicideboys type beat");
    expect(parsed.input.genre).toBe("phonk");
    expect(parsed.input.style).toBe("memphis");
    expect(parsed.input.mood).toBe("dark");
    expect(parsed.input.bpmRange).toEqual([130, 150]);
  });

  it("macky gee → jump-up dnb at roller tempo", () => {
    const parsed = parseIntentText("macky gee type beat");
    expect(parsed.input.genre).toBe("dnb");
    expect(parsed.input.style).toBe("jumpup");
    expect(parsed.input.bpmRange).toEqual([172, 177]);
  });

  it("fred again variants: base deep + UKG Actual-Life phrasing", () => {
    expect(parseIntentText("fred again").input.style).toBe("deep");
    expect(parseIntentText("fred again type beat").input.style).toBe("ukg");
    expect(parseIntentText("fred again type beat").input.bpmRange).toEqual([130, 145]);
  });
});

describe("world-roster wave (researched BPM)", () => {
  it("techno block: beyer/klangkuenstler/hi-lo/kobosil", () => {
    expect(parseIntentText("adam beyer type beat").input.bpmRange).toEqual([130, 138]);
    expect(parseIntentText("klangkuenstler type beat").input.bpmRange).toEqual([145, 155]);
    expect(parseIntentText("hi-lo type beat").input.bpmRange).toEqual([136, 144]);
    expect(parseIntentText("kobosil type beat").input.mood).toBe("dark");
  });

  it("electronic block: four tet/bicep/jamie xx/ben bohmer", () => {
    expect(parseIntentText("four tet type beat").input.style).toBe("organic");
    expect(parseIntentText("bicep type beat").input.bpmRange).toEqual([122, 128]);
    expect(parseIntentText("jamie xx type beat").input.style).toBe("ukg");
    expect(parseIntentText("ben böhmer type beat").input.mood).toBe("chill");
  });

  it("hip-hop block: young thug/don toliver/lil uzi/trippie redd", () => {
    expect(parseIntentText("young thug type beat").input.style).toBe("bouncy");
    expect(parseIntentText("don toliver type beat").input.bpmRange).toEqual([118, 128]);
    expect(parseIntentText("lil uzi vert type beat").input.energy).toBe(0.85);
    expect(parseIntentText("trippie redd type beat").input.mood).toBe("dark");
  });

  it("phonk + dnb block: moondeity/dvrst/chase & status/bou/1991/calibre", () => {
    expect(parseIntentText("moondeity type beat").input.style).toBe("drift");
    expect(parseIntentText("chase and status type beat").input.style).toBe("jumpup");
    expect(parseIntentText("bou type beat").input.style).toBe("roller");
    expect(parseIntentText("1991 type beat").input.bpmRange).toEqual([172, 178]);
    expect(parseIntentText("calibre type beat").input.style).toBe("liquid");
  });
});

describe("west coast / g-funk roster (researched 92-96 pocket)", () => {
  it("snoop → trap/headnod chill in the classic pocket", () => {
    const parsed = parseIntentText("snoop type beat");
    expect(parsed.input.genre).toBe("trap");
    expect(parsed.input.style).toBe("headnod");
    expect(parsed.input.mood).toBe("chill");
    expect(parsed.input.bpmRange).toEqual([92, 96]);
    expect(parsed.detected).toContain("♪ snoop dogg");
  });

  it("dre → trap/gfunk dark; warren g + nate dogg share the Regulate entry", () => {
    const dre = parseIntentText("dre type beat");
    expect(dre.input.style).toBe("gfunk");
    expect(dre.input.bpmRange).toEqual([93, 96]);
    const regulate = parseIntentText("regulate type beat");
    expect(regulate.input.style).toBe("headnod");
    expect(regulate.input.bpmRange).toEqual([94, 96]);
    expect(parseIntentText("nate dogg type beat").input.style).toBe("headnod");
  });

  it("ty dolla → modern west, slightly faster", () => {
    const parsed = parseIntentText("ty dolla type beat");
    expect(parsed.input.style).toBe("gfunk");
    expect(parsed.input.mood).toBe("energetic");
    expect(parsed.input.bpmRange).toEqual([95, 105]);
  });

  it("both styles resolve to real groove ids (resolveGroove contract)", () => {
    expect(getGrooveById("trap.headnod")).toBeDefined();
    expect(getGrooveById("trap.gfunk")).toBeDefined();
  });
});

describe("electronic wave roster (sophie / burial / hyperpop)", () => {
  // overmono/flume/duskus already live in the culture-wave roster — the
  // campaign's additions are the ones the culture wave lacked.
  it("sophie → hyper groove at the hyperpop floor; generic hyperpop too", () => {
    expect(parseIntentText("sophie type beat").input.style).toBe("hyper");
    expect(parseIntentText("sophie type beat").input.bpmRange).toEqual([120, 140]);
    expect(parseIntentText("hyperpop beat").input.style).toBe("hyper");
    expect(parseIntentText("hyperpop beat").input.bpmRange).toEqual([145, 160]);
  });

  it("burial → ambient future garage (the culture wave's genre home)", () => {
    const burial = parseIntentText("burial type beat");
    expect(burial.input.genre).toBe("ambient");
    expect(burial.input.style).toBe("future garage");
    expect(burial.input.mood).toBe("dark");
    expect(parseIntentText("future garage beat").input.style).toBe("future garage");
  });

  it("the wave's grooves resolve (broken generic + ambient future garage)", () => {
    expect(getGrooveById("house.broken")).toBeDefined();
    expect(getGrooveById("ambient.futuregarage")).toBeDefined();
    expect(getGrooveById("trap.hyper")).toBeDefined();
  });
});

describe("melo-club & bass music roster", () => {
  it("melodic techno corner: anyma / tale of us / artbat / camelphat", () => {
    for (const name of ["anyma", "tale of us", "artbat", "camelphat"]) {
      const parsed = parseIntentText(`${name} type beat`);
      expect(parsed.input.genre).toBe("techno");
      expect(parsed.input.style).toBe("melodic");
    }
    expect(parseIntentText("anyma type beat").input.bpmRange).toEqual([122, 126]);
  });

  it("dubstep corner: seven lions melodic vs excision headbanger", () => {
    expect(parseIntentText("seven lions type beat").input.style).toBe("dubstep");
    expect(parseIntentText("seven lions type beat").input.mood).toBe("energetic");
    expect(parseIntentText("excision type beat").input.mood).toBe("aggressive");
    expect(parseIntentText("excision type beat").input.bpmRange).toEqual([145, 155]);
    expect(parseIntentText("subtronics type beat").input.style).toBe("dubstep");
    expect(parseIntentText("illenium type beat").input.mood).toBe("chill");
  });

  it("black coffee → afro house; pinkpantheress → ukg", () => {
    const coffee = parseIntentText("black coffee type beat");
    expect(coffee.input.genre).toBe("house");
    expect(coffee.input.style).toBe("afro");
    expect(coffee.input.bpmRange).toEqual([120, 124]);
    const pink = parseIntentText("pinkpantheress type beat");
    expect(pink.input.style).toBe("ukg");
    expect(pink.input.bpmRange).toEqual([132, 140]);
  });
});

describe("hip-hop sub-genre roster sweep", () => {
  it("cloud corner: asap rocky / yung lean / clams casino", () => {
    expect(parseIntentText("asap rocky type beat").input.style).toBe("sparse");
    expect(parseIntentText("yung lean type beat").input.mood).toBe("chill");
    expect(parseIntentText("cloud rap beat").input.style).toBe("sparse");
    expect(parseIntentText("clams casino type beat").input.bpmRange).toEqual([125, 140]);
  });

  it("regional corners: dj screw slowed / babytron detroit / e-40 hyphy / lil jon crunk", () => {
    expect(parseIntentText("dj screw type beat").input.style).toBe("screwed");
    expect(parseIntentText("dj screw type beat").input.bpmRange).toEqual([66, 78]);
    expect(parseIntentText("babytron type beat").input.style).toBe("detroit");
    expect(parseIntentText("veeze type beat").input.style).toBe("detroit");
    expect(parseIntentText("e-40 type beat").input.style).toBe("hyphy");
    expect(parseIntentText("mac dre type beat").input.style).toBe("hyphy");
    expect(parseIntentText("lil jon type beat").input.style).toBe("crunk");
    expect(parseIntentText("crunk beat").input.bpmRange).toEqual([98, 108]);
  });

  it("grime corner: skepta / wiley on the 140 floor", () => {
    expect(parseIntentText("skepta type beat").input.genre).toBe("drill");
    expect(parseIntentText("skepta type beat").input.style).toBe("grime");
    expect(parseIntentText("wiley type beat").input.style).toBe("grime");
  });

  it("conscious boom bap corner: kendrick / j cole / nas / mf doom", () => {
    const kdot = parseIntentText("kendrick type beat");
    expect(kdot.input.style).toBe("headnod");
    expect(kdot.input.bpmRange).toEqual([92, 110]);
    expect(parseIntentText("j cole type beat").input.style).toBe("classic");
    expect(parseIntentText("nas type beat").input.style).toBe("classic");
    expect(parseIntentText("mf doom type beat").input.mood).toBe("chill");
    expect(parseIntentText("old school rap beat").input.style).toBe("oldschool");
  });

  it("pop routing: dance-pop/synth-pop/pop-rap/hyperpop land on existing genres", () => {
    expect(parseIntentText("pop beat").input.genre).toBe("house");
    expect(parseIntentText("pop beat").input.style).toBe("pop");
    expect(parseIntentText("dance pop beat at 120").input.genre).toBe("house");
    expect(parseIntentText("synthpop track").input.genre).toBe("house");
    expect(parseIntentText("pop-rap beat").input.genre).toBe("trap");
    expect(parseIntentText("hyperpop banger").input.genre).toBe("trap");
    expect(parseIntentText("hyperpop banger").input.style).toBe("hyper");
  });

  it("pop artists: dua/weeknd/billie/ariana/bruno/olivia/charli/taylor/lorde/tate/gaga/rihanna", () => {
    const dua = parseIntentText("dua lipa type beat");
    expect(dua.input.genre).toBe("house");
    expect(dua.input.style).toBe("pop");
    expect(dua.input.bpmRange).toEqual([103, 125]);
    expect(parseIntentText("the weeknd type beat").input.bpmRange).toEqual([90, 130]);
    const billie = parseIntentText("billie eilish type beat");
    expect(billie.input.genre).toBe("ambient");
    expect(billie.input.mood).toBe("dark");
    expect(billie.input.bpmRange).toEqual([70, 100]);
    expect(parseIntentText("ariana grande song").input.genre).toBe("house");
    expect(parseIntentText("bruno mars funk").input.style).toBe("funky");
    expect(parseIntentText("charli xcx hyperpop").input.style).toBe("hyper");
    expect(parseIntentText("charli xcx type beat").input.bpmRange).toEqual([130, 160]);
    expect(parseIntentText("taylor swift song").input.mood).toBe("chill");
    expect(parseIntentText("lorde type beat").input.genre).toBe("ambient");
    expect(parseIntentText("tate mcrae dance").input.genre).toBe("house");
    expect(parseIntentText("lady gaga dance pop").input.style).toBe("pop");
    expect(parseIntentText("rihanna type beat").input.bpmRange).toEqual([95, 120]);
    expect(dua.detected).toContain("♪ dua lipa");
  });

  it("pop preset is a base: explicit words still win", () => {
    const parsed = parseIntentText("billie eilish type beat bright");
    expect(parsed.input.mood).toBe("energetic");
    expect(parsed.input.genre).toBe("ambient");
  });
});
