const fs = require("node:fs");
const path = "src/ai/semantic/semantic-client.ts";
let src = fs.readFileSync(path, "utf8");

if (src.includes("export function warmSemanticModel")) {
  console.log("OK: warmSemanticModel already present");
  process.exit(0);
}

const anchor = `/** Test/diagnostic hook. */
export function resetSemanticClient(): void {`;

if (!src.includes(anchor)) {
  console.error("FAIL: resetSemanticClient anchor not found");
  process.exit(1);
}

const addition = `/**
 * Warm the ~118 MB MiniLM model in the background.
 *
 * WHY THIS EXISTS — measured 2026-09-28: PRIOR_STYLE_VOCAB holds 21 of the
 * 170 grooves in the library, so 88% of generated drums cannot use the v1
 * one-hot prior. The v3 semantic channel is the escape hatch (the provider
 * gates on \`(supportsDrumPrior || semantic)\`), but the FIRST embedTexts()
 * call pays the whole 118 MB load on its request budget. A user who types an
 * intent within seconds of opening the app therefore gets semantic=null and
 * silently falls back to template drums on exactly the run where it matters.
 *
 * Called fire-and-forget at boot so the load overlaps project opening instead
 * of the first intent. The warmup text is a throwaway sentence: the goal is
 * to make the model RESIDENT, not to produce a useful vector.
 *
 * Best-effort by design. Never throws, never blocks boot, and honours both the
 * \`pf:semantic-embed\` flag and the mobile deviceMemory opt-out, so a device
 * that would refuse the feature at request time also never pays this download.
 */
export function warmSemanticModel(): void {
  // Defer past the current task so the worker spawn never competes with the
  // boot path's own work (project load, bank decode, audio graph construction).
  setTimeout(() => {
    // A throwaway sentence is enough to force the load; the vector is discarded.
    void embedTexts(["warm up"]).catch(() => undefined);
  }, 0);
}

/** Test/diagnostic hook. */
export function resetSemanticClient(): void {`;

src = src.replace(anchor, addition);
fs.writeFileSync(path, src, "utf8");
console.log("OK: warmSemanticModel added to semantic-client.ts");
