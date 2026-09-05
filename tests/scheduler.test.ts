import { describe, expect, it, vi } from "vitest";
import {
  SCHEMA_VERSION,
  createDefaultProject,
  createDrumTrackModel,
  migrateProject,
  normalizeProject,
  validateProjectShape,
} from "../src/project-model/schema";
import { getDrumTrack, BAR_TICKS, STEP_TICKS } from "../src/project-model/types";
import { Scheduler } from "../src/scheduler/Scheduler";
import { Transport } from "../src/transport/Transport";
import type { DrumPad, Pattern, ProjectDocument } from "../src/project-model/types";
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
    expect(migrateProject(doc)).toStrictEqual(doc);
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

function makeHarness(doc: ProjectDocument, mode: "pattern" | "song" = "pattern", scheduleOffsetSec = 0) {
  const events: { trackId: string; padId: string; when: number; velocity: number }[] = [];
  const noteEvents: { trackId: string; pitch: number; velocity: number; when: number; durationSec: number }[] = [];
  const automationCalls: { from: number; to: number; relOf: (tick: number) => number }[] = [];
  const automationOffsets: number[] = [];
  const launches: string[] = [];
  let currentDoc = doc;
  let audioTime = 10;
  const transport = new Transport({ now: () => audioTime }, doc.bpm);
  const scheduler = new Scheduler({
    getProject: () => currentDoc,
    getTransport: () => transport,
    getAudioTime: () => audioTime,
    getScheduleOffsetSec: () => scheduleOffsetSec,
    getMode: () => mode,
    trigger: (trackId: string, pad: DrumPad, when: number, velocity: number) => {
      events.push({ trackId, padId: pad.id, when, velocity });
    },
    noteOn: (trackId: string, pitch: number, velocity: number, when: number, durationSec: number) => {
      noteEvents.push({ trackId, pitch, velocity, when, durationSec });
    },
    applyAutomation: (from: number, to: number, relOf: (tick: number) => number, offset?: number) => {
      automationCalls.push({ from, to, relOf });
      automationOffsets.push(offset ?? 0);
    },
    applyPatternLaunch: (patternId: string) => {
      launches.push(patternId);
      const next = currentDoc.patterns.find((p) => p.id === patternId);
      if (next) currentDoc = { ...currentDoc, activePatternId: patternId };
    },
  });
  return {
    events,
    noteEvents,
    automationCalls,
    automationOffsets,
    launches,
    transport,
    scheduler,
    setDoc: (next: ProjectDocument) => (currentDoc = next),
    getDoc: () => currentDoc,
    advance: (seconds: number) => (audioTime += seconds),
  };
}

