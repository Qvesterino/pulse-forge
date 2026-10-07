import { TSAR_FACTORY_PRESETS, TSAR_FACTORY_PRESET_COUNT } from "../src/presets/tsar-factory";
console.log("count:", TSAR_FACTORY_PRESET_COUNT);
console.log("first:", JSON.stringify(TSAR_FACTORY_PRESETS[0]?.id));
const ids = new Set(TSAR_FACTORY_PRESETS.map((p) => p.id));
console.log("unique ids:", ids.size === TSAR_FACTORY_PRESETS.length);
const genres = new Set(TSAR_FACTORY_PRESETS.map((p) => p.genre));
console.log("genres:", [...genres].join(","));