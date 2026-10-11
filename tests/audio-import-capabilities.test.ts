import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AUDIO_IMPORT_EXTENSIONS,
  AUDIO_IMPORT_MIME_TYPES,
  AudioImportTooLargeError,
  assertAudioImportSize,
  audioImportAcceptAttribute,
  base64ToAudioBytes,
  describeAudioImportFormats,
  isAudioImportExtension,
  isAudioImportFile,
  isAudioImportMimeType,
  maxAudioImportBase64Chars,
  MAX_AUDIO_IMPORT_BYTES,
} from "../src/audio-import-capabilities";
import { COMPRESSED_AUDIO_FORMATS } from "../src/export/compressed-audio-capabilities";
import { importAudioFile } from "../src/ui/sample-import";

// Vitest runs from the repo root; this spec sits directly in tests/, so the
// import depth above is `../src` (not `../../src`) and __dirname is not an ESM
// global. The single-source guards below read real files, so they need a real
// absolute root.
const REPO_ROOT = process.cwd();

describe("audio import acceptance", () => {
  it("accepts every container a browser can decode, case-insensitively", () => {
    for (const extension of AUDIO_IMPORT_EXTENSIONS) {
      expect(isAudioImportExtension(`take.${extension}`)).toBe(true);
      expect(isAudioImportExtension(`take.${extension.toUpperCase()}`)).toBe(true);
      expect(isAudioImportExtension(`my song v2.${extension}`)).toBe(true);
    }
  });

  it("rejects non-audio shapes rather than guessing", () => {
    for (const name of ["notes.txt", "art.png", "project.kyx.json", "noextension", "archive.zip", ""]) {
      expect(isAudioImportExtension(name)).toBe(false);
    }
  });

  it("accepts parameterised MIME types and rejects unrelated ones", () => {
    // Real files arrive as `audio/ogg; codecs=opus`, not the bare type.
    expect(isAudioImportMimeType("audio/ogg; codecs=opus")).toBe(true);
    expect(isAudioImportMimeType("AUDIO/WAV")).toBe(true);
    expect(isAudioImportMimeType("audio/x-m4a")).toBe(true);
    expect(isAudioImportMimeType("text/plain")).toBe(false);
    expect(isAudioImportMimeType("")).toBe(false);
    // An application container is not audio we can decode into a sample.
    expect(isAudioImportMimeType("video/mp4")).toBe(false);
  });

  it("accepts on EITHER the extension or the declared type", () => {
    // Browsers mislabel; a .bin that announces itself as FLAC is still FLAC.
    expect(isAudioImportFile({ name: "sample.bin", type: "audio/flac" })).toBe(true);
    expect(isAudioImportFile({ name: "sample.flac", type: "" })).toBe(true);
    expect(isAudioImportFile({ name: "sample.txt", type: "text/plain" })).toBe(false);
  });

  it("builds a picker attribute and a hint from the same list", () => {
    const attribute = audioImportAcceptAttribute();
    for (const extension of AUDIO_IMPORT_EXTENSIONS) {
      expect(attribute).toContain(`.${extension}`);
      expect(describeAudioImportFormats().length).toBeGreaterThan(0);
    }
    // Every hint token must be a real, accepted extension — the hint used to
    // read "WAV · MP3 · OGG · FLAC · AIFF" while OPUS was already accepted.
    const hinted = describeAudioImportFormats()
      .split("·")
      .map((token) => token.trim().toLowerCase());
    for (const token of hinted) {
      expect(AUDIO_IMPORT_EXTENSIONS as readonly string[]).toContain(token);
    }
  });
});

describe("audio import ceiling", () => {
  it("accepts files up to the limit and rejects beyond it", () => {
    expect(() => assertAudioImportSize(MAX_AUDIO_IMPORT_BYTES)).not.toThrow();
    expect(() => assertAudioImportSize(MAX_AUDIO_IMPORT_BYTES + 1)).toThrow(AudioImportTooLargeError);
    expect(() => assertAudioImportSize(Number.NaN)).toThrow(/unreadable file size/);
  });

  it("reports the offending size rather than a generic failure", () => {
    try {
      assertAudioImportSize(64 * 1024 * 1024);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioImportTooLargeError);
      expect((error as AudioImportTooLargeError).bytes).toBe(64 * 1024 * 1024);
      expect((error as Error).message).toMatch(/limit is 25 MB/);
    }
  });

  it("refuses an oversized base64 body WITHOUT decoding it", () => {
    // The intake payload arrives over HTTP and used to be atob'd in full
    // before anything could reject it. The guard must fire on encoded length.
    const oversized = "A".repeat(maxAudioImportBase64Chars() + 4);
    expect(oversized.length).toBeGreaterThan(maxAudioImportBase64Chars());
    expect(() => base64ToAudioBytes(oversized)).toThrow(AudioImportTooLargeError);
  });

  it("round-trips a body within the limit byte-for-byte", () => {
    const original = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    let binary = "";
    for (const byte of original) binary += String.fromCharCode(byte);
    const encoded = btoa(binary);
    expect(Array.from(base64ToAudioBytes(encoded))).toEqual(Array.from(original));
  });
});

