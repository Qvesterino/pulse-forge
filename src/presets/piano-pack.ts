import type { InstrumentPreset } from "./types";
import type { SampleBank } from "../sample-library/factory";
import { decodeAudioData } from "../services/audio-decode";
import { assetUrl } from "../shared/assetUrls";
import { PIANO_PACK_LAYERS } from "./piano-pack.generated";

/**
 * REAL PIANO PACK — Salamander Grand Piano V3 (CC-BY 3.0, Alexander Holm)
 * converted into 30 keys × 4 velocity zones (see
 * scripts/convert-salamander.mjs). Samples live in `public/samples/piano/`
 * (git-ignored — regenerate locally with the converter; ~236 MB, lazy).
 *
 * The loader follows the curated same-id contract: a missing/failing fetch
 * leaves the sampler silent for that zone (never throws into the UI) —
 * the pack is fetched on preset apply and on boot when a project
 * references it.
 */

export const REAL_PIANO_PRESET_ID = "factory.piano.real";
export const PIANO_PACK_PREFIX = "factory.piano.";

const fetched = new Set<string>();
let ensureInFlight: Promise<void> | null = null;

export function isPianoPackSample(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(PIANO_PACK_PREFIX);
}

export function realPianoLayers() {
  return PIANO_PACK_LAYERS;
}

/** The flagship preset the preset browser lists (sampler + mid-zone sample). */
export const REAL_PIANO_PRESET: InstrumentPreset = {
  id: REAL_PIANO_PRESET_ID,
  name: "Real Piano (Salamander)",
  instrument: "sampler",
  genre: null,
  mood: ["warm", "clean"],
  tags: ["piano", "real", "acoustic", "pack"],
  params: {},
  // Mid zone — the layers refine it per velocity + key once loaded.
  sampleId: "factory.piano.c4.z2",
  velocityLayers: PIANO_PACK_LAYERS,
};

/**
 * Fetch every pack sample into the bank (idempotent, concurrent-safe).
 * A failed file logs and continues — the sampler skips unresolved zones.
 */
export async function ensurePianoPackLoaded(
  bank: SampleBank,
  docSampleIds: Iterable<string | null | undefined> = [],
): Promise<void> {
  const referenced = new Set<string>();
  for (const layer of PIANO_PACK_LAYERS) if (layer.sampleId) referenced.add(layer.sampleId);
  for (const id of docSampleIds) if (id && isPianoPackSample(id)) referenced.add(id);

  const pending = [...referenced].filter((id) => !fetched.has(id) && !bank.has(id));
  if (pending.length === 0) return;
  if (ensureInFlight) return ensureInFlight;

  ensureInFlight = (async () => {
    let ok = 0;
    // Bounded concurrency: 120 × ~2 MB fetches must not open 120 sockets.
    const queue = [...pending];
    const worker = async () => {
      while (queue.length > 0) {
        const id = queue.shift()!;
        try {
          const response = await fetch(assetUrl(`/samples/piano/${id}.wav`));
          if (!response.ok) continue; // pack not downloaded — zone stays unresolved
          const data = await response.arrayBuffer();
          bank.add(id, await decodeAudioData(data));
          fetched.add(id);
          ok += 1;
        } catch {
          // Offline/install without the pack — never throws into the UI.
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (ok < pending.length) {
      console.warn(
        `[piano-pack] ${pending.length - ok}/${pending.length} samples failed to load — is the pack downloaded? (scripts/convert-salamander.mjs)`,
      );
    }
  })().finally(() => {
    ensureInFlight = null;
  });
  return ensureInFlight;
}
