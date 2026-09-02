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

// ── Beat Gallery store ──────────────────────────────────────────────────────

const GALLERY_MAX_ITEMS = 500;
const GALLERY_MAX_CODE_CHARS = 400_000; // ~ share code of a large project
const TITLE_MAX = 64;
const AUTHOR_MAX = 32;
const TAGS_MAX = 5;
const TAG_MAX = 16;
/** Sliding window: max posts per IP per minute (spam guard, not auth). */
const POST_WINDOW_MS = 60_000;
const POST_WINDOW_LIMIT = 10;

function cleanText(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((tag) => String(tag ?? "").trim().toLowerCase())
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
    return {
      bpm: typeof parsed.bpm === "number" && parsed.bpm >= 20 && parsed.bpm <= 300 ? Math.round(parsed.bpm) : null,
      projectName: typeof parsed.name === "string" ? cleanText(parsed.name, 64) : "",
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
    /** Debounced save handle — play counters tick often, disk writes should not. */
    this.saveTimer = null;
    try {
      if (existsSync(filePath)) {
        const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
        if (Array.isArray(parsed?.items)) this.items = parsed.items.filter((item) => item && typeof item.code === "string");
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
    return [...this.items]
      .reverse()
      .map((item) => ({ ...item, remixCount: remixCounts.get(item.id) ?? 0 }));
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
      writeFileSync(this.filePath, JSON.stringify({ items: this.items }, null, 2));
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
    if (recent.length >= limit) {
      hits.set(ip, recent);
      return false;
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
      if (conn !== excludeConn) conn.send(message, { binary: true });
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
export function createCollabServer({ galleryFile = process.env.GALLERY_FILE ?? DEFAULT_GALLERY_FILE } = {}) {
  const { getRoom, rooms } = createRoomRegistry();
  const gallery = new GalleryStore(galleryFile);
  const allowPost = makeRateLimiter();
  // Play counters are much hotter than uploads — their own, looser window.
  const allowPlay = makeRateLimiter(60);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "not found (this port speaks y-websocket + /api/gallery)" });
      return;
    }

    // CORS — the gallery page may live on another origin in dev/prod.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > GALLERY_MAX_CODE_CHARS + 4_096) {
          oversized = true;
          req.destroy();
        }
      });
      req.on("end", () => {
        if (oversized) return;
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

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, galleryItems: gallery.items.length });
      return;
    }

    sendJson(res, 404, { error: `unknown API route: ${req.method} ${url.pathname}` });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const roomId =
      decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname.replace(/^\//, "")) || "default";
    wss.handleUpgrade(request, socket, head, (conn) => {
      wss.emit("connection", conn, request, roomId);
    });
  });

  wss.on("connection", (conn, request, roomIdArg) => {
    const roomId = roomIdArg ?? "default";
    const room = getRoom(roomId);
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
    conn.send(encoding.toUint8Array(syncEncoder), { binary: true });
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]),
    );
    conn.send(encoding.toUint8Array(awarenessEncoder), { binary: true });

    conn.on("message", (data) => {
      try {
        const decoder = decoding.createDecoder(new Uint8Array(data));
        const encoder = encoding.createEncoder();
        const messageType = decoding.readVarUint(decoder);
        switch (messageType) {
          case MESSAGE_SYNC: {
            encoding.writeVarUint(encoder, MESSAGE_SYNC);
            syncProtocol.readSyncMessage(decoder, encoder, room.ydoc, conn);
            if (encoding.length(encoder) > 1) conn.send(encoding.toUint8Array(encoder), { binary: true });
            break;
          }
          case MESSAGE_AWARENESS: {
            awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn);
            break;
          }
        }
      } catch (error) {
        console.warn(`[collab] malformed message in room ${roomId}:`, String(error));
      }
    });

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      room.conns.delete(conn);
      room.awareness.off("update", awarenessCleanup);
      if (room.conns.size === 0) {
        rooms.delete(roomId);
      } else if (controlledIds.size > 0) {
        awarenessProtocol.removeAwarenessStates(room.awareness, [...controlledIds], null);
      }
    };
    conn.on("close", close);
    conn.on("error", close);

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

  return { server, wss, gallery };
}

// ── Main entry ──────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { server } = createCollabServer();
  server.listen(PORT, HOST, () => {
    console.log(`[collab] listening on ws://${HOST}:${PORT}/<roomId> + gallery at http://${HOST}:${PORT}/api/gallery`);
  });
}
