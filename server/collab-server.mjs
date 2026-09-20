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
 */
function decodeShareCodeMeta(code) {
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
    return {
      bpm: typeof parsed.bpm === "number" && parsed.bpm >= 20 && parsed.bpm <= 300 ? Math.round(parsed.bpm) : null,
      projectName: typeof parsed.name === "string" ? cleanText(parsed.name, 64) : "",
      genre,
      regenerable,
    };
  } catch {
    return null;
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
    return [...this.items].reverse().map((item) => ({ ...item, remixCount: remixCounts.get(item.id) ?? 0 }));
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
    const item = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      title,
      author,
      tags: cleanTags(input?.tags),
      code,
      bpm: meta.bpm,
      projectName: meta.projectName,
      genre: meta.genre,
      regenerable: meta.regenerable === true,
      parentId,
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

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
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

  return { server, wss, gallery, metrics };
}

// ── Main entry ──────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { server } = createCollabServer();
  server.listen(PORT, HOST, () => {
    console.log(`[collab] listening on ws://${HOST}:${PORT}/<roomId> + gallery at http://${HOST}:${PORT}/api/gallery`);
  });
}
