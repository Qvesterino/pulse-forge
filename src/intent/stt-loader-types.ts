/**
 * LOCAL STT (WHISPER) — TYPES (pipeline step [A], docs/LOCAL-INTENT-MODEL.md
 * §6). Manifest #2 in the src/ai drawer: same guarantees as the intent model
 * loader — lazy worker, manifest probe, SHA-256 pin, timeouts, breaker,
 * controlled failures. Voice is a TEXT SOURCE: the transcript lands in the
 * intent bar and re-enters the pipeline at [B]; nothing auto-executes.
 */

export interface SttManifest {
  sttModelVersion: string;
  schemaVersion: number;
  /** Runtime adapter module (vendored whisper WASM/ONNX), origin-relative. */
  runtime: { kind: string; module: string; export: string };
  model: { url: string; bytes: number; sha256: string };
  /** Audio contract the runtime expects. */
  audio: { sampleRate: number; language: string };
  /** Hints surfaced in the UI chip. */
  label?: string;
}

export type SttRequest =
  { type: "load"; id: number } | { type: "transcribe"; id: number; samples: Float32Array; sampleRate: number };

export type SttResponse =
  | { type: "loaded"; id: number; version: string }
  | { type: "result"; id: number; text: string }
  | { type: "error"; id: number; message: string };

export function isSttManifest(value: unknown): value is SttManifest {
  if (value == null || typeof value !== "object") return false;
  const m = value as Partial<SttManifest>;
  const HEX = /^[0-9a-f]{64}$/;
  if (typeof m.sttModelVersion !== "string" || m.sttModelVersion.length === 0) return false;
  if (typeof m.schemaVersion !== "number" || !Number.isInteger(m.schemaVersion) || m.schemaVersion < 1) return false;
  if (m.runtime == null || typeof m.runtime !== "object") return false;
  if (typeof m.runtime.kind !== "string" || m.runtime.kind.length === 0) return false;
  if (typeof m.runtime.module !== "string" || !m.runtime.module.startsWith("/")) return false;
  if (typeof m.runtime.export !== "string" || m.runtime.export.length === 0) return false;
  if (m.model == null || typeof m.model !== "object") return false;
  if (typeof m.model.url !== "string" || !m.model.url.startsWith("/")) return false;
  if (typeof m.model.bytes !== "number" || !Number.isInteger(m.model.bytes) || m.model.bytes <= 0) return false;
  if (typeof m.model.sha256 !== "string" || !HEX.test(m.model.sha256)) return false;
  if (m.audio == null || typeof m.audio !== "object") return false;
  if (m.audio.sampleRate !== 16000) return false;
  if (typeof m.audio.language !== "string" || m.audio.language.length === 0) return false;
  return true;
}

export type SttModelMode = "on" | "off";

/** Feature-flag contract shared with the panel chip. */
export interface SttTranscriber {
  transcribe(samples: Float32Array, sampleRate: number): Promise<string | null>;
}
