import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { routeIntentText } from "../src/intent/route";
import { CLARIFY_MESSAGES, clarifyMessage } from "../src/intent/clarify-messages";
import { partitionClarifySuggestions, wouldGenerateOnClick } from "../src/intent/clarify-suggestions";
import { testDoc } from "./fixtures/doc";

/**
 * DECLINE UX — control-surface audit 2026-10-19.
 *
 * A decline is the engine saying "I did not change anything". The producer has
 * to be able to read that, and the only thing the producer can click on a
 * decline must be safe to click. Both were broken.
 *
 * D1 — THE MACHINE KEY REACHED THE SCREEN. A decline's `reason` is a stable
 *      snake-case key (the SFT teacher's label, the mining log's group). The
 *      panel put it straight into the status line, so the producer read
 *      "negated-mutation-command" instead of a sentence. The key stays the
 *      key; intent/clarify-messages.ts is the one home for the sentence.
 *
 * D2 — PROSE WAS RENDERED AS A CLICKABLE CHIP. "name the track or layer" and
 *      "state the change you want" are instructions, not actions. Rendered as
 *      chips, clicking one re-routed English prose back into the engine.
 *
 * D3 — A FRAGMENT CHIP REGENERATED THE SONG. The preset-target decline
 *      suggested "on the bass" — the TAIL of "load the Warm Sub preset on the
 *      bass". The UI sends a clicked chip to the router STANDALONE, so the
 *      fragment lost its sentence and routed to a creative brief. Measured:
 *      clicking it GENERATED A NEW BEAT and replaced the producer's song — the
 *      exact P0-A failure the miss path is guarded against everywhere else.
 *
 * The fix has a general shape, not three special cases: a decline DECLARES
 * which suggestions are advice, and a chip that would generate is demoted no
 * matter who declared it. The safety test below is the point — it would have
 * caught D3 without anybody having to notice that particular fragment.
 */

/** Sentences that reach a decline, with the reason each one reaches. */
const DECLINE_BATTERY: ReadonlyArray<readonly [string, string]> = [
  ["turn down the drums and don't touch the bass", "negated-mutation-command"],
  ["should I lower the snare?", "hypothetical-action-question"],
  ["mute the bass but keep it audible", "conflicting-actions"],
  ["pan the bass left and right", "conflicting-pan-directions"],
  ["raise the bass and make it quieter", "conflicting-level-directions"],
  ["set it to a reasonable level", "missing-level-value"],
  ["move it left", "missing-pan-target"],
  ["lower it", "missing-fader-target"],
  ["make the other layer more prominent", "missing-layer-target"],
  ["add that effect", "missing-effect-target"],
  ["set tempo to a comfortable speed", "missing-tempo-value"],
  ["set the reverb send to a sensible amount", "missing-send-value"],
  ["set the reverb to a good amount", "missing-effect-value"],
  ["raise the reverb return", "ambiguous-send-return"],
  ["load the warm sub preset", "preset-target"],
  ["more delay", "na ktorý track má smerovať delay?"],
  ["zníž", "ktorý fader?"],
  ["mut the drums", 'did you mean "mute the drums"?'],
];

const isSlug = (reason: string): boolean => /^[a-z][a-z0-9-]*$/.test(reason);

describe("decline battery — every decline the router can reach", () => {
  const doc = testDoc();

  it("reaches the reason each sentence is supposed to reach", () => {
    for (const [text, reason] of DECLINE_BATTERY) {
      const route = routeIntentText(text, doc, {});
      expect(route.kind, `"${text}" should decline`).toBe("clarify");
      expect((route as { reason: string }).reason, `"${text}" reason`).toBe(reason);
    }
  });

  it("D3 — no suggestion of a decline can generate a new beat", () => {
    // The safety property. If this ever fails, a producer can replace their
    // song by clicking a chip on a card that said "nothing was changed".
    for (const [text] of DECLINE_BATTERY) {
      const route = routeIntentText(text, doc, {});
      if (route.kind !== "clarify") continue;
      for (const suggestion of route.suggestions) {
        expect(
          wouldGenerateOnClick(suggestion, doc),
          `"${suggestion}" (suggested by "${text}") must not generate`,
        ).toBe(false);
      }
    }
  });

  it("D3 — a chip is only ever offered for a suggestion that cannot generate", () => {
    for (const [text] of DECLINE_BATTERY) {
      const route = routeIntentText(text, doc, {});
      if (route.kind !== "clarify") continue;
      const split = partitionClarifySuggestions(route.suggestions, route.advice, doc);
      for (const chip of split.executable) {
        expect(wouldGenerateOnClick(chip, doc), `"${chip}" must not generate`).toBe(false);
      }
    }
  });

  it("D2 — every suggestion the battery produces is classified exactly once", () => {
    for (const [text] of DECLINE_BATTERY) {
      const route = routeIntentText(text, doc, {});
      if (route.kind !== "clarify") continue;
      const split = partitionClarifySuggestions(route.suggestions, route.advice, doc);
      expect(
        [...split.executable, ...split.advice].sort(),
        `"${text}" — every suggestion is either a chip or advice`,
      ).toEqual([...route.suggestions].sort());
    }
  });
});

