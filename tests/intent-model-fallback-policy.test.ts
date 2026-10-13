import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { isCreativeBriefRoute, shouldTryActionModelFallback } from "../src/intent/model-fallback-policy";
import { setIntentModelProvider, tryModelRoute } from "../src/intent/model-resolver";
import { routeIntentText } from "../src/intent/route";

const doc = createProjectFromTemplate("house");

afterEach(() => setIntentModelProvider(null));

describe("action-model fallback boundary", () => {
  it.each([
    "dark trap at 142",
    "make me a darker beat",
    "make me an instrumental to sing over",
    "I have a vocal; build a beat that leaves room for the singer",
    "give me something to sing over",
    "chcem niečo pod vokál a miesto pre hlas",
  ])("keeps creative brief out of the command model: %s", (text) => {
    const route = routeIntentText(text, doc);
    expect(isCreativeBriefRoute(text, route)).toBe(true);
    expect(shouldTryActionModelFallback(text, route)).toBe(false);
  });

  it("does not let a valid model action hijack a parsed creative request", async () => {
    const generate = vi.fn(async () => JSON.stringify({ kind: "fader", targets: ["bass"], direction: "down" }));
    setIntentModelProvider({ id: "test-action-model", version: "1", generate });
    const text = "dark trap at 142";
    const route = routeIntentText(text, doc);

    expect(await tryModelRoute(text, doc, route)).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps an unparsed editor action eligible for the command model", async () => {
    const generate = vi.fn(async () => JSON.stringify({ kind: "fader", targets: ["bass"], direction: "down" }));
    setIntentModelProvider({ id: "test-action-model", version: "1", generate });
    const text = "shove the low end slightly left";
    const route = routeIntentText(text, doc);

    expect(shouldTryActionModelFallback(text, route)).toBe(true);
    expect((await tryModelRoute(text, doc, route))?.kind).toBe("fader");
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each(["give me that warm sub sound on the low end", "fix the drums maybe?"])(
    "does not mistake an unparsed action for a creative brief: %s",
    (text) => {
      const route = routeIntentText(text, doc);
      expect(isCreativeBriefRoute(text, route)).toBe(false);
    },
  );

  it.each([
    "unsolo the bass",
    "more delay on the bass",
    "more reverb send on the lead",
    "more saturation on the drums",
    "make the bass metallic",
    "add a keys track",
  ])("does not classify a direct editor command as a creative brief: %s", (text) => {
    const route = routeIntentText(text, doc);
    expect(isCreativeBriefRoute(text, route)).toBe(false);
    expect(shouldTryActionModelFallback(text, route)).toBe(route.kind === "pattern");
  });

  it.each([
    "The bass needs to be less dominant.",
    "Can you make the drum part less prominent?",
    "Keep the drums more subdued.",
    "The kick could use more impact.",
    "The bass is boomy.",
    "The lead sounds too sharp.",
    "Identify the current tempo value",
    "Tell me the tonal center of this beat.",
    "What scale are these notes in?",
    "Which modules are active on the low-end channel?",
    "Report the latest project change",
    "How many channels are populated?",
    "the bass should feel less upfront",
    "the drums are overwhelming the vocals",
    "the lead disappears under the chords",
    "there is too much level on the chords",
    "the kick overpowers the bass",
    "the 808 should sit more underneath",
    "the snare needs more body up front",
    "bicie su prilis vpredu",
    "basa prekrikuje ostatne stopy",
    "lead zanika pod akordmi",
    "kopak prehlusi basu",
    "the bass sounds cloudy",
    "the lead has a glassy edge",
    "the drop has no energy",
    "basa ma zahmleny spodok",
    "kopak straca uder",
    "lead reze do usi",
    "give me the BPM number",
    "what's the tonic of the song?",
    "tell me how many channels are in use",
    "what number is setting the song's pulse?",
    "what did I change immediately before this?",
    "which processors are coloring the bass?",
  ])("routes a plausible residual editor ask deterministically or to the action model: %s", (text) => {
    const route = routeIntentText(text, doc);
    expect(isCreativeBriefRoute(text, route)).toBe(false);
    expect(route.kind !== "pattern" || shouldTryActionModelFallback(text, route)).toBe(true);
  });

  it("keeps a phrase describing a new song arrangement in the creative path", () => {
    const text = "arrange into intro-verse-chorus";
    const route = routeIntentText(text, doc);
    expect(isCreativeBriefRoute(text, route)).toBe(true);
    expect(shouldTryActionModelFallback(text, route)).toBe(false);
  });

  it("treats a comparative beat edit as an action, not a new creative brief", () => {
    const text = "make the beat louder";
    const route = routeIntentText(text, doc);
    expect(isCreativeBriefRoute(text, route)).toBe(false);
  });
});
