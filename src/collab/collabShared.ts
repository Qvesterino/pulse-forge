/**
 * Pure collab helpers — shared by the app shell WITHOUT dragging yjs /
 * y-websocket into the main bundle. The heavy CollabSession + YDocStore
 * classes load dynamically (see services.openProject).
 */
import type { CollaboratorInfo } from "./CollaborationProvider";

export type CollabStatus = "connecting" | "connected" | "disconnected";

/** Six-char lowercase room code, e.g. "k3x9qz" — short enough to say out loud. */
export function randomRoomId(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no lookalikes (i/l/1/o/0)
  let id = "";
  for (let i = 0; i < 6; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

const PRODUCER_NAMES = ["Nova", "Static", "Ember", "Vapor", "Circuit", "Prism", "Drift", "Pulse", "Echo", "Grid"];
const USER_COLORS = ["#f59e0b", "#22d3ee", "#a78bfa", "#34d399", "#f472b6", "#60a5fa", "#fbbf24", "#fb7185"];

export function randomUser(): CollaboratorInfo {
  return {
    id: Math.random().toString(36).slice(2, 10),
    name: PRODUCER_NAMES[Math.floor(Math.random() * PRODUCER_NAMES.length)],
    color: USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)],
  };
}

/** Default collab server for the current origin (dev: ws://<host>:1234). */
export function defaultServerUrl(): string {
  if (typeof location === "undefined") return "ws://127.0.0.1:1234";
  if (location.protocol === "https:") return `wss://${location.host}`;
  return `ws://${location.hostname || "127.0.0.1"}:1234`;
}

/**
 * The `?server=` override must not become a traffic-redirection sink: a
 * crafted collab link pointing at `wss://evil` would silently relay the
 * victim's whole project and every subsequent edit through an attacker
 * host. Overrides are limited to the SAME host as the app origin (ws/wss
 * only) — self-hosted relays on other hosts can be entered in the UI,
 * which stores them deliberately, instead of arriving via links.
 *
 * Beyond the same-host gate we additionally reject:
 *   - `javascript:`, `blob:`, `data:`, `file:` (non-ws/ws schemes that
 *     some browsers accept through `new URL`);
 *   - loopback hostnames (`localhost`, `127.0.0.1`, `0.0.0.0`, `::1`)
 *     when the app itself does NOT run on loopback — a crafted link on
 *     the public site pointing at `wss://localhost` is the canonical
 *     DNS-rebinding attack;
 *   - IPv4 / IPv6 literals — same-host bypasses shouldn't depend on a
 *     user typing `192.168.x.x` in a URL parameter;
 *   - non-wss schemes when the app is served over https;
 *   - ports other than the app's own port or the default relay port
 *     for the scheme (no port-hopping on a same-host override).
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function isIpLiteral(host: string): boolean {
  // IPv4 dotted-quad.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6 in brackets (`url.hostname` keeps them in WHATWG URL) or bare.
  if (host.startsWith("[") || host.includes(":")) return true;
  return false;
}

function isAllowedServerUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // Only ws / wss. Some browsers route `javascript:` etc. through URL
  // parsing, so we re-check the raw prefix as defence-in-depth.
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return false;
  const head = raw.trim().slice(0, 32).toLowerCase();
  if (
    head.startsWith("javascript:") ||
    head.startsWith("data:") ||
    head.startsWith("blob:") ||
    head.startsWith("file:")
  ) {
    return false;
  }
  if (typeof location === "undefined") {
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  }
  // Same-host is the only allowed override path. Hostname comparison is
  // case-insensitive per RFC 3986 — normalise both sides.
  if (url.hostname.toLowerCase() !== location.hostname.toLowerCase()) return false;
  // Anti-DNS-rebinding: reject loopback overrides unless the app itself
  // is served from loopback (dev scenario).
  if (isLoopback(url.hostname) && !isLoopback(location.hostname)) return false;
  // Reject IPv4 / IPv6 literals on the override.
  if (isIpLiteral(url.hostname)) return false;
  // Force wss when served from https (mixed-content relay).
  if (location.protocol === "https:" && url.protocol !== "wss:") return false;
  // Port must match either the app's own port or the default relay port
  // for the scheme. Reject port-hopping on the same host.
  //
  // Note: URL ctor strips the scheme-default port — `ws://host:80`,
  // `wss://host:443`, `http://host:80`, `https://host:443` all parse
  // with `url.port === ""`. Treating that as "no explicit port" and
  // silently accepting it would let an attacker slide a ws://same-host:80
  // override past the gate; require an explicit port instead.
  if (!url.port) return false;
  const allowedPorts = new Set<string>();
  if (location.port) allowedPorts.add(location.port);
  allowedPorts.add(url.protocol === "wss:" ? "443" : "1234");
  if (!allowedPorts.has(url.port)) return false;
  return true;
}

/** Parse ?collab=<room>[&server=<url>] from a search string (pure for tests). */
export function collabParamsFromSearch(search: string): { roomId: string; serverUrl: string } | null {
  if (!search) return null;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const roomId = params.get("collab");
  if (!roomId) return null;
  const serverOverride = params.get("server");
  const serverUrl = serverOverride && isAllowedServerUrl(serverOverride) ? serverOverride : defaultServerUrl();
  return { roomId, serverUrl };
}

/** Build a share URL for a room (pure for tests). */
export function shareUrl(roomId: string, serverUrl: string, origin: string): string {
  const url = new URL(origin);
  url.searchParams.set("collab", roomId);
  if (serverUrl !== defaultServerUrl()) url.searchParams.set("server", serverUrl);
  return url.toString();
}
