/**
 * Pulse Forge collab + gallery server.
 *
 * Two jobs on one port:
 *  1. y-websocket protocol relay for real-time collaboration — rooms are
 *     created on demand ("/<roomId>" → in-memory Y.Doc). Speaks the standard
 *     yjs sync + awareness wire protocol, so the y-websocket client provider
 *     works unmodified. CRDT state lives in the clients; a restarting server
 *     re-syncs from whichever client connects next.
 *  2. Beat Gallery REST API — a tiny JSON-store-backed list of shared beats
 *     (share codes + tags). GET/POST /api/gallery, persisted to gallery.json.
 *
 * Run: npm run collab   (ws://127.0.0.1:1234 by default, PORT/HOST to change)
 *
 * Deliberately simple: no auth — a self-hosted relay + beat drop for small
 * jam sessions. Only light sanitization and rate limiting on uploads.
 */
import { createServer } from "node:http";
import { createMcpHub, handleMcpRequest, isValidToken } from "./mcp-core.mjs";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import lzstring from "lz-string";
const { decompressFromEncodedURIComponent } = lzstring;

const PORT = Number(process.env.PORT ?? 1234);
const HOST = process.env.HOST ?? "127.0.0.1";
const DEFAULT_GALLERY_FILE = join(dirname(fileURLToPath(import.meta.url)), "gallery.json");

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

// The relay is intentionally small, but its limits must be explicit before
// exposing it to the public internet. These are deliberately conservative:
// a normal project update is much smaller, while a runaway client cannot
// allocate an unbounded number of rooms, sockets, or parser buffers.
const COLLAB_DEFAULT_LIMITS = Object.freeze({
  maxRooms: 256,
  maxConnections: 512,
  maxConnectionsPerRoom: 32,
  maxRoomIdChars: 96,
  maxMessageBytes: 8 * 1024 * 1024,
});
const WS_OPEN = 1;

function normalizeCorsOrigins(value) {
  const origins = Array.isArray(value) ? value : String(value ?? "*").split(",");
  const clean = origins.map((origin) => String(origin).trim()).filter(Boolean);
  return clean.length > 0 ? new Set(clean) : new Set(["*"]);
}

