/**
 * Golden Doctor — `npm run goldens:doctor [-- --bless]`
 *
 * Recomputes every doctor-covered frozen artifact (multi-voice identity hashes,
 * AI correctness-1 baseline) and prints the SEMANTIC diff next to the hash, so
 * a re-pin is reviewable evidence instead of an opaque hash swap.
 *
 * `--bless` refreshes `tests/fixtures/multivoice-golden.summaries.json`, the
 * committed record of what each voice hash covers. Review that diff (printed
 * before the write) together with the hash change; the summaries are what make
 * the NEXT re-pin readable.
 *
 * Exit code is always 0: this is a diagnostic. The enforcing gates are the
 * artifact specs themselves (multivoice-golden, ai-baseline, golden-doctor).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectGoldenDoctor,
  collectVoiceSummaries,
  diffRecords,
  formatGoldenDoctor,
  type VoiceSummaryFile,
} from "../tests/helpers/golden-doctor";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUMMARIES_PATH = resolve(ROOT, "tests/fixtures/multivoice-golden.summaries.json");

function readSummaries(): VoiceSummaryFile | null {
  try {
    return JSON.parse(readFileSync(SUMMARIES_PATH, "utf8")) as VoiceSummaryFile;
  } catch {
    return null;
  }
}

// npm's own arg parser eats `--bless` on some versions (it warns "Unknown cli
// config"), so the flag is detected leniently and an env var is the fallback:
//   npm run goldens:doctor -- --bless      (works on npm 10)
//   GOLDEN_DOCTOR_BLESS=1 npm run goldens:doctor
const bless = process.argv.some((arg) => arg.includes("bless")) || process.env.GOLDEN_DOCTOR_BLESS === "1";
const summaries = readSummaries();
const cases = collectGoldenDoctor(summaries);
console.log(formatGoldenDoctor(cases));

if (bless) {
  const current = collectVoiceSummaries();
  const previous = summaries;
  if (previous) {
    for (const entry of current.cases) {
      const before = previous.cases.find((item) => item.caseId === entry.caseId)?.summary;
      if (!before) continue;
      const diffs = diffRecords(
        before as unknown as Record<string, unknown>,
        entry.summary as unknown as Record<string, unknown>,
      );
      if (diffs.length > 0) {
        console.log(
          `bless: ${entry.caseId} summary change — ` +
            diffs.map((diff) => `${diff.field} ${String(diff.from)} → ${String(diff.to)}`).join(", "),
        );
      }
    }
  }
  mkdirSync(dirname(SUMMARIES_PATH), { recursive: true });
  writeFileSync(SUMMARIES_PATH, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  console.log(`blessed ${current.cases.length} voice summaries → ${SUMMARIES_PATH}`);
}

const changed = cases.filter((item) => item.hashChanged).length;
const drifted = cases.filter((item) => !item.hashChanged && item.diffs.length > 0).length;
console.log(
  changed === 0 && drifted === 0
    ? "goldens:doctor — SAFE (no hash or summary drift)"
    : `goldens:doctor — REVIEW (${changed} hash change(s), ${drifted} semantic drift(s))`,
);
