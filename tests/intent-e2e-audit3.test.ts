import { describe, expect, it } from "vitest";
import { parseTempoIntent } from "../src/intent/conversation";
import { applyAutomateIntent, parseAutomateIntent } from "../src/intent/studio-words";
import { parseExactIntent } from "../src/intent/exact";
import { applyExactIntentCommand } from "../src/commands/intentRouting";
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
 * 3. Silent defaults: a magnitude-less dB ask ("lower drums db") lands on the
 *    bounded ±2 dB default — legal, but the label must SAY the number was
 *    assumed, not present it as the user's (SILENT-DEFAULT rule).
 */

describe("silent dB default is marked as assumed", () => {
  it("magnitude-less ask lands ±2 dB with assumed: true and the label says so", () => {
    const plan = parseExactIntent("lower drums db")!;
    expect(plan).not.toBeNull();
    const op = plan.ops.find((o) => o.kind === "gainDb");
    expect(op).toMatchObject({ kind: "gainDb", target: "drums", deltaDb: -2, assumed: true });
    expect(plan.label).toContain("-2 dB drums (assumed)");
    const boost = parseExactIntent("boost the mix db")!;
    expect(boost.ops.find((o) => o.kind === "gainDb")).toMatchObject({ deltaDb: 2, assumed: true });
  });

  it("a stated magnitude never carries the assumed flag", () => {
    const plan = parseExactIntent("lower drums by 3 db")!;
    const op = plan.ops.find((o) => o.kind === "gainDb");
    expect(op).toMatchObject({ kind: "gainDb", target: "drums", deltaDb: -3 });
    expect(op && "assumed" in op && op.assumed).toBeFalsy();
    expect(plan.label).not.toContain("assumed");
  });
});

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

describe("master fader domain 0..2 (+6 dB) — the drive-into-the-chain knob", () => {
  it("absolute master asks land the full +6 dB domain and clamp at 2 (was 1.5)", () => {
    const base = createProjectFromTemplate("house");
    const plan = parseExactIntent("master na 5 db")!;
    expect(plan.ops).toContainEqual(expect.objectContaining({ kind: "gainDbAbsolute", target: "mix", absDb: 5 }));
    const next = applyExactIntentCommand(base, plan).execute(base);
    expect(next.master.masterGain).toBeCloseTo(Math.pow(10, 5 / 20), 4); // ≈1.778 — unreachable before
    const loud = applyExactIntentCommand(base, parseExactIntent("master to 10 db")!).execute(base);
    expect(loud.master.masterGain).toBe(2);
  });

  it("master DELTA rides the same domain; tracks keep the 1.5 fader domain", () => {
    const base = createProjectFromTemplate("house");
    const next = applyExactIntentCommand(base, parseExactIntent("boost the mix by 4 db")!).execute(base);
    expect(next.master.masterGain).toBeCloseTo(Math.pow(10, 4 / 20), 3); // ≈1.585 — past the old 1.5 ceiling
    const hot = { ...base, master: { ...base.master, masterGain: 1.8 } };
    const up = applyExactIntentCommand(hot, parseExactIntent("boost the mix by 2 db")!).execute(hot);
    expect(up.master.masterGain).toBe(2);
    // Tracks stay 0..1.5 — only the MASTER widened.
    const drums = applyExactIntentCommand(base, parseExactIntent("drums na 5 db")!).execute(base);
    const drumTrack = drums.tracks.find((t) => t.kind === "drum");
    expect(drumTrack && "gain" in drumTrack ? drumTrack.gain : null).toBe(1.5);
  });
});
