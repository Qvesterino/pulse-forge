import { describe, it, expect } from "vitest";
import { routeIntentText } from "../src/intent/route";
import { parseUndoIntent, parseQueryIntent } from "../src/intent/studio-words";
import { parseExactIntent } from "../src/intent/exact";
import { applyExactIntentCommand } from "../src/commands/intentRouting";
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

  it("understands natural EN/SK history references and rejects unrelated targets", () => {
    expect(parseUndoIntent("undo the previous change")).toEqual({ kind: "undo", steps: 1 });
    expect(parseUndoIntent("go back one step")).toEqual({ kind: "undo", steps: 1 });
    expect(parseUndoIntent("vráť poslednú zmenu")).toEqual({ kind: "undo", steps: 1 });
    expect(parseUndoIntent("vráť štyri kroky")).toEqual({ kind: "undo", steps: 4 });
    expect(parseUndoIntent("zopakuj poslednú akciu")).toEqual({ kind: "redo", steps: 1 });
    expect(parseUndoIntent("redo the last two steps")).toEqual({ kind: "redo", steps: 2 });
    expect(parseUndoIntent("reapply my latest edit")).toEqual({ kind: "redo", steps: 1 });
    expect(parseUndoIntent("repeat the previous adjustment")).toEqual({ kind: "redo", steps: 1 });
    expect(parseUndoIntent("apply the bass again")).toBeNull();
    expect(parseUndoIntent("revert one action")).toEqual({ kind: "undo", steps: 1 });
    expect(parseUndoIntent("reverse what I changed most recently")).toEqual({ kind: "undo", steps: 1 });
    expect(parseUndoIntent("go back two steps")).toEqual({ kind: "undo", steps: 2 });
    expect(parseUndoIntent("undo ten steps")).toEqual({ kind: "undo", steps: 10 });
    expect(parseUndoIntent("undo 10 steps")).toEqual({ kind: "undo", steps: 10 });
    expect(parseUndoIntent("zopakuj sedem krokov")).toEqual({ kind: "redo", steps: 7 });
    expect(parseUndoIntent("vráť päť krokov")).toEqual({ kind: "undo", steps: 5 });
    expect(parseUndoIntent("undo the bass")).toBeNull();
    expect(parseUndoIntent("go back to bar 8")).toBeNull();
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
    expect(parseQueryIntent("tell me the current bpm")?.subject).toBe("tempo");
    expect(parseQueryIntent("aké efekty sú na base?")).toMatchObject({ subject: "fxChain", target: "bass" });
    expect(parseQueryIntent("ukáž efekty na bicích")?.subject).toBe("fxChain");
    expect(parseQueryIntent("which plugins are on the drums?")).toMatchObject({ subject: "fxChain", target: "drums" });
    expect(parseQueryIntent("show all plugins on the low end channel?")).toMatchObject({
      subject: "fxChain",
      target: "bass",
    });
    expect(parseQueryIntent("which was my last action?")?.subject).toBe("lastAction");
    expect(parseQueryIntent("what was the last thing you changed?")?.subject).toBe("lastAction");
    expect(parseQueryIntent("čo si naposledy zmenil?")?.subject).toBe("lastAction");
    expect(parseQueryIntent("čo si práve zmenil?")?.subject).toBe("lastAction");
    expect(parseQueryIntent("Identify the current tempo value")).toEqual({ subject: "tempo" });
    expect(parseQueryIntent("Tell me the tonal center of this beat.")).toEqual({ subject: "key" });
    expect(parseQueryIntent("What scale are these notes in?")).toEqual({ subject: "key" });
    expect(parseQueryIntent("Which modules are active on the low-end channel?")).toEqual({
      subject: "fxChain",
      target: "bass",
    });
    expect(parseQueryIntent("Report the latest project change")).toEqual({ subject: "lastAction" });
    expect(parseQueryIntent("How many channels are populated?")).toEqual({ subject: "tracks" });
    expect(parseQueryIntent("kolko kanalov sme pouzili")).toEqual({ subject: "tracks" });
    expect(parseQueryIntent("what did I change immediately before this?")).toEqual({ subject: "lastAction" });
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
