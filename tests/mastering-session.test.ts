import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { Blob as NodeBlob } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { fingerprintEncodedMasterAsync } from "../src/mastering/fingerprintClient";
import { IncrementalSha256 } from "../src/mastering/sha256";
import { MasterAnalysisAccumulator } from "../src/mastering/analysis";
import { analyzeMasterPcmStreamAsync } from "../src/mastering/analysisClient";
import { applyMasteringAlbumGainInPlace, planMasteringAlbumGainAdjustment } from "../src/mastering/albumNormalization";
import { MASTER_PROFILES } from "../src/mastering/profiles";

type FlacDecoderMock = {
  ready: Promise<void>;
  decodeFile: ReturnType<typeof vi.fn>;
  free: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

const flacDecoderMock = vi.hoisted(() => ({
  instances: [] as FlacDecoderMock[],
  ready: undefined as Promise<void> | undefined,
  decodeFile: undefined as ((encoded: Uint8Array) => Promise<unknown>) | undefined,
}));

vi.mock("@wasm-audio-decoders/flac", () => ({
  FLACDecoderWebWorker: class {
    ready = flacDecoderMock.ready ?? Promise.resolve();
    decodeFile = vi.fn(
      (encoded: Uint8Array) =>
        flacDecoderMock.decodeFile?.(encoded) ??
        Promise.resolve({
          errors: [],
          channelData: [new Float32Array(35_280)],
          samplesDecoded: 35_280,
          sampleRate: 44_100,
          bitDepth: 16,
        }),
    );
    free = vi.fn(async () => undefined);
    terminate = vi.fn();

    constructor() {
      flacDecoderMock.instances.push(this as unknown as FlacDecoderMock);
    }
  },
}));
import {
  captureMasteringSnapshot,
  loadMasteringABSession,
  replaceSnapshot,
  saveMasteringABSession,
} from "../src/mastering/snapshots";
import { MasteringReferenceRepository } from "../src/mastering/referenceRepository";
import type { MasteringReferenceRecord } from "../src/mastering/referenceRepository";
import {
  captureMasteringSessionSnapshot,
  clearMasteringSessionSnapshot,
  createMasteringSessionRecord,
  MASTERING_SESSION_DATABASE,
  MASTERING_SESSION_DATABASE_VERSION,
  MASTERING_SESSION_REFERENCE_STORE,
  MASTERING_SESSION_SCHEMA_VERSION,
  MASTERING_SESSION_SOURCE_STORE,
  MASTERING_SESSION_STORE,
  MasteringSessionRepository,
  updateMasteringSessionConfig,
  undoMasteringSessionConfig,
} from "../src/mastering/sessionStore";
import {
  assertMasteringSessionWorkingSetBudget,
  createMasteringSessionRenderDocument,
  estimateMasteringSessionComparisonBytes,
  estimateMasteringSessionWorkingSetBytes,
  masteringSessionTimelineSeconds,
  MAX_MASTERING_SESSION_WORKING_SET_BYTES,
  renderMasteringSessionSource,
} from "../src/mastering/sessionRender";
import { MASTERING_RENDER_SAMPLE_RATES } from "../src/mastering/sampleRates";
import { decodeFlacAudioBuffer } from "../src/mastering/flacDecode";
import {
  addMasteringAlbumTrack,
  createMasteringAlbum,
  estimateMasteringAlbumDuration,
  MasteringAlbumRepository,
  moveMasteringAlbumTrack,
  summarizeMasteringAlbumDelivery,
  setMasteringAlbumGap,
  updateMasteringAlbumTrackDelivery,
  validateMasteringAlbum,
  type MasteringAlbumDeliverySummary,
} from "../src/mastering/albumStore";
import { MasteringAlbumPanel } from "../src/ui/MasteringAlbumPanel";
import type { MasteringSessionSummary } from "../src/mastering/sessionStore";
import type { SampleBank } from "../src/sample-library/factory";
import { testDoc } from "./fixtures/doc";

function projectWithId(id: string) {
  return { ...testDoc(), id };
}

function createTestMasteringSession(id: string) {
  const now = "2026-10-07T12:00:00.000Z";
  return createMasteringSessionRecord({
    id,
    fileName: `${id}.wav`,
    mimeType: "audio/wav",
    source: new NodeBlob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" }) as unknown as Blob,
    sourceHash: "a".repeat(64),
    durationSeconds: 1,
    channels: 2,
    sourceSampleRate: 44_100,
    sourceBitDepth: 24,
    masterConfig: testDoc().master,
    createdAt: now,
  });
}

function testAlbumDeliverySummary(
  overrides: Partial<MasteringAlbumDeliverySummary> = {},
): MasteringAlbumDeliverySummary {
  return {
    sourceHash: "a".repeat(64),
    configRevision: 0,
    generatedAt: "2026-10-10T12:00:00.000Z",
    fileName: "mastered.wav",
    format: "wav",
    decodeStatus: "measured",
    lufsIntegrated: -14,
    truePeakDb: -1,
    ...overrides,
  };
}

function createTestMasteringSummary(id: string): MasteringSessionSummary {
  const { source, ...summary } = createTestMasteringSession(id);
  void source;
  return summary;
}

async function seedVersionOneMasteringDatabase(): Promise<void> {
  const now = "2026-10-07T12:00:00.000Z";
  const config = testDoc().master;
  const oldSummary = {
    version: 1,
    id: "legacy-v1-session",
    fileName: "legacy.wav",
    mimeType: "audio/wav",
    byteLength: 4,
    sourceHash: "b".repeat(64),
    durationSeconds: 1,
    channels: 2,
    sourceSampleRate: 44_100,
    masterConfig: config,
    configRevision: 0,
    undoStack: [],
    redoStack: [],
    createdAt: now,
    updatedAt: now,
  };
  const open = indexedDB.open(MASTERING_SESSION_DATABASE, 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore(MASTERING_SESSION_STORE, { keyPath: "id" });
    open.result.createObjectStore(MASTERING_SESSION_SOURCE_STORE, { keyPath: "id" });
  };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("Could not seed the v1 mastering database."));
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([MASTERING_SESSION_STORE, MASTERING_SESSION_SOURCE_STORE], "readwrite");
    tx.objectStore(MASTERING_SESSION_STORE).put(oldSummary);
    tx.objectStore(MASTERING_SESSION_SOURCE_STORE).put({
      id: oldSummary.id,
      source: new NodeBlob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" }),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not store the v1 mastering fixture."));
    tx.onabort = () => reject(tx.error ?? new Error("The v1 mastering fixture transaction was aborted."));
  });
  db.close();
}