describe("export → import round-trip (the asymmetry this module exists to prevent)", () => {
  it("can re-open every audio container KYX is able to export", () => {
    // KYX writes WAV, FLAC and MP3 from the master menu, plus the lossy share
    // formats. Exporting a format the library then refuses is a one-way door.
    const exportable = ["wav", "flac", "mp3", ...COMPRESSED_AUDIO_FORMATS.map((format) => format.extension)];
    const notImportable = exportable.filter((extension) => !isAudioImportExtension(`master.${extension}`));
    expect(notImportable).toEqual([]);
  });

  it("keeps the import gate decode-driven, never encode-driven", () => {
    // The gate may be WIDER than what a browser can encode — that is the whole
    // asymmetry (Firefox decodes AAC but cannot encode it). It must never be
    // narrower than what KYX exports, which is asserted above.
    expect(isAudioImportExtension("master.m4a")).toBe(true);
    expect(isAudioImportExtension("master.ogg")).toBe(true);
  });
});

describe("single-source invariant", () => {
  /**
   * The acceptance rules used to live in four files with three different lists
   * and a "single source" constant nobody imported. A new format added to one
   * surface then silently failed to appear in the others. This pins the
   * surfaces that genuinely share the *sample-library* policy.
   *
   * Scope matters: the external-mastering surfaces
   * (`MasteringFileSessionPanel`, `MasteringReferenceCompare`) accept only
   * WAV/WAVE/MP3/FLAC and keep their own, much larger ceilings (a 128 MiB
   * decoded source and a 12-minute cap). Those are mastering *mixdowns*, not
   * one-shot samples — folding them into the 25 MB sample policy would reject
   * any full-length track someone wants to master. They are deliberately
   * exempt, and `mastering surfaces keep their own policy` below says so
   * out loud so nobody "fixes" them into this list later.
   */
  const SHARED_POLICY_SURFACES = [
    "DropZone.tsx",
    "sample-import.ts",
    "IntakeTray.tsx",
    "TsarPanel.tsx",
    "ReferenceMapPanel.tsx",
  ];

  it("no shared-policy surface redefines the extension list or the ceiling", () => {
    const uiDir = join(REPO_ROOT, "src", "ui");
    const offenders: string[] = [];
    for (const file of SHARED_POLICY_SURFACES) {
      const source = readFileSync(join(uiDir, file), "utf8");
      if (/\/\\\.\((wav|mp3|ogg|flac|aiff|aif)/i.test(source)) offenders.push(`${file}: own extension regex`);
      if (/MAX_AUDIO_IMPORT_BYTES\s*=/.test(source)) offenders.push(`${file}: own size ceiling`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the mastering mixdown surfaces on their own, larger policy", () => {
    const uiDir = join(REPO_ROOT, "src", "ui");
    for (const file of ["MasteringFileSessionPanel.tsx", "MasteringReferenceCompare.tsx"]) {
      const source = readFileSync(join(uiDir, file), "utf8");
      // Narrower by design, and it must NOT defer to the 25 MB sample ceiling.
      expect(source).toMatch(/\.\(wav\|wave\|mp3\|flac\)\$/i);
      expect(source).not.toMatch(/MAX_AUDIO_IMPORT_BYTES/);
      expect(source).not.toMatch(/audio-import-capabilities/);
    }
  });

  it("no source imports the ceiling from a UI component", () => {
    // It used to live in DropZone.tsx and be imported by ReferenceMapPanel —
    // a component file owning a shared policy, which also breaks any test that
    // mocks the component module wholesale.
    const srcDir = join(REPO_ROOT, "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const source = readFileSync(full, "utf8");
          for (const hit of source.match(/import\s*\{[^}]*\}\s*from\s*["'][^"']*DropZone["']/g) ?? []) {
            if (hit.includes("MAX_AUDIO_IMPORT_BYTES")) offenders.push(full.replace(`${REPO_ROOT}\\`, ""));
          }
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

describe("mime list", () => {
  it("has no duplicate entries", () => {
    expect(new Set(AUDIO_IMPORT_MIME_TYPES).size).toBe(AUDIO_IMPORT_MIME_TYPES.length);
    expect(new Set(AUDIO_IMPORT_EXTENSIONS).size).toBe(AUDIO_IMPORT_EXTENSIONS.length);
  });
});

describe("importAudioFile enforces the ceiling before reading bytes", () => {
  /**
   * The ordering is the whole point. A ceiling checked AFTER `arrayBuffer()` has
   * already spent the memory it exists to prevent, so this test replaces the
   * read with a sentinel that fails loudly: if the guard ever moves below the
   * read, the assertion sees the sentinel instead of the size error.
   */
  function oversizedFileWithTripwire(): File {
    const file = new File([new Uint8Array(16)], "huge.wav", { type: "audio/wav" });
    Object.defineProperty(file, "size", { value: MAX_AUDIO_IMPORT_BYTES + 1 });
    Object.defineProperty(file, "arrayBuffer", {
      value: () => Promise.reject(new Error("TRIPWIRE: bytes were read before the ceiling")),
    });
    return file;
  }

  const services = {
    engine: { context: { decodeAudioData: () => Promise.reject(new Error("TRIPWIRE: decode reached")) } },
    bank: { add: () => undefined },
    userSamples: { save: () => Promise.resolve() },
  } as unknown as Parameters<typeof importAudioFile>[0];

  it("refuses an oversized file without ever reading or decoding it", async () => {
    await expect(importAudioFile(services, oversizedFileWithTripwire())).rejects.toThrow(AudioImportTooLargeError);
    // A TRIPWIRE message here would mean the guard runs after the read.
    await expect(importAudioFile(services, oversizedFileWithTripwire())).rejects.not.toThrow(/TRIPWIRE/);
  });

  it("rejects a nonsensical size rather than letting it through", async () => {
    const file = new File([new Uint8Array(4)], "weird.wav", { type: "audio/wav" });
    Object.defineProperty(file, "size", { value: Number.NaN });
    await expect(importAudioFile(services, file)).rejects.toThrow(/unreadable file size/);
  });
});
