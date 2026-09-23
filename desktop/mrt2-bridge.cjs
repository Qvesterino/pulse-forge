/**
 * Narrow Electron IPC boundary for the optional MRT2 native host and a
 * deliberately selected localhost companion. Renderer input never becomes
 * an executable path, command line, or model path.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_ENDPOINT_LENGTH = 2048;

function validateMrt2Endpoint(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) {
    throw new Error("MRT2 endpoint must be a bounded URL string");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MRT2 endpoint is invalid");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("MRT2 endpoint requires ws:// or wss://");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("MRT2 endpoint must target localhost");
  }
  if (url.username || url.password) {
    throw new Error("MRT2 endpoint must not embed credentials");
  }
  return {
    url: url.toString(),
    secure: url.protocol === "wss:",
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "wss:" ? 443 : 80,
  };
}

function getMrt2Availability(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const appIsPackaged = options.appIsPackaged ?? false;
  const resourcesPath = options.resourcesPath ?? process.resourcesPath ?? "";
  const homeDirectory = options.homeDirectory ?? require("node:os").homedir();
  const path = require("node:path");
  const fs = require("node:fs");
  const nativeHostPath =
    options.nativeHostPath ??
    path.join(resourcesPath, "mrt2-host", platform === "win32" ? "kyx-mrt2-host.exe" : "kyx-mrt2-host");
  const modelRoot = options.modelRoot ?? path.join(homeDirectory, "Documents", "Magenta", "magenta-rt-v2");
  const helperExists = (options.fileExists ?? fs.existsSync)(nativeHostPath);
  let helperIsFile = false;
  if (helperExists) {
    try {
      helperIsFile = (
        options.isRegularFile ??
        ((filePath) => {
          const stat = fs.lstatSync(filePath);
          return stat.isFile() && !stat.isSymbolicLink();
        })
      )(nativeHostPath);
    } catch {
      helperIsFile = false;
    }
  }
  const resourcesExist = (options.fileExists ?? fs.existsSync)(path.join(modelRoot, "resources", "musiccoca"));
  const modelPath = path.join(modelRoot, "models", "mrt2_small", "mrt2_small.mlxfn");
  const modelExists = (options.fileExists ?? fs.existsSync)(modelPath);
  let helperExecutable = false;
  if (helperIsFile && platform === "darwin" && arch === "arm64") {
    try {
      (options.assertExecutable ?? ((filePath) => fs.accessSync(filePath, fs.constants.X_OK)))(nativeHostPath);
      helperExecutable = true;
    } catch {
      helperExecutable = false;
    }
  }
  const nativeInstalled =
    platform === "darwin" && arch === "arm64" && appIsPackaged && helperExecutable && resourcesExist && modelExists;
  const nativeRealtime = nativeInstalled && options.nativeReady === true;
  const status = nativeRealtime ? "available" : "unavailable";
  const message = nativeRealtime
    ? "Native MRT2 Small host is ready"
    : platform !== "darwin" || arch !== "arm64"
      ? "MRT2 realtime requires an Apple Silicon Mac"
      : !appIsPackaged
        ? "Native MRT2 is available only in a packaged KYX desktop build"
        : !helperIsFile || !helperExecutable
          ? "The packaged MRT2 native host is missing or not executable"
          : !resourcesExist || !modelExists
            ? "MRT2 Small model resources are not installed in ~/Documents/Magenta/magenta-rt-v2"
            : "MRT2 Small host and model are installed but the runtime has not reported ready";
  return {
    nativeInstalled,
    nativeRealtime,
    localCompanion: true,
    platform,
    arch,
    status,
    message,
  };
}

function registerMrt2IpcHandlers(ipcMain, options = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("Electron ipcMain is required");
  const { nativeHostManager, isTrustedSender, ...availabilityOptions } = options;
  const senderIsTrusted = (event) => (isTrustedSender ? isTrustedSender(event) === true : false);
  const transports = new Map();
  const owners = new Map();
  const destroyListeners = new WeakSet();
  const forgetTransport = (transportId) => {
    const ownerId = transports.get(transportId);
    transports.delete(transportId);
    if (ownerId === undefined) return;
    if (![...transports.values()].some((candidate) => candidate === ownerId)) owners.delete(ownerId);
  };
  if (nativeHostManager?.on) {
    nativeHostManager.on("transport-event", (event) => {
      const ownerId = transports.get(event.transportId);
      if (ownerId === undefined) return;
      const owner = owners.get(ownerId);
      if (!owner || owner.isDestroyed?.()) {
        forgetTransport(event.transportId);
        return;
      }
      try {
        owner.send("kyx:mrt2:transport-event", event);
      } catch {
        forgetTransport(event.transportId);
      }
      if (event.kind === "closed") forgetTransport(event.transportId);
    });
  }
  ipcMain.handle("kyx:mrt2:get-availability", () =>
    getMrt2Availability({ ...availabilityOptions, nativeReady: nativeHostManager?.isReady() === true }),
  );
  ipcMain.handle("kyx:mrt2:validate-endpoint", (_event, value) => {
    try {
      return { ok: true, endpoint: validateMrt2Endpoint(value) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "MRT2 endpoint is invalid" };
    }
  });
  ipcMain.handle("kyx:mrt2:start-native-host", async (event) => {
    if (!senderIsTrusted(event)) throw new Error("MRT2 native-host IPC request is not allowed from this frame");
    if (!nativeHostManager) throw new Error("MRT2 native host manager is unavailable");
    return nativeHostManager.start();
  });
  ipcMain.handle("kyx:mrt2:stop-native-host", async (event) => {
    if (!senderIsTrusted(event)) throw new Error("MRT2 native-host IPC request is not allowed from this frame");
    if (!nativeHostManager) return;
    await nativeHostManager.stop();
  });
  ipcMain.handle("kyx:mrt2:open-transport", (event) => {
    if (!senderIsTrusted(event)) throw new Error("MRT2 transport IPC request is not allowed from this frame");
    if (!nativeHostManager) throw new Error("MRT2 native host manager is unavailable");
    const transportId = nativeHostManager.openTransport();
    transports.set(transportId, event.sender.id);
    owners.set(event.sender.id, event.sender);
    if (!destroyListeners.has(event.sender)) {
      destroyListeners.add(event.sender);
      event.sender.once?.("destroyed", () => {
        owners.delete(event.sender.id);
        for (const [openId, ownerId] of transports) {
          if (ownerId !== event.sender.id) continue;
          transports.delete(openId);
          try {
            nativeHostManager.closeTransport(openId);
          } catch {
            /* host teardown is best effort when a renderer has exited */
          }
        }
      });
    }
    return transportId;
  });
  ipcMain.handle("kyx:mrt2:send-control", (event, transportId, message) => {
    if (!senderIsTrusted(event)) throw new Error("MRT2 transport IPC request is not allowed from this frame");
    if (transports.get(transportId) !== event.sender.id) throw new Error("MRT2 transport is not owned by this frame");
    nativeHostManager.sendControl(transportId, message);
  });
  ipcMain.handle("kyx:mrt2:send-binary", (event, transportId, packet) => {
    if (!senderIsTrusted(event)) throw new Error("MRT2 transport IPC request is not allowed from this frame");
    if (transports.get(transportId) !== event.sender.id) throw new Error("MRT2 transport is not owned by this frame");
    nativeHostManager.sendBinary(transportId, packet);
  });
  ipcMain.handle("kyx:mrt2:close-transport", (event, transportId) => {
    if (!senderIsTrusted(event)) throw new Error("MRT2 transport IPC request is not allowed from this frame");
    if (transports.get(transportId) !== event.sender.id) throw new Error("MRT2 transport is not owned by this frame");
    forgetTransport(transportId);
    nativeHostManager.closeTransport(transportId);
  });
}

module.exports = {
  MAX_ENDPOINT_LENGTH,
  getMrt2Availability,
  registerMrt2IpcHandlers,
  validateMrt2Endpoint,
};
