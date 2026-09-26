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

describe("bass-house / g-house / future-bass / riddim-dubstep / hardstyle / psytrance (electronic depth)", () => {
  // Each block covers one of the six new electronic-lane presets, asserting
  // genre + style + BPM + mood against the researched values.
  it("chris lake / acraze / sidepiece → bass house at the tech-house tempo", () => {
    const chris = parseIntentText("chris lake type beat");
    expect(chris.input.genre).toBe("house");
    expect(chris.input.style).toBe("driving");
    expect(chris.input.bpmRange).toEqual([124, 130]);
    expect(chris.input.energy).toBe(0.85);
  });

  it("don diablo / tchami / malaa → g-house (deep, chill, French vocal-chop floor)", () => {
    const don = parseIntentText("don diablo type beat");
    expect(don.input.genre).toBe("house");
    expect(don.input.style).toBe("deep");
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
    expect(head.input.style).toBe("hard");
    expect(head.input.bpmRange).toEqual([150, 155]);
    expect(head.input.energy).toBe(0.95);
  });

  it("astrix / vini vici / infected mushroom → psytrance (techno acid, 138-145)", () => {
    const astrix = parseIntentText("astrix type beat");
    expect(astrix.input.genre).toBe("techno");
    expect(astrix.input.style).toBe("acid");
    expect(astrix.input.bpmRange).toEqual([138, 145]);
    expect(astrix.input.energy).toBe(0.9);
  });

  it("the electronic-depth lanes resolve to real groove ids (resolveGroove contract)", () => {
    // Engine integration smoke — each preset's style must resolve to a real
    // `genre.style` grooveId via getGrooveById.
    expect(getGrooveById("house.driving")).toBeDefined();
    expect(getGrooveById("house.deep")).toBeDefined();
    expect(getGrooveById("house.broken")).toBeDefined();
    expect(getGrooveById("trap.dubstep")).toBeDefined();
    expect(getGrooveById("techno.hard")).toBeDefined();
    expect(getGrooveById("techno.acid")).toBeDefined();
  });
});
