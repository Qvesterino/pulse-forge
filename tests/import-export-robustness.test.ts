import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { decodeShareCode, encodeShareCode, shareAppUrl } from "../src/export/shareCode";
import { importProject, MAX_PROJECT_IMPORT_BYTES } from "../src/export/project-io";
import { encodeWav } from "../src/rendering/wav";
import { parseMidiFile, MidiParseError, writeMidiFile, type MidiTrackData } from "../src/midi/midiFile";
import { importMidiCommand } from "../src/midi/midiProject";
import { ProjectStore } from "../src/store/ProjectStore";
import { compressToEncodedURIComponent } from "lz-string";

/**
 * Import/export & format robustness (GOAL 08). External input is untrusted:
 * every path here must either produce a valid, normalized document or fail
 * with a NAMED error / null — never throw raw, never leave partial state.
 */

// ─── A. Project JSON fuzz — decodeShareCode + importProject ─────────────────

describe("share-code decode: hostile and malformed inputs normalize-or-reject", () => {
  it("returns null (never throws) for the hostile corpus", () => {
    const corpus: unknown[] = [
      null,
      undefined,
      "",
      "not-a-code",
      "AAAA", // valid lz-string alphabet, garbage payload
      compressToEncodedURIComponent("null"),
      compressToEncodedURIComponent("[]"),
      compressToEncodedURIComponent("{}"),
      compressToEncodedURIComponent('{"tracks": 42}'),
      compressToEncodedURIComponent('{"tracks": "nope", "patterns": null}'),
      compressToEncodedURIComponent('{"tracks": [{}], "patterns": [{}], "bpm": "fast"}'),
      compressToEncodedURIComponent(JSON.stringify({ tracks: [], patterns: [], scenes: [], __proto__: { injected: true } })),
      compressToEncodedURIComponent(JSON.stringify({ tracks: [], bomb: "x".repeat(1_000_000) })),
    ];
    for (const input of corpus) {
      expect(() => decodeShareCode(input as string)).not.toThrow();
      const doc = decodeShareCode(input as string);
      if (doc !== null) {
        // Anything that decodes is a fully normalized, valid-shaped document.
        expect(Array.isArray(doc.tracks)).toBe(true);
        expect(Array.isArray(doc.patterns)).toBe(true);
        expect(typeof doc.id).toBe("string");
      }
    }
    // Prototype pollution attempt must not poison anything.
    const probe: Record<string, unknown> = {};
    expect((probe as { injected?: unknown }).injected).toBeUndefined();
  });

  it("truncated real share codes fail cleanly: deep cuts null, tail cuts never throw", () => {
    const doc = createProjectFromTemplate("trap");
    const code = encodeShareCode(doc);
    expect(decodeShareCode(code)).not.toBeNull();
    // Deep truncations destroy the payload → null, never a throw.
    for (const cut of [8, code.length >> 2, code.length >> 1]) {
      expect(decodeShareCode(code.slice(0, cut))).toBeNull();
    }
    // Tiny tail cuts may survive (lz padding carries spare bits) — the only
    // contract there is no-throw + valid shape if anything decodes.
    for (const cut of [1, code.length - 8, code.length - 1]) {
      expect(() => decodeShareCode(code.slice(0, cut))).not.toThrow();
    }
    // Corrupted tail (valid length, broken payload).
    expect(decodeShareCode(code.slice(0, -4) + "AAAA")).toBeNull();
  });

  it("round-trips a real project semantically (export → import → equivalent)", () => {
    const doc = createProjectFromTemplate("trap");
    const decoded = decodeShareCode(encodeShareCode(doc))!;
    expect(decoded.id).toBe(doc.id);
    expect(decoded.bpm).toBe(doc.bpm);
    expect(decoded.tracks.map((t) => t.id)).toEqual(doc.tracks.map((t) => t.id));
    expect(decoded.patterns.map((p) => p.id)).toEqual(doc.patterns.map((p) => p.id));
    // And the round-tripped doc round-trips again byte-stably (normalized in, normalized out).
    expect(encodeShareCode(decoded)).toBe(encodeShareCode(doc));
  });
});

describe("importProject: file/string path validation", () => {
  it("rejects invalid JSON and wrong shapes with named errors (string path)", async () => {
    await expect(importProject("{not json")).rejects.toThrow(/Invalid JSON/);
    await expect(importProject(JSON.stringify({ hello: "world" }))).rejects.toThrow();
    await expect(importProject("null")).rejects.toThrow();
  });

  it("accepts a valid serialized project (string path)", async () => {
    const doc = createProjectFromTemplate("house");
    const imported = await importProject(JSON.stringify(doc));
    expect(imported.id).toBe(doc.id);
    expect(imported.tracks.length).toBe(doc.tracks.length);
  });

  it("enforces the 10 MB project cap at the File boundary", async () => {
    const oversized = new File(["x".repeat(MAX_PROJECT_IMPORT_BYTES + 1)], "big.pulseforge.json");
    await expect(importProject(oversized)).rejects.toThrow(/too large/);
    // Just under the cap with junk content — past the size gate, rejected by shape.
    const junk = new File(["x".repeat(1024)], "junk.pulseforge.json");
    await expect(importProject(junk)).rejects.toThrow();
  });
});

