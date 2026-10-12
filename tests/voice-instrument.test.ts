import { describe, expect, it } from "vitest";
import {
  encodeMonoWav16,
  medianVoiceRootPitch,
  prepareVoiceSample,
  trimAndNormalizeVoice,
  voiceInstrumentTrack,
  voiceInstrumentTrackCommand,
} from "../src/intent/voice-instrument";
import { composeFullTrack } from "../src/intent/compose";
import { testDoc } from "./fixtures/doc";
import type { NoteEvent } from "../src/project-model/types";

const RATE = 16000;

/** A take with silence at both edges and a 0.5 s tone in the middle. */
function takePcm(): Float32Array {
  const pcm = new Float32Array(RATE * 2);
  for (let index = 0; index < RATE * 0.5; index++) {
    pcm[RATE + index] = 0.4 * Math.sin((2 * Math.PI * 220 * index) / RATE);
  }
  return pcm;
}

function fakeTakeBuffer(pcm: Float32Array): AudioBuffer {
  return {
    sampleRate: RATE,
    length: pcm.length,
    numberOfChannels: 1,
    duration: pcm.length / RATE,
    getChannelData: (channel: number) => (channel === 0 ? pcm : new Float32Array(pcm.length)),
  } as unknown as AudioBuffer;
}

const HUM_NOTES: NoteEvent[] = [
  { id: "n1", pitch: 57, start: 0, duration: 240, velocity: 0.8 },
  { id: "n2", pitch: 57, start: 240, duration: 240, velocity: 0.8 },
  { id: "n3", pitch: 62, start: 480, duration: 240, velocity: 0.8 },
];

describe("trimAndNormalizeVoice", () => {
  it("trims silence, normalizes the peak and fades the edges", () => {
    const trimmed = trimAndNormalizeVoice(takePcm(), RATE);
    // The 1 s of leading silence is gone (some tolerance for the padding frame).
    expect(trimmed.length).toBeLessThan(RATE * 1.2);
    expect(trimmed.length).toBeGreaterThan(RATE * 0.3);
    let peak = 0;
    for (const value of trimmed) peak = Math.max(peak, Math.abs(value));
    expect(peak).toBeCloseTo(0.9, 1);
    // Fade-in: the very first sample is not the peak.
    expect(Math.abs(trimmed[0]!)).toBeLessThan(peak * 0.2);
  });

  it("all silence comes back unchanged, never a crash", () => {
    const quiet = new Float32Array(1000);
    expect(trimAndNormalizeVoice(quiet, RATE).length).toBe(1000);
  });
});

describe("encodeMonoWav16", () => {
  it("writes a parseable mono 16-bit RIFF header", () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1]);
    const blob = encodeMonoWav16(pcm, RATE);
    expect(blob.size).toBe(44 + pcm.length * 2);
  });
});

describe("medianVoiceRootPitch", () => {
  it("is the median of the hummed notes", () => {
    expect(medianVoiceRootPitch(HUM_NOTES)).toBe(57);
    expect(medianVoiceRootPitch([{ id: "a", pitch: 60, start: 0, duration: 1, velocity: 1 }])).toBe(60);
  });

  it("falls back to 60 and clamps extremes", () => {
    expect(medianVoiceRootPitch([])).toBe(60);
    expect(medianVoiceRootPitch([{ id: "a", pitch: 96, start: 0, duration: 1, velocity: 1 }])).toBe(84);
  });
});

describe("prepareVoiceSample", () => {
  it("builds the user-sample asset, wav blob and root pitch from the take", () => {
    const prepared = prepareVoiceSample(fakeTakeBuffer(takePcm()), "voice lead take", HUM_NOTES);
    expect(prepared.asset.id).toContain("voice-lead-take");
    expect(prepared.asset.category).toBe("Custom");
    expect(prepared.asset.channels).toBe(1);
    expect(prepared.asset.duration).toBeGreaterThan(0.3);
    expect(prepared.blob.size).toBe(44 + prepared.pcm.length * 2);
    expect(prepared.rootPitch).toBe(57);
    // The prepared PCM is the trimmed+normalized audio, not the raw take.
    expect(prepared.pcm.length).toBeLessThan(takePcm().length);
  });
});

