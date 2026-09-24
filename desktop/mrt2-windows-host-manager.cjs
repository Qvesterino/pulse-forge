/**
 * Windows companion process manager for the provider-neutral MRT2 protocol.
 *
 * This deliberately lives beside the macOS-only native host manager. It does
 * not pretend that MLX/Metal is portable: the packaged Windows executable is
 * a separate companion (for example a Python/JAX/CUDA launcher) that speaks
 * the same framed stdin/stdout protocol.
 */
const os = require("node:os");
const path = require("node:path");
const { Mrt2NativeHostManager } = require("./mrt2-host-manager.cjs");

function defaultWindowsPaths(homeDirectory, resourcesPath) {
  const modelRoot = path.join(homeDirectory, "Documents", "Magenta", "magenta-rt-v2-windows");
  return {
    nativeHostPath: path.join(resourcesPath, "mrt2-windows", "kyx-mrt2-windows-host.exe"),
    modelRoot,
    resources: path.join(modelRoot, "resources"),
    model: path.join(modelRoot, "models", "mrt2_small"),
  };
}

class Mrt2WindowsHostManager extends Mrt2NativeHostManager {
  constructor(options = {}) {
    const resourcesPath = options.resourcesPath ?? process.resourcesPath ?? "";
    const homeDirectory = options.homeDirectory ?? os.homedir();
    const defaults = defaultWindowsPaths(homeDirectory, resourcesPath);
    super({
      ...options,
      platform: "win32",
      arch: "x64",
      nativeHostPath: options.nativeHostPath ?? defaults.nativeHostPath,
    });
    this.platform = "win32";
    this.arch = "x64";
    this.nativeHostPath = options.nativeHostPath ?? defaults.nativeHostPath;
    this.modelPaths = {
      modelRoot: options.modelRoot ?? defaults.modelRoot,
      resources: options.resourcesPathForModel ?? defaults.resources,
      model: options.modelPath ?? defaults.model,
    };
    // JAX uses the raw safetensors checkpoint while an eventual CUDA/ONNX
    // companion may use the exported model directory. Keep both candidates in
    // the fixed host-owned asset boundary; renderer input can never select a
    // different path.
    this.checkpointPath =
      options.checkpointPath ?? path.join(this.modelPaths.modelRoot, "checkpoints", "mrt2_small.safetensors");
    this.executionMode = options.executionMode ?? "capture";
    this.backendId = options.backendId ?? "mrt2-windows-companion";
    this.runtimeVersion = options.runtimeVersion;
    this.measuredLatencyMs = options.measuredLatencyMs;
    this.frameP95Ms = options.frameP95Ms;
    this.realtimeFactor = options.realtimeFactor;
    this.runtimeWarning = options.warning;
    if (!options.childEnv) {
      const inheritedEnv = process.env;
      this.childEnv = {
        HOME: this.homeDirectory,
        USERPROFILE: this.homeDirectory,
        ...(inheritedEnv.SystemRoot ? { SystemRoot: inheritedEnv.SystemRoot } : {}),
        ...(inheritedEnv.WINDIR ? { WINDIR: inheritedEnv.WINDIR } : {}),
        ...(inheritedEnv.TEMP ? { TEMP: inheritedEnv.TEMP } : {}),
        ...(inheritedEnv.TMP ? { TMP: inheritedEnv.TMP } : {}),
        ...(inheritedEnv.CUDA_PATH ? { CUDA_PATH: inheritedEnv.CUDA_PATH } : {}),
        PATH: inheritedEnv.PATH ?? "",
      };
    }
  }

  assertInstallAvailable() {
    if (this.platform !== "win32" || this.arch !== "x64") {
      throw new Error("MRT2 Windows companion requires a Windows x64 host");
    }
    if (!this.appIsPackaged)
      throw new Error("Windows MRT2 companion is available only in a packaged KYX desktop build");
    let stat;
    try {
      stat = this.lstat(this.nativeHostPath);
    } catch {
      throw new Error("The packaged Windows MRT2 companion is missing or not executable");
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("The packaged Windows MRT2 companion is not a regular file");
    }
    try {
      this.assertExecutable(this.nativeHostPath);
    } catch {
      throw new Error("The packaged Windows MRT2 companion is missing or not executable");
    }
    if (!this.fileExists(this.modelPaths.resources) || !this.hasModelAssets()) {
      throw new Error("Windows MRT2 model resources are not installed in ~/Documents/Magenta/magenta-rt-v2-windows");
    }
  }

  hasModelAssets() {
    return this.fileExists(this.modelPaths.model) || this.fileExists(this.checkpointPath);
  }

  getHostArgs() {
    return this.executionMode === "capture"
      ? super.getHostArgs()
      : [...super.getHostArgs(), "--execution-mode", this.executionMode];
  }

  getAvailability() {
    let installed = false;
    try {
      const stat = this.lstat(this.nativeHostPath);
      installed =
        this.appIsPackaged &&
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        this.fileExists(this.modelPaths.resources) &&
        this.hasModelAssets();
      if (installed) this.assertExecutable(this.nativeHostPath);
    } catch {
      installed = false;
    }
    const ready = installed && this.isReady();
    const profile = this.readyProfile ?? {
      backendId: this.backendId,
      executionMode: this.executionMode,
      ...(this.runtimeVersion ? { runtimeVersion: this.runtimeVersion } : {}),
      ...(typeof this.measuredLatencyMs === "number" ? { measuredLatencyMs: this.measuredLatencyMs } : {}),
      ...(typeof this.frameP95Ms === "number" ? { frameP95Ms: this.frameP95Ms } : {}),
      ...(typeof this.realtimeFactor === "number" ? { realtimeFactor: this.realtimeFactor } : {}),
      ...(this.runtimeWarning ? { warning: this.runtimeWarning } : {}),
    };
    return {
      nativeInstalled: installed,
      nativeRealtime: ready && profile.executionMode === "realtime",
      windowsCompanionInstalled: installed,
      windowsCompanionReady: ready,
      localCompanion: true,
      platform: this.platform,
      arch: this.arch,
      status: ready ? "available" : "unavailable",
      executionMode: profile.executionMode,
      backendId: profile.backendId,
      ...(profile.runtimeVersion ? { runtimeVersion: profile.runtimeVersion } : {}),
      ...(typeof profile.measuredLatencyMs === "number" ? { measuredLatencyMs: profile.measuredLatencyMs } : {}),
      ...(typeof profile.frameP95Ms === "number" ? { frameP95Ms: profile.frameP95Ms } : {}),
      ...(typeof profile.realtimeFactor === "number" ? { realtimeFactor: profile.realtimeFactor } : {}),
      ...(profile.warning ? { warning: profile.warning } : {}),
      message: ready
        ? `Windows MRT2 companion is ready (${profile.executionMode})`
        : installed
          ? "Windows MRT2 companion is installed but not running"
          : "Windows MRT2 companion or model resources are not installed",
    };
  }
}

module.exports = {
  Mrt2WindowsHostManager,
  defaultWindowsPaths,
};
