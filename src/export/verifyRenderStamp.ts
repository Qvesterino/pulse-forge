/**
 * REPRODUCE / VERIFY (Wave 2/C, closing step).
 *
 * The stamp alone makes a claim; this is the part that CHECKS it. A file's
 * iXML manifest carries the render recipe (mode, rate, quality, tail) and a
 * SHA-256 of the rendered PCM — re-rendering the open project with that exact
 * recipe and comparing hashes proves "this is the same audio", bit for bit.
 *
 * It re-renders through the SAME offline renderer the export used, so this
 * path cannot drift from export semantics. A mismatch is reported, never
 * hidden: it means the project (or the quality switch) changed since the file
 * was written, and the user needs to know that before they ship the file.
 */

import type { ProjectDocument } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import { renderProject } from "../rendering/renderer";
import {
  hashPcmChannels,
  reproductionSettings,
  verifyRenderManifest,
  type ManifestVerification,
  type RenderManifest,
} from "./renderManifest";

export interface VerifyRenderStampInput {
  manifest: RenderManifest;
  doc: ProjectDocument;
  bank: SampleBank;
  signal?: AbortSignal;
}

export interface VerifyRenderStampOutcome extends ManifestVerification {
  /** True when the project matched closely enough to re-render at all. */
  reRendered: boolean;
  /** Hash of the fresh re-render (null when hashing was unavailable). */
  reRenderedHash: string | null;
}

export async function verifyRenderStamp(input: VerifyRenderStampInput): Promise<VerifyRenderStampOutcome> {
  const { manifest, doc, bank, signal } = input;
  if (doc.id !== manifest.project.id) {
    // Do not waste a full render on a project that cannot match.
    const verdict = await verifyRenderManifest(manifest, { docId: doc.id, channels: [] });
    return { ...verdict, reRendered: false, reRenderedHash: null };
  }

  const settings = reproductionSettings(manifest);
  const buffer = await renderProject(doc, bank, {
    // A manifest only ever records the two play modes; anything else is
    // treated as the arrangement render the exports use.
    mode: settings.mode === "pattern" ? "pattern" : "song",
    sampleRate: settings.sampleRate,
    ...(settings.quality === "studio" || settings.quality === "live" ? { quality: settings.quality } : {}),
    ...(settings.masterProcessing !== undefined ? { masterProcessing: settings.masterProcessing } : {}),
    ...(settings.tailSeconds !== undefined ? { tailSeconds: settings.tailSeconds } : {}),
    ...(signal ? { signal } : {}),
  });
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    channels.push(buffer.getChannelData(channel));
  }
  const reRenderedHash = await hashPcmChannels(channels);
  const verdict = await verifyRenderManifest(manifest, { docId: doc.id, channels });
  return { ...verdict, reRendered: true, reRenderedHash };
}
