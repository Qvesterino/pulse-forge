import { uid } from "../shared/ids";

export const MASTERING_ALBUM_DATABASE = "kyx-mastering-albums";
export const MASTERING_ALBUM_DATABASE_VERSION = 1;
export const MASTERING_ALBUM_STORE = "albums";
export const MASTERING_ALBUM_LIMIT = 24;
export const MASTERING_ALBUM_TRACK_LIMIT = 100;
export const MASTERING_ALBUM_GAP_MAX_SECONDS = 30;

export type MasteringAlbumDeliveryFormat = "wav" | "flac" | "mp3";

/** Compact verified export metrics cached with an album track; never contains audio or a full sidecar. */
export interface MasteringAlbumDeliverySummary {
  sourceHash: string;
  configRevision: number;
  generatedAt: string;
  fileName: string;
  format: MasteringAlbumDeliveryFormat;
  decodeStatus: "measured" | "not-measured";
  lufsIntegrated: number | null;
  truePeakDb: number | null;
}

export interface MasteringAlbumTrack {
  id: string;
  sessionId: string;
  /** Silence after this track, ignored for the final track in the sequence. */
  gapAfterSeconds: number;
  /** Latest compact export measurement; stale revisions remain visible but are excluded from the album report. */
  deliverySummary?: MasteringAlbumDeliverySummary;
}

export interface MasteringAlbumRecord {
  version: 1;
  id: string;
  title: string;
  tracks: MasteringAlbumTrack[];
  createdAt: string;
  updatedAt: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160;
}

function isDeliverySummary(value: unknown): value is MasteringAlbumDeliverySummary {
  if (!isObject(value)) return false;
  const dbValue = (candidate: unknown) =>
    candidate === null ||
    (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= -200 && candidate <= 100);
  return (
    typeof value.sourceHash === "string" &&
    /^[a-f0-9]{64}$/i.test(value.sourceHash) &&
    Number.isSafeInteger(value.configRevision) &&
    (value.configRevision as number) >= 0 &&
    typeof value.generatedAt === "string" &&
    Number.isFinite(Date.parse(value.generatedAt)) &&
    typeof value.fileName === "string" &&
    value.fileName.length > 0 &&
    value.fileName.length <= 255 &&
    (value.format === "wav" || value.format === "flac" || value.format === "mp3") &&
    (value.decodeStatus === "measured" || value.decodeStatus === "not-measured") &&
    dbValue(value.lufsIntegrated) &&
    dbValue(value.truePeakDb) &&
    (value.decodeStatus === "measured" || (value.lufsIntegrated === null && value.truePeakDb === null))
  );
}

function isTrack(value: unknown): value is MasteringAlbumTrack {
  return (
    isObject(value) &&
    isBoundedId(value.id) &&
    isBoundedId(value.sessionId) &&
    typeof value.gapAfterSeconds === "number" &&
    Number.isFinite(value.gapAfterSeconds) &&
    value.gapAfterSeconds >= 0 &&
    value.gapAfterSeconds <= MASTERING_ALBUM_GAP_MAX_SECONDS &&
    (value.deliverySummary === undefined || isDeliverySummary(value.deliverySummary))
  );
}

