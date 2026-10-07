import { describe, expect, it } from "vitest";
import { forgeSampleCommand } from "../../src/commands/tsar";
import { forgePlan } from "../../src/tsar/forge";
import { createInstrumentTrackModel } from "../../src/project-model/schema";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { InstrumentTrack } from "../../src/project-model/types";
import { goldenVoices } from "./golden-voices";

/**
 * T2 — FORGE COMMAND (docs/TSAR-ROADMAP.md). The plan is pure data; this
 * test owns the MUTATION contract: one undo step, honest refusal of an empty
 * plan, slot A/B routing, and the envelope/root actually landing in params.
 */

const SR = 44100;

function tsarDoc() {
  const base = createProjectFromTemplate("empty");
  const track = createInstrumentTrackModel("tsar", 1);
  track.id = "tsar-track";
  track.name = "TSAR";
  return { ...base, tracks: [track] };
}

describe("forgeSampleCommand", () => {
  it("applies a wavetable plan to Source A with one undo step", () => {
    const doc = tsarDoc();
    const plan = forgePlan(goldenVoices.get("saw-c3")!, SR);
    expect(plan.engine).toBe("wavetable");
    const command = forgeSampleCommand(doc, "tsar-track", "user.sample.saw", plan);
    const next = command.execute(doc);
    const track = next.tracks.find((t): t is InstrumentTrack => t.id === "tsar-track")!;
    expect(track.sampleId).toBe("user.sample.saw");
    expect(track.params.srcAEngine).toBe(1);
    expect(track.params.srcARoot).toBe(48);
    expect(track.params.srcAAtk).toBeCloseTo(plan.envelope.attackSec, 4);
    expect(track.params.srcASus).toBeGreaterThan(0.5);
    expect(command.undo(next)).toEqual(doc);
  });

  it("applies a one-shot plan with sustain 0 (the envelope dies with the sample)", () => {
    const doc = tsarDoc();
    const plan = forgePlan(goldenVoices.get("808-f1")!, SR);
    expect(plan.kind).toBe("one-shot");
    const next = forgeSampleCommand(doc, "tsar-track", "user.sample.808", plan).execute(doc);
    const track = next.tracks.find((t): t is InstrumentTrack => t.id === "tsar-track")!;
    expect(track.params.srcAEngine).toBe(0);
    expect(track.params.srcASus).toBe(0);
    expect(track.params.srcADec).toBeGreaterThan(0);
  });

  it("routes to Source B when asked (dual-source)", () => {
    const doc = tsarDoc();
    const plan = forgePlan(goldenVoices.get("sine-a1")!, SR);
    const next = forgeSampleCommand(doc, "tsar-track", "user.sample.b", plan, { slot: 1 }).execute(doc);
    const track = next.tracks.find((t): t is InstrumentTrack => t.id === "tsar-track")!;
    expect(track.sampleIdB).toBe("user.sample.b");
    expect(track.sampleId).toBeNull(); // A untouched
    expect(track.params.srcBEngine).toBe(1);
    expect(track.params.srcBRoot).toBe(33);
  });

  it("refuses an empty plan instead of applying silence", () => {
    const doc = tsarDoc();
    const plan = forgePlan(new Float32Array(SR), SR);
    expect(plan.kind).toBe("empty");
    expect(() => forgeSampleCommand(doc, "tsar-track", "user.sample.silent", plan)).toThrow(/Nothing was forged/);
  });

  it("refuses a non-TSAR track and a missing sample id", () => {
    const doc = tsarDoc();
    const plan = forgePlan(goldenVoices.get("sine-a1")!, SR);
    const other = { ...doc, tracks: [createInstrumentTrackModel("analog", 1)] };
    expect(() => forgeSampleCommand(other, other.tracks[0]!.id, "user.x", plan)).toThrow(/TSAR track/);
    expect(() => forgeSampleCommand(doc, "tsar-track", "", plan)).toThrow(/needs a sample/);
  });

  it("keeps the track's root when the source has no readable pitch (honest)", () => {
    const doc = tsarDoc();
    // Seed a root the user set manually.
    const seeded = {
      ...doc,
      tracks: doc.tracks.map((t) => (t.id === "tsar-track" ? { ...t, params: { ...t.params, srcARoot: 55 } } : t)),
    };
    const plan = forgePlan(goldenVoices.get("noise-burst")!, SR);
    expect(plan.rootMidi).toBeNull();
    const next = forgeSampleCommand(seeded, "tsar-track", "user.noise", plan).execute(seeded);
    const track = next.tracks.find((t): t is InstrumentTrack => t.id === "tsar-track")!;
    expect(track.params.srcARoot).toBe(55);
    expect(track.params.srcAEngine).toBe(0); // honest sampler route
  });
});
