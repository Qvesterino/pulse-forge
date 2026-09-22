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
const { app, BrowserWindow, protocol, session, dialog, net, Menu, ipcMain } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { registerMrt2IpcHandlers } = require("./mrt2-bridge.cjs");

const DIST_DIR = path.join(__dirname, "..", "dist");
const APP_URL = "app://bundle/index.html";
const IS_SMOKE = process.env.KYX_SMOKE === "1";

let mainWindow = null;

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
    return net.fetch(pathToFileURL(resolved).toString());
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

app.whenReady().then(() => {
  registerAppProtocol();
  configurePermissions();
  configureDownloads();
  registerMrt2IpcHandlers(ipcMain);
  buildMenu();
  createWindow();
  scheduleUpdateChecks();

  if (IS_SMOKE) runSmoke();
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
 * verify the renderer mounts over app:// and no page/preload errors fire,
 * then exit 0/1 so CI or a human can gate on it.
 */
function runSmoke() {
  const win = mainWindow;
  const errors = [];
  const timeout = setTimeout(() => finish("timeout"), 30_000);
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

  function finish(why) {
    clearTimeout(timeout);
    win.webContents
      .executeJavaScript(
        `({
          origin: location.origin,
          rootMounted: !!document.querySelector("#root"),
        })`,
      )
      .then((state) => {
        const ok = why !== "timeout" && state.rootMounted && state.origin === "app://bundle" && errors.length === 0;
        console.log(JSON.stringify({ ok, why, origin: state.origin, rootMounted: state.rootMounted, errors }, null, 2));
        app.exit(ok ? 0 : 1);
      })
      .catch((error) => {
        console.log(JSON.stringify({ ok: false, why: "check-failed", error: String(error) }, null, 2));
        app.exit(1);
      });
  }

  win.webContents.once("did-finish-load", () => {
    // Give lazy boot work (services, IndexedDB open) a moment to surface errors.
    setTimeout(() => finish("loaded"), 3_000);
  });
}
