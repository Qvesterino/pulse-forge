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
});
