const fs = require("node:fs");
const path = "src/intent/providers/symbolic.ts";
let src = fs.readFileSync(path, "utf8");

if (src.includes("semantic-unavailable")) {
  console.log("OK: already tagged");
  process.exit(0);
}

const anchor = `        if (pads.length > 0 && (supportsDrumPrior || semantic)) {`;

if (!src.includes(anchor)) {
  console.error("FAIL: gate anchor not found");
  process.exit(1);
}

// Insert the diagnostic BEFORE the gate so the "skipped entirely" case is
// recorded, not just the "entered but failed" case.
const insertion = `        if (pads.length > 0 && !(supportsDrumPrior || semantic)) {
          // Measured 2026-09-28: PRIOR_STYLE_VOCAB covers 21 of 170 library
          // grooves, so 88% of generations arrive here out-of-vocab. The only
          // thing that can save them is the v3 semantic channel, and it is
          // unavailable exactly when the model is cold, opted out by device
          // memory, or the embed worker is down.
          //
          // Before this tag the outcome was indistinguishable from success:
          // the drums came from the template, the provider returned a valid
          // pattern, and the UI said "generated". Naming the reason is what
          // makes the coverage gap diagnosable instead of invisible.
          failures.push(
            \`candidate-\${startIndex + offset}:drums-template-\${semantic ? "prior-vocab-miss" : "semantic-unavailable"}\`,
          );
        }
${anchor}`;

src = src.replace(anchor, insertion);
fs.writeFileSync(path, src, "utf8");
console.log("OK: semantic-unavailable / prior-vocab-miss tagged");
