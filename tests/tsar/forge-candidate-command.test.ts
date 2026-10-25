import { describe, expect, it } from "vitest";
import { applyForgeCandidateCommand } from "../../src/commands/tsar";
import { forgeCandidates } from "../../src/tsar/forge-candidates";
import { createInstrumentTrackModel } from "../../src/project-model/schema";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { InstrumentTrack } from "../../src/project-model/types";
import { goldenVoices, TSAR_GOLDEN_SAMPLE_RATE, type GoldenVoiceId } from "./golden-voices";

/**
 * WAVE 3 — FORGE CANDIDATE COMMAND.
 *
 * The mutation contract:
 *  - ONE undo step (the producer must be able to take back a reading);
 *  - the candidate lands in ITS OWN slot (the reading decided where it
 *    belongs; the producer chose the reading, not the slot);
 *  - the source is REFERENCED, not copied (the library owns the bytes);
 *  - a reading with no reliable root leaves the producer's own root alone;
 *  - the rest of the patch survives: applying a reading is a change of
 *    reading, not a reset of the instrument.
 */

const SR = TSAR_GOLDEN_SAMPLE_RATE;

function tsarDoc() {
  const base = createProjectFromTemplate("empty");
  const track = createInstrumentTrackModel("tsar", 1);
  track.id = "tsar-track";
  track.name = "TSAR";
  return { ...base, tracks: [track] };
}

function candidatesFor(id: GoldenVoiceId, slot: 0 | 1 = 0) {
  const set = forgeCandidates(goldenVoices.get(id)!, SR, { slot });
  return set.candidates;
}

