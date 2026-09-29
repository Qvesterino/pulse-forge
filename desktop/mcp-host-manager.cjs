/**
 * KYX MCP HOST MANAGER — the desktop half of the MCP integration
 * (docs/INTENT-MCP-EXPANSION-PLAN.md Phase D2).
 *
 * Spawns desktop/mcp-server.cjs as a STANDALONE stdio process for external
 * MCP clients (Claude Desktop & co. point their config at it), and runs a
 * LOOPBACK HTTP bridge (127.0.0.1 only) that the stdio process talks to.
 * Tool calls execute in the RENDERER through the deterministic command
 * layer: main relays every call to the KYX window and the window answers.
 *
 * Security model (§D4):
 *  - OFF by default; enabled only by explicit renderer action
 *  - the bridge binds 127.0.0.1 and requires a constant-time token check
 *  - the token is generated locally and shown ONLY in the KYX window
 *  - nothing executes outside the command layer — MCP is a transport
 */
const { spawn: spawnProcess } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const http = require("node:http");
const { createMcpBridgeServer } = require("./mcp-bridge-server.cjs");

const CALL_TIMEOUT_MS = 10_000;
const DEFAULT_BRIDGE_PORT = 8787;

function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

/** Constant-time compare (length + xor-fold). */
function tokenMatches(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

class McpHostManager {
  constructor(options = {}) {
    this.serverScriptPath = options.serverScriptPath ?? path.join(__dirname, "mcp-server.cjs");
    this.forwardCall = options.forwardCall ?? ((_call) => {}); // main → renderer
    this.bridgeServer = null;
    this.bridgePort = 0;
    this.token = "";
    this.stdioProcess = null;
    this.enabled = false;
    this.lineBuffer = "";
    /** callId -> { resolve, reject, timer } for calls awaiting the renderer */
    this.pendingCalls = new Map();
  }

  get status() {
    return {
      enabled: this.enabled,
      running: this.bridgeServer != null,
      bridgeUrl: this.enabled ? `http://127.0.0.1:${this.bridgePort}/rpc` : null,
      token: this.enabled ? this.token : null,
      clientConfig: this.enabled
        ? {
            command: process.execPath,
            args: [this.serverScriptPath],
            env: { KYX_MCP_BRIDGE_URL: `http://127.0.0.1:${this.bridgePort}/rpc`, KYX_MCP_TOKEN: this.token },
          }
        : null,
    };
  }

  /** Generate a fresh token, start the loopback bridge. Returns the status. */
  async enable(preferredPort) {
    this.token = generateToken();
    const port = Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : DEFAULT_BRIDGE_PORT;
    const { server } = createMcpBridgeServer({
      token: this.token,
      port,
      executeTool: async (name, args) => this.forwardCall({ name, args: args ?? {} }),
    });
    this.bridgeServer = server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    this.bridgePort = server.address().port;
    this.enabled = true;
    return this.status;
  }

  async disable() {
    this.enabled = false;
    this.stopStdio();
    if (this.bridgeServer != null) {
      await new Promise((resolve) => this.bridgeServer.close(() => resolve()));
      this.bridgeServer = null;
      this.bridgePort = 0;
    }
    this.token = "";
  }

  /**
   * Spawn the standalone stdio server for an EXTERNAL MCP client. The
   * caller passes its own token (must equal the bridge's token).
   */
  spawnStdioForExternalClient(envOverrides = {}) {
    if (!this.enabled) throw new Error("MCP is not enabled");
    this.stopStdio();
    const child = spawnProcess(process.execPath, [this.serverScriptPath], {
      env: {
        ...process.env,
        KYX_MCP_BRIDGE_URL: `http://127.0.0.1:${this.bridgePort}/rpc`,
        KYX_MCP_TOKEN: this.token,
        ...envOverrides,
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    this.stdioProcess = child;
    let lineBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      lineBuffer += chunk;
      let newlineIndex;
      while ((newlineIndex = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, newlineIndex).trim();
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (line === "") continue;
        this.handleStdioLine(line);
      }
    });
    child.on("exit", () => {
      this.stdioProcess = null;
    });
    return child;
  }

  handleStdioLine(line) {
    let rpc;
    try {
      rpc = JSON.parse(line);
    } catch {
      return; // malformed line from our own child — ignored
    }
    if (rpc == null || typeof rpc !== "object" || rpc.method !== "tools/call") return;
    const callId = `stdio-${rpc.id ?? Math.random().toString(36).slice(2)}`;
    const name = typeof rpc.params?.name === "string" ? rpc.params.name : "";
    const args = rpc.params?.arguments ?? {};
    this.forwardCall({ id: callId, name, args })
      .then((result) => {
        if (this.stdioProcess != null) {
          this.stdioProcess.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) + "\n");
        }
      })
      .catch((error) => {
        if (this.stdioProcess != null) {
          this.stdioProcess.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id ?? null,
              error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
            }) + "\n",
          );
        }
      });
  }

  stopStdio() {
    if (this.stdioProcess != null) {
      this.stdioProcess.kill();
      this.stdioProcess = null;
    }
  }

  /** Renderer answered a forwarded tool call. */
  resolveCall(payload) {
    const callId = String(payload?.id ?? "");
    const entry = this.pendingCalls.get(callId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pendingCalls.delete(callId);
    entry.resolve(payload.result ?? { text: String(payload.result ?? "") });
    return true;
  }
}

/**
 * IPC surface for the renderer. `options.rendererExecute` is ASYNC and
 * receives { name, args } — main forwards the call to the KYX window
 * (webContents.send "kyx:mcp:call") and the window answers via
 * kyx:mcp:answer. 10 s timeout per call.
 */
function registerMcpIpcHandlers(ipcMain, options = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("Electron ipcMain is required");
  const getWebContents = options.getWebContents;
  const manager = new McpHostManager(options);
  const pendingCalls = manager.pendingCalls;

  manager.forwardCall = (call) => {
    const callId = `call-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCalls.delete(callId);
        reject(new Error("KYX window timed out"));
      }, CALL_TIMEOUT_MS);
      pendingCalls.set(callId, { resolve, reject, timer });
    });
    const webContents = getWebContents?.();
    if (webContents == null || webContents.isDestroyed()) {
      return Promise.reject(new Error("KYX window not available"));
    }
    webContents.send("kyx:mcp:call", { id: callId, name: call.name, args: call.args });
    return promise;
  };

  ipcMain.handle("kyx:mcp:status", () => manager.status);

  ipcMain.handle("kyx:mcp:enable", async () => manager.enable(options.preferredPort));

  ipcMain.handle("kyx:mcp:disable", async () => {
    await manager.disable();
    return { enabled: false };
  });

  ipcMain.handle("kyx:mcp:answer", (_event, payload) => {
    manager.resolveCall(payload);
  });

  return { manager };
}

module.exports = {
  McpHostManager,
  registerMcpIpcHandlers,
  generateToken,
  tokenMatches,
  CALL_TIMEOUT_MS,
};
