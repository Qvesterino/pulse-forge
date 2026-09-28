const fs = require("node:fs");
const path = "src/intent/text-parser.ts";
let src = fs.readFileSync(path, "utf8");

if (src.includes("primeSemanticForText")) {
  console.log("OK: already wired");
  process.exit(0);
}

const anchor = `  const input: IntentInput = { text };`;

if (!src.includes(anchor)) {
  console.error("FAIL: input anchor not found");
  process.exit(1);
}

const replacement = `  const input: IntentInput = { text };

  // Prime the semantic embedding channel now (fix C) rather than waiting for
  // the provider to ask. Between parse and generate the groove is resolved and
  // the whole candidate bank is built, so the ~118 MB model would still be
  // loading when the one call that needs it arrives — and 88% of grooves are
  // outside PRIOR_STYLE_VOCAB, so the v3 channel is the only thing keeping
  // those runs off the template fallback. Fire-and-forget; the provider still
  // calls semanticConditioningForIntent on the normal path, so this is purely
  // a head start, never a correctness dependency.
  primeSemanticForText(text);`;

src = src.replace(anchor, replacement);

// Lazy import at the top of the module would drag the whole semantic client
// into the landing-route static closure, which is exactly what the client
// itself avoids. A dynamic import inside the call site keeps it lazy.
const dynImport = `  void import("./semantic-conditioning")
    .then((module) => module.primeSemanticForText(text))
    .catch(() => undefined);`;

src = src.replace(
  `  primeSemanticForText(text);`,
  `  // Lazy: a static import would pull the semantic client into the landing\n  // route's static closure, which the client itself is built to avoid.\n${dynImport}`,
);

fs.writeFileSync(path, src, "utf8");
console.log("OK: parseIntentText primes the semantic channel");
