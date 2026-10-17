import { describe, expect, it } from "vitest";
import { buildSessionStory, verdictForGeneration, type SessionStoryInput } from "../src/services/sessionStory";
import type { ReactionEntry } from "../src/intent/reaction-ledger";
import type { TapeStep } from "../src/intent/session-tape";

/**
 * SESSION STORY — the readable account, and its honesty rule.
 *
 * The load-bearing spec is the NEGATIVE: a step without a measured rationale
 * must print NOTHING about why. A story that fills the gap with plausible prose
 * is worse than a terse one, because a record that editorializes cannot be
 * trusted as a record.
 */

function step(overrides: Partial<TapeStep> = {}): TapeStep {
  return {
    id: "tape-1",
    at: Date.parse("2026-10-17T14:12:00.000Z"),
    docId: "doc-1",
    prompt: "dark trap at 142",
    outcome: "generated",
    routeKind: "generation",
    action: "generate:pattern:abs",
    undoDepthAfter: null,
    abandoned: false,
    ...overrides,
  };
}

function entry(overrides: Partial<ReactionEntry> = {}): ReactionEntry {
  return {
    id: "rx-1",
    createdAt: 1,
    routeKind: "candidateUse",
    action: "generate:pattern:abs",
    trackIds: [],
    beforeHash: "aaaaaaaa",
    afterHash: "bbbbbbbb",
    outcome: "kept",
    resolvedAt: 2,
    ...overrides,
  };
}

function input(overrides: Partial<SessionStoryInput> = {}): SessionStoryInput {
  return {
    docName: "House Beat",
    docId: "doc-1",
    generatedAt: new Date("2026-10-17T15:00:00.000Z"),
    contentHash: "c".repeat(64),
    steps: [],
    reactionEntries: [],
    reactions: { kept: 1, undone: 1, tweaked: 0, pending: 0 },
    ai: { assets: 1, patterns: 0, tracks: 0, models: ["mrt2/mrt2_small"] },
    exportStamp: { fileName: "beat-master.wav", hash: "d".repeat(64), renderedAt: "2026-10-17T14:40:00.000Z" },
    ...overrides,
  };
}

describe("verdictForGeneration", () => {
  it("joins by the generation identity and lets the LATEST entry win", () => {
    const entries = [
      entry({ id: "a", generationId: "gen-1", candidateIndex: 2, outcome: "kept" }),
      entry({ id: "b", generationId: "gen-1", candidateIndex: 2, outcome: "undone" }),
      entry({ id: "c", generationId: "gen-2", outcome: "kept" }),
    ];
    expect(verdictForGeneration(entries, "gen-1")).toMatchObject({ outcome: "undone", candidateIndex: 2 });
    expect(verdictForGeneration(entries, "gen-2")?.outcome).toBe("kept");
  });

  it("returns null without an id or without a match (nothing invented)", () => {
    expect(verdictForGeneration([entry({ generationId: "gen-1" })], undefined)).toBeNull();
    expect(verdictForGeneration([entry({ generationId: "gen-1" })], "gen-9")).toBeNull();
  });
});