describe("D1 — the producer reads a sentence, never a machine key", () => {
  it("every slug reason the router reaches has a human sentence", () => {
    for (const [, reason] of DECLINE_BATTERY) {
      if (!isSlug(reason)) continue;
      expect(reason in CLARIFY_MESSAGES, `no sentence for "${reason}"`).toBe(true);
      expect(clarifyMessage(reason)).not.toBe(reason);
      // A human sentence, not another slug.
      expect(clarifyMessage(reason)).toMatch(/[.!]/);
    }
  });

  it("every slug reason in the SFT dataset has a human sentence", () => {
    // The dataset is the CLOSED set of decline reasons the model was trained
    // on — 50 rows. If any of them is a slug without a sentence, the producer
    // reads the key.
    const dataset = readFileSync(join(process.cwd(), "scripts/data/intent-sft/train.jsonl"), "utf8");
    const reasons = new Set<string>();
    for (const line of dataset.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { response?: { kind?: string; reason?: string } };
      if (row.response?.kind === "clarify" && typeof row.response.reason === "string") {
        reasons.add(row.response.reason);
      }
    }
    expect(reasons.size).toBeGreaterThan(0);
    for (const reason of reasons) {
      if (!isSlug(reason)) continue;
      expect(reason in CLARIFY_MESSAGES, `no sentence for "${reason}"`).toBe(true);
    }
  });

  it("a decline whose reason is already a sentence reads as-is", () => {
    // The unmatched-route clarify and the Slovak fader/effect clarifications
    // use sentences as their reason — the map must not shadow them.
    expect(clarifyMessage("ktorý fader?")).toBe("ktorý fader?");
    expect(clarifyMessage('did you mean "mute the drums"?')).toBe('did you mean "mute the drums"?');
  });
});

describe("D2 — advice is text, an action is a chip", () => {
  const doc = testDoc();

  it("separates a declared command from declared prose advice", () => {
    const split = partitionClarifySuggestions(
      ["turn down the drums", "name the track or layer"],
      ["name the track or layer"],
      doc,
    );
    expect(split.executable).toEqual(["turn down the drums"]);
    expect(split.advice).toEqual(["name the track or layer"]);
  });

  it("the ambiguous-command declines declare their prose as advice", () => {
    // "name the track or layer" routes to a read-only query, and
    // "choose louder or quieter" routes to a real LOUDNESS action — so
    // probing the router for "is this executable" cannot tell prose from a
    // command. The route has to declare it.
    const route = routeIntentText("lower it", doc, {});
    expect(route.kind).toBe("clarify");
    expect((route as { advice?: string[] }).advice).toEqual(["name the track or layer"]);
  });

  it("a suggestion that would generate is demoted even if it was declared a command", () => {
    // The safety net is independent of the declaration: nothing that
    // regenerates the producer's song can ever become a chip.
    const split = partitionClarifySuggestions(["on the bass"], undefined, doc);
    expect(split.executable).toEqual([]);
    expect(split.advice).toEqual(["on the bass"]);
  });

  it("the fence offers the command half as an executable ask", () => {
    const route = routeIntentText("turn down the drums and don't touch the bass", doc, {});
    expect(route.kind).toBe("clarify");
    const suggestions = (route as { suggestions: string[] }).suggestions;
    // The negated half is NOT offered — clicking it would re-run the fence.
    expect(suggestions).toEqual(["turn down the drums"]);
    const split = partitionClarifySuggestions(suggestions, (route as { advice?: string[] }).advice, doc);
    expect(split.executable).toEqual(["turn down the drums"]);
  });

  it("the fence offers nothing when no clause stands alone as a command", () => {
    const route = routeIntentText("never change the master", doc, {});
    expect(route.kind).toBe("clarify");
    expect((route as { suggestions: string[] }).suggestions).toEqual([]);
  });
});

describe("D3 — a preset chip is a whole sentence", () => {
  const doc = testDoc();

  it("completes the producer's own sentence instead of sending a fragment", () => {
    const route = routeIntentText("load the warm sub preset", doc, {});
    expect(route.kind).toBe("clarify");
    const suggestions = (route as { suggestions: string[] }).suggestions;
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      // The chip carries the whole ask, not a tail of it.
      expect(suggestion.startsWith("load the warm sub preset")).toBe(true);
      expect(wouldGenerateOnClick(suggestion, doc)).toBe(false);
    }
  });

  it("keeps the producer's language", () => {
    const route = routeIntentText("nacitaj preset warm sub", doc, {});
    expect(route.kind).toBe("clarify");
    for (const suggestion of (route as { suggestions: string[] }).suggestions) {
      expect(suggestion.startsWith("nacitaj preset warm sub")).toBe(true);
      expect(suggestion).toContain(" na ");
    }
  });
});
