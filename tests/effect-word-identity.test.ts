import { describe, expect, it } from "vitest";
import { EFFECT_META } from "../src/effects/definitions";
import { effectWordIn } from "../src/intent/effect-words";
import { applyEffectIntent, parseEffectIntent } from "../src/intent/mix";
import { createProjectFromTemplate } from "../src/project-model/templates";

/**
 * THE EFFECT WORD TABLE MUST NOT HIJACK A CANONICAL NAME.
 *
 * The word table is a FOURTH vocabulary next to the registry, the knob map
 * and the capability matrix - and it was allowed to disagree with all of
 * them:
 *
 *   - "distortion" resolved to SATURATION, while `distortion` is a real
 *     registered effect the MCP tool inserts. The same sentence produced
 *     two different effects depending on which surface heard it.
 *   - "sv filter" resolved to EQ, because the generic `\bfilter` rule came
 *     before the specific `\bsv filter\b` rule and the lookup took the
 *     FIRST match. The intent layer's own param layer then forced
 *     `svFilter` for cutoff/Q asks, so the intent layer disagreed with
 *     itself.
 *
 * The contract: every canonical name - the registry's own id and name - must
 * resolve to its OWN effect, and the most specific match must win.
 */

function canonicalWords(type: string): string[] {
  const meta = EFFECT_META[type as keyof typeof EFFECT_META];
  const id = type.toLowerCase();
  const split = type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const name = meta.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return [...new Set([id, split, name])];
}

describe("every canonical effect name resolves to its OWN effect", () => {
  for (const type of Object.keys(EFFECT_META)) {
    it(`${type} is not hijacked by another effect's words`, () => {
      for (const word of canonicalWords(type)) {
        expect(effectWordIn(word), `"${word}" must resolve to ${type}`).toBe(type);
      }
    });
  }
});

describe("the most specific match wins", () => {
  it("resolves the state-variable filter to svFilter, not to the generic filter", () => {
    expect(effectWordIn("sv filter")).toBe("svFilter");
    expect(effectWordIn("add sv filter to the bass")).toBe("svFilter");
    expect(effectWordIn("state variable filter")).toBe("svFilter");
  });

  it("resolves the generic filter to the equalizer it always resolved to", () => {
    expect(effectWordIn("filter")).toBe("eq");
    expect(effectWordIn("more filter on the bass")).toBe("eq");
  });
});

describe("the alias words still resolve", () => {
  it("keeps the hand-written synonyms working", () => {
    expect(effectWordIn("reverbu")).toBe("reverb");
    expect(effectWordIn("dozvuk")).toBe("reverb");
    expect(effectWordIn("echo")).toBe("delay");
    expect(effectWordIn("kompresor")).toBe("compressor");
    expect(effectWordIn("koren")).toBe("bassHarmonic");
    expect(effectWordIn("drive")).toBe("saturation");
    expect(effectWordIn("formant")).toBe("rezonans");
  });
});

/**
 * The word table is not an end in itself: the INTENT LAYER must hear the
 * registry too. These are the sentences a producer actually types, and the
 * effect each one must land on. Before R-01 the first two landed on a
 * DIFFERENT effect than their own name says, and the next two landed on none.
 */
describe("the intent layer hears the registry", () => {
  const heard = (text: string): string | null => parseEffectIntent(text)?.effectType ?? null;

  it("routes the registry's own names to their own effect", () => {
    expect(heard("add distortion to the lead")).toBe("distortion");
    expect(heard("add sv filter to the bass")).toBe("svFilter");
    expect(heard("add sidechain to the bass")).toBe("sidechain");
    expect(heard("add grow to the bass")).toBe("bassHarmonic");
    expect(heard("add drift to the vocals")).toBe("ozvena");
    expect(heard("add zenit to the chords")).toBe("zenit");
    expect(heard("add prism to the lead")).toBe("fxeq");
    expect(heard("add vinyl suite to the drums")).toBe("vinyl");
    expect(heard("add beat mangler to the drums")).toBe("beatMangler");
  });

  it("keeps the generic words where they always pointed", () => {
    expect(heard("add reverb to the vocals")).toBe("reverb");
    expect(heard("add delay to the drop")).toBe("delay");
    expect(heard("add filter to the bass")).toBe("eq");
    expect(heard("add eq to the bass")).toBe("eq");
    expect(heard("add saturation to the lead")).toBe("saturation");
    expect(heard("add pump to the bass")).toBe("pump");
  });

  it("keeps the compound phrase producers actually say", () => {
    expect(heard("add sidechain pump to the bass")).toBe("pump");
  });
});

/**
 * The word table only matters if the effect LANDS. Before R-01 "add distortion
 * on the lead" put a saturation on the track — the sentence and the rack
 * disagreed. These apply the intent to a real project and read the rack back.
 */
describe("the ask lands the effect the word names", () => {
  const rackAfter = (text: string): string[] => {
    const doc = createProjectFromTemplate("house");
    const intent = parseEffectIntent(text);
    if (!intent) return [];
    const next = applyEffectIntent(doc, intent).execute(doc);
    return [...new Set(next.tracks.flatMap((track) => track.effects.map((fx) => fx.type)))];
  };

  it("puts the registry's effect on the track, not a lookalike", () => {
    expect(rackAfter("add distortion on the drums")).toContain("distortion");
    expect(rackAfter("add distortion on the drums")).not.toContain("saturation");
  });

  it("still applies the sidechain ask that used to resolve to pump", () => {
    expect(rackAfter("add sidechain on the bass")).toContain("sidechain");
  });

  it("keeps the generic effect where it always landed", () => {
    expect(rackAfter("add reverb on the drums")).toContain("reverb");
  });
});
