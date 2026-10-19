import { describe, expect, it } from "vitest";
import { parseFaderIntent, parseNamedTrackFaderIntent } from "../src/intent/conversation";
import { parseBypassIntent, parseEffectIntent, parseSendIntent } from "../src/intent/mix";
import { routeIntentText } from "../src/intent/route";
import { REFERENCE_CLAUSE, stripReferenceClauses } from "../src/intent/reference-clause";
import { testDoc } from "./fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * REFERENCE CLAUSE + NEGATION FENCE — audit 2026-10-19.
 *
 * Four P0s in one family, and every one of them was SILENT: the engine routed
 * the sentence to a real command and mutated the project with a value the
 * producer never asked for. There was no decline, no clarification card, no
 * red — just a wrong edit sitting in the undo history.
 *
 *   P0-1  "turn down the drums and don't touch the bass"
 *           → routed to `fader`, targets ["bass","drums"], direction down.
 *           The user's own carve-out was the thing that executed.
 *   P0-2  "bring the Rhodes up so it sits louder than the kick"
 *           → parseNamedTrackFaderIntent returned BOTH track ids. The kick,
 *             named as the yardstick, was raised along with the Rhodes.
 *   P0-3  "more delay on the pad, like the lead"
 *           → parseEffectIntent collected both targets and put delay on the lead.
 *   P0-3' "raise the reverb send on the pad, match the bass"
 *           → send target resolved to "bass"; the pad, the actual ask, was
 *             never touched.
 *
 * The root cause of 2/3/3' is the same: the reference-clause vocabulary lived
 * in ONE parser (the family fader) while three sibling paths resolved their
 * targets from the whole sentence. Three copies of one vocabulary is how "than"
 * ended up honoured on one route and ignored on another. It now has one home
 * (src/intent/reference-clause.ts) and every route reads targets from the
 * stripped residue.
 *
 * Every expectation below is an ASSERTION, not a snapshot of current behaviour.
 * If the vocabulary ever drifts closed, these fail rather than quietly
 * degrading — that is the whole point of pinning both directions.
 */

/** Two named tracks so reference-vs-target is observable by id, not by family. */
function namedDoc(): ProjectDocument {
  const base = testDoc();
  return {
    ...base,
    tracks: [
      { ...base.tracks[0], id: "tr-rhodes", name: "Rhodes", kind: "instrument" },
      { ...base.tracks[0], id: "tr-kick", name: "Kick", kind: "drum" },
    ],
  } as ProjectDocument;
}

describe("stripReferenceClauses", () => {
  it("removes the comparison and everything it governs", () => {
    expect(stripReferenceClauses("more delay on the pad, like the lead").trim()).toBe("more delay on the pad,");
  });

  it("is stateless across calls — the pattern is global, the instance is not shared", () => {
    // A cached RegExp with `g` carries lastIndex between sentences and silently
    // skips matches, so every OTHER call would resolve a different sentence
    // differently. Pin the same input twice in a row, then interleave.
    const a = "rhodes up relative to the kick";
    expect(stripReferenceClauses(a)).toBe(stripReferenceClauses(a));
    expect(stripReferenceClauses("rhodes up relative to the kick").trim()).toBe("rhodes up");
    expect(stripReferenceClauses(a).trim()).toBe("rhodes up");
  });

  it("leaves a plain sentence untouched", () => {
    expect(stripReferenceClauses("more delay on the pad").trim()).toBe("more delay on the pad");
  });

  it("exports a self-contained pattern usable as a fresh RegExp", () => {
    expect(new RegExp(REFERENCE_CLAUSE.source, REFERENCE_CLAUSE.flags).test("louder than the kick")).toBe(true);
  });
});

describe("P0-2 — a comparison's track is a yardstick, not an edit target", () => {
  it("raises the Rhodes and leaves the Kick alone", () => {
    const intent = parseNamedTrackFaderIntent("bring the Rhodes up so it sits louder than the kick", namedDoc());
    expect(intent?.trackIds).toEqual(["tr-rhodes"]);
    expect(intent?.trackIds).not.toContain("tr-kick");
  });

  it("honours every comparison word, not just 'than'", () => {
    // These all failed or over-matched before the vocabulary was centralized.
    expect(parseNamedTrackFaderIntent("make the Rhodes louder than the Kick", namedDoc())?.trackIds).toEqual([
      "tr-rhodes",
    ]);
    expect(parseNamedTrackFaderIntent("raise the Rhodes relative to the Kick", namedDoc())?.trackIds).toEqual([
      "tr-rhodes",
    ]);
    expect(parseNamedTrackFaderIntent("bring the Rhodes up similar to the Kick", namedDoc())?.trackIds).toEqual([
      "tr-rhodes",
    ]);
  });

  it("still resolves both tracks when BOTH are genuinely named as targets", () => {
    // The over-strip failure mode: if the fix removed too much, a real two-track
    // edit would silently become a one-track edit. Pin the positive direction.
    const intent = parseNamedTrackFaderIntent("raise the Rhodes and the Kick", namedDoc());
    expect(new Set(intent?.trackIds)).toEqual(new Set(["tr-rhodes", "tr-kick"]));
  });

  it("still resolves a plain single-target ask", () => {
    expect(parseNamedTrackFaderIntent("bring the Rhodes up", namedDoc())?.trackIds).toEqual(["tr-rhodes"]);
  });
});

