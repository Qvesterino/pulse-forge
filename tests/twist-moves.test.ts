import { describe, expect, it } from "vitest";
import { testDoc } from "./fixtures/doc";
import { applyEffectIntent, effectKnobDelta, effectReadback, parseEffectIntent } from "../src/intent/mix";

/**
 * TWIST semantic MOVES — "make the 808 throw", "wider hats, mono safe",
 * "smear the attack on the lead". A move is an ABSOLUTE re-voicing of the
 * effect (its own param map, role-landed FOCUS) that implies TWIST only when
 * no other effect is named, and it replaces the knob path entirely.
 */

function bassDoc() {
  const doc = testDoc();
  const instrument = doc.tracks.find((candidate) => candidate.kind === "instrument")!;
  instrument.name = "808 Bass";
  (instrument as { instrument?: string }).instrument = "808";
  return { doc, trackId: instrument.id };
}

function drumDoc() {
  const doc = testDoc();
  const drum = doc.tracks.find((candidate) => candidate.kind === "drum")!;
  return { doc, trackId: drum.id };
}

describe("TWIST semantic moves — parsing", () => {
  it("implies TWIST from the move phrase and carries no knob delta", () => {
    const intent = parseEffectIntent("make the 808 throw");
    expect(intent).not.toBeNull();
    expect(intent!.effectType).toBe("skrutka");
    expect(intent!.move?.id).toBe("throw");
    expect(intent!.targets).toContain("bass");
    expect(effectKnobDelta(intent!)).toBe(0);
  });

  it("parses the wider / mono-safe / smear moves (EN + SK)", () => {
    expect(parseEffectIntent("wider hats")?.move?.id).toBe("wider");
    expect(parseEffectIntent("wider hats")?.targets).toContain("drums");
    expect(parseEffectIntent("wider hats, mono safe")?.move?.id).toBe("mono-safe");
    expect(parseEffectIntent("mono safe on the bass")?.move?.id).toBe("mono-safe");
    expect(parseEffectIntent("smear the attack on the lead")?.move?.id).toBe("attack-smear");
    expect(parseEffectIntent("sirsie hats")?.move?.id).toBe("wider");
    expect(parseEffectIntent("gulp the tail on the 808")?.move?.id).toBe("tail-gulp");
  });

  it("never hijacks an explicitly named effect", () => {
    const reverb = parseEffectIntent("wider reverb on the lead");
    expect(reverb?.effectType).toBe("reverb");
    expect(reverb?.move).toBeUndefined();
  });

  it("declines a move without a resolvable target", () => {
    expect(parseEffectIntent("mono safe")).toBeNull();
    expect(parseEffectIntent("make it wider")).toBeNull();
  });
});

describe("TWIST semantic moves — applying", () => {
  it("lands THROW on the 808 with the bass focus as one command", () => {
    const { doc } = bassDoc();
    const intent = parseEffectIntent("make the 808 throw")!;
    const after = applyEffectIntent(doc, intent).execute(doc);
    const track = after.tracks.find((candidate) => candidate.name === "808 Bass")!;
    const fx = track.effects.find((effect) => effect.type === "skrutka")!;
    expect(fx).toBeDefined();
    expect(fx.params.dispersion).toBeCloseTo(0.6);
    expect(fx.params.punch).toBeCloseTo(0.45);
    expect(fx.params.punchMix).toBeCloseTo(1);
    expect(fx.params.focusHz).toBe(90); // role-landed FOCUS
    expect(fx.params.mix).toBeCloseTo(1);
    const readback = effectReadback(doc, after, intent);
    expect(readback).toContain("focusHz");
    expect(readback).toContain("808 Bass");
    // ONE command: replaying it from the original doc lands the same state
    // (ids are minted per apply, so compare the audible surface).
    const replay = applyEffectIntent(doc, intent).execute(doc);
    const replayTrack = replay.tracks.find((t) => t.name === "808 Bass")!;
    const shape = (effects: { type: string; params: Record<string, number> }[]) =>
      effects.map((effect) => ({ type: effect.type, params: effect.params }));
    expect(shape(replayTrack.effects)).toEqual(shape(track.effects));
  });

  it("lands WIDER on the drum track with the airy focus", () => {
    const { doc } = drumDoc();
    const intent = parseEffectIntent("wider hats")!;
    const after = applyEffectIntent(doc, intent).execute(doc);
    const drum = after.tracks.find((candidate) => candidate.kind === "drum")!;
    const fx = drum.effects.find((effect) => effect.type === "skrutka")!;
    expect(fx.params.field).toBeCloseTo(0.7);
    expect(fx.params.spread).toBeCloseTo(0.5);
    expect(fx.params.mix).toBeCloseTo(0.7);
    expect(fx.params.focusHz).toBe(3200);
  });

  it("mono-safe wins over wider when both appear", () => {
    const { doc } = drumDoc();
    const intent = parseEffectIntent("wider hats, mono safe")!;
    const after = applyEffectIntent(doc, intent).execute(doc);
    const drum = after.tracks.find((candidate) => candidate.kind === "drum")!;
    const fx = drum.effects.find((effect) => effect.type === "skrutka")!;
    expect(fx.params.field).toBeCloseTo(1);
    expect(fx.params.spread).toBeCloseTo(0.6);
  });

  it("is idempotent: a second identical move changes nothing and throws the honest error", () => {
    const { doc } = bassDoc();
    const intent = parseEffectIntent("make the 808 throw")!;
    const applied = applyEffectIntent(doc, intent).execute(doc);
    expect(() => applyEffectIntent(applied, intent)).toThrow(/changed nothing/);
  });
});
