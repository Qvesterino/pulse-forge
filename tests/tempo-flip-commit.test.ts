import { describe, expect, it, vi, afterEach } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { setSceneBpm } from "../src/commands/commands";
import { Scheduler } from "../src/scheduler/Scheduler";
import { Transport } from "../src/transport/Transport";
import { BAR_TICKS } from "../src/project-model/types";
import type { DrumTrack, ProjectDocument } from "../src/project-model/types";

/**
 * Fast tempo-flip committer (package 1+2, part B): a scheduled scene-tempo
 * flip used to commit on the 25 ms tick after the playhead crossed the
 * boundary, holding tempo-synced runtimes (SYNC delays, LFO syncs) on the old
 * tempo for up to a tick. A dedicated 5 ms loop — armed only while a flip is
 * pending — now commits at the boundary instant; the 25 ms tick stays as the
 * fallback and the commit itself is idempotent.
 */

const BPM_A = 120;
const BPM_B = 240;
const B = 4 * BAR_TICKS; // boundary: bar 4

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
  const drum = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
  const padId = drum.pads[0].id;
  const fill = (p: ProjectDocument, patternId: string) => ({
    ...p,
    patterns: p.patterns.map((pat) =>
      pat.id === patternId ? { ...pat, rows: { [padId]: new Array(pat.stepCount).fill(0.8) }, stepMeta: {} } : pat,
    ),
  });
  doc = fill(doc, doc.patterns[0].id);
  return fill(doc, patternB.id);
}

function makeHarness(doc: ProjectDocument) {
  let audioTime = 10;
  const transport = new Transport({ now: () => audioTime }, doc.bpm);
  const engineTempoCalls: number[] = [];
  const scheduler = new Scheduler({
    getProject: () => doc,
    getTransport: () => transport,
    getAudioTime: () => audioTime,
    getMode: () => "song",
    trigger: () => {},
    noteOn: () => {},
    applyAutomation: () => {},
    applyPatternLaunch: () => {},
    applySceneTempo: (bpm) => transport.setBpm(bpm ?? doc.bpm),
    applyEngineTempo: (bpm) => engineTempoCalls.push(bpm),
    recordCapturedEvent: () => {},
  });
  return {
    transport,
    scheduler,
    engineTempoCalls,
    setTime: (seconds: number) => {
      audioTime = seconds;
    },
    tick: () => scheduler["tick"](),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("fast tempo-flip committer", () => {
  it("commits at the boundary instant without waiting for the 25 ms tick", () => {
    vi.useFakeTimers();
    const h = makeHarness(twoTempoSong());
    try {
      h.transport.play(0);
      h.scheduler.start();
      // Manual windows up to just before the boundary — the flip gets armed
      // (lookahead covers it) but the playhead has not crossed yet.
      let t = 10;
      while (h.transport.position < B - 100 && t < 17.9) {
        t += 0.05;
        h.setTime(t);
        h.tick();
      }
      expect(h.engineTempoCalls).toHaveLength(0);
      // Cross the boundary with NO further manual tick. Advancing fake time
      // by 6 ms fires only the 5 ms committer — the 25 ms main tick would
      // need 25 ms. The flip must already be committed.
      h.setTime(10 + (B + 10) * (60 / (BPM_A * 480)));
      vi.advanceTimersByTime(6);
      expect(h.transport.bpm).toBe(BPM_B);
      expect(h.engineTempoCalls).toEqual([BPM_B]);
      expect(h.scheduler.stats.flipFastCommits).toBe(1);
      // A later tick must not double-commit.
      h.tick();
      expect(h.engineTempoCalls).toEqual([BPM_B]);
      expect(h.scheduler.stats.flipFastCommits).toBe(1);
    } finally {
      h.scheduler.stop();
    }
  });

  it("a stopped scheduler never commits a pending flip", () => {
    vi.useFakeTimers();
    const h = makeHarness(twoTempoSong());
    h.transport.play(0);
    h.scheduler.start();
    let t = 10;
    while (h.transport.position < B - 100 && t < 17.9) {
      t += 0.05;
      h.setTime(t);
      h.tick();
    }
    h.scheduler.stop();
    // Cross the boundary after the stop — the disarmed loop stays silent.
    h.setTime(10 + (B + 10) * (60 / (BPM_A * 480)));
    vi.advanceTimersByTime(100);
    expect(h.engineTempoCalls).toHaveLength(0);
    expect(h.transport.bpm).not.toBe(BPM_B);
  });
});