export function validateMasteringAlbum(value: unknown): MasteringAlbumRecord {
  if (!isObject(value)) throw new Error("The saved mastering album is invalid.");
  const tracks = value.tracks;
  if (
    value.version !== 1 ||
    !isBoundedId(value.id) ||
    typeof value.title !== "string" ||
    value.title.trim().length === 0 ||
    value.title.length > 120 ||
    !Array.isArray(tracks) ||
    tracks.length > MASTERING_ALBUM_TRACK_LIMIT ||
    !tracks.every(isTrack) ||
    new Set(tracks.map((track) => track.id)).size !== tracks.length ||
    new Set(tracks.map((track) => track.sessionId)).size !== tracks.length ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    (tracks.length > 0 && (tracks[tracks.length - 1] as MasteringAlbumTrack).gapAfterSeconds !== 0)
  ) {
    throw new Error("The saved mastering album has invalid metadata or track links.");
  }
  return {
    version: 1,
    id: value.id,
    title: value.title.trim(),
    tracks: tracks.map((track) => ({
      ...track,
      ...(track.deliverySummary ? { deliverySummary: { ...track.deliverySummary } } : {}),
    })),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function validateMasteringAlbumDeliverySummary(value: unknown): MasteringAlbumDeliverySummary {
  if (!isDeliverySummary(value)) throw new Error("The saved album delivery summary is invalid.");
  return { ...value };
}

export type MasteringAlbumDeliveryState = "missing-session" | "no-report" | "stale" | "not-measured" | "measured";

export interface MasteringAlbumTrackDeliveryAudit {
  trackId: string;
  sessionId: string;
  fileName: string | null;
  state: MasteringAlbumDeliveryState;
  deliverySummary: MasteringAlbumDeliverySummary | null;
  lufsOffsetFromMedianDb: number | null;
}

export interface MasteringAlbumDeliveryAudit {
  tracks: MasteringAlbumTrackDeliveryAudit[];
  currentReportCount: number;
  measuredTrackCount: number;
  lufsMeasuredTrackCount: number;
  lufsMedian: number | null;
  lufsSpreadDb: number | null;
  truePeakMeasuredTrackCount: number;
  truePeakMaxDb: number | null;
}

/** Applies the latest export report to every album sequence containing this saved session. */
export function updateMasteringAlbumTrackDelivery(
  album: MasteringAlbumRecord,
  sessionId: string,
  deliverySummary: MasteringAlbumDeliverySummary,
): MasteringAlbumRecord {
  const current = validateMasteringAlbum(album);
  const summary = validateMasteringAlbumDeliverySummary(deliverySummary);
  if (!current.tracks.some((track) => track.sessionId === sessionId)) return current;
  const tracks = current.tracks.map((track) =>
    track.sessionId === sessionId ? { ...track, deliverySummary: summary } : { ...track },
  );
  return validateMasteringAlbum({ ...current, tracks });
}

/**
 * Summarizes only track reports whose source fingerprint and config revision
 * still match the saved session. The statistics describe delivered files;
 * they never change per-track mastering settings.
 */
export function summarizeMasteringAlbumDelivery(
  album: MasteringAlbumRecord,
  sessions: ReadonlyMap<string, { id: string; fileName: string; sourceHash: string; configRevision: number }>,
): MasteringAlbumDeliveryAudit {
  const trackAudits = validateMasteringAlbum(album).tracks.map((track): MasteringAlbumTrackDeliveryAudit => {
    const session = sessions.get(track.sessionId);
    if (!session) {
      return {
        trackId: track.id,
        sessionId: track.sessionId,
        fileName: null,
        state: "missing-session",
        deliverySummary: track.deliverySummary ?? null,
        lufsOffsetFromMedianDb: null,
      };
    }
    const summary = track.deliverySummary ?? null;
    if (!summary) {
      return {
        trackId: track.id,
        sessionId: track.sessionId,
        fileName: session.fileName,
        state: "no-report",
        deliverySummary: null,
        lufsOffsetFromMedianDb: null,
      };
    }
    if (
      summary.configRevision !== session.configRevision ||
      summary.sourceHash.toLowerCase() !== session.sourceHash.toLowerCase()
    ) {
      return {
        trackId: track.id,
        sessionId: track.sessionId,
        fileName: session.fileName,
        state: "stale",
        deliverySummary: summary,
        lufsOffsetFromMedianDb: null,
      };
    }
    return {
      trackId: track.id,
      sessionId: track.sessionId,
      fileName: session.fileName,
      state: summary.decodeStatus === "measured" ? "measured" : "not-measured",
      deliverySummary: summary,
      lufsOffsetFromMedianDb: null,
    };
  });
  const measuredLufs = trackAudits
    .filter((track) => track.state === "measured" && track.deliverySummary?.lufsIntegrated != null)
    .map((track) => track.deliverySummary!.lufsIntegrated!)
    .sort((a, b) => a - b);
  const lufsMedian =
    measuredLufs.length === 0
      ? null
      : measuredLufs.length % 2 === 1
        ? measuredLufs[Math.floor(measuredLufs.length / 2)]!
        : (measuredLufs[measuredLufs.length / 2 - 1]! + measuredLufs[measuredLufs.length / 2]!) / 2;
  for (const track of trackAudits) {
    const lufs = track.deliverySummary?.lufsIntegrated;
    if (track.state === "measured" && lufs != null && lufsMedian != null && measuredLufs.length >= 2) {
      track.lufsOffsetFromMedianDb = lufs - lufsMedian;
    }
  }
  const measuredTruePeaks = trackAudits
    .filter((track) => track.state === "measured" && track.deliverySummary?.truePeakDb != null)
    .map((track) => track.deliverySummary!.truePeakDb!);
  const currentReportCount = trackAudits.filter(
    (track) => track.state === "measured" || track.state === "not-measured",
  ).length;
  const currentMeasured = trackAudits.filter((track) => track.state === "measured");
  const measuredLoudest = measuredLufs.length ? measuredLufs[measuredLufs.length - 1]! : null;
  const measuredQuietest = measuredLufs.length ? measuredLufs[0]! : null;
  return {
    tracks: trackAudits,
    currentReportCount,
    measuredTrackCount: currentMeasured.length,
    lufsMeasuredTrackCount: measuredLufs.length,
    lufsMedian,
    lufsSpreadDb:
      measuredLufs.length >= 2 && measuredLoudest != null && measuredQuietest != null
        ? measuredLoudest - measuredQuietest
        : null,
    truePeakMeasuredTrackCount: measuredTruePeaks.length,
    truePeakMaxDb: measuredTruePeaks.length ? Math.max(...measuredTruePeaks) : null,
  };
}

export function createMasteringAlbum(title: string, now = new Date().toISOString()): MasteringAlbumRecord {
  const trimmed = title.trim().slice(0, 120);
  if (!trimmed) throw new Error("Enter an album title first.");
  return { version: 1, id: uid("mastering-album"), title: trimmed, tracks: [], createdAt: now, updatedAt: now };
}

function touchAlbum(album: MasteringAlbumRecord, tracks: MasteringAlbumTrack[], now = new Date().toISOString()) {
  const next = { ...album, tracks, updatedAt: now };
  return validateMasteringAlbum(next);
}

export function addMasteringAlbumTrack(
  album: MasteringAlbumRecord,
  sessionId: string,
  now?: string,
): MasteringAlbumRecord {
  if (!isBoundedId(sessionId)) throw new Error("Choose a saved mastering session.");
  if (album.tracks.some((track) => track.sessionId === sessionId)) {
    throw new Error("This mastering session is already in the album sequence.");
  }
  if (album.tracks.length >= MASTERING_ALBUM_TRACK_LIMIT) {
    throw new Error(`An album sequence can contain up to ${MASTERING_ALBUM_TRACK_LIMIT} tracks.`);
  }
  const tracks = album.tracks.map((track) => ({ ...track }));
  if (tracks.length > 0) tracks[tracks.length - 1]!.gapAfterSeconds = 2;
  tracks.push({ id: uid("mastering-album-track"), sessionId, gapAfterSeconds: 0 });
  return touchAlbum(album, tracks, now);
}

export function removeMasteringAlbumTrack(
  album: MasteringAlbumRecord,
  trackId: string,
  now?: string,
): MasteringAlbumRecord {
  const tracks = album.tracks.filter((track) => track.id !== trackId).map((track) => ({ ...track }));
  if (tracks.length === album.tracks.length) return album;
  if (tracks.length > 0) tracks[tracks.length - 1]!.gapAfterSeconds = 0;
  return touchAlbum(album, tracks, now);
}

export function moveMasteringAlbumTrack(
  album: MasteringAlbumRecord,
  trackId: string,
  direction: -1 | 1,
  now?: string,
): MasteringAlbumRecord {
  const index = album.tracks.findIndex((track) => track.id === trackId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= album.tracks.length) return album;
  const tracks = album.tracks.map((track) => ({ ...track }));
  [tracks[index]!, tracks[target]!] = [tracks[target]!, tracks[index]!];
  if (tracks.length > 0) tracks[tracks.length - 1]!.gapAfterSeconds = 0;
  return touchAlbum(album, tracks, now);
}

export function setMasteringAlbumGap(
  album: MasteringAlbumRecord,
  trackId: string,
  gapAfterSeconds: number,
  now?: string,
): MasteringAlbumRecord {
  if (!Number.isFinite(gapAfterSeconds) || gapAfterSeconds < 0 || gapAfterSeconds > MASTERING_ALBUM_GAP_MAX_SECONDS) {
    throw new Error(`Track gaps must be between 0 and ${MASTERING_ALBUM_GAP_MAX_SECONDS} seconds.`);
  }
  const tracks = album.tracks.map((track) =>
    track.id === trackId ? { ...track, gapAfterSeconds: Math.round(gapAfterSeconds * 10) / 10 } : { ...track },
  );
  if (tracks.every((track, index) => track.gapAfterSeconds === album.tracks[index]?.gapAfterSeconds)) return album;
  if (tracks.length > 0) tracks[tracks.length - 1]!.gapAfterSeconds = 0;
  return touchAlbum(album, tracks, now);
}

export function estimateMasteringAlbumDuration(
  album: MasteringAlbumRecord,
  sessionDurations: ReadonlyMap<string, number>,
): number | null {
  if (album.tracks.length === 0 || album.tracks.some((track) => !sessionDurations.has(track.sessionId))) return null;
  return album.tracks.reduce((seconds, track, index) => {
    const duration = sessionDurations.get(track.sessionId) ?? 0;
    return seconds + duration + (index < album.tracks.length - 1 ? track.gapAfterSeconds : 0);
  }, 0);
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable."));
  if (databasePromise) return databasePromise;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(MASTERING_ALBUM_DATABASE, MASTERING_ALBUM_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(MASTERING_ALBUM_STORE)) {
        request.result.createObjectStore(MASTERING_ALBUM_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => {
        db.close();
        databasePromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("Could not open the local album sequence store."));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error("The local album store is locked by another KYX tab."));
    };
  });
  databasePromise = pending;
  pending.catch(() => {
    if (databasePromise === pending) databasePromise = null;
  });
  return pending;
}

