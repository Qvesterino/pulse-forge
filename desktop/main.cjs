/**
 * KYX desktop shell — Electron main process.
 *
 * The web app ships unchanged: this shell registers a custom `app://`
 * scheme (standard + secure) that serves the production `dist/` build at
 * `app://bundle/...`. Because the scheme is standard, every root-absolute
 * URL inside the app (`/core-worklet.js`, `/models/...`, `/samples/...`,
 * Vite's `/assets/...` chunks) resolves against the `app://bundle` origin —
 * zero changes to the audio engine, persistence, or worklet loaders
 * (ADR 0001's "packaging must not contaminate the core design", realized
 * in ADR 0010).
 *
 * The shell adds exactly four things the browser used to provide:
 *   1. silent permission grants (microphone, Web MIDI),
 *   2. a native Save-As dialog for anchor-download exports,
 *   3. no service worker (the PWA layer is browser-only),
 *   4. `window.kyxDesktop.isDesktop` so the app skips the web landing page.
 */
const {
  app,
  BrowserWindow,
  protocol,
  session,
  dialog,
  net,
  Menu,
  ipcMain,
  MessageChannelMain,
  utilityProcess,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const os = require("node:os");
const { registerMrt2IpcHandlers } = require("./mrt2-bridge.cjs");
const { registerClapIpcHandlers } = require("./clap-host-manager.cjs");
const { registerVst3IpcHandlers } = require("./vst3-host-manager.cjs");
const { registerAsioIpcHandlers } = require("./asio-host-manager.cjs");
const { registerMcpIpcHandlers } = require("./mcp-host-manager.cjs");
const { registerPcmIpcHandlers } = require("./pcm-desktop.cjs");
const { registerWindowsAudioEndpointHandlers } = require("./windows-audio-devices.cjs");
const { registerWindowsAudioIoHandlers } = require("./windows-audio-io.cjs");
const { Mrt2NativeHostManager } = require("./mrt2-host-manager.cjs");
const { Mrt2WindowsHostManager } = require("./mrt2-windows-host-manager.cjs");
const { Mrt2Wsl2HostManager } = require("./mrt2-wsl2-host-manager.cjs");
const { withAudioIsolationHeaders } = require("./audio-isolation.cjs");
const AUDIO_BRIDGE_SMOKE_WORKLET = require("./audio-bridge-smoke-worklet.cjs");

const DIST_DIR = path.join(__dirname, "..", "dist");
const APP_URL = "app://bundle/index.html";
const IS_SMOKE = process.env.KYX_SMOKE === "1";
const IS_WINDOWS_AUDIO_DEVICE_SMOKE = process.env.KYX_WINDOWS_AUDIO_DEVICE_SMOKE === "1";
const AUDIO_BRIDGE_SMOKE_BLOCKS = 3_000;
const AUDIO_BRIDGE_SMOKE_TIMEOUT_MS = 45_000;
if (IS_SMOKE || IS_WINDOWS_AUDIO_DEVICE_SMOKE)
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

let mainWindow = null;
let quittingAfterMrt2Stop = false;
let quittingAfterWindowsAudioStop = false;
let windowsAudioIo = null;
const mrt2NativeHost =
  process.platform === "win32"
    ? process.env.KYX_MRT2_WINDOWS_BACKEND === "wsl2"
      ? new Mrt2Wsl2HostManager({
          appIsPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          homeDirectory: os.homedir(),
        })
      : new Mrt2WindowsHostManager({
          appIsPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          homeDirectory: os.homedir(),
        })
    : new Mrt2NativeHostManager({
        appIsPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        homeDirectory: os.homedir(),
      });

// Must be called before app `ready`.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      // `standard` makes relative/absolute URL resolution behave like http://,
      // `secure` gives IndexedDB/localStorage a trustworthy stable origin.
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  },
]);

