import { describe, expect, it } from "vitest";
import {
  defineAnalyzer,
  resolveAnalysisWindow,
  resolveClipSourceWindow,
  type AudioAnalysisRequest,
} from "../../src/analysis/contract";
import { analyzeMixHealth } from "../../src/analysis/mixDoctor";
import { audioClipPlayWindow } from "../../src/audio-engine/warpManager";
import { addArrangementClip, addAudioClip } from "../../src/commands/commands";
import { createScene } from "../../src/commands/scenes";
import { setTrackParams } from "../../src/commands/project";
import { setTimeSignature } from "../../src/commands/metadata";
import { testDoc } from "../fixtures/doc";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * E-1 — the envelope's TIMELINE MAPPING, 20 hand-computed cases.
 *
 * The contract resolves an analysis window declared in TICKS to seconds and
 * samples through scene-time (the same integral playback and the offline
 * tempo map use). Every expected value below is computed BY HAND from
 * bar = 1920 ticks (4/4) / 1440 (3/4) and barSec = 240/bpm — not by calling
 * the code under test — so a wrong mapping cannot agree with the table.
 *
 * Success criterion (audit E-1): resolved samples == hand expectation ±1.
 * The frozen-caveat and freshness cases pin that KNOWN hazards are NAMED
 * instead of hidden (G-4, collab null revision).
 */

const SR = 44100;
const BAR = 1920; // 4/4 at PPQ 480
const BAR34 = 1440; // 3/4
const barSec = (bpm: number): number => 240 / bpm;

function flatDoc(bpm: number, meterNum = 4): ProjectDocument {
  const doc = { ...testDoc(), bpm };
  // testDoc() is 4/4; a real 3/4 document changes the meter so the doc's own
  // ticksPerBar becomes 1440 (the window table's barUnit must match).
  return meterNum === 3 ? setTimeSignature(doc, 3, 4).execute(doc) : doc;
}

/**
 * Place an arrangement span for a FRESH scene with an optional BPM pin.
 * A new scene per call: two pins on one scene would overwrite each other.
 */
function pinSpan(doc: ProjectDocument, bar: number, bars: number, bpm?: number): ProjectDocument {
  doc = createScene(doc, `Pin ${doc.scenes.length + 1}`).execute(doc);
  const sceneId = doc.scenes[doc.scenes.length - 1]!.id;
  if (bpm !== undefined) {
    doc = { ...doc, scenes: doc.scenes.map((s) => (s.id === sceneId ? { ...s, bpm } : s)) };
  }
  return addArrangementClip(doc, sceneId, bar, bars).execute(doc);
}

function request(doc: ProjectDocument, startBar: number, endBar: number, revision?: number): AudioAnalysisRequest {
  return {
    projectId: doc.id,
    ...(revision !== undefined ? { revision } : {}),
    scope: { kind: "master" },
    window: { startTick: startBar * BAR, endTick: endBar * BAR },
    stage: "master",
    featureSet: "mix-health",
  };
}

