import { describe, it, expect, beforeEach } from "vitest";
import {
  INTENT_FAILURE_LOG_KEY,
  INTENT_FAILURE_LOG_CAP,
  logIntentMiningEvent,
  readIntentMiningLog,
  clearIntentMiningLog,
  exportIntentMiningLog,
  installIntentFailureDevtools,
} from "../src/intent/failure-log";

/**
 * INTENT FAILURE MINING — the local ring-buffer that records what the intent
 * engine could not resolve (clarify shows, model misses, chip recoveries).
 * Pins: persistence round-trip, consecutive-duplicate collapse, FIFO cap,
 * corrupt-storage recovery, export shape, and the console devtools handle.
 */

beforeEach(() => {
  localStorage.clear();
});

describe("intent failure mining log", () => {
  it("appends events with ts and count, reads them back", () => {
    logIntentMiningEvent({ prompt: "sprav to hustejšie", outcome: "clarify", reason: "ktorý fader?" });
    logIntentMiningEvent({ prompt: "make the hats shimmer", outcome: "model-miss" });
    logIntentMiningEvent({ prompt: "turn down the drums", outcome: "model-hit", routeKind: "fader" });
    const events = readIntentMiningLog();
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ prompt: "sprav to hustejšie", outcome: "clarify", count: 1 });
    expect(events[1]).toMatchObject({ outcome: "model-miss" });
    expect(events[2]).toMatchObject({ outcome: "model-hit", routeKind: "fader" });
    for (const event of events) expect(event.ts).toBeGreaterThan(0);
  });

  it("collapses consecutive identical asks into a count instead of spamming", () => {
    for (let i = 0; i < 5; i += 1) {
      logIntentMiningEvent({ prompt: "hlasnejšie", outcome: "clarify", reason: "ktorý fader?" });
    }
    const events = readIntentMiningLog();
    expect(events).toHaveLength(1);
    expect(events[0].count).toBe(5);
    // a DIFFERENT outcome breaks the collapse
    logIntentMiningEvent({ prompt: "hlasnejšie", outcome: "model-miss" });
    expect(readIntentMiningLog()).toHaveLength(2);
  });

  it("caps the log FIFO at the constant", () => {
    for (let i = 0; i < INTENT_FAILURE_LOG_CAP + 40; i += 1) {
      logIntentMiningEvent({ prompt: `ask number ${i}`, outcome: "model-miss" });
    }
    const events = readIntentMiningLog();
    expect(events).toHaveLength(INTENT_FAILURE_LOG_CAP);
    expect(events[0].prompt).toBe(`ask number 40`);
    expect(events[events.length - 1].prompt).toBe(`ask number ${INTENT_FAILURE_LOG_CAP + 39}`);
  });

  it("caps prompt length at 280 chars (pasted lyrics cannot bloat storage)", () => {
    const long = "x".repeat(4000);
    logIntentMiningEvent({ prompt: long, outcome: "model-miss" });
    expect(readIntentMiningLog()[0].prompt).toHaveLength(280);
  });

  it("survives corrupt storage — reads empty, keeps logging", () => {
    localStorage.setItem(INTENT_FAILURE_LOG_KEY, "{not json at all");
    expect(readIntentMiningLog()).toEqual([]);
    logIntentMiningEvent({ prompt: "still works", outcome: "clarify" });
    expect(readIntentMiningLog()).toHaveLength(1);
  });

  it("drops tampered/garbage entries on read, keeps valid ones", () => {
    localStorage.setItem(
      INTENT_FAILURE_LOG_KEY,
      JSON.stringify([
        { ts: 1, prompt: "ok", outcome: "clarify", count: 1 },
        { ts: "evil", prompt: 42, outcome: "DROP TABLE" },
        null,
      ]),
    );
    const events = readIntentMiningLog();
    expect(events).toHaveLength(1);
    expect(events[0].prompt).toBe("ok");
  });

  it("export produces a stable JSON artifact with version + events", () => {
    logIntentMiningEvent({ prompt: "viac vzduchu", outcome: "model-miss" });
    logIntentMiningEvent({ prompt: "viac vzduchu", outcome: "clarify", reason: "ktorý track?" });
    const parsed = JSON.parse(exportIntentMiningLog()) as {
      version: number;
      exportedAt: number;
      events: unknown[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.exportedAt).toBeGreaterThan(0);
    expect(parsed.events).toHaveLength(2);
  });

  it("clear wipes the key", () => {
    logIntentMiningEvent({ prompt: "gone", outcome: "model-miss" });
    clearIntentMiningLog();
    expect(readIntentMiningLog()).toEqual([]);
    expect(localStorage.getItem(INTENT_FAILURE_LOG_KEY)).toBeNull();
  });

  it("devtools hook installs window.__kyxIntentFailures (idempotent)", () => {
    installIntentFailureDevtools();
    installIntentFailureDevtools();
    const handle = (window as unknown as Record<string, unknown>).__kyxIntentFailures as {
      read: () => unknown[];
      export: () => string;
      clear: () => void;
    };
    expect(typeof handle.read).toBe("function");
    logIntentMiningEvent({ prompt: "devtools", outcome: "model-miss" });
    expect(handle.read()).toHaveLength(1);
    expect(JSON.parse(handle.export())).toMatchObject({ version: 1 });
    handle.clear();
    expect(handle.read()).toHaveLength(0);
  });
});