// The studio starts audio on user gestures anyway; this only removes the
// surprise factor for restored sessions and preview-on-load paths.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.setAppUserModelId("app.kyx.studio");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/** Serve `app://bundle/<path>` from `dist/<path>` with a traversal guard. */
function registerAppProtocol() {
  protocol.handle("app", (request) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    rel = rel.replace(/^\/+/, "") || "index.html";
    const resolved = path.normalize(path.join(DIST_DIR, rel));
    if (resolved !== DIST_DIR && !resolved.startsWith(DIST_DIR + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    // net.fetch on a file:// URL infers Content-Type from the extension —
    // audio worklet modules and wasm need correct MIME to load.
    return net.fetch(pathToFileURL(resolved).toString()).then(withAudioIsolationHeaders);
  });
}

/** Grant mic + Web MIDI without prompting; deny everything else. */
function configurePermissions() {
  const ses = session.defaultSession;
  const allowed = new Set(["media", "midi"]);
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowed.has(permission));
  });
  ses.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
}

/** Anchor-download exports (WAV/MP3/MIDI/project JSON) open a Save dialog. */
function configureDownloads() {
  session.defaultSession.on("will-download", (_event, item) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const savePath = dialog.showSaveDialogSync(win, {
      defaultPath: item.getFilename(),
    });
    if (!savePath) {
      item.cancel();
      return;
    }
    item.setSavePath(savePath);
  });
}

function isTrustedMrt2Frame(event) {
  const frameUrl = event?.senderFrame?.url;
  if (typeof frameUrl !== "string") return false;
  let parsed;
  try {
    parsed = new URL(frameUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === "app:" && parsed.hostname === "bundle") return true;
  const devUrl = process.env.KYX_DEV_URL;
  if (!devUrl) return false;
  try {
    return parsed.origin === new URL(devUrl).origin;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#14161c",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once("ready-to-show", () => {
    if (!IS_SMOKE) mainWindow.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const devUrl = process.env.KYX_DEV_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadURL(APP_URL);
  }
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (!quittingAfterMrt2Stop && mrt2NativeHost.isRunning()) {
    event.preventDefault();
    quittingAfterMrt2Stop = true;
    void mrt2NativeHost.stop().finally(() => app.quit());
    return;
  }
  if (!quittingAfterWindowsAudioStop && windowsAudioIo?.activeSessions().length) {
    event.preventDefault();
    quittingAfterWindowsAudioStop = true;
    void windowsAudioIo.stopAll().then(
      () => app.quit(),
      (error) => {
        console.error("[windows-audio] Could not confirm utility shutdown before quitting:", error);
        app.quit();
      },
    );
  }
});

app.whenReady().then(() => {
  registerAppProtocol();
  configurePermissions();
  configureDownloads();
  registerMrt2IpcHandlers(ipcMain, {
    appIsPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    homeDirectory: os.homedir(),
    nativeHostManager: mrt2NativeHost,
    isTrustedSender: isTrustedMrt2Frame,
  });
  registerClapIpcHandlers(ipcMain, { resourcesPath: process.resourcesPath });
  registerVst3IpcHandlers(ipcMain, { resourcesPath: process.resourcesPath });
  registerAsioIpcHandlers(ipcMain, { resourcesPath: process.resourcesPath });
  registerWindowsAudioEndpointHandlers(ipcMain, {
    ...(app.isPackaged ? { resourcesPath: process.resourcesPath } : {}),
  });
  windowsAudioIo = registerWindowsAudioIoHandlers(ipcMain, {
    utilityProcess,
    MessageChannelMain,
    isTrustedSender: isTrustedMrt2Frame,
  });
  // MCP (Phase D2): opt-in loopback bridge + stdio forwarder lifecycle. Tool
  // calls execute in the renderer through the deterministic command layer.
  registerMcpIpcHandlers(ipcMain, {
    getWebContents: () => {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
      return win?.webContents ?? null;
    },
  });
  const pcmSessions = registerPcmIpcHandlers(ipcMain, { resourcesPath: process.resourcesPath });
  buildMenu();
  createWindow();
  scheduleUpdateChecks();

  if (IS_WINDOWS_AUDIO_DEVICE_SMOKE) {
    const { runWindowsAudioDeviceSmoke } = require("./windows-audio-device-smoke.cjs");
    void runWindowsAudioDeviceSmoke({ app, mainWindow, utilityProcess, MessageChannelMain });
  } else if (IS_SMOKE) runSmoke();
});

