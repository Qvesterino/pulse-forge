#!/usr/bin/env node
/**
 * Generate public/worklets-manifest.json: logical worklet filename -> SHA-256.
 *
 * Runs LAST in predev/prebuild, after every worklet bundle has been written.
 * The loader appends `?v=<hash>` to addModule URLs so a CDN/HTTP cache or a
 * shell without the service worker cannot pair an old bundle with a new app.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const publicDir = resolve(process.cwd(), "public");
const assets = {};
for (const name of readdirSync(publicDir)) {
  if (!name.endsWith("-worklet.js")) continue;
  const bytes = readFileSync(join(publicDir, name));
  assets[name] = createHash("sha256").update(bytes).digest("hex");
}
const names = Object.keys(assets).sort();
if (!names.length) throw new Error("no *-worklet.js bundles found in public/");
const sorted = Object.fromEntries(names.map((name) => [name, assets[name]]));
writeFileSync(
  join(publicDir, "worklets-manifest.json"),
  `${JSON.stringify({ version: 1, assets: sorted }, null, 2)}\n`,
  "utf8",
);
console.log(`[worklet-manifest] ${names.length} bundles hashed`);