function applyCorsPolicy(res, request, allowedOrigins) {
  const requestOrigin = request.headers.origin;
  if (allowedOrigins.has("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return true;
  }
  // Non-browser clients (curl, health checks, server-side fetch) have no
  // Origin header and should remain usable even with a browser allowlist.
  if (!requestOrigin) return true;
  if (!allowedOrigins.has(requestOrigin)) return false;
  res.setHeader("Access-Control-Allow-Origin", requestOrigin);
  res.setHeader("Vary", "Origin");
  return true;
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeCollabLimits(overrides = {}) {
  return {
    maxRooms: positiveInt(overrides.maxRooms, COLLAB_DEFAULT_LIMITS.maxRooms),
    maxConnections: positiveInt(overrides.maxConnections, COLLAB_DEFAULT_LIMITS.maxConnections),
    maxConnectionsPerRoom: positiveInt(overrides.maxConnectionsPerRoom, COLLAB_DEFAULT_LIMITS.maxConnectionsPerRoom),
    maxRoomIdChars: positiveInt(overrides.maxRoomIdChars, COLLAB_DEFAULT_LIMITS.maxRoomIdChars),
    maxMessageBytes: positiveInt(overrides.maxMessageBytes, COLLAB_DEFAULT_LIMITS.maxMessageBytes),
  };
}

function rejectUpgrade(socket, statusCode, statusText, reason) {
  if (socket.destroyed) return;
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body,
  );
}

function rawDataSize(data) {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Array.isArray(data)) return data.reduce((size, chunk) => size + chunk.byteLength, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data?.byteLength ?? 0;
}

function rawDataToUint8Array(data) {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

// ── Beat Gallery store ──────────────────────────────────────────────────────

const GALLERY_MAX_ITEMS = 500;
const DEFAULT_INTAKE_FILE = join(dirname(fileURLToPath(import.meta.url)), "intake.json");
const INTAKE_MAX_ITEMS = 50;
const INTAKE_MAX_B64_CHARS = 9_000_000; // ~6.7 MB binary — decoded PCM stays well under the tab budget
const INTAKE_NAME_MAX = 120;
const INTAKE_URL_MAX = 500;
const GALLERY_MAX_CODE_CHARS = 400_000; // ~ share code of a large project
const TITLE_MAX = 64;
const AUTHOR_MAX = 32;
const TAGS_MAX = 5;
const TAG_MAX = 16;
const REPORT_REASON_MAX = 64;
const REPORTS_MAX = 2_000;
/** Sliding window: max posts per IP per minute (spam guard, not auth). */
const POST_WINDOW_MS = 60_000;
const POST_WINDOW_LIMIT = 10;
const REPORT_WINDOW_LIMIT = 5;
const DELETE_WINDOW_LIMIT = 10;
const RATE_LIMIT_MAX_KEYS = 4_096;

function cleanText(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((tag) =>
      String(tag ?? "")
        .trim()
        .toLowerCase(),
    )
    .filter((tag) => /^[a-z0-9-]{1,16}$/.test(tag))
    .slice(0, TAGS_MAX);
}

/**
 * A share code is only accepted if it actually decodes back into a project
 * JSON shape (lz-string + JSON.parse + a tracks array). Returns lightweight
 * display metadata, or null when the code is junk.
 *
 * Exported for the client/server contract test: the gallery card's
 * genre/regenerable verdicts must agree with the studio-side
 * intentSnapshotOfDoc on every provenance shape.
 */
export function decodeShareCodeMeta(code) {
  try {
    const json = decompressFromEncodedURIComponent(code);
    if (!json || json.length > 4_000_000) return null;
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.tracks)) return null;
    // Fáza B (gallery as entry point): intent-provenance metadata. Generated
    // patterns carry their normalized IntentSpec snapshot at
    // `pattern.generation.intent` (attachProvenance) — a feed card can offer
    // "Regenerate with intent" and a genre filter without decoding the
    // (potentially large) code on the client again. Top-level `pattern.intent`
    // stays readable as a legacy fallback.
    let genre = null;
    let regenerable = false;
    if (Array.isArray(parsed.patterns)) {
      for (const pattern of parsed.patterns) {
        if (!pattern || typeof pattern !== "object") continue;
        const intent = pattern.generation && pattern.generation.intent ? pattern.generation.intent : pattern.intent;
        if (!intent || typeof intent !== "object") continue;
        regenerable = true;
        if (genre === null && typeof intent.genre === "string" && /^[a-z0-9-]{1,24}$/.test(intent.genre)) {
          genre = intent.genre;
        }
      }
    }
    // Remix-DNA family link (schema v3 `lineage`): sanitized doc ids so the
    // feed can render a family tree without decoding the code again. A child
    // may be published while its parent never is — parentDocId is stored
    // as-is, never required to resolve.
    let lineage = null;
    const raw = parsed.lineage;
    if (raw && typeof raw === "object") {
      const idOk = (v) => typeof v === "string" && v.length > 0 && v.length <= 128;
      if (idOk(raw.rootId)) {
        lineage = {
          parentDocId:
            raw.parentId === null || raw.parentId === undefined ? null : idOk(raw.parentId) ? raw.parentId : null,
          rootDocId: raw.rootId,
          depth:
            typeof raw.depth === "number" && Number.isInteger(raw.depth) && raw.depth >= 0 && raw.depth <= 1000
              ? raw.depth
              : 0,
        };
      }
    }
    return {
      bpm: typeof parsed.bpm === "number" && parsed.bpm >= 20 && parsed.bpm <= 300 ? Math.round(parsed.bpm) : null,
      projectName: typeof parsed.name === "string" ? cleanText(parsed.name, 64) : "",
      genre,
      regenerable,
      docId: typeof parsed.id === "string" && parsed.id.length > 0 && parsed.id.length <= 128 ? parsed.id : null,
      lineage,
    };
  } catch {
    return null;
  }
}

/** SEND-TO-KYX intake — audio the browser extension (or any local tool)
 * pushes into the running studio. Small bounded FIFO: the studio polls,
 * imports into its user-sample bank, and removes consumed entries. */
