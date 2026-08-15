import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  createDefaultProject,
  createDrumTrackModel,
  migrateProject,
  normalizeProject,
  validateProjectShape,
} from "../src/project-model/schema";
import { getDrumTrack, STEP_TICKS } from "../src/project-model/types";
import { Scheduler } from "../src/scheduler/Scheduler";
import { Transport } from "../src/transport/Transport";
import type { DrumPad, ProjectDocument } from "../src/project-model/types";
import { setStepVelocity } from "../src/project-model/transform";

describe("default project", () => {
  it("has 16 pads with factory assets assigned", () => {
    const doc = createDefaultProject();
    const track = getDrumTrack(doc);
    expect(track.pads).toHaveLength(16);
    for (const pad of track.pads) {
      expect(pad.assetId).toMatch(/^factory\./);
    }
  });

  it("contains a playable starter groove (4-on-the-floor kick)", () => {
    const doc = createDefaultProject();
    const track = getDrumTrack(doc);
    const pattern = doc.patterns[0];
    const kick = track.pads[0];
    for (const step of [0, 4, 8, 12]) {
      expect(pattern.rows[kick.id][step]).toBeGreaterThan(0);
    }
  });

  it("serializes to JSON and back with identical domain data", () => {
    const doc = createDefaultProject();
    const roundTripped = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
    expect(validateProjectShape(roundTripped)).toBe(true);
    expect(roundTripped).toEqual(doc);
  });
});

describe("schema migration", () => {
  it("accepts current version unchanged", () => {
    const doc = createDefaultProject();
    expect(migrateProject(doc)).toBe(doc);
  });

  it("rejects future schema versions", () => {
    const doc = { ...createDefaultProject(), schemaVersion: SCHEMA_VERSION + 1 };
    expect(() => migrateProject(doc as ProjectDocument)).toThrow();
  });

  it("rejects malformed documents", () => {
    expect(validateProjectShape(null)).toBe(false);
    expect(validateProjectShape({ bpm: 120 })).toBe(false);
  });

  it("normalizeProject fills missing pad rows and fixes wrong lengths", () => {
    const doc = createDefaultProject();
    const kick = getDrumTrack(doc).pads[0];
    const broken: ProjectDocument = {
      ...doc,
      patterns: [{ ...doc.patterns[0], rows: { [kick.id]: [0.5, 0.5] } }],
    };
    const fixed = normalizeProject(broken);
    const rows = fixed.patterns[0].rows;
    for (const pad of getDrumTrack(doc).pads) {
      expect(rows[pad.id]).toHaveLength(16);
    }
    expect(rows[kick.id][0]).toBe(0.5);
    expect(rows[kick.id][2]).toBe(0);
  });
});

