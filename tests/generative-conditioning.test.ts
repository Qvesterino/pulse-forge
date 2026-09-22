import { describe, expect, it } from "vitest";
import { createGenerativeTrack, setGenerativeTrackConfig } from "../src/commands/commands";
import { buildGenerativeInput, resolveGenerativeMacrosAtTick } from "../src/generative/conditioning";
import { createDefaultProject } from "../src/project-model/schema";
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
});
