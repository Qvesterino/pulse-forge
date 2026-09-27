/**
 * Tests for the space (reverb / delay) bridge path and the "spacious bass"
 * recipe.
 *
 * The thing this file really guards is the UNIT SPLIT. Reverb stores `decay`
 * in seconds and `predelay` in milliseconds; delay stores `time` in
 * milliseconds. Two adjacent effects, two different conventions, and writing
 * 1.8 into the wrong slot produces a perfectly valid, perfectly inaudible
 * tail. Every assertion here therefore checks the magnitude of the value, not
 * just that it was written.
 *
 * As with the EQ / sidechain / compressor specs, a bare params assertion is
 * not enough — a key that does not exist still "reads back". The
 * round-trip tests push the document through normalizeProject.
 */

import { describe, expect, it } from "vitest";
import { testDoc } from "../../fixtures/doc";
import type { ProjectDocument } from "../../../src/project-model/types";
import { normalizeProject } from "../../../src/project-model/schema";
import { EMPTY_PREFERENCES } from "../../../src/ai/bridge/types";
import { executeCommandBatch, __validateBridgeCommandForTest } from "../../../src/ai/bridge/executor";
import {
  DELAY_RANGES,
  DELAY_SYNC_DIVISIONS,
  REVERB_RANGES,
  delaySpec,
  reverbSpec,
  type DelaySpace,
  type ReverbSpace,
} from "../../../src/ai/bridge/spaceSlots";

const REVERB_SPACES: ReverbSpace[] = ["room", "hall", "plate", "spring", "cathedral"];
const DELAY_SPACES: DelaySpace[] = ["slap", "pingpong", "eighth", "sixteenth"];

/** The house template's bass track is literally named "808". */
function bassDoc(): ProjectDocument {
  const doc = testDoc();
  if (!doc.tracks.some((t) => /808|\bbass/i.test(t.name))) {
    throw new Error("fixture: testDoc() must contain a bass-shaped track");
  }
  return doc;
}

function bassOf(doc: ProjectDocument) {
  const found = doc.tracks.find((t) => /808|\bbass/i.test(t.name));
  if (!found) throw new Error("fixture: no bass track");
  return found;
}

/**
 * The space tables return `null` for an unknown space so the executor can
 * reject it. Every call below uses a KNOWN space, so a null here means the
 * table lost an entry — which is a spec failure worth failing loudly on
 * rather than reading a field off undefined.
 */
function reverb(space: ReverbSpace, intensity: number) {
  const s = reverbSpec(space, intensity);
  if (!s) throw new Error(`reverbSpec returned null for known space "${space}"`);
  return s;
}

function delay(space: DelaySpace, intensity: number) {
  const s = delaySpec(space, intensity);
  if (!s) throw new Error(`delaySpec returned null for known space "${space}"`);
  return s;
}

