/**
 * Vendor the Audiotool NEXUS validator WASM into public/audiotool-nexus/.
 *
 * The SDK loads its document validator two different ways. Under Node it
 * reads from disk with no help; in a browser it fetches it, using
 * VITE_WASM_ASSETS_PREFIX as the base. Without a vendored copy and that
 * prefix set, every createOfflineDocument() call fetches a URL that does
 * not exist, 404s, and takes the whole page down with it.
 *
 * Run after upgrading @audiotool/nexus:
 *   node scripts/vendor-audiotool-wasm.mjs
 */
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SRC = resolve(ROOT, "node_modules/@audiotool/nexus/dist");
const DEST = resolve(ROOT, "public/audiotool-nexus");

const FILES = ["document_validator.wasm", "wasm_exec.js"];

mkdirSync(DEST, { recursive: true });

for (const name of FILES) {
  const from = resolve(SRC, name);
  if (!existsSync(from)) {
    console.error(`[vendor-nexus-wasm] missing ${name} in ${SRC} — is @audiotool/nexus installed?`);
    process.exit(1);
  }
  const to = resolve(DEST, name);
  copyFileSync(from, to);
  console.log(`[vendor-nexus-wasm] ${basename(from)} -> public/audiotool-nexus/${name} (${(statSync(to).size / 1024).toFixed(0)} KB)`);
}

console.log(
  "[vendor-nexus-wasm] done. Make sure VITE_WASM_ASSETS_PREFIX=/audiotool-nexus/ is set in .env.local",
);
