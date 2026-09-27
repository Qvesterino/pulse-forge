/**
 * CLAP probe manager — the Node-side half of out-of-process plugin scanning
 * (ADR 0016). Spawns native/clap-probe per .clap FILE (never a directory):
 * one process per file is the crash-isolation unit, so a hostile plugin can
 * cost its own probe at most, killed on timeout.
 *
 * Boundary discipline (mirrors the MRT2 host managers):
 *  - the renderer never names the executable — the probe path comes from the
 *    app resources (or the dev-tree default); only the SCANNED FILE path is
 *    per-call input, and it is passed as a single argument with shell:false.
 *  - probe stdout is a network boundary: every JSON line is strictly
 *    validated and bounded before it reaches any caller.
 */
const { spawn: spawnProcess } = require("node:child_process");
const path = require("node:path");

const PROBE_EXIT = { PROBED: 0, NOT_A_CLAP: 2, INIT_REFUSED: 3, USAGE: 4 };

const MAX_PLUGIN_LINES = 512;
const MAX_LINE_BYTES = 8192;
const MAX_STDOUT_BYTES = 1 << 20; // 512 plugins × ≤8 KB lines fits comfortably
const MAX_STDERR_BYTES = 1 << 16;
const MAX_PATH_LENGTH = 2048;
const DEFAULT_TIMEOUT_MS = 5000;

/** Dev-tree default; packaged builds pass resourcesPath. */
function defaultProbePath(resourcesPath) {
  if (resourcesPath) return path.join(resourcesPath, "clap", "clap-probe.exe");
  return path.join(__dirname, "..", "native", "clap-probe", "build", "Release", "clap-probe.exe");
}

function boundedString(value, maxLength) {
  if (typeof value !== "string" || value.length > maxLength) return undefined;
  return value;
}

/**
 * Strict probe-output validation: returns a sanitized descriptor or null.
 * `id` and `name` are mandatory per the CLAP spec; everything else optional.
 */
function validatePluginDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const index = value.index;
  const id = boundedString(value.id, 256);
  const name = boundedString(value.name, 256);
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 4095) return null;
  if (id === undefined || name === undefined) return null;
  const descriptor = { index, id, name };
  for (const key of ["vendor", "url", "manualUrl", "supportUrl", "version", "description"]) {
    const sanitized = boundedString(value[key], 1024);
    if (sanitized !== undefined) descriptor[key] = sanitized;
  }
  if (value.features !== undefined) {
    if (!Array.isArray(value.features) || value.features.length > 64) return null;
    const features = [];
    for (const feature of value.features) {
      const sanitized = boundedString(feature, 128);
      if (sanitized === undefined) return null;
      features.push(sanitized);
    }
    descriptor.features = features;
  }
  return descriptor;
}

class ClapProbeManager {
  constructor(options = {}) {
    this.probePath = options.probePath ?? defaultProbePath(options.resourcesPath);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawn = options.spawn ?? spawnProcess;
  }

