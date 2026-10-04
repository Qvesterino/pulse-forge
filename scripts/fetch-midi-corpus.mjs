/**
 * W2 — fetch the Public Domain MIDI corpus (replayable, no Python).
 *
 * Source: Defiance99/midi-catalog (GitHub Pages) — a catalog + MIDI mirror of
 * the Mutopia Project (sheet music typeset in LilyPond by volunteers, each
 * piece under its own license; we ingest ONLY `license === "Public Domain"`).
 * Every file is SHA-1 verified against catalog.json.
 *
 * Writes (gitignored — deterministic, re-fetchable):
 *   scripts/data/midi-corpus/midi/*.mid
 *   scripts/data/midi-corpus/manifest.json   (catalog slice: license, sha1, sourceUrl)
 *
 * The manifest itself is COMMITTED as the license audit trail
 * (docs/intent-killer-feature-plan.md W2: "no data without provenance").
 *
 * Run: node scripts/fetch-midi-corpus.mjs
 */
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = "https://defiance99.github.io/midi-catalog/";
const OUT = path.resolve("scripts", "data", "midi-corpus");
const MIDI_DIR = path.join(OUT, "midi");

const catalogResponse = await fetch(`${BASE}catalog.json`);
if (!catalogResponse.ok) throw new Error(`catalog fetch failed: ${catalogResponse.status}`);
const catalog = await catalogResponse.json();
const pieces = (catalog.pieces ?? []).filter((p) => p.license === "Public Domain");
console.log(`[midi-corpus] catalog: ${catalog.pieces?.length ?? 0} pieces, ${pieces.length} Public Domain`);

mkdirSync(MIDI_DIR, { recursive: true });
let ok = 0;
const failed = [];
for (const piece of pieces) {
  const name = path.basename(piece.file);
  const dest = path.join(MIDI_DIR, name);
  if (existsSync(dest) && dest.length > 0) {
    ok++;
    continue;
  }
  try {
    const response = await fetch(`${BASE}${piece.file}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = createHash("sha1").update(bytes).digest("hex");
    if (piece.sha1 && digest !== piece.sha1) throw new Error(`sha1 mismatch: ${digest.slice(0, 12)}`);
    writeFileSync(dest, bytes);
    ok++;
    if (ok % 50 === 0) console.log(`  ${ok}/${pieces.length} fetched…`);
  } catch (error) {
    failed.push(`${piece.id}: ${error.message}`);
  }
}

writeFileSync(
  path.join(OUT, "manifest.json"),
  JSON.stringify(
    {
      source: "Defiance99/midi-catalog (GitHub Pages)",
      upstream: "Mutopia Project — sheet music typeset in LilyPond by volunteers",
      upstreamUrl: "https://www.mutopiaproject.org/",
      fetchedAt: new Date().toISOString().slice(0, 10),
      licenseFilter: "Public Domain",
      pieces,
    },
    null,
    2,
  ),
);
console.log(`[midi-corpus] fetched ${ok}/${pieces.length}, failed ${failed.length}`);
if (failed.length) console.log(`[midi-corpus] failures:\n  ${failed.join("\n  ")}`);
if (ok === 0) process.exit(1);