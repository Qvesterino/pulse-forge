/**
 * PCM playback IPC surface (ADR 0018 wave 3 — the "hear it" wiring).
 *
 * The renderer builds the ring (createPcmRingBuffer + init), sends the SAB
 * over `kyx:pcm:start` and this module spawns the native source in the MAIN
 * process, bridging pipe frames straight into that ring. The audio graph
 * never touches the pipe and the pipe never touches the graph — they meet
 * only in the shared ring.
 *
 * Boundary discipline (mirrors the CLAP/MRT2 surfaces): the renderer names
 * a SOURCE KIND from an allowlist, never an executable path. Numeric args
 * are validated; `--dll` (ASIO fixture) is a user-picked file passed as a
 * single shell:false argv entry.
 */
const path = require("node:path");
const { PcmPipeSource } = require("./pcm-pipe.cjs");
const { PcmPipeToSabBridge } = require("./pcm-ring-layout.cjs");

const SOURCE_KINDS = {
  "pcm-gen": { relative: path.join("native", "pcm-host", "build", "Release", "pcm-gen.exe"), resource: "pcm" },
  "asio-host": { relative: path.join("native", "asio-host", "build", "Release", "asio-host.exe"), resource: "asio" },
  "clap-player": {
    relative: path.join("native", "clap-host", "build", "Release", "clap-player.exe"),
    resource: "clap-host",
    /** Auto-injected fixture: the tone plugin ships with the dev tree. */
    fixture: path.join("native", "clap-host", "build", "Release", "clap-tone.clap"),
  },
};

const ALLOWED_ARG_FLAGS = new Set(["--rate", "--seconds", "--freq", "--block", "--dll"]);
/** Valueless switches (allowed anywhere in the argv, including last). */
const BOOLEAN_ARG_FLAGS = new Set(["--realtime"]);

function defaultResourcePath() {
  // Dev-tree default; packaged builds pass process.resourcesPath.
  return path.join(__dirname, "..");
}

function resolveSourcePath(kind, resourcesPath) {
  const spec = SOURCE_KINDS[kind];
  if (!spec) return null;
  if (resourcesPath) return path.join(resourcesPath, spec.resource, path.basename(spec.relative));
  return path.join(defaultResourcePath(), spec.relative);
}

/** The tone fixture .clap shipped with the build (clap-player's --dll). */
function resolveFixturePath(resourcesPath) {
  const spec = SOURCE_KINDS["clap-player"];
  if (resourcesPath) return path.join(resourcesPath, spec.resource, path.basename(spec.fixture));
  return path.join(defaultResourcePath(), spec.fixture);
}

/** Numeric-or-file argv validation: flags from the allowlist, bounded values. */
function sanitizeArgs(args) {
  if (!Array.isArray(args) || args.length > 32) return null;
  const clean = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (typeof flag !== "string") return null;
    if (BOOLEAN_ARG_FLAGS.has(flag)) {
      clean.push(flag);
      continue;
    }
    if (!ALLOWED_ARG_FLAGS.has(flag)) return null;
    const value = args[i + 1];
    if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
    clean.push(flag, value);
    i++;
  }
  return clean;
}

/**
 * Register `kyx:pcm:start` / `kyx:pcm:stop`. One live session at a time —
 * starting a new source stops the previous one (the ring is per-session).
 * Returns the manager for tests/shutdown.
 */
function registerPcmIpcHandlers(ipcMain, options = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("Electron ipcMain is required");
  const resourcesPath = options.resourcesPath;
  const spawn = options.spawn;
  const sessions = new Map();
  let nextId = 1;

  ipcMain.handle("kyx:pcm:start", (_event, request) => {
    const kind = request?.host;
    const sab = request?.sab;
    if (!SOURCE_KINDS[kind]) return { ok: false, error: `unknown source kind: ${String(kind)}` };
    if (!(sab instanceof SharedArrayBuffer)) return { ok: false, error: "sab must be a SharedArrayBuffer" };
    const args = sanitizeArgs(request?.args);
    if (args === null) return { ok: false, error: "args contain a flag outside the allowlist" };

    // One source at a time: a new start stops the previous session.
    for (const [, session] of sessions) session.stop();

    const hostPath = resolveSourcePath(kind, resourcesPath);
    if (!hostPath) return { ok: false, error: `source binary missing for ${kind}` };
    // The CLAP player needs its plugin: auto-inject the tone fixture from
    // the same build tree (renderer never names plugin paths in v1).
    const finalArgs = kind === "clap-player" ? ["--dll", resolveSourcePath("clap-tone"), ...args] : args;

    const id = `pcm-${nextId++}`;
    const source = new PcmPipeSource({
      hostPath,
      args: finalArgs,
      ...(spawn ? { spawn } : {}),
    });
    const bridge = new PcmPipeToSabBridge({ source, sab });
    const errors = [];
    const unsubscribe = source.on("protocol-error", (message) => errors.push(String(message)));
    source.start();
    sessions.set(id, {
      stop() {
        unsubscribe();
        bridge.stop();
        source.stop();
      },
    });
    source.on("close", () => sessions.delete(id));
    return { ok: true, id };
  });

  ipcMain.handle("kyx:pcm:stop", (_event, request) => {
    const session = sessions.get(request?.id);
    if (!session) return { ok: false, error: "unknown session" };
    session.stop();
    sessions.delete(request.id);
    return { ok: true };
  });

  return {
    stopAll() {
      for (const [, session] of sessions) session.stop();
      sessions.clear();
    },
  };
}

module.exports = { registerPcmIpcHandlers, resolveSourcePath, resolveFixturePath, sanitizeArgs, SOURCE_KINDS };