class IntakeStore {
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {Array<Record<string, unknown>>} newest last */
    this.items = [];
    try {
      if (existsSync(filePath)) {
        const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
        if (Array.isArray(parsed?.items)) this.items = parsed.items.filter((item) => item && typeof item.id === "string");
      }
    } catch (error) {
      console.warn("[intake] could not load store, starting empty:", String(error));
    }
  }

  save() {
    try {
      writeFileSync(this.filePath, JSON.stringify({ items: this.items }, null, 2));
    } catch (error) {
      console.warn("[intake] save failed:", String(error));
    }
  }

  add(input) {
    const name = cleanText(input?.name, INTAKE_NAME_MAX);
    if (!name) return { error: "name is required" };
    const dataB64 = typeof input?.dataB64 === "string" ? input.dataB64 : "";
    if (!dataB64) return { error: "dataB64 is required" };
    if (dataB64.length > INTAKE_MAX_B64_CHARS) return { error: "audio too large" };
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(dataB64)) return { error: "dataB64 must be base64" };
    const sourceUrl = cleanText(input?.sourceUrl, INTAKE_URL_MAX) || null;
    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name,
      dataB64,
      sourceUrl,
      createdAt: new Date().toISOString(),
    };
    this.items.push(item);
    if (this.items.length > INTAKE_MAX_ITEMS) this.items.splice(0, this.items.length - INTAKE_MAX_ITEMS);
    this.save();
    return { item };
  }

  /** Feed metadata without the payload — the studio pulls bytes per id. */
  list() {
    return [...this.items].reverse().map(({ dataB64, ...meta }) => ({ ...meta, bytes: Math.floor((dataB64.length * 3) / 4) }));
  }

  get(id) {
    return this.items.find((item) => item.id === id) ?? null;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (this.items.length !== before) this.save();
    return this.items.length !== before;
  }
}

class GalleryStore {
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {Array<Record<string, unknown>>} newest last */
    this.items = [];
    /** @type {Array<Record<string, unknown>>} newest last; never returned publicly */
    this.reports = [];
    /** Debounced save handle — play counters tick often, disk writes should not. */
    this.saveTimer = null;
    try {
      if (existsSync(filePath)) {
        const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
        if (Array.isArray(parsed?.items))
          this.items = parsed.items.filter((item) => item && typeof item.code === "string");
        if (Array.isArray(parsed?.reports))
          this.reports = parsed.reports.filter((report) => report && typeof report.beatId === "string");
      }
    } catch (error) {
      console.warn("[gallery] could not load store, starting empty:", String(error));
    }
  }

  list() {
    // Newest first for the feed, annotated with remix counts (children per
    // parent) so cards can show "3 remixes" without a second request.
    const remixCounts = new Map();
    for (const item of this.items) {
      if (typeof item.parentId === "string") {
        remixCounts.set(item.parentId, (remixCounts.get(item.parentId) ?? 0) + 1);
      }
    }
    // Remix-DNA family counts (children per parent DOC id) — same trick for
    // the 🧬 badge. Old items without lineage simply count zero.
    const childrenCounts = new Map();
    for (const item of this.items) {
      if (typeof item.parentDocId === "string") {
        childrenCounts.set(item.parentDocId, (childrenCounts.get(item.parentDocId) ?? 0) + 1);
      }
    }
    return [...this.items].reverse().map((item) => ({
      ...item,
      remixCount: remixCounts.get(item.id) ?? 0,
      childrenCount: typeof item.docId === "string" ? (childrenCounts.get(item.docId) ?? 0) : 0,
    }));
  }

  find(id) {
    return this.items.find((item) => item.id === id) ?? null;
  }

  add(input) {
    const title = cleanText(input?.title, TITLE_MAX);
    if (!title) return { error: "title is required" };
    const code = typeof input?.code === "string" ? input.code : "";
    if (!code) return { error: "code (share token) is required" };
    if (code.length > GALLERY_MAX_CODE_CHARS) return { error: "code too large" };
    const meta = decodeShareCodeMeta(code);
    if (!meta) return { error: "code is not a valid share token" };
    let parentId = null;
    if (input?.parentId !== undefined && input?.parentId !== null) {
      if (typeof input.parentId !== "string" || !this.find(input.parentId)) {
        return { error: "unknown parentId" };
      }
      parentId = input.parentId;
    }
    const author = cleanText(input?.author, AUTHOR_MAX) || "anonymous";
    // AGENT-MADE provenance: only the exact value "agent" marks a beat as
    // machine-made (anything else — absent, "human", junk — is human);
    // `agent` carries the display name of the publishing agent/client.
    const origin = input?.origin === "agent" ? "agent" : "human";
    const agent = origin === "agent" ? cleanText(input?.agent, AUTHOR_MAX) || "unknown agent" : null;
    const item = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      title,
      author,
      origin,
      agent,
      tags: cleanTags(input?.tags),
      code,
      bpm: meta.bpm,
      projectName: meta.projectName,
      genre: meta.genre,
      regenerable: meta.regenerable === true,
      parentId,
      // Remix-DNA family link, extracted from the code (schema v3 lineage).
      // parentDocId is stored as-is: the parent beat may never be published.
      docId: meta.docId,
      parentDocId: meta.lineage ? meta.lineage.parentDocId : null,
      rootDocId: meta.lineage ? meta.lineage.rootDocId : null,
      depth: meta.lineage ? meta.lineage.depth : 0,
      plays: 0,
      createdAt: new Date().toISOString(),
    };
    this.items.push(item);
    if (this.items.length > GALLERY_MAX_ITEMS) this.items.splice(0, this.items.length - GALLERY_MAX_ITEMS);
    this.save();
    return { item };
  }

  /** Count one playback. Returns the new total, or null for unknown ids. */
  registerPlay(id) {
    const item = this.find(id);
    if (!item) return null;
    item.plays = (typeof item.plays === "number" ? item.plays : 0) + 1;
    this.scheduleSave();
    return item.plays;
  }

  report(id, reason) {
    if (!this.find(id)) return { error: "unknown beat" };
    const cleanReason = cleanText(reason, REPORT_REASON_MAX) || "unspecified";
    this.reports.push({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      beatId: id,
      reason: cleanReason,
      createdAt: new Date().toISOString(),
    });
    if (this.reports.length > REPORTS_MAX) this.reports.splice(0, this.reports.length - REPORTS_MAX);
    this.save();
    return { accepted: true };
  }

  remove(id) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    this.save();
    return true;
  }

  /** Play counters tick often — coalesce disk writes. */
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 3000);
  }

  save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify({ items: this.items, reports: this.reports }, null, 2));
    } catch (error) {
      console.warn("[gallery] could not save store:", String(error));
    }
  }
}

