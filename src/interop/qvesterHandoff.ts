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
import { buildStemProject } from "../rendering/stems";
import { encodeWavAsync } from "../rendering/wav";
import { roleOfTrack } from "../effects/role-presets";
import type { SampleBank } from "../sample-library/factory";
import { publishStemProfile } from "./qvesterProfileBus";

export const KYX_HANDOFF_INTENT = "send_beat_to_audio_canvas";
export const KYX_ARTIFACT_TYPE = "audio_master";
export const KYX_SOURCE_MAP_ARTIFACT_TYPE = "kyx_source_map";
/** Bound on per-track stems per send — keeps the shared IDB payload sane. */
export const KYX_MAX_STEMS = 6;
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
  /** Stem records only: which track this isolated render belongs to. */
  trackName?: string;
  /** Stem records only: the mapped FxTrackRole (drums/bass/chords/lead). */
  role?: string;
  /** Beat-locked handoff v2 (2026-09-25) — offset of the first beat from
   *  t=0 in the rendered WAV (seconds). 0 = transport starts on grid beat 0.
   *  Drives Audio Canvas's beat-grid phase alignment so AC visuals are
   *  lock-step with the KYX transport. */
  beatGridOffsetSec: number;
  /** Active pattern's `PatternGeneration.genre` (e.g. "house", "dnb",
   *  "ambient"). Null when the active pattern was authored manually or
   *  the generation provenance is absent. Drives the AC preset
   *  recommender's genre → mood hint. */
  genre: string | null;
  /** 0..1 confidence from KYX's tempo estimator (placeholder 0.9 today
   *  — the estimator is currently the deterministic scheduler). */
  bpmConfidence: number;
}

export interface KyxSourceMapEntry {
  hash: string;
  trackName: string;
  role: string;
  durationSec: number;
  byteLength: number;
}

/** Non-group tracks in document order, capped — the tool map of the send. */
export function buildSourceMapEntries(
  doc: ProjectDocument,
): Array<{ trackId: string; trackName: string; role: string }> {
  return doc.tracks
    .filter((t) => (t as { kind: string }).kind !== "group")
    .slice(0, KYX_MAX_STEMS)
    .map((t) => {
      const track = t as { id: string; name: string };
      return { trackId: track.id, trackName: track.name, role: roleOfTrack(t as never) ?? "lead" };
    });
}

/** Reconstruct the handoff WAV as a Blob (the receiver wraps it in a File). */
export function beatRecordToBlob(record: BeatHandoffRecord): Blob {
  return new Blob([record.wav], { type: "audio/wav" });
}

/**
 * Beat-locked handoff v2 (2026-09-25): extract the cross-app metadata
 * (beatGridOffsetSec, genre, bpmConfidence) from the project document.
 *
 * - `beatGridOffsetSec` is the offset of the first beat from t=0 in
 *   the rendered WAV. KYX renders with the transport starting at bar 1
 *   / beat 0, so the value is 0 for a fresh render. The field exists so
 *   future KYX scenes can choose any grid phase and Audio Canvas still
 *   locks to it.
 * - `genre` comes from the active pattern's `PatternGeneration.genre`.
 *   Null when the pattern was authored manually (no generation provenance).
 * - `bpmConfidence` is currently a fixed 0.9 — the KYX scheduler IS the
 *   tempo authority (it's a deterministic transport), so the value is
 *   not heuristic. Bumped later when a measured confidence exists.
 */
