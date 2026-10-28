import { describe, expect, it } from "vitest";
import { buildTransferProject, inspectTransferFiles, midiImportWarnings } from "../src/export/transfer-import";
import { parseMidiFile, writeMidiFile } from "../src/midi/midiFile";
import { MAX_ARRANGEMENT_CLIP_TICKS } from "../src/project-model/schema";
import { BAR_TICKS } from "../src/project-model/types";

type MidiFixtureOptions = Omit<Parameters<typeof writeMidiFile>[0], "tracks"> & {
  tracks?: Parameters<typeof writeMidiFile>[0]["tracks"];
};

function midiBytes(options: MidiFixtureOptions = {}): Uint8Array {
  return writeMidiFile({
    bpm: 120,
    timeSignature: { num: 4, den: 4 },
    ...options,
    tracks: options.tracks ?? [
      { name: "Drums", channel: 9, notes: [{ pitch: 36, startTick: 0, endTick: 120, velocity: 0.9 }] },
      { name: "Sub Bass", channel: 0, notes: [{ pitch: 36, startTick: 0, endTick: 480, velocity: 0.8 }] },
      { name: "Lead", channel: 1, notes: [{ pitch: 72, startTick: 480, endTick: 960, velocity: 0.7 }] },
    ],
  });
}

function fileFromMidi(name: string, bytes: Uint8Array): File {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new File([copy.buffer], name, { type: "audio/midi" });
}

