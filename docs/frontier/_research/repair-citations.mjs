#!/usr/bin/env node
// Repair the drifted repository citations in the AAW frontier documents.
//
// WHY: the frontier program cites repository facts as `path:line`. A line
// number is a CLAIM that a specific piece of code is at a specific place,
// and it rots the moment anything above it changes. Two implementation waves
// (ZYVO T0/T1) and the peer's authorization work moved the cited code.
//
// The replacements below are NOT guesses: every old range and every new range
// was read out of the live source before this script ran.
//
// Usage: node docs/frontier/_research/repair-citations.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const frontierDir = new URL("../aaw/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const REPLACEMENTS = [
  // (old, new, why)
  [
    "toolExecution.ts:500-508,1093-1126",
    "authorization.ts:85-106, toolExecution.ts:1141-1179",
    "the allowlist moved into authorization.ts (AUTO_APPLY_CAPABILITIES); the autonomy branch moved down",
  ],
  [
    "toolExecution.ts:500-508",
    "authorization.ts:85-106",
    "the allowlist now lives in authorization.ts (AUTO_APPLY_CAPABILITIES / SAFE_AUTO_APPLY_COMMANDS)",
  ],
  [
    "toolExecution.ts:1093-1126",
    "toolExecution.ts:1141-1179",
    "the graduated-autonomy branch moved down (the show lock added lines above it)",
  ],
  [
    "agentVoiceManager.ts:5638-5648",
    "agentVoiceManager.ts:5671-5679",
    "the write-boundary comment moved down (the auto-apply wiring added lines above it)",
  ],
  [
    "command-core/src/registry.ts:43-46",
    "command-core/src/registry.ts:51-58",
    "the comment was CORRECTED (commit ab0076c2) and moved",
  ],
  ["zyx-transfer.ts:275", "src/export/zyvo-transfer.ts:275", "filename typo: the file is src/export/zyvo-transfer.ts"],
  // ── bare filenames that are ambiguous in a two-repo world ────────────────
  // Each of these exists under several names; a reader cannot resolve it.
  [
    "definitions.ts:331-343",
    "src/effects/definitions.ts:331-343",
    "bare filename: two files named definitions.ts exist",
  ],
  ["schema.ts:62", "src/project-model/schema.ts:62", "bare filename: two files named schema.ts exist"],
  ["types.ts:1", "src/project-model/types.ts:1", "bare filename: 38 files named types.ts exist"],
  [
    "crashJournal.ts:32-60",
    "src/persistence/crashJournal.ts:32-60",
    "bare filename: two files named crashJournal.ts exist (KYX and ZYVO)",
  ],
  [
    "authorization.ts:85-106",
    "packages/agent-runtime/src/audioTools/authorization.ts:85-106",
    "bare filename: two files named authorization.ts exist",
  ],
  ["registry.ts:3936-3993", "src/effects/registry.ts:3936-3993", "bare filename: seven files named registry.ts exist"],
];

let totalEdits = 0;
for (const file of readdirSync(frontierDir).filter((f) => f.endsWith(".md"))) {
  const path = join(frontierDir, file);
  let text = readFileSync(path, "utf8");
  const original = text;
  const applied = [];
  for (const [oldStr, newStr, why] of REPLACEMENTS) {
    if (!text.includes(oldStr)) continue;
    const count = text.split(oldStr).length - 1;
    text = text.split(oldStr).join(newStr);
    applied.push(`${count}× "${oldStr}" -> "${newStr}" (${why})`);
    totalEdits += count;
  }
  if (text !== original) {
    writeFileSync(path, text, "utf8");
    console.log(`${file}:`);
    for (const a of applied) console.log(`   ${a}`);
  }
}
console.log(`\ntotal replacements: ${totalEdits}`);
