import { describe, expect, it } from "vitest";
import { parseSfz } from "../src/sample-library/sfz";
import {
  importSfzLibrary,
  planSfzInstrumentImport,
  SFZ_IMPORT_MAX_BYTES,
  bytesToBase64,
  type SfzImportFile,
} from "../src/sample-library/sfz-import";
import { runSfzInstrumentImport } from "../src/sample-library/sfz-import-run";

/**
 * USER SFZ LIBRARY IMPORT — parser + planner contracts. VSCO2 CE proved the
 * state-machine approach in production conversion (scripts/convert-vsco2.mjs
 * shares the algorithm); these vectors pin the shared parser + the planner's
 * resolution/plan rules for the in-app user import.
 */

const SFZ = [
  "<control>",
  "default_path=Strings\\Cello Section\\susVib\\",
  "",
  "<global>",
  "ampeg_release=0.8",
  "",
  "<group>",
  "lovel=0 hivel=60",
  "",
  "<region>",
  "sample=susvib_A2_v1.wav",
  "lokey=45",
  "hikey=48",
  "pitch_keycenter=46",
  "",
  "<region>",
  "sample=susvib_C4_v1.wav",
  "lokey=59",
  "hikey=62",
  "pitch_keycenter=60",
  "",
  "<group>",
  "lovel=61 hivel=127",
  "",
  "<region>",
  "sample=susvib_A2_v2.wav",
  "lokey=45",
  "hikey=48",
  "pitch_keycenter=46",
  "",
  "<region>",
  "sample=susvib_C4_v2.wav",
  "lokey=59",
  "hikey=62",
  "pitch_keycenter=60",
].join("\r\n");

const files: SfzImportFile[] = [
  { name: "MyLib/Strings/Cello Section/susVib/susvib_A2_v1.wav", data: new ArrayBuffer(8) },
  { name: "MyLib/Strings/Cello Section/susVib/susvib_A2_v2.wav", data: new ArrayBuffer(8) },
  { name: "MyLib/Strings/Cello Section/susVib/susvib_C4_v1.wav", data: new ArrayBuffer(8) },
  { name: "MyLib/Strings/Cello Section/susVib/susvib_C4_v2.wav", data: new ArrayBuffer(8) },
];

describe("parseSfz (shared state-machine parser)", () => {
  it("collects default_path (separate) + regions with opcodes on their own lines", () => {
    const doc = parseSfz(SFZ);
    // default_path is returned SEPARATELY — the consumer joins it when
    // resolving sample files (the converter does path.join; the planner
    // resolves by path suffix).
    expect(doc.defaultPath).toBe("Strings/Cello Section/susVib/");
    expect(doc.regions.length).toBe(4);
    expect(doc.regions[0]).toEqual({
      sample: "susvib_A2_v1.wav",
      lokey: 45,
      hikey: 48,
      keycenter: 46,
      lovel: 0,
      hivel: 60,
    });
  });

  it("handles single-line regions (opcode on the header line)", () => {
    const doc = parseSfz("<region> sample=x.wav lokey=60 hikey=60 pitch_keycenter=60 lovel=0 hivel=127");
    expect(doc.regions.length).toBe(1);
    expect(doc.regions[0].keycenter).toBe(60);
  });

  it("strips // comments and tolerates unknown opcodes", () => {
    const doc = parseSfz(
      ["<region>", "sample=a.wav // the main take", "lokey=60", "weird_future_opcode=42", "hikey=60"].join("\r\n"),
    );
    expect(doc.regions.length).toBe(1);
    expect(doc.regions[0].lokey).toBe(60);
  });
});

describe("planSfzInstrumentImport", () => {
  it("plans one layer per region with root/keyzone/velocity from the SFZ", () => {
    const plan = planSfzInstrumentImport("MyCello.sfz", SFZ, files);
    expect(plan.instrumentName).toBe("MyCello");
    expect(plan.samplePrefix).toBe("user.sfz.mycello");
    expect(plan.regions.length).toBe(4);
    // Key 46, zone 1 (lovel 0..60): root 46, window 0..61/127.
    const first = plan.regions[0];
    expect(first.sampleId).toBe("user.sfz.mycello.k46z1");
    expect(first.layer.root).toBe(46);
    expect(first.layer.minPitch).toBe(45);
    expect(first.layer.maxPitch).toBe(48);
    expect(first.layer.min).toBeCloseTo(0, 5);
    expect(first.layer.max).toBeCloseTo(61 / 127, 3);
  });

  it("resolves samples by case-insensitive suffix of the provided paths", () => {
    const plan = planSfzInstrumentImport("MyCello.sfz", SFZ, files);
    expect(plan.missing.length).toBe(0);
    expect(plan.regions.every((r) => r.fileName.length > 0)).toBe(true);
  });

  it("reports regions whose sample file was not provided", () => {
    const plan = planSfzInstrumentImport("MyCello.sfz", SFZ, [files[2]!]);
    expect(plan.missing.length).toBeGreaterThan(0);
    expect(plan.missing[0].fileName).toContain("susvib_A2_v1.wav");
  });
});

