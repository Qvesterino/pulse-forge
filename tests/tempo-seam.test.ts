import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { setSceneBpm } from "../src/commands/commands";
import { buildTempoMap } from "../src/rendering/renderer";
import { Scheduler } from "../src/scheduler/Scheduler";
import { Transport } from "../src/transport/Transport";
import { BAR_TICKS, PPQ, STEP_TICKS } from "../src/project-model/types";
import type { DrumTrack, InstrumentTrack, ProjectDocument } from "../src/project-model/types";

/**
 * Release roadmap 2.2 — scene-tempo seam. The scheduler must split its
 * lookahead window at a clip boundary whose scene pins a different BPM:
 * events before the boundary run on the old anchor, events after it are
 * pre-scheduled on the new tempo integrated FROM the boundary (the exact
 * formula `buildTempoMap` uses offline), and the transport re-anchors only
 * when the playhead actually crosses. Before the fix the tempo flipped up to
 * one lookahead (~120 ms) early at a non-musical window edge and live
 * diverged from export.
 */

const BPM_A = 120;
const BPM_B = 240;
const B = 4 * BAR_TICKS; // boundary: bar 4 = 7680 ticks

function twoTempoSong(): ProjectDocument {
  let doc = createDefaultProject();
  const sceneA = doc.scenes[0];
  const patternB = doc.patterns[1] ?? doc.patterns[0];
  const sceneB = { id: "scene-b", name: "Scene B", patternId: patternB.id, intensity: 0.7, bpm: BPM_B };
  doc = {
    ...doc,
    scenes: [...doc.scenes, sceneB],
    arrangement: {
      ...doc.arrangement,
      clips: [
        { id: "c1", sceneId: sceneA.id, startBar: 0, lengthBars: 4 },
        { id: "c2", sceneId: "scene-b", startBar: 4, lengthBars: 4 },
      ],
    },
  };
  doc = setSceneBpm(doc, sceneA.id, BPM_A).execute(doc);
  // One dense row on the first pad of each pattern — one hit per 16th.
  const drum = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
  const padId = drum.pads[0].id;
  // REPLACE the rows (do not spread the default kit's rows) so exactly one
  // pad fires per 16th — every captured hit then maps to a known grid tick.
  const fill = (p: ProjectDocument, patternId: string) => ({
    ...p,
    patterns: p.patterns.map((pat) =>
      pat.id === patternId
        ? {
            ...pat,
            rows: { [padId]: new Array(pat.stepCount).fill(0.8) },
            stepMeta: {},
          }
        : pat,
    ),
  });
  doc = fill(doc, doc.patterns[0].id);
  doc = fill(doc, patternB.id);
  return doc;
}

function makeHarness(doc: ProjectDocument) {
  let audioTime = 10;
  const transport = new Transport({ now: () => audioTime }, doc.bpm);
  const triggers: { when: number; velocity: number }[] = [];
  const captured: { tick: number; velocity: number; padId?: string; pitch?: number; duration?: number }[] = [];
  const tempoCalls: (number | null)[] = [];
  const engineTempoCalls: number[] = [];
  const automationCalls: {
    from: number;
    to: number;
    offset: number;
    timeAt?: (tick: number) => number;
  }[] = [];
  const scheduler = new Scheduler({
    getProject: () => doc,
    getTransport: () => transport,
    getAudioTime: () => audioTime,
    getMode: () => "song",
    trigger: (_trackId, _pad, when, velocity) => triggers.push({ when, velocity }),
    noteOn: () => {},
    applyAutomation: (from, to, _relOf, offset, timeAt) =>
      automationCalls.push({ from, to, offset: offset ?? 0, timeAt }),
    applyPatternLaunch: () => {},
    applySceneTempo: (bpm) => {
      tempoCalls.push(bpm);
      // Mirror the real services wiring: transport AND engine runtimes get
      // the effective tempo on the immediate path.
      const effective = bpm ?? doc.bpm;
      transport.setBpm(effective);
      engineTempoCalls.push(effective);
    },
    applyEngineTempo: (bpm) => engineTempoCalls.push(bpm),
    recordCapturedEvent: (event) =>
      captured.push({
        tick: event.tick,
        velocity: event.velocity,
        padId: event.padId,
        pitch: event.pitch,
        duration: event.duration,
      }),
  });
  return {
    doc,
    transport,
    scheduler,
    triggers,
    captured,
    tempoCalls,
    engineTempoCalls,
    automationCalls,
    advance: (seconds: number) => {
      audioTime += seconds;
      scheduler["tick"]();
    },
    get time() {
      return audioTime;
    },
  };
}

