import { describe, expect, it, vi } from "vitest";
import { MidiParseError, parseMidiFile, writeMidiFile } from "../src/midi/midiFile";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * AUDIT 10 — Import robustness regression invariants
 * (prompts/daw_qa_reliability_vault/10-import-audit.md).
 *
 * The parser's bounded-loop discipline (VLQ always advances or throws,
 * chunk skip ≥ 8, SMPTE/division-0 rejection) was already covered by
 * tests/midi-file.test.ts. This suite pins the Audit-10 fixes: the note
 * flood cap, and the DropZone batch skip/concurrency guards.
 */

describe("MIDI import — note flood cap (audit 10)", () => {
  it("a machine-generated file with > 200k notes throws a readable error instead of OOM-ing", () => {
    // Build a track chunk manually: many note-on/note-off pairs via running
    // status. writeMidiFile would need 200k note objects — hand-roll the
    // bytes for speed.
    const bytes: number[] = [];
    const pushVlq = (value: number) => {
      const septets = [value & 0x7f];
      let rest = value >> 7;
      while (rest > 0) {
        septets.unshift((rest & 0x7f) | 0x80);
        rest >>= 7;
      }
      bytes.push(...septets);
    };

    const track: number[] = [];
    // Explicit note-on establishes running status 0x90 (a leading program
    // change would be eaten as one-byte program events instead).
    track.push(0, 0x90, 64, 100);
    const pairs = 210_000; // each off/on cycle closes ONE note → 210k > 200k
    for (let i = 0; i < pairs; i++) {
      // note-off one tick later (a zero-length note is discarded BEFORE
      // counting), then the next note-on via running status.
      pushVlq(1);
      track.push(64, 0);
      pushVlq(1);
      track.push(64, 100);
    }
    const trackBytes = new Uint8Array(track);

    const file: number[] = [
      0x4d, 0x54, 0x68, 0x64, // MThd
      0, 0, 0, 6, // header length
      0, 0, 0, 1, // format 0, 1 track
      0, 1, // division 1... irrelevant for the cap
    ];
    file.push(0x4d, 0x54, 0x72, 0x6b); // MTrk
    file.push((trackBytes.length >>> 24) & 0xff, (trackBytes.length >>> 16) & 0xff, (trackBytes.length >>> 8) & 0xff, trackBytes.length & 0xff);
    // No spread: ~500k elements blow the call stack.
    const fileBytes = new Uint8Array(file.length + trackBytes.length);
    fileBytes.set(file, 0);
    fileBytes.set(trackBytes, file.length);

    expect(() => parseMidiFile(fileBytes)).toThrow(MidiParseError);
    expect(() => parseMidiFile(fileBytes)).toThrow(/too many notes/);
  });

  it("a normal small file still parses (cap does not bite legitimate imports)", () => {
    const bytes = writeMidiFile({ bpm: 120, tracks: [{ channel: 0, notes: [{ pitch: 60, startTick: 0, endTick: 240, velocity: 0.8 }] }] });
    const parsed = parseMidiFile(bytes);
    expect(parsed.bpm).toBeGreaterThan(0);
  });
});

/* ── DropZone batch skip + concurrency (source pins) ────────────────── */

describe("DropZone — batch skip + concurrency guards (audit 10)", () => {
  const dropzone = () => readFileSync(resolve(process.cwd(), "src/ui/DropZone.tsx"), "utf8");

  it("unsupported/oversized files SKIP (continue), not abort the batch", () => {
    const source = dropzone();
    const loop = source.slice(source.indexOf("for (const file of fileArray)"), source.indexOf("} catch (err)"));
    expect(loop).toContain("skipped.push(file.name)");
    expect(loop).toContain("skipped.push(");
    expect(loop.match(/setImporting\(false\);[\s\S]*?return;/g)?.filter((m) => m.includes("skipped")).length ?? 0).toBe(0);
  });

  it("a second drop during an in-flight batch is refused (importing guard)", () => {
    const source = dropzone();
    const start = source.indexOf("const importFiles = useCallback");
    expect(source.slice(start, start + 400)).toContain("if (importing) return;");
  });

  it("the skip summary names the count and files", () => {
    const source = dropzone();
    expect(source).toContain("Skipped ${skipped.length}");
  });
});
