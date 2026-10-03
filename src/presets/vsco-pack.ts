import type { InstrumentPreset } from "./types";
import type { SampleBank } from "../sample-library/factory";
import { decodeAudioData } from "../services/audio-decode";
import { assetUrl } from "../shared/assetUrls";
import { VSCO_PACK_LAYERS } from "./vsco-pack.generated";

/**
 * VSCO 2 CE ORCHESTRAL PACK — Versilian Studios Community Edition (CC0):
 * strings ensembles, flute, clarinet, french horn, harp, glockenspiel,
 * marimba (see scripts/convert-vsco2.mjs for the subset + conversion).
 *
 * Samples live in `public/samples/vsco/` (regenerate from the free source
 * with the converter). The loader mirrors piano-pack.ts: fetch on demand,
 * missing/failing files leave the zone unresolved (never throws into the UI).
 */

export const VSCO_PACK_PREFIX = "factory.vsco.";

export function isVscoPackSample(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(VSCO_PACK_PREFIX);
}

export function vscoPackSampleIds(): string[] {
  return [...new Set(VSCO_PACK_LAYERS.map((l) => l.sampleId).filter((id): id is string => !!id))];
}

/** One InstrumentPreset per converted instrument (its own sampler voice). */
export function vscoPackPresets(): InstrumentPreset[] {
  const byInstrument = new Map<string, typeof VSCO_PACK_LAYERS>();
  for (const layer of VSCO_PACK_LAYERS) {
    const inst = layer.id.replace("layer.vsco.", "").replace(/\.r\d+$/, "");
    if (!byInstrument.has(inst)) byInstrument.set(inst, []);
    byInstrument.get(inst)!.push(layer);
  }
  const names: Record<string, string> = {
    uprightPiano: "Upright Piano",
    gmPerc: "Real Percussion Kit",
    violinEns: "Violin Ensemble",
    celloEns: "Cello Ensemble",
    flute: "Flute",
    clarinet: "Clarinet",
    fHorn: "French Horn",
    harp: "Harp",
    glockenspiel: "Glockenspiel",
    marimba: "Marimba",
  };
  const out: InstrumentPreset[] = [];
  for (const [inst, layers] of byInstrument) {
    if (layers.length === 0) continue;
    const mid = layers[Math.floor(layers.length / 2)];
    out.push({
      id: `factory.vsco.${inst}`,
      name: `${names[inst] ?? inst} (VSCO)`,
      instrument: "sampler",
      genre: null,
      mood: ["warm", "clean"],
      tags: ["orchestral", "real", "pack", inst.toLowerCase()],
      params: {},
      sampleId: mid.sampleId,
      velocityLayers: layers,
    });
  }
  return out;
}

const fetched = new Set<string>();
let ensureInFlight: Promise<void> | null = null;

export async function ensureVscoPackLoaded(
  bank: SampleBank,
  docSampleIds: Iterable<string | null | undefined> = [],
): Promise<void> {
  const referenced = new Set<string>();
  for (const layer of VSCO_PACK_LAYERS) if (layer.sampleId) referenced.add(layer.sampleId);
  for (const id of docSampleIds) if (id && isVscoPackSample(id)) referenced.add(id);

  const pending = [...referenced].filter((id) => !fetched.has(id) && !bank.has(id));
  if (pending.length === 0) return;
  if (ensureInFlight) return ensureInFlight;

  ensureInFlight = (async () => {
    let ok = 0;
    const queue = [...pending];
    const worker = async () => {
      while (queue.length > 0) {
        const id = queue.shift()!;
        try {
          const response = await fetch(assetUrl(`/samples/vsco/${id}.wav`));
          if (!response.ok) continue;
          const data = await response.arrayBuffer();
          bank.add(id, await decodeAudioData(data));
          fetched.add(id);
          ok += 1;
        } catch {
          // Offline/install without the pack — the zone stays unresolved.
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (ok < pending.length) {
      console.warn(
        `[vsco-pack] ${pending.length - ok}/${pending.length} samples failed to load — run scripts/convert-vsco2.mjs to build the pack`,
      );
    }
  })().finally(() => {
    ensureInFlight = null;
  });
  return ensureInFlight;
}