/** Expected live `when` for a hit at absolute tick t (play anchored at t=10s). */
function expectedWhen(t: number): number {
  const t0 = 10;
  if (t < B) return t0 + t * (60 / (BPM_A * PPQ));
  const boundaryTime = t0 + B * (60 / (BPM_A * PPQ));
  return boundaryTime + (t - B) * (60 / (BPM_B * PPQ));
}

describe("Scheduler — scene-tempo seam (roadmap 2.2)", () => {
  it("schedules events past the boundary on the NEW tempo exactly from the boundary", () => {
    const h = makeHarness(twoTempoSong());
    h.transport.play(0);
    h.scheduler.start();
    // Drive playback past the boundary with headroom so the lookahead
    // window covers the events asserted below (tick 8640 sounds at 18.5 s).
    while (h.time < 19.2) h.advance(0.025);
    h.scheduler.stop();

    // The capture ring carries drum hits (padId) AND instrument notes
    // (pitch) — the grid assertions compare drum hits only.
    const drumHits = h.captured.filter((e) => e.padId !== undefined);
    expect(drumHits.length).toBeGreaterThan(40);
    const boundaryHits = drumHits.filter((e) => e.tick >= B);
    expect(boundaryHits.length).toBeGreaterThanOrEqual(8);
    // EVERY scheduled event — old side AND new side — sits on its tempo map.
    for (const hit of drumHits) {
      const trigger = h.triggers.find((tr) => Math.abs(tr.when - expectedWhen(hit.tick)) < 0.05);
      expect(trigger, `no trigger near expected time for tick ${hit.tick}`).toBeDefined();
    }
    // Precise check on a few known ticks: last of clip A, first of clip B.
    const lastA = 7680 - STEP_TICKS;
    const firstB = B;
    for (const t of [lastA, firstB, firstB + STEP_TICKS * 8]) {
      const hit = h.triggers.find((tr) => Math.abs(tr.when - expectedWhen(t)) < 1e-6);
      expect(hit, `tick ${t} must land at ${expectedWhen(t)}`).toBeDefined();
    }
  });

  it("flips the transport only when the playhead crosses the boundary", () => {
    const h = makeHarness(twoTempoSong());
    h.transport.play(0);
    h.scheduler.start();
    const samples: { time: number; bpm: number }[] = [];
    while (h.time < 18.5) {
      h.advance(0.025);
      samples.push({ time: h.time, bpm: h.transport.bpm });
    }
    h.scheduler.stop();
    // Before the boundary instant (audioTime 18 s) the transport MUST still
    // run at 120 — the old bug flipped it up to 120 ms early here.
    for (const s of samples.filter((x) => x.time < 18 - 1e-9)) {
      expect(s.bpm, `bpm at ${s.time}s must be 120`).toBe(BPM_A);
    }
    for (const s of samples.filter((x) => x.time >= 18 + 0.025 - 1e-9)) {
      expect(s.bpm, `bpm at ${s.time}s must be 240`).toBe(BPM_B);
    }
  });

  it("does not double-fire or drop hits at the seam", () => {
    const h = makeHarness(twoTempoSong());
    h.transport.play(0);
    h.scheduler.start();
    while (h.time < 19.5) h.advance(0.025);
    h.scheduler.stop();
    // Every grid hit whose sound time falls inside the driven window must
    // fire EXACTLY once — no seam double-fires, no dropped hits. Clip B runs
    // at 240 BPM, so 1.5 s past the boundary covers only its opening bars.
    const ticks = h.captured
      .filter((e) => e.padId !== undefined)
      .map((e) => e.tick)
      .sort((a, b) => a - b);
    const expected: number[] = [];
    for (let t = 0; t < 8 * BAR_TICKS; t += STEP_TICKS) {
      if (expectedWhen(t) < 19.65) expected.push(t);
    }
    expect(ticks).toEqual(expected);
  });

  it("matches the offline buildTempoMap tick→time map", () => {
    const doc = twoTempoSong();
    const h = makeHarness(doc);
    h.transport.play(0);
    h.scheduler.start();
    while (h.time < 18.5) h.advance(0.025);
    h.scheduler.stop();

    const map = buildTempoMap(doc, [
      { from: 0, to: B, bpm: BPM_A },
      { from: B, to: 8 * BAR_TICKS, bpm: BPM_B },
    ] as never);
    for (const hit of h.captured.filter((e) => e.padId !== undefined)) {
      const offline = map.timeAt(hit.tick);
      const live = expectedWhen(hit.tick) - 10; // offline map starts at 0
      expect(live).toBeCloseTo(offline, 4);
    }
  });

  it("stop() discards a scheduled flip (it must not fire after restart)", () => {
    const h = makeHarness(twoTempoSong());
    h.transport.play(0);
    h.scheduler.start();
    // Drive until the split window exists (boundary inside the lookahead).
    while (h.time < 17.9) h.advance(0.025);
    h.scheduler.stop();
    expect(h.scheduler["pendingTempoFlip"]).toBeNull();
    // Restart from the beginning: the stale flip must not leak into it.
    h.transport.seek(0);
    h.transport.play(0);
    h.scheduler.start();
    h.advance(0.025);
    expect(h.transport.bpm).toBe(BPM_A);
    h.scheduler.stop();
  });

  it("sustained notes take their duration from the LOCAL map tempo (old before the seam, new after)", () => {
    // The live duration bug: in the split window the transport still runs the
    // OLD tempo, so notes starting on the NEW side got old-tempo (2× too long
    // at 120→240) durations live, while the offline render used the new one.
    let doc = twoTempoSong();
    const inst = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument");
    expect(inst).toBeDefined();
    const seedNote = (patternId: string) => ({
      ...doc,
      patterns: doc.patterns.map((pat) =>
        pat.id === patternId
          ? {
              ...pat,
              notes: {
                ...pat.notes,
                [inst!.id]: [{ id: `sus-${patternId}`, pitch: 88, start: 0, duration: 480, velocity: 0.8 }],
              },
            }
          : pat,
      ),
    });
    // Both scenes share the house template's single pattern (see
    // twoTempoSong's `patterns[1] ?? patterns[0]` fallback), so one seeded
    // note fires in BOTH clip windows — old tempo in A, new in B.
    doc = seedNote(doc.patterns[0].id);
    if (doc.patterns[1]) doc = seedNote(doc.patterns[1].id);
    const h = makeHarness(doc);
    h.transport.play(0);
    h.scheduler.start();
    while (h.time < 19.2) h.advance(0.025);
    h.scheduler.stop();

    // A quarter note (480 ticks) lasts 0.5 s at 120 BPM and 0.25 s at 240.
    const sptA = 60 / (BPM_A * PPQ);
    const sptB = 60 / (BPM_B * PPQ);
    const noteDur = (tick: number) => {
      const events = h.captured.filter((e) => e.padId === undefined && e.pitch === 88 && e.tick === tick);
      expect(events.length, `note at tick ${tick} must be captured`).toBeGreaterThan(0);
      return events[0].duration;
    };
    // Old side (clip A cycles) — old tempo. New side (clip B) — NEW tempo,
    // even though the transport had not re-anchored yet when the note was
    // scheduled inside the split window.
    expect(noteDur(0)).toBeCloseTo(480 * sptA, 6);
    expect(noteDur(5760)).toBeCloseTo(480 * sptA, 6);
    expect(noteDur(B)).toBeCloseTo(480 * sptB, 6);
    expect(noteDur(B + BAR_TICKS)).toBeCloseTo(480 * sptB, 6);
  });

  it("pushes the effective tempo to the engine at the flip and restores doc BPM on stop", () => {
    const h = makeHarness(twoTempoSong());
    h.transport.play(0);
    h.scheduler.start();
    // First window: the active scene's tempo reaches the engine immediately.
    expect(h.engineTempoCalls[0]).toBe(BPM_A);
    while (h.time < 19.2) h.advance(0.025);
    expect(h.transport.bpm).toBe(BPM_B);
    // The flip commit handed the NEW tempo to the engine (SYNC delays/LFO
    // syncs flip with the transport, not a window late).
    expect(h.engineTempoCalls).toContain(BPM_B);
    expect(h.engineTempoCalls.at(-1)).toBe(BPM_B);
    h.scheduler.stop();
    // stop() hands tempo control back to the project tempo — engine too.
    expect(h.engineTempoCalls.at(-1)).toBe(h.doc.bpm);
    h.scheduler.stop();
  });
});