describe("external mastering session persistence", () => {
  it("migrates saved v1 sessions to the named A/B snapshot slots", async () => {
    await seedVersionOneMasteringDatabase();
    const repository = new MasteringSessionRepository();
    const listed = await repository.list();
    const loaded = await repository.get("legacy-v1-session");
    expect(MASTERING_SESSION_DATABASE_VERSION).toBe(4);
    expect(MASTERING_SESSION_SCHEMA_VERSION).toBe(2);
    expect(listed[0]).toMatchObject({ version: 2, snapshots: { A: null, B: null } });
    expect(loaded?.snapshots).toEqual({ A: null, B: null });
    expect(loaded?.source.size).toBe(4);
    await repository.delete("legacy-v1-session");
  });

  it("keeps named snapshots independent while loading them remains undoable", () => {
    const session = createTestMasteringSession("named-version-session");
    const a = captureMasteringSessionSnapshot(session, "A", "Warm / open", "2026-10-07T12:01:00.000Z");
    const changed = updateMasteringSessionConfig(a, { ...a.masterConfig, masterGain: 1.25 });
    const b = captureMasteringSessionSnapshot(changed, "B", "Punchier", "2026-10-07T12:02:00.000Z");

    expect(b.snapshots.A?.name).toBe("Warm / open");
    expect(b.snapshots.A?.masterConfig.masterGain).not.toBe(1.25);
    expect(b.snapshots.B).toMatchObject({ name: "Punchier", masterConfig: { masterGain: 1.25 } });
    expect(undoMasteringSessionConfig(b).masterConfig.masterGain).toBe(session.masterConfig.masterGain);
    expect(clearMasteringSessionSnapshot(b, "A").snapshots.A).toBeNull();
    expect(() => captureMasteringSessionSnapshot(session, "A", "   ")).toThrow(/1 to 64 characters/);
  });

  it("round-trips the immutable source with saved A/B session versions", async () => {
    const repository = new MasteringSessionRepository();
    const id = `round-trip-${Date.now()}`;
    const original = createTestMasteringSession(id);
    const withSnapshot = captureMasteringSessionSnapshot(original, "A", "Approved master");
    let stage = "put";
    try {
      await repository.put(withSnapshot);
      stage = "list";
      const listed = await repository.list();
      stage = "get";
      const loaded = await repository.get(id);
      expect(listed.find((item) => item.id === id)?.snapshots.A?.name).toBe("Approved master");
      expect(loaded?.snapshots.A?.masterConfig).toEqual(original.masterConfig);
      expect(loaded?.source.size).toBe(original.source.size);
      expect(loaded?.sourceBitDepth).toBe(24);
      stage = "delete";
      await repository.delete(id);
      await expect(repository.get(id)).resolves.toBeNull();
    } catch (error) {
      throw new Error(`Mastering session repository failed during ${stage}: ${String(error)}`);
    }
  });

  it("stores bounded schema-v8 gain-normalization metadata in checked delivery reports", async () => {
    const repository = new MasteringSessionRepository();
    const session = createTestMasteringSession(`gain-report-${Date.now()}`);
    const fileName = "gain-report-mastered.wav";
    const reportFileName = fileName.replace(/\.wav$/i, "-report.json");
    const createdAt = new Date().toISOString();
    const albumNormalization = {
      status: "applied",
      targetLufs: -14,
      truePeakCeilingDbtp: -1.5,
      maximumGainDb: 12,
      sourceLufs: -18,
      sourceTruePeakDbtp: -8,
      requestedGainDb: 4,
      appliedGainDb: 4,
      peakLimited: false,
      maximumGainLimited: false,
      targetReached: true,
      postEncodeTruePeakDbtp: -4,
      postEncodeCeilingExceeded: false,
    };
    const reportJson = JSON.stringify({
      schema: "kyx.external-mastering-report",
      schemaVersion: 8,
      generatedAt: createdAt,
      session: { id: session.id, revision: session.configRevision },
      source: { fileName: session.fileName, sha256: session.sourceHash },
      render: { runtimeDiagnostics: { degradedEffects: [], degradedMasterStages: [] } },
      delivery: { fileName, albumNormalization },
    });
    try {
      await repository.put(session);
      const report = {
        id: `${session.id}:${fileName}`,
        sessionId: session.id,
        sourceFileName: session.fileName,
        sourceHash: session.sourceHash,
        fileName,
        reportFileName,
        createdAt,
        reportJson,
      };
      await repository.putDeliveryReport(report);
      expect(await repository.listRecentDeliveryReports()).toEqual([report]);

      const invalidSidecar = JSON.parse(reportJson);
      invalidSidecar.delivery.albumNormalization.status = "unknown";
      await expect(
        repository.putDeliveryReport({ ...report, reportJson: JSON.stringify(invalidSidecar) }),
      ).rejects.toThrow(/invalid, oversized or uses an unsupported schema/);
    } finally {
      await repository.delete(session.id);
    }
  });

  it("persists each reference in a separate session store and deletes it with its session", async () => {
    const repository = new MasteringSessionRepository();
    const id = `reference-session-${Date.now()}`;
    const session = createTestMasteringSession(id);
    await repository.put(session);
    const reference = {
      sessionId: id,
      fileName: "reference.wav",
      mimeType: "audio/wav",
      byteLength: 4,
      source: new NodeBlob([new Uint8Array([5, 6, 7, 8])], { type: "audio/wav" }) as unknown as Blob,
      sourceHash: "c".repeat(64),
      durationSeconds: 1,
      channels: 2 as const,
      sampleRate: 44_100,
      importedAt: "2026-10-07T12:03:00.000Z",
    };
    await repository.putReference(reference);
    await expect(repository.getReference(id)).resolves.toMatchObject({
      sessionId: id,
      fileName: "reference.wav",
      sourceHash: "c".repeat(64),
      source: { size: 4 },
    });
    expect(await repository.list()).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));

    const dbRequest = indexedDB.open(MASTERING_SESSION_DATABASE, MASTERING_SESSION_DATABASE_VERSION);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      dbRequest.onsuccess = () => resolve(dbRequest.result);
      dbRequest.onerror = () => reject(dbRequest.error ?? new Error("Could not inspect mastering stores."));
    });
    expect(db.objectStoreNames.contains(MASTERING_SESSION_REFERENCE_STORE)).toBe(true);
    db.close();

    await repository.delete(id);
    await expect(repository.getReference(id)).resolves.toBeNull();
  });

  it("preserves IndexedDB quota errors from asynchronous reference writes", async () => {
    const repository = new MasteringSessionRepository();
    const id = `reference-quota-${Date.now()}`;
    await repository.put(createTestMasteringSession(id));
    const reference = {
      sessionId: id,
      fileName: "reference.wav",
      mimeType: "audio/wav",
      byteLength: 4,
      source: new NodeBlob([new Uint8Array([5, 6, 7, 8])], { type: "audio/wav" }) as unknown as Blob,
      sourceHash: "d".repeat(64),
      durationSeconds: 1,
      channels: 2 as const,
      sampleRate: 44_100,
      importedAt: "2026-10-07T12:04:00.000Z",
    };
    const originalPut = IDBObjectStore.prototype.put;
    Object.defineProperty(IDBObjectStore.prototype, "put", {
      configurable: true,
      writable: true,
      value: function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
        if (this.name === MASTERING_SESSION_REFERENCE_STORE) {
          throw new DOMException("Simulated storage exhaustion", "QuotaExceededError");
        }
        if (arguments.length > 1) return originalPut.call(this, value, key);
        return originalPut.call(this, value);
      },
    });
    try {
      await expect(repository.putReference(reference)).rejects.toMatchObject({ name: "QuotaExceededError" });
      await expect(repository.getReference(id)).resolves.toBeNull();
    } finally {
      Object.defineProperty(IDBObjectStore.prototype, "put", {
        configurable: true,
        writable: true,
        value: originalPut,
      });
    }
    await repository.delete(id);
  });
});

