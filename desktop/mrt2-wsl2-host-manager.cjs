/**
 * Optional WSL2/NVIDIA launcher for the Windows MRT2 companion protocol.
 *
 * This launcher is selected only by Electron main-process configuration. The
 * renderer still cannot select a distro, Python binary, model path or flags.
 */
const os = require("node:os");
const path = require("node:path");
const { Mrt2WindowsHostManager } = require("./mrt2-windows-host-manager.cjs");
const { verifyWindowsMrt2HostScript } = require("./mrt2-windows-assets.cjs");

function windowsPathToWslPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("WSL MRT2 path is invalid");
  }
  const absolutePath = path.win32.resolve(value);
  const root = path.win32.parse(absolutePath).root;
  if (!/^[A-Za-z]:\\$/u.test(root)) {
    throw new Error("WSL MRT2 requires a drive-letter path accessible under /mnt");
  }
  return `/mnt/${root[0].toLowerCase()}${absolutePath.slice(root.length - 1).replaceAll("\\", "/")}`;
}

function validateDistro(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(value)) {
    throw new Error("WSL MRT2 distribution name is invalid");
  }
  return value;
}

function validateLinuxPath(value, label) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > 1024 ||
    value.includes("\0") ||
    value.split("/").includes("..")
  ) {
    throw new Error(`${label} must be a fixed absolute Linux path`);
  }
  return value;
}

class Mrt2Wsl2HostManager extends Mrt2WindowsHostManager {
  constructor(options = {}) {
    const resourcesPath = options.resourcesPath ?? process.resourcesPath ?? "";
    const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
    const wslPath = options.wslExePath ?? path.win32.join(windowsRoot, "System32", "wsl.exe");
    super({
      ...options,
      nativeHostPath: wslPath,
      executionMode: "near-realtime",
      backendId: "mrt2-windows-wsl2-cuda",
      warning: "Experimental WSL2/CUDA stream; realtime promotion requires the 10-minute benchmark gate",
      stopTimeoutMs: options.stopTimeoutMs ?? 20_000,
      stopSignalTimeoutMs: options.stopSignalTimeoutMs ?? 15_000,
    });
    this.wslDistro = validateDistro(options.wslDistro ?? process.env.KYX_MRT2_WSL_DISTRO ?? "Ubuntu");
    this.wslPythonPath = validateLinuxPath(
      options.wslPythonPath ??
        process.env.KYX_MRT2_WSL_PYTHON ??
        `/home/${path.posix.basename(this.homeDirectory.replaceAll("\\", "/"))}/.venvs/kyx-mrt2-wsl/bin/python`,
      "WSL MRT2 Python executable",
    );
    this.hostScriptPath =
      options.hostScriptPath ?? path.join(resourcesPath, "mrt2-windows", "kyx_mrt2_windows_host.py");
    this.manifestPath =
      options.manifestPath ?? path.join(resourcesPath, "mrt2-windows", "kyx-mrt2-windows-manifest.json");
    this.verifyHostScript =
      options.verifyHostScript ??
      (() => verifyWindowsMrt2HostScript({ hostScriptPath: this.hostScriptPath, manifestPath: this.manifestPath }));
  }

  assertInstallAvailable() {
    if (this.platform !== "win32" || this.arch !== "x64") {
      throw new Error("WSL2 MRT2 companion requires a Windows x64 host");
    }
    if (!this.appIsPackaged) throw new Error("WSL2 MRT2 companion is available only in a packaged KYX desktop build");
    for (const [filePath, label] of [
      [this.nativeHostPath, "WSL executable"],
      [this.hostScriptPath, "packaged WSL MRT2 host script"],
      [this.manifestPath, "WSL companion integrity manifest"],
    ]) {
      let stat;
      try {
        stat = this.lstat(filePath);
      } catch {
        throw new Error(`The ${label} is missing or invalid`);
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`The ${label} is not a regular file`);
    }
    const integrity = this.verifyHostScript();
    if (!integrity?.ok) {
      throw new Error(
        `The packaged WSL MRT2 host script failed integrity verification: ${integrity?.error ?? "invalid manifest"}`,
      );
    }
    try {
      this.assertExecutable(this.nativeHostPath);
    } catch {
      throw new Error("The Windows Subsystem for Linux executable is not available");
    }
    if (!this.fileExists(this.modelPaths.resources) || !this.hasModelAssets()) {
      throw new Error("WSL2 MRT2 model resources are not installed in ~/Documents/Magenta/magenta-rt-v2-windows");
    }
  }

  getHostArgs() {
    return [
      "--distribution",
      this.wslDistro,
      "--exec",
      "/usr/bin/env",
      "XLA_PYTHON_CLIENT_PREALLOCATE=false",
      "XLA_FLAGS=--xla_gpu_autotune_level=1",
      "TF_GPU_ALLOCATOR=cuda_malloc_async",
      this.wslPythonPath,
      windowsPathToWslPath(this.hostScriptPath),
      "--model-root",
      windowsPathToWslPath(this.modelPaths.modelRoot),
      "--execution-mode",
      "near-realtime",
    ];
  }
}

module.exports = { Mrt2Wsl2HostManager, windowsPathToWslPath };
