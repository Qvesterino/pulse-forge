import { describe, it, expect } from "vitest";
import { parseIntentText, parseKeyPhrase } from "../src/intent/text-parser";
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

  it("maps adjacent genres to the canonical four", () => {
    expect(parseIntentText("phonk beat").input.genre).toBe("trap");
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
