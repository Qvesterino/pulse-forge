import { describe, it } from "vitest";
import { routeIntentText } from "../src/intent/route";
import { parseNamedTrackFaderIntent, parseFaderIntent } from "../src/intent/conversation";
import { parseEffectIntent, parseSendIntent } from "../src/intent/mix";
import { testDoc } from "../tests/fixtures/doc";

/** Verification probe: do the reported P0s actually reproduce? */
describe("P0 verification", () => {
  it("P0-1 negation", () => {
    for (const t of [
      "turn down the drums and don't touch the bass",
      "turn down the drums, don't touch the bass",
      "don't touch the bass",
      "turn down the drums and never mute the bass",
    ]) {
      const r = routeIntentText(t, testDoc());
      const f = parseFaderIntent(t);
      console.log(
        `P0-1 "${t}"\n     route=${r.kind} | faderTargets=${JSON.stringify(f?.targets ?? null)} dir=${f?.direction ?? "-"}`,
      );
    }
  });

  it("P0-2 named-track reference clause", () => {
    const doc = testDoc();
    // rename two tracks to the exact names the sentence uses
    const tracks = doc.tracks.map((t, i) => (i === 0 ? { ...t, name: "Rhodes" } : i === 1 ? { ...t, name: "Kick" } : t));
    const named = { ...doc, tracks };
    for (const t of [
      "bring the Rhodes up so it sits louder than the kick",
      "make the Rhodes quieter than the kick",
      "turn the Rhodes up",
    ]) {
      const f = parseFaderIntent(t);
      const n = parseNamedTrackFaderIntent(t, named);
      const r = routeIntentText(t, named);
      console.log(
        `P0-2 "${t}"\n     family=${JSON.stringify(f?.targets ?? null)} namedTrackIds=${JSON.stringify(n?.trackIds ?? null)} route=${r.kind}`,
      );
    }
  });

  it("P0-3 effect/send reference clause", () => {
    for (const t of ["more delay on the pad, like the lead", "more reverb on the pad like the bass"]) {
      const e = parseEffectIntent(t);
      console.log(`P0-3 "${t}"\n     effectTargets=${JSON.stringify(e?.targets ?? null)} dir=${e?.direction ?? "-"}`);
    }
    for (const t of ["raise the reverb send on the pad, match the bass"]) {
      const s = parseSendIntent(t);
      console.log(`P0-3 "${t}"\n     sendTarget=${JSON.stringify(s?.target ?? null)} dir=${s?.direction ?? "-"}`);
    }
  });
});