describe("scheduler", () => {
  function makeHarness(doc: ProjectDocument) {
    const events: { trackId: string; padId: string; when: number; velocity: number }[] = [];
    const noteEvents: { trackId: string; pitch: number; velocity: number; when: number; durationSec: number }[] = [];
    let audioTime = 10;
    const transport = new Transport({ now: () => audioTime }, doc.bpm);
    const scheduler = new Scheduler({
      getProject: () => doc,
      getTransport: () => transport,
      getAudioTime: () => audioTime,
      trigger: (trackId: string, pad: DrumPad, when: number, velocity: number) => {
        events.push({ trackId, padId: pad.id, when, velocity });
      },
      noteOn: (trackId: string, pitch: number, velocity: number, when: number, durationSec: number) => {
        noteEvents.push({ trackId, pitch, velocity, when, durationSec });
      },
    });
    return { events, noteEvents, transport, scheduler, advance: (seconds: number) => (audioTime += seconds) };
  }

  it("schedules the starter groove ahead of the playhead", () => {
    const doc = createDefaultProject();
    const { events, transport, scheduler, advance } = makeHarness(doc);
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 40; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    const kickEvents = events.filter((e) => e.padId === "pad-01");
    expect(kickEvents.length).toBeGreaterThanOrEqual(2);
    for (const event of events) {
      expect(event.when).toBeGreaterThanOrEqual(10);
    }
    scheduler.stop();
  });

  it("wraps around the pattern boundary without losing the downbeat", () => {
    const doc = createDefaultProject();
    const { events, transport, scheduler, advance } = makeHarness(doc);
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 88; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    const kickTimes = events.filter((e) => e.padId === "pad-01").map((e) => e.when);
    const beatSeconds = 60 / doc.bpm;
    for (let i = 1; i < kickTimes.length; i++) {
      expect(kickTimes[i] - kickTimes[i - 1]).toBeCloseTo(beatSeconds, 3);
    }
    scheduler.stop();
  });

  it("skips muted pads", () => {
    const doc = createDefaultProject();
    doc.tracks[0].kind === "drum" && (doc.tracks[0].pads[0].mute = true);
    const { events, transport, scheduler, advance } = makeHarness(doc);
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 8; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    expect(events.find((e) => e.padId === "pad-01")).toBeUndefined();
    scheduler.stop();
  });

  it("step velocities are read live from the project", () => {
    const doc = createDefaultProject();
    const track = getDrumTrack(doc);
    const updated = setStepVelocity(doc, track.pads[1].id, 2, 0.42);
    const { events, transport, scheduler, advance } = makeHarness(updated);
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 40; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    const event = events.find((e) => e.padId === track.pads[1].id);
    expect(event?.velocity).toBeCloseTo(0.42, 5);
    scheduler.stop();
  });

  it("keeps step grid aligned to 16th notes", () => {
    const doc = createDefaultProject();
    const { events, transport, scheduler, advance } = makeHarness(doc);
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 40; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    const stepSeconds = (60 / doc.bpm) / 4;
    const kickTimes = events.filter((e) => e.padId === "pad-01").map((e) => e.when);
    expect(kickTimes[0]).toBeCloseTo(10, 5);
    for (let i = 1; i < kickTimes.length; i++) {
      expect((kickTimes[i] - kickTimes[i - 1]) % stepSeconds).toBeCloseTo(0, 3);
    }
    expect(STEP_TICKS).toBe(120);
    scheduler.stop();
  });

  it("triggers pads across multiple tracks", () => {
    const base = createDefaultProject();
    const second = createDrumTrackModel("Drums 2");
    const doc: ProjectDocument = normalizeProject({
      ...base,
      tracks: [...base.tracks, second],
    });
    const secondKick = second.pads[0];
    doc.patterns[0].rows[secondKick.id][0] = 0.7;
    const { events, transport, scheduler, advance } = makeHarness(doc);
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 8; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    expect(events.some((e) => e.trackId === base.tracks[0].id)).toBe(true);
    expect(events.some((e) => e.trackId === second.id)).toBe(true);
    const secondKickEvent = events.find((e) => e.padId === secondKick.id);
    expect(secondKickEvent?.velocity).toBeCloseTo(0.7, 5);
    scheduler.stop();
  });

  it("schedules instrument notes with correct pitch, timing and duration", () => {
    const doc = createDefaultProject();
    const bass = doc.tracks.find((t): t is import("../src/project-model/types").InstrumentTrack => t.kind === "instrument")!;
    const { noteEvents, transport, scheduler, advance } = makeHarness(doc);
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 60; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    expect(noteEvents.length).toBeGreaterThanOrEqual(4);
    const stepSec = (60 / doc.bpm) / 4;
    for (const event of noteEvents) {
      expect(event.trackId).toBe(bass.id);
      expect(event.velocity).toBeGreaterThan(0);
      expect(event.durationSec).toBeCloseTo(stepSec * 2, 3);
    }
    const first = noteEvents[0];
    expect(first.pitch).toBe(28);
    expect(first.when).toBeCloseTo(10, 3);
    expect(noteEvents.map((e) => e.pitch)).toContain(31);
    scheduler.stop();
  });

  it("wraps note scheduling across the pattern boundary", () => {
    const doc = createDefaultProject();
    const { noteEvents, transport, scheduler, advance } = makeHarness(doc);
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 120; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    const beats = (60 / doc.bpm) * 4;
    expect(noteEvents.length).toBeGreaterThanOrEqual(7);
    const wrapped = noteEvents[4];
    expect(wrapped.when).toBeGreaterThan(10 + beats - 0.1);
    scheduler.stop();
  });

  it("track mute silences the whole track; track solo silences the others", () => {
    const base = createDefaultProject();
    const second = createDrumTrackModel("Drums 2");
    const both: ProjectDocument = normalizeProject({
      ...base,
      tracks: [...base.tracks, { ...second, mute: true }],
    });
    const mutedHarness = makeHarness(both);
    mutedHarness.transport.play(0);
    mutedHarness.scheduler.start();
    for (let i = 0; i < 8; i++) {
      mutedHarness.advance(0.025);
      mutedHarness.scheduler["tick"]();
    }
    mutedHarness.scheduler.stop();
    expect(mutedHarness.events.every((e) => e.trackId !== second.id)).toBe(true);

    const soloed: ProjectDocument = normalizeProject({
      ...base,
      tracks: [...base.tracks.map((t) => (t.kind === "drum" ? { ...t, solo: false } : t)), { ...second, solo: true }],
    });
    const soloKick = second.pads[0];
    soloed.patterns[0].rows[soloKick.id][0] = 0.7;
    const soloHarness = makeHarness(soloed);
    soloHarness.transport.play(0);
    soloHarness.scheduler.start();
    for (let i = 0; i < 8; i++) {
      soloHarness.advance(0.025);
      soloHarness.scheduler["tick"]();
    }
    soloHarness.scheduler.stop();
    expect(soloHarness.events.length).toBeGreaterThan(0);
    expect(soloHarness.events.every((e) => e.trackId === second.id)).toBe(true);
  });
});