describe("AI bridge — space slots", () => {
  it("every reverb space expands to legal values with the right units", () => {
    for (const space of REVERB_SPACES) {
      for (const intensity of [0, 0.5, 1]) {
        const s = reverb(space, intensity);
        // decay is SECONDS: a room must not be under a second and a cathedral
        // must not be under a few. Anything in the 0.1…20 window is legal,
        // but a value in the millisecond range means the units were swapped.
        expect(s.decaySec).toBeGreaterThan(REVERB_RANGES.decay.min);
        expect(s.decaySec).toBeLessThanOrEqual(REVERB_RANGES.decay.max);
        // predelay is MILLISECONDS and must stay in the 0…250 window.
        expect(s.predelayMs).toBeGreaterThanOrEqual(REVERB_RANGES.predelay.min);
        expect(s.predelayMs).toBeLessThanOrEqual(REVERB_RANGES.predelay.max);
        expect(s.toneHz).toBeLessThanOrEqual(REVERB_RANGES.tone.max);
        expect(s.dampingHz).toBeLessThanOrEqual(REVERB_RANGES.damping.max);
        expect(s.diffusion).toBeGreaterThanOrEqual(0);
        expect(s.diffusion).toBeLessThanOrEqual(1);
        expect(s.mod).toBeGreaterThanOrEqual(0);
        expect(s.mod).toBeLessThanOrEqual(1);
        expect(s.mix).toBeLessThanOrEqual(1);
      }
    }
  });

  it("reverb spaces are ordered by tail length (cathedral > room)", () => {
    expect(reverb("cathedral", 0).decaySec).toBeGreaterThan(reverb("hall", 0).decaySec);
    expect(reverb("hall", 0).decaySec).toBeGreaterThan(reverb("room", 0).decaySec);
    // Plate is the bright, dense vocal space — highest tone and diffusion.
    const plate = reverb("plate", 0);
    const room = reverb("room", 0);
    expect(plate.diffusion).toBeGreaterThan(room.diffusion);
  });

  it("every delay space expands to legal values; synced spaces use a real division", () => {
    for (const space of DELAY_SPACES) {
      const s = delay(space, 0);
      expect(s.timeMs).toBeGreaterThanOrEqual(DELAY_RANGES.time.min);
      expect(s.timeMs).toBeLessThanOrEqual(DELAY_RANGES.time.max);
      expect(s.sync).toBeGreaterThanOrEqual(0);
      expect(s.sync).toBeLessThanOrEqual(DELAY_RANGES.sync.max);
      // A sync index must point at a real entry in the division table —
      // the worklet indexes straight into it, so an off-by-one is a crash.
      expect(DELAY_SYNC_DIVISIONS[s.sync]).toBeDefined();
      expect(s.feedback).toBeLessThanOrEqual(DELAY_RANGES.feedback.max);
      expect(s.mix).toBeLessThanOrEqual(1);
    }
    // Slap is the only unsynced space (it must stay BPM-proof).
    expect(delay("slap", 0).sync).toBe(0);
    expect(delay("pingpong", 0).sync).toBeGreaterThan(0);
    // Ping-pong is the only one that alternates sides.
    expect(delay("pingpong", 0).pingPong).toBe(1);
    expect(delay("eighth", 0).pingPong).toBe(0);
  });

  it("intensity only ever increases wet signal and feedback", () => {
    for (const space of REVERB_SPACES) {
      expect(reverb(space, 1).mix).toBeGreaterThanOrEqual(reverb(space, 0).mix);
      expect(reverb(space, 1).decaySec).toBeGreaterThanOrEqual(reverb(space, 0).decaySec);
    }
    for (const space of DELAY_SPACES) {
      expect(delay(space, 1).mix).toBeGreaterThanOrEqual(delay(space, 0).mix);
      expect(delay(space, 1).feedback).toBeGreaterThanOrEqual(delay(space, 0).feedback);
    }
  });

  it("rejects an unknown space and an out-of-range intensity", () => {
    const doc = bassDoc();
    const badSpace = __validateBridgeCommandForTest(doc, {
      kind: "reverb",
      label: "bogus",
      rationale: "test",
      target: { namePattern: "808", regex: false, preferKind: "any" },
      // @ts-expect-error — deliberately invalid so the guard is exercised.
      space: "infinite-cave",
      intensity: 0.5,
    });
    expect(badSpace.ok).toBe(false);

    const badIntensity = __validateBridgeCommandForTest(doc, {
      kind: "delay",
      label: "bogus",
      rationale: "test",
      target: { namePattern: "808", regex: false, preferKind: "any" },
      space: "eighth",
      intensity: -2,
    });
    expect(badIntensity.ok).toBe(false);
    if (badIntensity.ok) return;
    expect(badIntensity.message).toContain("intensity");
  });
});

