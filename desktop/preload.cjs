/**
 * KYX desktop preload — the only bridge between the sandboxed renderer and
 * the shell. The studio checks `window.kyxDesktop.isDesktop` to skip the
 * web-only landing page and to no-op browser-only features (service
 * worker, PWA install prompt).
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kyxDesktop", {
  isDesktop: true,
  mrt2: {
    getAvailability: () => ipcRenderer.invoke("kyx:mrt2:get-availability"),
    validateEndpoint: (value) => ipcRenderer.invoke("kyx:mrt2:validate-endpoint", value),
    startNativeHost: () => ipcRenderer.invoke("kyx:mrt2:start-native-host"),
    stopNativeHost: () => ipcRenderer.invoke("kyx:mrt2:stop-native-host"),
    openTransport: () => ipcRenderer.invoke("kyx:mrt2:open-transport"),
    sendControl: (transportId, message) => ipcRenderer.invoke("kyx:mrt2:send-control", transportId, message),
    sendBinary: (transportId, packet) => ipcRenderer.invoke("kyx:mrt2:send-binary", transportId, packet),
    closeTransport: (transportId) => ipcRenderer.invoke("kyx:mrt2:close-transport", transportId),
    subscribe: (listener) => {
      if (typeof listener !== "function") throw new TypeError("MRT2 event listener must be a function");
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on("kyx:mrt2:transport-event", handler);
      return () => ipcRenderer.removeListener("kyx:mrt2:transport-event", handler);
    },
  },
  clap: {
    /** Crash-isolated scan of the standard CLAP directories (probe per file). */
    scan: () => ipcRenderer.invoke("kyx:clap:scan"),
  },
  asio: {
    /** ASIO discovery (ADR 0017): registry names + best-effort probe details. */
    list: () => ipcRenderer.invoke("kyx:asio:list"),
  },
  pcm: {
    /** External PCM source: main spawns the host, frames land in the shared ring. */
    start: (request) => ipcRenderer.invoke("kyx:pcm:start", request),
    stop: (id) => ipcRenderer.invoke("kyx:pcm:stop", { id }),
  },
  mcp: {
    status: () => ipcRenderer.invoke("kyx:mcp:status"),
    enable: () => ipcRenderer.invoke("kyx:mcp:enable"),
    disable: () => ipcRenderer.invoke("kyx:mcp:disable"),
    /** Main forwards an external tools/call; answer with { id, result }. */
    onCall: (listener) => {
      if (typeof listener !== "function") throw new TypeError("MCP call listener must be a function");
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on("kyx:mcp:call", handler);
      return () => ipcRenderer.removeListener("kyx:mcp:call", handler);
    },
    answer: (payload) => ipcRenderer.invoke("kyx:mcp:answer", payload),
  },
});
