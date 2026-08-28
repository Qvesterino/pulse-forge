/**
 * freesound.org integration — search and import CC0 one-shots directly
 * into the sample bank.
 *
 * Design notes:
 *  - Freesound requires an API token and this is a client-side app, so the
 *    token is user-provided (free, instant: https://freesound.org/api/apply)
 *    and stored in localStorage — never shipped with the bundle.
 *  - Search is filtered to Creative Commons 0 (public domain): zero
 *    attribution required, zero licensing risk for shared/embedded beats.
 *  - Full-quality downloads require OAuth2, but the HQ MP3 previews live on
 *    a public CDN and are perfect for one-shot pads; imports are labeled
 *    "preview quality" to be honest about it.
 *  - Imported previews flow through the normal user-sample pipeline
 *    (bank + IndexedDB persistence), so they work with Slice Lab, reloads
 *    and the wavetable/granular engines like any other sample.
 */

const API_BASE = "https://freesound.org/apiv2";
const TOKEN_STORAGE_KEY = "pulse-forge.freesound-token";

export interface FreesoundResult {
  id: number;
  name: string;
  username: string;
  durationSec: number;
  /** HQ MP3 preview on the public CDN (no auth needed to download). */
  previewUrl: string;
  license: string;
}

export class FreesoundError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FreesoundError";
  }
}

export function loadFreesoundToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveFreesoundToken(token: string): void {
  try {
    if (token.trim()) localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // storage unavailable (private mode) — token lives only for this session
  }
}

interface RawSound {
  id: number;
  name: string;
  username: string;
  duration: number;
  previews?: { "preview-hq-mp3"?: string; "preview-lq-mp3"?: string };
  license: string;
}

function mapResult(raw: RawSound): FreesoundResult | null {
  const previewUrl = raw.previews?.["preview-hq-mp3"] ?? raw.previews?.["preview-lq-mp3"];
  if (!previewUrl) return null;
  return {
    id: raw.id,
    name: raw.name,
    username: raw.username,
    durationSec: raw.duration,
    previewUrl,
    license: raw.license,
  };
}

export interface SearchOptions {
  token: string;
  /** Max sound length in seconds — one-shots for pads (default 8). */
  maxDurationSec?: number;
  page?: number;
}

/** Search freesound for CC0 sounds matching the query. */
export async function searchFreesound(query: string, options: SearchOptions): Promise<FreesoundResult[]> {
  if (!options.token) throw new FreesoundError("No API token set — get a free one at freesound.org/api/apply", 0);
  const params = new URLSearchParams({
    query,
    token: options.token,
    page: String(options.page ?? 1),
    page_size: "15",
    fields: "id,name,username,duration,previews,license",
    filter: `license:"Creative Commons 0" duration:[0 TO ${options.maxDurationSec ?? 8}]`,
  });
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/search/text/?${params.toString()}`);
  } catch {
    throw new FreesoundError("Network error — freesound.org unreachable", 0);
  }
  if (response.status === 401) {
    throw new FreesoundError("Invalid API token — check it at freesound.org/api/", 401);
  }
  if (!response.ok) {
    throw new FreesoundError(`Freesound search failed (${response.status})`, response.status);
  }
  const json = (await response.json()) as { results?: RawSound[] };
  return (json.results ?? []).map(mapResult).filter((r): r is FreesoundResult => r !== null);
}

/** Download a result's HQ MP3 preview bytes (public CDN, no auth). */
export async function fetchFreesoundPreview(result: FreesoundResult): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(result.previewUrl);
  } catch {
    throw new FreesoundError("Network error downloading the preview", 0);
  }
  if (!response.ok) throw new FreesoundError(`Preview download failed (${response.status})`, response.status);
  return response.arrayBuffer();
}

/** Convert a freesound name to a clean user-sample id. */
export function freesoundSampleId(result: FreesoundResult): string {
  const slug =
    result.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "sound";
  return `fs-${result.id}-${slug}`;
}
