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
import { readFileSync } from "node:fs";
import { routeIntentText } from "../src/intent/route";
import { applyFaderIntent, parseFaderIntent } from "../src/intent/conversation";
import {
  recordEffectAdjustment,
  recordFaderAdjustment,
  recordParamAdjustment,
} from "../src/intent/adjustment-recording";
import { ROUTE_ADJUSTMENT, noteAppliedRoute, noteExternalMutation, noteUndoRedo } from "../src/intent/apply-boundary";
import {
  clearAdjustments,
  lastAdjustment,
  rememberAdjustment,
  type EffectRecord,
  type FaderRecord,
} from "../src/intent/adjustment-ledger";
import { isPriorDeltaReference, stripPriorDeltaReference } from "../src/intent/reference-delta";
import { applyEffectIntent, parseEffectIntent } from "../src/intent/mix";
import { applyParamIntent, parseParamIntent } from "../src/intent/param-intent";
import { resolvePriorAdjustment } from "../src/intent/prior-adjustment";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { addEffectToTracks } from "../src/commands/commands";
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
      kind: "fader",
      docId: "project-a",
      direction: "up",
      factor: 1.35,
      targets: ["bass"],
      pads: [],
      trackIds: [],
      returnIds: [],
    });
    const entry = lastAdjustment("project-a") as FaderRecord;
    expect(entry).not.toBeNull();
    expect(entry!.factor).toBe(1.35);
    expect(entry!.direction).toBe("up");
    expect(entry!.targets).toEqual(["bass"]);
  });

  it("does NOT hand a change of another project back — its track ids name tracks that do not exist here", () => {
    rememberAdjustment({
      kind: "fader",
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
      kind: "fader",
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
    const entry = lastAdjustment(doc.id) as FaderRecord;
    expect(entry).not.toBeNull();
    expect(entry!.direction).toBe("up");
    // The factor is the MEASURED gain change, not the phrase's nominal step.
    expect(entry!.factor).toBeGreaterThan(1);
    expect(entry!.factor).toBeLessThan(1.2);
    expect(entry!.targets).toContain("bass");
  });

  it("'half as much as last time' comes back as a fader move, not a decline", () => {
    perform("raise the bass by 10%");
    const before = (lastAdjustment(doc.id) as FaderRecord).factor;
    const route = routeIntentText("half as much as last time", doc);
    expect(route.kind).toBe("fader");
    const intent = (route as { kind: "fader"; intent: { factor?: number; direction: string } }).intent;
    // A genuine halving: smaller than the remembered move, larger than none.
    expect(intent.factor).toBeGreaterThan(1);
    expect(intent.factor!).toBeLessThan(before);
  });

  it("'as much as last time' comes back as the SAME magnitude", () => {
    perform("raise the bass by 10%");
    const before = (lastAdjustment(doc.id) as FaderRecord).factor;
    const route = routeIntentText("as much as last time", doc);
    expect(route.kind).toBe("fader");
    const intent = (route as { kind: "fader"; intent: { factor?: number } }).intent;
    expect(intent.factor).toBeCloseTo(before, 5);
  });

  it("'same again but on the hats' repeats the move on the NEW target", () => {
    perform("raise the bass by 10%");
    const before = (lastAdjustment(doc.id) as FaderRecord).factor;
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

/**
 * STEP 1 (2026-10-21) — ONE MUTATION BOUNDARY.
 *
 * The ledger used to be updated in six places (UI dispatch + three branches,
 * MCP executor + undo + tool wrapper). The boundary classifies every route
 * kind in one Record and both surfaces call it, so a new route cannot quietly
 * skip the rule. These tests pin the classification, the no-op case and the
 * source ownership.
 */
describe("mutation boundary — one place owns ledger invalidation", () => {
  it("classifies the three recordable routes and the non-mutating routes", () => {
    expect(ROUTE_ADJUSTMENT.fader).toBe("fader");
    expect(ROUTE_ADJUSTMENT.effectIntent).toBe("effect");
    expect(ROUTE_ADJUSTMENT.paramIntent).toBe("param");
    expect(ROUTE_ADJUSTMENT.clarify).toBe("none");
    expect(ROUTE_ADJUSTMENT.queryIntent).toBe("none");
    expect(ROUTE_ADJUSTMENT.transport).toBe("none");
    expect(ROUTE_ADJUSTMENT.select).toBe("none");
    expect(ROUTE_ADJUSTMENT.exact).toBe("other");
    expect(ROUTE_ADJUSTMENT.undoIntent).toBe("other");
    expect(ROUTE_ADJUSTMENT.pattern).toBe("other");
    expect(ROUTE_ADJUSTMENT.revise).toBe("other");
  });

  it("records a fader route that landed, and keeps it across a clarify", () => {
    const intent = parseFaderIntent("turn the bass down a little");
    expect(intent).not.toBeNull();
    const command = applyFaderIntent(doc, intent!);
    expect(command).not.toBeNull();
    const after = command!.execute(doc);
    noteAppliedRoute({ kind: "fader", intent: intent! }, doc, after);
    const entry = lastAdjustment(doc.id) as FaderRecord;
    expect(entry).not.toBeNull();
    expect(entry!.factor).toBeLessThan(1);

    // A clarify does not mutate; the reference stays valid.
    noteAppliedRoute({ kind: "clarify", reason: "param-target", suggestions: [] }, after, after);
    expect(lastAdjustment(doc.id)).toEqual(entry);
  });

  it("clears for a different mutation and for an effect/param change", () => {
    const intent = parseFaderIntent("turn the bass down a little")!;
    const after = applyFaderIntent(doc, intent)!.execute(doc);
    noteAppliedRoute({ kind: "fader", intent }, doc, after);
    expect(lastAdjustment(doc.id)).not.toBeNull();

    const otherMutation = routeIntentText("set tempo to 131", after);
    expect(ROUTE_ADJUSTMENT[otherMutation.kind]).toBe("other");
    noteAppliedRoute(otherMutation, after, after);
    expect(lastAdjustment(doc.id)).toBeNull();

    // Re-record, then an effect change supersedes it.
    noteAppliedRoute({ kind: "fader", intent }, doc, after);
    const effect = routeIntentText("more reverb on the pads", after);
    expect(effect.kind).toBe("effectIntent");
    noteAppliedRoute(effect, after, after);
    expect(lastAdjustment(doc.id)).toBeNull();
  });

  it("undo/redo clears only when it actually moved, external mutation always clears", () => {
    const intent = parseFaderIntent("turn the bass down a little")!;
    const after = applyFaderIntent(doc, intent)!.execute(doc);
    noteAppliedRoute({ kind: "fader", intent }, doc, after);
    noteUndoRedo(0);
    expect(lastAdjustment(doc.id)).not.toBeNull();
    noteUndoRedo(1);
    expect(lastAdjustment(doc.id)).toBeNull();

    noteAppliedRoute({ kind: "fader", intent }, doc, after);
    noteExternalMutation();
    expect(lastAdjustment(doc.id)).toBeNull();
  });

  it("the UI and MCP surfaces cannot bypass the boundary with the recorder", () => {
    const surfaces = ["src/ui/IntentPanel.tsx", "src/mcp/tools.ts"];
    for (const path of surfaces) {
      const source = readFileSync(path, "utf8");
      expect(source, path).toContain("apply-boundary");
      expect(source, path).not.toContain("adjustment-recording");
    }
    const boundary = readFileSync("src/intent/apply-boundary.ts", "utf8");
    expect(boundary).toContain("adjustment-recording");
  });
});

/**
 * C (2026-10-22) — the ledger now covers effect and param moves too.
 *
 * The measured step is the number the resolver scales: half of an effect knob
 * step is half the knob range; half of a param fraction is half the param
 * range. "One step further" is a reuse of that measured step.
 */
describe("prior adjustment — effect and param moves", () => {
  const mixOf = (document: ProjectDocument, trackName: string): number => {
    const track = document.tracks.find((entry) => entry.name === trackName);
    const effect = track?.effects.find((entry) => entry.type === "reverb");
    if (!effect) throw new Error(`no reverb on ${trackName}`);
    return effect.params.mix;
  };
  const decayOf = (document: ProjectDocument, trackName: string): number => {
    const track = document.tracks.find((entry) => entry.name === trackName);
    const effect = track?.effects.find((entry) => entry.type === "reverb");
    if (!effect) throw new Error(`no reverb on ${trackName}`);
    return effect.params.decay;
  };

  it("half of an effect move is half the knob step", () => {
    const intent = parseEffectIntent("slightly more reverb on the pads")!;
    const after1 = applyEffectIntent(doc, intent)!.execute(doc);
    const beforeMix = 0.3; // reverb.mix default
    recordEffectAdjustment(doc.id, intent, doc, after1);
    const half = resolvePriorAdjustment("half that adjustment", after1);
    expect(half?.kind).toBe("effect");
    if (half?.kind !== "effect") return;
    const after2 = applyEffectIntent(after1, half.intent)!.execute(after1);
    const firstDelta = mixOf(after1, "Chords") - beforeMix;
    const secondDelta = mixOf(after2, "Chords") - mixOf(after1, "Chords");
    expect(firstDelta).toBeGreaterThan(0);
    expect(secondDelta).toBeCloseTo(firstDelta / 2, 3);
  });

  it("'do the same on the bass' reuses the effect step on the new family", () => {
    const intent = parseEffectIntent("slightly more reverb on the pads")!;
    const after1 = applyEffectIntent(doc, intent)!.execute(doc);
    recordEffectAdjustment(doc.id, intent, doc, after1);
    const entry = lastAdjustment(doc.id) as EffectRecord;
    const same = resolvePriorAdjustment("do the same on the bass", after1);
    expect(same?.kind).toBe("effect");
    if (same?.kind !== "effect") return;
    expect(same.intent.targets).toEqual(["bass"]);
    const bass = doc.tracks.find((track) => track.name === "808")!;
    const added = addEffectToTracks(after1, [bass.id], "reverb").execute(after1);
    const beforeBass = mixOf(added, "808");
    const after2 = applyEffectIntent(after1, same.intent)!.execute(after1);
    expect(mixOf(after2, "808") - beforeBass).toBeCloseTo(entry.stepFraction, 3);
  });

  it("half of a param move is half the range fraction", () => {
    const intent = parseParamIntent("slightly longer reverb decay on the 808")!;
    const after1 = applyParamIntent(doc, intent)!.execute(doc);
    recordParamAdjustment(doc.id, intent, doc, after1);
    const half = resolvePriorAdjustment("half that adjustment", after1);
    expect(half?.kind).toBe("param");
    if (half?.kind !== "param") return;
    const after2 = applyParamIntent(after1, half.intent)!.execute(after1);
    const firstDelta = decayOf(after1, "808") - 1.8;
    const secondDelta = decayOf(after2, "808") - decayOf(after1, "808");
    expect(firstDelta).toBeGreaterThan(0);
    expect(secondDelta).toBeCloseTo(firstDelta / 2, 2);
  });

  it("'one step further' repeats the measured step", () => {
    perform("turn down the bass a little");
    const entry = lastAdjustment(doc.id) as FaderRecord;
    const next = resolvePriorAdjustment("one step further", doc);
    expect(next?.kind).toBe("fader");
    if (next?.kind !== "fader") return;
    expect(next.intent.factor).toBeCloseTo(entry.factor, 6);
  });

  it("a newer effect move supersedes the older fader record", () => {
    perform("turn down the bass a little");
    const intent = parseEffectIntent("slightly more reverb on the pads")!;
    const after = applyEffectIntent(doc, intent)!.execute(doc);
    recordEffectAdjustment(doc.id, intent, doc, after);
    expect(resolvePriorAdjustment("half that adjustment", after)?.kind).toBe("effect");
  });
});

describe("prior adjustment — ordinal targets", () => {
  it("reuses an effect on an ordinal track", () => {
    const first = parseEffectIntent("slightly more reverb on the pads")!;
    const after1 = applyEffectIntent(doc, first)!.execute(doc);
    recordEffectAdjustment(doc.id, first, doc, after1);
    const same = resolvePriorAdjustment("do the same on track two", after1);
    expect(same?.kind).toBe("effect");
    if (same?.kind !== "effect") return;
    const target = doc.tracks.filter((track) => track.kind !== "group")[1]!;
    expect(same.intent.trackIds).toEqual([target.id]);
    const after2 = applyEffectIntent(after1, same.intent)!.execute(after1);
    expect(after2.tracks.find((track) => track.id === target.id)?.effects.some((fx) => fx.type === "reverb")).toBe(
      true,
    );
  });

  it("reuses a param move on an ordinal track", () => {
    const first = parseParamIntent("slightly longer reverb decay on the 808")!;
    const after1 = applyParamIntent(doc, first)!.execute(doc);
    recordParamAdjustment(doc.id, first, doc, after1);
    const same = resolvePriorAdjustment("do the same on track three", after1);
    expect(same?.kind).toBe("param");
    if (same?.kind !== "param") return;
    const target = doc.tracks.filter((track) => track.kind !== "group")[2]!;
    expect(same.intent.trackIds).toEqual([target.id]);
    const after2 = applyParamIntent(after1, same.intent)!.execute(after1);
    const reverb = after2.tracks.find((track) => track.id === target.id)?.effects.find((fx) => fx.type === "reverb");
    expect(reverb?.params.decay).toBeCloseTo(1.98, 2);
  });

  it("records an ordinal effect and halves on the SAME track", () => {
    const first = parseEffectIntent("slightly more reverb on track three")!;
    const after1 = applyEffectIntent(doc, first)!.execute(doc);
    recordEffectAdjustment(doc.id, first, doc, after1);
    const entry = lastAdjustment(doc.id) as EffectRecord;
    const target = doc.tracks.filter((track) => track.kind !== "group")[2]!;
    expect(entry.trackIds).toEqual([target.id]);
    const half = resolvePriorAdjustment("half that adjustment", after1);
    expect(half?.kind).toBe("effect");
    if (half?.kind !== "effect") return;
    expect(half.intent.trackIds).toEqual([target.id]);
    expect(half.intent.targets).toEqual([]);
  });
});