function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void,
) {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction([MASTERING_ALBUM_STORE], mode);
        let result: T;
        let hasResult = false;
        let settled = false;
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          try {
            tx.abort();
          } catch {
            // The transaction may already be complete.
          }
          reject(error);
        };
        try {
          run(
            tx.objectStore(MASTERING_ALBUM_STORE),
            (value) => {
              result = value;
              hasResult = true;
            },
            fail,
          );
        } catch (error) {
          fail(error);
          return;
        }
        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          if (hasResult) resolve(result!);
          else reject(new Error("Album storage completed without a result."));
        };
        tx.onerror = () => fail(tx.error ?? new Error("Album storage failed."));
        tx.onabort = () => {
          if (settled) return;
          settled = true;
          reject(tx.error ?? new Error("Album storage was aborted."));
        };
      }),
  );
}

export class MasteringAlbumRepository {
  async get(id: string): Promise<MasteringAlbumRecord | null> {
    if (!isBoundedId(id)) throw new Error("A saved album ID is required.");
    return transaction("readonly", (store, done, fail) => {
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result === undefined) {
          done(null);
          return;
        }
        try {
          done(validateMasteringAlbum(request.result));
        } catch (error) {
          fail(error);
        }
      };
      request.onerror = () => fail(request.error ?? new Error("Could not load the saved album sequence."));
    });
  }

  async list(): Promise<MasteringAlbumRecord[]> {
    return transaction("readonly", (store, done, fail) => {
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          done(
            (request.result as unknown[])
              .map(validateMasteringAlbum)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
          );
        } catch (error) {
          fail(error);
        }
      };
      request.onerror = () => fail(request.error ?? new Error("Could not list album sequences."));
    });
  }

  async save(album: MasteringAlbumRecord): Promise<void> {
    const valid = validateMasteringAlbum(album);
    await transaction("readwrite", (store, done, fail) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const albums = request.result as unknown[];
        const existing = albums.find((item) => isObject(item) && item.id === valid.id);
        const exists = existing !== undefined;
        if (!exists && albums.length >= MASTERING_ALBUM_LIMIT) {
          fail(new Error(`This device can keep up to ${MASTERING_ALBUM_LIMIT} album sequences.`));
          return;
        }
        let next = valid;
        if (existing !== undefined) {
          try {
            const prior = validateMasteringAlbum(existing);
            const priorTracks = new Map(prior.tracks.map((track) => [track.id, track]));
            next = validateMasteringAlbum({
              ...valid,
              tracks: valid.tracks.map((track) => ({
                ...track,
                ...(track.deliverySummary || !priorTracks.get(track.id)?.deliverySummary
                  ? {}
                  : { deliverySummary: priorTracks.get(track.id)!.deliverySummary }),
              })),
            });
          } catch (error) {
            fail(error);
            return;
          }
        }
        const write = store.put(next);
        write.onsuccess = () => done(undefined);
        write.onerror = () => fail(write.error ?? new Error("Could not save the album sequence."));
      };
      request.onerror = () => fail(request.error ?? new Error("Could not check the album limit."));
    });
  }

  async updateSessionDeliverySummary(
    sessionId: string,
    deliverySummary: MasteringAlbumDeliverySummary,
  ): Promise<number> {
    if (!isBoundedId(sessionId)) throw new Error("A saved session ID is required for album delivery metrics.");
    const summary = validateMasteringAlbumDeliverySummary(deliverySummary);
    return transaction("readwrite", (store, done, fail) => {
      const request = store.getAll();
      request.onsuccess = () => {
        let changed: MasteringAlbumRecord[];
        try {
          changed = (request.result as unknown[])
            .map(validateMasteringAlbum)
            .filter((album) => album.tracks.some((track) => track.sessionId === sessionId))
            .map((album) => updateMasteringAlbumTrackDelivery(album, sessionId, summary));
        } catch (error) {
          fail(error);
          return;
        }
        if (changed.length === 0) {
          done(0);
          return;
        }
        let remaining = changed.length;
        for (const album of changed) {
          const write = store.put(album);
          write.onsuccess = () => {
            remaining--;
            if (remaining === 0) done(changed.length);
          };
          write.onerror = () => fail(write.error ?? new Error("Could not save album delivery metrics."));
        }
      };
      request.onerror = () => fail(request.error ?? new Error("Could not read album sequences for delivery metrics."));
    });
  }

  async delete(id: string): Promise<void> {
    await transaction("readwrite", (store, done, fail) => {
      const request = store.delete(id);
      request.onsuccess = () => done(undefined);
      request.onerror = () => fail(request.error ?? new Error("Could not delete the album sequence."));
    });
  }
}
