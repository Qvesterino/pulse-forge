import { describe, expect, it } from "vitest";
import { createGenerativeTrack, setGenerativeTrackConfig } from "../src/commands/commands";
import { buildGenerativeInput, resolveGenerativeMacrosAtTick } from "../src/generative/conditioning";
import { createDefaultProject } from "../src/project-model/schema";
import { BAR_TICKS } from "../src/project-model/types";
import { GENERATIVE_FRAME_RATE_HZ } from "../src/generative/types";

describe("generative conditioning", () => {
  it("maps KYX notes to provider frame pitch states without touching the engine", () => {
    const base = createDefaultProject();
    const instrument = base.tracks.find((track) => track.kind === "instrument");
    if (!instrument) throw new Error("instrument fixture missing");
    const withTrack = createGenerativeTrack(base).execute(base);
    const generative = withTrack.tracks.find((track) => track.kind === "generative");
    if (!generative || generative.kind !== "generative") throw new Error("generative fixture missing");
    const configured = setGenerativeTrackConfig(withTrack, generative.id, {
      chordSourceTrackId: instrument.id,
      style: { kind: "text", text: "dark pads" },
    }).execute(withTrack);
    const configuredTrack = configured.tracks.find((track) => track.id === generative.id);
    if (!configuredTrack || configuredTrack.kind !== "generative") throw new Error("configured track missing");
    const pattern = configured.patterns.find((candidate) => candidate.id === configured.activePatternId);
    if (!pattern) throw new Error("pattern fixture missing");
    const notes = [
      { id: "onset", pitch: 60, start: 0, duration: 240, velocity: 0.8 },
      { id: "sustain", pitch: 64, start: 48, duration: 480, velocity: 0.7 },
    ];
    const withNotes = {
      ...configured,
      patterns: configured.patterns.map((candidate) =>
        candidate.id === pattern.id
          ? { ...candidate, notes: { ...candidate.notes, [instrument.id]: notes } }
          : candidate,
      ),
    };

    const input = buildGenerativeInput(withNotes, configuredTrack, 0, 192);

    expect(input.frameRateHz).toBe(GENERATIVE_FRAME_RATE_HZ);
    expect(input.noteFrames.length).toBe(5);
    expect(input.noteFrames[0]?.pitchState[60]).toBe(2);
    expect(input.noteFrames[0]?.pitchState[64]).toBe(0);
    expect(input.noteFrames[1]?.pitchState[60]).toBe(1);
    expect(input.noteFrames[1]?.pitchState[64]).toBe(2);
  });

  it("requires a resolver for audio style references", () => {
    const base = createDefaultProject();
    const withTrack = createGenerativeTrack(base).execute(base);
    const generative = withTrack.tracks.find((track) => track.kind === "generative");
    if (!generative || generative.kind !== "generative") throw new Error("generative fixture missing");
    const configured = setGenerativeTrackConfig(withTrack, generative.id, {
      style: { kind: "audio", bufferId: "generated-style" },
    }).execute(withTrack);
    const current = configured.tracks.find((track) => track.id === generative.id);
    if (!current || current.kind !== "generative") throw new Error("configured track missing");

    expect(() => buildGenerativeInput(configured, current, 0, 480)).toThrow("generated-style");
    expect(
      buildGenerativeInput(configured, current, 0, 480, {
        resolveAudioStyle: () => ({ kind: "audio", sampleRate: 16000, channels: [new Float32Array(16)] }),
      }).style.kind,
    ).toBe("audio");
  });

  it("samples persisted macro lanes and active scene intensity before provider conditioning", () => {
    const base = createDefaultProject();
    const created = createGenerativeTrack(base).execute(base);
    const track = created.tracks.find((candidate) => candidate.kind === "generative");
    const scene = created.scenes[0];
    if (!track || track.kind !== "generative" || !scene) throw new Error("conditioning fixture missing");
    const configured = setGenerativeTrackConfig(created, track.id, {
      macros: { energy: 1 },
      automation: [{ id: "energy-lane", macro: "energy", points: [{ tick: 0, value: 0.4 }] }],
    }).execute(created);
    const configuredTrack = configured.tracks.find((candidate) => candidate.id === track.id);
    if (!configuredTrack || configuredTrack.kind !== "generative") throw new Error("configured track missing");
    const withScene = {
      ...configured,
      scenes: configured.scenes.map((candidate) =>
        candidate.id === scene.id ? { ...candidate, intensity: 1 } : candidate,
      ),
    };

    const macros = resolveGenerativeMacrosAtTick(withScene, configuredTrack, 0);

    expect(macros.energy).toBeCloseTo(0.4);
    expect(macros.density).toBeCloseTo(configuredTrack.generative.macros.density);
    expect(buildGenerativeInput(withScene, configuredTrack, 0, 192, { macros }).macros).toEqual(macros);
  });

  it("emits onset, sustain and release states, including overlapping note onsets", () => {
    const base = createDefaultProject();
    const instrument = base.tracks.find((track) => track.kind === "instrument");
    if (!instrument) throw new Error("instrument fixture missing");
    const withTrack = createGenerativeTrack(base).execute(base);
    const generative = withTrack.tracks.find((track) => track.kind === "generative");
    if (!generative || generative.kind !== "generative") throw new Error("generative fixture missing");
    const configured = setGenerativeTrackConfig(withTrack, generative.id, {
      chordSourceTrackId: instrument.id,
    }).execute(withTrack);
    const pattern = configured.patterns.find((candidate) => candidate.id === configured.activePatternId);
    if (!pattern) throw new Error("pattern fixture missing");
    const withNotes = {
      ...configured,
      patterns: configured.patterns.map((candidate) =>
        candidate.id === pattern.id
          ? {
              ...candidate,
              notes: {
                ...candidate.notes,
                [instrument.id]: [
                  { id: "long", pitch: 60, start: 0, duration: 120, velocity: 0.8 },
                  { id: "overlap", pitch: 60, start: 48, duration: 240, velocity: 0.8 },
                ],
              },
            }
          : candidate,
      ),
    };
    const track = withNotes.tracks.find((candidate) => candidate.id === generative.id);
    if (!track || track.kind !== "generative") throw new Error("configured track missing");
    const frames = buildGenerativeInput(withNotes, track, 0, 480).noteFrames;
    expect(frames[0]?.pitchState[60]).toBe(2);
    expect(frames.some((frame) => frame.pitchState[60] === 1)).toBe(true);
    expect(frames.at(-1)?.pitchState[60]).toBe(0);
  });

  it("wraps note conditioning at pattern loops and uses effective transport BPM", () => {
    const base = createDefaultProject();
    const instrument = base.tracks.find((track) => track.kind === "instrument");
    if (!instrument) throw new Error("instrument fixture missing");
    const withTrack = createGenerativeTrack(base).execute(base);
    const generative = withTrack.tracks.find((track) => track.kind === "generative");
    if (!generative || generative.kind !== "generative") throw new Error("generative fixture missing");
    const configured = setGenerativeTrackConfig(withTrack, generative.id, {
      chordSourceTrackId: instrument.id,
    }).execute(withTrack);
    const pattern = configured.patterns.find((candidate) => candidate.id === configured.activePatternId);
    if (!pattern) throw new Error("pattern fixture missing");
    const withNotes = {
      ...configured,
      patterns: configured.patterns.map((candidate) =>
        candidate.id === pattern.id
          ? {
              ...candidate,
              notes: {
                ...candidate.notes,
                [instrument.id]: [{ id: "loop", pitch: 67, start: 0, duration: 120, velocity: 0.8 }],
              },
            }
          : candidate,
      ),
    };
    const track = withNotes.tracks.find((candidate) => candidate.id === generative.id);
    if (!track || track.kind !== "generative") throw new Error("configured track missing");
    const looped = buildGenerativeInput(withNotes, track, 16 * 120, 120);
    expect(looped.noteFrames[0]?.pitchState[67]).toBe(2);
    const slower = buildGenerativeInput(withNotes, track, 0, 480, { bpm: 60 });
    expect(slower.bpm).toBe(60);
    expect(slower.noteFrames.length).toBe(25);
  });

  it("keeps drums/808 notes out of chord conditioning when drums are off", () => {
    const base = createDefaultProject();
    const instrument = base.tracks.find((track) => track.kind === "instrument");
    const drums = base.tracks.find((track) => track.kind === "drum");
    if (!instrument || !drums) throw new Error("source track fixture missing");
    const withTrack = createGenerativeTrack(base).execute(base);
    const generative = withTrack.tracks.find((track) => track.kind === "generative");
    if (!generative || generative.kind !== "generative") throw new Error("generative fixture missing");
    const configured = setGenerativeTrackConfig(withTrack, generative.id, {
      noteSourceTrackId: instrument.id,
      drumsMode: "off",
    }).execute(withTrack);
    const pattern = configured.patterns.find((candidate) => candidate.id === configured.activePatternId);
    if (!pattern) throw new Error("pattern fixture missing");
    const withNotes = {
      ...configured,
      patterns: configured.patterns.map((candidate) =>
        candidate.id === pattern.id
          ? {
              ...candidate,
              notes: {
                ...candidate.notes,
                [instrument.id]: [{ id: "chord", pitch: 60, start: 0, duration: 120, velocity: 1 }],
                [drums.id]: [{ id: "kick", pitch: 36, start: 0, duration: 120, velocity: 1 }],
              },
            }
          : candidate,
      ),
    };
    const track = withNotes.tracks.find((candidate) => candidate.id === generative.id);
    if (!track || track.kind !== "generative") throw new Error("configured track missing");
    const frames = buildGenerativeInput(withNotes, track, 0, 120).noteFrames;
    expect(frames[0]?.pitchState[60]).toBe(2);
    expect(frames[0]?.pitchState[36]).toBe(0);
  });

  it("keeps macro automation continuous at a section boundary", () => {
    const base = createDefaultProject();
    const created = createGenerativeTrack(base).execute(base);
    const track = created.tracks.find((candidate) => candidate.kind === "generative");
    if (!track || track.kind !== "generative") throw new Error("generative fixture missing");
    const configured = setGenerativeTrackConfig(created, track.id, {
      automation: [
        {
          id: "energy-boundary",
          macro: "energy",
          points: [
            { tick: 0, value: 0.2 },
            { tick: BAR_TICKS, value: 0.8 },
          ],
        },
      ],
    }).execute(created);
    const withoutSceneIntensity = { ...configured, scenes: [] };
    const current = withoutSceneIntensity.tracks.find((candidate) => candidate.id === track.id);
    if (!current || current.kind !== "generative") throw new Error("configured track missing");
    const before = resolveGenerativeMacrosAtTick(withoutSceneIntensity, current, BAR_TICKS - 1);
    const atBoundary = resolveGenerativeMacrosAtTick(withoutSceneIntensity, current, BAR_TICKS);
    expect(before.energy).toBeGreaterThan(0.2);
    expect(before.energy).toBeLessThan(0.8);
    expect(atBoundary.energy).toBeCloseTo(0.8);
    expect(atBoundary.energy).toBeGreaterThan(before.energy);
  });
});