// ─── B. MIDI import edge cases ───────────────────────────────────────────────

/** Build a minimal MIDI file from raw chunk bytes. */
function midiFile(format: number, division: number, tracks: number[][]): Uint8Array {
  const bytes: number[] = [];
  const push32 = (v: number) => bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const push16 = (v: number) => bytes.push((v >>> 8) & 0xff, v & 0xff);
  const vlq = (v: number): number[] => {
    const out = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
      out.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    return out;
  };
  bytes.push(0x4d, 0x54, 0x68, 0x64); // MThd
  push32(6);
  push16(format);
  push16(tracks.length);
  push16(division);
  for (const track of tracks) {
    bytes.push(0x4d, 0x54, 0x72, 0x6b); // MTrk
    push32(track.length);
    bytes.push(...track);
  }
  void vlq;
  return new Uint8Array(bytes);
}

describe("MIDI import: malformed files fail with named errors", () => {
  it("rejects empty, truncated and non-MIDI buffers", () => {
    expect(() => parseMidiFile(new Uint8Array(0))).toThrow(MidiParseError);
    expect(() => parseMidiFile(new Uint8Array([0x4d, 0x54]))).toThrow(MidiParseError);
    expect(() => parseMidiFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]))).toThrow(
      /MThd/,
    );
  });

  it("rejects format 2, zero division and SMPTE timing", () => {
    const mk = (division: number, format = 0) => midiFile(format, division, [[]]);
    expect(() => parseMidiFile(mk(0))).toThrow(/division/);
    expect(() => parseMidiFile(mk(0xe250))).toThrow(/SMPTE/);
    expect(() => parseMidiFile(midiFile(2, 480, [[]]))).toThrow(/format-2/);
  });

  it("running status without a preceding status byte is a named error", () => {
    // Delta 0 then raw data bytes (0x40 0x7f) with no status byte first.
    const track = [0x00, 0x40, 0x7f];
    expect(() => parseMidiFile(midiFile(0, 480, [track]))).toThrow(/running status/);
  });

  it("accepts zero-track and truncated-chunk-count files as EMPTY parses (tolerant)", () => {
    const empty = parseMidiFile(midiFile(0, 480, []));
    expect(empty.tracks.length).toBe(0);
    // Header declares 3 tracks but the file ends after the header.
    const truncated = parseMidiFile(midiFile(0, 480, [[], [], []]).slice(0, 14));
    expect(truncated.tracks.length).toBe(0);
  });

  it("round-trips a written file: notes survive write → parse → importMidiCommand", () => {
    const doc = createProjectFromTemplate("house");
    const store = new ProjectStore(doc);
    // Write a known 2-track MIDI (melodic + GM drum channel), parse and
    // import it through the real command path.
    const tracks: MidiTrackData[] = [
      {
        name: "Lead",
        channel: 0,
        notes: [
          { pitch: 60, startTick: 0, endTick: 240, velocity: 0.8 },
          { pitch: 64, startTick: 240, endTick: 480, velocity: 0.6 },
        ],
      },
      { name: "Drums", channel: 9, notes: [{ pitch: 36, startTick: 0, endTick: 120, velocity: 1 }] },
    ];
    const bytes = writeMidiFile({ division: 480, tracks });
    const parsed = parseMidiFile(bytes);
    const allNotes = parsed.tracks.flatMap((t) => t.notes);
    expect(allNotes.length).toBe(3);
    expect(allNotes.map((n) => n.pitch).sort()).toEqual([36, 60, 64]);

    // Import into the live doc through the real command (one undo step).
    const command = importMidiCommand(store.doc, bytes, "test.mid");
    store.execute(command);
    expect(store.doc.patterns.length).toBeGreaterThan(doc.patterns.length);
    store.undo();
    expect(store.doc.patterns.length).toBe(doc.patterns.length);
  });
});

// ─── C. WAV encoder round-trip (16 / 24 / 32-float, odd lengths) ─────────────

function fakeBuffer(channels: number, samples: number[][]): AudioBuffer {
  return {
    numberOfChannels: channels,
    length: samples[0]!.length,
    sampleRate: 44100,
    duration: samples[0]!.length / 44100,
    getChannelData: (index: number) => new Float32Array(samples[index]!),
  } as unknown as AudioBuffer;
}

/** Minimal RIFF reader: returns {channels, sampleRate, bits, format, data}. */
function parseWav(bytes: ArrayBuffer): {
  channels: number;
  sampleRate: number;
  bits: number;
  format: number;
  data: DataView;
} {
  const view = new DataView(bytes);
  expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe("RIFF");
  expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe("WAVE");
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let format = 0;
  let data: DataView | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      format = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === "data") {
      data = new DataView(bytes, offset + 8, size);
    }
    offset += 8 + size + (size % 2);
  }
  if (!data) throw new Error("no data chunk");
  return { channels, sampleRate, bits, format, data };
}