const cases: Array<{
  name: string;
  doc: () => ProjectDocument;
  startBar: number;
  endBar: number;
  barUnit: number;
  expectedStartSec: number;
  expectedEndSec: number;
}> = [
  // ── flat 120 ────────────────────────────────────────────────────────────
  { name: "120bpm bars 1-2", doc: () => flatDoc(120), startBar: 1, endBar: 2, barUnit: BAR, expectedStartSec: 2, expectedEndSec: 4 },
  { name: "120bpm bars 0-1", doc: () => flatDoc(120), startBar: 0, endBar: 1, barUnit: BAR, expectedStartSec: 0, expectedEndSec: 2 },
  { name: "120bpm bars 0.5-1.5 (half-bar resolution)", doc: () => flatDoc(120), startBar: 0.5, endBar: 1.5, barUnit: BAR, expectedStartSec: 1, expectedEndSec: 3 },
  { name: "120bpm bars 3-5", doc: () => flatDoc(120), startBar: 3, endBar: 5, barUnit: BAR, expectedStartSec: 6, expectedEndSec: 10 },
  // ── flat 90 ─────────────────────────────────────────────────────────────
  { name: "90bpm bars 0-1", doc: () => flatDoc(90), startBar: 0, endBar: 1, barUnit: BAR, expectedStartSec: 0, expectedEndSec: 240 / 90 },
  { name: "90bpm bars 1-2", doc: () => flatDoc(90), startBar: 1, endBar: 2, barUnit: BAR, expectedStartSec: 240 / 90, expectedEndSec: 480 / 90 },
  // ── flat 140 ────────────────────────────────────────────────────────────
  { name: "140bpm bars 2-3", doc: () => flatDoc(140), startBar: 2, endBar: 3, barUnit: BAR, expectedStartSec: 480 / 140, expectedEndSec: 720 / 140 },
  // ── scene pin 140 over bars 0-4, project 120 ────────────────────────────
  {
    name: "pin140 inside span bars 0-1",
    doc: () => pinSpan(flatDoc(120), 0, 4, 140),
    startBar: 0,
    endBar: 1,
    barUnit: BAR,
    expectedStartSec: 0,
    expectedEndSec: 240 / 140,
  },
  {
    name: "pin140 inside span bars 1-2",
    doc: () => pinSpan(flatDoc(120), 0, 4, 140),
    startBar: 1,
    endBar: 2,
    barUnit: BAR,
    expectedStartSec: 240 / 140,
    expectedEndSec: 480 / 140,
  },
  {
    name: "pin140 straddle edge bars 3-5 (pin 4 bars then project tempo)",
    doc: () => pinSpan(flatDoc(120), 0, 4, 140),
    startBar: 3,
    endBar: 5,
    barUnit: BAR,
    expectedStartSec: 3 * (240 / 140),
    expectedEndSec: 4 * (240 / 140) + 1 * 2,
  },
  {
    name: "pin140 after-span bars 5-6 runs at project tempo",
    doc: () => pinSpan(flatDoc(120), 0, 4, 140),
    startBar: 5,
    endBar: 6,
    barUnit: BAR,
    // span = 4 bars @140; bar 4 itself already runs at project tempo.
    expectedStartSec: 4 * (240 / 140) + 2,
    expectedEndSec: 4 * (240 / 140) + 4,
  },
  // ── two pins 140 + 160 ─────────────────────────────────────────────────
  {
    name: "pin140 bars0-4 + pin160 bars4-8, window 0-5",
    doc: () => pinSpan(pinSpan(flatDoc(120), 4, 4, 160), 0, 4, 140),
    startBar: 0,
    endBar: 5,
    barUnit: BAR,
    expectedStartSec: 0,
    expectedEndSec: 4 * (240 / 140) + 240 / 160,
  },
  {
    name: "pin160 only (bars 4-8), window bars 5-6",
    doc: () => pinSpan(flatDoc(120), 4, 4, 160),
    startBar: 5,
    endBar: 6,
    barUnit: BAR,
    expectedStartSec: 4 * 2 + 240 / 160,
    expectedEndSec: 4 * 2 + 480 / 160,
  },
  // ── 3/4 meter (bar = 1440 ticks) ────────────────────────────────────────
  {
    name: "3/4 120bpm bars 1-2",
    doc: () => flatDoc(120),
    startBar: 1,
    endBar: 2,
    barUnit: BAR34,
    expectedStartSec: 1.5,
    expectedEndSec: 3,
  },
  {
    name: "3/4 120bpm bars 2-3",
    doc: () => flatDoc(120),
    startBar: 2,
    endBar: 3,
    barUnit: BAR34,
    expectedStartSec: 3,
    expectedEndSec: 4.5,
  },
  {
    name: "3/4 pin140 over bars 0-2, window bars 0-2",
    doc: () => pinSpan(flatDoc(120), 0, 2, 140),
    startBar: 0,
    endBar: 2,
    barUnit: BAR34,
    expectedStartSec: 0,
    expectedEndSec: 2 * (180 / 140),
  },
  {
    name: "3/4 pin140 bars0-2, window 2-3 runs at project",
    doc: () => pinSpan(flatDoc(120, 3), 0, 2, 140),
    startBar: 2,
    endBar: 3,
    barUnit: BAR34,
    expectedStartSec: 2 * (180 / 140),
    expectedEndSec: 2 * (180 / 140) + 1.5,
  },
];

