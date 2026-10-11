import { testDoc } from "../tests/fixtures/doc";
import { parseIntentText } from "../src/intent/text-parser";
import { normalizeIntent } from "../src/intent/normalize";
import { generateLocalResult } from "../src/intent/pipeline";

const brief = "dark rolling techno at 140 with lead";
const doc = testDoc();
const parsed = parseIntentText(brief);
const input = normalizeIntent({ ...parsed.input, candidateCount: 3, seed: "gate-explicit BPM + genre" });
const result = generateLocalResult(doc, input, "apply");
console.log("status:", result.status);
console.log("proposal:", result.proposal ? `defined (${result.proposal.status})` : "undefined");
console.log("errors:", JSON.stringify(result.diagnostics.errors));
console.log("fallbackReason:", result.diagnostics.fallbackReason ?? "none");
console.log("bank:", result.bank?.length ?? "n/a");
