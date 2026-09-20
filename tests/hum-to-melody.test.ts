import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { trackPitch, PITCH_CLARITY_GATE } from "../src/audio-workers/pitch-tracker";
import { trackPitchAsync } from "../src/audio-workers/pitch-tracker-client";
import { framesToNotes, humToNotesCommand, patternLengthTicks } from "../src/midi/hum-to-notes";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { MusicalKey, Pattern, ProjectDocument } from "../src/project-model/types";

/**
 * Hum-to-melody: pitch tracker (YIN) + segmentation/key-snap/quantize +
 * the one-undo-step install command. All audio is synthetic — the whole
 * pipeline is deterministic without a microphone.
 */

const SR = 22_050;
const sec = SR; // one-second shorthand

/** Mono sine segment helpers. */
function silence(samples: number): Float32Array {
  return new Float32Array(samples);
}

function sine(freqHz: number, samples: number, amp = 0.4, phase = 0): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = amp * Math.sin(2 * Math.PI * freqHz * (i / SR) + phase);
  }
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function voicedMidi(frames: ReturnType<typeof trackPitch>): number[] {
  return frames.filter((f) => f.clarity >= PITCH_CLARITY_GATE && f.rms >= 0.004 && f.midi > 0).map((f) => f.midi);
}

describe("pitch tracker", () => {
  it("tracks A3 (220 Hz) and A4 (440 Hz) sines within a quarter tone", () => {
    for (const [hz, expectedMidi] of [
      [220, 57],
      [440, 69],
    ] as const) {
      const frames = trackPitch(sine(hz, SR), SR);
      const voiced = voicedMidi(frames);
      expect(voiced.length).toBeGreaterThan(20);
      const mean = voiced.reduce((a, b) => a + b, 0) / voiced.length;
      expect(Math.abs(mean - expectedMidi)).toBeLessThan(0.25);
      // Stable: the spread stays tight (no octave flips).
      const max = Math.max(...voiced);
      const min = Math.min(...voiced);
      expect(max - min).toBeLessThan(1);
    }
  });

  it("treats digital silence and noise as unvoiced", () => {
    const silent = trackPitch(silence(SR), SR);
    expect(silent.length).toBeGreaterThan(0);
    expect(voicedMidi(silent)).toHaveLength(0);

    // Deterministic pseudo-noise: no stable period to lock onto.
    let seed = 12345;
    const noise = new Float32Array(SR);
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = ((seed / 0x3fffffff) % 1) * 2 - 1;
    }
    const noisy = trackPitch(noise, SR);
    expect(voicedMidi(noisy)).toHaveLength(0);
  });

  it("rejects malformed worker messages (guard contract)", () => {
    // The worker source is TypeScript (not eval-able here), so pin the guard
    // contract structurally — same contract as onset-detector.ts.
    const source = readFileSync(resolve(process.cwd(), "src/audio-workers/pitch-tracker.ts"), "utf8");
    expect(source).toContain('typeof (self as unknown as { postMessage?: unknown }).postMessage === "function"');
    expect(source).toContain('!(channelData instanceof Float32Array)');
    expect(source).toContain('return; // not our message — ignore silently');
  });
});

