/**
 * GALLERY RENDER PROVENANCE — the verifiable-publish layer.
 *
 * A published beat can carry the RENDER provenance of the export it came from:
 * the SHA-256 of the rendered PCM plus the AI receipts (which models are in
 * the mix). Nothing is stored as a boolean flag — the badge and the filter are
 * DERIVED from this object, so a claim cannot go stale against its own data.
 *
 * The same discipline as the rest of the codebase applies: the studio attaches
 * provenance only when it actually has a render stamp (an unexported project
 * publishes as a plain beat, honestly), `sanitizeGalleryRenderProvenance` is
 * the single shape check used by the client, and the server re-validates with
 * the same bounds — a malformed or oversized payload is refused, never stored.
 */
import type { LastRenderStamp } from "../export/renderManifest";

export const GALLERY_RENDER_KEY = "pf:publish-render";
export const GALLERY_RENDER_FORMAT = "kyx-render-provenance/1";
export const MAX_GALLERY_MODELS = 8;
export const MAX_GALLERY_MODEL_CHARS = 64;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface GalleryRenderProvenance {
  /** SHA-256 of the rendered float PCM (the protocol's hash). */
  hash: string;
  algorithm: "SHA-256";
  /** Which manifest version the export carried. */
  manifestFormat: string;
  /** provider/model pairs, bounded and sorted; empty = no AI in the mix. */
  models: string[];
}

export function sanitizeGalleryRenderProvenance(value: unknown): GalleryRenderProvenance | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.hash !== "string" || !HASH_RE.test(raw.hash)) return null;
  if (raw.algorithm !== "SHA-256") return null;
  const manifestFormat = typeof raw.manifestFormat === "string" ? raw.manifestFormat.slice(0, 64) : "";
  if (manifestFormat === "") return null;
  const models = Array.isArray(raw.models)
    ? [
        ...new Set(
          raw.models.filter(
            (model): model is string =>
              typeof model === "string" && model.length > 0 && model.length <= MAX_GALLERY_MODEL_CHARS,
          ),
        ),
      ]
        .sort()
        .slice(0, MAX_GALLERY_MODELS)
    : [];
  return { hash: raw.hash, algorithm: "SHA-256", manifestFormat, models };
}

/** Build the publish payload from the last export stamp; null without a hash. */
export function provenanceFromStamp(stamp: LastRenderStamp | null): GalleryRenderProvenance | null {
  if (stamp == null || stamp.manifest.hash.value == null) return null;
  const models = new Set<string>();
  for (const asset of stamp.manifest.aiAssets) models.add(`${asset.providerId}/${asset.modelId}`);
  for (const track of stamp.manifest.aiTracks) models.add(`${track.providerId}/${track.modelId}`);
  for (const pattern of stamp.manifest.aiPatterns) models.add(`${pattern.engineId}@${pattern.engineVersion}`);
  return sanitizeGalleryRenderProvenance({
    hash: stamp.manifest.hash.value,
    algorithm: "SHA-256",
    manifestFormat: stamp.manifest.format,
    models: [...models],
  });
}

/** How many models are in the mix, for the badge. */
export function provenanceModelCount(provenance: GalleryRenderProvenance | null | undefined): number {
  return provenance?.models.length ?? 0;
}

/** The exact command a reader can run to check a downloaded file. */
export function provenanceVerifyHint(provenance: GalleryRenderProvenance): string {
  return `npx kyx-verify <file.wav> --expect ${provenance.hash}`;
}
