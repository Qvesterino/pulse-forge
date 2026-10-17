/**
 * Windows Core Audio endpoint discovery (ADR 0050). This is metadata-only:
 * it does not open streams or choose a fallback device. Native streaming is
 * a later, separate implementation gate.
 */
const { spawn: spawnProcess } = require("node:child_process");
const path = require("node:path");

const MAX_ENDPOINTS = 256;
const MAX_STDOUT_BYTES = 1 << 20;
const DEFAULT_TIMEOUT_MS = 5000;
const FLOWS = new Set(["capture", "render"]);
const STATES = new Set(["active", "disabled", "not-present", "unplugged", "unknown"]);

function defaultEndpointProbePath(resourcesPath) {
  if (resourcesPath) return path.join(resourcesPath, "windows-audio-probe", "kyx-windows-audio-probe.exe");
  return path.join(__dirname, "..", "build", "windows-audio-probe", "Release", "kyx-windows-audio-probe.exe");
}

function validateEndpointPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) return null;
  if (!Array.isArray(value.endpoints) || value.endpoints.length > MAX_ENDPOINTS) return null;
  const seen = new Set();
  const endpoints = [];
  for (const item of value.endpoints) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { id, name, flow, state, isDefaultConsole } = item;
    if (
      typeof id !== "string" ||
      id.trim().length === 0 ||
      id.length > 2048 ||
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 512 ||
      !FLOWS.has(flow) ||
      !STATES.has(state) ||
      typeof isDefaultConsole !== "boolean"
    ) {
      return null;
    }
    const key = `${flow}\0${id}`;
    if (seen.has(key)) return null;
    seen.add(key);
    endpoints.push({ id, name, flow, state, isDefaultConsole });
  }
  return { schemaVersion: 1, endpoints };
}

class WindowsAudioEndpointManager {
  constructor(options = {}) {
    this.probePath = options.probePath ?? defaultEndpointProbePath(options.resourcesPath);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.platform = options.platform ?? process.platform;
    this.spawn = options.spawn ?? spawnProcess;
  }

  list() {
    if (this.platform !== "win32") {
      return Promise.resolve({
        status: "unsupported",
        endpoints: [],
        message: "Windows endpoint discovery is only available in KYX Studio for Windows.",
      });
    }
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let termination = null;
      let byteCount = 0;
      const chunks = [];
      let timer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const stopChild = () => {
        if (!child || child.exitCode !== null || child.killed) return;
        try {
          child.kill();
        } catch {
          /* The process may already have exited. */
        }
      };

      try {
        child = this.spawn(this.probePath, ["--list-json"], {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const code = error?.code;
        finish({
          status: code === "ENOENT" ? "no-probe" : "error",
          endpoints: [],
          message:
            code === "ENOENT"
              ? "Windows endpoint probe is not built."
              : `Probe launch failed: ${error?.message ?? error}`,
        });
        return;
      }

      if (!child || typeof child.on !== "function" || !child.stdout || !child.stderr) {
        finish({ status: "error", endpoints: [], message: "Probe did not return a usable child process." });
        stopChild();
        return;
      }

      timer = setTimeout(() => {
        if (settled || termination) return;
        termination = { status: "timeout", message: "Windows endpoint discovery timed out." };
        stopChild();
      }, this.timeoutMs);
      // A successful discovery does not need stderr. Drain it to avoid a pipe
      // filling and blocking the child if Windows emits a COM diagnostic.
      child.stderr.on("data", () => {});
      child.stdout.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteCount += buffer.length;
        if (byteCount > MAX_STDOUT_BYTES) {
          termination = {
            status: "invalid-output",
            message: "Endpoint list exceeded the discovery size limit.",
          };
          stopChild();
          return;
        }
        chunks.push(buffer);
      });
      child.on("error", (error) => {
        if (termination) return;
        const code = error?.code;
        finish({
          status: code === "ENOENT" ? "no-probe" : "error",
          endpoints: [],
          message:
            code === "ENOENT"
              ? "Windows endpoint probe is not built."
              : `Probe launch failed: ${error?.message ?? error}`,
        });
      });
      child.on("close", (code, signal) => {
        if (termination) {
          finish({ ...termination, endpoints: [] });
          return;
        }
        if (signal) {
          finish({
            status: "error",
            endpoints: [],
            message: "Windows endpoint probe exited after an unexpected signal.",
          });
          return;
        }
        if (code !== 0) {
          finish({
            status: "error",
            endpoints: [],
            message: `Windows endpoint probe exited with code ${code ?? "unknown"}.`,
          });
          return;
        }
        let decoded;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        } catch {
          finish({ status: "invalid-output", endpoints: [], message: "Endpoint list was not valid UTF-8." });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(decoded);
        } catch {
          finish({ status: "invalid-output", endpoints: [], message: "Endpoint probe returned invalid JSON." });
          return;
        }
        const payload = validateEndpointPayload(parsed);
        if (!payload) {
          finish({
            status: "invalid-output",
            endpoints: [],
            message: "Endpoint probe returned an invalid endpoint record.",
          });
          return;
        }
        finish({ status: "ok", ...payload });
      });
    });
  }
}

function registerWindowsAudioEndpointHandlers(ipcMain, options = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("Electron ipcMain is required");
  const manager = options.manager ?? new WindowsAudioEndpointManager(options);
  ipcMain.handle("kyx:audio:windows-endpoints", () => manager.list());
  return manager;
}

module.exports = {
  WindowsAudioEndpointManager,
  registerWindowsAudioEndpointHandlers,
  defaultEndpointProbePath,
  validateEndpointPayload,
  MAX_ENDPOINTS,
  MAX_STDOUT_BYTES,
  DEFAULT_TIMEOUT_MS,
};
