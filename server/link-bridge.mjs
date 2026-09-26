#!/usr/bin/env node
/**
 * Ableton Link WebSocket bridge — `npm run link`.
 *
 * Browsers can't speak Link's native UDP protocol, so this loopback bridge
 * owns the session clock (server/link-core.mjs) and relays tempo/beat/playing
 * state to KYX clients over WebSocket at 10 Hz. Out of the box it syncs every
 * connected client with each other (KYX ↔ KYX ↔ desktop shell ↔ any WS
 * peer) using the same phase math as Link. When the OPTIONAL native package
 * is installed (`npm i abletonlink`), the bridge additionally attaches to the
 * real Link LAN session — Live, Traktor and friends set the tempo, KYX
 * follows. The native attach is best-effort and experimental: every call into
 * the module is capability-guarded and any failure falls back to loopback
 * sync with a logged reason.
 *
 * Bind is loopback by default; `--host 0.0.0.0` exposes the socket
 * deliberately. `GET /api/health` answers { ok: true, ... } for smoke tests.
 *
 * Message protocol (JSON, one object per frame):
 *   client → bridge: { type: "hello", name }
 *                    { type: "state", tempo, playing }
 *   bridge → client: { type: "welcome", quantum, native }
 *                    { type: "link", tempo, beat, playing, quantum, peers, at }
 */
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  createLinkCore,
  LINK_DEFAULT_HOST,
  LINK_DEFAULT_PORT,
  DEFAULT_QUANTUM,
  MAX_TEMPO,
  MIN_TEMPO,
} from "./link-core.mjs";

function parseArgs(argv) {
  const args = { host: LINK_DEFAULT_HOST, port: LINK_DEFAULT_PORT, quantum: DEFAULT_QUANTUM, bpm: 120 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--host") args.host = String(value);
    else if (flag === "--port") args.port = Number(value);
    else if (flag === "--quantum") args.quantum = Number(value);
    else if (flag === "--bpm") args.bpm = Number(value);
    else if (flag === "--help" || flag === "-h") args.help = true;
    if (value !== undefined) i++;
  }
  if (!Number.isFinite(args.port) || args.port < 1 || args.port > 65535) args.port = LINK_DEFAULT_PORT;
  if (!Number.isFinite(args.quantum) || args.quantum < 1 || args.quantum > 16) args.quantum = DEFAULT_QUANTUM;
  return args;
}

const BROADCAST_HZ = 10;
const BROADCAST_MS = 1000 / BROADCAST_HZ;

/**
 * Optional native Link attach. Everything is defensive: the package may be
 * absent, its API shape may differ, and individual calls may throw — any of
 * that degrades to loopback-only sync, never to a crash.
 */
async function tryAttachNativeLink(core, log) {
  let mod;
  try {
    mod = await import("abletonlink");
  } catch (err) {
    log(`native Link unavailable (${err?.code ?? err?.message ?? "import failed"}) — loopback sync only`);
    return null;
  }
  try {
    const LinkCtor = mod?.default ?? mod?.Link;
    if (typeof LinkCtor !== "function") throw new Error("unexpected module shape");
    const link = new LinkCtor(core.tempo, core.quantum);
    link.enable?.(true);
    // Adopt the LAN session if it is already running at a different tempo.
    const nativeTempo = typeof link.tempo === "function" ? link.tempo() : undefined;
    if (Number.isFinite(nativeTempo) && nativeTempo >= MIN_TEMPO && nativeTempo <= MAX_TEMPO) {
      core.applyNativeState({ tempo: nativeTempo });
    }
    log(`native Link session attached (LAN peers: ${typeof link.numPeers === "function" ? link.numPeers() : "?"})`);
    return link;
  } catch (err) {
    log(`native Link attach failed (${err?.message ?? err}) — loopback sync only`);
    return null;
  }
}

/** Read the native session into the core — best-effort, called per broadcast. */
function pollNativeLink(link, core) {
  if (!link) return;
  try {
    const tempo = typeof link.tempo === "function" ? link.tempo() : undefined;
    const playing = typeof link.isPlaying === "function" ? link.isPlaying() : undefined;
    core.applyNativeState({
      ...(Number.isFinite(tempo) ? { tempo } : {}),
      ...(playing !== undefined ? { playing } : {}),
    });
  } catch {
    /* native hiccups must never break the WS broadcast loop */
  }
}

export function startLinkBridge({ host, port, quantum, bpm }, log = console.log) {
  const core = createLinkCore({ quantum, tempo: bpm });
  let nativeLink = null;
  const http = createServer((req, res) => {
    if (req.url === "/api/health") {
      const body = JSON.stringify({ ok: true, tempo: core.tempo, playing: core.playing, peers: core.peerCount });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server: http });

  wss.on("connection", (ws) => {
    let name = "peer";
    core.touchPeer(ws);
    ws.on("message", (data) => {
      // Network boundary: validate before anything reaches the session core.
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "hello") {
        if (typeof msg.name === "string" && msg.name.length > 0) name = msg.name.slice(0, 40);
        core.touchPeer(ws, name);
        // A connecting client publishes its transport so the session adopts it.
        core.applyClientState({ tempo: Number(msg.tempo), playing: msg.playing === true });
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "welcome", quantum: core.quantum, native: !!nativeLink }));
        return;
      }
      if (msg.type === "state") {
        core.applyClientState({ tempo: Number(msg.tempo), playing: msg.playing === true });
        return;
      }
    });
    ws.on("close", () => core.dropPeer(ws));
    ws.on("error", () => core.dropPeer(ws));
    // Immediate frame so the client can phase-lock before the next tick.
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(core.frame()));
  });

  const broadcast = setInterval(() => {
    pollNativeLink(nativeLink, core);
    if (core.peerCount === 0) return;
    const frame = JSON.stringify(core.frame());
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(frame);
    }
  }, BROADCAST_MS);

  const server = http.listen(port, host, () => {
    log(`[link-bridge] ws://${host}:${port} (quantum ${core.quantum})`);
    log("[link-bridge] connect from KYX via the LINK chip in the status bar");
    void tryAttachNativeLink(core, log).then((link) => {
      nativeLink = link;
    });
  });

  return {
    core,
    close() {
      clearInterval(broadcast);
      for (const client of wss.clients) client.close();
      wss.close();
      server.close();
    },
  };
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node server/link-bridge.mjs [--host 127.0.0.1] [--port 20909] [--quantum 4] [--bpm 120]");
  } else {
    startLinkBridge(args);
  }
}
