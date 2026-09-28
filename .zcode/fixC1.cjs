const fs = require("node:fs");
const path = "src/intent/semantic-conditioning.ts";
let src = fs.readFileSync(path, "utf8");

if (src.includes("primeSemanticForText")) {
  console.log("OK: primeSemanticForText already present");
  process.exit(0);
}

const anchor = `export function semanticConditioningForIntent(`;

if (!src.includes(anchor)) {
  console.error("FAIL: semanticConditioningForIntent anchor not found");
  process.exit(1);
}

const addition = `/**
 * Prime the semantic channel for a text the parser has just seen, without
 * waiting for the generation request (fix C).
 *
 * WHY: the intent flow parses text, then the provider asks for conditioning
 * only once it reaches the prior. Between those two points the groove is
 * resolved and the whole candidate bank is built, so the ~118 MB model is
 * still loading when the one call that needs it arrives. Priming here starts
 * the load at PARSE time, so by the time the provider asks, the model is
 * already resident.
 *
 * This is the same fire-and-forget shape as the boot warmup; it just happens
 * earlier and with the real text, which additionally memoises the projection
 * that the provider will later look up. A repeated parse of the same text
 * therefore costs nothing: the projection cache is keyed on the trimmed text.
 *
 * Never throws and never awaits. The provider still calls
 * \`semanticConditioningForIntent\` on the normal path, so a primed cache is
 * an optimisation, never a correctness dependency.
 */
export function primeSemanticForText(
  text: string | null | undefined,
  artist?: ArtistProfile | null,
): void {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return;
  // Defer so the worker spawn never blocks the parse caller's turn.
  setTimeout(() => {
    void semanticConditioning(trimmed, undefined, artist ?? null).catch(() => null);
  }, 0);
}

/** Resolve the parsed artist preset and pass its curated signature to the
 * embedding conditioner. Keeping this at the intent boundary means every
 * provider gets the same artist + user-text blend instead of silently
 * dropping artist identity before the semantic prior. */
export function semanticConditioningForIntent(`;

src = src.replace(anchor, addition);
fs.writeFileSync(path, src, "utf8");
console.log("OK: primeSemanticForText added");