describe("buildSessionStory — the record", () => {
  it("prints steps oldest-first, with the measured reason ONLY where one exists", () => {
    const story = buildSessionStory(
      input({
        steps: [
          step({
            id: "t3",
            at: Date.parse("2026-10-17T14:26:00.000Z"),
            outcome: "applied",
            routeKind: "fader",
            action: "adjust:trackGain:rel",
            prompt: "Turn the drums up a bit",
            detail: undefined,
          }),
          step({
            id: "t2",
            at: Date.parse("2026-10-17T14:13:00.000Z"),
            outcome: "applied-candidate",
            routeKind: "candidateUse",
            action: "generate:pattern:abs",
            prompt: "dark trap at 142",
            generationId: "gen-1",
            candidateIndex: 1,
            detail: "candidate #2",
          }),
          step({
            id: "t1",
            generationId: "gen-1",
            rationale: "Highest deterministic fit score in the bank (0.912). Clear lead over the runner-up (+0.084).",
          }),
        ],
        reactionEntries: [entry({ generationId: "gen-1", candidateIndex: 1, outcome: "kept" })],
      }),
    );

    // Step-level reasons are the indented "Why:" lines; the legend below also
    // explains the marker, so match the indentation, not the word.
    const whyLines = story.markdown.split("\n").filter((line) => line.startsWith("   Why:"));
    expect(whyLines).toHaveLength(1);
    expect(whyLines[0]).toContain("Highest deterministic fit score");

    // Oldest first: the generation precedes its application, which precedes the fader move.
    const generationAt = story.markdown.indexOf('⚡ "dark trap at 142"');
    const appliedAt = story.markdown.indexOf("★");
    const faderAt = story.markdown.indexOf("Turn the drums up a bit");
    expect(generationAt).toBeGreaterThan(-1);
    expect(appliedAt).toBeGreaterThan(generationAt);
    expect(faderAt).toBeGreaterThan(appliedAt);

    // The verdict is joined by the generation identity, for BOTH steps that carry it.
    expect(story.markdown).toContain("candidate #2: kept (heard and not reverted)");
    expect(story.markdown).toContain('"House Beat"');
    expect(story.markdown).toContain("1 generated asset(s)");
    expect(story.markdown).toContain("mrt2/mrt2_small");
    expect(story.markdown).toContain(`npx kyx-verify <file.wav> --expect ${"d".repeat(64)}`);
  });

  it("marks a DETACHED step and counts the branch in the header", () => {
    const story = buildSessionStory(
      input({
        steps: [
          step({
            id: "t2",
            outcome: "applied",
            routeKind: "fader",
            action: "adjust:trackGain:rel",
            prompt: "up a bit",
            abandoned: true,
          }),
          step({ id: "t1", prompt: "dark trap at 142" }),
        ],
      }),
    );
    expect(story.markdown).toContain("1 detached by a rewind");
    expect(story.markdown).toContain("detached — a rewind left this branch");
  });

  it("explains a clarify step without pretending it applied something", () => {
    const story = buildSessionStory(
      input({
        steps: [
          step({
            outcome: "clarify",
            routeKind: "clarify",
            action: "clarify",
            prompt: "make it fuller",
            detail: "send or return?",
          }),
        ],
      }),
    );
    expect(story.markdown).toContain("needed disambiguation");
    expect(story.markdown).toContain("send or return?");
    expect(story.markdown.split("\n").some((line) => line.startsWith("   Why:"))).toBe(false);
  });

  it("says so when the session has no steps, and when nothing is available", () => {
    const empty = buildSessionStory(input({ steps: [], reactions: null, ai: null, exportStamp: null }));
    expect(empty.markdown).toContain("No steps were recorded in this session yet.");
    expect(empty.markdown).toContain("learning ledger is not available");
    expect(empty.markdown).toContain("Not available in this environment.");
    expect(empty.markdown).toContain("No export was stamped in this session");

    const nothingAi = buildSessionStory(
      input({ steps: [step()], ai: { assets: 0, patterns: 0, tracks: 0, models: [] } }),
    );
    expect(nothingAi.markdown).toContain("No AI-generated material is placed in this project.");
  });

  it("mirrors the steps and verdicts in the machine-readable JSON", () => {
    const story = buildSessionStory(
      input({
        steps: [step({ generationId: "gen-1", rationale: "Highest deterministic fit score in the bank (0.9)." })],
        reactionEntries: [entry({ generationId: "gen-1", candidateIndex: 0, outcome: "undone" })],
      }),
    );
    const json = story.json as { format: string; steps: Array<Record<string, unknown>> };
    expect(json.format).toBe("kyx-session-story/1");
    expect(json.steps).toHaveLength(1);
    expect(json.steps[0]).toMatchObject({
      generationId: "gen-1",
      rationale: "Highest deterministic fit score in the bank (0.9).",
      verdict: { outcome: "undone", candidateIndex: 0 },
    });
  });
});
