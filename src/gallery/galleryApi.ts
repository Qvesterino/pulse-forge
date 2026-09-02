/**
 * Beat Gallery client — talks to the tiny JSON store on the collab server.
 *
 * A gallery item IS a share code (the same lz-string token behind
 * ?import= links and /embed players), so publishing needs no upload of
 * audio and playback needs no streaming — the embed player already knows
 * how to play one.
 */
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import { validateProjectShape } from "../project-model/schema";
import type { ProjectDocument } from "../project-model/types";

export interface GalleryItem {
  id: string;
  title: string;
  author: string;
  tags: string[];
  code: string;
  bpm: number | null;
  projectName: string;
  createdAt: string;
}

export interface PublishInput {
  title: string;
  author: string;
  tags: string[];
  code: string;
}

const API_KEY = "pf-gallery-api";

/**
 * Where the gallery server lives. The studio may be served from a static
 * host while the collab server runs elsewhere, so:
 *   1. localStorage override (set by collab panel conventions)
 *   2. localhost dev → the collab server's default port
 *   3. production → same origin (/api/gallery is served alongside the app)
 */
export function galleryBaseUrl(): string {
  try {
    const override = localStorage.getItem(API_KEY);
    if (override) return override.replace(/\/$/, "");
  } catch {
    // storage blocked — fall through
  }
  if (typeof location !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    return "http://127.0.0.1:1234";
  }
  return "";
}

export async function listBeats(baseUrl: string = galleryBaseUrl()): Promise<GalleryItem[]> {
  const res = await fetch(`${baseUrl}/api/gallery`);
  if (!res.ok) throw new Error(`Gallery unavailable (${res.status})`);
  const body = (await res.json()) as { items?: GalleryItem[] };
  return Array.isArray(body.items) ? body.items : [];
}

export async function publishBeat(input: PublishInput, baseUrl: string = galleryBaseUrl()): Promise<GalleryItem> {
  const res = await fetch(`${baseUrl}/api/gallery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as { item?: GalleryItem; error?: string };
  if (!res.ok || !body.item) throw new Error(body.error ?? `Publish failed (${res.status})`);
  return body.item;
}

/** Encode the current project for publishing (share-code pipeline). */
export function encodeProjectForGallery(doc: ProjectDocument): string {
  return compressToEncodedURIComponent(JSON.stringify(doc));
}

/**
 * Extract a share code from user input: a raw token, a studio link
 * (?import=…), an embed link (#p=…) or an iframe snippet pasted from the
 * Export panel. Returns null when nothing extractable is found.
 */
export function extractShareCode(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;
  const patterns = [/[?#](?:import|p)=([A-Za-z0-9+/=_-]+)/g, /src="([^"]+)"/g];
  const candidates: string[] = [];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      // The first group is the code itself, or a URL containing it.
      const hit = match[1];
      const codeMatch = /[?#](?:import|p)=([A-Za-z0-9+/=_-]+)/.exec(hit);
      candidates.push(codeMatch ? codeMatch[1] : hit);
    }
  }
  candidates.push(raw);
  for (const candidate of candidates) {
    if (candidate.length > 16 && looksLikeProjectCode(candidate)) return candidate;
  }
  return null;
}

/** Cheap structural check — real validation happens on decode + shape check. */
function looksLikeProjectCode(code: string): boolean {
  try {
    const json = decompressFromEncodedURIComponent(code);
    if (!json) return false;
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && validateProjectShape(parsed as Record<string, unknown>);
  } catch {
    return false;
  }
}
