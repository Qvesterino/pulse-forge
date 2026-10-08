import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  PREFERENCE_LEDGER_CAP,
  isPreferenceFeatureVersion,
  isValidPreferenceObservation,
} from "../src/intent/preference-ledger-core";
import { PRODUCER_MEMORY_EVENT_CAP, sanitizeProducerMemoryEvent } from "../src/intent/producer-memory-core";
import { evaluatePersonalPreferences, evaluateProducerMemoryEvents } from "../src/intent/preference-evaluation";

const MAX_PACK_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  console.error(`[producer-dna-evaluate] ${message}`);
  process.exitCode = 2;
  throw new Error(message);
}

async function main(): Promise<void> {
  const filename = process.argv[2];
  if (!filename) {
    console.error("Usage: npm run producer-dna:evaluate -- <exported-ledger.json>");
    process.exitCode = 2;
    return;
  }

  const absolutePath = path.resolve(filename);
  const fileInfo = await stat(absolutePath).catch(() => null);
  if (!fileInfo?.isFile()) fail("the input path is not a readable file");
  if (fileInfo.size > MAX_PACK_BYTES) fail(`pack exceeds the ${MAX_PACK_BYTES}-byte safety cap`);

  const raw = await readFile(absolutePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("the input is not valid JSON");
  }
  if (!isRecord(parsed)) fail("expected a Producer DNA export object");

  if (parsed.schemaVersion === 1 && Array.isArray(parsed.events)) {
    if (parsed.events.length > PRODUCER_MEMORY_EVENT_CAP) {
      fail(`the events array exceeds the ${PRODUCER_MEMORY_EVENT_CAP}-record Producer Memory cap`);
    }
    const validEvents = parsed.events
      .map(sanitizeProducerMemoryEvent)
      .filter((event): event is NonNullable<typeof event> => event !== null);
    const report = evaluateProducerMemoryEvents(validEvents);
    console.log(
      JSON.stringify(
        {
          source: path.basename(absolutePath),
          schemaVersion: parsed.schemaVersion,
          rejectedInvalidEvents: parsed.events.length - validEvents.length,
          ...report,
        },
        null,
        2,
      ),
    );
    if (report.evaluatedComparisons === 0 && report.capturedScoreEvaluatedComparisons === 0) {
      console.error(
        "[producer-dna-evaluate] no holdout comparison could be scored yet; collect A/B choices with captured global/personal scores across distinct sessions or lineages",
      );
      process.exitCode = 2;
    }
    return;
  }

  if (parsed.version !== 1 || !isPreferenceFeatureVersion(parsed.featureVersion)) {
    fail("unsupported pack (expected a legacy preference-ledger v1 pack or Producer Memory schema v1)");
  }
  if (!Array.isArray(parsed.observations)) fail("the pack does not contain an observations array");
  if (parsed.observations.length > PREFERENCE_LEDGER_CAP) {
    fail(`the observations array exceeds the ${PREFERENCE_LEDGER_CAP}-record ledger cap`);
  }

  const valid = parsed.observations.filter(isValidPreferenceObservation);
  const report = evaluatePersonalPreferences(valid);
  console.log(
    JSON.stringify(
      {
        source: path.basename(absolutePath),
        featureVersion: parsed.featureVersion,
        rejectedInvalidObservations: parsed.observations.length - valid.length,
        ...report,
      },
      null,
      2,
    ),
  );
  if (report.evaluatedComparisons === 0 && report.capturedScoreEvaluatedComparisons === 0) {
    console.error(
      "[producer-dna-evaluate] no holdout comparison could be scored yet; collect A/B choices with captured global/personal scores",
    );
    process.exitCode = 2;
  }
}

try {
  await main();
} catch (error) {
  if (process.exitCode !== 2) {
    console.error(`[producer-dna-evaluate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