describe("importSfzLibrary — size honesty (agent-surface audit 10-06)", () => {
  it("refuses an oversized request BEFORE decoding anything (clean error, no OOM allocation)", async () => {
    // 256 MB cap → a base64 payload of >4/3·cap chars must be refused from
    // the string length alone, before a single byte is decoded.
    const oversizeChars = Math.ceil((SFZ_IMPORT_MAX_BYTES * 4) / 3) + 16; // > 4/3·cap → decoded > cap
    const oversized = { sfzBase64: "QUFB", samples: [{ fileName: "a.wav", base64: "A".repeat(oversizeChars) }] };
    const sinks = {
      bank: { add: () => undefined },
      userSamples: { put: () => Promise.resolve() },
      decode: () => Promise.resolve({ length: 0 } as unknown as AudioBuffer),
      getDoc: () => ({ id: "x", name: "x", tracks: [], patterns: [], scenes: [], arrangement: { clips: [] } }),
      execute: () => undefined,
    };
    await expect(importSfzLibrary(oversized as never, sinks as never)).rejects.toThrow(/import too large/);
  });
});

describe("SFZ import — persistence rollback (ghost-sample guard)", () => {
  /** A bank stand-in that records exactly what is currently held. */
  function trackingBank() {
    const held = new Set<string>();
    return {
      held,
      bank: {
        has: (id: string) => held.has(id),
        add: (id: string) => void held.add(id),
        remove: (id: string) => void held.delete(id),
      },
    };
  }

  const fakeBuffer = () =>
    ({ duration: 1, sampleRate: 44100, numberOfChannels: 1, length: 44100 }) as unknown as AudioBuffer;

  it("importSfzLibrary removes a failed region's buffer (no ghost sample)", async () => {
    const { held, bank } = trackingBank();
    const sinks = {
      bank,
      // A durable write failure (quota/blocked IndexedDB) must not leave the
      // already-playable buffer behind: the region never reaches the library,
      // so the in-memory bank and the durable store would disagree.
      userSamples: {
        save: async () => {
          throw new Error("QuotaExceededError");
        },
      },
      decode: async () => fakeBuffer(),
      getDoc: () => ({ id: "x", name: "x", tracks: [], patterns: [], scenes: [], arrangement: { clips: [] } }),
      execute: () => undefined,
    };
    const input = {
      name: "MyCello",
      sfzBase64: bytesToBase64(new TextEncoder().encode(SFZ)),
      trackId: "trk",
      samples: [
        { fileName: "susvib_A2_v1.wav", base64: bytesToBase64(new Uint8Array(8)) },
        { fileName: "susvib_A2_v2.wav", base64: bytesToBase64(new Uint8Array(8)) },
        { fileName: "susvib_C4_v1.wav", base64: bytesToBase64(new Uint8Array(8)) },
        { fileName: "susvib_C4_v2.wav", base64: bytesToBase64(new Uint8Array(8)) },
      ],
    };

    await expect(importSfzLibrary(input as never, sinks as never)).rejects.toThrow("QuotaExceededError");
    expect(held.size).toBe(0);
  });

  it("importSfzLibrary keeps regions that persisted before a later region fails", async () => {
    // A multi-region import that fails on a LATER region must not remove the
    // bank buffers of regions whose durable write already committed — that
    // would orphan their library rows (listed, but unplayable this session).
    const { held, bank } = trackingBank();
    let saveCount = 0;
    const sinks = {
      bank,
      userSamples: {
        save: async () => {
          saveCount += 1;
          if (saveCount > 1) throw new Error("QuotaExceededError");
        },
      },
      decode: async () => fakeBuffer(),
      getDoc: () => ({ id: "x", name: "x", tracks: [], patterns: [], scenes: [], arrangement: { clips: [] } }),
      execute: () => undefined,
    };
    const input = {
      name: "MyCello",
      sfzBase64: bytesToBase64(new TextEncoder().encode(SFZ)),
      trackId: "trk",
      samples: [
        { fileName: "susvib_A2_v1.wav", base64: bytesToBase64(new Uint8Array(8)) },
        { fileName: "susvib_A2_v2.wav", base64: bytesToBase64(new Uint8Array(8)) },
        { fileName: "susvib_C4_v1.wav", base64: bytesToBase64(new Uint8Array(8)) },
        { fileName: "susvib_C4_v2.wav", base64: bytesToBase64(new Uint8Array(8)) },
      ],
    };

    await expect(importSfzLibrary(input as never, sinks as never)).rejects.toThrow("QuotaExceededError");
    expect([...held]).toEqual(["user.sfz.mycello.k46z1"]);
  });

  it("runSfzInstrumentImport removes the buffer for a region whose save fails", async () => {
    const { held, bank } = trackingBank();
    const fileLike = (name: string, bytes: Uint8Array) =>
      ({
        name,
        webkitRelativePath: "",
        arrayBuffer: async () => bytes.buffer.slice(0),
      }) as unknown as File;
    const sinks = {
      bank,
      userSamples: {
        save: async () => {
          throw new Error("QuotaExceededError");
        },
      },
      decode: async () => fakeBuffer(),
    };
    const fileList = [
      fileLike("MyCello.sfz", new TextEncoder().encode(SFZ)),
      fileLike("susvib_A2_v1.wav", new Uint8Array(8)),
      fileLike("susvib_A2_v2.wav", new Uint8Array(8)),
      fileLike("susvib_C4_v1.wav", new Uint8Array(8)),
      fileLike("susvib_C4_v2.wav", new Uint8Array(8)),
    ];

    const result = await runSfzInstrumentImport(fileList, sinks as never);
    expect(result.imported).toBe(0);
    expect(result.layers).toHaveLength(0);
    expect(result.failed.length).toBeGreaterThan(0);
    expect(held.size).toBe(0);
  });
});
