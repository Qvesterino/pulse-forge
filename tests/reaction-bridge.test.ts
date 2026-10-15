import { beforeEach, describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { routeIntentText, type RoutedIntent } from "../src/intent/route";
import { describeIntentAction, noteIntentProposal } from "../src/intent/reaction-bridge";
import { ReactionLedger, sanitizeAction, setActiveReactionLedger } from "../src/intent/reaction-ledger";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * REGRESSION PINS FOR THE F1 GLUE — `src/intent/reaction-bridge.ts`.
 *
 * The bridge shipped in a state where every row it wrote was content-free, and
 * every spec in the suite was green: 19/19 on the ledger itself. The ledger was
 * not the problem — it was handed nothing worth recording. These tests exist so
 * that "green" cannot mean "content-free" again.
 *
 * The three defects, each with the test that now breaks it:
 *
 *  1. The action column was constant (`adjust:unknown:abs` on every row),
 *     because the compact-response envelope was passed where
 *     `{verb, subject, relative}` was expected.   → "the action column is not constant"
 *  2. The before/after pair was vacuous (both hashes over the track-id LIST,
 *     identical across a parameter change), so F2's teacher pair was empty by
 *     construction.                              → "a parameter change produces a real pair"
 *  3. `trackIds` carried FAMILY tokens ("drums", "lead") into a field the
 *     ledger matches document track ids against — so `noteUserEdit` could never
 *     match and the `tweaked` outcome was unreachable in production.
 *                                                → "families never reach trackIds"
 *                                                → "the tweaked outcome is reachable"
 *
 * A fourth pin is the privacy promise in behavioural form: renaming a track is
 * not a mix change, and the ledger must not record it as one.
 */

let clock = 1_000;
let ledger: ReactionLedger;

beforeEach(() => {
  clock = 1_000;
  let counter = 0;
  ledger = new ReactionLedger({ now: () => clock, newId: () => `rx-test-${++counter}` });
  setActiveReactionLedger(ledger);
});

/** The table below is deliberately synthetic: it pins the descriptor, not the parser. */
const route = (value: unknown): RoutedIntent => value as RoutedIntent;

function fresh(): ProjectDocument {
  return createProjectFromTemplate("house");
}

function withTrackChanged(doc: ProjectDocument, trackId: string, patch: Record<string, unknown>): ProjectDocument {
  return {
    ...doc,
    tracks: doc.tracks.map((track) => (track.id === trackId ? { ...track, ...patch } : track)),
  } as unknown as ProjectDocument;
}

function firstEntry(): ReturnType<ReactionLedger["entries"]>[number] {
  const rows = ledger.entries();
  expect(rows.length).toBeGreaterThan(0);
  return rows[0];
}

describe("F1 glue — the action column", () => {
  // The exact token per route. A table, not a spot check: the defect was that
  // the column was CONSTANT, so what matters is that it varies the way the
  // parse says it should — relative vs absolute is the real signal here.
  const cases: Array<[RoutedIntent, string]> = [
    [route({ kind: "fader", intent: { targets: ["lead"], direction: "up" } }), "adjust:trackGain:rel"],
    [route({ kind: "fader", intent: { targets: ["bass"], direction: "down", amount: "big" } }), "adjust:trackGain:rel"],
    [route({ kind: "fader", intent: { targets: ["bass"], direction: "set", percent: 0.5 } }), "set:trackGain:abs"],
    [route({ kind: "fader", intent: { targets: ["master"], direction: "set", percent: 0.8 } }), "set:master:abs"],
    [route({ kind: "tempo", intent: { direction: "set", bpm: 140 } }), "bpm:tempo:abs"],
    [route({ kind: "tempo", intent: { direction: "up" } }), "adjust:tempo:rel"],
    [route({ kind: "paramIntent", intent: { mode: "set", value: 0.4 } }), "set:param:abs"],
    [route({ kind: "paramIntent", intent: { mode: "less" } }), "adjust:param:rel"],
    [route({ kind: "effectIntent", intent: { direction: "more" } }), "adjust:effect:rel"],
    [route({ kind: "effectIntent", intent: { direction: "set" } }), "set:effect:abs"],
    [route({ kind: "effectIntent", intent: { direction: "remove" } }), "remove:effect:abs"],
    [route({ kind: "sendIntent", intent: { direction: "more" } }), "adjust:effect:rel"],
    [route({ kind: "bypassIntent", intent: { bypassed: true } }), "bypass:effect:abs"],
    [route({ kind: "mix", overrides: {}, detected: ["warm"] }), "mix:sceneMix:rel"],
    [route({ kind: "loudness", parse: { direction: "louder", detected: [] } }), "adjust:master:rel"],
    [
      route({ kind: "loudness", parse: { direction: "louder", targetDb: -6, detected: ["bass"] } }),
      "adjust:trackGain:abs",
    ],
    [route({ kind: "preset", intent: {} }), "set:preset:abs"],
    [route({ kind: "markerIntent", intent: { action: "add", bar: 9 } }), "add:marker:abs"],
    [route({ kind: "markerIntent", intent: { action: "remove", bar: 9 } }), "remove:marker:abs"],
    [route({ kind: "grooveIntent", intent: { direction: "swingUp" } }), "adjust:param:rel"],
    [route({ kind: "arrange", ops: [], unrecognized: [] }), "arrange:scene:abs"],
    [route({ kind: "clips", ops: [] }), "arrange:clip:abs"],
    [route({ kind: "production", intent: {} }), "generate:pattern:abs"],
    [route({ kind: "sectionProduction", targetRole: "chorus", intent: {}, detected: [] }), "generate:pattern:abs"],
    [
      route({ kind: "revise", attribute: "drums", direction: "more", detected: [], targetRole: null }),
      "generate:pattern:abs",
    ],
    [
      route({ kind: "exact", plan: { label: "", ops: [{ kind: "gainDb", target: "bass", deltaDb: -3 }] } }),
      "adjust:trackGain:rel",
    ],
    [
      route({ kind: "exact", plan: { label: "", ops: [{ kind: "gainDbAbsolute", target: "bass", absDb: -6 }] } }),
      "set:trackGain:abs",
    ],
    [
      route({ kind: "exact", plan: { label: "", ops: [{ kind: "pan", target: "lead", value: -0.5 }] } }),
      "set:trackPan:abs",
    ],
    [route({ kind: "exact", plan: { label: "", ops: [{ kind: "swing", percent: 60 }] } }), "set:param:abs"],
  ];

  it.each(cases)("describes %# as %s", (candidate, token) => {
    expect(sanitizeAction(describeIntentAction(candidate))).toBe(token);
  });

  it("the action column is not constant", () => {
    const tokens = cases.map(([candidate]) => sanitizeAction(describeIntentAction(candidate)));
    expect(new Set(tokens).size).toBeGreaterThanOrEqual(12);
    expect(tokens).not.toContain("adjust:unknown:abs");
  });

  it("a mixed exact plan is not attributed to whichever op was read last", () => {
    // Heterogeneous plan → the honest degradation, not a guess.
    expect(
      sanitizeAction(
        describeIntentAction(
          route({
            kind: "exact",
            plan: {
              label: "",
              ops: [
                { kind: "pan", target: "lead", value: -0.5 },
                { kind: "addTrack", trackKind: "instrument", instrument: "piano" },
              ],
            },
          }),
        ),
      ),
    ).toBe("adjust:unknown:abs");
  });
});

describe("F1 glue — the before/after pair", () => {
  it("the recorded row carries the descriptor, not an envelope", () => {
    // The table above pins describeIntentAction in isolation. This pins the
    // WIRING: the value that reaches ledger.register must be the descriptor.
    // Falsifying the bridge back to the compact-response envelope must turn
    // this test red — the table cannot, it never touches the bridge.
    const doc = fresh();
    const bass = doc.tracks[0];
    noteIntentProposal(
      routeIntentText("zvys bass", doc),
      doc,
      withTrackChanged(doc, bass.id, { gain: bass.gain + 0.2 }),
      1,
    );
    expect(firstEntry().action).toBe("adjust:trackGain:rel");

    noteIntentProposal(
      route({ kind: "fader", intent: { targets: ["bass"], direction: "set", percent: 0.5 } }),
      doc,
      withTrackChanged(doc, bass.id, { gain: 0.5 }),
      2,
    );
    // entries() is [pending oldest-first, history newest-first]; both rows are
    // still pending here, so the newest proposal is the LAST one.
    expect(ledger.entries().at(-1)?.action).toBe("set:trackGain:abs");
  });

  it("a parameter change produces a real pair", () => {
    const doc = fresh();
    const bass = doc.tracks[0];
    const asked = routeIntentText("zvys bass", doc);
    expect(asked.kind).toBe("fader");

    noteIntentProposal(asked, doc, withTrackChanged(doc, bass.id, { gain: bass.gain + 0.12 }), 1);

    const row = firstEntry();
    expect(row.beforeHash).not.toBe("");
    expect(row.afterHash).not.toBe("");
    expect(row.beforeHash).not.toBe(row.afterHash);
    expect(row.trackIds).toEqual([bass.id]);
    expect(row.action).not.toBe("adjust:unknown:abs");
  });

  it("an effect parameter change is visible too — not only track gain", () => {
    const doc = fresh();
    const track = doc.tracks[0];
    const withEffect = {
      ...doc,
      tracks: doc.tracks.map((candidate) =>
        candidate.id === track.id
          ? {
              ...candidate,
              effects: [
                ...candidate.effects,
                { id: "fx-1", type: "reverb", mix: 0.3, bypassed: false, params: { decay: 1.2 } },
              ],
            }
          : candidate,
      ),
    } as unknown as ProjectDocument;
    const after = {
      ...withEffect,
      tracks: withEffect.tracks.map((candidate) =>
        candidate.id === track.id
          ? { ...candidate, effects: candidate.effects.map((fx) => (fx.id === "fx-1" ? { ...fx, mix: 0.62 } : fx)) }
          : candidate,
      ),
    } as unknown as ProjectDocument;

    noteIntentProposal(route({ kind: "effectIntent", intent: { direction: "more" } }), withEffect, after, 1);
    expect(firstEntry().beforeHash).not.toBe(firstEntry().afterHash);
  });

  it("a tempo change moves no track, and still gets a real pair", () => {
    const doc = fresh();
    const after = { ...doc, bpm: doc.bpm + 12 } as ProjectDocument;
    noteIntentProposal(route({ kind: "tempo", intent: { direction: "up" } }), doc, after, 1);
    const row = firstEntry();
    expect(row.beforeHash).not.toBe(row.afterHash);
    expect(row.trackIds).toEqual([]);
  });

  it("a proposal that changed nothing is not recorded", () => {
    const doc = fresh();
    noteIntentProposal(route({ kind: "fader", intent: { targets: ["bass"], direction: "up" } }), doc, doc, 1);
    // A query, a no-op command, or a re-ask that landed on the current value
    // must not become a "kept" reaction — it would inflate the keep-rate with
    // machine actions the human never heard.
    expect(ledger.entries()).toEqual([]);
  });

  it("renaming a track is not a mix change", () => {
    const doc = fresh();
    const track = doc.tracks[0];
    const renamed = withTrackChanged(doc, track.id, { name: "Môj vlastný bas" });
    noteIntentProposal(route({ kind: "fader", intent: { targets: ["bass"], direction: "up" } }), doc, renamed, 1);
    // The user's own words never enter the recorded state.
    expect(ledger.entries()).toEqual([]);
  });
});

describe("F1 glue — affected tracks", () => {
  it("families never reach trackIds", () => {
    const doc = fresh();
    const bass = doc.tracks[0];
    // A fader ask names a FAMILY ("bass"), not a document track id.
    const asked = routeIntentText("zvys bass", doc);
    noteIntentProposal(asked, doc, withTrackChanged(doc, bass.id, { gain: bass.gain + 0.2 }), 1);

    const row = firstEntry();
    expect(row.trackIds).toEqual([bass.id]);
    expect(row.trackIds).not.toContain("bass");
  });

  it("the tweaked outcome is reachable", () => {
    const doc = fresh();
    const bass = doc.tracks[0];
    const asked = routeIntentText("zvys bass", doc);
    noteIntentProposal(asked, doc, withTrackChanged(doc, bass.id, { gain: bass.gain + 0.2 }), 1);

    // 90 s later the proposal is kept; a human edit on the SAME track must
    // find it. Before the fix the entry carried "bass" instead of the track
    // id, this lookup returned null, and the correction pair F2 depends on
    // could never be formed.
    clock += 91_000;
    const tweaked = ledger.noteUserEdit([bass.id]);
    expect(tweaked).not.toBeNull();
    expect(tweaked?.outcome).toBe("tweaked");
    expect(tweaked?.beforeHash).not.toBe(tweaked?.afterHash);
  });

  it("an edit on an unrelated track is not this proposal's correction", () => {
    const doc = fresh();
    const bass = doc.tracks[0];
    const other = doc.tracks[1];
    expect(other).toBeDefined();
    noteIntentProposal(
      routeIntentText("zvys bass", doc),
      doc,
      withTrackChanged(doc, bass.id, { gain: bass.gain + 0.2 }),
      1,
    );

    clock += 91_000;
    expect(ledger.noteUserEdit([other.id])).toBeNull();
  });
});