describe("P0-3 — effect / send / bypass resolve targets off the stripped residue", () => {
  it("does not put the effect on the comparison track", () => {
    expect(parseEffectIntent("more delay on the pad, like the lead")?.targets).toEqual(["chords"]);
    expect(parseSendIntent("raise the reverb send on the pad, match the bass")?.target).toBe("chords");
    expect(parseBypassIntent("turn off the delay on the chords, like the pad")?.target).toBe("chords");
  });

  it("keeps a genuine multi-target effect ask intact", () => {
    // "and" is a target list, not a comparison — stripping must not eat it.
    expect(new Set(parseEffectIntent("more delay on the pad and the lead")?.targets)).toEqual(
      new Set(["chords", "lead"]),
    );
  });

  it("does not let a scene role be read out of a comparison", () => {
    // 'chorus' in "…, like the chorus" is the yardstick; role expansion must not
    // fire on it and drag in drums+bass+chords.
    expect(parseEffectIntent("more delay on the pad, like the chorus")?.targets).toEqual(["chords"]);
  });

  it("keeps effect-word and direction detection on the whole sentence", () => {
    // Stripping for TARGETS must not strip the amount or the effect noun:
    // "more" is the direction and "delay" is the effect, and a comparison word
    // sitting between them must not blind the parser to either.
    const intent = parseEffectIntent("more delay on the pad, like the lead");
    expect(intent?.effectType).toBe("delay");
    expect(intent?.direction).toBe("more");
  });

  it("declines a sentence-initial 'match' rather than mutating both of its tracks", () => {
    // "match" is genuinely ambiguous English: it can be the primary verb ("make
    // the Rhodes match the kick") or a comparison ("…, match the bass"). The
    // strip is GREEDY on purpose, so a sentence-initial "match" takes the rest of
    // the sentence with it and the fader path finds no target.
    //
    // The alternative — anchoring "match" to a non-initial position so the
    // leading verb survives — was measured and REJECTED: it makes "match the
    // Rhodes to the Kick and raise it" resolve BOTH tracks, which is exactly
    // the P0 this file exists to prevent. A safe decline beats a clever parse.
    //
    // The property that matters is the safety one: no track is mutated by a
    // comparison, and the sentence still surfaces as a visible decline rather
    // than a silent no-op. Measured route kinds for "match …" sentences are
    // loudness/pattern/clarify — never a fader edit.
    const doc = namedDoc();
    const intent = parseNamedTrackFaderIntent("match the Rhodes to the Kick and raise it", doc);
    expect(intent?.trackIds ?? []).not.toContain("tr-kick");
    expect(routeIntentText("match the Rhodes to the Kick and raise it", doc, {}).kind).not.toBe("fader");
  });
});

describe("P0-1 — a negation fence never becomes an edit", () => {
  it("declines the whole sentence instead of executing the carve-out", () => {
    const doc = testDoc();
    for (const text of [
      "turn down the drums and don't touch the bass",
      "don't touch the bass",
      "please don't touch the reverb on the pad",
      "raise the hats but don't move the bass",
      "never change the master",
    ]) {
      const routed = routeIntentText(text, doc, {});
      expect(routed.kind, `expected a decline for: ${text}`).toBe("clarify");
      expect((routed as { reason?: string }).reason).toBe("negated-mutation-command");
    }
  });

  it("declines on the fence even when the rest of the sentence is a valid command", () => {
    // The dangerous shape: a genuinely executable first clause. Splitting it and
    // applying the first half would be a guess about which half was meant, so
    // the product asks instead.
    const doc = testDoc();
    const routed = routeIntentText("turn down the drums and don't touch the bass", doc, {});
    expect(routed.kind).not.toBe("fader");
  });

  it("does not fence an ordinary command that merely mentions a track", () => {
    // The over-fire failure mode: a fence regex that swallows plain commands
    // would make the whole fader route dead. Pin that it still routes.
    const doc = testDoc();
    const routed = routeIntentText("turn down the drums", doc, {});
    expect(routed.kind).toBe("fader");
    expect(parseFaderIntent("turn down the drums")?.targets).toEqual(["drums"]);
  });
});
