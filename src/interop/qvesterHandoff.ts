/**
 * QVESTER ECOSYSTEM HANDOFF — "Send to Qvester Visualizer".
 *
 * Hands the rendered beat to Audio Canvas (SIQ, mounted at /audio-canvas in
 * the Qvester Studio shell) so its deterministic analysis and beat-reactive
 * visuals run on OUR audio. Lives only in the mounted context: the handoff
 * medium is same-origin (IndexedDB + WebStorage), so a standalone KYX
 * deployment never shows the action.
 *
 * Ecosystem conventions this module follows (see the Qvester interop spec
 * V2 §2.2 and AUDIO-CANVAS/src/interop/sendAudioAnalysisToCanvas.ts):
 *   - packet envelope "2.0", persisted under `qvester:handoff:<id>` in
 *     sessionStorage AND localStorage, TTL 30 minutes;
 *   - `InputArtifact.value` is always a STRING — the WAV itself travels via
 *     the `qvester-blob:<hash>` pointer backed by a shared IndexedDB store
 *     (`qvester-audio-handoff`), never inline in the packet;
 *   - navigation target `<origin>/audio-canvas?handoff=<id>&handoffIntent=<intent>`;
 *   - Audio Canvas re-runs its own deterministic analysis on the bound file;
 *     our bpm/key/camelot ride along as a declared-source hint.
 */
import type { MusicalKey, ProjectDocument } from "../project-model/types";
import { renderProject, type RenderOptions } from "../rendering/renderer";
import { encodeWavAsync } from "../rendering/wav";
import type { SampleBank } from "../sample-library/factory";

export const KYX_HANDOFF_INTENT = "send_beat_to_audio_canvas";
export const KYX_ARTIFACT_TYPE = "audio_master";
export const HANDOFF_DB_NAME = "qvester-audio-handoff";
export const HANDOFF_STORE_NAME = "blobs";
export const HANDOFF_TTL_MS = 30 * 60 * 1000;
const PACKET_KEY_PREFIX = "qvester:handoff:";
const TARGET_APP = "audio_canvas";
const TARGET_ROUTE = "/audio-canvas";
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Camelot wheel (Mixed In Key convention): C Major = 8B, relative minor = same number + A. */
const CAMELOT_MAJOR: Record<string, number> = {
  C: 8,
  G: 9,
  D: 10,
  A: 11,
  E: 12,
  B: 1,
  "F#": 2,
  "C#": 3,
  "G#": 4,
  "D#": 5,
  "A#": 6,
  F: 7,
};
const CAMELOT_MINOR: Record<string, number> = {
  A: 8,
  E: 9,
  B: 10,
  "F#": 11,
  "C#": 12,
  "G#": 1,
  "D#": 2,
  "A#": 3,
  F: 4,
  C: 5,
  G: 6,
  D: 7,
};

export interface BeatKeyMetadata {
  key: string | null;
  mode: "major" | "minor" | null;
  camelot: string | null;
}

/**
 * Map KYX's "<Root> <Scale>" musical key onto the interop profile's
 * {key, mode, camelot}. Modes other than Major/Pentatonic Major/Mixolydian
 * count as minor-family (documented heuristic — the interop profile only
 * carries "major" | "minor" | null).
 */
export function keyToCamelot(key: MusicalKey | undefined): BeatKeyMetadata {
  if (!key) return { key: null, mode: null, camelot: null };
  const splitAt = key.indexOf(" ");
  if (splitAt <= 0) return { key: null, mode: null, camelot: null };
  const root = key.slice(0, splitAt);
  const scale = key.slice(splitAt + 1);
  const majorFamily = scale === "Major" || scale === "Pentatonic Major" || scale === "Mixolydian";
  const camelot = majorFamily ? CAMELOT_MAJOR[root] : CAMELOT_MINOR[root];
  if (camelot === undefined) return { key: null, mode: null, camelot: null };
  return { key: root, mode: majorFamily ? "major" : "minor", camelot: `${camelot}${majorFamily ? "B" : "A"}` };
}

export interface BeatHandoffRecord {
  hash: string;
  /** The rendered master as raw WAV bytes (IDB-cloneable without Blob support). */
  wav: ArrayBuffer;
  name: string;
  bpm: number | null;
  key: string | null;
  mode: "major" | "minor" | null;
  camelot: string | null;
  durationSec: number;
  sampleRate: number;
  byteLength: number;
  createdAt: number;
}

/** Reconstruct the handoff WAV as a Blob (the receiver wraps it in a File). */
export function beatRecordToBlob(record: BeatHandoffRecord): Blob {
  return new Blob([record.wav], { type: "audio/wav" });
}

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function withIdb<T>(run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const open = indexedDB.open(HANDOFF_DB_NAME, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(HANDOFF_STORE_NAME)) {
        open.result.createObjectStore(HANDOFF_STORE_NAME, { keyPath: "hash" });
      }
    };
    open.onerror = () => rejectPromise(open.error ?? new Error("handoff IDB open failed"));
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction(HANDOFF_STORE_NAME, "readwrite");
        const request = run(tx.objectStore(HANDOFF_STORE_NAME));
        request.onsuccess = () => resolvePromise(request.result);
        request.onerror = () => rejectPromise(request.error ?? new Error("handoff IDB request failed"));
        tx.oncomplete = () => db.close();
      } catch (error) {
        db.close();
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      }
    };
  });
}

/** Store the beat blob under its content hash; prune stale entries (24 h). */
export async function storeBeatBlob(record: BeatHandoffRecord): Promise<void> {
  await withIdb((store) => store.put(record));
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  try {
    const all = await withIdb((store) => store.getAll() as IDBRequest<BeatHandoffRecord[]>);
    for (const entry of all) {
      if (entry.createdAt < cutoff && entry.hash !== record.hash) {
        await withIdb((store) => store.delete(entry.hash));
      }
    }
  } catch {
    /* prune is best-effort */
  }
}

