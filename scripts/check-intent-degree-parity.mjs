#!/usr/bin/env node
/**
 * Cross-engine degree parity check.
 *
 * KYX and VocalForge both speak the seven-level modifier language. This script
 * parses the canonical contract in KYX and the `DEGREE_BANDS` in VocalForge's
 * `graduatedDegree.ts`, then checks every SHARED word resolves to the same
 * level. KYX-only words are marked `extension: true` in the contract and are
 * reported informationally, not as failures.
 *
 * Run: npm run intent:degree-parity
 * Exits 0 when the VocalForge checkout is absent (CI without the sibling repo).
 */
import { existsSync, readFileSync } from "node:fs";

const CONTRACT = "src/intent/semantics/degree-contract.ts";
const VOCALFORGE = "D:/VocalForge_DAW/packages/soloflow-command/src/graduatedDegree.ts";

function readRequired(path) {
  if (!existsSync(path)) {
    console.error(`missing ${path}`);
    process.exit(2);
  }
  return readFileSync(path, "utf8");
}

const contractSource = readRequired(CONTRACT);
const contract = [
  ...contractSource.matchAll(/\{\s*word:\s*"([^"]+)",\s*level:\s*(\d)(?:,\s*extension:\s*true)?\s*\}/g),
].map((match) => ({
  word: match[1],
  level: Number(match[2]),
  extension: /extension:\s*true/.test(match[0]),
}));

if (contract.length === 0) {
  console.error("could not parse any contract words");
  process.exit(2);
}

if (!existsSync(VOCALFORGE)) {
  console.log(`skip: ${VOCALFORGE} not present (KYX-only checkout)`);
  process.exit(0);
}

const vfSource = readFileSync(VOCALFORGE, "utf8");
const bands = [...vfSource.matchAll(/level:\s*(\d+),\s*words:\s*\/((?:\\.|[^/])+)\/g,/g)].map((match) => ({
  level: Number(match[1]),
  regex: new RegExp(match[2], "i"),
}));

if (bands.length !== 7) {
  console.error(`expected 7 VocalForge degree bands, parsed ${bands.length}`);
  process.exit(2);
}

let failed = 0;
const rows = [];
for (const entry of contract) {
  const withMatches = bands
    .map((band) => ({ level: band.level, hit: band.regex.exec(entry.word) }))
    .filter((band) => band.hit != null);
  // "as much as possible" also contains the L5 token "much"; the full-phrase
  // match is the specific band, so prefer a match that spans the whole word.
  const full = withMatches.find((band) => band.hit[0].toLowerCase() === entry.word.toLowerCase());
  const chosen = full ?? (withMatches.length === 1 ? withMatches[0] : null);
  const vfLevel = chosen ? chosen.level : withMatches.length === 0 ? null : "ambiguous";
  const same = vfLevel === entry.level;
  const status = entry.extension
    ? same
      ? "extension (agrees)"
      : vfLevel === null
        ? "extension (KYX-only)"
        : `extension (VF says ${vfLevel})`
    : same
      ? "ok"
      : `DIVERGED (VF says ${vfLevel ?? "nothing"})`;
  if (!entry.extension && !same) failed += 1;
  rows.push({ word: entry.word, kyx: entry.level, vf: vfLevel ?? "-", status });
}

const width = Math.max(...rows.map((row) => row.word.length), 4);
console.log(`${"word".padEnd(width)}  KYX  VF   status`);
for (const row of rows) {
  console.log(`${row.word.padEnd(width)}  ${String(row.kyx).padEnd(3)}  ${String(row.vf).padEnd(3)}  ${row.status}`);
}

console.log(
  `\n${contract.filter((entry) => !entry.extension).length} shared words, ${failed} divergence(s); ` +
    `${contract.filter((entry) => entry.extension).length} KYX extension(s).`,
);
process.exit(failed === 0 ? 0 : 1);