export function gatherBeatMetadata(doc: ProjectDocument): {
  beatGridOffsetSec: number;
  genre: string | null;
  bpmConfidence: number;
} {
  // Defensive: test fixtures and a few transitional project shapes may
  // not yet carry `patterns` / `activePatternId`. When the array is
  // absent we return nulls — the packet still rides the bpm/key/camelot
  // through the existing fields.
  if (!Array.isArray(doc.patterns) || doc.patterns.length === 0) {
    return { beatGridOffsetSec: 0, genre: null, bpmConfidence: 0.9 };
  }
  const activePattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  const generationGenre =
    activePattern && typeof (activePattern as { generation?: { genre?: string } }).generation?.genre === "string"
      ? (activePattern as { generation?: { genre?: string } }).generation?.genre ?? null
      : null;
  return {
    beatGridOffsetSec: 0,
    genre: generationGenre,
    bpmConfidence: 0.9,
  };
}

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  // crypto.subtle.digest requires BufferSource = ArrayBuffer | ArrayBufferView<ArrayBuffer>.
  // Uint8Array<ArrayBufferLike> would fail the strict ArrayBuffer constraint; a Uint8Array
  // built from a Blob-backed ArrayBuffer is never SharedArrayBuffer in this codebase.
  const buffer: ArrayBuffer = data instanceof Uint8Array ? (data.buffer as ArrayBuffer) : data;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function withIdb<T>(run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    // A blocked open (another tab holds an older DB version) or an aborted
    // transaction would otherwise leave this promise unsettled forever — the
    // send button would hang with no diagnostic (GOAL 04, re-run 4). Same
    // bounded-open convention as persistence/db.ts (5 s).
    let settled = false;
    const resolve = (value: T) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const reject = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const open = indexedDB.open(HANDOFF_DB_NAME, 1);
    const blockedTimer = setTimeout(
      () => reject(new Error("handoff IDB open blocked by another tab — close it and retry")),
      5000,
    );
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(HANDOFF_STORE_NAME)) {
        open.result.createObjectStore(HANDOFF_STORE_NAME, { keyPath: "hash" });
      }
    };
    open.onerror = () => {
      clearTimeout(blockedTimer);
      reject(open.error ?? new Error("handoff IDB open failed"));
    };
    open.onsuccess = () => {
      clearTimeout(blockedTimer);
      const db = open.result;
      try {
        const tx = db.transaction(HANDOFF_STORE_NAME, "readwrite");
        const request = run(tx.objectStore(HANDOFF_STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("handoff IDB request failed"));
        tx.onabort = () => reject(tx.error ?? new Error("handoff IDB transaction aborted"));
        tx.oncomplete = () => {
          resolve(request.result as T);
          db.close();
        };
      } catch (error) {
        db.close();
        reject(error instanceof Error ? error : new Error(String(error)));
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
  /** ISO timestamp — required by the Audio Canvas packet validator. */
  timestamp: string;
  sourceApp: "pulse_forge";
  targetApp: typeof TARGET_APP;
  initiatedBy: "user";
  intent: typeof KYX_HANDOFF_INTENT;
  createdAt: number;
  expiresAt: number;
  ttl: number;
  payload: {
    inputs: Array<{
      type: string;
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

export function buildBeatHandoffPacket(
  record: BeatHandoffRecord,
  doc: ProjectDocument,
  sourceMap: KyxSourceMapEntry[] = [],
): BeatHandoffPacket {
  const createdAt = Date.now();
  const key = keyToCamelot(doc.key);
  const beatMeta = gatherBeatMetadata(doc);
  const metadata = {
    bpm: record.bpm,
    key: key.key,
    mode: key.mode,
    camelot: key.camelot,
    declaredSource: "kyx project metadata",
    durationSec: record.durationSec,
    sampleRate: record.sampleRate,
    byteLength: record.byteLength,
    // Beat-locked handoff v2 (2026-09-25) — cross-app rhythm alignment
    // + genre hint for the AC preset recommender.
    beatGridOffsetSec: record.beatGridOffsetSec ?? beatMeta.beatGridOffsetSec,
    genre: record.genre ?? beatMeta.genre,
    bpmConfidence: record.bpmConfidence ?? beatMeta.bpmConfidence,
  };
  const inputs: BeatHandoffPacket["payload"]["inputs"] = [
    {
      type: KYX_ARTIFACT_TYPE,
      label: `${record.name} (KYX render)`,
      uri: `qvester-blob:${record.hash}`,
      value: JSON.stringify(metadata),
      metadata: { format: "audio/wav", transport: "local-reference" },
    },
  ];
  if (sourceMap.length > 0) {
    inputs.push({
      type: KYX_SOURCE_MAP_ARTIFACT_TYPE,
      label: `Instrument map — ${sourceMap.length} track(s)`,
      uri: `qvester-blob:${record.hash}`,
      value: JSON.stringify({ stems: sourceMap }),
      metadata: { roles: [...new Set(sourceMap.map((e) => e.role))] },
    });
  }
  return {
    version: "2.0",
    handoffId: generateHandoffId(),
    timestamp: new Date(createdAt).toISOString(),
    sourceApp: "pulse_forge",
    targetApp: TARGET_APP,
    initiatedBy: "user",
    intent: KYX_HANDOFF_INTENT,
    createdAt,
    expiresAt: createdAt + HANDOFF_TTL_MS,
    ttl: HANDOFF_TTL_MS,
    payload: {
      inputs,
      recommendedAction:
        "Bind the beat as the audio source — the deterministic analysis (bpm/key/beatGrid) then drives the reactive visuals. The instrument map lists per-track stems you can bind instead to isolate one instrument.",
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

/** Remove handoff packets whose TTL has passed. Every send persists a NEW
 *  uuid key — without this sweep localStorage grows forever (the blob store
 *  has its own 24 h prune; packets are useless past their 30 min TTL). */
function pruneExpiredPackets(): void {
  const now = Date.now();
  for (const storage of [sessionStorage, localStorage]) {
    try {
      const stale: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key?.startsWith(PACKET_KEY_PREFIX)) continue;
        try {
          const packet = JSON.parse(storage.getItem(key) ?? "") as { expiresAt?: number };
          if (typeof packet.expiresAt !== "number" || packet.expiresAt < now) stale.push(key);
        } catch {
          stale.push(key); // unparseable — it can never be a valid handoff again
        }
      }
      for (const key of stale) storage.removeItem(key);
    } catch {
      /* storage inaccessible — nothing to prune */
    }
  }
}

export function persistBeatHandoffPacket(packet: BeatHandoffPacket): boolean {
  pruneExpiredPackets();
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
  /** Per-track stems (master record excluded) — the instrument map of the send. */
  sourceMap: KyxSourceMapEntry[];
}

async function renderStemWav(
  doc: ProjectDocument,
  bank: SampleBank,
  trackId: string,
  options: SendBeatOptions,
): Promise<{ bytes: ArrayBuffer; mono: Float32Array; durationSec: number; sampleRate: number }> {
  const stemDoc = buildStemProject(doc, (t) => t.id === trackId);
  // Stems skip the master limiter/glue stage (same convention as the stems
  // export) — each tool is heard in isolation.
  const buffer = await renderProject(stemDoc, bank, {
    mode: options.mode,
    sampleRate: options.sampleRate,
    ...(options.quality !== undefined ? { quality: options.quality } : {}),
    masterProcessing: false,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const mono = mixDownToMono(buffer);
  const bytes = await encodeWavAsync(buffer, 16, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { bytes, mono, durationSec: buffer.duration, sampleRate: buffer.sampleRate };
}

/** Beat-locked handoff v2 (2026-09-25): mix a multi-channel AudioBuffer
 *  down to a single mono Float32Array of samples in [-1, 1]. Used by the
 *  stem-publisher path so each track stem can be summed into a
 *  rhythm/bass/melody group envelope without an extra decode pass. */
function mixDownToMono(buffer: AudioBuffer): Float32Array {
  const length = buffer.length;
  const out = new Float32Array(length);
  const channels = buffer.numberOfChannels;
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) out[i] += data[i]!;
  }
  if (channels > 1) {
    const inv = 1 / channels;
    for (let i = 0; i < length; i++) out[i]! *= inv;
  }
  return out;
}

/** Map an FxTrackRole onto the three sub-channels the AC visual layer
 *  exposes (rhythm/bass/melody). Drums collapse into "rhythm"; chords
 *  and lead merge into "melody" — the AC visual contract collapses the
 *  four roles into three visual layers without losing musical intent. */
function mapRoleToStemChannel(role: string): "rhythm" | "bass" | "melody" | null {
  if (role === "drums") return "rhythm";
  if (role === "bass") return "bass";
  if (role === "chords" || role === "lead") return "melody";
  return null;
}

/** Sum several Float32Arrays of (possibly) differing lengths into one
 *  Float32Array the length of the longest input. The mix is plain add —
 *  we are NOT applying a limiter; the result is used only for envelope
 *  analysis, not for playback. */
function sumSamples(list: Float32Array[]): Float32Array {
  if (list.length === 0) return new Float32Array(0);
  const length = list.reduce((m, s) => Math.max(m, s.length), 0);
  const out = new Float32Array(length);
  for (const s of list) for (let i = 0; i < s.length; i++) out[i]! += s[i]!;
  return out;
}

/** Render the current project (master + per-track stems), store everything,
 *  persist the handoff packet. Navigation is the caller's job. */
export async function prepareBeatHandoff(
  doc: ProjectDocument,
  bank: SampleBank,
  options: SendBeatOptions,
): Promise<SendBeatResult> {
  const createdAt = Date.now();
  const beatMeta = gatherBeatMetadata(doc);
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
    createdAt,
    beatGridOffsetSec: beatMeta.beatGridOffsetSec,
    genre: beatMeta.genre,
    bpmConfidence: beatMeta.bpmConfidence,
  };
  await storeBeatBlob(record);

  // ── Instrument map: one isolated stem per non-group track ──
  const entries = buildSourceMapEntries(doc);
  const sourceMap: KyxSourceMapEntry[] = [];
  // Beat-locked handoff v2 (2026-09-25): also keep the per-track mono
  // PCM around so we can sum them into role-group envelopes for the
  // audio profile bus sub-channels. Dropped after the publish step.
  const monoPerRole: Record<"rhythm" | "bass" | "melody", Float32Array[]> = {
    rhythm: [],
    bass: [],
    melody: [],
  };
  let lastSampleRate = options.sampleRate;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    options.onProgress?.((i + 0.5) / (entries.length + 1), `Rendering stem: ${entry.trackName}…`);
    const stem = await renderStemWav(doc, bank, entry.trackId, options);
    const stemHash = await sha256Hex(stem.bytes);
    const stemRecord: BeatHandoffRecord = {
      hash: stemHash,
      wav: stem.bytes,
      name: `${doc.name} — ${entry.trackName}`,
      bpm: Number.isFinite(doc.bpm) ? doc.bpm : null,
      key: doc.key ?? null,
      mode: keyToCamelot(doc.key).mode,
      camelot: keyToCamelot(doc.key).camelot,
      durationSec: stem.durationSec,
      sampleRate: stem.sampleRate,
      byteLength: stem.bytes.byteLength,
      createdAt,
      trackName: entry.trackName,
      role: entry.role,
      beatGridOffsetSec: beatMeta.beatGridOffsetSec,
      genre: beatMeta.genre,
      bpmConfidence: beatMeta.bpmConfidence,
    };
    await storeBeatBlob(stemRecord);
    sourceMap.push({
      hash: stemHash,
      trackName: entry.trackName,
      role: entry.role,
      durationSec: stem.durationSec,
      byteLength: stem.bytes.byteLength,
    });

    // Group the mono PCM by sub-channel role for the bus publish below.
    const channel = mapRoleToStemChannel(entry.role);
    if (channel) monoPerRole[channel].push(stem.mono);
    lastSampleRate = stem.sampleRate;
  }

  // ── Beat-locked v2: publish per-group envelopes on the audio profile
  //    bus sub-channels (pulse_forge/rhythm, pulse_forge/bass,
  //    pulse_forge/melody). Best-effort: a publish failure must never break
  //    the explicit WAV handoff — sibling apps simply keep looping the
  //    master envelope. ──
  for (const role of ["rhythm", "bass", "melody"] as const) {
    const samplesList = monoPerRole[role];
    if (samplesList.length === 0) continue;
    const summed = sumSamples(samplesList);
    publishStemProfile({
      role,
      samples: summed,
      sampleRate: lastSampleRate,
      parentRevision: 0, // sub-channel envelopes correlate by timestamp, not master revision
      beatMeta,
    });
  }

  const packet = buildBeatHandoffPacket(record, doc, sourceMap);
  if (!persistBeatHandoffPacket(packet)) {
    throw new Error("WebStorage rejected the handoff packet (private mode or quota) — nothing was sent.");
  }
  return { packet, record, sourceMap };
}
