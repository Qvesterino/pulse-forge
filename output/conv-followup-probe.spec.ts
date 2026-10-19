import { describe, it } from "vitest";
import { parseFaderIntent } from "../src/intent/conversation";
import { parsePercent } from "../src/intent/percent";

/** Temporary probe: what do comparative follow-up phrases do TODAY? */
describe("conversation follow-up probe", () => {
  it("prints actual behaviour", () => {
    const phrases = [
      "half as much as last time",
      "a little less again",
      "even less",
      "same amount as last time",
      "as much as before",
      "make it even less on the bass",
      "make it a little less again on the bass",
    ];
    for (const p of phrases) {
      const intent = parseFaderIntent(p);
      console.log(
        `PROBE "${p.padEnd(38)}" | fader=${intent ? `${intent.direction}/${intent.amount}${intent.percent != null ? `/${intent.percent}%` : ""}` : "DECLINES"} | parsePercent=${parsePercent(p)}`,
      );
    }
  });
});