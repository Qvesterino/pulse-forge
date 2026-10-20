/**
 * CONVERSATIONAL MEMORY — "half as much as last time", "same again but on the hats".
 *
 * The producer's second sentence often refers to their FIRST one. The engine
 * had no memory of one, so those sentences were handled in the worst possible
 * way (see `src/intent/reference-delta.ts`): the reuse forms fell through to
 * PATTERN GENERATION, which replaces the producer's song, and the magnitude
 * forms silently applied the phrase's own nominal step.
 *
 * The feature is three parts, and this suite pins all three:
 *
 *   1. the LEDGER (`src/intent/adjustment-ledger.ts`) — one session-scoped
 *      record of the last RELATIVE fader move, scoped to the project it
 *      happened in;
 *   2. the VOCABULARY (`src/intent/reference-delta.ts`) — which sentences name
 *      an earlier change at all, and which of them are the DEGREE ladder
 *      repeating its own step instead of a memory lookup;
 *   3. the RESOLUTION (`src/intent/prior-adjustment.ts`) — the remembered
 *      change turned back into a validated fader intent.
 *
 * The dangerous property is pinned hardest: a reference must NEVER reach the
 * generation route. A beat generated from the words "same again but on the
 * hats" would replace the producer's song.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { routeIntentText } from "../src/intent/route";
import { applyFaderIntent, parseFaderIntent } from "../src/intent/conversation";
import { recordFaderAdjustment } from "../src/intent/adjustment-recording";
import { clearAdjustments, lastAdjustment, rememberAdjustment } from "../src/intent/adjustment-ledger";
import { isPriorDeltaReference, stripPriorDeltaReference } from "../src/intent/reference-delta";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/** One document for the whole file — `createProjectFromTemplate` mints a new id per call. */
const doc: ProjectDocument = createProjectFromTemplate("house");

/** Apply a fader ask the way the panel does, and record what landed. */
function perform(text: string, source: ProjectDocument = doc): void {
  const intent = parseFaderIntent(text);
  if (!intent) throw new Error(`probe setup: "${text}" is not a fader intent`);
  const command = applyFaderIntent(source, intent);
  if (!command) throw new Error(`probe setup: "${text}" has no target`);
  recordFaderAdjustment(source.id, intent, source, command.execute(source));
}

beforeEach(() => {
  clearAdjustments();
});

describe("the ledger — one session-scoped record of the last relative fader move", () => {
  it("remembers a change and hands it back for the SAME project", () => {
    rememberAdjustment({
      docId: "project-a",
      direction: "up",
      factor: 1.35,
      targets: ["bass"],
      pads: [],
      trackIds: [],
      returnIds: [],
    });
    const entry = lastAdjustment("project-a");
    expect(entry).not.toBeNull();
    expect(entry!.factor).toBe(1.35);
    expect(entry!.direction).toBe("up");
    expect(entry!.targets).toEqual(["bass"]);
  });

  it("does NOT hand a change of another project back — its track ids name tracks that do not exist here", () => {
    rememberAdjustment({
      docId: "project-a",
      direction: "up",
      factor: 1.35,
      targets: ["bass"],
      pads: [],
      trackIds: [],
      returnIds: [],
    });
    expect(lastAdjustment("project-b")).toBeNull();
  });

  it("forgets on clear — an undo or a different kind of change invalidates the record", () => {
    rememberAdjustment({
      docId: "project-a",
      direction: "up",
      factor: 1.35,
      targets: ["bass"],
      pads: [],
      trackIds: [],
      returnIds: [],
    });
    clearAdjustments();
    expect(lastAdjustment("project-a")).toBeNull();
  });
});

describe("the vocabulary — which sentences name an earlier change", () => {
  it("recognises the repeat forms", () => {
    for (const text of [
      "same again but on the hats",
      "that again",
      "do it again",
      "repeat the last change",
      "do the same on the hats",
      "the same adjustment as before",
    ]) {
      expect(isPriorDeltaReference(text), text).toBe(true);
    }
  });

  it("recognises the magnitude forms", () => {
    for (const text of ["half as much as last time", "as much as last time", "the same amount as before"]) {
      expect(isPriorDeltaReference(text), text).toBe(true);
    }
  });

  it("does NOT claim the DEGREE ladder repeating its own step", () => {
    // "a little less AGAIN" is the graduated magnitude repeating itself, not
    // a memory lookup. A vocabulary that claimed it would turn an ordinary
    // ask into a decline.
    expect(isPriorDeltaReference("make it a little less again on the bass")).toBe(false);
  });

  it("does not claim an ordinary ask", () => {
    for (const text of ["raise the bass", "more delay on the pad", "turn down the hats"]) {
      expect(isPriorDeltaReference(text), text).toBe(false);
    }
  });

  it("strips the reference so the rest of the sentence can be offered back", () => {
    expect(stripPriorDeltaReference("half as much as last time")).not.toContain("last time");
    expect(stripPriorDeltaReference("same again but on the hats")).toContain("hats");
  });
});