describe("Scheduler — tick-mapped automation across the tempo seam (roadmap 2.3)", () => {
  it("hands the window's tick→time map to applyAutomation — piecewise in the split window", () => {
    let doc = twoTempoSong();
    // Project automation lane on the drum track's gain.
    const drum = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
    doc = {
      ...doc,
      automation: [
        {
          id: "auto-1",
          target: { kind: "trackGain", trackId: drum.id },
          points: [
            { tick: 0, value: 0.3 },
            { tick: 8 * BAR_TICKS, value: 0.9 },
          ],
        },
      ],
    };
    const h = makeHarness(doc);
    h.transport.play(0);
    h.scheduler.start();
    while (h.time < 18.4) h.advance(0.025);
    h.scheduler.stop();

    expect(h.automationCalls.length).toBeGreaterThan(4);
    // Every call carries a timeAt map; the window edge times must follow the
    // TEMPO MAP (old before the boundary, new after), not the wall clock.
    for (const call of h.automationCalls) {
      expect(call.timeAt).toBeDefined();
      const t0 = call.timeAt!(call.from);
      const t1 = call.timeAt!(call.to);
      expect(t0).toBeCloseTo(expectedWhen(call.from), 3);
      expect(t1).toBeCloseTo(expectedWhen(call.to), 3);
    }
    // Continuity: end time of window N == start time of window N+1.
    for (let i = 1; i < h.automationCalls.length; i++) {
      const prevEnd = h.automationCalls[i - 1].timeAt!(h.automationCalls[i - 1].to);
      const nextStart = h.automationCalls[i].timeAt!(h.automationCalls[i].from);
      expect(nextStart).toBeCloseTo(prevEnd, 3);
    }
  });

  it("the split window's end time uses the NEW tempo (seam-exact automation)", () => {
    let doc = twoTempoSong();
    const drum = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
    doc = {
      ...doc,
      automation: [
        {
          id: "auto-1",
          target: { kind: "trackGain", trackId: drum.id },
          points: [{ tick: 0, value: 0.5 }],
        },
      ],
    };
    const h = makeHarness(doc);
    h.transport.play(0);
    h.scheduler.start();
    // Stop driving INSIDE the split window: boundary tick B sounds at t=8;
    // drive until the window covering B has been scheduled (window end > B).
    let sawSplit = false;
    while (h.time < 18.6) {
      h.advance(0.025);
      const last = h.automationCalls.at(-1);
      if (last && last.to > B && last.from < B) sawSplit = true;
      if (sawSplit) break;
    }
    h.scheduler.stop();
    expect(sawSplit).toBe(true);
    const split = h.automationCalls.find((c) => c.to > B && c.from < B)!;
    const oldMapEnd = 10 + (split.to / (BPM_A * PPQ)) * 60; // old-tempo time of the window end
    const newMapEnd = 18 + ((split.to - B) / (BPM_B * PPQ)) * 60; // new tempo from the boundary
    const mappedEnd = split.timeAt!(split.to);
    // The map must follow the NEW tempo past the boundary. The old-tempo
    // value differs by the window's post-boundary width × (sptOld − sptNew)
    // — narrow window, so the expectation is scaled to that width.
    expect(Math.abs(mappedEnd - newMapEnd)).toBeLessThan(0.01);
    const slopeDelta = (split.to - B) * Math.abs(60 / (BPM_A * PPQ) - 60 / (BPM_B * PPQ));
    expect(Math.abs(mappedEnd - oldMapEnd)).toBeCloseTo(slopeDelta, 3);
  });
});
