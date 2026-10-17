import { describe, expect, it } from "vitest";
import {
  buildTrustReport,
  buildTrustReportZip,
  collectTrustReportInput,
  type TrustReportInput,
} from "../src/services/trustReport";
import { createDefaultProject } from "../src/project-model/schema";
import { freezeTrack } from "../src/commands/freeze";
import { ProjectStore } from "../src/store/ProjectStore";
import type { Services } from "../src/services";

/**
 * TRUST REPORT — "we don't lose your work and we don't lie to you".
 *
 * The load-bearing specs are the NEGATIVES: a check that could not run is
 * `unknown`, never a quiet ✓; a report where everything degraded is not
 * "clean"; and the collector survives every source throwing at it, because
 * the report is what you open when something is already wrong.
 */

function input(overrides: Partial<TrustReportInput> = {}): TrustReportInput {
  return {
    docName: "Beat",
    docId: "doc-1",
    generatedAt: new Date("2026-10-17T12:00:00.000Z"),
    contentHash: "a".repeat(64),
    save: { status: "saved", lastSaveOkAt: "2026-10-17T11:59:00.000Z", lastSessionClean: true, lastSaveFailure: null },
    snapshots: { count: 3, latestAt: "2026-10-17T11:00:00.000Z" },
    recovery: { buffered: false },
    frozen: [],
    audio: { state: "running", xruns: 0, maxGapMs: 4, schedulerFailures: 0, processorErrors: 0 },
    ai: { assets: 1, patterns: 0, tracks: 0, models: ["mrt2/mrt2_small"] },
    agent: {
      agent: "web-relay",
      sessionCalls: 2,
      sessionMutations: 1,
      checkpointSaved: true,
      destructiveEntries: 0,
      errorEntries: 0,
      totalEntries: 2,
    },
    jobs: [{ kind: "agent", status: "done" }],
    exportStamp: { fileName: "beat-master.wav", hash: "b".repeat(64), renderedAt: "2026-10-17T11:30:00.000Z" },
    intentFailures: { total: 0, latestReason: null },
    ...overrides,
  };
}

describe("buildTrustReport — honest verdicts", () => {
  it("reports a clean level only when checks actually ran and passed", () => {
    const report = buildTrustReport(input());
    expect(report.level).toBe("clean");
    expect(report.verdict.every((entry) => entry.level !== "warn")).toBe(true);
    expect(report.verdict.some((entry) => entry.level === "ok")).toBe(true);
    expect(report.verdict.map((entry) => entry.text).join("\n")).toContain("no audio dropouts this session");
  });

  it("never turns a MISSING source into a quiet pass", () => {
    const report = buildTrustReport(
      input({ snapshots: null, recovery: null, audio: null, ai: null, agent: null, intentFailures: null }),
    );
    const unknowns = report.verdict.filter((entry) => entry.level === "unknown");
    expect(unknowns.length).toBeGreaterThanOrEqual(4);
    for (const entry of unknowns) expect(entry.text).toMatch(/not available|no verdict yet/);
    // …and the top line says so: a report with checks that could not run is
    // "partial", never "clean".
    expect(report.level).toBe("partial");
  });

  it("warns about the things a human must act on", () => {
    const report = buildTrustReport(
      input({
        save: { status: "error", lastSaveOkAt: null, lastSessionClean: false, lastSaveFailure: "QuotaExceededError" },
        frozen: [{ name: "Bass", staleness: "stale" }],
        audio: { state: "running", xruns: 3, maxGapMs: 42, schedulerFailures: 2, processorErrors: 1 },
        recovery: { buffered: true },
        snapshots: { count: 0, latestAt: null },
        agent: {
          agent: "web-relay",
          sessionCalls: 5,
          sessionMutations: 4,
          checkpointSaved: false,
          destructiveEntries: 2,
          errorEntries: 1,
          totalEntries: 6,
        },
      }),
    );
    expect(report.level).toBe("warnings");
    const text = report.verdict.map((entry) => entry.text).join("\n");
    expect(text).toContain("QuotaExceededError");
    expect(text).toContain("did NOT end through the app");
    expect(text).toContain("1 frozen track(s) edited since the freeze");
    expect(text).toContain("3 audio dropout(s)");
    expect(text).toContain("UNSAVED recovery copy");
    expect(text).toContain("no snapshots for this project yet");
    expect(text).toContain("2 destructive");
  });

  it("says the export hash is unavailable instead of showing a fake one", () => {
    const report = buildTrustReport(
      input({ exportStamp: { fileName: "a.wav", hash: null, renderedAt: "2026-10-17T11:30:00.000Z" } }),
    );
    expect(report.verdict.some((entry) => entry.text.includes("unavailable — insecure context"))).toBe(true);
  });
});

