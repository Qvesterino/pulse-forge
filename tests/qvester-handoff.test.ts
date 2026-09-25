import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAudioCanvasHandoffUrl,
  buildBeatHandoffPacket,
  buildSourceMapEntries,
  HANDOFF_TTL_MS,
  KYX_ARTIFACT_TYPE,
  KYX_HANDOFF_INTENT,
  keyToCamelot,
  persistBeatHandoffPacket,
  readBeatBlob,
  storeBeatBlob,
  type BeatHandoffRecord,
} from "../src/interop/qvesterHandoff";
import type { ProjectDocument } from "../src/project-model/types";
import { createProjectFromTemplate } from "../src/project-model/templates";

/**
 * QVESTER handoff (KYX beat → Audio Canvas). The packet follows the
 * ecosystem conventions: envelope "2.0", `qvester:handoff:<id>` in session +
 * local storage, artifact value always a STRING (metadata JSON), the WAV
 * itself travels as a `qvester-blob:<hash>` pointer backed by the shared
 * `qvester-audio-handoff` IndexedDB store.
 */

// jsdom's crypto lacks SubtleCrypto — Node's webcrypto provides it.
vi.stubGlobal("crypto", webcrypto);

function fakeRecord(overrides?: Partial<BeatHandoffRecord>): BeatHandoffRecord {
  return {
    hash: "a".repeat(64),
    wav: new TextEncoder().encode("wav").buffer as ArrayBuffer,
    name: "House Beat",
    bpm: 124,
    key: "C",
    mode: "major",
    camelot: "8B",
    durationSec: 9.6,
    sampleRate: 44100,
    byteLength: 3,
    createdAt: Date.now(),
    beatGridOffsetSec: 0,
    genre: null,
    bpmConfidence: 0.9,
    ...overrides,
  };
}

function fakeDoc(): ProjectDocument {
  return { name: "House Beat", bpm: 124, key: "A Natural Minor" } as unknown as ProjectDocument;
}

describe("keyToCamelot (KYX MusicalKey → interop profile metadata)", () => {
  it("maps the Camelot wheel correctly for major and relative minor", () => {
    expect(keyToCamelot("C Major")).toEqual({ key: "C", mode: "major", camelot: "8B" });
    expect(keyToCamelot("A Natural Minor")).toEqual({ key: "A", mode: "minor", camelot: "8A" });
    expect(keyToCamelot("G Major")).toEqual({ key: "G", mode: "major", camelot: "9B" });
    expect(keyToCamelot("F Natural Minor")).toEqual({ key: "F", mode: "minor", camelot: "4A" });
  });

  it("treats minor-family modes as minor and maps their roots", () => {
    expect(keyToCamelot("D Dorian")).toEqual({ key: "D", mode: "minor", camelot: "7A" });
    expect(keyToCamelot("C# Harmonic Minor")).toEqual({ key: "C#", mode: "minor", camelot: "12A" });
    expect(keyToCamelot("F# Pentatonic Major")).toEqual({ key: "F#", mode: "major", camelot: "2B" });
  });

  it("returns nulls for absent keys", () => {
    expect(keyToCamelot(undefined)).toEqual({ key: null, mode: null, camelot: null });
  });
});

