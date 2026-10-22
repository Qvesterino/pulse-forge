#!/usr/bin/env node
/**
 * Cross-engine CALIBRATION parity check.
 *
 * KYX (`src/intent/semantics/calibration.ts`) and the shared
 * `@vocalforge/param-calibration` package must use the same six-step family
 * ladders. They live in different repositories, so this script reads both
 * sources and compares the numbers directly. Run:
 *
 *   npm run intent:calibration-parity
 *
 * Exits 0 when the VocalForge checkout is absent.
 */
import { existsSync, readFileSync } from "node:fs";

const KYX = "src/intent/semantics/calibration.ts";
const SHARED = "D:/VocalForge_DAW/packages/param-calibration/src/index.ts";

function read(path) {
  if (!existsSync(path)) {
    console.error(`missing ${path}`);
    process.exit(2);
  }
  return readFileSync(path, "utf8");
}

const kyx = read(KYX);
const numbers = (match) => (match ? match[1].split(",").map((value) => Number(value.trim())) : null);

const kyxFamilies = {
  db: numbers(/db:\s*\[([^\]]+)\]/.exec(kyx)),
  time: numbers(/time:\s*\[([^\]]+)\]/.exec(kyx)),
  frequency: numbers(/frequency:\s*\[([^\]]+)\]/.exec(kyx)),
  q: numbers(/q:\s*\[([^\]]+)\]/.exec(kyx)),
  percent: numbers(/percent:\s*\[([^\]]+)\]/.exec(kyx)),
  normalized: numbers(/normalized:\s*\[([^\]]+)\]/.exec(kyx)),
};

if (Object.values(kyxFamilies).some((steps) => steps == null || steps.length !== 6)) {
  console.error(`could not parse KYX calibration families from ${KYX}`);
  process.exit(2);
}

if (!existsSync(SHARED)) {
  console.log(`skip: ${SHARED} not present (KYX-only checkout)`);
  process.exit(0);
}

const shared = read(SHARED);
const sharedFamilies = {};
for (const match of shared.matchAll(/family:\s*"([^"]+)",\s*steps:\s*\[([^\]]+)\]/g)) {
  sharedFamilies[match[1]] = numbers([null, match[2]]);
}
sharedFamilies.normalized = numbers(/const normalizedSteps: RelativeStep = \[([^\]]+)\]/.exec(shared));

// The host names two families differently; the numbers must be identical.
const aliases = { time: "time-ms", q: "q-factor" };
let failed = 0;
console.log("family        KYX                              shared");
for (const [kyxName, kyxSteps] of Object.entries(kyxFamilies)) {
  const sharedName = aliases[kyxName] ?? kyxName;
  const sharedSteps = sharedFamilies[sharedName];
  const same =
    Array.isArray(sharedSteps) &&
    sharedSteps.length === kyxSteps.length &&
    sharedSteps.every((value, index) => Math.abs(value - kyxSteps[index]) < 1e-12);
  if (!same) failed += 1;
  console.log(
    `${kyxName.padEnd(12)} ${JSON.stringify(kyxSteps).padEnd(32)} ${JSON.stringify(sharedSteps ?? null)} ${same ? "ok" : "DIVERGED"}`,
  );
}

console.log(`\n${Object.keys(kyxFamilies).length} families, ${failed} divergence(s).`);
process.exit(failed === 0 ? 0 : 1);
