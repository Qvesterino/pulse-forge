import { describe, expect, it } from "vitest";
import { buildMiningCycleReport, buildMinedCorpus, guessLang } from "../src/intent/mining-cycle";
import type { IntentMiningEvent } from "../src/intent/failure-log";
import { datasetDoc } from "../scripts/intent-sft-doc.mjs";

/**
 * MINING CYCLE (2026-10-11) — the mining→retraining loop's pure core. The
 * mined producer sentences used to die in a browser localStorage ring
 * buffer; the cycle classifies them against the CURRENT engine: a miss that
 * today routes to a real action is RESOLVED (dataset-ready — it pins the
 * resolution against regression), one that still falls through to
 * pattern/clarify is STILL-FAILING (human work). Model-hits are wins, not
 * misses.
 */

const doc = datasetDoc();
let ts = 1000;
function event(partial: Omit<IntentMiningEvent, "ts">): IntentMiningEvent {
  return { ...partial, ts: ts++ };
}

describe("buildMiningCycleReport", () => {
  it("classifies resolved vs still-failing and excludes model hits", () => {
    const report = buildMiningCycleReport(
      [
        event({ prompt: "add a fill before every chorus", outcome: "model-miss", count: 3 }),
        event({ prompt: "make the bridge more energetic", outcome: "model-hit", routeKind: "revise", count: 2 }),
        event({ prompt: "no lead in the intro", outcome: "model-miss" }),
      ],
      doc,
    );
    expect(report.totalEvents).toBe(3);
    expect(report.modelHits).toBe(1);
    expect(report.misses).toBe(2);
    // The fill command routes to arrange TODAY (the structural-command wave
    // resolved it) — dataset-ready with the route summary.
    const resolved = report.resolved.find((row) => row.prompt === "add a fill before every chorus");
    expect(resolved?.hits).toBe(3);
    expect(resolved?.routeKind).toBe("arrange");
    // The intro-lead ask still falls to generation — honest human work.
    const failing = report.stillFailing.find((row) => row.prompt === "no lead in the intro");
    expect(failing?.routeKind).toBe("pattern");
  });

  it("sums collapsed repeat counts and sorts by frequency", () => {
    const report = buildMiningCycleReport(
      [
        event({ prompt: "rare ask", outcome: "clarify" }),
        event({ prompt: "common ask", outcome: "clarify", count: 7 }),
        event({ prompt: "common ask", outcome: "clarify", count: 2 }),
      ],
      doc,
    );
    expect(report.stillFailing[0]?.prompt).toBe("common ask");
    expect(report.stillFailing[0]?.hits).toBe(9);
  });

  it("is stable across runs (pure — no clock, no storage)", () => {
    const events = [event({ prompt: "add a riser into the drop", outcome: "model-miss" })];
    const a = buildMiningCycleReport(events, doc);
    const b = buildMiningCycleReport(events, doc);
    expect(b).toEqual(a);
  });
});

describe("mined corpus sidecar", () => {
  it("builds dataset rows with a language guess", () => {
    const report = buildMiningCycleReport(
      [
        event({ prompt: "add a fill before every chorus", outcome: "model-miss", count: 2 }),
        event({ prompt: "pridaj break pred most", outcome: "model-miss" }),
      ],
      doc,
    );
    const corpus = buildMinedCorpus(report);
    expect(corpus.version).toBe(1);
    expect(corpus.rows).toHaveLength(2);
    expect(corpus.rows.map((row) => row.lang)).toEqual(["en", "sk"]);
    for (const row of corpus.rows) {
      expect(row.kind, `${row.instruction} kind`).not.toBe("pattern");
      expect(row.kind).not.toBe("clarify");
    }
  });

  it("guessLang reads SK diacritics and stems", () => {
    expect(guessLang("add a fill")).toBe("en");
    expect(guessLang("pridaj fill")).toBe("sk");
    expect(guessLang("hustejší beat")).toBe("sk");
  });
});
