import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import { normalizeProject, validateProjectShape } from "../project-model/schema";
import type { ProjectDocument } from "../project-model/types";

/**
 * Share codes: a whole project compressed into a URL-safe token.
 *
 * The app has no backend — the share link IS the project. lz-string's
 * URI-component encoding keeps the token free of characters that need
 * escaping, so it can live in ?import=…, /embed/#p=…, an iframe src or a
 * chat message untouched.
 */

/** Compress a project into a URL-safe share token. */
export function encodeShareCode(doc: ProjectDocument): string {
  return compressToEncodedURIComponent(JSON.stringify(doc));
}

// Decompression-bomb caps: a crafted ?import= URL (URLs can carry megabytes)
// previously expanded + parsed on the main thread at boot with no ceiling —
// one tab-killer OOM away from a hung boot. Real projects sit far below
// these limits (a full project is a few hundred KB of JSON at worst).
const MAX_TOKEN_CHARS = 2_000_000;
const MAX_DECOMPRESSED_CHARS = 8_000_000;

/** Decompress a share token back into a normalized project. Null when invalid. */
export function decodeShareCode(code: string): ProjectDocument | null {
  try {
    if (typeof code !== "string" || code.length > MAX_TOKEN_CHARS) return null;
    const json = decompressFromEncodedURIComponent(code);
    if (!json || json.length > MAX_DECOMPRESSED_CHARS) return null;
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!validateProjectShape(parsed as Record<string, unknown>)) return null;
    return normalizeProject(parsed as ProjectDocument);
  } catch {
    return null;
  }
}

/** Studio URL that auto-opens the shared project (?import=…). */
export function shareAppUrl(code: string, origin: string): string {
  return `${origin}/?import=${code}`;
}

/** Self-contained embed player URL (/embed/#p=…). */
export function embedUrl(code: string, origin: string): string {
  return `${origin}/embed/#p=${code}`;
}

/** iframe snippet for pasting into Discord/Reddit/websites. */
export function embedSnippet(url: string): string {
  // Escape HTML-significant characters before interpolation so a crafted
  // URL can't break out of the `src="..."` quote and inject arbitrary HTML
  // when the snippet is pasted into a page that doesn't sanitise. `&` is
  // escaped first so the subsequent entity replacements don't double-escape.
  const safe = url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<iframe src="${safe}" width="100%" height="220" frameborder="0" style="border:1px solid #26272c;border-radius:8px" title="KYX beat"></iframe>`;
}
