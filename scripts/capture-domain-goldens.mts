/**
 * GOAL 06 — capture domain-golden fixtures.
 *
 * Regenerates `tests/domain-goldens/*.json` from the current engine via the
 * shared harness (`tests/domain-goldens/harness.ts`). Run after an
 * INTENTIONAL behavior change and review the diff like code — the fixtures
 * are the parity contract for future platform implementations.
 *
 * `decode-goldens.json` (backward-compatibility share codes) is PRESERVED:
 * the script only creates it on first run; it must never be regenerated.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { buildFamilies, canonicalize } from "../tests/domain-goldens/harness";
import { canonicalShareDoc } from "../tests/domain-goldens/harness";
import { encodeShareCode } from "../src/export/shareCode";

const OUT_DIR = resolve(process.cwd(), "tests/domain-goldens");
const DECODE_FILE = resolve(OUT_DIR, "decode-goldens.json");

mkdirSync(OUT_DIR, { recursive: true });

// Decode pins: create once, then preserve forever (backward compatibility).
let decodeGoldens: Array<{ label: string; code: string }>;
if (existsSync(DECODE_FILE)) {
  decodeGoldens =
    (JSON.parse(readFileSync(DECODE_FILE, "utf8")) as { pins: Array<{ label: string; code: string }> }).pins ?? [];
  console.log(`decode-goldens.json preserved (${decodeGoldens.length} pins)`);
} else {
  const doc = canonicalShareDoc();
  decodeGoldens = [{ label: "house-canonical-v1", code: encodeShareCode(doc) }];
  writeFileSync(DECODE_FILE, JSON.stringify({ pins: decodeGoldens }, null, 2) + "\n");
  console.log("decode-goldens.json created (first capture)");
}

for (const family of buildFamilies(decodeGoldens)) {
  const file = resolve(OUT_DIR, family.file);
  const payload = { meta: family.meta, cases: family.cases.map((c) => canonicalize(c)) };
  writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
  console.log(`captured ${family.file} (${family.cases.length} cases)`);
}

void dirname;
