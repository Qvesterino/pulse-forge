import { EFFECT_META } from "../src/effects/definitions";
const kit = ["eq", "compressor", "saturation", "delay", "reverb"];
let tot = 0;
console.log("Pocet ParamDef z realneho importu:\n");
for (const t of kit) {
  const n = EFFECT_META[t].params.length;
  tot += n;
  console.log("  " + EFFECT_META[t].name.padEnd(14) + String(n).padStart(3) + "  " + EFFECT_META[t].params.map((p) => p.id).join(", "));
}
console.log("\n  SPOLU: " + tot + " parametrov");
