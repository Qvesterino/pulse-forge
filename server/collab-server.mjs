/**
 * Pulse Forge collab server — a minimal y-websocket protocol relay.
 *
 * Rooms are created on demand: the URL path "/<roomId>" maps to an
 * in-memory Y.Doc. Speaks the standard yjs sync + awareness wire protocol,
 * so the y-websocket client provider works unmodified.
 *
 * Run: npm run collab   (ws://127.0.0.1:1234 by default, PORT/HOST to change)
 *
 * Deliberately simple: no persistence, no auth — a self-hosted relay for
 * small jam sessions. CRDT state lives in the clients; a restarting server
 * re-syncs from whichever client connects next.
 */
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const PORT = Number(process.env.PORT ?? 1234);
const HOST = process.env.HOST ?? "127.0.0.1";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

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

const rooms = new Map();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Room();
    rooms.set(roomId, room);
  }
  return room;
}

const wss = new WebSocketServer({ host: HOST, port: PORT });
console.log(`[collab] listening on ws://${HOST}:${PORT}/<roomId>`);

wss.on("connection", (conn, request) => {
  const roomId =
    decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname.replace(/^\//, "")) || "default";
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
