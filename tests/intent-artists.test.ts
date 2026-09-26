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

  it("covers the expanded phonk lane (bounce, horror, drift, aggressive drift)", () => {
    // Dvrst / Phonk Killer — TikTok-era cowbell-forward phonk bounce.
    expect(parseIntentText("dvrst type beat").input.genre).toBe("phonk");
    expect(parseIntentText("dvrst type beat").input.style).toBe("bounce");
    expect(parseIntentText("phonk killer beat").input.bpmRange).toEqual([130, 145]);
    // Ghostemane / Soudiere — dark NOLA horrorcore lane. The shared $uicideboy$
    // and moon deity/moondeity names live in the older target-roster (memphis)
    // and world-roster (drift) entries, so we exercise this lane via the unique
    // ghostemane + soudiere aliases instead.
    expect(parseIntentText("ghostemane type beat").input.mood).toBe("dark");
    expect(parseIntentText("ghostemane type beat").input.style).toBe("horror");
    expect(parseIntentText("soudiere beat").input.bpmRange).toEqual([125, 140]);
    // Rare Akuma / Rxseboy — clean cowbell syncopation, higher BPM TikTok drift.
    expect(parseIntentText("rare akuma beat").input.style).toBe("drift");
    expect(parseIntentText("rxseboy beat").input.bpmRange).toEqual([145, 160]);
    // Freddie Dredd — aggressive drift, Rage tempos.
    expect(parseIntentText("freddie dredd beat").input.style).toBe("drift");
    expect(parseIntentText("freddie dredd beat").input.bpmRange).toEqual([150, 170]);
    // The added lanes resolve to a real groove (engine integration smoke).
    // getGrooveById expects the full `genre.style` id, so we prepend the genre.
    const horror = normalizeIntent({
      ...parseIntentText("ghostemane type beat").input,
      seed: "ghostemane-test",
    });
    expect(getGrooveById(`phonk.${horror.style ?? ""}`)?.id).toBe("phonk.horror");
    const drift = normalizeIntent({
      ...parseIntentText("rare akuma beat").input,
      seed: "rare-akuma-test",
    });
    expect(getGrooveById(`phonk.${drift.style ?? ""}`)?.id).toBe("phonk.drift");
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

describe("dnb wave roster (sub-genres + researched 160–178 pockets)", () => {
  it("liquid block: netsky / hybrid minds / ltj bukem / dj marky", () => {
    expect(parseIntentText("netsky type beat").input.style).toBe("liquid");
    expect(parseIntentText("hybrid minds type beat").input.mood).toBe("chill");
    expect(parseIntentText("ltj bukem type beat").input.bpmRange).toEqual([168, 172]);
    expect(parseIntentText("dj marky type beat").input.genre).toBe("dnb");
  });

  it("jump-up block: turno / kanine / amc (+ serum guard)", () => {
    expect(parseIntentText("turno type beat").input.style).toBe("jumpup");
    expect(parseIntentText("kanine type beat").input.mood).toBe("aggressive");
    expect(parseIntentText("amc type beat").input.genre).toBe("dnb");
    expect(parseIntentText("serum type beat").input.style).toBe("jumpup");
    // bare "serum" is wavetable-synth talk, not the dnb artist
    expect(matchArtistPreset("serum bass")).toBeNull();
  });

  it("dancefloor block: andy c / dimension / metrik", () => {
    expect(parseIntentText("andy c type beat").input.style).toBe("dancefloor");
    expect(parseIntentText("andy c type beat").input.bpmRange).toEqual([172, 176]);
    expect(parseIntentText("dimension type beat").input.mood).toBe("energetic");
    expect(parseIntentText("metrik type beat").input.genre).toBe("dnb");
  });

  it("neuro block: noisia / black sun empire / ed rush", () => {
    expect(parseIntentText("noisia type beat").input.style).toBe("neuro");
    expect(parseIntentText("noisia type beat").input.energy).toBe(0.95);
    expect(parseIntentText("black sun empire type beat").input.mood).toBe("dark");
    expect(parseIntentText("ed rush and optical type beat").input.genre).toBe("dnb");
  });

  it("rollers + jungle + twostep: break guard / skeptical / congo natty / roni size", () => {
    expect(parseIntentText("break dnb type beat").input.style).toBe("roller");
    // bare "break" is arrangement talk, not the dnb artist
    expect(matchArtistPreset("make the break longer")).toBeNull();
    expect(parseIntentText("skeptical type beat").input.genre).toBe("dnb");
    expect(parseIntentText("congo natty type beat").input.style).toBe("amen");
    expect(parseIntentText("congo natty type beat").input.bpmRange).toEqual([160, 168]);
    expect(parseIntentText("shy fx type beat").input.style).toBe("amen");
    expect(parseIntentText("roni size type beat").input.style).toBe("twostep");
  });

  it("explicit words still override dnb presets", () => {
    const chill = parseIntentText("andy c type beat chill");
    expect(chill.input.mood).toBe("chill");
    expect(chill.input.genre).toBe("dnb");
  });

  it("every dnb wave style resolves to a real groove id", () => {
    for (const id of [
      "dnb.liquid",
      "dnb.jumpup",
      "dnb.dancefloor",
      "dnb.neuro",
      "dnb.roller",
      "dnb.amen",
      "dnb.twostep",
    ]) {
      expect(getGrooveById(id)).toBeDefined();
    }
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

describe("southern specialties + afroswing + countrytune (bounce wave)", () => {
  it("bounce routes by genre: trap/phonk/drill/jersey each carry .bounce", () => {
    const nola = parseIntentText("new orleans bounce beat");
    expect(nola.input.genre).toBe("trap");
    expect(nola.input.style).toBe("bounce");
    expect(parseIntentText("nola bounce").input.style).toBe("bounce");
    expect(parseIntentText("triggerman beat").input.style).toBe("bounce");
    expect(parseIntentText("bounce beat").input.style).toBe("bounce");
    expect(parseIntentText("bounce beat").input.genre).toBe("trap");
    // "bouncy" keeps the rage-era reading
    expect(parseIntentText("bouncy rage beat").input.style).toBe("bouncy");
    for (const id of ["trap.bounce", "phonk.bounce", "drill.bounce", "jersey.bounce"]) {
      expect(getGrooveById(id)).toBeDefined();
    }
  });

  it("bounce artists: freedia / jubilee / juvenile → trap/bounce 98-104", () => {
    const freedia = parseIntentText("big freedia bounce beat");
    expect(freedia.input.genre).toBe("trap");
    expect(freedia.input.style).toBe("bounce");
    expect(freedia.input.bpmRange).toEqual([98, 104]);
    expect(parseIntentText("dj jubilee type beat").input.style).toBe("bounce");
    expect(parseIntentText("juvenile type beat").input.bpmRange).toEqual([98, 104]);
  });

  it("miami bass: 2 live crew → trap/miamibass 115-125 on a real groove", () => {
    const luke = parseIntentText("2 live crew type beat");
    expect(luke.input.genre).toBe("trap");
    expect(luke.input.style).toBe("miamibass");
    expect(luke.input.bpmRange).toEqual([115, 125]);
    expect(parseIntentText("miami bass beat").input.style).toBe("miamibass");
    expect(parseIntentText("booty bass beat").input.genre).toBe("trap");
    expect(getGrooveById("trap.miamibass")).toBeDefined();
  });

  it("snap era: soulja boy + D4L lane → trap/snap 80-95, minimal", () => {
    const soulja = parseIntentText("soulja boy type beat");
    expect(soulja.input.genre).toBe("trap");
    expect(soulja.input.style).toBe("snap");
    expect(soulja.input.bpmRange).toEqual([80, 95]);
    expect(soulja.input.density).toBe(0.4);
    expect(parseIntentText("d4l type beat").input.style).toBe("snap");
    expect(parseIntentText("laffy taffy beat").detected).toContain("♪ snap era");
    expect(parseIntentText("ringtone rap beat").input.style).toBe("snap");
    // DAW grid-snap talk must not hijack the groove
    expect(parseIntentText("snap to grid").input.style).toBeUndefined();
    expect(getGrooveById("trap.snap")).toBeDefined();
  });

  it("afroswing: j hus lane → house/afroswing ~104 on a real groove", () => {
    const hus = parseIntentText("j hus type beat");
    expect(hus.input.genre).toBe("house");
    expect(hus.input.style).toBe("afroswing");
    expect(hus.input.bpmRange).toEqual([100, 108]);
    expect(parseIntentText("afro swing beat").input.style).toBe("afroswing");
    expect(parseIntentText("afroswing type beat").input.genre).toBe("house");
    expect(getGrooveById("house.afroswing")).toBeDefined();
  });

  it("countrytune: lil nas x → trap/countrytune (nas-blend stays in pocket)", () => {
    const nas = parseIntentText("lil nas x type beat");
    expect(nas.input.genre).toBe("trap");
    expect(nas.input.style).toBe("countrytune");
    expect(nas.input.bpmRange).toEqual([88, 92]);
    const road = parseIntentText("old town road beat");
    expect(road.input.style).toBe("countrytune");
    expect(road.input.bpmRange).toEqual([78, 92]);
    expect(parseIntentText("country rap beat").input.style).toBe("countrytune");
    expect(getGrooveById("trap.countrytune")).toBeDefined();
  });

  it("every new groove generates a pattern end-to-end", async () => {
    const doc = testDoc();
    for (const style of ["bounce", "miamibass", "snap", "countrytune"]) {
      const result = await generateAsyncResult(doc, normalizeIntent({ genre: "trap", style, seed: "bounce-wave" }), {
        mode: "apply",
      });
      expect(result.proposal?.pattern.generation?.grooveId ?? result.plan.groove.id).toBe(`trap.${style}`);
    }
    const afro = await generateAsyncResult(
      doc,
      normalizeIntent({ genre: "house", style: "afroswing", seed: "bounce-wave" }),
      { mode: "apply" },
    );
    expect(afro.proposal?.pattern.generation?.grooveId ?? afro.plan.groove.id).toBe("house.afroswing");
  });
});

describe("legends + dirty south + g-era + griselda/three6 (legends wave)", () => {
  it("90s NY: 2pac / biggie / wu-tang (+raekwon) / jay-z / mobb deep → classic dark 84-96", () => {
    const pac = parseIntentText("2pac type beat");
    expect(pac.input.genre).toBe("trap");
    expect(pac.input.style).toBe("classic");
    expect(pac.input.mood).toBe("dark");
    expect(pac.input.bpmRange).toEqual([88, 95]);
    expect(parseIntentText("biggie type beat").input.bpmRange).toEqual([87, 94]);
    expect(parseIntentText("raekwon type beat").input.style).toBe("classic");
    expect(parseIntentText("raekwon type beat").detected).toContain("♪ wu-tang");
    expect(parseIntentText("jay-z type beat").input.bpmRange).toEqual([86, 95]);
    expect(parseIntentText("mobb deep type beat").input.style).toBe("classic");
    expect(getGrooveById("trap.classic")).toBeDefined();
  });

  it("dirty south founders: outkast / ugk / scarface / t.i. / jeezy / gucci / mannie", () => {
    expect(parseIntentText("outkast type beat").input.mood).toBe("chill");
    expect(parseIntentText("ugk type beat").input.bpmRange).toEqual([82, 94]);
    expect(parseIntentText("scarface type beat").input.style).toBe("classic");
    expect(parseIntentText("t.i. type beat").input.style).toBe("classic");
    expect(parseIntentText("jeezy type beat").input.style).toBe("rolling");
    expect(parseIntentText("gucci mane type beat").input.style).toBe("sparse");
    expect(parseIntentText("mannie fresh type beat").input.style).toBe("bounce");
  });

  it("2000s mainstream: eminem / 50 / wayne / ross / dmx / busta / missy-timbaland", () => {
    expect(parseIntentText("eminem type beat").input.mood).toBe("aggressive");
    expect(parseIntentText("50 cent type beat").input.style).toBe("classic");
    expect(parseIntentText("lil wayne type beat").input.style).toBe("bouncy");
    expect(parseIntentText("rick ross type beat").input.style).toBe("rolling");
    expect(parseIntentText("dmx type beat").input.style).toBe("classic");
    // name-masking: "dark" in "dark man x" must not flip the preset mood
    expect(parseIntentText("dark man x type beat").input.mood).toBe("aggressive");
    // ...but a name that IS the descriptor keeps the legacy reading
    expect(parseIntentText("neurofunk at 174").input.style).toBe("neuro");
    // "x type beat" still belongs to xxxtentacion, not DMX
    expect(parseIntentText("x type beat").detected).toContain("♪ xxxtentacion");
    expect(parseIntentText("busta rhymes type beat").input.style).toBe("bouncy");
    expect(parseIntentText("timbaland type beat").detected).toContain("♪ missy / timbaland");
    expect(parseIntentText("neptunes type beat").input.style).toBe("bouncy");
  });

  it("bay/LA g-era: too $hort / quik / kurupt / yg-mustard / nipsey / blueface", () => {
    expect(parseIntentText("too short type beat").input.style).toBe("gfunk");
    expect(parseIntentText("dj quik type beat").input.style).toBe("gfunk");
    expect(parseIntentText("kurupt type beat").input.style).toBe("headnod");
    expect(parseIntentText("yg type beat").input.style).toBe("detroit");
    expect(parseIntentText("nipsey hussle type beat").input.style).toBe("headnod");
    expect(parseIntentText("blueface type beat").input.style).toBe("detroit");
    expect(getGrooveById("trap.detroit")).toBeDefined();
  });

  it("three 6 + griselda ride existing grooves (memphis / classic)", () => {
    const three6 = parseIntentText("juicy j type beat");
    expect(three6.input.genre).toBe("phonk");
    expect(three6.input.style).toBe("memphis");
    expect(parseIntentText("dj paul type beat").detected).toContain("♪ three 6 mafia");
    const griz = parseIntentText("westside gunn type beat");
    expect(griz.input.style).toBe("classic");
    expect(griz.input.bpmRange).toEqual([84, 94]);
    expect(parseIntentText("earl sweatshirt type beat").input.mood).toBe("chill");
  });

  it("explicit words still override legends presets", () => {
    const bright = parseIntentText("2pac type beat bright");
    expect(bright.input.mood).toBe("energetic");
    expect(bright.input.genre).toBe("trap");
  });
});
describe("mainstream heavyweights roster", () => {
  it("drake → sparse Toronto dark; kodak → Florida lazy chill", () => {
    const drake = parseIntentText("drake type beat");
    expect(drake.input.genre).toBe("trap");
    expect(drake.input.style).toBe("sparse");
    expect(drake.input.bpmRange).toEqual([128, 142]);
    expect(parseIntentText("ovo beat").input.style).toBe("sparse");
    const kodak = parseIntentText("kodak black type beat");
    expect(kodak.input.mood).toBe("chill");
    expect(kodak.input.style).toBe("sparse");
  });

  it("melodic drill corner: lil durk / polo g on the drill family", () => {
    for (const name of ["lil durk", "polo g"]) {
      const parsed = parseIntentText(`${name} type beat`);
      expect(parsed.input.genre).toBe("drill");
      expect(parsed.input.style).toBe("dark");
    }
  });

  it("emo/aggro corner: juice wrld rolling, x hyper, denzel + jpegmafi", () => {
    expect(parseIntentText("juice wrld type beat").input.style).toBe("rolling");
    expect(parseIntentText("999 beat").input.style).toBe("rolling");
    expect(parseIntentText("xxxtentacion type beat").input.mood).toBe("aggressive");
    expect(parseIntentText("denzel curry type beat").input.bpmRange).toEqual([140, 160]);
    expect(parseIntentText("jpegmafia type beat").input.style).toBe("hyper");
  });

  it("conscious boom bap corner: tyler / mac miller at the slow pocket", () => {
    const tyler = parseIntentText("igor type beat");
    expect(tyler.input.style).toBe("classic");
    expect(tyler.input.bpmRange).toEqual([75, 105]);
    expect(parseIntentText("mac miller type beat").input.mood).toBe("chill");
    expect(parseIntentText("mac miller type beat").input.style).toBe("classic");
  });

  it("sing-rap corner: rod wave / lil peep / a boogie sparse; megan rolling houston", () => {
    expect(parseIntentText("rod wave type beat").input.style).toBe("sparse");
    expect(parseIntentText("lil peep type beat").input.mood).toBe("chill");
    expect(parseIntentText("a boogie type beat").input.style).toBe("sparse");
    const megan = parseIntentText("megan thee stallion type beat");
    expect(megan.input.style).toBe("rolling");
    expect(megan.input.bpmRange).toEqual([125, 140]);
  });
});

describe("jersey / drill / phonk depth wave (researched pockets)", () => {
  it("jersey corner: uniiqu3 queen / tameil pioneer / sliink exporter / 2rare viral", () => {
    const queen = parseIntentText("uniiqu3 type beat");
    expect(queen.input.genre).toBe("jersey");
    expect(queen.input.style).toBe("club");
    expect(queen.input.bpmRange).toEqual([134, 140]);
    expect(queen.detected).toContain("♪ uniiqu3");
    const tameil = parseIntentText("dj tameil type beat");
    expect(tameil.input.genre).toBe("jersey");
    expect(tameil.input.bpmRange).toEqual([128, 136]);
    expect(parseIntentText("brick bandits beat").input.genre).toBe("jersey");
    expect(parseIntentText("dj sliink type beat").input.style).toBe("bounce");
    expect(parseIntentText("2rare type beat").input.bpmRange).toEqual([134, 142]);
  });

  it("sexy drill corner: cash cobain + chow lee stay drill/bounce party", () => {
    const cash = parseIntentText("cash cobain type beat");
    expect(cash.input.genre).toBe("drill");
    expect(cash.input.style).toBe("bounce");
    expect(cash.input.mood).toBe("energetic");
    expect(cash.input.bpmRange).toEqual([138, 145]);
    expect(parseIntentText("chow lee type beat").input.style).toBe("bounce");
    expect(parseIntentText("sexy drill beat").input.genre).toBe("drill");
  });

  it("ny drill corner: fivio / sheff g + sleepy hallow dark and aggressive", () => {
    const fivio = parseIntentText("fivio foreign type beat");
    expect(fivio.input.genre).toBe("drill");
    expect(fivio.input.style).toBe("dark");
    expect(fivio.input.mood).toBe("aggressive");
    expect(fivio.input.bpmRange).toEqual([140, 145]);
    expect(parseIntentText("big drip type beat").input.style).toBe("dark");
    expect(parseIntentText("sheff g type beat").input.bpmRange).toEqual([138, 143]);
    expect(parseIntentText("sleepy hallow type beat").input.mood).toBe("aggressive");
  });

  it("uk drill corner: headie / digga / 808melo / axl / ghosty / m1", () => {
    expect(parseIntentText("headie one type beat").input.style).toBe("uk");
    expect(parseIntentText("headie one type beat").input.bpmRange).toEqual([138, 143]);
    expect(parseIntentText("digga d type beat").input.mood).toBe("aggressive");
    const melo = parseIntentText("808melo type beat");
    expect(melo.input.genre).toBe("drill");
    expect(melo.input.style).toBe("dark");
    expect(melo.input.bpmRange).toEqual([138, 144]);
    expect(parseIntentText("axl beats type beat").input.style).toBe("uk");
    expect(parseIntentText("ghosty type beat").input.mood).toBe("dark");
    expect(parseIntentText("m1onthebeat type beat").input.style).toBe("uk");
  });

  it("chicago corner: g herbo punchy and aggressive", () => {
    const herbo = parseIntentText("g herbo type beat");
    expect(herbo.input.genre).toBe("drill");
    expect(herbo.input.style).toBe("dark");
    expect(herbo.input.bpmRange).toEqual([138, 146]);
  });

  it("phonk corner: kaito + pharmacist drift; xavier / lovell / bones memphis lofi", () => {
    const kaito = parseIntentText("kaito shoma type beat");
    expect(kaito.input.genre).toBe("phonk");
    expect(kaito.input.style).toBe("drift");
    expect(kaito.input.bpmRange).toEqual([140, 155]);
    expect(parseIntentText("scary garry beat").input.style).toBe("drift");
    expect(parseIntentText("pharmacist type beat").input.mood).toBe("aggressive");
    expect(parseIntentText("xavier wulf type beat").input.style).toBe("memphis");
    expect(parseIntentText("night lovell type beat").input.mood).toBe("dark");
    const bones = parseIntentText("bones type beat");
    expect(bones.input.mood).toBe("chill");
    expect(bones.input.bpmRange).toEqual([120, 130]);
  });

  it("the wave's styles resolve to real groove ids (resolveGroove contract)", () => {
    for (const id of [
      "jersey.club",
      "jersey.bounce",
      "drill.dark",
      "drill.uk",
      "drill.bounce",
      "phonk.drift",
      "phonk.memphis",
    ]) {
      expect(getGrooveById(id)).toBeDefined();
    }
  });

  it("explicit words still override the new presets", () => {
    const chill = parseIntentText("fivio foreign type beat chill");
    expect(chill.input.mood).toBe("chill");
    expect(chill.input.genre).toBe("drill");
    const dark = parseIntentText("uniiqu3 type beat dark");
    expect(dark.input.mood).toBe("dark");
    expect(dark.input.genre).toBe("jersey");
  });
});

describe("club depth wave 2 (second line jersey + bronx + drift anthems)", () => {
  it("jersey second line: mcvertt / jayhood / nadus / r3ll / unicorn151", () => {
    const mcvertt = parseIntentText("mcvertt type beat");
    expect(mcvertt.input.genre).toBe("jersey");
    expect(mcvertt.input.style).toBe("club");
    expect(mcvertt.input.bpmRange).toEqual([136, 142]);
    expect(parseIntentText("just wanna rock beat").input.genre).toBe("jersey");
    expect(parseIntentText("dj jayhood type beat").input.style).toBe("club");
    expect(parseIntentText("nadus type beat").input.style).toBe("bounce");
    expect(parseIntentText("r3ll type beat").input.bpmRange).toEqual([132, 142]);
    const uni = parseIntentText("unicorn151 type beat");
    expect(uni.input.genre).toBe("jersey");
    expect(uni.input.mood).toBe("aggressive");
    expect(parseIntentText("killa kherk cobain beat").input.genre).toBe("jersey");
  });

  it("bronx drill: b-lovee melodic bridge vs kay flock full aggression", () => {
    const lovee = parseIntentText("b-lovee type beat");
    expect(lovee.input.genre).toBe("drill");
    expect(lovee.input.style).toBe("dark");
    expect(lovee.input.mood).toBe("energetic");
    const flock = parseIntentText("kay flock type beat");
    expect(flock.input.mood).toBe("aggressive");
    expect(flock.input.bpmRange).toEqual([140, 145]);
  });

  it("uk forefront: unknown t homerton dark", () => {
    const unknown = parseIntentText("unknown t type beat");
    expect(unknown.input.genre).toBe("drill");
    expect(unknown.input.style).toBe("uk");
    expect(unknown.input.bpmRange).toEqual([138, 144]);
  });

  it("drift anthems: interworld metamorphosis + dxrk rave", () => {
    const inter = parseIntentText("interworld type beat");
    expect(inter.input.genre).toBe("phonk");
    expect(inter.input.style).toBe("drift");
    expect(inter.input.bpmRange).toEqual([140, 155]);
    expect(parseIntentText("metamorphosis beat").input.style).toBe("drift");
    expect(parseIntentText("dxrk type beat").input.mood).toBe("aggressive");
    expect(parseIntentText("rave phonk beat").input.style).toBe("drift");
  });
});

describe("bass-house / g-house / future-bass / riddim-dubstep / hardstyle / psytrance (electronic depth)", () => {
  // Each block covers one of the six new electronic-lane presets, asserting
  // genre + style + BPM + mood against the researched values.
  it("chris lake / acraze / sidepiece → bass house at the tech-house tempo", () => {
    const chris = parseIntentText("chris lake type beat");
    expect(chris.input.genre).toBe("house");
    expect(chris.input.style).toBe("basshouse");
    expect(chris.input.bpmRange).toEqual([124, 130]);
    expect(chris.input.energy).toBe(0.85);
  });

  it("don diablo / tchami / malaa → g-house (deep, chill, French vocal-chop floor)", () => {
    const don = parseIntentText("don diablo type beat");
    expect(don.input.genre).toBe("house");
    expect(don.input.style).toBe("ghouse");
    expect(don.input.bpmRange).toEqual([120, 126]);
    expect(don.input.mood).toBe("chill");
  });

  it("marshmello / said the sky → future bass (broken / 140-150)", () => {
    const mello = parseIntentText("marshmello type beat");
    expect(mello.input.genre).toBe("house");
    expect(mello.input.style).toBe("broken");
    expect(mello.input.bpmRange).toEqual([140, 150]);
    expect(mello.input.energy).toBe(0.85);
  });

  it("virtual riot / borgore → riddim dubstep (aggressive, 140-150)", () => {
    const vrit = parseIntentText("virtual riot type beat");
    expect(vrit.input.genre).toBe("trap");
    expect(vrit.input.style).toBe("dubstep");
    expect(vrit.input.bpmRange).toEqual([140, 150]);
    expect(vrit.input.mood).toBe("aggressive");
  });

  it("headhunterz / sound rush / ran-d → hardstyle (techno hard, 150-155)", () => {
    const head = parseIntentText("headhunterz type beat");
    expect(head.input.genre).toBe("techno");
    expect(head.input.style).toBe("hardstyle");
    expect(head.input.bpmRange).toEqual([150, 155]);
    expect(head.input.energy).toBe(0.95);
  });

  it("astrix / vini vici / infected mushroom → psytrance (techno acid, 138-145)", () => {
    const astrix = parseIntentText("astrix type beat");
    expect(astrix.input.genre).toBe("techno");
    expect(astrix.input.style).toBe("psytrance");
    expect(astrix.input.bpmRange).toEqual([138, 145]);
    expect(astrix.input.energy).toBe(0.9);
  });

  it("the electronic-depth lanes resolve to real groove ids (resolveGroove contract)", () => {
    // Engine integration smoke — each preset's style must resolve to a real
    // `genre.style` grooveId via getGrooveById. Wave 3 added dedicated grooves
    // for bass-house (house.basshouse), g-house (house.ghouse), hardstyle
    // (techno.hardstyle), and psytrance (techno.psytrance); the corresponding
    // artist presets now route to those first-class grooves instead of the
    // closest-fit mappings.
    expect(getGrooveById("house.basshouse")).toBeDefined();
    expect(getGrooveById("house.ghouse")).toBeDefined();
    expect(getGrooveById("house.broken")).toBeDefined();
    expect(getGrooveById("trap.dubstep")).toBeDefined();
    expect(getGrooveById("techno.hardstyle")).toBeDefined();
    expect(getGrooveById("techno.psytrance")).toBeDefined();
  });
});

describe("vaporwave / synthwave / lofi / downtempo / plugg-newer / trap-soul (chill + electronic-depth wave)", () => {
  // Each block covers one of the six new chill/electronic presets, asserting
  // genre + style + BPM + mood against the researched values. The synthwave
  // lane maps onto ambient.organic (no dedicated synthwave groove yet);
  // vaporwave + lofi both map onto ambient.drifting; downtempo onto
  // ambient.organic; plugg-newer onto trap.plugg; trap-soul onto trap.sparse.
  it("vaporwave / macintosh plus / vektroid → ambient drifting at 70-85", () => {
    // 'vaporwave' (bare) lives in an earlier parallel-session entry (2814);
    // we exercise this lane via the unique producer names instead.
    const vw = parseIntentText("vektroid type beat");
    expect(vw.input.genre).toBe("ambient");
    expect(vw.input.style).toBe("drifting");
    expect(vw.input.bpmRange).toEqual([70, 85]);
    expect(vw.input.mood).toBe("chill");
    expect(vw.input.energy).toBe(0.2);
  });

  it("synthwave / kavinsky / the midnight → ambient organic at 95-115", () => {
    const kav = parseIntentText("kavinsky type beat");
    expect(kav.input.genre).toBe("ambient");
    expect(kav.input.style).toBe("organic");
    expect(kav.input.bpmRange).toEqual([95, 115]);
    expect(kav.input.mood).toBe("chill");
  });

  it("lofi / nujabes / dj okawari → ambient drifting at 75-92 (jazz-sample)", () => {
    const nuj = parseIntentText("nujabes type beat");
    expect(nuj.input.genre).toBe("ambient");
    expect(nuj.input.style).toBe("drifting");
    expect(nuj.input.bpmRange).toEqual([75, 92]);
    expect(nuj.input.energy).toBe(0.35);
  });

  it("downtempo / bonobo / caribou / bibio → ambient organic at 92-110", () => {
    const bon = parseIntentText("bonobo type beat");
    expect(bon.input.genre).toBe("ambient");
    expect(bon.input.style).toBe("organic");
    expect(bon.input.bpmRange).toEqual([92, 110]);
    expect(bon.input.mood).toBe("chill");
  });

  it("nettspend / homixide gang / 2hollis → trap plugg at 130-150", () => {
    const ns = parseIntentText("nettspend type beat");
    expect(ns.input.genre).toBe("trap");
    expect(ns.input.style).toBe("plugg");
    expect(ns.input.bpmRange).toEqual([130, 150]);
    expect(ns.input.energy).toBe(0.7);
  });

  it("bryson tiller / partynextdoor / 6lack → trap sparse at 78-95 (R&B-trap)", () => {
    const bt = parseIntentText("bryson tiller type beat");
    expect(bt.input.genre).toBe("trap");
    expect(bt.input.style).toBe("sparse");
    expect(bt.input.bpmRange).toEqual([78, 95]);
    expect(bt.input.mood).toBe("chill");
  });

  it("the chill + electronic-depth lanes resolve to real groove ids (resolveGroove contract)", () => {
    // Engine integration smoke — each preset's style must resolve to a real
    // `genre.style` grooveId via getGrooveById.
    expect(getGrooveById("ambient.drifting")).toBeDefined();
    expect(getGrooveById("ambient.organic")).toBeDefined();
    expect(getGrooveById("trap.plugg")).toBeDefined();
    expect(getGrooveById("trap.sparse")).toBeDefined();
  });
});

describe("afrobeats / latin urban / k-pop / dancehall / city pop / 88rising (global-pop wave)", () => {
  // Each block covers one of the six new global-pop presets, asserting
  // genre + style + BPM + mood against the researched values. The bare
  // 'afrobeat' / 'amapiano' / 'k-pop' names live in earlier entries; we
  // exercise these lanes via unique artist names where possible.
  it("wizkid / burna boy / davido → afrobeats (house afropop, 100-112)", () => {
    const wiz = parseIntentText("wizkid type beat");
    expect(wiz.input.genre).toBe("house");
    expect(wiz.input.style).toBe("afropop");
    expect(wiz.input.bpmRange).toEqual([100, 112]);
    expect(wiz.input.mood).toBe("chill");
  });

  it("j balvin / ozuna / rosalia → latin urban (house dembow, 88-100)", () => {
    const jb = parseIntentText("j balvin type beat");
    expect(jb.input.genre).toBe("house");
    expect(jb.input.style).toBe("dembow");
    expect(jb.input.bpmRange).toEqual([88, 100]);
    expect(jb.input.energy).toBe(0.75);
  });

  it("bts / newjeans / blackpink → k-pop (house pop, 100-120)", () => {
    const bts = parseIntentText("bts type beat");
    expect(bts.input.genre).toBe("house");
    expect(bts.input.style).toBe("pop");
    expect(bts.input.bpmRange).toEqual([100, 120]);
    expect(bts.input.energy).toBe(0.85);
  });

  it("sean paul / vybz kartel / popcaan → dancehall (trap bounce, 88-105)", () => {
    const sp = parseIntentText("sean paul type beat");
    expect(sp.input.genre).toBe("trap");
    expect(sp.input.style).toBe("bounce");
    expect(sp.input.bpmRange).toEqual([88, 105]);
  });

  it("anri / tatsuro yamashita / mariya takeuchi → city pop (ambient organic, 100-125)", () => {
    const anri = parseIntentText("anri type beat");
    expect(anri.input.genre).toBe("ambient");
    expect(anri.input.style).toBe("organic");
    expect(anri.input.bpmRange).toEqual([100, 125]);
    expect(anri.input.mood).toBe("chill");
  });

  it("joji / rich brian / niki → 88rising (trap lux, 80-110)", () => {
    const joji = parseIntentText("joji type beat");
    expect(joji.input.genre).toBe("trap");
    expect(joji.input.style).toBe("lux");
    expect(joji.input.bpmRange).toEqual([80, 110]);
    expect(joji.input.mood).toBe("chill");
  });

  it("the global-pop lanes resolve to real groove ids (resolveGroove contract)", () => {
    // Engine integration smoke — each preset's style must resolve to a real
    // `genre.style` grooveId via getGrooveById.
    expect(getGrooveById("house.afro")).toBeDefined();
    expect(getGrooveById("house.dancefloor")).toBeDefined();
    expect(getGrooveById("house.pop")).toBeDefined();
    expect(getGrooveById("trap.bounce")).toBeDefined();
    expect(getGrooveById("ambient.organic")).toBeDefined();
    expect(getGrooveById("trap.lux")).toBeDefined();
  });
});

describe("hyperpop / baile funk / corridos tumbados / industrial techno / footwork / melodic house (club + global wave)", () => {
  // Each block covers one of the six new club / global presets, asserting
  // genre + style + BPM + mood against the researched values.
  it("a.g. cook / 100 gecs / underscores → hyperpop wave (trap hyper, 140-160)", () => {
    // parseIntentText's preprocess collapses all periods into whitespace
    // (regex /[\s,.]+/g), so the "a.g. cook" name won't match the regex
    // pattern. We use "ag cook" (period-free variant) to exercise the lane.
    const ag = parseIntentText("ag cook type beat");
    expect(ag.input.genre).toBe("trap");
    expect(ag.input.style).toBe("hyper");
    expect(ag.input.bpmRange).toEqual([140, 160]);
    expect(ag.input.energy).toBe(0.9);
  });

  it("anitta / mc kevin o chris → baile funk (house dancefloor, 130-150)", () => {
    const ani = parseIntentText("anitta type beat");
    expect(ani.input.genre).toBe("house");
    expect(ani.input.style).toBe("dancefloor");
    expect(ani.input.bpmRange).toEqual([130, 150]);
    expect(ani.input.energy).toBe(0.85);
  });

  it("peso pluma / natanael cano → corridos tumbados (trap countrytune, 90-130)", () => {
    const pp = parseIntentText("peso pluma type beat");
    expect(pp.input.genre).toBe("trap");
    expect(pp.input.style).toBe("countrytune");
    expect(pp.input.bpmRange).toEqual([90, 130]);
    expect(pp.input.mood).toBe("dark");
  });

  it("surgeon / ancient methods → industrial techno (techno industrial, 130-140)", () => {
    const surg = parseIntentText("surgeon type beat");
    expect(surg.input.genre).toBe("techno");
    expect(surg.input.style).toBe("industrial");
    expect(surg.input.bpmRange).toEqual([130, 140]);
    expect(surg.input.mood).toBe("dark");
  });

  it("rp boo / dj rashad → footwork (house dancefloor, 155-165)", () => {
    const rp = parseIntentText("rp boo type beat");
    expect(rp.input.genre).toBe("house");
    expect(rp.input.style).toBe("footwork");
    expect(rp.input.bpmRange).toEqual([155, 165]);
    expect(rp.input.energy).toBe(0.95);
  });

  it("tinlicker / lane 8 / yotto → melodic house (house deep, 120-128)", () => {
    const t = parseIntentText("tinlicker type beat");
    expect(t.input.genre).toBe("house");
    expect(t.input.style).toBe("deep");
    expect(t.input.bpmRange).toEqual([120, 128]);
    expect(t.input.mood).toBe("chill");
  });

  it("the club + global lanes resolve to real groove ids (resolveGroove contract)", () => {
    // Engine integration smoke — each preset's style must resolve to a real
    // `genre.style` grooveId via getGrooveById. Wave 3 promoted footwork from
    // house.dancefloor (closest-fit) to house.footwork (first-class).
    expect(getGrooveById("trap.hyper")).toBeDefined();
    expect(getGrooveById("trap.countrytune")).toBeDefined();
    expect(getGrooveById("techno.industrial")).toBeDefined();
    expect(getGrooveById("house.footwork")).toBeDefined();
  });
});

describe("regional now + female / latin / scloud / experimental (now wave)", () => {
  it("chicago: king von drill + conscious classic (SK-safe names)", () => {
    const von = parseIntentText("king von type beat");
    expect(von.input.genre).toBe("drill");
    expect(von.input.style).toBe("dark");
    expect(von.input.bpmRange).toEqual([135, 145]);
    const chi = parseIntentText("chance the rapper type beat");
    expect(chi.input.style).toBe("classic");
    expect(chi.input.bpmRange).toEqual([82, 94]);
    expect(parseIntentText("noname type beat").detected).toContain("♪ chicago conscious");
    expect(parseIntentText("saba type beat").input.style).toBe("classic");
    expect(getGrooveById("drill.dark")).toBeDefined();
  });

  it("detroit now + LA now ride detroit/sparse (SK-safe names)", () => {
    const det = parseIntentText("sada baby type beat");
    expect(det.input.genre).toBe("trap");
    expect(det.input.style).toBe("detroit");
    expect(det.input.bpmRange).toEqual([130, 148]);
    expect(parseIntentText("icewear vezzo type beat").input.style).toBe("detroit");
    expect(parseIntentText("rio da yung og type beat").input.style).toBe("detroit");
    // "sada" alone is Slovak for "now" — must not match the artist
    expect(matchArtistPreset(" sprav mi beat sada ")).toBeNull();
    const drakeo = parseIntentText("drakeo the ruler type beat");
    expect(drakeo.input.style).toBe("detroit");
    expect(parseIntentText("remble type beat").input.style).toBe("detroit");
    const blxst = parseIntentText("blxst type beat");
    expect(blxst.input.style).toBe("sparse");
    expect(blxst.input.bpmRange).toEqual([125, 140]);
    expect(getGrooveById("trap.detroit")).toBeDefined();
  });

  it("new rage: osamason bouncy (nettspend/2hollis live in plugg newer wave)", () => {
    const osa = parseIntentText("osamason type beat");
    expect(osa.input.style).toBe("bouncy");
    expect(osa.input.bpmRange).toEqual([148, 165]);
    expect(parseIntentText("nettspend type beat").input.style).toBe("plugg");
  });

  it("uk pop-drill: dave melodic / stormzy grime / 22gz dark", () => {
    const dave = parseIntentText("dave type beat");
    expect(dave.input.genre).toBe("drill");
    expect(dave.input.style).toBe("melodic");
    expect(dave.input.bpmRange).toEqual([138, 145]);
    expect(parseIntentText("stormzy type beat").input.style).toBe("grime");
    expect(parseIntentText("22gz type beat").input.style).toBe("dark");
    expect(getGrooveById("drill.melodic")).toBeDefined();
    expect(getGrooveById("drill.grime")).toBeDefined();
  });

  it("female rap: nicki / cardi / latto / glorilla / sexyy / doechii / simz", () => {
    expect(parseIntentText("nicki minaj type beat").input.style).toBe("rolling");
    expect(parseIntentText("nicki minaj type beat").input.bpmRange).toEqual([130, 145]);
    expect(parseIntentText("cardi b type beat").input.mood).toBe("aggressive");
    expect(parseIntentText("latto type beat").input.style).toBe("rolling");
    const glo = parseIntentText("glorilla type beat");
    expect(glo.input.style).toBe("crunk");
    expect(glo.input.bpmRange).toEqual([98, 108]);
    expect(parseIntentText("f n f beat").detected).toContain("♪ glorilla");
    expect(parseIntentText("sexyy red type beat").input.style).toBe("rolling");
    expect(parseIntentText("doechii type beat").input.style).toBe("bouncy");
    expect(parseIntentText("little simz type beat").input.style).toBe("classic");
    expect(getGrooveById("trap.crunk")).toBeDefined();
  });

  it("latin trap + french cloud: bunny / myke / duki / pnl", () => {
    expect(parseIntentText("bad bunny type beat").input.style).toBe("rolling");
    expect(parseIntentText("bad bunny type beat").input.bpmRange).toEqual([95, 125]);
    expect(parseIntentText("myke towers type beat").input.style).toBe("rolling");
    expect(parseIntentText("duki type beat").input.mood).toBe("aggressive");
    const pnl = parseIntentText("pnl type beat");
    expect(pnl.input.style).toBe("sparse");
    expect(pnl.input.mood).toBe("chill");
  });

  it("soundcloud era: ski hyper / purpp rolling dark / pump rolling", () => {
    expect(parseIntentText("ski mask type beat").input.style).toBe("hyper");
    const purpp = parseIntentText("smokepurpp type beat");
    expect(purpp.input.style).toBe("rolling");
    expect(purpp.input.mood).toBe("dark");
    expect(parseIntentText("lil pump type beat").input.style).toBe("rolling");
    expect(parseIntentText("gucci gang beat").detected).toContain("♪ lil pump");
  });

  it("experimental edge: death grips → dnb.amen, clipping. → phonk horror", () => {
    const dg = parseIntentText("death grips type beat");
    expect(dg.input.genre).toBe("dnb");
    expect(dg.input.style).toBe("amen");
    expect(dg.input.bpmRange).toEqual([160, 168]);
    const clip = parseIntentText("clipping type beat");
    expect(clip.input.genre).toBe("phonk");
    expect(clip.input.style).toBe("horror");
    // bare "clipping" is an audio term — must not match
    expect(matchArtistPreset(" add clipping to the master ")).toBeNull();
    expect(getGrooveById("dnb.amen")).toBeDefined();
    expect(getGrooveById("phonk.horror")).toBeDefined();
  });
});

describe("trap producers + memphis OGs + UKG revival + UK drill second line (producer wave)", () => {
  it("808 Mafia corner: wheezy lux / southside dark / tm88 bounce", () => {
    const wheezy = parseIntentText("wheezy type beat");
    expect(wheezy.input.genre).toBe("trap");
    expect(wheezy.input.style).toBe("lux");
    expect(wheezy.input.bpmRange).toEqual([130, 146]);
    const southside = parseIntentText("southside type beat");
    expect(southside.input.style).toBe("dark");
    expect(southside.input.mood).toBe("aggressive");
    expect(parseIntentText("808 mafia type beat").input.style).toBe("dark");
    const tm88 = parseIntentText("tm88 type beat");
    expect(tm88.input.style).toBe("bouncy");
    expect(tm88.input.bpmRange).toEqual([138, 150]);
  });

  it("A-list producers: mike will / murda / hit-boy / london / wondagurl / sonny", () => {
    const will = parseIntentText("mike will made it type beat");
    expect(will.input.style).toBe("dark");
    expect(will.input.bpmRange).toEqual([138, 150]);
    expect(parseIntentText("mike will type beat").input.style).toBe("dark");
    expect(parseIntentText("murda beatz type beat").input.style).toBe("bouncy");
    expect(parseIntentText("hit-boy type beat").input.style).toBe("rolling");
    expect(parseIntentText("london on da track type beat").input.style).toBe("bouncy");
    expect(parseIntentText("wondagurl type beat").input.mood).toBe("dark");
    expect(parseIntentText("sonny digital type beat").input.style).toBe("rolling");
  });

  it("memphis OG producers: squeeky / spanish fly / skinny pimp / playa fly / tommy wright", () => {
    const squeeky = parseIntentText("dj squeeky type beat");
    expect(squeeky.input.genre).toBe("phonk");
    expect(squeeky.input.style).toBe("memphis");
    expect(squeeky.input.bpmRange).toEqual([120, 140]);
    expect(parseIntentText("dj spanish fly type beat").input.style).toBe("memphis");
    expect(parseIntentText("kingpin skinny pimp type beat").input.style).toBe("memphis");
    expect(parseIntentText("playa fly type beat").input.style).toBe("memphis");
    expect(parseIntentText("tommy wright iii type beat").input.style).toBe("memphis");
  });

  it("UKG revival: conducta / interplanetary criminal / virji / piri", () => {
    for (const name of ["conducta", "interplanetary criminal", "sammy virji", "piri"]) {
      const parsed = parseIntentText(`${name} type beat`);
      expect(parsed.input.genre, name).toBe("house");
      expect(parsed.input.style, name).toBe("ukg");
    }
    expect(parseIntentText("interplanetary criminal type beat").input.bpmRange).toEqual([132, 142]);
    expect(parseIntentText("piri type beat").input.mood).toBe("chill");
    expect(parseIntentText("virji type beat").input.style).toBe("ukg");
  });

  it("UK drill second line: ofb / loski / harlem spartans / digdat", () => {
    const ofb = parseIntentText("ofb type beat");
    expect(ofb.input.genre).toBe("drill");
    expect(ofb.input.style).toBe("uk");
    expect(ofb.input.bpmRange).toEqual([138, 144]);
    expect(parseIntentText("bandokay type beat").input.style).toBe("uk");
    expect(parseIntentText("loski type beat").input.mood).toBe("aggressive");
    expect(parseIntentText("harlem spartans type beat").input.style).toBe("uk");
    expect(parseIntentText("digdat type beat").input.mood).toBe("dark");
  });

  it("producer-wave styles resolve to real groove ids", () => {
    for (const id of [
      "trap.lux",
      "trap.bouncy",
      "trap.rolling",
      "trap.sparse",
      "phonk.memphis",
      "house.ukg",
      "drill.uk",
    ]) {
      expect(getGrooveById(id), id).toBeDefined();
    }
  });
});

describe("pop wave 2 — dance-pop / pop-rap / retro revival / ballads", () => {
  it("dance-pop block: sia / ava max / zedd / calvin harris / kesha / katy perry", () => {
    expect(parseIntentText("sia type beat").input.bpmRange).toEqual([120, 133]);
    expect(parseIntentText("ava max type beat").input.bpmRange).toEqual([125, 135]);
    expect(parseIntentText("zedd type beat").input.genre).toBe("house");
    expect(parseIntentText("calvin harris type beat").input.style).toBe("dancefloor");
    expect(parseIntentText("ke$ha type beat").input.energy).toBe(0.85);
    expect(parseIntentText("katy perry type beat").input.style).toBe("pop");
  });

  it("pop-rap block: post malone / doja cat / kid laroi / bieber", () => {
    expect(parseIntentText("post malone type beat").input.bpmRange).toEqual([80, 95]);
    expect(parseIntentText("post malone type beat").input.genre).toBe("trap");
    expect(parseIntentText("doja cat type beat").input.style).toBe("pop");
    expect(parseIntentText("kid laroi type beat").input.bpmRange).toEqual([85, 140]);
    expect(parseIntentText("justin bieber type beat").input.mood).toBe("chill");
  });

  it("retro/funk-pop revival: miley / sabrina / chappell roan / harry styles / troye / halsey", () => {
    expect(parseIntentText("miley cyrus type beat").input.style).toBe("funky");
    expect(parseIntentText("miley cyrus type beat").input.bpmRange).toEqual([105, 120]);
    expect(parseIntentText("sabrina carpenter type beat").input.bpmRange).toEqual([100, 112]);
    expect(parseIntentText("chappell roan type beat").input.genre).toBe("house");
    expect(parseIntentText("harry styles type beat").input.mood).toBe("chill");
    expect(parseIntentText("troye sivan type beat").input.style).toBe("pop");
    expect(parseIntentText("halsey type beat").input.bpmRange).toEqual([90, 136]);
  });

  it("ballad pop: adele / sam smith → ambient pop lane", () => {
    expect(parseIntentText("adele type beat").input.genre).toBe("ambient");
    expect(parseIntentText("adele type beat").input.bpmRange).toEqual([70, 100]);
    expect(parseIntentText("sam smith type beat").input.style).toBe("pop");
  });
});

describe("plugg / opium producers + amapiano / afro-house + phonk TikTok wave 2", () => {
  it("plugg producers: mexikodro / cashcache / xangang / senseiatl / forza", () => {
    const mex = parseIntentText("mexikodro type beat");
    expect(mex.input.genre).toBe("trap");
    expect(mex.input.style).toBe("plugg");
    expect(mex.input.bpmRange).toEqual([140, 160]);
    expect(parseIntentText("cashcache type beat").input.style).toBe("plugg");
    expect(parseIntentText("xangang type beat").input.style).toBe("plugg");
    expect(parseIntentText("senseiatl type beat").input.style).toBe("plugg");
    expect(parseIntentText("forza type beat").input.style).toBe("plugg");
  });

  it("opium room: f1lthy / outtatown / lil 88 / ojivolta / richie souf", () => {
    const f1 = parseIntentText("f1lthy type beat");
    expect(f1.input.genre).toBe("trap");
    expect(f1.input.style).toBe("bouncy");
    expect(f1.input.mood).toBe("aggressive");
    expect(f1.input.bpmRange).toEqual([150, 165]);
    expect(parseIntentText("outtatown type beat").input.style).toBe("bouncy");
    expect(parseIntentText("lil 88 type beat").input.style).toBe("bouncy");
    expect(parseIntentText("ojivolta type beat").input.style).toBe("bouncy");
    expect(parseIntentText("richie souf type beat").input.style).toBe("bouncy");
  });

  it("drain gang production: whitearmor / yung gud ethereal plugg", () => {
    const armor = parseIntentText("whitearmor type beat");
    expect(armor.input.style).toBe("plugg");
    expect(armor.input.mood).toBe("chill");
    expect(parseIntentText("yung gud type beat").input.style).toBe("plugg");
    expect(parseIntentText("drain gang type beat").input.mood).toBe("chill");
  });

  it("amapiano producers: kabza / maphorisa / jazziq / waffles / major league / focalistic", () => {
    const kabza = parseIntentText("kabza de small type beat");
    expect(kabza.input.genre).toBe("house");
    expect(kabza.input.style).toBe("afro");
    expect(kabza.input.bpmRange).toEqual([110, 116]);
    expect(parseIntentText("dj maphorisa type beat").input.style).toBe("afro");
    expect(parseIntentText("mr jazziq type beat").input.style).toBe("afro");
    expect(parseIntentText("uncle waffles type beat").input.style).toBe("afro");
    expect(parseIntentText("major league djz type beat").input.style).toBe("afro");
    expect(parseIntentText("focalistic type beat").input.mood).toBe("energetic");
    expect(parseIntentText("kelvin momo type beat").input.mood).toBe("chill");
  });

  it("afro-house producer school: shimza / black motion / da capo / eno napa / themba", () => {
    const shimza = parseIntentText("shimza type beat");
    expect(shimza.input.genre).toBe("house");
    expect(shimza.input.style).toBe("afro");
    expect(shimza.input.bpmRange).toEqual([118, 126]);
    expect(parseIntentText("black motion type beat").input.style).toBe("afro");
    expect(parseIntentText("da capo type beat").input.style).toBe("afro");
    expect(parseIntentText("eno napa type beat").input.style).toBe("afro");
    expect(parseIntentText("themba type beat").input.mood).toBe("energetic");
  });

  it("phonk TikTok wave 2: hensonn / g3ox_em / sxmpra drift; rare phonk school", () => {
    const hensonn = parseIntentText("hensonn type beat");
    expect(hensonn.input.genre).toBe("phonk");
    expect(hensonn.input.style).toBe("drift");
    expect(hensonn.input.bpmRange).toEqual([150, 170]);
    expect(parseIntentText("g3ox_em type beat").input.style).toBe("drift");
    expect(parseIntentText("cypariss type beat").input.style).toBe("drift");
    expect(parseIntentText("sxmpra type beat").input.mood).toBe("aggressive");
    const rare = parseIntentText("mythic type beat");
    expect(rare.input.style).toBe("memphis");
    expect(rare.input.mood).toBe("dark");
    expect(parseIntentText("backwhen type beat").input.style).toBe("memphis");
    expect(parseIntentText("yung vamp type beat").input.style).toBe("memphis");
  });

  it("wave-4 styles resolve to real groove ids", () => {
    for (const id of ["trap.plugg", "trap.bouncy", "house.afro", "phonk.drift", "phonk.memphis"]) {
      expect(getGrooveById(id), id).toBeDefined();
    }
  });
});

describe("techno depth wave (Detroit / dub techno / acid / electro)", () => {
  it("Detroit legends: jeff mills / hawtin / may / atkins / saunderson / craig / hood", () => {
    const mills = parseIntentText("jeff mills type beat");
    expect(mills.input.genre).toBe("techno");
    expect(mills.input.style).toBe("driving");
    expect(mills.input.bpmRange).toEqual([135, 145]);
    expect(parseIntentText("richie hawtin type beat").input.style).toBe("minimal");
    expect(parseIntentText("plastikman type beat").input.mood).toBe("dark");
    expect(parseIntentText("strings of life type beat").input.style).toBe("melodic");
    expect(parseIntentText("juan atkins type beat").input.genre).toBe("techno");
    expect(parseIntentText("model 500 type beat").input.genre).toBe("techno");
    expect(parseIntentText("kevin saunderson type beat").input.genre).toBe("techno");
    expect(parseIntentText("carl craig type beat").input.mood).toBe("chill");
    expect(parseIntentText("robert hood type beat").input.style).toBe("minimal");
    expect(parseIntentText("octave one type beat").input.style).toBe("melodic");
    expect(parseIntentText("terrence dixon type beat").input.genre).toBe("techno");
  });

  it("Detroit soul axis: omar s / moodymann / theo parrish", () => {
    expect(parseIntentText("omar s type beat").input.style).toBe("driving");
    expect(parseIntentText("moodymann type beat").input.style).toBe("melodic");
    expect(parseIntentText("theo parrish type beat").input.mood).toBe("chill");
  });

  it("90s/now hard lineage: clarke / sims / mulero / dvs1 / faki / temple", () => {
    expect(parseIntentText("dave clarke type beat").input.style).toBe("hard");
    expect(parseIntentText("ben sims type beat").input.bpmRange).toEqual([136, 145]);
    expect(parseIntentText("oscar mulero type beat").input.mood).toBe("dark");
    expect(parseIntentText("dvs1 type beat").input.style).toBe("driving");
    expect(parseIntentText("dax j type beat").input.style).toBe("industrial");
    expect(parseIntentText("len faki type beat").input.genre).toBe("techno");
    expect(parseIntentText("speedy j type beat").input.style).toBe("industrial");
    expect(parseIntentText("paula temple type beat").input.mood).toBe("aggressive");
  });

  it("acid lineage fills the empty techno.acid lane", () => {
    expect(parseIntentText("dj pierre type beat").input.style).toBe("acid");
    expect(parseIntentText("phuture type beat").input.style).toBe("acid");
    expect(parseIntentText("hardfloor type beat").input.style).toBe("acid");
    expect(parseIntentText("emmanuel top type beat").input.style).toBe("acid");
    expect(parseIntentText("tin man type beat").input.style).toBe("acid");
    expect(parseIntentText("999999999 type beat").input.style).toBe("acid");
    expect(parseIntentText("nico moreno type beat").input.mood).toBe("aggressive");
  });

  it("dub techno sub-genre: basic channel / deepchord / monolake / yagya", () => {
    const bc = parseIntentText("basic channel type beat");
    expect(bc.input.genre).toBe("techno");
    expect(bc.input.style).toBe("dub");
    expect(bc.input.mood).toBe("chill");
    expect(parseIntentText("rhythm & sound type beat").input.style).toBe("dub");
    expect(parseIntentText("deepchord type beat").input.style).toBe("dub");
    expect(parseIntentText("deadbeat type beat").input.style).toBe("dub");
    expect(parseIntentText("monolake type beat").input.mood).toBe("dark");
    expect(parseIntentText("yagya type beat").input.bpmRange).toEqual([112, 124]);
  });

  it("micro-house + electro: villalobos / perlon / drexciya / stingray / hauff", () => {
    expect(parseIntentText("villalobos type beat").input.style).toBe("minimal");
    expect(parseIntentText("sonja moonear type beat").input.style).toBe("minimal");
    expect(parseIntentText("drexciya type beat").input.mood).toBe("dark");
    expect(parseIntentText("dopplereffekt type beat").input.genre).toBe("techno");
    expect(parseIntentText("dj stingray type beat").input.mood).toBe("aggressive");
    expect(parseIntentText("helena hauff type beat").input.genre).toBe("techno");
    expect(parseIntentText("aux 88 type beat").input.genre).toBe("techno");
  });

  it("guarded aliases never hijack unrelated prompts", () => {
    // "reese bass" is the DnB technique, not the producer alias
    expect(matchArtistPreset("reese bass")).toBeNull();
    // "plug in" is an English phrase, not the Plug alias
    expect(matchArtistPreset("plug in the cable")).toBeNull();
    // "big beat" promo text is not Fatboy Slim
    expect(matchArtistPreset("this is a big beat")).toBeNull();
  });

  it("every wave style resolves to a real groove id", () => {
    for (const id of [
      "techno.driving",
      "techno.minimal",
      "techno.acid",
      "techno.dub",
      "techno.hard",
      "techno.industrial",
      "techno.melodic",
    ]) {
      expect(getGrooveById(id), id).toBeDefined();
    }
  });
});

describe("house depth wave (Chicago / Detroit / garage / French / disco)", () => {
  it("Chicago founders: knuckles / heard / jefferson / hardy / trax era", () => {
    const knuckles = parseIntentText("frankie knuckles type beat");
    expect(knuckles.input.genre).toBe("house");
    expect(knuckles.input.style).toBe("soulful");
    expect(knuckles.input.bpmRange).toEqual([118, 126]);
    expect(parseIntentText("larry heard type beat").input.style).toBe("deep");
    expect(parseIntentText("mr fingers type beat").input.mood).toBe("chill");
    expect(parseIntentText("marshall jefferson type beat").input.genre).toBe("house");
    expect(parseIntentText("ron hardy type beat").input.style).toBe("funky");
    expect(parseIntentText("steve hurley type beat").input.genre).toBe("house");
    expect(parseIntentText("chip e type beat").input.genre).toBe("house");
  });

  it("Detroit house + NJ/NY garage axis", () => {
    expect(parseIntentText("blake baxter type beat").input.style).toBe("deep");
    expect(parseIntentText("eddie fowlkes type beat").input.genre).toBe("house");
    expect(parseIntentText("kerri chandler type beat").input.style).toBe("deep");
    expect(parseIntentText("masters at work type beat").input.style).toBe("soulful");
    expect(parseIntentText("little louie vega type beat").input.genre).toBe("house");
    expect(parseIntentText("todd terry type beat").input.style).toBe("funky");
    expect(parseIntentText("larry levan type beat").input.style).toBe("soulful");
    expect(parseIntentText("paradise garage type beat").input.genre).toBe("house");
  });

  it("French filter house + disco origin", () => {
    expect(parseIntentText("cassius type beat").input.style).toBe("disco");
    expect(parseIntentText("stardust type beat").input.mood).toBe("energetic");
    expect(parseIntentText("alan braxe type beat").input.genre).toBe("house");
    expect(parseIntentText("bob sinclar type beat").input.style).toBe("disco");
    expect(parseIntentText("giorgio moroder type beat").input.genre).toBe("house");
    expect(parseIntentText("nile rodgers type beat").input.style).toBe("disco");
    expect(parseIntentText("arthur russell type beat").input.mood).toBe("energetic");
  });

  it("modern deep/melodic school + amapiano second line", () => {
    expect(parseIntentText("nora en pure type beat").input.style).toBe("deep");
    expect(parseIntentText("lane 8 type beat").input.mood).toBe("chill");
    expect(parseIntentText("harrison bdp type beat").input.genre).toBe("house");
    expect(parseIntentText("jody wisternoff type beat").input.style).toBe("minimal");
    expect(parseIntentText("musa keys type beat").input.style).toBe("afro");
    expect(parseIntentText("young stunna type beat").input.genre).toBe("house");
  });

  it("guarded aliases never hijack generic words", () => {
    // "justice" alone is a common word — only the qualified form matches
    expect(matchArtistPreset("justice for the people")).toBeNull();
    // "chic" alone is generic — the qualified form matches
    expect(matchArtistPreset("chic type beat")).not.toBeNull();
    // "marsh" alone is a habitat, not the producer
    expect(matchArtistPreset("marsh land ambience")).toBeNull();
  });

  it("house history phrases route correctly", () => {
    expect(parseIntentText("chicago house").input.genre).toBe("house");
    expect(parseIntentText("garage house").input.genre).toBe("house");
    expect(parseIntentText("filter house").input.genre).toBe("house");
    expect(parseIntentText("soulful house").input.genre).toBe("house");
    // Chicago RAP/drill stays out of the house route
    expect(parseIntentText("chicago drill").input.genre).toBe("drill");
  });

  it("every house wave style resolves to a real groove id", () => {
    for (const id of ["house.soulful", "house.deep", "house.funky", "house.disco", "house.driving", "house.minimal"]) {
      expect(getGrooveById(id), id).toBeDefined();
    }
  });
});

describe("experimental + score wave", () => {
  it("experimental hip-hop edges: brockhampton / clipping / flying lotus", () => {
    expect(parseIntentText("brockhampton type beat").input.style).toBe("hyper");
    expect(parseIntentText("kevin abstract type beat").input.genre).toBe("trap");
    // clipping. keeps its earlier phonk/horror entry (industrial rap textures)
    expect(parseIntentText("clipping type beat").input.mood).toBe("dark");
    expect(parseIntentText("flying lotus type beat").input.style).toBe("glitch");
    expect(parseIntentText("clouddead type beat").input.mood).toBe("dark");
  });

  it("neoclassical / modern score depth", () => {
    const einaudi = parseIntentText("ludovico einaudi type beat");
    expect(einaudi.input.genre).toBe("ambient");
    expect(einaudi.input.style).toBe("organic");
    expect(einaudi.input.mood).toBe("chill");
    expect(parseIntentText("max richter type beat").input.mood).toBe("dark");
    expect(parseIntentText("vangelis type beat").input.mood).toBe("energetic");
    expect(parseIntentText("steve roach type beat").input.style).toBe("drifting");
    expect(parseIntentText("ryuichi sakamoto type beat").input.mood).toBe("chill");
    expect(parseIntentText("biosphere type beat").input.style).toBe("drifting");
  });

  it("big beat + 90s rave lineage resolve", () => {
    expect(parseIntentText("fatboy slim type beat").input.style).toBe("broken");
    expect(parseIntentText("chemical brothers type beat").input.genre).toBe("house");
    expect(parseIntentText("prodigy type beat").input.genre).toBe("techno");
    expect(parseIntentText("orbital type beat").input.mood).toBe("aggressive");
  });

  it("2-step originators land on house/ukg", () => {
    expect(parseIntentText("mj cole type beat").input.style).toBe("ukg");
    expect(parseIntentText("artful dodger type beat").input.mood).toBe("chill");
    expect(parseIntentText("zed bias type beat").input.mood).toBe("dark");
    expect(parseIntentText("wookie type beat").input.genre).toBe("house");
  });
});

describe("jersey/baltimore/UKG producers + hyperpop-sigilkore underworld (crate-digger wave)", () => {
  it("jersey second wave: lilman / drizz / dellirious / problem / delish / tim dolla", () => {
    const lilman = parseIntentText("dj lilman type beat");
    expect(lilman.input.genre).toBe("jersey");
    expect(lilman.input.style).toBe("club");
    expect(lilman.input.bpmRange).toEqual([134, 142]);
    expect(parseIntentText("kayy drizz type beat").input.style).toBe("bounce");
    expect(parseIntentText("so dellirious type beat").input.style).toBe("bounce");
    expect(parseIntentText("dj problem type beat").input.style).toBe("flip");
    expect(parseIntentText("dj delish type beat").input.style).toBe("flip");
    expect(parseIntentText("dj tim dolla type beat").input.bpmRange).toEqual([128, 136]);
  });

  it("baltimore club lineage: the parent genre at the slower pocket", () => {
    const bmore = parseIntentText("baltimore club beat");
    expect(bmore.input.genre).toBe("jersey");
    expect(bmore.input.bpmRange).toEqual([125, 135]);
    expect(parseIntentText("dj k-swift type beat").input.genre).toBe("jersey");
    expect(parseIntentText("scottie b type beat").input.genre).toBe("jersey");
    expect(parseIntentText("kw griff type beat").input.style).toBe("bounce");
    expect(parseIntentText("rod lee type beat").input.style).toBe("bounce");
    expect(parseIntentText("blaqstarr type beat").input.mood).toBe("aggressive");
  });

  it("UKG producers: salute / barry can't swim / bassline niche school", () => {
    const salute = parseIntentText("salute type beat");
    expect(salute.input.genre).toBe("house");
    expect(salute.input.style).toBe("ukg");
    expect(salute.input.bpmRange).toEqual([132, 140]);
    expect(parseIntentText("barry can't swim type beat").input.mood).toBe("chill");
    const niche = parseIntentText("dj q type beat");
    expect(niche.input.style).toBe("ukg");
    expect(niche.input.mood).toBe("energetic");
    expect(parseIntentText("t2 type beat").input.style).toBe("ukg");
    expect(parseIntentText("burgaboy type beat").input.style).toBe("ukg");
    expect(parseIntentText("trc type beat").input.style).toBe("ukg");
  });

  it("pc music room + deconstructed club: umru / felicita / shygirl / jockstrap", () => {
    const umru = parseIntentText("umru type beat");
    expect(umru.input.genre).toBe("trap");
    expect(umru.input.style).toBe("hyper");
    expect(umru.input.bpmRange).toEqual([150, 170]);
    expect(parseIntentText("felicita type beat").input.style).toBe("hyper");
    expect(parseIntentText("easyfun type beat").input.style).toBe("hyper");
    expect(parseIntentText("shygirl type beat").input.mood).toBe("aggressive");
    expect(parseIntentText("jockstrap type beat").input.style).toBe("hyper");
  });

  it("hardcore revival: machine girl / sewerslvt / goreshit amen", () => {
    const mg = parseIntentText("machine girl type beat");
    expect(mg.input.genre).toBe("dnb");
    expect(mg.input.style).toBe("amen");
    expect(mg.input.mood).toBe("aggressive");
    expect(parseIntentText("alice gas type beat").input.style).toBe("amen");
    expect(parseIntentText("sewerslvt type beat").input.style).toBe("amen");
    expect(parseIntentText("goreshit type beat").input.mood).toBe("dark");
  });

  it("sigilkore + haunted mound: the occult trap underworld", () => {
    const luci = parseIntentText("luci4 type beat");
    expect(luci.input.genre).toBe("trap");
    expect(luci.input.style).toBe("hyper");
    expect(luci.input.mood).toBe("dark");
    expect(luci.input.bpmRange).toEqual([135, 155]);
    expect(parseIntentText("sellasouls type beat").input.style).toBe("hyper");
    expect(parseIntentText("nosgov type beat").input.style).toBe("hyper");
    expect(parseIntentText("sematary type beat").input.mood).toBe("aggressive");
    expect(parseIntentText("ghost mountain type beat").input.style).toBe("hyper");
  });

  it("witch house + dark electronic: salem / crim3s / crystal castles / ic3peak", () => {
    const salem = parseIntentText("salem type beat");
    expect(salem.input.genre).toBe("ambient");
    expect(salem.input.style).toBe("drifting");
    expect(salem.input.mood).toBe("dark");
    expect(parseIntentText("crim3s type beat").input.style).toBe("drifting");
    expect(parseIntentText("white ring type beat").input.style).toBe("drifting");
    const cc = parseIntentText("crystal castles type beat");
    expect(cc.input.genre).toBe("ambient");
    expect(cc.input.style).toBe("glitch");
    expect(parseIntentText("ic3peak type beat").input.style).toBe("glitch");
  });

  it("crate-digger wave styles resolve to real groove ids", () => {
    for (const id of [
      "jersey.club",
      "jersey.bounce",
      "jersey.flip",
      "house.ukg",
      "trap.hyper",
      "dnb.amen",
      "ambient.drifting",
      "ambient.glitch",
    ]) {
      expect(getGrooveById(id), id).toBeDefined();
    }
  });
});