/** Naive per-IP sliding-window limiter. Returns true when the request passes. */
function makeRateLimiter(limit = POST_WINDOW_LIMIT) {
  const hits = new Map(); // ip → timestamps[]
  return function allow(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < POST_WINDOW_MS);
    if (recent.length === 0) hits.delete(ip);
    if (recent.length >= limit) {
      hits.set(ip, recent);
      return false;
    }
    // A public endpoint can receive a never-seen IP on every request. Keep
    // the limiter itself bounded instead of allowing that attacker to turn
    // the abuse guard into an unbounded memory sink.
    if (!hits.has(ip) && hits.size >= RATE_LIMIT_MAX_KEYS) {
      for (const [key, timestamps] of hits) {
        if (timestamps.every((timestamp) => now - timestamp >= POST_WINDOW_MS)) hits.delete(key);
      }
      if (hits.size >= RATE_LIMIT_MAX_KEYS) {
        const oldestKey = hits.keys().next().value;
        if (oldestKey !== undefined) hits.delete(oldestKey);
      }
    }
    recent.push(now);
    hits.set(ip, recent);
    return true;
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let oversized = false;
    const fail = (code, message) => {
      const error = new Error(message);
      error.code = code;
      reject(error);
    };
    req.on("data", (chunk) => {
      bodyBytes += Buffer.byteLength(chunk);
      if (bodyBytes > maxBytes) {
        oversized = true;
        req.resume();
        return;
      }
      if (!oversized) body += chunk;
    });
    req.on("end", () => {
      if (oversized) {
        fail("PAYLOAD_TOO_LARGE", "request body too large");
        return;
      }
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        fail("INVALID_JSON", `invalid JSON body: ${String(error)}`);
      }
    });
    req.on("error", (error) => reject(error));
  });
}

function hasAdminToken(request, expectedToken) {
  if (!expectedToken) return false;
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const actual = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ── Collab rooms (unchanged behavior) ───────────────────────────────────────

class Room {
  constructor() {
    this.ydoc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
    this.conns = new Set();

    this.ydoc.on("update", (update, origin) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder), origin);
    });

    this.awareness.on("update", ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.broadcast(encoding.toUint8Array(encoder), origin);
    });
  }

  broadcast(message, excludeConn) {
    for (const conn of this.conns) {
      if (conn !== excludeConn && conn.readyState === WS_OPEN) conn.send(message, { binary: true });
    }
  }
}

function createRoomRegistry() {
  const rooms = new Map();
  const getRoom = (roomId) => {
    let room = rooms.get(roomId);
    if (!room) {
      room = new Room();
      rooms.set(roomId, room);
    }
    return room;
  };
  return { getRoom, rooms };
}

// ── Server factory ──────────────────────────────────────────────────────────

/**
 * Build the collab + gallery HTTP server (not yet listening). Exported so the
 * test-suite can boot it on an ephemeral port; `npm run collab` starts it
 * through the main guard at the bottom of this file.
 */