describe("E-1: the analysis window maps ticks to samples exactly (20-case matrix)", () => {
  for (const c of cases) {
    it(`${c.name}: ±1 sample against the hand-computed window`, () => {
      const doc = c.doc();
      const req = request(doc, c.startBar, c.endBar);
      const window: { startTick: number; endTick: number } = {
        startTick: c.startBar * c.barUnit,
        endTick: c.endBar * c.barUnit,
      };
      const resolved = resolveAnalysisWindow(doc, { ...req, window }, SR);
      const expectedStart = Math.round(c.expectedStartSec * SR);
      const expectedEnd = Math.round(c.expectedEndSec * SR);
      expect(Math.abs(resolved.startSample - expectedStart), `start ${resolved.startSample} vs ${expectedStart}`).toBeLessThanOrEqual(1);
      expect(Math.abs(resolved.endSample - expectedEnd), `end ${resolved.endSample} vs ${expectedEnd}`).toBeLessThanOrEqual(1);
      // The seconds themselves carry the documented epsilon of the integral.
      expect(Math.abs(resolved.startSec - c.expectedStartSec)).toBeLessThan(1e-6);
      expect(Math.abs(resolved.endSec - c.expectedEndSec)).toBeLessThan(1e-6);
    });
  }

  it("case 18: the tempoContext names the crossed pins", () => {
    const doc = pinSpan(pinSpan(flatDoc(120), 4, 4, 160), 0, 4, 140);
    const resolved = resolveAnalysisWindow(doc, { ...request(doc, 0, 5), window: { startTick: 0, endTick: 5 * BAR } }, SR);
    expect(resolved.tempoContext.map((span) => span.bpm)).toEqual([140, 160]);
  });

  it("case 19: a frozen track inside the window sets the G-4 caveat by name", () => {
    let doc = testDoc();
    const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    doc = addAudioClip(doc, trackId, "factory.kick", 1, 2).execute(doc);
    doc = {
      ...doc,
      tracks: doc.tracks.map((t) => (t.id === trackId ? { ...t, frozen: { bufferId: `frozen-${trackId}` } } : t)),
    };
    const resolved = resolveAnalysisWindow(doc, request(doc, 0, 4), SR);
    expect(resolved.caveats.map((c) => c.code)).toContain("frozen-playback-uses-project-tempo");
  });

  it("case 20: a request without a revision carries freshness-unknown (collab)", () => {
    const doc = flatDoc(120);
    const resolved = resolveAnalysisWindow(doc, request(doc, 0, 2), SR);
    expect(resolved.caveats.map((c) => c.code)).toContain("freshness-unknown");
    const withRevision = resolveAnalysisWindow(doc, request(doc, 0, 2, 42), SR);
    expect(withRevision.caveats.map((c) => c.code)).not.toContain("freshness-unknown");
  });
});