describe("scheduler", () => {
  it("applies a runtime reference offset to project-generated events", () => {
    const doc = createDefaultProject();
    const baseline = makeHarness(doc);
    const shifted = makeHarness(doc, "pattern", 0.025);
    baseline.transport.play(0);
    shifted.transport.play(0);
    baseline.scheduler.start();
    shifted.scheduler.start();

    expect(shifted.events[0].when - baseline.events[0].when).toBeCloseTo(0.025, 6);
    baseline.scheduler.stop();
    shifted.scheduler.stop();
  });

  it("does not schedule negatively shifted events in the past", () => {
    const doc = createDefaultProject();
    const harness = makeHarness(doc, "pattern", -0.05);
    harness.transport.play(0);
    harness.scheduler.start();
    for (const event of harness.events) expect(event.when).toBeGreaterThanOrEqual(9.998);
    harness.scheduler.stop();
  });

  it("passes the runtime offset into automation scheduling", () => {
    const baseDoc = createDefaultProject();
    const doc = {
      ...baseDoc,
      automation: [
        {
          id: "auto-test",
          target: { kind: "trackGain" as const, trackId: baseDoc.tracks[0].id },
          points: [
            { tick: 0, value: 0.5 },
            { tick: 1920, value: 1 },
          ],
        },
      ],
    };
    const harness = makeHarness(doc, "pattern", 0.03);
    harness.transport.play(0);
    harness.scheduler.start();
    expect(harness.automationOffsets.some((offset) => offset === 0.03)).toBe(true);
    harness.scheduler.stop();
  });

  it("schedules the starter groove ahead of the playhead", () => {
    const doc = createDefaultProject();
    const kickPadId = getDrumTrack(doc).pads[0].id;
    const { events, transport, scheduler, advance } = makeHarness(doc);
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 40; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    const kickEvents = events.filter((e) => e.padId === kickPadId);
    expect(kickEvents.length).toBeGreaterThanOrEqual(2);
    for (const event of events) {
      expect(event.when).toBeGreaterThanOrEqual(10);
    }
    scheduler.stop();
  });

  it("wraps around the pattern boundary without losing the downbeat", () => {
    const doc = createDefaultProject();
    const kickPadId = getDrumTrack(doc).pads[0].id;
    const { events, transport, scheduler, advance } = makeHarness(doc);
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 88; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    const kickTimes = events.filter((e) => e.padId === kickPadId).map((e) => e.when);
    const beatSeconds = 60 / doc.bpm;
    for (let i = 1; i < kickTimes.length; i++) {
      expect(kickTimes[i] - kickTimes[i - 1]).toBeCloseTo(beatSeconds, 3);
    }
    scheduler.stop();
  });

  it("skips muted pads", () => {
    const doc = createDefaultProject();
    const kickPadId = getDrumTrack(doc).pads[0].id;
    doc.tracks[0].kind === "drum" && (doc.tracks[0].pads[0].mute = true);
    const { events, transport, scheduler, advance } = makeHarness(doc);
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 8; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    expect(events.find((e) => e.padId === kickPadId)).toBeUndefined();
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
    const kickPadId = getDrumTrack(doc).pads[0].id;
    const { events, transport, scheduler, advance } = makeHarness(doc);
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 40; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    const stepSeconds = 60 / doc.bpm / 4;
    const kickTimes = events.filter((e) => e.padId === kickPadId).map((e) => e.when);
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
    const bass = doc.tracks.find(
      (t): t is import("../src/project-model/types").InstrumentTrack => t.kind === "instrument",
    )!;
    const { noteEvents, transport, scheduler, advance } = makeHarness(doc);
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 60; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    const bassEvents = noteEvents.filter((e) => e.trackId === bass.id);
    expect(bassEvents.length).toBeGreaterThanOrEqual(4);
    const stepSec = 60 / doc.bpm / 4;
    for (const event of bassEvents) {
      expect(event.trackId).toBe(bass.id);
      expect(event.velocity).toBeGreaterThan(0);
      expect(event.durationSec).toBeCloseTo(stepSec * 2, 3);
    }
    const first = bassEvents[0];
    expect(first.pitch).toBe(28);
    expect(first.when).toBeCloseTo(10, 3);
    expect(bassEvents.map((e) => e.pitch)).toContain(31);
    scheduler.stop();
  });

  it("wraps note scheduling across the pattern boundary", () => {
    const doc = createDefaultProject();
    const bass = doc.tracks.find(
      (t): t is import("../src/project-model/types").InstrumentTrack => t.kind === "instrument",
    )!;
    const { noteEvents, transport, scheduler, advance } = makeHarness(doc);
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 120; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    const beats = (60 / doc.bpm) * 4;
    const bassEvents = noteEvents.filter((e) => e.trackId === bass.id);
    expect(bassEvents.length).toBeGreaterThanOrEqual(7);
    const wrapped = bassEvents[4];
    expect(wrapped.when).toBeGreaterThan(10 + beats - 0.1);
    scheduler.stop();
  });

  it("song mode plays the arrangement: clips switch patterns at their boundaries", () => {
    const closeToGrid = (value: number, unit: number) => {
      const remainder = ((value % unit) + unit) % unit;
      const distance = Math.min(remainder, unit - remainder);
      expect(distance).toBeLessThan(0.001);
    };
    const doc = createDefaultProject();
    const grooveScene = doc.scenes[0];
    const patternB = {
      ...doc.patterns[0],
      id: "pattern-b",
      name: "Pattern B",
      rows: { ...doc.patterns[0].rows },
      notes: {},
    };
    const kick = getDrumTrack(doc).pads[0];
    patternB.rows[kick.id] = new Array(16).fill(0).map((_, i) => (i === 0 || i === 8 ? 0.9 : 0));
    const sceneB = { id: "scene-b", name: "Break", patternId: patternB.id, intensity: 0.7 };
    const withSong: ProjectDocument = {
      ...doc,
      patterns: [...doc.patterns, patternB],
      scenes: [...doc.scenes, sceneB],
      arrangement: {
        clips: [
          { id: "clip-1", sceneId: grooveScene.id, startBar: 0, lengthBars: 2 },
          { id: "clip-2", sceneId: sceneB.id, startBar: 2, lengthBars: 2 },
        ],
      },
    };
    const { events, transport, scheduler, advance } = makeHarness(withSong, "song");
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 200; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    const kickTimes = events.filter((e) => e.padId === kick.id).map((e) => e.when);
    expect(kickTimes.length).toBeGreaterThanOrEqual(6);
    const beatSec = 60 / withSong.bpm;
    const barSec = beatSec * 4;
    const boundary = 10 + 2 * barSec;
    const beforeBoundary = kickTimes.filter((t) => t < boundary - 0.01);
    const afterBoundary = kickTimes.filter((t) => t >= boundary - 0.01);
    expect(beforeBoundary.length).toBeGreaterThanOrEqual(4);
    expect(afterBoundary.length).toBeGreaterThanOrEqual(2);
    for (const t of beforeBoundary) {
      closeToGrid(t - 10, beatSec);
    }
    for (const t of afterBoundary) {
      closeToGrid(t - boundary, beatSec * 2);
    }
    scheduler.stop();
  });

  it("song mode is silent in gaps between clips", () => {
    const doc = createDefaultProject();
    const scene = doc.scenes[0];
    const withGap: ProjectDocument = {
      ...doc,
      arrangement: {
        clips: [
          { id: "clip-1", sceneId: scene.id, startBar: 0, lengthBars: 1 },
          { id: "clip-2", sceneId: scene.id, startBar: 3, lengthBars: 1 },
        ],
      },
    };
    const { events, transport, scheduler, advance } = makeHarness(withGap, "song");
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 140; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    const beatSec = 60 / withGap.bpm;
    const barSec = beatSec * 4;
    const gapStart = 10 + barSec;
    const gapEnd = 10 + 3 * barSec;
    const inGap = events.filter((e) => e.when >= gapStart + 0.01 && e.when < gapEnd - 0.01);
    expect(inGap).toHaveLength(0);
    scheduler.stop();
  });

  it("song mode loops a short pattern inside a longer clip", () => {
    const doc = createDefaultProject();
    const scene = doc.scenes[0];
    const withLongClip: ProjectDocument = {
      ...doc,
      arrangement: { clips: [{ id: "clip-1", sceneId: scene.id, startBar: 0, lengthBars: 3 }] },
    };
    const { events, transport, scheduler, advance } = makeHarness(withLongClip, "song");
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 300; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    const kick = getDrumTrack(doc).pads[0];
    const kickTimes = events.filter((e) => e.padId === kick.id).map((e) => e.when);
    const beatSec = 60 / withLongClip.bpm;
    const patternSec = beatSec * 4;
    expect(kickTimes.length).toBeGreaterThanOrEqual(10);
    const secondLoop = kickTimes.find((t) => t > 10 + patternSec + 0.01);
    expect(secondLoop).toBeDefined();
    expect(secondLoop! - (10 + patternSec)).toBeLessThan(beatSec + 0.001);
    scheduler.stop();
  });

  it("automation hook is called once per window in pattern mode", () => {
    const doc = createDefaultProject();
    const { automationCalls, transport, scheduler, advance } = makeHarness(doc);
    transport.play(0);
    scheduler.start();
    for (let i = 0; i < 8; i++) {
      advance(0.025);
      scheduler["tick"]();
    }
    expect(automationCalls.length).toBeGreaterThanOrEqual(6);
    for (const call of automationCalls) {
      expect(call.to).toBeGreaterThan(call.from);
    }
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

  it("song-mode automation uses the covering clip's real patternTicks (not a hard-coded length)", () => {
    // Regression: the scheduler used to initialise automationCtx with
    // `patternTicks: STEP_TICKS * 4 * 4` (= 480), which broke looping for any
    // pattern that wasn't a 16-step default.
    const base = createDefaultProject();
    const drum = getDrumTrack(base);
    const trackId = drum.id;
    const stepCount = 32; // 32-step pattern → patternTicks = 3840
    const pattern32: Pattern = {
      ...base.patterns[0],
      stepCount,
      rows: Object.fromEntries(
        drum.pads.map((pad) => [
          pad.id,
          new Array<number>(stepCount).fill(0).map((_, i) => base.patterns[0].rows[pad.id][i] ?? 0),
        ]),
      ),
    };
    const scene = base.scenes[0];
    const doc: ProjectDocument = normalizeProject({
      ...base,
      patterns: [pattern32],
      arrangement: {
        clips: [{ id: "clip-1", sceneId: scene.id, startBar: 0, lengthBars: 8 }],
      },
      automation: [
        {
          id: "auto-pan",
          target: { kind: "trackPan", trackId },
          points: [
            { tick: 0, value: 0 },
            { tick: STEP_TICKS * 16, value: 0.5 },
          ],
        },
      ],
    });
    const clipStart = 0;
    const h = makeHarness(doc, "song");
    h.transport.play(0);
    h.scheduler.start();
    h.advance(0.025);
    h.scheduler["tick"]();
    h.scheduler.stop();

    expect(h.automationCalls.length).toBeGreaterThan(0);
    const { from, to, relOf } = h.automationCalls[0];
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);

    // The probe tick must wrap to a non-zero value when the pattern is 32
    // steps long. With the old hard-coded patternTicks = 480, mod(1920, 480)
    // = 0 and this assertion would fail.
    const probe = clipStart + STEP_TICKS * 16;
    expect(relOf(probe)).toBe(STEP_TICKS * 16);
    expect(relOf(clipStart)).toBe(0);
    expect(relOf(clipStart + stepCount * STEP_TICKS)).toBe(0);
    expect(relOf(clipStart + stepCount * STEP_TICKS * 2)).toBe(0);
  });
});

describe("scheduler realtime loop wrap", () => {
  it("pattern mode: scheduler rebases to loopStart when position reaches loopEnd", () => {
    // 16-step default pattern is 16 * STEP_TICKS = 1920 ticks. Loop over the
    // first 8 steps (0..960) so position wraps to 0 after a long advance.
    const doc = createDefaultProject();
    const h = makeHarness(doc, "pattern");
    h.transport.setLoop(true, 0, 8 * STEP_TICKS);
    h.transport.play(0);
    h.advance(2);
    h.scheduler["tick"]();
    expect(h.transport.position).toBeLessThan(8 * STEP_TICKS);
    h.scheduler.stop();
  });

  it("pattern mode: loopEnd === 0 resolves to the full pattern (no wrap)", () => {
    const doc = createDefaultProject();
    const h = makeHarness(doc, "pattern");
    h.transport.setLoop(true, 0, 0); // sentinel → patternTicks
    h.transport.play(0);
    h.advance(1);
    h.scheduler["tick"]();
    // Position should be well past the 8-step mark but inside the full pattern.
    expect(h.transport.position).toBeGreaterThan(8 * STEP_TICKS);
    expect(h.transport.position).toBeLessThan(16 * STEP_TICKS);
    h.scheduler.stop();
  });

  it("song mode: scheduler rebases to loopStart when position reaches loopEnd (1 bar loop)", () => {
    const doc = createDefaultProject();
    const h = makeHarness(doc, "song");
    h.transport.setLoop(true, 0, BAR_TICKS);
    h.transport.play(0);
    h.advance(2);
    h.scheduler["tick"]();
    expect(h.transport.position).toBeLessThan(BAR_TICKS);
    h.scheduler.stop();
  });

  it("scheduler does not rebase when loop is disabled (existing behavior preserved)", () => {
    const doc = createDefaultProject();
    const h = makeHarness(doc, "pattern");
    h.transport.play(0);
    h.advance(2);
    h.scheduler["tick"]();
    expect(h.transport.position).toBeGreaterThan(8 * STEP_TICKS);
    h.scheduler.stop();
  });

  it("play() snaps to loopStart when pauseTick is before the loop (Transport contract)", () => {
    // Transport.play() handles the "before-loop" snap. The scheduler's
    // position < loopStart branch is a defensive no-op for already-snapped
    // playback, so we just verify the play-side contract.
    const doc = createDefaultProject();
    const h = makeHarness(doc, "pattern");
    h.transport.setLoop(true, 4 * STEP_TICKS, 12 * STEP_TICKS);
    h.transport.play(0);
    expect(h.transport.position).toBe(4 * STEP_TICKS);
    h.scheduler.stop();
  });
});

describe("scheduler — quantized pattern launch", () => {
  function docWithEmptySecondPattern(): { doc: ProjectDocument; secondId: string } {
    const base = createDefaultProject();
    const first = base.patterns[0];
    // A second, completely silent pattern — after a launch, drum events must stop.
    const second: Pattern = {
      id: "pattern-silent",
      name: "Silent",
      stepCount: first.stepCount,
      rows: Object.fromEntries(
        Object.keys(first.rows).map((padId) => [padId, new Array<number>(first.stepCount).fill(0)]),
      ),
      notes: {},
    };
    return {
      doc: { ...base, patterns: [first, second], activePatternId: first.id },
      secondId: second.id,
    };
  }

  it("launches the queued pattern exactly at the boundary tick", () => {
    const { doc, secondId } = docWithEmptySecondPattern();
    const h = makeHarness(doc, "pattern");
    h.transport.play(0);
    h.scheduler.start();
    h.scheduler.queuePatternLaunch(secondId, BAR_TICKS);
    expect(h.scheduler.pendingPatternId).toBe(secondId);
    for (let i = 0; i < 120; i++) {
      h.advance(0.025);
      h.scheduler["tick"]();
      if (h.launches.length > 0) break;
    }
    expect(h.launches).toEqual([secondId]);
    expect(h.getDoc().activePatternId).toBe(secondId);
    expect(h.scheduler.pendingPatternId).toBeNull();
    // After the boundary the wiped pattern schedules no drum hits.
    const boundarySeconds = h.transport.timeAtTick(BAR_TICKS);
    const lateDrumEvents = h.events.filter((e) => e.when >= boundarySeconds + 0.02);
    expect(lateDrumEvents).toHaveLength(0);
    // But events before the boundary came from the original groove.
    expect(h.events.filter((e) => e.when < boundarySeconds).length).toBeGreaterThan(0);
    h.scheduler.stop();
  });

  it("stop() commits a pending launch immediately", () => {
    const { doc, secondId } = docWithEmptySecondPattern();
    const h = makeHarness(doc, "pattern");
    h.scheduler.queuePatternLaunch(secondId, 4 * BAR_TICKS);
    h.scheduler.stop();
    expect(h.launches).toEqual([secondId]);
    expect(h.getDoc().activePatternId).toBe(secondId);
  });

  it("a launch whose boundary was passed (e.g. after seek) commits on the next tick", () => {
    const { doc, secondId } = docWithEmptySecondPattern();
    const h = makeHarness(doc, "pattern");
    h.transport.play(0);
    h.scheduler.start();
    h.advance(3); // position now ~3s in ≈ well past bar 1
    h.scheduler.resync();
    h.scheduler.queuePatternLaunch(secondId, BAR_TICKS); // boundary already behind us
    h.scheduler["tick"]();
    expect(h.launches).toEqual([secondId]);
    expect(h.getDoc().activePatternId).toBe(secondId);
    h.scheduler.stop();
  });

  it("launches a NON-empty pattern without dropping its first hits after the boundary", () => {
    // Regression: the scheduler scheduled only [windowStart, boundary) and then
    // advanced the window to the full windowEnd — so every event of the newly
    // launched pattern inside (boundary, windowEnd] was silently skipped. The
    // downbeat of a quantized scene/pattern launch landed inside that gap.
    const base = createDefaultProject();
    const first = base.patterns[0];
    const kickPadId = getDrumTrack(base).pads[0].id;
    const second: Pattern = {
      id: "pattern-hit",
      name: "Hit",
      stepCount: first.stepCount,
      rows: Object.fromEntries(
        Object.keys(first.rows).map((padId) => [
          padId,
          new Array<number>(first.stepCount).fill(0).map((_, i) => (padId === kickPadId && i === 1 ? 0.9 : 0)),
        ]),
      ),
      notes: {},
    };
    const doc: ProjectDocument = { ...base, patterns: [first, second], activePatternId: first.id };
    const h = makeHarness(doc, "pattern");
    h.transport.play(0);
    h.scheduler.start();
    h.scheduler.queuePatternLaunch(second.id, BAR_TICKS);
    // Run well past the launch: the region [boundary, launchWindowEnd) must
    // be covered either by the commit tick itself or the following windows —
    // never skipped.
    for (let i = 0; i < 200; i++) {
      h.advance(0.025);
      h.scheduler["tick"]();
      if (h.launches.length > 0 && h.transport.position > BAR_TICKS + STEP_TICKS * 2) break;
    }
    expect(h.launches).toEqual([second.id]);
    // The launched pattern hits step 1 (tick BAR_TICKS + STEP_TICKS).
    const hitTick = BAR_TICKS + STEP_TICKS;
    const boundarySeconds = h.transport.timeAtTick(BAR_TICKS);
    const hitSeconds = h.transport.timeAtTick(hitTick);
    const scheduled = h.events.filter((e) => e.padId === kickPadId && Math.abs(e.when - hitSeconds) < 0.002);
    expect(scheduled.length).toBe(1);
    expect(scheduled[0].when).toBeGreaterThanOrEqual(boundarySeconds);
    h.scheduler.stop();
  });
});

describe("scheduler — seek resync", () => {
  it("resync re-aligns the window after a seek while playing", () => {
    const doc = createDefaultProject();
    const h = makeHarness(doc, "pattern");
    h.transport.play(0);
    h.scheduler.start();
    h.advance(2);
    h.scheduler["tick"]();
    const horizonBefore = h.scheduler.stats.lastHorizonTick;
    expect(horizonBefore).toBeGreaterThan(4 * STEP_TICKS);
    // Seek back to the start while playing and resync.
    h.transport.seek(0);
    h.scheduler.resync();
    h.scheduler["tick"]();
    expect(h.scheduler.stats.lastHorizonTick).toBeLessThan(horizonBefore);
    expect(h.scheduler.stats.lastHorizonTick).toBeLessThan(2 * STEP_TICKS);
    h.scheduler.stop();
  });
});

describe("scheduler — pending launch notifications", () => {
  it("notifies subscribers when a pending launch is queued, fires, and clears", () => {
    const base = createDefaultProject();
    const first = base.patterns[0];
    const second: Pattern = {
      id: "pattern-silent-2",
      name: "Silent",
      stepCount: first.stepCount,
      rows: Object.fromEntries(
        Object.keys(first.rows).map((padId) => [padId, new Array<number>(first.stepCount).fill(0)]),
      ),
      notes: {},
    };
    const doc: ProjectDocument = { ...base, patterns: [first, second], activePatternId: first.id };

    const h = makeHarness(doc, "pattern");
    let notifies = 0;
    const unsub = h.scheduler.subscribe(() => notifies++);
    h.scheduler.queuePatternLaunch(second.id, BAR_TICKS);
    expect(notifies).toBe(1);
    expect(h.scheduler.pendingPatternId).toBe(second.id);

    h.transport.play(0);
    h.scheduler.start();
    for (let i = 0; i < 120; i++) {
      h.advance(0.025);
      h.scheduler["tick"]();
      if (h.scheduler.pendingPatternId === null) break;
    }
    expect(notifies).toBeGreaterThanOrEqual(2);
    expect(h.scheduler.pendingPatternId).toBeNull();
    unsub();
    h.scheduler.stop();
  });
});

describe("scheduler — failure containment", () => {
  it("a throwing trigger does not wedge the window (regression: exception re-scheduled the same events every 25 ms)", () => {
    const doc = createDefaultProject();
    const triggerCalls: number[] = [];
    let audioTime = 10;
    const transport = new Transport({ now: () => audioTime }, doc.bpm);
    const scheduler = new Scheduler({
      getProject: () => doc,
      getTransport: () => transport,
      getAudioTime: () => audioTime,
      getMode: () => "pattern",
      trigger: () => {
        triggerCalls.push(audioTime);
        throw new Error("boom");
      },
      noteOn: () => {},
      applyAutomation: () => {},
      applyPatternLaunch: () => {},
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    transport.play(0);
    try {
      // Old behavior: the trigger's exception propagated out of tick() and
      // windowStartTick never advanced, so every later tick re-entered the
      // same window — duplicating already-scheduled events forever.
      expect(() => scheduler.start()).not.toThrow();
      expect(errSpy).toHaveBeenCalled();
      expect(scheduler.stats.lastHorizonTick).toBeGreaterThan(0);
      // Advance time and tick again: the scheduler must move FORWARD —
      // windowStartTick already passed the damaged window.
      audioTime += 0.2;
      scheduler["tick"]();
      expect(triggerCalls.length).toBeLessThanOrEqual(4); // no runaway re-scheduling
    } finally {
      scheduler.stop();
      errSpy.mockRestore();
    }
  });
});

describe("scheduler — recovery", () => {
  it("does not throw when the active pattern id points to a deleted pattern", () => {
    // Regression: getActivePattern() throws when activePatternId is stale.
    // The scheduler's tick() catch block counts the exception but the
    // very next tick re-throws on the same line — the scheduler wedges
    // and failedWindows grows unbounded. The scheduler must fall back
    // to a usable pattern instead of crashing every window.
    const doc = createDefaultProject();
    doc.activePatternId = "deleted-pattern-id";
    const h = makeHarness(doc);
    h.transport.play(0);
    h.scheduler.start();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let i = 0; i < 12; i++) {
        h.advance(0.025);
        expect(() => h.scheduler["tick"]()).not.toThrow();
      }
      // The scheduler must not be in a permanent failure spiral.
      // (Some failedWindows are allowed for the first tick while it
      // detects the missing pattern; the rest of the windows should
      // recover.)
      expect(h.scheduler.stats.windows).toBeGreaterThan(8);
    } finally {
      h.scheduler.stop();
      errSpy.mockRestore();
    }
  });

  it("clears a pending launch whose target pattern was removed from the doc", () => {
    // Regression: a queued scene launch survives a pattern delete because
    // the scheduler doesn't subscribe to onDocChanged. On the next
    // boundary tick, applyPatternLaunch("deleted") is called, the
    // dependency callback updates activePatternId to a missing id, and
    // the next tick() throws on getActivePattern. The scheduler must
    // drop the pending launch and never invoke applyPatternLaunch.
    const base = createDefaultProject();
    const second = { ...base.patterns[0], id: "second-pattern", name: "B" };
    const doc: ProjectDocument = normalizeProject({
      ...base,
      patterns: [...base.patterns, second],
    });
    const h = makeHarness(doc, "pattern");
    h.transport.play(0);
    h.scheduler.queuePatternLaunch(second.id, BAR_TICKS);
    expect(h.scheduler.pendingPatternId).toBe(second.id);
    // Remove the second pattern from the live doc.
    h.setDoc({ ...doc, patterns: doc.patterns.filter((p) => p.id !== second.id) });
    h.scheduler.start();
    try {
      // Cross the queued boundary (one full bar of lookahead).
      for (let i = 0; i < 80; i++) {
        h.advance(0.025);
        h.scheduler["tick"]();
      }
      // The scheduler must not have asked the harness to launch a
      // pattern that no longer exists in the doc.
      expect(h.launches).not.toContain(second.id);
      expect(h.scheduler.pendingPatternId).toBeNull();
    } finally {
      h.scheduler.stop();
    }
  });

  it("skips event scheduling while the audio context is suspended", () => {
    // Regression: events scheduled against a suspended context are queued
    // by createBufferSource; on resume they all fire in a microsecond
    // burst (a "machine gun" of every missed step). The scheduler must
    // gate tick() on the live context state and not enqueue anything
    // while suspended — the window still advances so we don't wedge.
    const base = createDefaultProject();
    const events: { trackId: string; padId: string; when: number; velocity: number }[] = [];
    let currentDoc = base;
    let audioTime = 10;
    const transport = new Transport({ now: () => audioTime }, base.bpm);
    const scheduler = new Scheduler({
      getProject: () => currentDoc,
      getTransport: () => transport,
      getAudioTime: () => audioTime,
      getScheduleOffsetSec: () => 0,
      getMode: () => "pattern",
      getContextState: () => "suspended" as const,
      trigger: (trackId, pad, when, velocity) => {
        events.push({ trackId, padId: pad.id, when, velocity });
      },
      noteOn: () => {},
      applyAutomation: () => {},
      applyPatternLaunch: () => {},
    });
    transport.play(0);
    scheduler.start();
    try {
      for (let i = 0; i < 40; i++) {
        audioTime += 0.025;
        scheduler["tick"]();
      }
      expect(events).toEqual([]);
      // The scheduler must still have advanced its bookkeeping — a
      // suspended context should not freeze windowStartTick forever.
      expect(scheduler.stats.windows).toBeGreaterThan(0);
    } finally {
      scheduler.stop();
    }
  });
});
