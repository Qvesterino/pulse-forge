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
  },
});