  /**
   * Probe one .clap file. Resolves with a classification — never throws:
   *   { status: "ok", plugins }            descriptors found
   *   { status: "not-clap" }               load failed / no clap_entry export
   *   { status: "init-refused" }           version mismatch or init() false
   *   { status: "timeout" }                killed after this.timeoutMs
   *   { status: "crashed", exitCode }      nonzero/signal exit — quarantine
   *   { status: "error", message }         manager-side failure (bad path etc.)
   */
  probeFile(filePath) {
    if (typeof filePath !== "string" || filePath.length === 0 || filePath.length > MAX_PATH_LENGTH) {
      return Promise.resolve({ status: "error", message: "plugin path must be a bounded string" });
    }
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawn(this.probePath, [filePath], { shell: false, windowsHide: true });
      } catch (err) {
        resolve({ status: "error", message: `spawn failed: ${err?.message ?? err}` });
        return;
      }
      if (!child || typeof child.on !== "function" || !child.stdout) {
        resolve({ status: "error", message: "spawn returned no child process" });
        return;
      }

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
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
        stdoutBytes += chunk.length;
        if (stdoutBytes <= MAX_STDOUT_BYTES) stdout += chunk;
      });
      child.stderr?.on?.("data", (chunk) => {
        if (stderr.length < MAX_STDERR_BYTES) stderr += chunk;
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ status: "error", message: `probe launch failed: ${err?.message ?? err}` });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (killed || signal === "SIGKILL") {
          resolve({ status: "timeout", stderr: stderr.slice(0, 512) });
          return;
        }
        if (signal) {
          // The plugin crashed the probe process — exactly what the
          // out-of-process design is for. Report, quarantine, move on.
          resolve({ status: "crashed", signal, stderr: stderr.slice(0, 512) });
          return;
        }
        if (code === PROBE_EXIT.NOT_A_CLAP) {
          resolve({ status: "not-clap", stderr: stderr.slice(0, 512) });
          return;
        }
        if (code === PROBE_EXIT.INIT_REFUSED) {
          resolve({ status: "init-refused", stderr: stderr.slice(0, 512) });
          return;
        }
        if (code !== PROBE_EXIT.PROBED) {
          resolve({ status: "crashed", exitCode: code, stderr: stderr.slice(0, 512) });
          return;
        }
        const plugins = [];
        let malformed = 0;
        for (const line of stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.length > MAX_LINE_BYTES || plugins.length >= MAX_PLUGIN_LINES) {
            malformed++;
            continue;
          }
          let parsed;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            malformed++;
            continue;
          }
          const descriptor = validatePluginDescriptor(parsed);
          if (descriptor) plugins.push(descriptor);
          else malformed++;
        }
        resolve({ status: "ok", plugins, ...(malformed > 0 ? { malformed } : {}) });
      });
    });
  }

  /** Aggregate scan: file paths in (user-picked), plugin descriptors out. */
  async scanPaths(paths) {
    if (!Array.isArray(paths) || paths.length > 4096) {
      return { status: "error", message: "scanPaths expects a bounded array of file paths" };
    }
    const plugins = [];
    const failures = [];
    let ok = 0;
    let notClap = 0;
    let failed = 0;
    for (const filePath of paths) {
      const result = await this.probeFile(filePath);
      if (result.status === "ok") {
        ok++;
        for (const descriptor of result.plugins) plugins.push({ file: filePath, ...descriptor });
      } else if (result.status === "not-clap") {
        notClap++;
      } else {
        failed++;
        failures.push({ file: filePath, status: result.status, message: result.stderr ?? result.message });
      }
    }
    return { status: "ok", scanned: paths.length, plugins, counts: { ok, notClap, failed }, failures };
  }
}

/**
 * Standard CLAP search directories on Windows (per the CLAP spec: flat
 * folders, no recursion). Missing directories simply hold no plugins.
 */
function defaultScanDirectories(env = process.env) {
  const dirs = [];
  if (env.COMMONPROGRAMFILES) dirs.push(path.join(env.COMMONPROGRAMFILES, "CLAP"));
  if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "Programs", "Common", "CLAP"));
  return dirs.filter((dir) => typeof dir === "string" && dir.length > 0);
}

/**
 * Enumerate .clap files under the given directories (default: the standard
 * ones). Bounded — a runaway folder tree cannot outgrow the cap.
 */
function listInstalledClapFiles(directories = defaultScanDirectories(), fsMod = require("node:fs")) {
  const files = [];
  for (const dir of directories) {
    let entries;
    try {
      entries = fsMod.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // missing directory = nothing installed there
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".clap")) {
        files.push(path.join(dir, entry.name));
        if (files.length >= 4096) return files;
      }
    }
  }
  return files;
}

/**
 * Electron IPC surface (kyx:clap:scan) — the renderer's "aké clapy mám?"
 * verb lands here. Registration mirrors the MRT2 bridge; the heavy work is
 * the same crash-isolated probe-per-file scan the manager always does.
 */
function registerClapIpcHandlers(ipcMain, options = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("Electron ipcMain is required");
  const manager = options.manager ?? new ClapProbeManager(options);
  const directories = options.directories ?? defaultScanDirectories();
  ipcMain.handle("kyx:clap:scan", async () => {
    const files = listInstalledClapFiles(directories);
    const result = await manager.scanPaths(files);
    return { ...result, scannedDirectories: directories };
  });
  return manager;
}

module.exports = {
  ClapProbeManager,
  defaultProbePath,
  validatePluginDescriptor,
  defaultScanDirectories,
  listInstalledClapFiles,
  registerClapIpcHandlers,
  PROBE_EXIT,
  MAX_PLUGIN_LINES,
  DEFAULT_TIMEOUT_MS,
};
