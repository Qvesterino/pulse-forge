const fs = require("node:fs");
const path = "src/intent/production.ts";
let src = fs.readFileSync(path, "utf8");

const old = `        case "sidechain":
          // amount is a 0..1 BLEND, not a depth: the duck depth comes
          // from threshold + ratio, and amount only decides how much of
          // that reduction is applied. attack/release are SECONDS.
          actions.push({
            trackId,
            type: "sidechain",
            params: {
              threshold: -18,
              ratio: Math.round(2 + goal.amount * 6),
              attack: 0.001,
              release: 0.18,
              amount: Math.min(1, 0.5 + goal.amount * 0.5),
              splitFreq: 180,
            },
            sidechainFromDrums: true,
          });
          break;`;

if (!src.includes(old)) {
  console.error("FAIL: sidechain case not found");
  process.exit(1);
}

// The "pump" effect is the one that already carries the drum-keyed
// sidechain wiring (its registry entry reads the drum track), and its
// params are amount / rate / release - a 1:1 mapping of the user's ask
// with no invented fields. "sidechain" the raw compressor would need a
// sidechainFromDrums field on ProductionAction that does not exist, and
// its amount is a blend of a threshold/ratio reduction the user never
// asked for.
const replacement = `        case "sidechain":
          // The PUMP effect, not the raw sidechain compressor: pump is the
          // one already keyed from the drum track by the registry, and its
          // amount / rate / release map 1:1 onto the ask with no invented
          // fields. The sidechain compressor's amount is a blend of a
          // threshold+ratio reduction, which is not what "pumping" means.
          actions.push({
            trackId,
            type: "pump",
            params: {
              amount: Math.min(1, 0.4 + goal.amount * 0.6),
              rate: Math.round(0.4 + goal.amount * 1.6),
              release: Math.round(120 + goal.amount * 220),
            },
          });
          break;`;

src = src.replace(old, replacement);
fs.writeFileSync(path, src, "utf8");
console.log("OK: sidechain -> pump");