/** Default menu + a manual update check under Help. */
function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
      {
        label: "Help",
        submenu: [{ label: "Check for updates…", click: () => void manualUpdateCheck() }, { role: "about" }],
      },
    ]),
  );
}

let updaterConfigured = false;
let manualCheckInFlight = false;

/**
 * Auto-update (ADR 0011): check GitHub Releases on launch and every 6 h,
 * download in the background, install on the user's restart — mirroring the
 * PWA "prompt" philosophy: a running session is never torn down on its own.
 * `autoInstallOnAppQuit` covers the dismiss path ("Later").
 */
function scheduleUpdateChecks() {
  if (process.env.KYX_DEV_URL || IS_SMOKE) return;
  configureAutoUpdater();
  setTimeout(() => void autoUpdater.checkForUpdates().catch(logUpdateError), 10_000);
  setInterval(() => void autoUpdater.checkForUpdates().catch(logUpdateError), 6 * 60 * 60 * 1000);
}

function configureAutoUpdater() {
  if (updaterConfigured) return;
  updaterConfigured = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;
  // Runtime feed override — points the updater at any static host serving
  // latest.yml + the installer (local testing, future self-hosting).
  const feedUrl = process.env.KYX_UPDATE_URL;
  if (feedUrl) {
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl.endsWith("/") ? feedUrl : `${feedUrl}/` });
  }
  autoUpdater.on("update-not-available", () => {
    if (!manualCheckInFlight) return;
    manualCheckInFlight = false;
    void dialog.showMessageBox({
      type: "info",
      message: "You're up to date",
      detail: `KYX ${app.getVersion()} is the latest version.`,
    });
  });
  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Update ready",
      message: `KYX ${info.version} is ready to install.`,
      detail: "The update installs when the app restarts.",
      buttons: ["Restart & install", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on("error", (error) => logUpdateError(error));
}

function logUpdateError(error) {
  // Expected offline / no-releases-yet noise stays in the console; the UI
  // is never interrupted for background-check failures.
  console.warn("[updater]", error?.message ?? String(error));
}

async function manualUpdateCheck() {
  configureAutoUpdater();
  manualCheckInFlight = true;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    manualCheckInFlight = false;
    void dialog.showMessageBox({
      type: "warning",
      message: "Update check failed",
      detail: error?.message ?? String(error),
    });
  }
}

/**
 * Headless-ish smoke (scripts/desktop-smoke.mjs): boot the packaged build,
 * verify the renderer mounts over app://, no page/preload errors fire, and a
 * silent AudioWorklet can exchange PCM periods with an isolated utility host.
 * The latter is a transport smoke only, not a WASAPI or audible-playback test.
 */
