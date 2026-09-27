import { it, expect } from "vitest";
import { EFFECT_META } from "../src/effects/definitions";
import { EFFECT_DEFS, EFFECT_ORDER } from "../src/effects/registry";
it("probe", () => {
  console.log("EFFECT_DEFS", Object.keys(EFFECT_DEFS).length);
  console.log("EFFECT_META", Object.keys(EFFECT_META).length);
  console.log("EFFECT_ORDER", EFFECT_ORDER.length);
  expect(true).toBe(true);
});