describe("external mastering album sequences", () => {
  it("applies one uniform gain to the rendered PCM without dynamics processing", () => {
    const left = new Float32Array([0.5, -0.25]);
    const right = new Float32Array([-0.125, 0.0625]);
    const channels = [left, right];
    const buffer = {
      numberOfChannels: channels.length,
      getChannelData: (channel: number) => channels[channel]!,
    } as unknown as AudioBuffer;
    applyMasteringAlbumGainInPlace(buffer, 20 * Math.log10(2));
    expect(Array.from(left)).toEqual([1, -0.5]);
    expect(Array.from(right)).toEqual([-0.25, 0.125]);
  });

  it("uses gain-only loudness matching with a true-peak guard and explicit boost cap", () => {
    const matched = planMasteringAlbumGainAdjustment({
      targetLufs: -14,
      truePeakCeilingDbtp: -1.5,
      maximumGainDb: 12,
      sourceLufs: -18,
      sourceTruePeakDbtp: -8,
    });
    expect(matched).toMatchObject({ status: "applied", requestedGainDb: 4, appliedGainDb: 4, targetReached: true });

    const peakLimited = planMasteringAlbumGainAdjustment({
      targetLufs: -14,
      truePeakCeilingDbtp: -1,
      maximumGainDb: 12,
      sourceLufs: -18,
      sourceTruePeakDbtp: -2,
    });
    expect(peakLimited).toMatchObject({ appliedGainDb: 1, peakLimited: true, targetReached: false });

    const boostLimited = planMasteringAlbumGainAdjustment({
      targetLufs: -14,
      truePeakCeilingDbtp: -1,
      maximumGainDb: 12,
      sourceLufs: -35,
      sourceTruePeakDbtp: -30,
    });
    expect(boostLimited).toMatchObject({ appliedGainDb: 12, maximumGainLimited: true, peakLimited: false });

    const peakOnly = planMasteringAlbumGainAdjustment({
      targetLufs: -14,
      truePeakCeilingDbtp: -1.5,
      maximumGainDb: 12,
      sourceLufs: null,
      sourceTruePeakDbtp: -0.1,
    });
    expect(peakOnly).toMatchObject({ status: "loudness-unavailable", appliedGainDb: -1.4, targetReached: false });

    const noPeakMeasure = planMasteringAlbumGainAdjustment({
      targetLufs: -14,
      truePeakCeilingDbtp: -1.5,
      maximumGainDb: 12,
      sourceLufs: -18,
      sourceTruePeakDbtp: null,
    });
    expect(noPeakMeasure).toMatchObject({ status: "true-peak-unavailable", appliedGainDb: 0, targetReached: false });
  });

  it("persists an ordered session list and estimates runtime including editable gaps", async () => {
    const repository = new MasteringAlbumRepository();
    const id = `album-${Date.now()}`;
    let album = createMasteringAlbum("Night Drive", "2026-10-10T12:00:00.000Z");
    album = { ...album, id };
    album = addMasteringAlbumTrack(album, "session-a", "2026-10-10T12:01:00.000Z");
    album = addMasteringAlbumTrack(album, "session-b", "2026-10-10T12:02:00.000Z");
    expect(album.tracks[0]?.gapAfterSeconds).toBe(2);

    album = moveMasteringAlbumTrack(album, album.tracks[1]!.id, -1, "2026-10-10T12:03:00.000Z");
    album = setMasteringAlbumGap(album, album.tracks[0]!.id, 1.25, "2026-10-10T12:04:00.000Z");
    expect(album.tracks.map((track) => track.sessionId)).toEqual(["session-b", "session-a"]);
    expect(album.tracks[0]?.gapAfterSeconds).toBe(1.3);
    expect(
      estimateMasteringAlbumDuration(
        album,
        new Map([
          ["session-a", 5],
          ["session-b", 10],
        ]),
      ),
    ).toBe(16.3);
    expect(estimateMasteringAlbumDuration(album, new Map([["session-a", 5]]))).toBeNull();

    try {
      await repository.save(album);
      await expect(repository.list()).resolves.toEqual([album]);
    } finally {
      await repository.delete(id);
    }
  });

  it("rejects duplicate sessions, invalid gaps, and malformed saved records", () => {
    let album = createMasteringAlbum("EP", "2026-10-10T12:00:00.000Z");
    album = addMasteringAlbumTrack(album, "session-a", "2026-10-10T12:01:00.000Z");
    expect(() => addMasteringAlbumTrack(album, "session-a")).toThrow(/already in the album/);
    expect(() => setMasteringAlbumGap(album, album.tracks[0]!.id, 31)).toThrow(/between 0 and 30/);
    expect(() =>
      validateMasteringAlbum({ ...album, tracks: [{ ...album.tracks[0], gapAfterSeconds: Number.NaN }] }),
    ).toThrow(/invalid metadata or track links/);
  });

  it("summarizes only current decoded delivery revisions and labels stale or unmeasured tracks", () => {
    let album = createMasteringAlbum("Night Drive", "2026-10-10T12:00:00.000Z");
    album = addMasteringAlbumTrack(album, "track-loud");
    album = addMasteringAlbumTrack(album, "track-quiet");
    album = addMasteringAlbumTrack(album, "track-stale");
    album = addMasteringAlbumTrack(album, "track-header-only");
    album = updateMasteringAlbumTrackDelivery(
      album,
      "track-loud",
      testAlbumDeliverySummary({ lufsIntegrated: -12.5, truePeakDb: -0.8, fileName: "loud.wav" }),
    );
    album = updateMasteringAlbumTrackDelivery(
      album,
      "track-quiet",
      testAlbumDeliverySummary({ lufsIntegrated: -14.5, truePeakDb: -1.4, fileName: "quiet.flac", format: "flac" }),
    );
    album = updateMasteringAlbumTrackDelivery(
      album,
      "track-stale",
      testAlbumDeliverySummary({ lufsIntegrated: -16, truePeakDb: -2, fileName: "stale.mp3", format: "mp3" }),
    );
    album = updateMasteringAlbumTrackDelivery(
      album,
      "track-header-only",
      testAlbumDeliverySummary({
        fileName: "header-only.mp3",
        format: "mp3",
        decodeStatus: "not-measured",
        lufsIntegrated: null,
        truePeakDb: null,
      }),
    );
    const sessionMap = new Map([
      ["track-loud", { id: "track-loud", fileName: "loud.wav", sourceHash: "a".repeat(64), configRevision: 0 }],
      ["track-quiet", { id: "track-quiet", fileName: "quiet.flac", sourceHash: "a".repeat(64), configRevision: 0 }],
      ["track-stale", { id: "track-stale", fileName: "stale.mp3", sourceHash: "a".repeat(64), configRevision: 1 }],
      [
        "track-header-only",
        { id: "track-header-only", fileName: "header-only.mp3", sourceHash: "a".repeat(64), configRevision: 0 },
      ],
    ]);

    const report = summarizeMasteringAlbumDelivery(album, sessionMap);
    expect(report.currentReportCount).toBe(3);
    expect(report.measuredTrackCount).toBe(2);
    expect(report.lufsMeasuredTrackCount).toBe(2);
    expect(report.lufsMedian).toBe(-13.5);
    expect(report.lufsSpreadDb).toBe(2);
    expect(report.truePeakMeasuredTrackCount).toBe(2);
    expect(report.truePeakMaxDb).toBe(-0.8);
    expect(report.tracks.map((track) => track.state)).toEqual(["measured", "measured", "stale", "not-measured"]);
    expect(report.tracks[0]?.lufsOffsetFromMedianDb).toBe(1);
    expect(report.tracks[1]?.lufsOffsetFromMedianDb).toBe(-1);
    expect(report.tracks[2]?.lufsOffsetFromMedianDb).toBeNull();
  });

  it("persists compact delivery summaries across albums without overwriting concurrent sequence edits", async () => {
    const repository = new MasteringAlbumRepository();
    const firstId = `delivery-album-a-${Date.now()}`;
    const secondId = `delivery-album-b-${Date.now()}`;
    const summary = testAlbumDeliverySummary({ lufsIntegrated: -13.2, truePeakDb: -1.3 });
    const first = addMasteringAlbumTrack({ ...createMasteringAlbum("Album A"), id: firstId }, "delivery-session");
    const second = addMasteringAlbumTrack({ ...createMasteringAlbum("Album B"), id: secondId }, "delivery-session");
    try {
      await repository.save(first);
      await repository.save(second);
      await expect(repository.updateSessionDeliverySummary("delivery-session", summary)).resolves.toBe(2);

      // This edit is based on a pre-report album object, as can happen if a
      // user reorders while an export finishes. The repository keeps the
      // report for surviving track IDs while applying the sequence edit.
      await repository.save({ ...first, title: "Album A revised", updatedAt: "2026-10-10T13:00:00.000Z" });
      const records = await repository.list();
      expect(records.find((album) => album.id === firstId)?.tracks[0]?.deliverySummary).toEqual(summary);
      expect(records.find((album) => album.id === firstId)?.title).toBe("Album A revised");
      expect(records.find((album) => album.id === secondId)?.tracks[0]?.deliverySummary).toEqual(summary);
    } finally {
      await repository.delete(firstId);
      await repository.delete(secondId);
    }
  });

  it("lets a user create an album, add sessions, and reorder the track list", async () => {
    const repository = new MasteringAlbumRepository();
    const sessions = [createTestMasteringSummary("ui-song-a"), createTestMasteringSummary("ui-song-b")];
    const onAudition = vi.fn();
    const onBatchExport = vi.fn();
    const view = render(
      createElement(MasteringAlbumPanel, {
        sessions,
        activeSessionId: "ui-song-a",
        onOpenSession: vi.fn(),
        onAudition,
        onBatchExport,
      }),
    );

    fireEvent.change(screen.getByRole("textbox", { name: "New album title" }), {
      target: { value: "Road EP" },
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Create album" }));
      await screen.findByText("Created album sequence “Road EP”.");
      fireEvent.click(screen.getByRole("button", { name: "Add track" }));
      await waitFor(() =>
        expect(within(screen.getByRole("list", { name: "Road EP track order" })).getAllByRole("listitem")).toHaveLength(
          1,
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "Audition album sequence" }));
      expect(onAudition).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Road EP", tracks: [expect.objectContaining({ sessionId: "ui-song-a" })] }),
      );

      fireEvent.change(screen.getByRole("combobox", { name: "Mastering session to add to album" }), {
        target: { value: "ui-song-b" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add track" }));
      await waitFor(() =>
        expect(within(screen.getByRole("list", { name: "Road EP track order" })).getAllByRole("listitem")).toHaveLength(
          2,
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "Move ui-song-b.wav up" }));

      await waitFor(() => {
        const rows = within(screen.getByRole("list", { name: "Road EP track order" })).getAllByRole("listitem");
        expect(rows[0]).toHaveTextContent("ui-song-b.wav");
        expect(rows[1]).toHaveTextContent("ui-song-a.wav");
      });
      expect(screen.getByText("Estimated sequence duration: 0:02")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("checkbox", { name: "Match album track loudness using gain only" }));
      fireEvent.change(screen.getByRole("spinbutton", { name: "Album batch target integrated loudness in LUFS" }), {
        target: { value: "-16" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Audition gain-matched sequence" }));
      expect(onAudition).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Road EP" }), {
        targetLufs: -16,
        truePeakCeilingDbtp: -1.5,
        maximumGainDb: 12,
      });
      fireEvent.click(screen.getByRole("button", { name: "Export 2 tracks" }));
      expect(onBatchExport).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Road EP", tracks: expect.any(Array) }),
        expect.objectContaining({
          format: "wav",
          sampleRate: 44_100,
          bitDepth: 24,
          normalizeToLufs: -16,
          truePeakCeilingDbtp: -1.5,
          maximumGainDb: 12,
        }),
      );

      await repository.updateSessionDeliverySummary("ui-song-a", testAlbumDeliverySummary());
      view.rerender(
        createElement(MasteringAlbumPanel, {
          sessions,
          activeSessionId: "ui-song-a",
          deliveryRefreshToken: 1,
          onOpenSession: vi.fn(),
        }),
      );
      expect(await screen.findByText(/1\/2 current export reports · 1 decoded/)).toBeInTheDocument();
      expect(await screen.findByText(/Current WAV · -14\.0 LUFS-I · -1\.0 dBTP · mastered\.wav/)).toBeInTheDocument();
    } finally {
      for (const album of await repository.list()) {
        if (album.title === "Road EP") await repository.delete(album.id);
      }
    }
  });
});

describe("mastering A/B session snapshots", () => {
  beforeEach(() => sessionStorage.clear());

  it("round-trips complete, cloned master configurations per project", () => {
    const doc = projectWithId("snapshot-project-a");
    const config = {
      ...doc.master,
      masterGain: 1.35,
      deliveryProfileId: "vinyl" as const,
      deliveryTruePeakDb: -2,
      limiterTransientLink: 0.35,
      limiterReleaseLink: 0.65,
      effects: [
        {
          id: "master-zenit-snapshot",
          type: "zenit" as const,
          bypassed: false,
          params: { ceiling: -1.5, limit: 0.25, glue: 0.2 },
        },
      ],
    };
    const snapshot = captureMasteringSnapshot(config);
    const session = replaceSnapshot(loadMasteringABSession(doc), "A", snapshot);

    config.effects[0]!.params.ceiling = -4;
    expect(saveMasteringABSession(session)).toBe(true);

    const loaded = loadMasteringABSession(doc);
    expect(loaded.a?.id).toBe(snapshot.id);
    expect(loaded.a?.config).toMatchObject({
      masterGain: 1.35,
      deliveryProfileId: "vinyl",
      deliveryTruePeakDb: -2,
      limiterTransientLink: 0.35,
      limiterReleaseLink: 0.65,
      effects: [{ id: "master-zenit-snapshot", type: "zenit", params: { ceiling: -1.5 } }],
    });
    expect(loadMasteringABSession(projectWithId("snapshot-project-b"))).toMatchObject({ a: null, b: null });
    expect(doc.master).not.toBe(loaded.a?.config);
  });

  it("fails closed on malformed, foreign-project, or future-version storage", () => {
    const doc = projectWithId("snapshot-corruption");
    const key = `kyx.mastering.ab.v1:${doc.id}`;
    const empty = { version: 1, projectId: doc.id, a: null, b: null };

    sessionStorage.setItem(key, "{");
    expect(loadMasteringABSession(doc)).toEqual(empty);
    sessionStorage.setItem(key, JSON.stringify({ ...empty, version: 2 }));
    expect(loadMasteringABSession(doc)).toEqual(empty);
    sessionStorage.setItem(key, JSON.stringify({ ...empty, projectId: "another-project" }));
    expect(loadMasteringABSession(doc)).toEqual(empty);
  });
});

describe("mastering reference repository", () => {
  it("rejects an invalid persisted reference record", async () => {
    const repository = new MasteringReferenceRepository();
    const projectId = `mastering-reference-corrupt-${Date.now()}`;
    const corrupt = {
      projectId,
      fileName: "broken.wav",
      mimeType: "audio/wav",
      byteLength: 99,
      importedAt: new Date().toISOString(),
      source: { size: 3, type: "audio/wav" },
    } as MasteringReferenceRecord;

    await repository.put(corrupt);
    await expect(repository.get(projectId)).rejects.toThrow("saved mastering reference record is invalid");
  });
});

describe("external mastering session render document", () => {
  it("routes only the immutable source through a cloned master config at exact source duration", () => {
    const original = testDoc();
    const master = {
      ...original.master,
      masterGain: 1.25,
      tiltDb: 1.5,
      limiterTransientLink: 0.35,
      limiterReleaseLink: 0.65,
      effects: [
        {
          id: "session-compressor",
          type: "compressor" as const,
          bypassed: false,
          params: { threshold: -24, ratio: 2 },
        },
      ],
    };
    const durationSeconds = 237.125;
    const scratch = createMasteringSessionRenderDocument(durationSeconds, master, "mastering-session-source-a");
    const clip = scratch.arrangement.audioClips?.[0];

    expect(clip).toMatchObject({
      bufferId: "mastering-session-source-a",
      startBar: 0,
      offsetSec: 0,
      trimStart: 0,
      trimEnd: 1,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      reverse: false,
    });
    expect(scratch.arrangement.clips).toEqual([]);
    expect(scratch.returns).toEqual([]);
    expect(scratch.tracks).toHaveLength(1);
    expect(scratch.tracks[0]).toMatchObject({ kind: "drum", name: "Source Mix", gain: 1, effects: [] });
    expect(scratch.master).toEqual(master);
    expect(scratch.master).not.toBe(master);
    expect(scratch.master.effects?.[0]).not.toBe(master.effects[0]);
    expect(scratch.master.effects?.[0]?.params).not.toBe(master.effects[0]?.params);
    expect(master.masterGain).toBe(1.25);
    expect(masteringSessionTimelineSeconds(scratch)).toBeCloseTo(durationSeconds, 10);
  });

  it("rejects an invalid source duration or buffer identity", () => {
    const master = testDoc().master;
    expect(() => createMasteringSessionRenderDocument(0.79, master, "source")).toThrow(/between 0.8 seconds/);
    expect(() => createMasteringSessionRenderDocument(721, master, "source")).toThrow(/between 0.8 seconds/);
    expect(() => createMasteringSessionRenderDocument(1, master, "")).toThrow(/buffer id is invalid/);
  });

  it("preflights decoded source, render, and float WAV working memory", () => {
    const master = testDoc().master;
    const smallSource = { duration: 1, length: 48_000, numberOfChannels: 2, sampleRate: 48_000 };
    const estimatedBytes = estimateMasteringSessionWorkingSetBytes(smallSource, master, 48_000);
    const estimate96kBytes = estimateMasteringSessionWorkingSetBytes(smallSource, master, 96_000);
    expect(MASTERING_RENDER_SAMPLE_RATES).toEqual([44_100, 48_000, 96_000]);
    expect(estimatedBytes).toBeGreaterThan(0);
    expect(estimate96kBytes).toBeGreaterThan(estimatedBytes);
    expect(estimateMasteringSessionComparisonBytes(smallSource, master, master, 48_000)).toBeGreaterThan(
      estimatedBytes,
    );
    expect(() => assertMasteringSessionWorkingSetBudget(estimatedBytes)).not.toThrow();
    expect(() => assertMasteringSessionWorkingSetBudget(MAX_MASTERING_SESSION_WORKING_SET_BYTES)).not.toThrow();
    expect(() => assertMasteringSessionWorkingSetBudget(MAX_MASTERING_SESSION_WORKING_SET_BYTES + 1)).toThrow(
      /above KYX's 512 MiB session limit/,
    );
    expect(estimateMasteringSessionWorkingSetBytes({ ...smallSource, duration: Number.NaN }, master, 48_000)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("rejects an over-budget source before reading the bank or creating an offline context", async () => {
    const source = {
      duration: 600,
      length: 600 * 96_000,
      numberOfChannels: 2,
      sampleRate: 96_000,
    } as AudioBuffer;
    const bank = { entries: vi.fn() } as unknown as SampleBank;
    const contextConstructor = vi.fn();
    vi.stubGlobal("OfflineAudioContext", contextConstructor);

    try {
      await expect(
        renderMasteringSessionSource(source, testDoc().master, bank, { sampleRate: 96_000 }),
      ).rejects.toThrow(/above KYX's 512 MiB session limit/);
      expect(bank.entries).not.toHaveBeenCalled();
      expect(contextConstructor).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("FLAC decoder worker cancellation", () => {
  beforeEach(() => {
    flacDecoderMock.instances.length = 0;
    flacDecoderMock.ready = undefined;
    flacDecoderMock.decodeFile = undefined;
  });

  it("terminates the worker once when cancellation arrives during worker startup", async () => {
    flacDecoderMock.ready = new Promise<void>(() => undefined);
    const controller = new AbortController();
    const result = decodeFlacAudioBuffer(
      new ArrayBuffer(42),
      {
        sampleRate: 44_100,
        channels: 1,
        durationSeconds: 0.8,
        bitDepth: 16,
      },
      { maxPcmBytes: 1_000_000, signal: controller.signal },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    await vi.waitFor(() => expect(flacDecoderMock.instances).toHaveLength(1));
    const decoder = flacDecoderMock.instances[0]!;
    controller.abort();

    expect(await result).toMatchObject({ name: "AbortError" });
    expect(decoder.terminate).toHaveBeenCalledOnce();
    expect(decoder.decodeFile).not.toHaveBeenCalled();
    expect(decoder.free).not.toHaveBeenCalled();
  });

  it("terminates the worker once when cancellation arrives during frame decoding", async () => {
    flacDecoderMock.decodeFile = () => new Promise<unknown>(() => undefined);
    const controller = new AbortController();
    const result = decodeFlacAudioBuffer(
      new ArrayBuffer(42),
      {
        sampleRate: 44_100,
        channels: 1,
        durationSeconds: 0.8,
        bitDepth: 16,
      },
      { maxPcmBytes: 1_000_000, signal: controller.signal },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    await vi.waitFor(() => expect(flacDecoderMock.instances[0]?.decodeFile).toHaveBeenCalledOnce());
    const decoder = flacDecoderMock.instances[0]!;
    controller.abort();

    expect(await result).toMatchObject({ name: "AbortError" });
    expect(decoder.terminate).toHaveBeenCalledOnce();
    expect(decoder.free).not.toHaveBeenCalled();
  });
});

describe("encoded mastering SHA-256 fingerprints", () => {
  it.each([
    ["empty input", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "the NIST 56-byte padding-boundary vector",
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("matches the known SHA-256 digest for %s", (_label, input, expected) => {
    const digest = new IncrementalSha256();
    digest.update(new TextEncoder().encode(input));
    expect(digest.digestHex()).toBe(expected);
  });

  it.each([55, 56, 63, 64, 65, 1_048_575, 1_048_576, 1_048_641])(
    "matches Node crypto across 64-byte and 1 MiB boundaries for %i bytes",
    (byteLength) => {
      const bytes = Uint8Array.from({ length: byteLength }, (_, index) => (index * 31 + 7) & 0xff);
      const expected = createHash("sha256").update(bytes).digest("hex");
      const digest = new IncrementalSha256();
      const chunkSizes = byteLength > 1_048_576 ? [1_048_576, 64, 1] : [1, 63, 64, 65];
      let chunkIndex = 0;
      for (let offset = 0; offset < bytes.byteLength;) {
        const remaining = bytes.byteLength - offset;
        const chunkBytes = Math.min(chunkSizes[chunkIndex % chunkSizes.length]!, remaining);
        digest.update(bytes.subarray(offset, offset + chunkBytes));
        offset += chunkBytes;
        chunkIndex += 1;
      }
      expect(digest.digestHex()).toBe(expected);
    },
  );

  it("matches the NIST million-byte repeated-a vector across one-megabyte slices", () => {
    const bytes = new Uint8Array(1_000_000).fill(0x61);
    const digest = new IncrementalSha256();
    for (let offset = 0; offset < bytes.byteLength; offset += 1_048_576) {
      digest.update(bytes.subarray(offset, Math.min(bytes.byteLength, offset + 1_048_576)));
    }
    expect(digest.digestHex()).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  it("reports a transparent not-computed fallback when workers are unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    try {
      await expect(fingerprintEncodedMasterAsync(new Blob([new Uint8Array([1, 2, 3])]))).resolves.toMatchObject({
        algorithm: "SHA-256",
        status: "not-computed",
        hex: null,
        reason: expect.stringContaining("cannot run the SHA-256 worker"),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("emits progress and terminates the worker immediately when cancelled", async () => {
    class ControlledFingerprintWorker extends EventTarget {
      static instances: ControlledFingerprintWorker[] = [];
      readonly terminate = vi.fn();

      constructor() {
        super();
        ControlledFingerprintWorker.instances.push(this);
      }

      postMessage(message: { requestId: number }): void {
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: { type: "MASTER_FINGERPRINT_PROGRESS", requestId: message.requestId, progress: 0.5 },
            }),
          );
        });
      }
    }

    ControlledFingerprintWorker.instances.length = 0;
    vi.stubGlobal("Worker", ControlledFingerprintWorker as unknown as typeof Worker);
    const controller = new AbortController();
    const onProgress = vi.fn();
    try {
      const pending = fingerprintEncodedMasterAsync(new Blob([new Uint8Array([1, 2, 3])]), {
        signal: controller.signal,
        onProgress,
      });
      await vi.waitFor(() =>
        expect(onProgress).toHaveBeenCalledWith({ progress: 0.5, stage: "Fingerprinting the encoded file" }),
      );
      const worker = ControlledFingerprintWorker.instances[0]!;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("mastering analysis long-run stability", () => {
  it("keeps a five-minute streaming analysis finite, bounded and stable", () => {
    const sampleRate = 48_000;
    const seconds = 300;
    const frames = sampleRate * seconds;
    const windowFrames = sampleRate * 50;
    const firstWindowStart = sampleRate * 10;
    const firstWindowEnd = firstWindowStart + windowFrames;
    const lastWindowStart = sampleRate * 250;
    const profile = MASTER_PROFILES.find((candidate) => candidate.id === "streaming");
    if (!profile) throw new Error("Streaming mastering profile is unavailable.");

    const amplitude = 10 ** (-23 / 20);
    const cycle = Float32Array.from({ length: 48 }, (_, index) => amplitude * Math.sin((2 * Math.PI * index) / 48));
    const frame = new Float64Array(2);
    const full = new MasterAnalysisAccumulator(sampleRate, 2, profile);
    const firstWindow = new MasterAnalysisAccumulator(sampleRate, 2, profile);
    const lastWindow = new MasterAnalysisAccumulator(sampleRate, 2, profile);

    global.gc?.();
    const heapStart = process.memoryUsage().heapUsed;

    for (let index = 0; index < frames; index++) {
      const sample = cycle[index % cycle.length]!;
      frame[0] = sample;
      frame[1] = sample;
      full.processFrame(frame);
      if (index >= firstWindowStart && index < firstWindowEnd) firstWindow.processFrame(frame);
      if (index >= lastWindowStart) lastWindow.processFrame(frame);
    }

    const fullResult = full.finish();
    const firstResult = firstWindow.finish();
    const lastResult = lastWindow.finish();
    const timeline = fullResult.loudnessTimeline;
    expect(fullResult.mixHealth.flags.some((flag) => flag.check === "non-finite")).toBe(false);
    expect(fullResult.mixHealth.durationSec).toBe(seconds);
    expect(timeline).not.toBeNull();
    expect(timeline!.durationSeconds).toBe(seconds);
    expect(timeline!.sourceWindowCount).toBe(2_971);
    expect(timeline!.points.length).toBeLessThanOrEqual(1_200);
    expect(timeline!.points.every((point) => point.lowLufs <= point.meanLufs && point.meanLufs <= point.highLufs)).toBe(
      true,
    );

    const firstTimelineMeans = timeline!.points
      .filter((point) => point.timeSeconds >= 10 && point.timeSeconds < 60)
      .map((point) => point.meanLufs);
    const lastTimelineMeans = timeline!.points
      .filter((point) => point.timeSeconds >= 250 && point.timeSeconds < 300)
      .map((point) => point.meanLufs);
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(firstTimelineMeans.length).toBeGreaterThan(100);
    expect(lastTimelineMeans.length).toBeGreaterThan(100);
    expect(Math.abs(mean(firstTimelineMeans) - mean(lastTimelineMeans))).toBeLessThanOrEqual(0.02);

    for (const result of [fullResult, firstResult, lastResult]) {
      expect(Number.isFinite(result.measurements.lufsIntegrated)).toBe(true);
      expect(Number.isFinite(result.measurements.truePeakDb)).toBe(true);
      expect(Number.isFinite(result.measurements.loudnessRangeLu)).toBe(true);
    }
    expect(
      Math.abs(firstResult.measurements.lufsIntegrated - lastResult.measurements.lufsIntegrated),
    ).toBeLessThanOrEqual(0.02);
    expect(Math.abs(firstResult.measurements.truePeakDb - lastResult.measurements.truePeakDb)).toBeLessThanOrEqual(
      0.02,
    );

    global.gc?.();
    const growthMb = (process.memoryUsage().heapUsed - heapStart) / (1024 * 1024);
    console.log(
      `[master-analysis-soak] ${seconds}s streaming: ${growthMb.toFixed(2)} MB heap growth; LUFS drift ${Math.abs(firstResult.measurements.lufsIntegrated - lastResult.measurements.lufsIntegrated).toFixed(4)} dB; true-peak drift ${Math.abs(firstResult.measurements.truePeakDb - lastResult.measurements.truePeakDb).toFixed(4)} dB`,
    );
    expect(growthMb).toBeLessThanOrEqual(6);
  }, 300_000);

  it("keeps a two-hour minimum-rate analysis finite with bounded heap growth", () => {
    const sampleRate = 8_000;
    const seconds = 2 * 60 * 60;
    const frames = sampleRate * seconds;
    const profile = MASTER_PROFILES.find((candidate) => candidate.id === "streaming");
    if (!profile) throw new Error("Streaming mastering profile is unavailable.");

    const amplitude = 10 ** (-23 / 20);
    const cycle = Float32Array.from({ length: 8 }, (_, index) => amplitude * Math.sin((2 * Math.PI * index) / 8));
    const frame = new Float64Array(1);
    const analyzer = new MasterAnalysisAccumulator(sampleRate, 1, profile);

    global.gc?.();
    const heapStart = process.memoryUsage().heapUsed;
    for (let index = 0; index < frames; index++) {
      frame[0] = cycle[index % cycle.length]!;
      analyzer.processFrame(frame);
    }
    const result = analyzer.finish();

    expect(result.mixHealth.durationSec).toBe(seconds);
    expect(result.measurements.channelCount).toBe(1);
    expect(Number.isFinite(result.measurements.lufsIntegrated)).toBe(true);
    expect(Number.isFinite(result.measurements.truePeakDb)).toBe(true);
    expect(Number.isFinite(result.measurements.loudnessRangeLu)).toBe(true);
    expect(result.loudnessTimeline?.sourceWindowCount).toBe(72_000 - 29);
    expect(result.loudnessTimeline?.points.length).toBeLessThanOrEqual(1_200);

    global.gc?.();
    const growthMb = (process.memoryUsage().heapUsed - heapStart) / (1024 * 1024);
    console.log(`[master-analysis-soak] ${seconds}s streaming: ${growthMb.toFixed(2)} MB heap growth`);
    expect(growthMb).toBeLessThanOrEqual(6);
  }, 120_000);
});

describe("mastering analysis worker watchdog", () => {
  it("terminates an idle worker at the watchdog limit", async () => {
    class SilentAnalysisWorker extends EventTarget {
      readonly terminate = vi.fn();
      readonly postMessage = vi.fn();
    }

    const workers: SilentAnalysisWorker[] = [];
    class WorkerWithoutResponses extends SilentAnalysisWorker {
      constructor() {
        super();
        workers.push(this);
      }
    }
    const profile = MASTER_PROFILES.find((candidate) => candidate.id === "streaming");
    if (!profile) throw new Error("Streaming mastering profile is unavailable.");

    vi.useFakeTimers();
    vi.stubGlobal("Worker", WorkerWithoutResponses as unknown as typeof Worker);
    try {
      const pending = analyzeMasterPcmStreamAsync(
        {
          sampleRate: 48_000,
          channelCount: 1,
          frameCount: 48_000,
          readChunk: () => [new Float32Array(48_000)],
        },
        profile,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      const worker = workers[0];
      if (!worker) throw new Error("The mastering analysis worker was not constructed.");

      await vi.advanceTimersByTimeAsync(179_999);
      expect(worker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      const error = await pending;
      expect(error).toMatchObject({
        message: "Master analysis worker stopped responding for 3 minutes.",
      });
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
