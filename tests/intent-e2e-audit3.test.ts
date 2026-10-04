import { describe, expect, it } from "vitest";
import { parseTempoIntent } from "../src/intent/conversation";
import { applyAutomateIntent, parseAutomateIntent } from "../src/intent/studio-words";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { createDrumTrackModel, createInstrumentTrackModel } from "../src/project-model/schema";
import { MAX_BPM, MIN_BPM } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * INTENT E2E AUDIT 3 (re-run 2026-10) — parser/window contract consistency.
 *
 * 1. BPM windows: three different clamp windows coexisted — exact parser and
 *    normalizeProject accept 20..300 (= MIN_BPM/MAX_BPM, what setBpm enforces)
 *    but the tempo-word parser gated 40..220. "Set tempo to 250" executed
 *    while "tempo na 250" silently declined and fell through to generation.
 * 2. Automate no-guessing: applyAutomateIntent fell back to tracks[0] for ANY
 *    project when no family was named — the strict no-positional-guess rule
 *    (pinned for transpose in intent-e2e-audit2) did not hold here. The
 *    fallback is now restricted to the case its comment actually described:
 *    a project with exactly one non-group lane.
 */

describe("tempo intent window (MIN_BPM..MAX_BPM everywhere)", () => {
  it("accepts the full authoritative window through the tempo-word parser", () => {
    expect(parseTempoIntent("tempo na 250")).toEqual({ direction: "set", bpm: 250 });
    expect(parseTempoIntent("tempo to 300")).toEqual({ direction: "set", bpm: 300 });
    expect(parseTempoIntent("tempo na 20")).toEqual({ direction: "set", bpm: 20 });
  });

  it("still declines beyond the authoritative window (no silent clamping at parse)", () => {
    expect(parseTempoIntent("tempo na 350")).toBeNull();
    expect(parseTempoIntent("tempo to 10")).toBeNull();
  });

  it("the parser window and the command window are the same constants", () => {
    expect(MIN_BPM).toBe(20);
    expect(MAX_BPM).toBe(300);
  });
});

describe("automate intent — no positional guessing", () => {
  it("declines on a multi-track project when no family is named (pre-fix: automated tracks[0])", () => {
    const base = createProjectFromTemplate("house");
    const extra = createDrumTrackModel("Perc");
    const lead = createInstrumentTrackModel("analog", 0);
    const doc = { ...base, tracks: [...base.tracks, extra, lead] } as ProjectDocument;
    const intent = parseAutomateIntent("automate the volume from 20 to 100");
    expect(intent).not.toBeNull();
    expect(applyAutomateIntent(doc, intent!, null)).toBeNull();
    // Nothing was written — declining happens before any lane is added.
    expect(doc.automation.length).toBe(base.automation.length);
  });

  it("named family still resolves and stays one snapshot", () => {
    const base = createProjectFromTemplate("house");
    const intent = parseAutomateIntent("automate the bass volume from 0 to 100");
    expect(intent).not.toBeNull();
    const cmd = applyAutomateIntent(base, intent!, null);
    expect(cmd).not.toBeNull();
    const next = cmd!.execute(base);
    const lane = next.automation[next.automation.length - 1];
    expect(lane.target.kind).toBe("trackGain");
  });

  it("single non-group lane keeps the unambiguous fallback", () => {
    const base = createProjectFromTemplate("house");
    // Reduce to exactly one non-group track.
    const only = base.tracks.find((t) => t.kind !== "group")!;
    const doc = { ...base, tracks: [only, ...base.tracks.filter((t) => t.kind === "group")] } as ProjectDocument;
    const nonGroup = doc.tracks.filter((t) => t.kind !== "group");
    expect(nonGroup.length).toBe(1);
    const intent = parseAutomateIntent("automate the volume from 20 to 100");
    const cmd = applyAutomateIntent(doc, intent!, null);
    expect(cmd).not.toBeNull();
    const next = cmd!.execute(doc);
    expect(next.automation.length).toBe(doc.automation.length + 1);
  });
});
