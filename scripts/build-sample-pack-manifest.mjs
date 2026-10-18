#!/usr/bin/env node
/**
 * Generate public/samples/offline-pack.json (ADR 0051 mobile install diet).
 *
 * The app shell no longer precaches 270+ MB of WAVs. This manifest lists the
 * curated packs a user can explicitly download into the `kyx-samples` runtime
 * cache. Paths are root-absolute (the loader/asset base applies at fetch time)
 * and deterministic (sorted, no timestamps) so a rebuild does not churn.
 *
 * Excludes public/samples/vsco/** — local conversion output, not shipped.
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd(), "public", "samples");
const outFile = join(root, "offline-pack.json");

function wavFiles(dir, prefix) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".wav")) continue;
    const full = join(dir, entry.name);
    files.push({
      url: `/samples/${prefix}${entry.name}`,
      bytes: statSync(full).size,
    });
  }
  return files.sort((a, b) => a.url.localeCompare(b.url));
}

function pack(id, label, files) {
  return {
    id,
    label,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

const factoryFiles = wavFiles(root, "");
const pianoFiles = wavFiles(join(root, "piano"), "piano/");
const packs = [pack("factory", "Factory one-shots", factoryFiles), pack("piano", "Piano", pianoFiles)].filter(
  (entry) => entry.files.length > 0,
);

writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      version: 1,
      note: "Optional offline audio packs. Runtime-cached into kyx-samples; never precached at install.",
      packs,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(
  `[offline-pack] ${packs.map((entry) => `${entry.id}: ${entry.files.length} files / ${(entry.bytes / 1048576).toFixed(1)} MB`).join(", ")}`,
);
