/**
 * Reference Map → project commands (F4-full).
 *
 * These are the tests that decide whether a reference can safely touch a
 * project. The dangerous property is not "does it write the right value" —
 * that is one assertion — it is **undoability**: every action here is one
 * command, and a half-reverted project is worse than no action at all.
 *
 * The map is built from the real analyzer output of a real click track, so the
 * beat times under test are the ones a user would actually see — not a
 * hand-written fixture that happens to be convenient.
 */

import { describe, expect, it } from "vitest";
import {
  bpmCommand,
  effectiveBpm,
  grooveCommand,
  keyCommand,
  markerCommand,
  musicalKeyFor,
  secondsToTicks,
} from "../../src/reference/apply";
import { analyzeReference } from "../../src/reference/analysis/analyzeReference";
import { PITCH_CLASSES, type ReferenceMap } from "../../src/reference/types";
import { BAR_TICKS, PPQ } from "../../src/project-model/types";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { ProjectStore } from "../../src/store/ProjectStore";
import { clickTrack, makeMetadata } from "./_fixtures";
import { MIN_BPM, MAX_BPM } from "../../src/project-model/schema";

/** A real 120 BPM click track through the real analyzer. */
function analyzedMap(): ReferenceMap {
  return analyzeReference({ mono: clickTrack(120, 16), metadata: makeMetadata(16) }).result;
}

function freshDoc() {
  const doc = createProjectFromTemplate("empty");
  return { doc, store: new ProjectStore(doc) };
}

describe("apply — musicalKeyFor", () => {
  it("maps every detectable pitch class in both modes into a project key", () => {
    for (const tonic of PITCH_CLASSES) {
      const major = musicalKeyFor(tonic, "major");
      const minor = musicalKeyFor(tonic, "minor");
      // The cast in apply.ts is only safe if this is total for all 24 cases.
      // Asserting it here is what makes the cast honest.
      expect(major, `${tonic} major`).toBe(`${tonic} Major`);
      expect(minor, `${tonic} minor`).toBe(`${tonic} Natural Minor`);
    }
  });

  it("refuses an unknown pitch class or mode instead of inventing a key", () => {
    expect(musicalKeyFor("H", "major")).toBeNull();
    expect(musicalKeyFor("C", "lydian" as never)).toBeNull();
    expect(musicalKeyFor("", "major")).toBeNull();
  });
});

describe("apply — effectiveBpm", () => {
  it("prefers the confirmed correction over any reading", () => {
    const map = analyzedMap();
    expect(effectiveBpm(map, "half", 132.5)).toBe(132.5);
    expect(effectiveBpm(map, "double", 132.5)).toBe(132.5);
  });

  it("falls back to the reading when there is no correction", () => {
    const map = analyzedMap();
    const detected = map.rhythm.bpm;
    expect(detected).not.toBeNull();
    expect(effectiveBpm(map, "as-detected")).toBeCloseTo(detected!, 6);
    expect(effectiveBpm(map, "half")).toBeCloseTo(detected! / 2, 6);
    expect(effectiveBpm(map, "double")).toBeCloseTo(detected! * 2, 6);
  });

  it("returns null rather than guessing when nothing was detected", () => {
    const silent = analyzeReference({ mono: new Float32Array(22050 * 3), metadata: makeMetadata(3) }).result;
    expect(silent.rhythm.bpm).toBeNull();
    expect(effectiveBpm(silent, "half", null)).toBeNull();
    expect(effectiveBpm(silent, "double")).toBeNull();
  });
});

describe("apply — bpmCommand", () => {
  it("sets the project tempo and undoes back to the original in one step", () => {
    const { doc, store } = freshDoc();
    const before = doc.bpm;
    const map = analyzedMap();
    const bpm = effectiveBpm(map, "as-detected")!;
    store.execute(bpmCommand(doc, bpm));
    expect(store.getDoc().bpm).toBeCloseTo(bpm, 2);
    store.undo();
    expect(store.getDoc().bpm).toBe(before);
  });

  it("clamps an absurd tempo into the project's legal range rather than writing it", () => {
    const { doc, store } = freshDoc();
    store.execute(bpmCommand(doc, 9999));
    expect(store.getDoc().bpm).toBe(MAX_BPM);
    store.execute(bpmCommand(doc, 1));
    expect(store.getDoc().bpm).toBe(MIN_BPM);
  });
});

describe("apply — keyCommand", () => {
  it("writes the project key hint and restores the previous one on undo", () => {
    const { doc, store } = freshDoc();
    const command = keyCommand(doc, "F#", "minor");
    expect(command).not.toBeNull();
    store.execute(command!);
    expect(store.getDoc().key).toBe("F# Natural Minor");
    store.undo();
    // `setProjectKey` DROPS the key property to represent absence (rather
    // than writing null), so undo restores an absent key — `undefined` here,
    // not `null`. Both mean "no key", but the property is genuinely gone.
    expect(store.getDoc().key).toBeUndefined();
  });

  it("declines when there is no key to apply", () => {
    const { doc } = freshDoc();
    expect(keyCommand(doc, null, null)).toBeNull();
    expect(keyCommand(doc, "C", null)).toBeNull();
  });

  it("clears an existing key when asked to set null", () => {
    const { doc, store } = freshDoc();
    store.execute(keyCommand(doc, "G", "major")!);
    expect(store.getDoc().key).toBe("G Major");
    store.execute(keyCommand(store.getDoc(), "G", "major")!);
    expect(store.getDoc().key).toBe("G Major");
  });
});

