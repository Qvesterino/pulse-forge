/**
 * KYX desktop dev loop: spawn the Vite dev server, wait for it to come up,
 * then launch Electron pointed at it (main.cjs reads KYX_DEV_URL).
 *
 * In dev mode the app loads over http://localhost, so the PWA plugin's
 * dev behavior applies (service worker registration is disabled by default
 * there) — the desktop flag still skips the landing page.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// Under plain Node, requiring "electron" resolves to the electron binary path.
const electronExe = require("electron");

const PORT = 5188;
const DEV_URL = `http://localhost:${PORT}/`;
const root = fileURLToPath(new URL("..", import.meta.url));

let vite = null;
let electron = null;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  electron?.kill();
  vite?.kill();
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function spawnNode(args, { name, env = {}, onLine, onExit } = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pipe = (stream, passthrough) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) onLine?.(line);
      passthrough.write(chunk);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (!shuttingDown) onExit?.(code ?? 1);
  });
  return child;
}

const pendingLineChecks = new Set();
function awaitLine(pattern, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const check = (line) => {
      if (!pattern.test(line)) return;
      clearTimeout(timeout);
      pendingLineChecks.delete(check);
      resolve();
    };
    const timeout = setTimeout(() => {
      pendingLineChecks.delete(check);
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
    pendingLineChecks.add(check);
  });
}

vite = spawnNode(["node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort"], {
  name: "vite",
  onLine: (line) => {
    for (const check of [...pendingLineChecks]) check(line);
  },
  onExit: (code) => {
    console.error(`[vite] exited unexpectedly (code ${code}) — shutting down`);
    shutdown(1);
  },
});

try {
  await awaitLine(/^Local:\s+/im, 30_000, "the Vite dev server (Local: …)");
} catch (error) {
  console.error(error.message);
  shutdown(1);
}

console.log(`\nKYX desktop → ${DEV_URL}\n`);
electron = spawnNode([electronExe, "desktop/main.cjs"], {
  name: "electron",
  env: { KYX_DEV_URL: DEV_URL },
  onExit: (code) => shutdown(code),
});
