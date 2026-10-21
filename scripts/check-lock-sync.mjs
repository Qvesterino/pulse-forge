#!/usr/bin/env node
/**
 * check-lock-sync.mjs — proves the committed lockfile is still in sync with
 * package.json under the SAME peer-dependency policy CI runs with.
 *
 * Why this exists: the lockfile was generated on a machine whose user-level
 * .npmrc set `legacy-peer-deps=true`. With that flag npm does not enforce peer
 * ranges, so the lock pinned `electron-builder-squirrel-windows@26.15.3` while
 * `app-builder-lib@26.17.0` declares a peer dependency on exactly `26.17.0`.
 * A plain `npm ci` — no flags, no personal .npmrc, exactly what CI runs —
 * rejected that lock:
 *
 *   npm error code EUSAGE
 *   npm error Invalid: lock file's electron-builder-squirrel-windows@26.15.3
 *   npm error does not satisfy electron-builder-squirrel-windows@26.17.0
 *
 * and aborted in ~3 seconds, in every job, for 134 consecutive CI runs.
 *
 * The repository now pins the policy in its own .npmrc, and this script proves
 * the lock still matches it — BEFORE a lockfile change reaches CI, where the
 * only feedback is a red job and a log behind a login.
 *
 * `--dry-run` never touches node_modules; `--ignore-scripts` keeps lifecycle
 * scripts (the electron binary download) out of the check.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

if (!existsSync(path.join(ROOT, "package-lock.json"))) {
  console.error("deps:check — package-lock.json is missing; nothing to verify.");
  process.exit(1);
}

const result = spawnSync(
  NPM,
  ["ci", "--dry-run", "--ignore-scripts", "--legacy-peer-deps=false", "--no-audit", "--no-fund"],
  {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  },
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

if (result.status === 0) {
  const added = /added (\d+) packages/.exec(output);
  console.log(
    `deps:check — the committed lockfile is in sync with package.json under legacy-peer-deps=false` +
      (added ? ` (${added[1]} packages resolved).` : "."),
  );
  process.exit(0);
}

console.error("deps:check — the committed lockfile is NOT in sync with package.json.");
console.error("npm rejected `npm ci --dry-run --legacy-peer-deps=false`. Its own words:");
console.error(
  output
    .split("\n")
    .filter((line) => /npm error/i.test(line))
    .slice(0, 20)
    .join("\n"),
);
console.error("");
console.error("Fix it with the tool that owns the lockfile, under the policy the repo declares:");
console.error("  npm install --package-lock-only --legacy-peer-deps=false");
console.error("then re-run: npm run deps:check");
process.exit(1);