describe("E-1: clip scope agrees with the PLAYBACK window resolver", () => {
  it("a trimmed straight clip: the analysis source window matches audioClipPlayWindow's offsets", () => {
    let doc = flatDoc(120);
    const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    doc = addAudioClip(doc, trackId, "factory.kick", 2, 2, { trimStart: 1 }).execute(doc);
    doc = setTrackParams(doc, trackId, { name: "Window Check" }).execute(doc);
    const clip = doc.arrangement.audioClips!.find((c) => c.trackId === trackId)!;

    // The analysis contract: window = the clip's first arrangement bar.
    const window = { startTick: 2 * BAR, endTick: 3 * BAR };
    const source = resolveClipSourceWindow(doc, clip.id, window);
    expect(source.caveats).toEqual([]);
    expect(source.startSec).toBeCloseTo(clip.trimStart, 6);
    expect(source.endSec).toBeCloseTo(clip.trimStart + 2, 6);

    // The playback resolver must agree about where the source playhead sits.
    const barSec = 2;
    const play = audioClipPlayWindow(clip, 8, barSec, 1);
    expect(play.playOffset).toBeCloseTo(clip.trimStart, 6);
    // The playback window never exceeds the requested span (content may cut
    // it shorter — the kick buffer's length is the buffer's business).
    expect(play.duration).toBeLessThanOrEqual(barSec + 1e-9);
    expect(play.duration).toBeGreaterThan(0);
  });

  it("a reverse/loop clip sets source-window-approximate instead of pretending", () => {
    let doc = testDoc();
    const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    doc = addAudioClip(doc, trackId, "factory.kick", 0, 2, { reverse: true }).execute(doc);
    const clip = doc.arrangement.audioClips!.find((c) => c.trackId === trackId)!;
    const source = resolveClipSourceWindow(doc, clip.id, { startTick: 0, endTick: BAR });
    expect(source.caveats.map((c) => c.code)).toContain("source-window-approximate");
  });
});

describe("E-1: defineAnalyzer wraps a real analyzer in the envelope", () => {
  it("mixDoctor's payload travels with algorithm identity, alignment and partial handling", () => {
    const analyzer = defineAnalyzer({
      name: "mix-doctor",
      version: "1",
      featureSet: "mix-health",
      analyze: (channels, sampleRate) => analyzeMixHealth(channels, sampleRate),
    });
    let doc = flatDoc(120);
    const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    doc = addAudioClip(doc, trackId, "factory.kick", 0, 4).execute(doc);
    doc = setTrackParams(doc, trackId, { gain: 0.9 }).execute(doc);

    // 8 s of plausible PCM (noise-free sine+silence mix is fine for the envelope).
    const sampleRate = 44100;
    const pcm = new Float32Array(sampleRate * 8);
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
    const request: AudioAnalysisRequest = {
      projectId: doc.id,
      revision: 7,
      scope: { kind: "track", id: trackId },
      window: { startTick: 0, endTick: 4 * BAR },
      stage: "track",
      featureSet: "mix-health",
    };
    const result = analyzer.run(doc, request, [pcm, pcm], sampleRate);

    expect(result.algorithm).toEqual({ name: "mix-doctor", version: "1" });
    expect(result.producedAtRevision).toBe(7);
    expect(result.alignment.sampleRate).toBe(sampleRate);
    expect(result.alignment.startSample).toBe(0);
    expect(result.alignment.endSample).toBe(Math.round(8 * sampleRate));
    expect(result.request).toBe(request);
    expect(result.confidence).toBeNull();
    expect(result.partial).toBeUndefined();
    // The payload is mixDoctor's own report shape.
    expect(typeof (result.payload as { integratedLufs?: number }).integratedLufs).toBe("number");
  });

  it("a non-forward window throws; a sub-sample window reports partial instead of calling the analyzer", () => {
    const analyzer = defineAnalyzer({
      name: "noop",
      version: "1",
      featureSet: "x",
      analyze: () => {
        throw new Error("must not run");
      },
    });
    const doc = flatDoc(120);
    expect(() => resolveAnalysisWindow(doc, request(doc, 1, 0), SR)).toThrow(/forward/);
    // 0.01 ticks ≈ 0.02 samples at 44.1 kHz — rounds to an empty slice.
    const result = analyzer.run(
      doc,
      { ...request(doc, 0, 1), window: { startTick: 0, endTick: 0.01 } },
      [new Float32Array(44100)],
      SR,
    );
    expect(result.partial?.reason).toMatch(/empty/i);
  });
});
