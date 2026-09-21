/**
 * ASSET URL CONTRACT (cross-platform campaign GOAL 03).
 *
 * Static assets — the 7 prebuilt AudioWorklet bundles in `public/`, ONNX
 * model binaries, ORT wasm, curated sample sets — are addressed by
 * ROOT-ABSOLUTE paths (`/core-worklet.js`, `/models/…`). That assumes an
 * http-like origin where root-relative URLs resolve, which is exactly what
 * the Electron shell had to reproduce with its custom `app://` standard
 * scheme. Any other host (subpath deployment, native bundle, test runner)
 * needs to remap them — in exactly one place.
 *
 * Responsibilities: map a root-absolute asset path to its fetchable URL.
 * Inputs: a path beginning with `/`. Outputs: a URL string (default:
 * unchanged — zero behavior change until a host configures a base).
 * Error model: none — pure string mapping; unknown paths are not the
 * resolver's problem (the fetcher reports 404s).
 * Lifecycle: hosts call `configureAssetBase` ONCE at boot, before any
 * worklet/model/sample loads; reconfiguration later affects only new loads.
 * Cancellation: n/a. Capability limits: no per-asset overrides — a platform
 * with split asset stores should extend the config, not fork call sites.
 */

let assetBase = "";

/**
 * Set a base prefix for every root-absolute asset path. Call once at boot.
 * Examples: `/studio` (subpath hosting), `https://cdn.example.com/kyx`
 * (split asset host). Empty string (default) = paths pass through verbatim.
 */
export function configureAssetBase(base: string): void {
  assetBase = base.replace(/\/$/, "");
}

/** Map a root-absolute asset path (`/models/x.json`) to its fetchable URL. */
export function assetUrl(absolutePath: string): string {
  return assetBase ? `${assetBase}${absolutePath}` : absolutePath;
}
