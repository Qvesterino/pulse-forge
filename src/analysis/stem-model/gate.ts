/**
 * S3 — STEM MODEL GATE (ADR 0019 Tier 2): the audio-tag ritual applied to
 * htdemucs. A fetched checkpoint is a CANDIDATE; it becomes an actor only
 * when (a) the user flipped `pf:stem-model` to on, (b) a manifest exists on
 * this origin, (c) the manifest validates against the contract, and
 * (d) `gatePassed` is pinned in it. Everything degrades to "unavailable"
 * without throwing — the never-throw contract of every model client here.
 */

import { assetUrl } from "../../shared/assetUrls";

export const STEM_MODEL_FLAG = "pf:stem-model";
export const STEMS_MANIFEST_PATH = "/models/stem/manifest.json";

export interface StemModelManifest {
  stemModelVersion: string;
  /** Model checkpoint identity (e.g. "htdemucs"). */
  model: string;
  /** sha256 of the ONNX file, pinned at fetch time. */
  modelHash: string;
  /** ONNX file path relative to the manifest. */
  modelFile: string;
  /** Expected sample rate of the model's input. */
  sampleRate: number;
  /** Native chunk length in seconds the export was validated with. */
  chunkSec: number;
  stems: ["vocals", "drums", "bass", "other"];
  /** Optional ONNX IO name overrides — defaults follow the demucs
   * convention (first input, first output). */
  inputName?: string;
  outputName?: string;
  /** Set true ONLY after the S4 validation pass (golden set + smoke). */
  gatePassed: boolean;
}

export function isStemModelManifest(value: unknown): value is StemModelManifest {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.stemModelVersion === "string" &&
    typeof m.model === "string" &&
    typeof m.modelHash === "string" &&
    m.modelHash.length === 64 &&
    typeof m.modelFile === "string" &&
    typeof m.sampleRate === "number" &&
    m.sampleRate > 0 &&
    typeof m.chunkSec === "number" &&
    m.chunkSec > 0 &&
    Array.isArray(m.stems) &&
    m.stems.length === 4 &&
    m.stems.every((s) => typeof s === "string") &&
    typeof m.gatePassed === "boolean"
  );
}

export function manifestGatePassed(manifest: StemModelManifest): boolean {
  return manifest.gatePassed === true;
}

export function stemModelFlagOn(): boolean {
  try {
    return localStorage.getItem(STEM_MODEL_FLAG) === "on";
  } catch {
    return false;
  }
}

export function setStemModelFlag(on: boolean): void {
  try {
    if (on) localStorage.setItem(STEM_MODEL_FLAG, "on");
    else localStorage.removeItem(STEM_MODEL_FLAG);
  } catch {
    /* storage blocked — caller-side state still flips */
  }
}

/** Probe this origin for the manifest; remembers a 404 for the session. */
let probeUnavailable = false;

export function resetStemModelProbe(): void {
  probeUnavailable = false;
}

export async function probeStemModelManifest(): Promise<StemModelManifest | null> {
  if (probeUnavailable) return null;
  try {
    const response = await fetch(assetUrl(STEMS_MANIFEST_PATH));
    if (!response.ok) {
      probeUnavailable = true;
      return null;
    }
    const manifest = (await response.json()) as unknown;
    if (!isStemModelManifest(manifest)) {
      probeUnavailable = true;
      return null;
    }
    return manifest;
  } catch {
    probeUnavailable = true;
    return null;
  }
}