export async function readBeatBlob(hash: string): Promise<BeatHandoffRecord | null> {
  const record = await withIdb((store) => store.get(hash) as IDBRequest<BeatHandoffRecord | undefined>);
  return record ?? null;
}

export interface BeatHandoffPacket {
  version: "2.0";
  handoffId: string;
  sourceApp: "pulse_forge";
  targetApp: typeof TARGET_APP;
  initiatedBy: "user";
  intent: typeof KYX_HANDOFF_INTENT;
  createdAt: number;
  expiresAt: number;
  ttl: number;
  payload: {
    inputs: Array<{
      type: typeof KYX_ARTIFACT_TYPE;
      label: string;
      uri: string;
      value: string;
      metadata: Record<string, unknown>;
    }>;
    recommendedAction: string;
  };
  returnTarget: { appId: "pulse_forge"; route: "/pulse-forge"; mode: "manual" };
  tracking: { createdAt: string };
}

function generateHandoffId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `kyx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildBeatHandoffPacket(record: BeatHandoffRecord, doc: ProjectDocument): BeatHandoffPacket {
  const createdAt = Date.now();
  const key = keyToCamelot(doc.key);
  const metadata = {
    bpm: record.bpm,
    key: key.key,
    mode: key.mode,
    camelot: key.camelot,
    declaredSource: "kyx project metadata",
    durationSec: record.durationSec,
    sampleRate: record.sampleRate,
    byteLength: record.byteLength,
  };
  return {
    version: "2.0",
    handoffId: generateHandoffId(),
    sourceApp: "pulse_forge",
    targetApp: TARGET_APP,
    initiatedBy: "user",
    intent: KYX_HANDOFF_INTENT,
    createdAt,
    expiresAt: createdAt + HANDOFF_TTL_MS,
    ttl: HANDOFF_TTL_MS,
    payload: {
      inputs: [
        {
          type: KYX_ARTIFACT_TYPE,
          label: `${record.name} (KYX render)`,
          uri: `qvester-blob:${record.hash}`,
          value: JSON.stringify(metadata),
          metadata: { format: "audio/wav", transport: "local-reference" },
        },
      ],
      recommendedAction:
        "Bind the beat as the audio source — the deterministic analysis (bpm/key/beatGrid) then drives the reactive visuals.",
    },
    returnTarget: { appId: "pulse_forge", route: "/pulse-forge", mode: "manual" },
    tracking: { createdAt: new Date(createdAt).toISOString() },
  };
}

export function buildAudioCanvasHandoffUrl(packet: BeatHandoffPacket, origin = window.location.origin): string {
  return `${origin}${TARGET_ROUTE}?handoff=${encodeURIComponent(packet.handoffId)}&handoffIntent=${encodeURIComponent(
    packet.intent,
  )}`;
}

export function persistBeatHandoffPacket(packet: BeatHandoffPacket): boolean {
  let persisted = false;
  const serialized = JSON.stringify(packet);
  try {
    sessionStorage.setItem(PACKET_KEY_PREFIX + packet.handoffId, serialized);
    persisted = true;
  } catch {
    /* private mode — localStorage may still work */
  }
  try {
    localStorage.setItem(PACKET_KEY_PREFIX + packet.handoffId, serialized);
    persisted = true;
  } catch {
    /* quota — sessionStorage may have accepted */
  }
  return persisted;
}

/** True when KYX runs inside the Qvester mount — the only context where the
 *  handoff medium (same-origin IDB + WebStorage) reaches Audio Canvas. */
export function isMountedInEcosystem(): boolean {
  return import.meta.env.BASE_URL !== "/";
}

export interface SendBeatOptions {
  mode: RenderOptions["mode"];
  sampleRate: number;
  quality?: RenderOptions["quality"];
  signal?: AbortSignal;
  /** Progress for the render phase (0..1). */
  onProgress?: (fraction: number, label: string) => void;
}

export interface SendBeatResult {
  packet: BeatHandoffPacket;
  record: BeatHandoffRecord;
}

/** Render the current project, store the WAV, persist the handoff packet.
 *  Navigation is the caller's job (returns the target URL in packet form). */
export async function prepareBeatHandoff(
  doc: ProjectDocument,
  bank: SampleBank,
  options: SendBeatOptions,
): Promise<SendBeatResult> {
  const buffer = await renderProject(doc, bank, {
    mode: options.mode,
    sampleRate: options.sampleRate,
    ...(options.quality !== undefined ? { quality: options.quality } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const wavBytes = await encodeWavAsync(buffer, 16, {
    ...(options.onProgress ? { onProgress: (f: number) => options.onProgress!(f, "Preparing handoff WAV…") } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const hash = await sha256Hex(wavBytes);
  const record: BeatHandoffRecord = {
    hash,
    wav: wavBytes,
    name: doc.name,
    bpm: Number.isFinite(doc.bpm) ? doc.bpm : null,
    key: doc.key ?? null,
    mode: keyToCamelot(doc.key).mode,
    camelot: keyToCamelot(doc.key).camelot,
    durationSec: buffer.duration,
    sampleRate: buffer.sampleRate,
    byteLength: wavBytes.byteLength,
    createdAt: Date.now(),
  };
  await storeBeatBlob(record);
  const packet = buildBeatHandoffPacket(record, doc);
  if (!persistBeatHandoffPacket(packet)) {
    throw new Error("WebStorage rejected the handoff packet (private mode or quota) — nothing was sent.");
  }
  return { packet, record };
}
