import { describe, expect, it } from "vitest";
import { forgeLowEndStackCommand } from "../../src/commands/instrument";
import { lowEndPlan } from "../../src/instruments/lowEnd";
import { parseKey } from "../../src/project-model/scales";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { InstrumentTrack, ProjectDocument } from "../../src/project-model/types";

/**
 * The LOW-END STACK (the KOPA-family follow-up): one command binds KOPA
 * (kick) + an 808 bass carrying the KOREŇ harmonic engine + a sidechain
 * keyed to the kick, all tuned to the song's tonic. The pure plan and the
 * command's apply/undo/idempotence are pinned here.
 */

function docWithKey(key: string | undefined): ProjectDocument {
  const doc = createProjectFromTemplate("house");
  if (key !== undefined) doc.key = key;
  // Strip the template's existing kopa/808 tracks so each test starts clean.
  doc.tracks = doc.tracks.filter((t) => !(t.kind === "instrument" && (t.instrument === "kopa" || t.instrument === "808")));
  return doc;
}

describe("lowEndPlan", () => {
  it("computes the tonic offset: A major → kick tuned −3 st, no tracks → create both", () => {
    const doc = docWithKey("A Natural Minor");
    const plan = lowEndPlan(doc);
    expect(plan.keyRootPc).toBe(9);
    expect(plan.kickTuneSt).toBe(-3); // A, one octave below the C anchor
    expect(plan.kickTrackId).toBeNull();
    expect(plan.bassTrackId).toBeNull();
    expect(plan.sidechainWired).toBe(false);
    expect(plan.keyKnown).toBe(true);
  });

  it("a project without a key degrades to chromatic and says so", () => {
    const doc = docWithKey(undefined);
    const plan = lowEndPlan(doc);
    expect(plan.keyRootPc).toBe(0);
    expect(plan.keyKnown).toBe(false);
  });

  it("detects existing tracks and existing sidechain wiring", () => {
    const doc = docWithKey("C Major");
    // The template's stripped state has neither → create both, wire, then
    // re-plan: the second plan must see everything wired.
    const command = forgeLowEndStackCommand(doc, { keyRootPc: 0 });
    const next = command.execute(doc);
    const plan = lowEndPlan(next);
    expect(plan.sidechainWired).toBe(true);
    expect(plan.kickTrackId).not.toBeNull();
    expect(plan.bassTrackId).not.toBeNull();
  });
});

describe("forgeLowEndStackCommand", () => {
  function buildStack(key = "C Major"): ProjectDocument {
    const doc = docWithKey(key);
    // The caller resolves the tonic from the doc's key (lowEndPlan) and
    // hands it to the command — mirror that contract here.
    const root = parseKey(key)?.root ?? 0;
    return forgeLowEndStackCommand(doc, { keyRootPc: root }).execute(doc);
  }

  it("creates the KOPA kick, the 808 bass, the KOREŇ engine and the sidechain in one apply", () => {
    const doc = buildStack("C Major");
    const kick = doc.tracks.find((t): t is InstrumentTrack => t.instrument === "kopa");
    const bass = doc.tracks.find((t): t is InstrumentTrack => t.instrument === "808");
    expect(kick).toBeTruthy();
    expect(bass).toBeTruthy();
    // The kick is tuned to the tonic (C → −12 st from the default anchor).
    expect(kick!.params.bodyTune).toBe(-12);
    expect(kick!.params.subTune).toBe(-12);
    // The bass carries the KOREŇ engine AND the sidechain keyed to the kick.
    const koren = bass!.effects?.find((fx) => fx.type === "bassHarmonic");
    const sidechain = bass!.effects?.find((fx) => fx.type === "sidechain");
    expect(koren).toBeTruthy();
    expect(sidechain?.sidechainTrackId).toBe(kick!.id);
  });

  it("re-tunes to the tonic for a non-C key (A → −3 st)", () => {
    const doc = buildStack("A Natural Minor");
    const kick = doc.tracks.find((t): t is InstrumentTrack => t.instrument === "kopa");
    expect(kick!.params.bodyTune).toBe(-3);
    expect(kick!.params.subTune).toBe(-3);
  });

  it("undo restores the pre-stack document wholesale", () => {
    const doc = docWithKey("C Major");
    const before = doc.tracks.length;
    const command = forgeLowEndStackCommand(doc, { keyRootPc: 0 });
    const next = command.execute(doc);
    const rolled = command.undo(next);
    expect(rolled.tracks.length).toBe(before);
    expect(rolled.tracks.some((t): t is InstrumentTrack => t.instrument === "kopa")).toBe(false);
  });

  it("is idempotent: applying the stack twice does not duplicate the effects", () => {
    let doc = docWithKey("C Major");
    doc = forgeLowEndStackCommand(doc, { keyRootPc: 0 }).execute(doc);
    doc = forgeLowEndStackCommand(doc, { keyRootPc: 0 }).execute(doc);
    const bass = doc.tracks.find((t): t is InstrumentTrack => t.instrument === "808");
    const sidechains = (bass!.effects ?? []).filter((fx) => fx.type === "sidechain");
    const korens = (bass!.effects ?? []).filter((fx) => fx.type === "bassHarmonic");
    expect(sidechains.length).toBe(1);
    expect(korens.length).toBe(1);
  });
});
