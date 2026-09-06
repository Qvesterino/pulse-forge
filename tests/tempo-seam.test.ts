import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { setSceneBpm } from "../src/commands/commands";
import { buildTempoMap } from "../src/rendering/renderer";
import { Scheduler } from "../src/scheduler/Scheduler";
import { Transport } from "../src/transport/Transport";
import { BAR_TICKS, PPQ, STEP_TICKS } from "../src/project-model/types";
import type { DrumTrack, ProjectDocument } from "../src/project-model/types";

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
  const captured: { tick: number; velocity: number; padId?: string }[] = [];
  const tempoCalls: (number | null)[] = [];
  const scheduler = new Scheduler({
    getProject: () => doc,
    getTransport: () => transport,
    getAudioTime: () => audioTime,
    getMode: () => "song",
    trigger: (_trackId, _pad, when, velocity) => triggers.push({ when, velocity }),
    noteOn: () => {},
    applyAutomation: () => {},
    applyPatternLaunch: () => {},
    applySceneTempo: (bpm) => {
      tempoCalls.push(bpm);
      transport.setBpm(bpm ?? doc.bpm);
    },
    recordCapturedEvent: (event) => captured.push({ tick: event.tick, velocity: event.velocity, padId: event.padId }),
  });
  return {
    doc,
    transport,
    scheduler,
    triggers,
    captured,
    tempoCalls,
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
});
