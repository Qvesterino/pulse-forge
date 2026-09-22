/**
 * Small, testable Electron-side boundary for the optional MRT2 host.
 *
 * This module deliberately does not spawn a model process. The native MRT2
 * adapter is still an external release artifact; until it exists on a host,
 * Electron reports unavailable and can only validate a deliberately selected
 * loopback companion endpoint. Renderer input never becomes an executable
 * path, command line or model path.
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

function getMrt2Availability({ platform = process.platform, arch = process.arch, nativeInstalled = false } = {}) {
  return {
    nativeRealtime: nativeInstalled === true && platform === "darwin" && arch === "arm64",
    localCompanion: true,
    platform,
    arch,
    status: nativeInstalled === true && platform === "darwin" && arch === "arm64" ? "available" : "unavailable",
    message:
      nativeInstalled === true && platform === "darwin" && arch === "arm64"
        ? "Native MRT2 host is available"
        : "MRT2 native host is not installed; use an explicit localhost companion",
  };
}

function registerMrt2IpcHandlers(ipcMain, options = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("Electron ipcMain is required");
  ipcMain.handle("kyx:mrt2:get-availability", () => getMrt2Availability(options));
  ipcMain.handle("kyx:mrt2:validate-endpoint", (_event, value) => {
    try {
      return { ok: true, endpoint: validateMrt2Endpoint(value) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "MRT2 endpoint is invalid" };
    }
  });
}

module.exports = {
  MAX_ENDPOINT_LENGTH,
  getMrt2Availability,
  registerMrt2IpcHandlers,
  validateMrt2Endpoint,
};
