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

  it("treats a comparative beat edit as an action, not a new creative brief", () => {
    const text = "make the beat louder";
    const route = routeIntentText(text, doc);
    expect(isCreativeBriefRoute(text, route)).toBe(false);
  });
});