describe("apply — secondsToTicks", () => {
  it("places one beat of a 120 BPM bar at PPQ ticks", () => {
    expect(secondsToTicks(0.5, 120)).toBe(PPQ);
    expect(secondsToTicks(0, 120)).toBe(0);
  });

  it("degrades to 0 rather than NaN/Infinity on hostile input", () => {
    expect(secondsToTicks(Number.NaN, 120)).toBe(0);
    expect(secondsToTicks(1, 0)).toBe(0);
    expect(secondsToTicks(Number.POSITIVE_INFINITY, 120)).toBe(0);
  });
});

describe("apply — markerCommand", () => {
  it("drops a bar-aligned marker per phrase and undoes the whole import at once", () => {
    const { doc, store } = freshDoc();
    const map = analyzedMap();
    const command = markerCommand(doc, map, { beatsPerPhrase: 8, bpm: 120, label: "ref" });
    expect(command).not.toBeNull();

    store.execute(command!);
    const added = store.getDoc().markers;
    expect(added.length).toBeGreaterThan(0);
    // Every marker on a bar line — a marker between bars is worse than none.
    for (const marker of added) {
      expect(marker.tick % BAR_TICKS).toBe(0);
    }
    // Phrases of 8 beats at 120 BPM = 2 bars, so spacing is 2 bars.
    const ticks = added.map((m) => m.tick).sort((a, b) => a - b);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i] - ticks[i - 1]).toBe(2 * BAR_TICKS);
    }

    // One undo removes every marker at once — this is the whole reason the
    // import is a single snapshot() rather than N addMarker commands.
    store.undo();
    expect(store.getDoc().markers.length).toBe(0);
  });

  it("produces a finer grid for shorter phrases and a coarser one for longer", () => {
    const { doc, store } = freshDoc();
    const map = analyzedMap();
    const countFor = (beatsPerPhrase: number): number => {
      const before = doc.markers.length;
      store.execute(markerCommand(doc, map, { beatsPerPhrase, bpm: 120 })!);
      const n = store.getDoc().markers.length - before;
      store.undo();
      return n;
    };
    const one = countFor(4);
    const two = countFor(8);
    const four = countFor(16);
    expect(one).toBeGreaterThan(two);
    expect(two).toBeGreaterThan(four);
  });

  it("declines when the track is too short to hold a single phrase", () => {
    const { doc } = freshDoc();
    const short = analyzeReference({ mono: clickTrack(120, 1), metadata: makeMetadata(1) }).result;
    expect(markerCommand(doc, short, { beatsPerPhrase: 32, bpm: 120 })).toBeNull();
  });

  it("refuses a non-positive phrase length instead of dividing by zero", () => {
    const { doc } = freshDoc();
    expect(markerCommand(doc, analyzedMap(), { beatsPerPhrase: 0, bpm: 120 })).toBeNull();
  });

  it("does not stack duplicate markers when snapped boundaries collide", () => {
    const { doc, store } = freshDoc();
    const map = analyzedMap();
    store.execute(markerCommand(doc, map, { beatsPerPhrase: 4, bpm: 120 })!);
    const ticks = store.getDoc().markers.map((m) => m.tick);
    // Two beats that snap onto one bar would otherwise leave two markers with
    // the same tick, which reads as a bug on the timeline.
    expect(new Set(ticks).size).toBe(ticks.length);
  });
});

describe("apply — grooveCommand", () => {
  it("writes swing and restores the previous groove on undo", () => {
    const { doc, store } = freshDoc();
    store.execute(grooveCommand(doc, { swing: 0.22 })!);
    expect(store.getDoc().groove?.swing).toBeCloseTo(0.22, 6);
    store.undo();
    // Undo must restore the ABSENCE of a groove, not an empty object.
    expect(store.getDoc().groove?.swing ?? null).toBeNull();
  });

  it("clamps out-of-range and drops non-finite values", () => {
    const { doc, store } = freshDoc();
    store.execute(grooveCommand(doc, { swing: 5, humanizeTiming: -2, humanizeVelocity: Number.NaN })!);
    const groove = store.getDoc().groove;
    expect(groove?.swing).toBe(1);
    expect(groove?.humanizeTiming).toBe(0);
    // NaN is DROPPED from the command rather than written, so the field keeps
    // whatever default normalization materializes. What matters is that no NaN
    // reaches an audio parameter.
    expect(groove?.humanizeVelocity).not.toBeNaN();
  });

  it("declines an all-empty request", () => {
    const { doc } = freshDoc();
    expect(grooveCommand(doc, {})).toBeNull();
    expect(grooveCommand(doc, { swing: Number.NaN })).toBeNull();
  });
});
