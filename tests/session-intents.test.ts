import { describe, it, expect } from "vitest";
import { routeIntentText } from "../src/intent/route";
import { parseUndoIntent, parseQueryIntent } from "../src/intent/studio-words";
import { parseExactIntent } from "../src/intent/exact";
import { applyExactIntentCommand } from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc } from "./fixtures/doc";

/**
 * PHASE A — undo/query/session intents. The most-said producer sentence
 * ("vráť to") plus read-only questions. Undo/redo dispatch through the real
 * ProjectStore; queries never mutate.
 */

describe("undo/redo intents", () => {
  it("'undo' undoes the last command; 'vráť to' likewise", () => {
    const store = new ProjectStore(testDoc());
    const bpmBefore = store.doc.bpm;
    store.execute(applyExactIntentCommand(store.doc, parseExact("set tempo to 140")));
    expect(store.doc.bpm).toBe(140);
    expect(routeIntentText("undo", store.doc).kind).toBe("undoIntent");
    expect(routeIntentText("vráť to", store.doc).kind).toBe("undoIntent");
    store.undo();
    expect(store.doc.bpm).toBe(bpmBefore);
  });

  it("'undo two steps' undoes BOTH in one ask", () => {
    const store = new ProjectStore(testDoc());
    const bpmBefore = store.doc.bpm;
    const masterBefore = store.doc.master.masterGain;
    store.execute(applyExactIntentCommand(store.doc, parseExact("set tempo to 140")));
    store.execute(applyExactIntentCommand(store.doc, parseExact("boost the mix by 2 db")));
    const route = routeIntentText("undo two steps", store.doc);
    if (route.kind !== "undoIntent") throw new Error("expected undo");
    expect(route.intent.steps).toBe(2);
    for (let i = 0; i < route.intent.steps; i++) store.undo();
    expect(store.doc.bpm).toBe(bpmBefore);
    expect(store.doc.master.masterGain).toBe(masterBefore);
  });

  it("'redo' reapplies; 'undo 3 steps' parses the numeric form", () => {
    expect(parseUndoIntent("undo 3 steps")?.steps).toBe(3);
    expect(parseUndoIntent("vráť to")?.steps).toBe(1);
    expect(parseUndoIntent("späť")?.steps).toBe(1);
    expect(parseUndoIntent("redo")?.kind).toBe("redo");
    expect(parseUndoIntent("zopakuj")?.kind).toBe("redo");
  });

  it("undo/redo routes win over pattern generation (bare words)", () => {
    const doc = testDoc();
    expect(routeIntentText("undo", doc).kind).toBe("undoIntent");
    expect(routeIntentText("redo", doc).kind).toBe("undoIntent");
  });
});

describe("query intents", () => {
  it("queries are read-only and answer real state", () => {
    const store = new ProjectStore(testDoc());
    const before = store.doc;
    for (const text of ["what tempo", "v akom je to takte?", "list tracks", "what markers?", "what's on the lead?"]) {
      const route = routeIntentText(text, store.doc);
      expect(route.kind).toBe("queryIntent");
    }
    expect(store.doc).toBe(before); // zero mutation
    expect(store.undoStackLength).toBe(0);
  });

  it("subject extraction: tempo/key/tracks/fxChain/markers/groove", () => {
    expect(parseQueryIntent("what tempo")?.subject).toBe("tempo");
    expect(parseQueryIntent("what key are we in?")?.subject).toBe("key");
    expect(parseQueryIntent("list tracks")?.subject).toBe("tracks");
    expect(parseQueryIntent("čo má lead na sebe?")?.subject).toBe("fxChain");
    if (parseQueryIntent("čo má lead na sebe?")?.subject !== "fxChain") throw new Error("unreachable");
    expect(parseQueryIntent("what markers do we have?")?.subject).toBe("markers");
    expect(parseQueryIntent("ako znie groove?")?.subject).toBe("groove");
  });

  it("'what did you just do' → lastAction (history read)", () => {
    const store = new ProjectStore(testDoc());
    store.execute(applyExactIntentCommand(store.doc, parseExact("set tempo to 128")));
    const route = routeIntentText("čo si spravil?", store.doc);
    expect(route.kind).toBe("queryIntent");
    if (route.kind !== "queryIntent") throw new Error("expected query");
    expect(route.intent.subject).toBe("lastAction");
    // the answer exists in history
    const entry = store.history[store.history.length - 1];
    expect(entry.label).toContain("128");
  });

  it("non-questions never route as queries", () => {
    const doc = testDoc();
    expect(routeIntentText("turn down the lead", doc).kind).not.toBe("queryIntent");
    expect(routeIntentText("dark techno at 140", doc).kind).not.toBe("queryIntent");
    expect(parseQueryIntent("what a great beat")).toBeNull(); // no subject
  });
});

function parseExact(text: string) {
  const plan = parseExactIntent(text);
  if (!plan) throw new Error(`fixture: exact parse failed for "${text}"`);
  return plan;
}