describe("buildTrustReport — the artifact", () => {
  it("markdown carries the verdict, the durability facts and the transparency section", () => {
    const report = buildTrustReport(input({ frozen: [{ name: "Bass", staleness: "fresh" }] }));
    expect(report.markdown).toContain('# KYX Trust Report — "Beat"');
    expect(report.markdown).toContain("## Verdict");
    expect(report.markdown).toContain("## Durability");
    expect(report.markdown).toContain("## Freeze integrity");
    expect(report.markdown).toContain("## AI provenance");
    expect(report.markdown).toContain("## What this file contains — and what it never contains");
    expect(report.markdown).toContain("SHORT prompt fragment");
    expect(report.markdown).toContain("node tools/kyx-verify.mjs");
    expect(report.markdown).toContain("content `aaaaaaaaaaaa`");
  });

  it("JSON is machine-readable and mirrors the verdict", () => {
    const report = buildTrustReport(input());
    const json = report.json as Record<string, unknown>;
    expect(json.format).toBe("kyx-trust-report/1");
    expect(json.level).toBe("clean");
    expect(Array.isArray(json.verdict)).toBe(true);
    expect(json.project).toMatchObject({ id: "doc-1", name: "Beat" });
  });

  it("zips both artifacts into one download", () => {
    const report = buildTrustReport(input());
    const { blob, filename } = buildTrustReportZip(report, "My Beat / 2026");
    expect(filename).toBe("kyx-trust-My-Beat-2026-2026-10-17.zip");
    expect(blob.size).toBeGreaterThan(0);
    // The ZIP is STORE-only, so both member names and the markdown text are
    // searchable in the raw bytes.
    return blob.arrayBuffer().then((buffer) => {
      const text = new TextDecoder().decode(new Uint8Array(buffer));
      expect(text).toContain("trust-report.md");
      expect(text).toContain("trust-report.json");
      expect(text).toContain("# KYX Trust Report");
      expect(text).toContain("kyx-trust-report/1");
    });
  });
});

describe("collectTrustReportInput — degrades, never breaks", () => {
  it("survives every source throwing and still builds a report", async () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const broken = {
      store,
      core: {
        crashJournal: {
          read: async () => {
            throw new Error("journal unavailable");
          },
        },
        snapshots: {
          list: async () => {
            throw new Error("idb unavailable");
          },
        },
      },
      engine: {
        getRtLoad: () => {
          throw new Error("no monitor");
        },
        getDiagnostics: () => {
          throw new Error("no engine");
        },
      },
      userSamples: {
        list: async () => {
          throw new Error("no repo");
        },
      },
    } as unknown as Services;

    const collected = await collectTrustReportInput(broken, new Date("2026-10-17T12:00:00.000Z"));
    expect(collected.save.status).toBe("saved");
    expect(collected.snapshots).toBeNull();
    expect(collected.ai).toBeNull();
    expect(collected.audio?.xruns).toBeNull();
    expect(collected.save.lastSessionClean).toBeNull();
    expect(collected.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const report = buildTrustReport(collected);
    expect(report.level).toBe("partial");
    expect(report.markdown).toContain("not available here");
  });

  it("survives sources that are MISSING entirely (a minimal host)", async () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const bare = { store, core: {}, engine: {}, userSamples: {} } as unknown as Services;

    const collected = await collectTrustReportInput(bare, new Date("2026-10-17T12:00:00.000Z"));
    expect(collected.snapshots).toBeNull();
    expect(collected.ai).toBeNull();
    expect(collected.audio?.xruns).toBeNull();
    const report = buildTrustReport(collected);
    expect(report.level).toBe("partial");
    expect(report.markdown).toContain("not available here");
  });

  it("reports a genuinely stale frozen track from the live store", async () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const track = doc.tracks.find((candidate) => candidate.kind !== "group")!;
    store.execute(freezeTrack(store.doc, track.id, "frozen-live", 4, 44100));

    const services = {
      store,
      core: {
        crashJournal: { read: async () => ({ lastSessionClean: true, lastEvent: null, lastSaveOk: null }) },
        snapshots: { list: async () => [] },
      },
      engine: { getRtLoad: () => null, getDiagnostics: () => ({}) },
      userSamples: { list: async () => [] },
    } as unknown as Services;

    const collected = await collectTrustReportInput(services, new Date("2026-10-17T12:00:00.000Z"));
    expect(collected.frozen).toHaveLength(1);
    // No signature was ever remembered in this process → the honest state is
    // "unknown", not a fabricated "fresh".
    expect(collected.frozen[0]!.staleness).toBe("unknown");
    const report = buildTrustReport(collected);
    expect(report.verdict.some((entry) => entry.text.includes("no recorded signature"))).toBe(true);
  });
});