describe("DAW transfer import", () => {
  it("preflights a multi-file audio and MIDI selection and discloses its alignment contract", async () => {
    const midi = fileFromMidi("Song.mid", midiBytes());
    const audioA = new File([new Uint8Array([1, 2, 3])], "Kick Stem.wav", { type: "audio/wav" });
    const audioB = new File([new Uint8Array([4, 5, 6])], "Reference Mix.wav", { type: "audio/wav" });

    const result = await inspectTransferFiles([audioA, midi, audioB]);

    expect(result.errors).toEqual([]);
    expect(result.audioFiles.map((file) => file.name)).toEqual(["Kick Stem.wav", "Reference Mix.wav"]);
    expect(result.totalAudioBytes).toBe(6);
    expect(result.midiFile?.name).toBe("Song.mid");
    expect(result.parsedMidi?.tracks.map((track) => track.name)).toEqual(["Drums", "Sub Bass", "Lead"]);
    expect(result.warnings.some((warning) => warning.includes("same song start"))).toBe(true);
  });

  it("warns when a multi-stem selection crosses the encoded-audio memory caution point", async () => {
    const audioFiles = Array.from({ length: 5 }, (_, index) => {
      const file = new File([new Uint8Array([index])], `Stem ${index + 1}.wav`, { type: "audio/wav" });
      Object.defineProperty(file, "size", { configurable: true, value: 20 * 1024 * 1024 + 1 });
      return file;
    });

    const result = await inspectTransferFiles(audioFiles);

    expect(result.errors).toEqual([]);
    expect(result.totalAudioBytes).toBe(5 * (20 * 1024 * 1024 + 1));
    expect(result.warnings.join(" ")).toContain("Decoded PCM can use considerably more memory");
  });

  it("creates aligned, named audio lanes and editable MIDI/drum arrangement clips", () => {
    const bytes = midiBytes();
    const parsed = parseMidiFile(bytes);
    const result = buildTransferProject({
      projectName: "My Session Transfer",
      sourceDaw: "fl-studio",
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      audioAssets: [
        { fileName: "Kick Stem.wav", assetId: "user.kick", durationSec: 7.2 },
        { fileName: "Reference Mix.wav", assetId: "user.ref", durationSec: 8, referenceMix: true },
      ],
      midiFileName: "Song.mid",
      midiBytes: bytes,
      parsedMidi: parsed,
    });

    expect(result.doc.name).toBe("My Session Transfer");
    expect(result.doc.transferOrigin).toEqual({ version: 1, kind: "aligned-audio-midi", sourceDaw: "fl-studio" });
    expect(result.doc.bpm).toBe(120);
    expect(result.doc.timeSignature).toEqual({ numerator: 4, denominator: 4 });
    expect(result.audioTrackNames).toEqual(["Kick Stem", "Reference Mix"]);
    expect(result.doc.arrangement.audioClips).toHaveLength(2);
    expect(result.doc.arrangement.audioClips?.every((clip) => clip.startBar === 0)).toBe(true);
    expect(result.doc.arrangement.audioClips?.[0]?.lengthBars).toBe(4);
    expect(result.doc.tracks.find((track) => track.name === "Reference Mix")?.mute).toBe(true);
    expect(result.midiTrackNames).toContain("Sub Bass");
    expect(result.midiTrackNames).toContain("Lead");
    expect(result.doc.arrangement.midiClips).toHaveLength(2);
    expect(result.doc.arrangement.midiClips?.every((clip) => clip.startTick === 0)).toBe(true);
    expect(result.doc.arrangement.clips).toHaveLength(1);
    expect(result.doc.arrangement.clips[0]?.lengthBars).toBe(1);
  });

  it("imports CC7/10/11 as editable automation and applies sustain to MIDI note timing", async () => {
    const bytes = midiBytes({
      tempoChanges: [
        { tick: 0, bpm: 120 },
        { tick: 480, bpm: 60 },
      ],
      tracks: [
        {
          name: "Expressive Lead",
          channel: 0,
          notes: [{ pitch: 60, startTick: 0, endTick: 480, velocity: 0.8, releaseVelocity: 0.7 }],
          controllers: [
            { tick: 0, controller: 64, value: 127 },
            { tick: 0, controller: 7, value: 127 },
            { tick: 0, controller: 10, value: 64 },
            { tick: 480, controller: 7, value: 64 },
            { tick: 960, controller: 11, value: 64 },
            { tick: 1920, controller: 64, value: 0 },
          ],
        },
      ],
    });
    const result = buildTransferProject({
      projectName: "Controller Transfer",
      sourceDaw: "cubase",
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      audioAssets: [],
      midiBytes: bytes,
      parsedMidi: parseMidiFile(bytes),
    });
    const inspection = await inspectTransferFiles([fileFromMidi("Controller Transfer.mid", bytes)]);
    const track = result.doc.tracks.find((candidate) => candidate.name === "Expressive Lead");
    const pattern = result.doc.patterns.find((candidate) => candidate.id === result.doc.activePatternId);
    const note = track && pattern?.notes[track.id]?.[0];
    const clips = result.doc.arrangement.automationClips?.filter((clip) => clip.target.trackId === track?.id) ?? [];
    const volume = clips.find((clip) => clip.target.kind === "trackGain");
    const pan = clips.find((clip) => clip.target.kind === "trackPan");

    expect(note).toMatchObject({ duration: 3360, expression: { releaseVelocity: 0.7 } });
    expect(volume?.points.map((point) => point.tick)).toEqual([0, 480, 1440]);
    expect(volume?.points[0]?.value).toBeCloseTo(1);
    expect(volume?.points[1]?.value).toBeCloseTo(64 / 127);
    expect(volume?.points[2]?.value).toBeCloseTo((64 / 127) ** 2);
    expect(pan?.points.map((point) => point.tick)).toEqual([0]);
    expect(pan?.points[0]?.value).toBe(0);
    expect(result.warnings.join(" ")).toContain(
      "CC7 volume and CC11 expression become combined track-volume automation",
    );
    expect(result.warnings.join(" ")).toContain("CC64 sustain extends note lengths");
    expect(inspection.warnings.join(" ")).toContain(
      "CC7 volume and CC11 expression become combined track-volume automation",
    );
    expect(inspection.warnings.join(" ")).toContain("CC64 sustain extends note lengths");
  });

  it("creates an editable automation lane for a MIDI track with controllers and no notes", () => {
    const bytes = midiBytes({
      tracks: [
        { name: "Automation Only", channel: 0, notes: [], controllers: [{ tick: 240, controller: 10, value: 127 }] },
      ],
    });
    const result = buildTransferProject({
      projectName: "Automation Only Transfer",
      sourceDaw: "other",
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      audioAssets: [],
      midiBytes: bytes,
      parsedMidi: parseMidiFile(bytes),
    });
    const track = result.doc.tracks.find((candidate) => candidate.name === "Automation Only");
    const clip = result.doc.arrangement.automationClips?.find(
      (candidate) => candidate.target.kind === "trackPan" && candidate.target.trackId === track?.id,
    );

    expect(track?.kind).toBe("instrument");
    expect(result.midiTrackNames).toContain("Automation Only");
    expect(result.doc.arrangement.midiClips ?? []).toHaveLength(0);
    // F-07: an imported point carries its minted identity, so the lane can be
    // edited by point and not by slot.
    expect(clip?.points.at(-1)).toEqual({ id: expect.any(String), tick: 240, value: 1 });
  });

  it("keeps a larger song handoff's track mapping intact", () => {
    const tracks = Array.from({ length: 4 }, (_, index) => ({
      name: `Instrument ${index + 1}`,
      channel: index,
      notes: [{ pitch: 60 + index, startTick: 0, endTick: 960, velocity: 0.75 }],
    }));
    const bytes = midiBytes({ bpm: 100, timeSignature: { num: 7, den: 8 }, tracks });
    const parsed = parseMidiFile(bytes);
    const result = buildTransferProject({
      projectName: "Eight Stem Arrangement",
      sourceDaw: "cubase",
      bpm: 100,
      timeSignature: { numerator: 7, denominator: 8 },
      audioAssets: Array.from({ length: 8 }, (_, index) => ({
        fileName: `Stem ${index + 1}.wav`,
        assetId: `user.stem-${index + 1}`,
        durationSec: 30,
      })),
      midiBytes: bytes,
      parsedMidi: parsed,
    });

    expect(result.audioTrackNames).toHaveLength(8);
    expect(result.doc.arrangement.audioClips).toHaveLength(8);
    expect(result.midiTrackNames).toEqual(tracks.map((track) => track.name));
    expect(result.doc.arrangement.midiClips).toHaveLength(4);
    expect(result.doc.timeSignature).toEqual({ numerator: 7, denominator: 8 });
  });

  it("refuses drum MIDI past the bounded pattern window instead of dropping late hits", async () => {
    const bytes = midiBytes({
      tracks: [
        {
          name: "Drums",
          channel: 9,
          notes: [{ pitch: 36, startTick: 32 * BAR_TICKS, endTick: 32 * BAR_TICKS + 120, velocity: 0.9 }],
        },
        { name: "Bass", channel: 0, notes: [{ pitch: 36, startTick: 0, endTick: 480, velocity: 0.8 }] },
      ],
    });
    const inspection = await inspectTransferFiles([fileFromMidi("Long.mid", bytes)]);
    expect(inspection.errors.join(" ")).toContain("32-bar drum-pattern import limit");
  });

  it("discloses when the MIDI tempo map will be flattened before import", async () => {
    const bytes = midiBytes({
      tempoChanges: [
        { tick: 0, bpm: 120 },
        { tick: BAR_TICKS * 4, bpm: 100 },
      ],
    });
    const inspection = await inspectTransferFiles([fileFromMidi("Tempo Map.mid", bytes)]);
    expect(inspection.errors).toEqual([]);
    expect(inspection.warnings.join(" ")).toContain("flattened into the chosen project tempo");
    expect(inspection.parsedMidi?.tempoEvents).toEqual([
      { tick: 0, bpm: 120 },
      { tick: BAR_TICKS * 4, bpm: 100 },
    ]);
  });

  it("preserves MIDI performance timing when flattening a tempo map into the chosen project BPM", () => {
    const bytes = midiBytes({
      tempoChanges: [
        { tick: 0, bpm: 120 },
        { tick: BAR_TICKS * 4, bpm: 100 },
      ],
      tracks: [
        {
          name: "Lead",
          channel: 0,
          notes: [
            {
              pitch: 72,
              startTick: BAR_TICKS * 8,
              endTick: BAR_TICKS * 8 + 480,
              velocity: 0.8,
              releaseVelocity: 0.8,
            },
          ],
        },
      ],
    });
    const parsed = parseMidiFile(bytes);
    const result = buildTransferProject({
      projectName: "Tempo Map Transfer",
      sourceDaw: "cubase",
      bpm: 125,
      timeSignature: { numerator: 4, denominator: 4 },
      audioAssets: [],
      midiBytes: bytes,
      parsedMidi: parsed,
    });
    const track = result.doc.tracks.find((candidate) => candidate.name === "Lead");
    const pattern = result.doc.patterns.find((candidate) => candidate.id === result.doc.activePatternId);
    const note = track && pattern?.notes[track.id]?.[0];

    expect(result.doc.bpm).toBe(125);
    expect(note).toMatchObject({ start: 17_600, duration: 600, expression: { releaseVelocity: 0.8 } });
    expect(result.warnings.join(" ")).toContain("while preserving performance timing");
  });

  it("uses the exact MIDI tempo value when preserving performance timing", () => {
    const bytes = midiBytes({
      bpm: 123.4,
      tracks: [{ name: "Lead", channel: 0, notes: [{ pitch: 60, startTick: 480, endTick: 960, velocity: 0.8 }] }],
    });
    const parsed = parseMidiFile(bytes);
    const result = buildTransferProject({
      projectName: "Fractional Tempo Transfer",
      sourceDaw: "fl-studio",
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      audioAssets: [],
      midiBytes: bytes,
      parsedMidi: parsed,
    });
    const track = result.doc.tracks.find((candidate) => candidate.name === "Lead");
    const pattern = result.doc.patterns.find((candidate) => candidate.id === result.doc.activePatternId);

    expect(parsed.tempoEvents[0]?.bpm).toBeCloseTo(123.4, 2);
    expect(pattern?.notes[track?.id ?? ""]?.[0]?.start).toBe(467);
  });

  it("refuses a project tempo that would silently drop MIDI drum hits", () => {
    const bytes = midiBytes({
      tracks: [
        {
          name: "Drums",
          channel: 9,
          notes: [{ pitch: 36, startTick: BAR_TICKS * 16, endTick: BAR_TICKS * 16 + 120, velocity: 0.9 }],
        },
      ],
    });

    expect(() =>
      buildTransferProject({
        projectName: "Too Slow Transfer",
        sourceDaw: "other",
        bpm: 300,
        timeSignature: { numerator: 4, denominator: 4 },
        audioAssets: [],
        midiBytes: bytes,
        parsedMidi: parseMidiFile(bytes),
      }),
    ).toThrow(/would omit 1 GM drum hit/);
  });

  it("refuses a project tempo that would truncate a MIDI note tail", () => {
    const sourceStartTick = (MAX_ARRANGEMENT_CLIP_TICKS - 60) / 2.5;
    const bytes = midiBytes({
      tracks: [
        {
          name: "Long Sustain",
          channel: 0,
          notes: [{ pitch: 48, startTick: sourceStartTick, endTick: sourceStartTick + 480, velocity: 0.8 }],
        },
      ],
    });

    expect(() =>
      buildTransferProject({
        projectName: "Long Tail Transfer",
        sourceDaw: "pro-tools",
        bpm: 300,
        timeSignature: { numerator: 4, denominator: 4 },
        audioAssets: [],
        midiBytes: bytes,
        parsedMidi: parseMidiFile(bytes),
      }),
    ).toThrow(/would omit 1 MIDI note tail/);
  });

  it("reports the count of each MIDI event type that will be lost", () => {
    const parsed = {
      division: 480,
      bpm: 120,
      timeSignature: { num: 4, den: 4 },
      tempoEvents: [],
      timeSignatureEvents: [],
      unsupportedEvents: {
        controlChanges: 12,
        pitchBends: 2,
        programChanges: 1,
        aftertouch: 0,
        systemExclusive: 3,
      },
      sustainPedalEvents: 0,
      tracks: [],
    } as ReturnType<typeof parseMidiFile>;

    expect(midiImportWarnings(parsed)).toContain(
      "MIDI data that will not transfer: 12 unsupported CC messages, 2 pitch bends, 1 program change, 3 SysEx messages. KYX imports notes, GM drum hits, CC7/10/11 track automation, and bakes CC64 sustain into note lengths.",
    );
  });

  it("rejects unsupported files and multiple MIDI files before any import work", async () => {
    const result = await inspectTransferFiles([
      new File(["data"], "session.txt", { type: "text/plain" }),
      fileFromMidi("one.mid", midiBytes()),
      fileFromMidi("two.mid", midiBytes()),
    ]);
    expect(result.errors.join(" ")).toContain("not a supported audio or Standard MIDI file");
    expect(result.errors.join(" ")).toContain("Choose one combined MIDI file");
  });
});