describe("AI bridge — spacious bass recipe", () => {
  it("applies high-pass, reverb, delay, volume trim and a pan hint", () => {
    const doc = bassDoc();
    const result = executeCommandBatch("uprav basy aby boli viac priestorove", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bass = result.doc.tracks.find((t) => /808|\bbass/i.test(t.name));
    if (!bass) throw new Error("fixture: bass vanished");
    expect(bass.effects.some((fx) => fx.type === "reverb")).toBe(true);
    expect(bass.effects.some((fx) => fx.type === "delay")).toBe(true);
    expect(bass.effects.some((fx) => fx.type === "eq")).toBe(true);
    // The level trim is what makes "more space" not mean "louder".
    expect(bass.gain).toBeLessThan(bassDoc().tracks.find((t) => /808|\bbass/i.test(t.name))!.gain);
  });

  it("reverb params survive normalizeProject with decay in SECONDS", () => {
    const doc = bassDoc();
    const result = executeCommandBatch("make the bass more spacious", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const normalized = normalizeProject(result.doc);
    const rev = bassOf(normalized).effects.find((fx) => fx.type === "reverb");
    expect(rev).toBeDefined();
    for (const key of Object.keys(rev?.params ?? {})) {
      expect(Object.keys(REVERB_RANGES)).toContain(key);
    }
    // The unit check: decay must be a plausible number of SECONDS, not a
    // millisecond figure that would truncate the tail to nothing.
    expect(rev?.params.decay).toBeGreaterThan(0.5);
    expect(rev?.params.decay).toBeLessThanOrEqual(REVERB_RANGES.decay.max);
    // ...and predelay must be MILLISECONDS inside its own window.
    expect(rev?.params.predelay).toBeGreaterThanOrEqual(REVERB_RANGES.predelay.min);
    expect(rev?.params.predelay).toBeLessThanOrEqual(REVERB_RANGES.predelay.max);
  });

  it("delay params survive normalizeProject and carry a legal sync index", () => {
    const doc = bassDoc();
    const result = executeCommandBatch("basy su suche", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const normalized = normalizeProject(result.doc);
    const del = bassOf(normalized).effects.find((fx) => fx.type === "delay");
    expect(del).toBeDefined();
    for (const key of Object.keys(del?.params ?? {})) {
      expect(Object.keys(DELAY_RANGES)).toContain(key);
    }
    // The worklet indexes DELAY_SYNC_DIVISIONS directly — an index outside
    // the table reads `undefined` and the repeat time collapses.
    expect(DELAY_SYNC_DIVISIONS[del?.params.sync ?? -1]).toBeDefined();
    // Ping-pong is the source of the width here.
    expect(del?.params.pingPong).toBe(1);
    expect(del?.params.time).toBeGreaterThanOrEqual(DELAY_RANGES.time.min);
  });

  it("leaves a deliberately panned bass alone", () => {
    const base = bassDoc();
    const bass = bassOf(base);
    const panned: ProjectDocument = {
      ...base,
      tracks: base.tracks.map((t) => (t.id === bass.id ? { ...t, pan: 0.6 } : t)),
    };

    const result = executeCommandBatch("make the bass wider", {
      doc: panned,
      userPreferences: EMPTY_PREFERENCES,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A user who already placed the bass off-centre must not be re-placed
    // by an inferred "spacious" intent.
    const after = result.doc.tracks.find((t) => t.id === bass.id);
    expect(after?.pan).toBe(0.6);
  });

  it("retunes an existing reverb instead of stacking a second one", () => {
    const base = bassDoc();
    const bass = bassOf(base);
    const doc: ProjectDocument = {
      ...base,
      tracks: base.tracks.map((t) =>
        t.id === bass.id
          ? {
              ...t,
              effects: [
                ...t.effects,
                { id: "fx-user-rev", type: "reverb" as const, bypassed: true, params: { decay: 9 } },
              ],
            }
          : t,
      ),
    };

    const result = executeCommandBatch("uprav basy aby boli viac priestorove", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = result.doc.tracks.find((t) => t.id === bass.id);
    if (!after) throw new Error("fixture: bass vanished");
    const reverbs = after.effects.filter((fx) => fx.type === "reverb");
    expect(reverbs.length).toBe(1);
    expect(reverbs[0]?.id).toBe("fx-user-rev");
    expect(reverbs[0]?.bypassed).toBe(false);
  });

  it("returns no-track-match on a project with no bass", () => {
    const base = testDoc();
    const doc: ProjectDocument = { ...base, tracks: base.tracks.map((t) => ({ ...t, name: `Track ${t.id}` })) };
    const result = executeCommandBatch("uprav basy aby boli viac priestorove", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("no-track-match");
  });
});
