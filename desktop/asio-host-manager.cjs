/**
 * ASIO discovery manager (ADR 0017) — the Node half of out-of-process driver
 * discovery. Two tiers:
 *
 *  1. `enumerateRegistry()` — pure Node (reg.exe): lists registered ASIO
 *     driver names from HKLM\SOFTWARE\ASIO in both registry views. Works
 *     everywhere, no SDK or native build needed.
 *  2. `ClapProbeManager`-style spawn of native/asio-host/asio-probe.exe —
 *     per-driver JSON details (channels, buffers, sample rate). A driver
 *     that hangs its COM init gets the process killed on timeout; drivers
 *     reported BEFORE the blocker still parse (the probe flushes per line).
 *
 * Boundary discipline mirrors the other host managers: the renderer never
 * names an executable; probe stdout is validated and bounded before use.
 */
const { spawn: spawnProcess } = require("node:child_process");
const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const MAX_DRIVERS = 256;
const MAX_LINE_BYTES = 2048;
const MAX_STDOUT_BYTES = 1 << 18;
const DEFAULT_TIMEOUT_MS = 6000;

/** Dev-tree default; packaged builds pass resourcesPath. */
function defaultProbePath(resourcesPath) {
  if (resourcesPath) return path.join(resourcesPath, "asio", "asio-probe.exe");
  return path.join(__dirname, "..", "native", "asio-host", "build", "Release", "asio-probe.exe");
}

/**
 * Registered ASIO driver names from both registry views. Resolves to
 * { status: "ok"|"unavailable", names } — an empty list is a valid answer
 * (no ASIO drivers installed), not an error. `options.exec` swaps the
 * process runner (tests inject a fixture); `options.regFile` the binary.
 */
async function enumerateRegistry({ exec = execFileAsync, regFile = "reg" } = {}) {
  const names = [];
  const views = ["HKLM\\SOFTWARE\\ASIO", "HKLM\\SOFTWARE\\WOW6432Node\\ASIO"];
  for (const key of views) {
    try {
      const { stdout } = await exec(regFile, ["query", key], { timeout: 4000, maxBuffer: 1 << 20 });
      for (const line of stdout.split(/\r?\n/)) {
        // Subkey lines look like:  "HKEY_LOCAL_MACHINE\SOFTWARE\ASIO\ASIO4ALL v2"
        const match = /^HKEY_LOCAL_MACHINE\\.*\\ASIO\\(.+)$/.exec(line.trim());
        if (!match) continue;
        const name = match[1].trim();
        if (name && !names.includes(name) && names.length < MAX_DRIVERS) names.push(name);
      }
    } catch (err) {
      // reg.exe exit 1 = key does not exist = "no drivers in this view".
      if (err?.code !== 1 && err?.stderr && !/unable to find/i.test(String(err.stderr))) {
        return { status: "unavailable", message: `registry query failed: ${err.message}`, names: [] };
      }
    }
  }
  return { status: "ok", names };
}

/**
 * Strict validation of one probe JSON record — the COM/registry boundary is
 * hostile territory; nothing unbounded reaches a caller or the UI.
 */
function validateAsioDriverRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = typeof value.name === "string" ? value.name.slice(0, 256) : null;
  if (!name) return null;
  const record = { name };
  if (value.status === "ok") {
    record.status = "ok";
    const numeric = (key) => (typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : undefined);
    for (const key of [
      "version",
      "inputs",
      "outputs",
      "minBuffer",
      "maxBuffer",
      "preferredBuffer",
      "granularity",
      "sampleRate",
    ]) {
      const sanitized = numeric(key);
      if (sanitized !== undefined) record[key] = sanitized;
    }
    const driverName = typeof value.driverName === "string" ? value.driverName.slice(0, 64) : undefined;
    if (driverName !== undefined) record.driverName = driverName;
  } else if (value.status === "unavailable") {
    record.status = "unavailable";
    const detail = typeof value.detail === "string" ? value.detail.slice(0, 256) : undefined;
    if (detail !== undefined) record.detail = detail;
  } else {
    return null;
  }
  return record;
}

/**
 * Parse partial probe stdout — lines before a hang/crash are real answers.
 */
function parseDriverLines(stdout) {
  const drivers = [];
  let malformed = 0;
  if (stdout.length > MAX_STDOUT_BYTES) stdout = stdout.slice(0, MAX_STDOUT_BYTES);
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_LINE_BYTES || drivers.length >= MAX_DRIVERS) {
      malformed++;
      continue;
    }
    try {
      const record = validateAsioDriverRecord(JSON.parse(trimmed));
      if (record) drivers.push(record);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { drivers, malformed };
}

class AsioProbeManager {
  constructor(options = {}) {
    this.probePath = options.probePath ?? defaultProbePath(options.resourcesPath);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawn = options.spawn ?? spawnProcess;
    this.registry = options.registry ?? enumerateRegistry;
  }

  /**
   * Registry names (tier 1) — always available, no native build required.
   * Resolves { status, names } and never throws for the "no drivers" case.
   */
  async listRegisteredDrivers() {
    return this.registry();
  }

  /**
   * Full details (tier 2): run the native probe. Resolves
   *   { status: "ok", drivers } | { status: "timeout", drivers, partial: true }
   *   | { status: "no-probe" } (native build absent) | { status: "error", message }
   * "timeout" still carries every driver that answered before the blocker.
   */
  probeDrivers() {
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawn(this.probePath, [], { shell: false, windowsHide: true });
      } catch (err) {
        resolve({ status: "error", message: `spawn failed: ${err?.message ?? err}`, drivers: [] });
        return;
      }
      if (!child || typeof child.on !== "function" || !child.stdout) {
        resolve({ status: "error", message: "spawn returned no child process", drivers: [] });
        return;
      }

      let stdout = "";
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, this.timeoutMs);

      child.stdout.on("data", (chunk) => {
        if (stdout.length <= MAX_STDOUT_BYTES) stdout += chunk;
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        const code = err?.code;
        if (code === "ENOENT") resolve({ status: "no-probe", drivers: [] });
        else resolve({ status: "error", message: `probe launch failed: ${err?.message ?? err}`, drivers: [] });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const { drivers, malformed } = parseDriverLines(stdout);
        if (killed || signal === "SIGKILL") {
          resolve({ status: "timeout", partial: true, drivers, ...(malformed ? { malformed } : {}) });
          return;
        }
        if (signal) {
          resolve({ status: "timeout", partial: true, drivers, signal, ...(malformed ? { malformed } : {}) });
          return;
        }
        resolve({ status: "ok", drivers, ...(malformed ? { malformed } : {}) });
      });
    });
  }
}

module.exports = {
  AsioProbeManager,
  defaultProbePath,
  enumerateRegistry,
  validateAsioDriverRecord,
  parseDriverLines,
  MAX_DRIVERS,
  DEFAULT_TIMEOUT_MS,
};