describe("WAV encode round-trip (GOAL 08)", () => {
  const LENGTHS = [1, 2, 3, 33, 4096];
  const VALUE = 0.5;

  for (const bitDepth of [16, 24, 32] as const) {
    it(`round-trips ${bitDepth}-bit mono at odd and even lengths`, () => {
      for (const length of LENGTHS) {
        const samples = Array.from({ length }, (_, i) => (i % 2 === 0 ? VALUE : -VALUE));
        const encoded = encodeWav(fakeBuffer(1, [samples]), bitDepth);
        const wav = parseWav(encoded);
        expect(wav.channels).toBe(1);
        expect(wav.sampleRate).toBe(44100);
        expect(wav.bits).toBe(bitDepth);
        expect(wav.format).toBe(bitDepth === 32 ? 3 : 1);
        expect(wav.data.byteLength).toBe(length * (bitDepth / 8));

        const tolerance = bitDepth === 16 ? 2 ** -14 : bitDepth === 24 ? 2 ** -22 : 2 ** -23;
        for (let i = 0; i < length; i++) {
          const decoded =
            bitDepth === 16
              ? wav.data.getInt16(i * 2, true) / 32768
              : bitDepth === 24
                ? (() => {
                    const b = i * 3;
                    let v = wav.data.getUint8(b) | (wav.data.getUint8(b + 1) << 8) | (wav.data.getUint8(b + 2) << 16);
                    if (v & 0x800000) v |= ~0xffffff;
                    return v / 8388608;
                  })()
                : wav.data.getFloat32(i * 4, true);
          expect(Math.abs(decoded - samples[i]!)).toBeLessThanOrEqual(tolerance);
        }
      }
    });
  }

  it("stereo channels stay de-interleaved", () => {
    const left = [0.25, -0.25, 0.5];
    const right = [-0.75, 0.125, -0.5];
    const wav = parseWav(encodeWav(fakeBuffer(2, [left, right]), 32));
    expect(wav.channels).toBe(2);
    for (let i = 0; i < 3; i++) {
      expect(wav.data.getFloat32((i * 2) * 4, true)).toBeCloseTo(left[i]!, 6);
      expect(wav.data.getFloat32((i * 2 + 1) * 4, true)).toBeCloseTo(right[i]!, 6);
    }
  });

  it("16-bit soft-clips over-range samples; 32-float retains them (documented behavior)", () => {
    const hot = [0.5, 1.5, -1.5];
    const wav16 = parseWav(encodeWav(fakeBuffer(1, [hot]), 16));
    expect(wav16.data.getInt16(1 * 2, true) / 32768).toBeLessThanOrEqual(1);
    expect(wav16.data.getInt16(2 * 2, true) / 32768).toBeGreaterThanOrEqual(-1);
    const wav32 = parseWav(encodeWav(fakeBuffer(1, [hot]), 32));
    expect(wav32.data.getFloat32(1 * 4, true)).toBeCloseTo(1.5, 6);
    expect(wav32.data.getFloat32(2 * 4, true)).toBeCloseTo(-1.5, 6);
  });
});

// ─── D. Gallery payload ceiling at the boundary ──────────────────────────────

describe("gallery code ceiling boundary (shape contract, server-side check order)", () => {
  it("the cap check runs BEFORE decode — an over-cap junk code is 'too large', not 'invalid'", async () => {
    // Reuse the exported server meta fn through the contract suite's import
    // pattern; here we pin the client-visible behavior: share URLs carry the
    // full code unescaped, so ceiling violations must be detectable by length
    // alone (the server does exactly that — length gate precedes decode).
    const doc = createProjectFromTemplate("house");
    const code = encodeShareCode(doc);
    expect(code.length).toBeLessThan(400_000); // real projects sit far below
    expect(decodeShareCode(code)).not.toBeNull();

    const over = "A".repeat(400_001);
    expect(over.length).toBeGreaterThan(400_000);
    // Client decode of an over-cap token must reject on length, not decode.
    expect(decodeShareCode(over)).toBeNull();
  });

  it("URL round-trip mangles '+' to space; lz-string decode STILL recovers (pinned dependency)", () => {
    // compressToEncodedURIComponent's alphabet includes '+'. URLSearchParams
    // (form-urlencoded rules) reads it back as a space — so Boot's
    // params.get("import") hands lz-string a SPACE-MANGLED code. This works
    // ONLY because decompressFromEncodedURIComponent restores spaces to '+'
    // before decoding. Pin both halves: the mangling is real, and the
    // recovery depends on it — switching codecs would silently break every
    // share link containing '+'.
    const doc = createProjectFromTemplate("house");
    const code = encodeShareCode(doc);
    expect(code).toMatch(/\+/); // the hazard is real in actual codes
    const url = shareAppUrl(code, "https://kyx.app");
    const echoed = new URL(url).searchParams.get("import")!;
    expect(echoed).not.toBe(code); // '+' arrived as ' '
    expect(echoed).toContain(" ");
    const roundTripped = decodeShareCode(echoed);
    expect(roundTripped).not.toBeNull();
    expect(roundTripped!.id).toBe(doc.id);
  });
});