describe("beat handoff packet", () => {
  it("carries the ecosystem envelope with a pointer artifact, never the bytes", () => {
    const record = fakeRecord();
    const packet = buildBeatHandoffPacket(record, fakeDoc());
    expect(packet.version).toBe("2.0");
    expect(packet.sourceApp).toBe("pulse_forge");
    expect(packet.targetApp).toBe("audio_canvas");
    expect(packet.intent).toBe(KYX_HANDOFF_INTENT);
    expect(packet.ttl).toBe(HANDOFF_TTL_MS);
    expect(packet.expiresAt - packet.createdAt).toBe(HANDOFF_TTL_MS);

    const [artifact] = packet.payload.inputs;
    expect(artifact?.type).toBe(KYX_ARTIFACT_TYPE);
    expect(artifact?.uri).toBe(`qvester-blob:${record.hash}`);
    // The WAV must travel by pointer — the value carries metadata only.
    expect(artifact?.value).not.toContain("wav");
    const metadata = JSON.parse(artifact!.value!) as { bpm: number; camelot: string };
    expect(metadata.bpm).toBe(124);
    expect(metadata.camelot).toBe("8A"); // from the DOC key, not the record's
    expect(packet.returnTarget).toEqual({ appId: "pulse_forge", route: "/pulse-forge", mode: "manual" });
  });

  it("persists to both web stores and builds the Audio Canvas URL", () => {
    sessionStorage.clear();
    localStorage.clear();
    const packet = buildBeatHandoffPacket(fakeRecord(), fakeDoc());
    expect(persistBeatHandoffPacket(packet)).toBe(true);
    const key = `qvester:handoff:${packet.handoffId}`;
    expect(sessionStorage.getItem(key)).not.toBeNull();
    expect(localStorage.getItem(key)).not.toBeNull();
    expect(buildAudioCanvasHandoffUrl(packet, "https://qvesterstudio.com")).toBe(
      `https://qvesterstudio.com/audio-canvas?handoff=${encodeURIComponent(packet.handoffId)}&handoffIntent=${KYX_HANDOFF_INTENT}`,
    );
  });

  it("survives a storage failure on one store if the other accepts", () => {
    sessionStorage.clear();
    localStorage.clear();
    const setItem = Storage.prototype.setItem;
    vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    try {
      const packet = buildBeatHandoffPacket(fakeRecord(), fakeDoc());
      expect(persistBeatHandoffPacket(packet)).toBe(true);
      expect(localStorage.getItem(`qvester:handoff:${packet.handoffId}`)).not.toBeNull();
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });

  it("prunes expired and unparseable packet keys from both stores on the next persist", () => {
    sessionStorage.clear();
    localStorage.clear();
    const expiredPacket = buildBeatHandoffPacket(fakeRecord(), fakeDoc());
    const expiredKey = `qvester:handoff:${expiredPacket.handoffId}`;
    const stalePayload = JSON.stringify({ ...expiredPacket, expiresAt: Date.now() - 1, handoffId: "stale" });
    sessionStorage.setItem(expiredKey, stalePayload);
    localStorage.setItem(expiredKey, stalePayload);
    localStorage.setItem("qvester:handoff:garbage", "{not json");
    localStorage.setItem("unrelated:key", "keep me");
    const packet = buildBeatHandoffPacket(fakeRecord(), fakeDoc());
    expect(persistBeatHandoffPacket(packet)).toBe(true);
    // Expired + unparseable keys are gone from BOTH stores...
    expect(sessionStorage.getItem(expiredKey)).toBeNull();
    expect(localStorage.getItem(expiredKey)).toBeNull();
    expect(localStorage.getItem("qvester:handoff:garbage")).toBeNull();
    // ...the unrelated key survives, and the fresh packet is present.
    expect(localStorage.getItem("unrelated:key")).toBe("keep me");
    expect(localStorage.getItem(`qvester:handoff:${packet.handoffId}`)).not.toBeNull();
    expect(sessionStorage.getItem(`qvester:handoff:${packet.handoffId}`)).not.toBeNull();
  });
});

describe("beat blob store (shared IndexedDB)", () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
  });

  afterEach(() => {
    // fake-indexeddb/auto installs a global; reset between tests.
    indexedDB = new IDBFactory();
  });

  it("round-trips the record by content hash", async () => {
    const record = fakeRecord({ hash: "b".repeat(64) });
    await storeBeatBlob(record);
    const read = await readBeatBlob(record.hash);
    expect(read?.name).toBe("House Beat");
    expect(read?.wav.byteLength).toBe(record.wav.byteLength);
    expect(new TextDecoder().decode(read!.wav)).toBe("wav");
    expect(await readBeatBlob("c".repeat(64))).toBeNull();
  });

  it("prunes records older than 24 h except the fresh one", async () => {
    const old = fakeRecord({ hash: "1".repeat(64), createdAt: Date.now() - 25 * 60 * 60 * 1000 });
    const fresh = fakeRecord({ hash: "2".repeat(64) });
    await storeBeatBlob(old);
    await storeBeatBlob(fresh);
    expect(await readBeatBlob(old.hash)).toBeNull();
    expect(await readBeatBlob(fresh.hash)).not.toBeNull();
  });
});

describe("source map (instrument mapping)", () => {
  it("maps every non-group track to its role via roleOfTrack", () => {
    const doc = createProjectFromTemplate("house");
    const entries = buildSourceMapEntries(doc);
    expect(entries.length).toBeGreaterThan(0);
    const roles = entries.map((e) => e.role);
    expect(roles).toContain("drums");
    expect(roles).toContain("bass");
    expect(entries.every((e) => e.trackId.length > 0 && e.trackName.length > 0)).toBe(true);
  });

  it("caps the map at six stems", () => {
    const doc = createProjectFromTemplate("house");
    // pad with extra non-group tracks beyond the cap
    const base = doc.tracks[doc.tracks.length - 1]!;
    for (let i = 0; i < 9; i++) {
      doc.tracks.push({ ...(base as object), id: `extra-${i}`, name: `Extra ${i}` } as never);
    }
    const entries = buildSourceMapEntries(doc);
    expect(entries.length).toBeLessThanOrEqual(6);
  });

  it("carries the source map as a second artifact with per-stem pointers", () => {
    const doc = createProjectFromTemplate("house");
    const record = fakeRecord();
    const sourceMap = [
      { hash: "d".repeat(64), trackName: "Drums", role: "drums", durationSec: 9.6, byteLength: 100 },
      { hash: "e".repeat(64), trackName: "808", role: "bass", durationSec: 9.6, byteLength: 100 },
    ];
    const packet = buildBeatHandoffPacket(record, doc, sourceMap);
    expect(packet.payload.inputs.length).toBe(2);
    const map = packet.payload.inputs[1]!;
    expect(map.type).toBe("kyx_source_map");
    const parsed = JSON.parse(map.value!) as { stems: Array<{ trackName: string; role: string; hash: string }> };
    expect(parsed.stems.length).toBe(2);
    expect(parsed.stems[0]).toMatchObject({ trackName: "Drums", role: "drums", hash: "d".repeat(64) });
    expect(map.metadata).toMatchObject({ roles: ["drums", "bass"] });
  });

  it("omits the source map artifact when no stems are mapped", () => {
    const packet = buildBeatHandoffPacket(fakeRecord(), fakeDoc(), []);
    expect(packet.payload.inputs.length).toBe(1);
    expect(packet.payload.inputs[0]!.type).toBe("audio_master");
  });
});
