/**
 * KYX desktop preload — the only bridge between the sandboxed renderer and
 * the shell. The studio checks `window.kyxDesktop.isDesktop` to skip the
 * web-only landing page and to no-op browser-only features (service
 * worker, PWA install prompt).
 */
const { contextBridge, ipcRenderer } = require("electron");

// The native-audio transport probe uses a dedicated MessagePort. Forward only
// the port object from this main-process-owned channel into the app origin;
// PCM never rides through ordinary invoke payloads or React state.
ipcRenderer.on("kyx:audio:bridge-port", (event, metadata) => {
  const port = event.ports?.[0];
  const requestId = metadata && metadata.requestId;
  if (!port || typeof requestId !== "string" || requestId.length > 96) {
    port?.close?.();
    return;
  }
  try {
    window.postMessage({ type: "kyx:audio:bridge-port", requestId, port }, "*", [port]);
  } catch (error) {
    console.error("Could not forward the Windows audio MessagePort to the app page", error);
    port.close();
  }
});
ipcRenderer.on("kyx:audio:windows-session-port", (event, metadata) => {
  const port = event.ports?.[0];
  const sessionId = metadata && typeof metadata.sessionId === "string" ? metadata.sessionId : "";
  if (!port || !sessionId) {
    port?.close();
    return;
  }
  try {
    window.postMessage({ type: "kyx:audio:windows-session-port", sessionId, port }, window.location.origin, [port]);
  } catch (error) {
    port.close();
    console.error("Could not forward the Windows audio session port to the app page", error);
  }
});

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
  vst3: {
    /** Crash-isolated STRUCTURAL scan of the standard VST3 directories
     *  (ADR 0035 Wave 1 — layout enumeration, no plugin code runs). */
    scan: () => ipcRenderer.invoke("kyx:vst3:scan"),
  },
  asio: {
    /** ASIO discovery (ADR 0017): registry names + best-effort probe details. */
    list: () => ipcRenderer.invoke("kyx:asio:list"),
  },
  audio: {
    /** Windows Core Audio endpoint discovery only; this does not start a stream. */
    listWindowsEndpoints: () => ipcRenderer.invoke("kyx:audio:windows-endpoints"),
    /** Start an exact shared-mode duplex session and transfer PCM over a dedicated port. */
    startWindowsSession: (request) => ipcRenderer.invoke("kyx:audio:windows-start", request),
    stopWindowsSession: (sessionId) => ipcRenderer.invoke("kyx:audio:windows-stop", { sessionId }),
    /** Observe bounded startup diagnostics for a native session owned by this window. */
    onWindowsSessionStage: (listener) => {
      if (typeof listener !== "function") throw new TypeError("Windows audio stage listener must be a function");
      const handler = (_event, payload) => {
        if (
          !payload ||
          typeof payload !== "object" ||
          typeof payload.sessionId !== "string" ||
          payload.sessionId.length === 0 ||
          payload.sessionId.length > 128 ||
          typeof payload.stage !== "string" ||
          payload.stage.length === 0 ||
          payload.stage.length > 256
        )
          return;
        listener({ sessionId: payload.sessionId, stage: payload.stage });
      };
      ipcRenderer.on("kyx:audio:windows-session-stage", handler);
      return () => ipcRenderer.removeListener("kyx:audio:windows-session-stage", handler);
    },
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
