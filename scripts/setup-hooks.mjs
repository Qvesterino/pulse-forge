#!/usr/bin/env node
// setup-hooks.mjs — installs the pre-commit hook into .git/hooks/pre-commit
// Runs automatically via the "prepare" npm script (after `npm ci`/`npm install`).
// No external dependencies — just Node + the file system.
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const hookDir = join(repoRoot, ".git", "hooks");
const hookPath = join(hookDir, "pre-commit");

const hook = `#!/bin/sh
# pre-commit — installed by scripts/setup-hooks.mjs (npm run prepare)
# Catches cross-agent type regressions locally before they reach CI.
set -e
echo "[pre-commit] typecheck:clean…"
npm run typecheck:clean --silent
echo "[pre-commit] prettier --check…"
npx --yes prettier --check "src/**/*.{ts,tsx}" "tests/**/*.{ts,tsx}" --ignore-unknown 2>&1 | head -40
echo "[pre-commit] ok"
`;

if (!existsSync(hookDir)) mkdirSync(hookDir, { recursive: true });
writeFileSync(hookPath, hook.replace(/\r\n/g, "\n"), "utf8");
try { chmodSync(hookPath, 0o755); } catch {}
console.log(`[setup-hooks] installed ${hookPath}`);
