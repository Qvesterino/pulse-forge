import { describe, expect, it } from "vitest";
import {
  buildSourceRecord,
  describeSourcePitch,
  describeSourceState,
  markSourceMissing,
  sourceContentHash,
  type SourceDraft,
} from "../../src/sample-library/source-record";

/**
 * WAVE 3 — SOURCE RECORDS (roadmap plan R2).
 *
 * The contract:
 *  - a source has an identity that survives the patch (the CONTENT, not the
 *    moment it was imported);
 *  - a source that was never analysed says so — no invented root;
 *  - a source whose bytes are gone is VISIBLE and still carries its identity;
 *  - a weak pitch reading is never presented as a precise note.
 */

const SR = 44100;

function draft(overrides: Partial<SourceDraft> = {}): SourceDraft {
  return {
    id: "user.kick-1",
    contentHash: "0123abcd",
    name: "kick",
    fileName: "kick.wav",
    origin: "imported",
    durationSec: 0.5,
    sampleRate: SR,
    channels: 1,
    ...overrides,
  };
}

describe("sourceContentHash", () => {
  it("is stable for the same audio — the same file imported twice is one source", () => {
    const pcm = new Float32Array(4096);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 10);
    expect(sourceContentHash(pcm, SR)).toBe(sourceContentHash(pcm.slice(), SR));
  });

  it("tells two different files apart", () => {
    const a = new Float32Array(4096);
    const b = new Float32Array(4096);
    for (let i = 0; i < a.length; i++) a[i] = Math.sin(i / 10);
    for (let i = 0; i < b.length; i++) b[i] = Math.sin(i / 3);
    expect(sourceContentHash(a, SR)).not.toBe(sourceContentHash(b, SR));
  });

  it("the sample rate and the recording's length are part of the identity", () => {
    const pcm = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
    // A different rate is a different source.
    expect(sourceContentHash(pcm, SR)).not.toBe(sourceContentHash(pcm, 48000));
    // A longer recording is a different source: a truncated take is not the
    // same sound, so the hash must not collapse them into one identity.
    const longer = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(sourceContentHash(pcm, SR)).not.toBe(sourceContentHash(longer, SR));
  });
});

describe("buildSourceRecord", () => {
  it("invents no root when nothing was analysed", () => {
    const record = buildSourceRecord(draft());
    expect(record.pitch.rootMidi).toBeNull();
    expect(record.pitch.rootConfidence).toBe(0);
    expect(record.state).toBe("ready");
  });

  it("carries the measured pitch and envelope", () => {
    const record = buildSourceRecord(draft(), {
      pitch: { rootMidi: 36, rootConfidence: 0.82, rootHz: 65.4 },
      envelope: { attackSec: 0.002, releaseSec: 0.4 },
    });
    expect(record.pitch.rootMidi).toBe(36);
    expect(record.pitch.rootConfidence).toBe(0.82);
    expect(record.envelope.releaseSec).toBe(0.4);
  });

  it("keeps the loop information it was given", () => {
    const record = buildSourceRecord(draft({ isLoop: true, bpm: 128 }));
    expect(record.loop.isLoop).toBe(true);
    expect(record.loop.bpm).toBe(128);
    const plain = buildSourceRecord(draft());
    expect(plain.loop.isLoop).toBe(false);
  });
});

describe("markSourceMissing", () => {
  it("keeps the identity and metadata but says the bytes are gone", () => {
    const record = buildSourceRecord(draft(), { pitch: { rootMidi: 36, rootConfidence: 0.9, rootHz: 65.4 } });
    const missing = markSourceMissing(record, "the audio is not in your library");
    expect(missing.state).toBe("missing");
    expect(missing.missingReason).toBe("the audio is not in your library");
    // The producer must still be able to tell WHICH sound is missing.
    expect(missing.id).toBe(record.id);
    expect(missing.name).toBe(record.name);
    expect(missing.pitch.rootMidi).toBe(36);
    // The original record is untouched.
    expect(record.state).toBe("ready");
  });
});

describe("describeSourcePitch", () => {
  it("states a precise reading as a note", () => {
    expect(describeSourcePitch({ rootMidi: 36, rootConfidence: 0.9, rootHz: 65.4 })).toMatch(/root MIDI 36/);
  });

  it("states a weak reading as weak — never as a precise note", () => {
    const weak = describeSourcePitch({ rootMidi: 36, rootConfidence: 0.2, rootHz: 65.4 });
    expect(weak).toMatch(/weak/);
    expect(weak).toMatch(/20 %/);
  });

  it("states no reading as no reading", () => {
    expect(describeSourcePitch({ rootMidi: null, rootConfidence: 0, rootHz: 0 })).toBe("no pitch detected");
  });
});

describe("describeSourceState", () => {
  it("says a present source is available", () => {
    expect(describeSourceState(buildSourceRecord(draft()))).toBe("source available");
  });

  it("says a missing source is missing AND says why", () => {
    const missing = markSourceMissing(buildSourceRecord(draft()), "the audio is not in your library");
    const text = describeSourceState(missing);
    expect(text).toMatch(/missing/);
    expect(text).toMatch(/not in your library/);
  });
});
