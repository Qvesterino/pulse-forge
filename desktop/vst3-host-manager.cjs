/**
 * VST3 probe manager — the Node-side half of out-of-process plugin scanning
 * (ADR 0035). Mirrors the CLAP probe manager (ADR 0016): spawns
 * native/vst3-probe per .vst3 FILE OR BUNDLE DIRECTORY, one process per
 * entry — crash isolation means a hostile plugin costs its own probe at
 * most, killed on timeout.
 *
 * Boundary discipline (identical to the CLAP manager):
 *  - the renderer never names the executable — the probe path comes from the
 *    app resources (or the dev-tree default); only the SCANNED PATH is
 *    per-call input, passed as a single argument with shell:false.
 *  - probe stdout is a network boundary: every JSON line is strictly
 *    validated and bounded before it reaches any caller.
 *
 * Wave 1 (this file + the C probe): STRUCTURAL enumeration — a .vst3 entry
 * is classified (bundle directory vs single module) and its binary modules
 * listed, without loading anything. Factory enumeration and audio processing
 * are Waves 2–3 (ADR 0035) and may add a pinned VST SDK 3.8+ build; retain
 * its applicable license notices before distributing SDK-linked binaries.
 */
const { spawn: spawnProcess } = require("node:child_process");
const path = require("node:path");

const PROBE_EXIT = { PROBED: 0, NOT_A_VST3: 2, USAGE: 4 };

const MAX_MODULE_LINES = 512;
const MAX_LINE_BYTES = 8192;
const MAX_STDOUT_BYTES = 1 << 20;
const MAX_STDERR_BYTES = 1 << 16;
const MAX_PATH_LENGTH = 2048;
const DEFAULT_TIMEOUT_MS = 5000;

/** Dev-tree default; packaged builds pass resourcesPath. */
function defaultProbePath(resourcesPath) {
  if (resourcesPath) return path.join(resourcesPath, "vst3", "vst3-probe.exe");
  return path.join(__dirname, "..", "native", "vst3-probe", "build", "Release", "vst3-probe.exe");
}

function boundedString(value, maxLength) {
  if (typeof value !== "string" || value.length > maxLength) return undefined;
  return value;
}

/**
 * Strict module-output validation: a module is a bounded path string plus a
 * known architecture folder name; everything else is rejected.
 */
function validateModuleDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pathValue = boundedString(value.path, MAX_PATH_LENGTH);
  const arch = boundedString(value.arch, 64);
  const bytes = value.bytes;
  if (pathValue === undefined || arch === undefined) return null;
  const module = { path: pathValue, arch };
  if (typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 && bytes <= Number.MAX_SAFE_INTEGER) {
    module.bytes = bytes;
  }
  return module;
}

class Vst3ProbeManager {
  constructor(options = {}) {
    this.probePath = options.probePath ?? defaultProbePath(options.resourcesPath);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawn = options.spawn ?? spawnProcess;
  }

  /**
   * Probe one .vst3 entry (bundle directory or single module file). Resolves
   * with a classification — never throws:
   *   { status: "ok", modules }             binary modules enumerated
   *   { status: "not-vst3" }                missing/bad layout
   *   { status: "timeout" }                 killed after this.timeoutMs
   *   { status: "crashed", exitCode }       nonzero/signal exit — quarantine
   *   { status: "error", message }          manager-side failure (bad path etc.)
   */
  probeEntry(entryPath) {
    if (typeof entryPath !== "string" || entryPath.length === 0 || entryPath.length > MAX_PATH_LENGTH) {
      return Promise.resolve({ status: "error", message: "plugin path must be a bounded string" });
    }
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawn(this.probePath, [entryPath], { shell: false, windowsHide: true });
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
          resolve({ status: "crashed", signal, stderr: stderr.slice(0, 512) });
          return;
        }
        if (code === PROBE_EXIT.NOT_A_VST3) {
          resolve({ status: "not-vst3", stderr: stderr.slice(0, 512) });
          return;
        }
        if (code !== PROBE_EXIT.PROBED) {
          resolve({ status: "crashed", exitCode: code, stderr: stderr.slice(0, 512) });
          return;
        }
        const modules = [];
        let malformed = 0;
        for (const line of stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.length > MAX_LINE_BYTES || modules.length >= MAX_MODULE_LINES) {
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
          const module = validateModuleDescriptor(parsed);
          if (module) modules.push(module);
          else malformed++;
        }
        resolve({ status: "ok", modules, ...(malformed > 0 ? { malformed } : {}) });
      });
    });
  }

  /** Aggregate scan: .vst3 entry paths in (user-picked), modules out. */
  async scanEntries(entries) {
    if (!Array.isArray(entries) || entries.length > 4096) {
      return { status: "error", message: "scanEntries expects a bounded array of .vst3 paths" };
    }
    const modules = [];
    const failures = [];
    let ok = 0;
    let notVst3 = 0;
    let failed = 0;
    for (const entryPath of entries) {
      const result = await this.probeEntry(entryPath);
      if (result.status === "ok") {
        ok++;
        for (const module of result.modules) modules.push({ entry: entryPath, ...module });
      } else if (result.status === "not-vst3") {
        notVst3++;
      } else {
        failed++;
        failures.push({ entry: entryPath, status: result.status, message: result.stderr ?? result.message });
      }
    }
    return { status: "ok", scanned: entries.length, modules, counts: { ok, notVst3, failed }, failures };
  }
}

/**
 * Standard VST3 search directories on Windows. Per the Steinberg spec the
 * module folder is scanned WITHOUT recursion (bundle folders are the unit);
 * missing directories simply hold no plugins.
 */
function defaultScanDirectories(env = process.env) {
  const home = env.APPDATA ?? "";
  const programFiles = env["ProgramFiles(C:x86)"] ?? env.ProgramFiles ?? "";
  const common = env["CommonProgramFiles"] ?? "";
  const dirs = [];
  if (common) dirs.push(path.join(common, "VST3"));
  if (home) dirs.push(path.join(home, "Programs", "Common", "VST3"));
  void programFiles;
  return dirs;
}

/** Flat enumeration of *.vst3 entries in the given directories (no recursion). */
function listInstalledVst3Entries(directories = defaultScanDirectories(), fsMod = require("node:fs")) {
  const entries = [];
  for (const dir of directories) {
    let names = [];
    try {
      names = fsMod.readdirSync(dir);
    } catch {
      continue; // missing directory — holds no plugins
    }
    for (const name of names) {
      if (name.toLowerCase().endsWith(".vst3")) entries.push(path.join(dir, name));
    }
  }
  return entries;
}

/**
 * Electron IPC registration — mirrors registerClapIpcHandlers. The renderer
 * asks for a scan of the standard directories; it never names executables.
 */
function registerVst3IpcHandlers(ipcMain, options = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("Electron ipcMain is required");
  const manager = options.manager ?? new Vst3ProbeManager(options);
  const directories = options.directories ?? defaultScanDirectories();
  ipcMain.handle("kyx:vst3:scan", async () => {
    const entries = listInstalledVst3Entries(directories);
    const result = await manager.scanEntries(entries);
    return { ...result, directories };
  });
}

module.exports = {
  Vst3ProbeManager,
  registerVst3IpcHandlers,
  defaultProbePath,
  defaultScanDirectories,
  listInstalledVst3Entries,
  validateModuleDescriptor,
  PROBE_EXIT,
};