describe("the resolution — the remembered change comes back as a fader intent", () => {
  it("a measured fader move is recorded with the factor that actually landed", () => {
    perform("raise the bass by 10%");
    const entry = lastAdjustment(doc.id);
    expect(entry).not.toBeNull();
    expect(entry!.direction).toBe("up");
    // The factor is the MEASURED gain change, not the phrase's nominal step.
    expect(entry!.factor).toBeGreaterThan(1);
    expect(entry!.factor).toBeLessThan(1.2);
    expect(entry!.targets).toContain("bass");
  });

  it("'half as much as last time' comes back as a fader move, not a decline", () => {
    perform("raise the bass by 10%");
    const before = lastAdjustment(doc.id)!.factor;
    const route = routeIntentText("half as much as last time", doc);
    expect(route.kind).toBe("fader");
    const intent = (route as { kind: "fader"; intent: { factor?: number; direction: string } }).intent;
    // A genuine halving: smaller than the remembered move, larger than none.
    expect(intent.factor).toBeGreaterThan(1);
    expect(intent.factor!).toBeLessThan(before);
  });

  it("'as much as last time' comes back as the SAME magnitude", () => {
    perform("raise the bass by 10%");
    const before = lastAdjustment(doc.id)!.factor;
    const route = routeIntentText("as much as last time", doc);
    expect(route.kind).toBe("fader");
    const intent = (route as { kind: "fader"; intent: { factor?: number } }).intent;
    expect(intent.factor).toBeCloseTo(before, 5);
  });

  it("'same again but on the hats' repeats the move on the NEW target", () => {
    perform("raise the bass by 10%");
    const before = lastAdjustment(doc.id)!.factor;
    const route = routeIntentText("same again but on the hats", doc);
    expect(route.kind).toBe("fader");
    const intent = (route as { kind: "fader"; intent: { factor?: number; pads?: string[] } }).intent;
    expect(intent.pads ?? []).toContain("hat");
    expect(intent.factor).toBeCloseTo(before, 5);
  });

  it("'do the same on the hats' repeats the move on the NEW target", () => {
    perform("raise the bass by 10%");
    const route = routeIntentText("do the same on the hats", doc);
    expect(route.kind).toBe("fader");
    const intent = (route as { kind: "fader"; intent: { pads?: string[]; targets?: string[] } }).intent;
    expect(intent.pads ?? []).toContain("hat");
  });

  it("WITHOUT a record the same sentence declines — it never guesses a magnitude", () => {
    const route = routeIntentText("half as much as last time", doc);
    expect(route.kind).toBe("clarify");
    expect((route as { reason: string }).reason).toBe("last-adjustment-reference");
  });

  it("an effect change supersedes the fader record — the reference then declines", () => {
    perform("raise the bass by 10%");
    expect(lastAdjustment(doc.id)).not.toBeNull();
    clearAdjustments();
    const route = routeIntentText("half as much as last time", doc);
    expect(route.kind).toBe("clarify");
  });
});

describe("the safety property — a reference must never reach the generation route", () => {
  it("'same again but on the hats' is not a beat-generation prompt", () => {
    perform("raise the bass by 10%");
    const route = routeIntentText("same again but on the hats", doc);
    expect(route.kind).not.toBe("pattern");
  });

  it("'again' on its own is not a beat-generation prompt", () => {
    perform("raise the bass by 10%");
    const route = routeIntentText("again", doc);
    expect(route.kind).not.toBe("pattern");
    expect(route.kind).toBe("clarify");
  });

  it("the transport keeps its own commands — 'play' is still a transport command", () => {
    perform("raise the bass by 10%");
    expect(routeIntentText("play", doc).kind).toBe("transport");
  });

  it("'play it again' is a TRANSPORT command — the repetition adverb must not become an edit", () => {
    // Without this, "play it again" fell out of the transport's bare-word
    // gate, and the conversational memory read it as "repeat the last edit" —
    // a silent fader move the producer never asked for.
    perform("raise the bass by 10%");
    const route = routeIntentText("play it again", doc);
    expect(route.kind).toBe("transport");
    expect((route as { action: string }).action).toBe("play");
  });
});
