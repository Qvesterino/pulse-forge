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
  /** Playback counter — incremented by POST /api/gallery/:id/play. */
  plays?: number;
  /** How many published beats call this one their parent. */
  remixCount?: number;
  /** Present when this beat was published as a remix of another beat. */
  parentId?: string | null;
}

export interface PublishInput {
  title: string;
  author: string;
  tags: string[];
  code: string;
  /** Gallery id of the beat this was forked from (remix chain). */
  parentId?: string | null;
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

/**
 * Count one playback. Fire-and-forget (the feed never blocks on it) and
 * deduplicated per beat per session, so hammering the play button or a
 * page refresh does not inflate the counter.
 */
const playedThisSession = new Set<string>();

export async function registerPlay(id: string, baseUrl: string = galleryBaseUrl()): Promise<number | null> {
  if (playedThisSession.has(id)) return null;
  playedThisSession.add(id);
  try {
    const res = await fetch(`${baseUrl}/api/gallery/${encodeURIComponent(id)}/play`, { method: "POST" });
    if (!res.ok) return null;
    const body = (await res.json()) as { plays?: number };
    return typeof body.plays === "number" ? body.plays : null;
  } catch {
    return null;
  }
}

/** 42 → "42", 1234 → "1.2k", 1200000 → "1.2m" — the feed's count badges. */
export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

// ── creator handle + remix chain (localStorage, 24 h TTL on the chain) ──────

const HANDLE_KEY = "pf-creator-name";
const REMIX_PARENT_KEY = "pf-remix-parent";
const REMIX_TTL_MS = 24 * 60 * 60 * 1000;

/** Persisted author name — "by <handle>" stops being random on every publish. */
export function creatorHandle(): string {
  try {
    return localStorage.getItem(HANDLE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveCreatorHandle(name: string): void {
  try {
    if (name.trim()) localStorage.setItem(HANDLE_KEY, name.trim());
  } catch {
    // storage blocked — the handle just is not remembered
  }
}

export interface RemixParent {
  id: string;
  title: string;
  savedAt: number;
}

/** FORK writes this; the publish form reads (and clears) it. */
export function setRemixParent(parent: { id: string; title?: string }): void {
  try {
    localStorage.setItem(
      REMIX_PARENT_KEY,
      JSON.stringify({ id: parent.id, title: parent.title ?? "a gallery beat", savedAt: Date.now() } satisfies RemixParent),
    );
  } catch {
    // storage blocked — publishing still works, just without the chain
  }
}

/** Fresh (24 h) fork origin, if any. */
export function peekRemixParent(): RemixParent | null {
  try {
    const raw = localStorage.getItem(REMIX_PARENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RemixParent;
    if (typeof parsed.id !== "string" || Date.now() - (parsed.savedAt ?? 0) > REMIX_TTL_MS) {
      localStorage.removeItem(REMIX_PARENT_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearRemixParent(): void {
  try {
    localStorage.removeItem(REMIX_PARENT_KEY);
  } catch {
    // ignore
  }
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
