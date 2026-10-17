/**
 * One-shot generator for the compatibility golden fixture (run once, then the
 * committed artifact is the proof — see docs/COMPATIBILITY.md):
 *
 *   npx vite-node scripts/make-sharecode-fixture.mts
 *
 * It encodes a default project with the CURRENT encoder and records the parts
 * of the decoded shape a future reader must still produce. NEVER regenerate
 * this fixture to make a failing test pass — the failure is the promise being
 * broken.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDefaultProject } from "../src/project-model/schema";
import { encodeShareCode } from "../src/export/shareCode";

const doc = createDefaultProject();
const code = encodeShareCode(doc);
const fixture = {
  format: "share-code.v1",
  note:
    "Golden share code, generated 2026-10-17 with encodeShareCode(createDefaultProject()). " +
    "tests/compatibility-golden.test.ts decodes it with the current code; deleting or regenerating it " +
    "removes the only proof that v1 share codes keep opening.",
  code,
  expected: {
    id: doc.id,
    name: doc.name,
    schemaVersion: doc.schemaVersion,
    bpm: doc.bpm,
    trackCount: doc.tracks.length,
    patternCount: doc.patterns.length,
    trackKinds: doc.tracks.map((track) => track.kind),
  },
};
const outDir = path.resolve("tests/fixtures/compatibility");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "share-code-v1.json");
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
console.log(`wrote ${outPath} (${code.length} chars, project "${doc.name}")`);
