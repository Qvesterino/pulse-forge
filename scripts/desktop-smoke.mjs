/**
 * Launch the KYX desktop shell in smoke mode over the existing `dist/`
 * build (run `npm run desktop:build` or a plain `npm run build` first).
 * The shell itself performs the checks — renderer mounted over app://,
 * no console/preload/render errors — and exits 0/1; this script just
 * forwards the exit code.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronExe = require("electron");
const root = fileURLToPath(new URL("..", import.meta.url));

if (!existsSync(path.join(root, "dist", "index.html"))) {
  console.error("dist/index.html not found — run `npm run desktop:build` (or `npm run build`) first.");
  process.exit(1);
}

const child = spawn(electronExe, ["desktop/main.cjs"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, KYX_SMOKE: "1" },
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
