import { readFileSync, writeFileSync } from "node:fs";
const p = "docs/CURRENT-STATE.md";
const lines = readFileSync(p, "utf8").split("\n");
const i = lines.findIndex((l) => l.includes("kit multiview (five devices, live)"));
if (i < 0) { console.error("anchor not found"); process.exit(1); }
lines[i] = lines[i].replace(
  "Locked by `tests/effects-essential-kit.test.ts`",
  "The EQ column additionally paints a **response curve** (`src/effects/eqCurve.ts` + `src/ui/EqCurveCanvas.tsx`) instead of four bare sliders. `eqCurve` is an OFFLINE transcription of the worklet's own arithmetic, not `BiquadFilterNode`: `eq-processor.js` deliberately uses PARALLEL shelves and a bilinear Q pre-correction so both shelf ends land exactly on 0 dB and +/-G, and a BiquadFilter response would draw a curve that is close to, but not, the one the track is processing. That would be worse than no curve. Locked by `tests/effects-eq-curve.test.ts` (15/15, asserting the physics: flat passband, 3 dB at each HP/LP corner, a +12 dB shelf that does NOT droop to +7 at 20 kHz) + `tests/effects-essential-kit.test.ts`",
);
writeFileSync(p, lines.join("\n"), "utf8");
console.log("updated:", lines[i].slice(0, 90));