describe("applyForgeCandidateCommand", () => {
  it("applies a reading to Source A with one undo step", () => {
    const doc = tsarDoc();
    const candidate = candidatesFor("saw-c3")[0]!;
    const command = applyForgeCandidateCommand(doc, "tsar-track", "user.sample.saw", candidate);
    const next = command.execute(doc);
    const track = next.tracks.find((t): t is InstrumentTrack => t.id === "tsar-track")!;
    expect(track.sampleId).toBe("user.sample.saw");
    expect(track.params.srcAEngine).toBe(candidate.params.srcAEngine);
    // One undo restores the whole document.
    expect(command.undo(next)).toEqual(doc);
  });

  it("applies a reading to Source B when the candidate targets B", () => {
    const doc = tsarDoc();
    const candidate = candidatesFor("sine-a1", 1)[0]!;
    expect(candidate.slot).toBe(1);
    const before = doc.tracks[0].params;
    const next = applyForgeCandidateCommand(doc, "tsar-track", "user.sample.b", candidate).execute(doc);
    const track = next.tracks.find((t): t is InstrumentTrack => t.id === "tsar-track")!;
    expect(track.sampleIdB).toBe("user.sample.b");
    expect(track.sampleId).toBeNull(); // A's source untouched
    expect(track.params.srcBEngine).toBeDefined();
    // "A untouched" means EVERY A parameter keeps its value — the TSAR track
    // model ships defaults for both slots (srcAEngine = 1, srcBEngine = 0),
    // so the absence of a key is not the contract; the UNCHANGED value is.
    const srcAKeys = Object.keys(before).filter((key) => key.startsWith("srcA"));
    expect(srcAKeys.length).toBeGreaterThan(0);
    for (const key of srcAKeys) {
      expect(track.params[key]).toEqual(before[key]);
    }
    // And the reading itself never carries a foreign slot's key.
    expect(Object.keys(candidate.params).filter((key) => key.startsWith("srcA"))).toEqual([]);
  });

  it("a Source A reading leaves Source B alone", () => {
    const doc = tsarDoc();
    const candidate = candidatesFor("saw-c3", 0)[0]!;
    const before = doc.tracks[0].params;
    const next = applyForgeCandidateCommand(doc, "tsar-track", "user.sample.a", candidate).execute(doc);
    const track = next.tracks.find((t): t is InstrumentTrack => t.id === "tsar-track")!;
    expect(track.sampleId).toBe("user.sample.a");
    expect(track.sampleIdB ?? null).toBeNull();
    const srcBKeys = Object.keys(before).filter((key) => key.startsWith("srcB"));
    expect(srcBKeys.length).toBeGreaterThan(0);
    for (const key of srcBKeys) {
      expect(track.params[key]).toEqual(before[key]);
    }
    expect(Object.keys(candidate.params).filter((key) => key.startsWith("srcB"))).toEqual([]);
  });

  it("the texture reading lands the grain cloud, not just the engine switch", () => {
    const doc = tsarDoc();
    const granular = candidatesFor("sustained-pad").find((c) => c.engine === "granular")!;
    const next = applyForgeCandidateCommand(doc, "tsar-track", "user.pad", granular).execute(doc);
    const track = next.tracks.find((t): t is InstrumentTrack => t.id === "tsar-track")!;
    expect(track.params.srcAEngine).toBe(2);
    expect(track.params.srcAGrainSize).toBeGreaterThan(0);
    expect(track.params.srcAGrainDensity).toBeGreaterThan(0);
  });

  it("leaves the producer's own root alone when the reading has none", () => {
    const doc = tsarDoc();
    const seeded = {
      ...doc,
      tracks: doc.tracks.map((t) => (t.id === "tsar-track" ? { ...t, params: { ...t.params, srcARoot: 55 } } : t)),
    };
    const candidate = candidatesFor("noise-burst")[0]!;
    expect(candidate.rootMidi).toBeNull();
    const next = applyForgeCandidateCommand(seeded, "tsar-track", "user.noise", candidate).execute(seeded);
    const track = next.tracks.find((t): t is InstrumentTrack => t.id === "tsar-track")!;
    expect(track.params.srcARoot).toBe(55);
  });

  it("keeps the rest of the patch: applying a reading is not a reset", () => {
    const doc = tsarDoc();
    const seeded = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.id === "tsar-track" ? { ...t, params: { ...t.params, srcAMorph: 0.42, subLevel: 0.7, lfoRate: 3 } } : t,
      ),
    };
    const candidate = candidatesFor("saw-c3")[0]!;
    const next = applyForgeCandidateCommand(seeded, "tsar-track", "user.saw", candidate).execute(seeded);
    const track = next.tracks.find((t): t is InstrumentTrack => t.id === "tsar-track")!;
    expect(track.params.srcAMorph).toBe(0.42);
    expect(track.params.subLevel).toBe(0.7);
    expect(track.params.lfoRate).toBe(3);
  });

  it("clears the preset id — a forged reading is no longer the preset it came from", () => {
    const doc = tsarDoc();
    const seeded = {
      ...doc,
      tracks: doc.tracks.map((t) => (t.id === "tsar-track" ? { ...t, presetId: "tsar-factory-1" } : t)),
    };
    const candidate = candidatesFor("saw-c3")[0]!;
    const next = applyForgeCandidateCommand(seeded, "tsar-track", "user.saw", candidate).execute(seeded);
    const track = next.tracks.find((t): t is InstrumentTrack => t.id === "tsar-track")!;
    expect(track.presetId).toBeNull();
  });

  it("refuses a non-TSAR track, a missing track and a missing sample id", () => {
    const doc = tsarDoc();
    const candidate = candidatesFor("saw-c3")[0]!;
    const other = { ...doc, tracks: [createInstrumentTrackModel("analog", 1)] };
    expect(() => applyForgeCandidateCommand(other, other.tracks[0]!.id, "user.x", candidate)).toThrow(/TSAR track/);
    expect(() => applyForgeCandidateCommand(doc, "nope", "user.x", candidate)).toThrow(/not found/);
    expect(() => applyForgeCandidateCommand(doc, "tsar-track", "", candidate)).toThrow(/needs a sample/);
  });
});