describe("voiceInstrumentTrack + command", () => {
  it("is a sampler with a full-range layer rooted at the hum pitch", () => {
    const track = voiceInstrumentTrack(
      { trackId: "track-voice", sampleId: "user-voice", rootPitch: 57 },
      3,
      "layer-voice",
    );
    expect(track.instrument).toBe("sampler");
    expect(track.name).toBe("Voice Lead");
    expect(track.sampleId).toBe("user-voice");
    expect(track.velocityLayers).toHaveLength(1);
    expect(track.velocityLayers?.[0]).toMatchObject({ sampleId: "user-voice", min: 0, max: 1, root: 57 });
  });

  it("installs with one undo step", () => {
    const doc = testDoc();
    const track = voiceInstrumentTrack(
      { trackId: "track-voice", sampleId: "user-voice", rootPitch: 57 },
      doc.tracks.length,
      "layer-voice",
    );
    const command = voiceInstrumentTrackCommand(doc, track);
    const next = command.execute(doc);
    expect(next.tracks.some((candidate) => candidate.id === "track-voice")).toBe(true);
    expect(command.undo(doc)).toBe(doc);
  });
});

describe("SUNO MODE with a voice instrument", () => {
  it("hum notes play on the VOICE track, not the positional bass fallback", async () => {
    const doc = testDoc();
    const result = await composeFullTrack(doc, "house at 124", {
      loudness: false,
      candidateCount: 3,
      hum: {
        notes: [
          { id: "hum-c", pitch: 69, start: 0, duration: 240, velocity: 0.8 },
          { id: "hum-d", pitch: 71, start: 240, duration: 240, velocity: 0.8 },
        ],
        loopTicks: 7680,
        key: "C Major",
      },
      voice: { trackId: "track-voice-test", sampleId: "user-voice-test", rootPitch: 57 },
    });
    const leadSections = result.build.sections.filter((section) => section.roles.includes("lead"));
    expect(leadSections.length).toBeGreaterThan(0);
    for (const section of leadSections) {
      const voicedTracks = Object.keys(section.pattern.notes ?? {}).filter((trackId) =>
        Object.values(section.pattern.notes?.[trackId] ?? {})
          .flat()
          .some((note) => note.id.startsWith("hum-")),
      );
      expect(voicedTracks).toEqual(["track-voice-test"]);
    }
    // Install: the voice track joins the project with the sample wired.
    const before = doc;
    const installed = result.commands.song.execute(before);
    const voiceTrack = installed.tracks.find((candidate) => candidate.id === "track-voice-test");
    expect(voiceTrack).toBeDefined();
    expect(voiceTrack?.name).toBe("Voice Lead");
    if (voiceTrack && "sampleId" in voiceTrack) expect(voiceTrack.sampleId).toBe("user-voice-test");
    expect(result.commands.song.undo(before)).toBe(before);
  });

  it("without a voice instrument the legacy lead resolution still applies", async () => {
    const doc = testDoc();
    const result = await composeFullTrack(doc, "house at 124", {
      loudness: false,
      candidateCount: 3,
      hum: {
        notes: [{ id: "hum-x", pitch: 72, start: 0, duration: 240, velocity: 0.8 }],
        loopTicks: 7680,
        key: "C Major",
      },
    });
    const leadSections = result.build.sections.filter((section) => section.roles.includes("lead"));
    const owners = new Set<string>();
    for (const section of leadSections) {
      for (const [trackId, notes] of Object.entries(section.pattern.notes ?? {})) {
        if (notes.some((note) => note.id.startsWith("hum-x"))) owners.add(trackId);
      }
    }
    expect(owners.size).toBeGreaterThan(0);
    expect(owners.has("track-voice-test")).toBe(false);
  });
});