function runSmoke() {
  const win = mainWindow;
  const errors = [];
  let finished = false;
  const timeout = setTimeout(() => finish("timeout"), 60_000);
  win.webContents.on("console-message", (event) => {
    // Electron ≥32 passes the details as event params; the legacy
    // (level, message) positional args are deprecated.
    if (event.level >= 3) errors.push(event.message);
  });
  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    errors.push(`preload-error (${preloadPath}): ${error}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    errors.push(`render-process-gone: ${details.reason}`);
  });

  async function runAudioBridgeProbe() {
    const requestId = "desktop-audio-bridge-smoke-v1";
    const host = utilityProcess.fork(path.join(__dirname, "audio-bridge-smoke-host.cjs"), [], {
      cwd: __dirname,
    });
    let hostExited = false;
    let utilityPortAttached = false;
    let utilityReceivedFirstPeriod = false;
    let utilityReceivedSharedBufferProbe = false;
    let utilityReceivedSharedBufferControl = false;
    let probeSettled = false;
    let nativeProbeSettled = false;
    let resolveProbe;
    let rejectProbe;
    let resolveNativeProbe;
    let rejectNativeProbe;
    const probeResult = new Promise((resolve, reject) => {
      resolveProbe = resolve;
      rejectProbe = reject;
    });
    const nativeHostProbe = new Promise((resolve, reject) => {
      resolveNativeProbe = resolve;
      rejectNativeProbe = reject;
    });
    let sharedBufferProbeSettled = false;
    let resolveSharedBufferProbe;
    let rejectSharedBufferProbe;
    const sharedBufferProbe = new Promise((resolve, reject) => {
      resolveSharedBufferProbe = resolve;
      rejectSharedBufferProbe = reject;
    });
    // The native probe can finish while the renderer is preparing its AudioWorklet.
    // Attach a rejection handler immediately and still await the original promise below.
    void nativeHostProbe.catch(() => {});
    void sharedBufferProbe.catch(() => {});
    const settleProbe = (callback, value) => {
      if (probeSettled) return;
      probeSettled = true;
      callback(value);
    };
    host.once("exit", (code) => {
      hostExited = true;
      if (!probeSettled) settleProbe(rejectProbe, new Error(`audio utility exited with code ${code}`));
      if (!nativeProbeSettled) {
        nativeProbeSettled = true;
        rejectNativeProbe(new Error(`audio utility exited before native addon probe (code ${code})`));
      }
      if (!sharedBufferProbeSettled) {
        sharedBufferProbeSettled = true;
        rejectSharedBufferProbe(new Error(`audio utility exited before SharedArrayBuffer probe (code ${code})`));
      }
    });
    host.on("message", (message) => {
      if (message?.type === "port-attached") utilityPortAttached = true;
      if (message?.type === "first-period-received") utilityReceivedFirstPeriod = true;
      if (message?.type === "shared-buffer-probe-received") utilityReceivedSharedBufferProbe = true;
      if (message?.type === "shared-buffer-probe-control-received") utilityReceivedSharedBufferControl = true;
      if (message?.type === "probe-result") settleProbe(resolveProbe, message.result);
      if (message?.type === "probe-error") settleProbe(rejectProbe, new Error(message.message || "PCM probe failed"));
      if (message?.type === "native-host-probe-result" && !nativeProbeSettled) {
        nativeProbeSettled = true;
        resolveNativeProbe(message.result);
      }
      if (message?.type === "native-host-probe-error" && !nativeProbeSettled) {
        nativeProbeSettled = true;
        rejectNativeProbe(new Error(message.message || "Windows audio native-addon probe failed"));
      }
      if (message?.type === "shared-buffer-probe-result" && !sharedBufferProbeSettled) {
        sharedBufferProbeSettled = true;
        const expected = [3.5, 5.5, 7.5, 9.5];
        const valuesMatch =
          message.samples?.length === expected.length &&
          message.samples.every((value, index) => value === expected[index]);
        if (valuesMatch)
          resolveSharedBufferProbe({ ok: true, sharedMemoryTransportSupported: true, sharedNapiMutation: true });
        else rejectSharedBufferProbe(new Error("native process did not report the expected shared-buffer mutation"));
      }
      if (message?.type === "shared-buffer-transport-unavailable" && !sharedBufferProbeSettled) {
        sharedBufferProbeSettled = true;
        resolveSharedBufferProbe({
          ok: true,
          sharedMemoryTransportSupported: false,
          reason: message.reason || "SharedArrayBuffer was not received by the utility process",
        });
      }
      if (message?.type === "shared-buffer-probe-error" && !sharedBufferProbeSettled) {
        sharedBufferProbeSettled = true;
        rejectSharedBufferProbe(new Error(message.message || "SharedArrayBuffer transfer probe failed"));
      }
    });
    const waitForHostExit = (timeoutMs) =>
      new Promise((resolve) => {
        const onExit = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          host.removeListener("exit", onExit);
          resolve(false);
        }, timeoutMs);
        host.once("exit", onExit);
      });

    const workletSourceLiteral = JSON.stringify(AUDIO_BRIDGE_SMOKE_WORKLET);
    try {
      await win.webContents.executeJavaScript(`(() => {
        const requestId = "${requestId}";
        window.__kyxAudioBridgeResult = { status: "preparing" };
        const resources = { context: null, node: null, silent: null };
        window.__kyxAudioBridgeResources = resources;
        const fail = (error) => {
          window.__kyxAudioBridgeResult = { status: "failed", error: error.message || String(error) };
          resources.node?.disconnect();
          resources.silent?.disconnect();
          if (resources.context && resources.context.state !== "closed") void resources.context.close();
        };
        const probeSharedBuffer = (port) => new Promise((resolve, reject) => {
          const samples = new Float32Array(new SharedArrayBuffer(4 * Float32Array.BYTES_PER_ELEMENT));
          samples.set([1.25, 2.25, 3.25, 4.25]);
          window.__kyxNativeSharedBufferProbe = { ok: false, status: "pending" };
          let sentSharedArrayBuffer = false;
          let checkTimer = null;
          const timeout = setTimeout(() => {
            port.removeEventListener("message", onProbeMessage);
            reject(new Error("renderer-to-utility SharedArrayBuffer probe timed out"));
          }, 5000);
          const onProbeMessage = (probeEvent) => {
            const message = probeEvent.data;
            if (message?.type === "shared-buffer-probe-error") {
              clearTimeout(timeout);
              clearTimeout(checkTimer);
              port.removeEventListener("message", onProbeMessage);
              window.__kyxNativeSharedBufferProbe = { ok: false, error: message.message || "native shared-buffer probe failed" };
              reject(new Error(message.message || "native shared-buffer probe failed"));
              return;
            }
            if (message?.type === "shared-buffer-probe-dropped") {
              clearTimeout(timeout);
              clearTimeout(checkTimer);
              port.removeEventListener("message", onProbeMessage);
              window.__kyxNativeSharedBufferProbe = {
                ok: true,
                supported: false,
                transportReady: true,
                reason: "SharedArrayBuffer message was dropped before reaching the utility process",
              };
              resolve({ ok: true, sharedMemoryTransportSupported: false });
              return;
            }
            if (message?.type === "shared-buffer-probe-control-result" && !sentSharedArrayBuffer) {
              window.__kyxNativeSharedBufferProbe = { ok: false, status: "pending", transportReady: true };
              try {
                port.postMessage({ type: "shared-buffer-probe", samples: samples.buffer });
                sentSharedArrayBuffer = true;
                checkTimer = setTimeout(() => port.postMessage({ type: "shared-buffer-probe-control-check" }), 250);
              } catch (error) {
                clearTimeout(timeout);
                port.removeEventListener("message", onProbeMessage);
                window.__kyxNativeSharedBufferProbe = { ok: false, error: String(error), transportReady: true };
                try {
                  port.postMessage({ type: "shared-buffer-probe-error", message: String(error) });
                } catch {
                  /* Surface the original structured-clone failure below. */
                }
                reject(error);
              }
              return;
            }
            if (message?.type !== "shared-buffer-probe-result") return;
            const expected = [3.5, 5.5, 7.5, 9.5];
            const valuesMatch = samples.every((value, index) => value === expected[index]);
            clearTimeout(timeout);
            clearTimeout(checkTimer);
            port.removeEventListener("message", onProbeMessage);
            if (!valuesMatch) {
              window.__kyxNativeSharedBufferProbe = { ok: false, error: "utility native code did not update shared memory" };
              reject(new Error("utility native code did not update the renderer SharedArrayBuffer"));
              return;
            }
            window.__kyxNativeSharedBufferProbe = { ok: true, supported: true, values: Array.from(samples) };
            port.postMessage({ type: "shared-buffer-probe-verified", samples: Array.from(samples) });
            resolve();
          };
          port.addEventListener("message", onProbeMessage);
          port.start();
          port.postMessage({ type: "shared-buffer-probe-control" });
        });
        const onPort = (event) => {
          const data = event.data;
          if (data?.requestId !== requestId || data.type !== "kyx:audio:bridge-port") return;
          if (event.origin !== location.origin || !resources.node) {
            data.port?.close?.();
            fail(new Error("audio bridge port did not arrive from the ready app context"));
            return;
          }
          void probeSharedBuffer(data.port)
            .then(() => resources.node.port.postMessage({ type: "attach", port: data.port }, [data.port]))
            .catch((error) => {
              data.port?.close?.();
              fail(error);
            });
        };
        window.addEventListener("message", onPort);
        const start = async () => {
          const context = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
          resources.context = context;
          const moduleUrl = URL.createObjectURL(new Blob([${workletSourceLiteral}], { type: "text/javascript" }));
          try {
            await context.audioWorklet.addModule(moduleUrl);
          } finally {
            URL.revokeObjectURL(moduleUrl);
          }
          const node = new AudioWorkletNode(context, "kyx-audio-bridge-smoke", {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: { blockCount: ${AUDIO_BRIDGE_SMOKE_BLOCKS} },
          });
          const silent = context.createGain();
          silent.gain.value = 0;
          node.connect(silent);
          silent.connect(context.destination);
          resources.node = node;
          resources.silent = silent;
          node.port.onmessage = (messageEvent) => {
            const message = messageEvent.data;
            if (message?.type === "result") {
              window.__kyxAudioBridgeResult = message.result;
              window.removeEventListener("message", onPort);
              node.disconnect();
              silent.disconnect();
              void context.close();
            } else if (message?.type === "failed") {
              fail(new Error(message.message || "AudioWorklet PCM bridge failed"));
            }
          };
          await context.resume();
          if (context.state !== "running") throw new Error("Silent AudioWorklet probe context did not start");
          window.__kyxAudioBridgeResult = { status: "ready", sampleRateHz: context.sampleRate };
        };
        void start().catch(fail);
        return true;
      })()`);

      const setupDeadline = Date.now() + 10_000;
      let setupResult;
      while (Date.now() < setupDeadline) {
        setupResult = await win.webContents.executeJavaScript("window.__kyxAudioBridgeResult");
        if (setupResult?.status === "ready") break;
        if (setupResult?.status === "failed") throw new Error(setupResult.error || "AudioWorklet setup failed");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (setupResult?.status !== "ready") throw new Error("AudioWorklet setup timed out");

      const { port1, port2 } = new MessageChannelMain();
      host.postMessage({ type: "attach", blockCount: AUDIO_BRIDGE_SMOKE_BLOCKS }, [port1]);
      win.webContents.postMessage("kyx:audio:bridge-port", { requestId }, [port2]);
      let resultTimeout;
      let result;
      try {
        result = await Promise.race([
          probeResult,
          new Promise((_, reject) => {
            resultTimeout = setTimeout(
              () => reject(new Error("PCM MessagePort probe result timed out")),
              AUDIO_BRIDGE_SMOKE_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (error) {
        const rendererProbe = await win.webContents
          .executeJavaScript("window.__kyxNativeSharedBufferProbe")
          .catch(() => null);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; utilityPortAttached=${utilityPortAttached}; utilityReceivedSharedBufferControl=${utilityReceivedSharedBufferControl}; utilityReceivedSharedBufferProbe=${utilityReceivedSharedBufferProbe}; utilityReceivedFirstPeriod=${utilityReceivedFirstPeriod}; rendererSharedBufferProbe=${JSON.stringify(rendererProbe)}`,
        );
      } finally {
        clearTimeout(resultTimeout);
      }
      if (!result?.ok || result.sent !== AUDIO_BRIDGE_SMOKE_BLOCKS || result.received !== AUDIO_BRIDGE_SMOKE_BLOCKS) {
        throw new Error("PCM MessagePort probe did not complete every 10 ms block");
      }
      let nativeProbeTimeout;
      let nativeHostResult;
      try {
        nativeHostResult = await Promise.race([
          nativeHostProbe,
          new Promise((_, reject) => {
            nativeProbeTimeout = setTimeout(
              () => reject(new Error("Windows audio native-addon probe timed out")),
              5_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(nativeProbeTimeout);
      }
      if (!nativeHostResult?.ok || !nativeHostResult.exactEndpointRejected) {
        throw new Error("Windows audio native-addon probe did not confirm exact endpoint refusal");
      }
      let sharedBufferResult;
      let sharedBufferTimeout;
      try {
        sharedBufferResult = await Promise.race([
          sharedBufferProbe,
          new Promise((_, reject) => {
            sharedBufferTimeout = setTimeout(
              () => reject(new Error("SharedArrayBuffer process probe timed out")),
              5_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(sharedBufferTimeout);
      }
      const rendererSharedBufferResult = await win.webContents.executeJavaScript("window.__kyxNativeSharedBufferProbe");
      if (
        !rendererSharedBufferResult?.ok ||
        rendererSharedBufferResult.supported !== sharedBufferResult.sharedMemoryTransportSupported
      ) {
        throw new Error("renderer and utility process disagreed about SharedArrayBuffer transport support");
      }
      return { ...result, nativeHost: nativeHostResult, sharedBuffer: sharedBufferResult };
    } finally {
      if (!hostExited) {
        try {
          host.postMessage({ type: "shutdown" });
        } catch {
          /* The utility may already be exiting after a failed probe. */
        }
        const stoppedCleanly = await waitForHostExit(1000);
        if (!stoppedCleanly && !hostExited) {
          host.kill();
          await waitForHostExit(500);
        }
      }
    }
  }

  function finish(why, audioBridge = null) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    win.webContents
      .executeJavaScript(
        `({
          origin: location.origin,
          rootMounted: !!document.querySelector("#root"),
          crossOriginIsolated: window.crossOriginIsolated === true,
          sharedArrayBufferAvailable: typeof SharedArrayBuffer === "function",
        })`,
      )
      .then((state) => {
        const ok =
          why !== "timeout" &&
          state.rootMounted &&
          state.origin === "app://bundle" &&
          state.crossOriginIsolated &&
          state.sharedArrayBufferAvailable &&
          audioBridge?.ok === true &&
          errors.length === 0;
        console.log(
          JSON.stringify(
            {
              ok,
              why,
              origin: state.origin,
              rootMounted: state.rootMounted,
              crossOriginIsolated: state.crossOriginIsolated,
              sharedArrayBufferAvailable: state.sharedArrayBufferAvailable,
              audioBridge,
              errors,
            },
            null,
            2,
          ),
        );
        app.exit(ok ? 0 : 1);
      })
      .catch((error) => {
        console.log(JSON.stringify({ ok: false, why: "check-failed", error: String(error) }, null, 2));
        app.exit(1);
      });
  }

  win.webContents.once("did-finish-load", () => {
    // Give lazy boot work (services, IndexedDB open) a moment to surface errors.
    setTimeout(() => {
      void runAudioBridgeProbe()
        .then((audioBridge) => finish("loaded", audioBridge))
        .catch((error) => {
          errors.push(`audio bridge probe: ${error instanceof Error ? error.message : String(error)}`);
          finish("audio-bridge-failed", { ok: false });
        });
    }, 3_000);
  });
}