export function createCollabServer({
  galleryFile = process.env.GALLERY_FILE ?? DEFAULT_GALLERY_FILE,
  intakeFile = process.env.INTAKE_FILE ?? DEFAULT_INTAKE_FILE,
  collabLimits: collabLimitOverrides = {},
  corsOrigins = process.env.CORS_ORIGIN ?? "*",
  adminToken: adminTokenOverride = process.env.GALLERY_ADMIN_TOKEN ?? "",
  enforceProductionConfig = process.env.NODE_ENV === "production",
} = {}) {
  const { getRoom, rooms } = createRoomRegistry();
  const collabLimits = normalizeCollabLimits(collabLimitOverrides);
  const allowedOrigins = normalizeCorsOrigins(corsOrigins);
  if (enforceProductionConfig && allowedOrigins.has("*")) {
    throw new Error("production collab server requires an explicit CORS_ORIGIN allowlist");
  }
  const gallery = new GalleryStore(galleryFile);
  const intake = new IntakeStore(intakeFile ?? DEFAULT_INTAKE_FILE);
  const allowPost = makeRateLimiter();
  // Play counters are much hotter than uploads — their own, looser window.
  const allowPlay = makeRateLimiter(60);
  const allowReport = makeRateLimiter(REPORT_WINDOW_LIMIT);
  const allowDelete = makeRateLimiter(DELETE_WINDOW_LIMIT);
  const adminToken = String(adminTokenOverride ?? "").trim();
  const metrics = {
    activeConnections: 0,
    rejectedUpgrades: 0,
    rejectedPayloads: 0,
  };
  let mcpRelaySocket = null;

  // KYX MCP server (docs/INTENT-MCP-EXPANSION-PLAN.md Phase D3): opt-in via
  // MCP_TOKEN env — without it /mcp and /mcp-relay 404/refuse and the
  // surface costs nothing. Tool calls relay to the connected KYX window,
  // which executes them through the deterministic command layer.
  const mcpToken = String(process.env.MCP_TOKEN ?? "").trim();
  const mcpHub = createMcpHub({
    token: mcpToken,
    sendToSession: (payload) => {
      if (mcpRelaySocket != null && mcpRelaySocket.readyState === WS_OPEN) {
        mcpRelaySocket.send(JSON.stringify(payload));
      }
    },
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/mcp" && req.method === "POST") {
      if (mcpToken.length === 0) {
        sendJson(res, 404, { error: "MCP server is disabled (set MCP_TOKEN to enable)" });
        return;
      }
      const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!isValidToken(auth, mcpToken)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 1_000_000) req.destroy();
      });
      req.on("end", () => {
        void handleMcpRequest(mcpHub, mcpToken, auth, raw).then((response) => {
          if (response != null) sendJson(res, 200, response);
          else sendJson(res, 202, {});
        });
      });
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "not found (this port speaks y-websocket + /api/gallery)" });
      return;
    }

    // CORS — development defaults to wildcard; production can set
    // CORS_ORIGIN=https://app.example.com,https://www.example.com.
    if (!applyCorsPolicy(res, req, allowedOrigins)) {
      sendJson(res, 403, { error: "origin is not allowed" });
      return;
    }
    res.setHeader("Access-Control-Allow-Methods", "DELETE,GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/gallery") {
      sendJson(res, 200, { items: gallery.list() });
      return;
    }

    // SEND-TO-KYX intake — the browser extension (or any local tool) pushes
    // audio bytes; the studio polls the list, imports per item, and
    // removes what it consumed. Bounded FIFO, same upload rate limit.
    if (req.method === "POST" && url.pathname === "/api/intake") {
      const ip = req.socket.remoteAddress ?? "unknown";
      if (!allowPost(ip)) {
        sendJson(res, 429, { error: "slow down — too many uploads" });
        return;
      }
      let body = "";
      let oversized = false;
      req.on("data", (chunk) => {
        if (body.length < INTAKE_MAX_B64_CHARS + 4_096) body += chunk;
        else oversized = true;
      });
      req.on("end", () => {
        if (oversized) {
          sendJson(res, 413, { error: "request body too large" });
          return;
        }
        try {
          const parsed = JSON.parse(body || "{}");
          const result = intake.add(parsed);
          if (result.error) {
            sendJson(res, 400, { error: result.error });
            return;
          }
          sendJson(res, 201, { item: { ...result.item, dataB64: undefined, bytes: Math.floor((result.item.dataB64.length * 3) / 4) } });
        } catch (error) {
          sendJson(res, 400, { error: `invalid JSON body: ${String(error)}` });
        }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/intake") {
      sendJson(res, 200, { items: intake.list() });
      return;
    }

    if (req.method === "GET" && /^\/api\/intake\/[\w-]+$/.test(url.pathname)) {
      const item = intake.get(url.pathname.split("/")[3]);
      if (!item) {
        sendJson(res, 404, { error: "unknown intake item" });
        return;
      }
      sendJson(res, 200, { item });
      return;
    }

    if (req.method === "DELETE" && /^\/api\/intake\/[\w-]+$/.test(url.pathname)) {
      const removed = intake.remove(url.pathname.split("/")[3]);
      if (!removed) {
        sendJson(res, 404, { error: "unknown intake item" });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/gallery") {
      const ip = req.socket.remoteAddress ?? "unknown";
      if (!allowPost(ip)) {
        sendJson(res, 429, { error: "slow down — too many uploads" });
        return;
      }
      let body = "";
      let oversized = false;
      let oversizedResponseSent = false;
      let bodyBytes = 0;
      req.on("data", (chunk) => {
        bodyBytes += Buffer.byteLength(chunk);
        if (bodyBytes > GALLERY_MAX_CODE_CHARS + 4_096) {
          oversized = true;
          if (!oversizedResponseSent) {
            oversizedResponseSent = true;
            sendJson(res, 413, { error: "request body too large" });
          }
          // Drain the request without retaining it. This lets the client
          // receive a useful 413 instead of an opaque socket reset.
          req.resume();
          return;
        }
        if (!oversized) body += chunk;
      });
      req.on("end", () => {
        if (oversized || oversizedResponseSent) return;
        try {
          const parsed = JSON.parse(body || "{}");
          const result = gallery.add(parsed);
          if (result.error) {
            sendJson(res, 400, { error: result.error });
            return;
          }
          sendJson(res, 201, { item: result.item });
        } catch (error) {
          sendJson(res, 400, { error: `invalid JSON body: ${String(error)}` });
        }
      });
      return;
    }

    if (req.method === "POST" && /^\/api\/gallery\/[\w-]+\/play$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3];
      const ip = req.socket.remoteAddress ?? "unknown";
      if (!allowPlay(ip)) {
        sendJson(res, 429, { error: "slow down — too many play pings" });
        return;
      }
      const plays = gallery.registerPlay(id);
      if (plays === null) {
        sendJson(res, 404, { error: "unknown beat" });
        return;
      }
      sendJson(res, 200, { plays });
      return;
    }

    if (req.method === "POST" && /^\/api\/gallery\/[\w-]+\/report$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3];
      const ip = req.socket.remoteAddress ?? "unknown";
      if (!allowReport(ip)) {
        sendJson(res, 429, { error: "slow down — too many reports" });
        return;
      }
      void readJsonBody(req, 4_096).then(
        (parsed) => {
          const result = gallery.report(id, parsed?.reason);
          if (result.error) {
            sendJson(res, 404, { error: result.error });
            return;
          }
          sendJson(res, 202, result);
        },
        (error) => {
          sendJson(res, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
            error: error?.message ?? "invalid report body",
          });
        },
      );
      return;
    }

    if (url.pathname === "/api/admin/reports" && req.method === "GET") {
      if (!adminToken) {
        sendJson(res, 503, { error: "gallery moderation is not configured" });
        return;
      }
      if (!hasAdminToken(req, adminToken)) {
        sendJson(res, 401, { error: "moderation authorization required" });
        return;
      }
      sendJson(res, 200, {
        reports: gallery.reports.map((report) => ({
          ...report,
          beatTitle: gallery.find(report.beatId)?.title ?? null,
        })),
      });
      return;
    }

    const deleteMatch = /^\/api\/gallery\/([\w-]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && deleteMatch) {
      const ip = req.socket.remoteAddress ?? "unknown";
      if (!allowDelete(ip)) {
        sendJson(res, 429, { error: "slow down — too many moderation deletes" });
        return;
      }
      if (!adminToken) {
        sendJson(res, 503, { error: "gallery moderation is not configured" });
        return;
      }
      if (!hasAdminToken(req, adminToken)) {
        sendJson(res, 401, { error: "moderation authorization required" });
        return;
      }
      if (!gallery.remove(deleteMatch[1])) {
        sendJson(res, 404, { error: "unknown beat" });
        return;
      }
      sendJson(res, 200, { deleted: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        galleryItems: gallery.items.length,
        galleryReports: gallery.reports.length,
        collab: {
          rooms: rooms.size,
          connections: metrics.activeConnections,
          rejectedUpgrades: metrics.rejectedUpgrades,
          rejectedPayloads: metrics.rejectedPayloads,
        },
      });
      return;
    }

    sendJson(res, 404, { error: `unknown API route: ${req.method} ${url.pathname}` });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: collabLimits.maxMessageBytes });
  let pendingConnections = 0;
  const pendingByRoom = new Map();
  const pendingRooms = new Set();

  const reserveUpgrade = (roomId, roomExists) => {
    pendingConnections += 1;
    pendingByRoom.set(roomId, (pendingByRoom.get(roomId) ?? 0) + 1);
    if (!roomExists) pendingRooms.add(roomId);
  };

  const releaseUpgrade = (roomId) => {
    pendingConnections = Math.max(0, pendingConnections - 1);
    const pending = (pendingByRoom.get(roomId) ?? 1) - 1;
    if (pending <= 0) {
      pendingByRoom.delete(roomId);
      pendingRooms.delete(roomId);
    } else {
      pendingByRoom.set(roomId, pending);
    }
  };

  server.on("upgrade", (request, socket, head) => {
    const upgradeUrl = new URL(request.url ?? "/", "http://x");
    // MCP relay: the KYX window registers as the tool executor session.
    if (upgradeUrl.pathname === "/mcp-relay") {
      const token = String(upgradeUrl.searchParams.get("token") ?? "").trim();
      if (mcpToken.length === 0 || !isValidToken(token, mcpToken)) {
        rejectUpgrade(socket, 401, "Unauthorized", "mcp token missing or wrong");
        return;
      }
      wss.handleUpgrade(request, socket, head, (conn) => {
        mcpRelaySocket = conn;
        conn.isAlive = true;
        conn.on("pong", () => {
          conn.isAlive = true;
        });
        mcpHub.connectSession(); // the window IS the tool-executor session — without this every tools/call answers -32002
        conn.on("message", (raw) => {
          try {
            mcpHub.handleSessionMessage(JSON.parse(String(raw)));
          } catch {
            /* malformed relay message — ignored */
          }
        });
        conn.on("close", () => {
          if (mcpRelaySocket === conn) {
            mcpRelaySocket = null;
            mcpHub.disconnectSession(); // reject pending calls instead of letting them hang to timeout
          }
        });
      });
      return;
    }

    const requestOrigin = request.headers.origin;
    if (!allowedOrigins.has("*") && requestOrigin && !allowedOrigins.has(requestOrigin)) {
      metrics.rejectedUpgrades += 1;
      rejectUpgrade(socket, 403, "Forbidden", "origin is not allowed");
      return;
    }

    let roomId;
    try {
      roomId = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname.replace(/^\//, "")) || "default";
    } catch {
      metrics.rejectedUpgrades += 1;
      rejectUpgrade(socket, 400, "Bad Request", "invalid room id");
      return;
    }

    if (roomId.length > collabLimits.maxRoomIdChars || /[\u0000-\u001f\u007f]/.test(roomId)) {
      metrics.rejectedUpgrades += 1;
      rejectUpgrade(socket, 414, "URI Too Long", "room id is too long or contains unsupported characters");
      return;
    }

    const room = rooms.get(roomId);
    const pendingRoomConnections = pendingByRoom.get(roomId) ?? 0;
    const roomConnectionCount = (room?.conns.size ?? 0) + pendingRoomConnections;
    if (metrics.activeConnections + pendingConnections >= collabLimits.maxConnections) {
      metrics.rejectedUpgrades += 1;
      rejectUpgrade(socket, 503, "Service Unavailable", "collaboration connection limit reached");
      return;
    }
    if (roomConnectionCount >= collabLimits.maxConnectionsPerRoom) {
      metrics.rejectedUpgrades += 1;
      rejectUpgrade(socket, 503, "Service Unavailable", "room connection limit reached");
      return;
    }
    if (!room && !pendingRooms.has(roomId) && rooms.size + pendingRooms.size >= collabLimits.maxRooms) {
      metrics.rejectedUpgrades += 1;
      rejectUpgrade(socket, 503, "Service Unavailable", "room limit reached");
      return;
    }

    reserveUpgrade(roomId, Boolean(room));
    let released = false;
    const releasePending = () => {
      if (released) return;
      released = true;
      releaseUpgrade(roomId);
    };
    socket.once("close", releasePending);

    try {
      wss.handleUpgrade(request, socket, head, (conn) => {
        socket.off("close", releasePending);
        releasePending();
        wss.emit("connection", conn, request, roomId);
      });
    } catch (error) {
      socket.off("close", releasePending);
      releasePending();
      metrics.rejectedUpgrades += 1;
      console.warn("[collab] upgrade rejected:", String(error));
      rejectUpgrade(socket, 400, "Bad Request", "invalid collaboration upgrade");
    }
  });

  wss.on("connection", (conn, request, roomIdArg) => {
    // MCP relay sockets join NO room — they are the tool-executor channel.
    // Without this guard the yjs sync frames get broadcast at them.
    if ((request.url ?? "").startsWith("/mcp-relay")) {
      conn.isAlive = true;
      conn.on("pong", () => {
        conn.isAlive = true;
      });
      return;
    }
    const roomId = roomIdArg ?? "default";
    const room = getRoom(roomId);
    metrics.activeConnections += 1;
    conn.binaryType = "arraybuffer";
    room.conns.add(conn);
    // Awareness client IDs this connection owns (for cleanup on disconnect).
    const controlledIds = new Set();
    const awarenessCleanup = ({ added, removed }, origin) => {
      if (origin !== conn) return;
      for (const id of added) controlledIds.add(id);
      for (const id of removed) controlledIds.delete(id);
    };
    room.awareness.on("update", awarenessCleanup);

    // Init: sync step 1 + current awareness states.
    const syncEncoder = encoding.createEncoder();
    encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(syncEncoder, room.ydoc);
    const sendBinary = (message) => {
      if (conn.readyState === WS_OPEN) conn.send(message, { binary: true });
    };
    sendBinary(encoding.toUint8Array(syncEncoder));
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]),
    );
    sendBinary(encoding.toUint8Array(awarenessEncoder));

    conn.on("message", (data, isBinary) => {
      const size = rawDataSize(data);
      if (!isBinary || typeof data === "string") {
        metrics.rejectedPayloads += 1;
        if (conn.readyState === WS_OPEN) conn.close(1003, "binary collaboration messages required");
        return;
      }
      if (size > collabLimits.maxMessageBytes) {
        metrics.rejectedPayloads += 1;
        if (conn.readyState === WS_OPEN) conn.close(1009, "collaboration message is too large");
        return;
      }
      try {
        const decoder = decoding.createDecoder(rawDataToUint8Array(data));
        const encoder = encoding.createEncoder();
        const messageType = decoding.readVarUint(decoder);
        switch (messageType) {
          case MESSAGE_SYNC: {
            encoding.writeVarUint(encoder, MESSAGE_SYNC);
            syncProtocol.readSyncMessage(decoder, encoder, room.ydoc, conn);
            if (encoding.length(encoder) > 1) sendBinary(encoding.toUint8Array(encoder));
            break;
          }
          case MESSAGE_AWARENESS: {
            awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn);
            break;
          }
          default:
            throw new Error(`unsupported message type ${messageType}`);
        }
      } catch (error) {
        metrics.rejectedPayloads += 1;
        console.warn(JSON.stringify({ event: "collab_message_rejected", room: roomId, reason: String(error) }));
        if (conn.readyState === WS_OPEN) conn.close(1003, "malformed collaboration message");
      }
    });

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      metrics.activeConnections = Math.max(0, metrics.activeConnections - 1);
      room.conns.delete(conn);
      room.awareness.off("update", awarenessCleanup);
      if (room.conns.size === 0) {
        rooms.delete(roomId);
      } else if (controlledIds.size > 0) {
        awarenessProtocol.removeAwarenessStates(room.awareness, [...controlledIds], null);
      }
    };
    conn.on("close", close);
    conn.on("error", (error) => {
      if (String(error).toLowerCase().includes("max payload")) metrics.rejectedPayloads += 1;
      close();
    });

    conn.isAlive = true;
    conn.on("pong", () => {
      conn.isAlive = true;
    });
  });

  const PING_INTERVAL = 30_000;
  const pingTimer = setInterval(() => {
    for (const conn of wss.clients) {
      if (conn.isAlive === false) {
        conn.terminate();
        continue;
      }
      conn.isAlive = false;
      conn.ping();
    }
  }, PING_INTERVAL);
  wss.on("close", () => clearInterval(pingTimer));
  server.on("close", () => clearInterval(pingTimer));

  return { server, wss, gallery, intake, metrics };
}

// ── Main entry ──────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { server } = createCollabServer();
  server.listen(PORT, HOST, () => {
    console.log(`[collab] listening on ws://${HOST}:${PORT}/<roomId> + gallery at http://${HOST}:${PORT}/api/gallery`);
  });
}