describe("framesToNotes — segmentation, key snap, quantize", () => {
  const base = { bpm: 120, quantize: true };

  it("turns three hummed notes into three quantized notes (dropout bridged)", () => {
    // A3 (with a 40 ms dropout inside — bridged), C4, E4. All in C major.
    const audio = concat(
      silence(Math.round(sec * 0.4)),
      sine(220, Math.round(sec * 0.35)),
      silence(Math.round(sec * 0.04)),
      sine(220, Math.round(sec * 0.35)),
      silence(Math.round(sec * 0.25)),
      sine(261.63, Math.round(sec * 0.7)),
      silence(Math.round(sec * 0.25)),
      sine(329.63, Math.round(sec * 0.7)),
      silence(sec),
    );
    const frames = trackPitch(audio, SR);
    const notes = framesToNotes(frames, { ...base, patternLengthTicks: 1920 * 8 });
    expect(notes.length).toBe(3);
    expect(notes.map((n) => n.pitch)).toEqual([57, 60, 64]);
    // Quantized starts sit on the 16th grid; first note starts ≈ 0.39 s in
    // (≈ 374 ticks → quantized 360); the dropout did not split it (the run
    // spans ≈ 0.75 s (0.39→1.14) ≈ 720 ticks quantized.
    for (const note of notes) expect(note.start % 120).toBe(0);
    expect(notes[0]!.start).toBe(360);
    expect(notes[0]!.duration).toBe(720);
    // Velocity ordering follows loudness — all segments use the same amp.
    for (const note of notes) expect(note.velocity).toBeCloseTo(0.9, 1);
  });

  it("snaps off-scale pitches into the project key", () => {
    // F#4 (369.99 Hz) is NOT in C major — nearest degree is F4 (65).
    const audio = concat(silence(Math.round(sec * 0.4)), sine(369.99, Math.round(sec * 1.2)), silence(sec));
    const frames = trackPitch(audio, SR);
    const notes = framesToNotes(frames, {
      ...base,
      key: "C Major" as MusicalKey,
      patternLengthTicks: 1920 * 8,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.pitch).toBe(65);
  });

  it("drops notes past the pattern end and survives empty input", () => {
    // One long hum starting at 2.5 s — a 1-bar pattern (1920 ticks = 2 s @120)
    // keeps only what fits inside.
    const audio = concat(silence(Math.round(sec * 2.4)), sine(220, Math.round(sec * 1.2)), silence(sec));
    const frames = trackPitch(audio, SR);
    const short = framesToNotes(frames, { ...base, patternLengthTicks: 1920 });
    expect(short).toHaveLength(0);

    const nothing = framesToNotes(trackPitch(silence(SR), SR), { ...base, patternLengthTicks: 1920 });
    expect(nothing).toEqual([]);
  });

  it("matches the client fallback path (same frames without a worker)", async () => {
    const data = sine(220, SR);
    const viaClient = await trackPitchAsync(data, SR);
    expect(viaClient).toEqual(trackPitch(data, SR));
  });
});

describe("humToNotesCommand", () => {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((t): t is Extract<ProjectDocument["tracks"][number], { kind: "instrument" }> => t.kind === "instrument")!;
  const pattern = doc.patterns[0]!;

  const note = (pitch: number, start: number) => ({
    id: `n-${pitch}-${start}`,
    pitch,
    start,
    duration: 120,
    velocity: 0.8,
  });

  it("replaces the track's notes in ONE undo step and restores on undo", () => {
    const seeded: Pattern = { ...pattern, notes: { ...pattern.notes, [track.id]: [note(72, 0)] } };
    const docSeeded: ProjectDocument = { ...doc, patterns: [seeded, ...doc.patterns.filter((p) => p.id !== seeded.id)] };
    const command = humToNotesCommand(
      docSeeded,
      [note(60, 240), note(64, 480)],
      { trackId: track.id, patternId: seeded.id, mode: "replace" },
    );
    const next = command.execute(docSeeded);
    const applied = next.patterns.find((p) => p.id === seeded.id)!.notes[track.id]!;
    expect(applied.map((n) => n.pitch)).toEqual([60, 64]);
    // Undo applies the inverse patch to the EXECUTED state (delta snapshot
    // contract — stale dispatch on the old doc must not corrupt anything).
    const undone = command.undo(next);
    const undonePattern = undone.patterns.find((p) => p.id === seeded.id)!;
    expect(undonePattern.notes[track.id]).toEqual([note(72, 0)]);
    expect(undone.patterns).toHaveLength(docSeeded.patterns.length);
  });

  it("merge appends without duplicating identical pitch+start", () => {
    const seeded: Pattern = { ...pattern, notes: { ...pattern.notes, [track.id]: [note(60, 240)] } };
    const docSeeded: ProjectDocument = { ...doc, patterns: [seeded, ...doc.patterns.filter((p) => p.id !== seeded.id)] };
    const next = humToNotesCommand(docSeeded, [note(60, 240), note(64, 480)], {
      trackId: track.id,
      patternId: seeded.id,
      mode: "merge",
    }).execute(docSeeded);
    const merged = next.patterns.find((p) => p.id === seeded.id)!.notes[track.id]!;
    expect(merged).toHaveLength(2);
    expect(merged.map((n) => n.start)).toEqual([240, 480]);
  });

  it("validates targets and rejects empty note lists", () => {
    expect(() =>
      humToNotesCommand(doc, [note(60, 0)], { trackId: "missing", patternId: pattern.id, mode: "replace" }),
    ).toThrow(/track/);
    expect(() =>
      humToNotesCommand(doc, [note(60, 0)], { trackId: track.id, patternId: "missing", mode: "replace" }),
    ).toThrow(/pattern/);
    expect(() =>
      humToNotesCommand(doc, [], { trackId: track.id, patternId: pattern.id, mode: "replace" }),
    ).toThrow(/No hummed notes/);
  });

  it("patternLengthTicks matches the piano roll grid math", () => {
    expect(patternLengthTicks(pattern)).toBe(pattern.stepCount * 120);
  });
});
