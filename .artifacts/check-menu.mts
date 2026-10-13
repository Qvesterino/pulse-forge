import { EFFECT_META, EFFECT_ORDER } from "../src/effects/definitions";
import { CORE_EFFECT_ORDER, FLAGSHIP_EFFECT_ORDER, ADDITIONAL_EFFECT_GROUPS } from "../src/effects/registry";

const names = (list) => list.map((t) => EFFECT_META[t].name);
const menuOrder = [
  ...CORE_EFFECT_ORDER,
  ...FLAGSHIP_EFFECT_ORDER,
  ...ADDITIONAL_EFFECT_GROUPS.flatMap((g) => g.types),
];
const menuNames = names(menuOrder);
const metaNames = Object.values(EFFECT_META).map((m) => m.name);

console.log("EFFECT_META keys:      ", Object.keys(EFFECT_META).length);
console.log("EFFECT_ORDER:          ", EFFECT_ORDER.length);
console.log("menu (CORE+FS+MORE):   ", menuOrder.length);
console.log("unique type ids:       ", new Set(menuOrder).size);
console.log("unique NAMES in menu:  ", new Set(menuNames).size, " <-- must equal menuOrder.length");
console.log("unique NAMES in META:  ", new Set(metaNames).size);

const dupNames = menuNames.filter((n, i) => menuNames.indexOf(n) !== i);
console.log("\nDuplicate display names:", [...new Set(dupNames)].join(", ") || "none");
for (const n of new Set(dupNames)) {
  console.log("  " + n + " <- " + menuOrder.filter((t, i) => menuNames[i] === n).join(", "));
}
const missing = metaNames.filter((n) => !menuNames.includes(n));
console.log("\nIn META but not in menu:", missing.join(", ") || "none");
