import { describe, it, expect } from "vitest";
import { executeMcpToolAsync, MCP_TOOLS, type McpToolContext } from "../src/mcp/tools";
import {
  buildMasterFindings,
  buildStripFindings,
  buildSuggestedActions,
  formatAttributions,
  formatMixDiagnosis,
  type DiagnosedStrip,
  type MixDiagnosisData,
  type StripDocFacts,
} from "../src/mcp/mix-diagnosis";
import type { MixHealthReport } from "../src/analysis/mixDoctor";

/**
 * kyx_diagnose_mix — the agent's EARS v2. Pins the pure interpretation
 * layer (energy-weighted band ownership, per-strip findings with callable
 * fixes, master findings with the auto-fix + loudness-loop suggestion, the
 * deterministic read-back), and the transport contract (honest refusal
 * without the diagnose hook, async pass-through with the data envelope).
 */

const strip = (overrides: Partial<DiagnosedStrip>): DiagnosedStrip => ({
  id: "s1",
  name: "Kick",
  kind: "drum",
  lufs: -10,
  peakDb: -3,
  crestDb: 9,
  lowEndShare: 0.9,
  hfShare: 0.02,
  deltaVsLoudest: 0,
  ...overrides,
});

describe("band ownership attribution", () => {
  it("ranks strips by loudness-weighted band share, deterministically", () => {
    const strips = [
      // The lead's hf share is high enough that NEITHER band has a runaway
      // top-end owner (kick's hf stays below the 40% floor).
      strip({ id: "kick", name: "Kick", lufs: -10, lowEndShare: 0.9, hfShare: 0.05 }),
      strip({ id: "bass", name: "Bass", lufs: -11, lowEndShare: 0.8, hfShare: 0.05 }),
      strip({ id: "lead", name: "Lead", lufs: -20, lowEndShare: 0.05, hfShare: 0.5 }),
    ];
    const lines = formatAttributions(strips);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("low-end ownership: Kick ≈58% of low energy · next Bass ≈41%");
    // Same input → byte-equal output (the transport determinism contract).
    expect(formatAttributions(strips)).toEqual(lines);
  });

  it("stays silent when no strip owns 40%+ of a band (no fake attributions)", () => {
    const spread = [
      strip({ id: "a", name: "A", lufs: -10, lowEndShare: 0.35 }),
      strip({ id: "b", name: "B", lufs: -10, lowEndShare: 0.35 }),
      strip({ id: "c", name: "C", lufs: -10, lowEndShare: 0.3 }),
    ];
    expect(formatAttributions(spread)).toEqual([]);
  });
});

describe("per-strip findings", () => {
  it("quiet outlier → setGain suggestion bounded by the tool ceiling", () => {
    const findings = buildStripFindings([
      strip({ id: "hot", name: "Drums", lufs: -8 }),
      strip({ id: "buried", name: "Pad", lufs: -15, lowEndShare: 0.1 }),
    ]);
    const quiet = findings.find((finding) => finding.check === "quiet-strip");
    expect(quiet).toBeDefined();
    expect(quiet!.stripId).toBe("buried");
    expect(quiet!.detail).toContain("Pad is 7.0 LU below the loudest strip (Drums)");
    expect(quiet!.suggest!.tool).toBe("kyx_tracks");
    expect(quiet!.suggest!.args).toEqual({ op: "setGain", trackId: "buried", gainDb: 3.5 });
  });

  it("collapsed crest on a strip → kyx_fx compressor less on THAT strip", () => {
    const findings = buildStripFindings([
      strip({ id: "flat", name: "Lead", lufs: -9, crestDb: 5.2 }),
      strip({ id: "ok", name: "Drums", lufs: -10, crestDb: 11 }),
    ]);
    const collapsed = findings.find((finding) => finding.check === "crest-collapse-strip");
    expect(collapsed).toBeDefined();
    expect(collapsed!.stripId).toBe("flat");
    expect(collapsed!.suggest!.args).toEqual({ effect: "compressor", action: "less", trackId: "flat" });
  });

  it("two hot low-end strips → sub collision; the pump targets the NON-drum participant by id", () => {
    const findings = buildStripFindings([
      strip({ id: "kick", name: "Kick", lufs: -9, lowEndShare: 0.9 }),
      strip({ id: "bass", name: "Bass", lufs: -11, lowEndShare: 0.8, kind: "instrument" }),
    ]);
    const collision = findings.find((finding) => finding.check === "low-end-collision");
    expect(collision).toBeDefined();
    expect(collision!.detail).toContain("Kick and Bass both carry >50% low-end");
    expect(collision!.suggest!.args).toEqual({ effect: "pump", action: "more", trackId: "bass" });
    expect(collision!.suggest!.why).toContain("ducks Bass");
  });

  it("collision between two non-drum strips falls back to the bass family", () => {
    const findings = buildStripFindings([
      strip({ id: "sub", name: "Sub", lufs: -9, lowEndShare: 0.9, kind: "instrument" }),
      strip({ id: "pad808", name: "808 Pad", lufs: -11, lowEndShare: 0.8, kind: "instrument" }),
    ]);
    const collision = findings.find((finding) => finding.check === "low-end-collision");
    expect(collision!.suggest!.args).toEqual({ effect: "pump", action: "more", family: "bass" });
  });

  it("a healthy pair produces no findings", () => {
    const findings = buildStripFindings([
      strip({ id: "drums", name: "Drums", lufs: -8, crestDb: 11 }),
      strip({ id: "bass", name: "Bass", lufs: -11, lowEndShare: 0.3, crestDb: 10, kind: "instrument" }),
    ]);
    expect(findings).toEqual([]);
  });
});

describe("doc-aware suggestions (StripDocFacts)", () => {
  const facts = (overrides: Partial<StripDocFacts>): StripDocFacts => ({
    mutedTrackIds: new Set<string>(),
    hasActiveEffect: () => false,
    hasContent: () => true,
    ...overrides,
  });

  it("a muted strip with content that renders SILENT is told to unmute — even as the only strip", () => {
    // Silent strips are invisible to every loudness rule (BS.1770 gates
    // silence out) — the silent-strip check must run before the <2-measured
    // early return that guards the balance rules.
    const findings = buildStripFindings(
      [strip({ id: "vox", name: "Vox", lufs: null })],
      facts({ mutedTrackIds: new Set(["vox"]) }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.check).toBe("silent-strip");
    expect(findings[0]!.detail).toContain("MUTED");
    expect(findings[0]!.suggest!.args).toEqual({ op: "setMute", trackId: "vox", value: false });
  });

  it("silent with content but NOT muted → routing finding, no blind suggestion", () => {
    const findings = buildStripFindings(
      [strip({ id: "vox", name: "Vox", lufs: null }), strip({ id: "drums", name: "Drums", lufs: -9 })],
      facts({}),
    );
    const silent = findings.find((finding) => finding.check === "silent-strip");
    expect(silent).toBeDefined();
    expect(silent!.detail).toContain("routing");
    expect(silent!.suggest).toBeUndefined();
  });

  it("content-free silent strips are NOT flagged (intentionally empty)", () => {
    const findings = buildStripFindings(
      [strip({ id: "spare", name: "Spare", lufs: null }), strip({ id: "drums", name: "Drums", lufs: -9 })],
      facts({ hasContent: () => false }),
    );
    expect(findings.find((finding) => finding.check === "silent-strip")).toBeUndefined();
  });

  it("a quiet MUTED strip is told to unmute — setGain on a muted track does nothing", () => {
    const findings = buildStripFindings(
      [
        strip({ id: "hot", name: "Drums", lufs: -8 }),
        strip({ id: "buried", name: "Pad", lufs: -15, kind: "instrument" }),
      ],
      facts({ mutedTrackIds: new Set(["buried"]) }),
    );
    const quiet = findings.find((finding) => finding.check === "quiet-strip");
    expect(quiet!.suggest!.args).toEqual({ op: "setMute", trackId: "buried", value: false });
    expect(quiet!.suggest!.why).toContain("setGain on a muted track changes nothing");
  });

  it("top-end dominance: saturation advice only when a saturation instance exists", () => {
    const strips = [
      strip({ id: "lead", name: "Lead", lufs: -9, hfShare: 0.55, lowEndShare: 0.05, kind: "instrument" }),
      strip({ id: "drums", name: "Drums", lufs: -12, hfShare: 0.1 }),
    ];
    const without = buildStripFindings(strips, facts({}));
    const bright = without.find((finding) => finding.check === "top-end-dominant-strip");
    expect(bright).toBeDefined();
    expect(bright!.stripId).toBe("lead");
    expect(bright!.suggest).toBeUndefined();

    const withSat = buildStripFindings(
      strips,
      facts({ hasActiveEffect: (id, type) => id === "lead" && type === "saturation" }),
    );
    const advised = withSat.find((finding) => finding.check === "top-end-dominant-strip")!;
    expect(advised.suggest!.args).toEqual({ effect: "saturation", action: "less", trackId: "lead" });
  });
});

function fakeReport(overrides: Partial<MixHealthReport> = {}): MixHealthReport {
  return {
    durationSec: 9.6,
    peak: 0.9,
    clippedSamples: 0,
    headroomDb: 0.9,
    crestDb: 10,
    dcOffset: 0,
    integratedLufs: -14,
    momentaryMaxLufs: -10,
    bandShares: { sub: 0.4, low: 0.3, lowmid: 0.1, mid: 0.1, himid: 0.06, high: 0.03, air: 0.01 },
    lowEndShare: 0.7,
    stereoCorrelation: 0.9,
    flags: [],
    ok: true,
    ...overrides,
  };
}

describe("master findings", () => {
  it("passes the mix-doctor flags through and offers the loudness loop when the level is off target", () => {
    const report = fakeReport({
      flags: [{ severity: "red", check: "clipping", detail: "12 samples at/over full scale" }],
      clippedSamples: 12,
      integratedLufs: -8,
    });
    const { findings, autoFix } = buildMasterFindings(report, -14);
    // Clipping + a −1 dBFS master-gain auto-fix (12 clipped samples) + the
    // 6 LU gap above target.
    const checks = findings.map((finding) => finding.check);
    expect(checks).toContain("clipping");
    expect(checks).toContain("mechanical-fix-available");
    expect(checks).toContain("lufs-off-target");
    expect(autoFix).not.toBeNull();
    const loudness = findings.find((finding) => finding.suggest?.tool === "kyx_loudness");
    expect(loudness!.suggest!.args).toEqual({ op: "match", targetDb: -14 });
  });

  it("on-target clean mix → no findings, no auto-fix", () => {
    const { findings, autoFix } = buildMasterFindings(fakeReport(), -14);
    expect(findings).toEqual([]);
    expect(autoFix).toBeNull();
  });

  it("near-mono stereo (correlation at the ceiling) → narrow-stereo advisory, no auto-fix", () => {
    const { findings, autoFix } = buildMasterFindings(fakeReport({ stereoCorrelation: 0.995 }), -14);
    const narrow = findings.find((finding) => finding.check === "narrow-stereo");
    expect(narrow).toBeDefined();
    expect(narrow!.detail).toContain("near-mono master");
    expect(narrow!.suggest).toBeUndefined(); // widening is a creative decision — reported, not prescribed
    expect(autoFix).toBeNull();
    // The mix-doctor's negative-phase red stays a separate master flag.
    const inverted = buildMasterFindings(
      fakeReport({
        stereoCorrelation: -0.4,
        flags: [{ severity: "red", check: "stereo-phase", detail: "L/R correlation -0.40 — phase inversion" }],
      }),
      -14,
    );
    expect(inverted.findings[0]!.check).toBe("stereo-phase");
    expect(inverted.findings.find((finding) => finding.check === "narrow-stereo")).toBeUndefined();
  });
});

describe("read-back + action list", () => {
  const DATA: MixDiagnosisData = {
    scope: "all",
    referenceLufs: -14,
    master: {
      lufs: -13.9,
      peakDb: -1.2,
      crestDb: 8.8,
      lowEndShare: 0.72,
      hfShare: 0.09,
      stereoCorrelation: 0.91,
      clippedSamples: 0,
      headroomDb: 1.2,
      lufsVsTarget: 0.1,
      flags: [],
      autoFix: null,
    },
    strips: [
      strip({ id: "drums", name: "Drums", lufs: -8.3, deltaVsLoudest: 0 }),
      strip({ id: "pad", name: "Pad", lufs: -15.2, lowEndShare: 0.05, deltaVsLoudest: -6.9 }),
    ],
    findings: buildStripFindings([
      strip({ id: "drums", name: "Drums", lufs: -8.3 }),
      strip({ id: "pad", name: "Pad", lufs: -15.2, lowEndShare: 0.05 }),
    ]),
    attributions: ["low-end ownership: Drums ≈88% of low energy"],
    suggestedActions: [],
  };

  it("the suggested actions are deduplicated, order-stable and reference real tools", () => {
    const actions = buildSuggestedActions(DATA.findings);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toContain("kyx_tracks");
    expect(actions[0]).toContain("pad");
    expect(buildSuggestedActions(DATA.findings)).toEqual(actions);
    // Dedup is by tool+args: a duplicate finding does not double the action.
    const duplicated = [...DATA.findings, { ...DATA.findings[0]! }];
    expect(buildSuggestedActions(duplicated)).toHaveLength(1);
  });

  it("formatMixDiagnosis is deterministic and evidence-first", () => {
    const data = { ...DATA, suggestedActions: buildSuggestedActions(DATA.findings) };
    const text = formatMixDiagnosis(data);
    expect(formatMixDiagnosis(data)).toBe(text);
    expect(text).toContain("MASTER — -13.9 LUFS");
    expect(text).toContain("low 72% · hf 9%");
    expect(text).toContain("findings: none red · 1 advisory");
    expect(text).toContain("○ quiet-strip: Pad is 6.9 LU below");
    expect(text).toContain("low-end ownership: Drums ≈88% of low energy");
    expect(text).toContain("next moves (apply, then re-run kyx_diagnose_mix to verify):");
    expect(text).toContain('kyx_tracks {"op":"setGain","trackId":"pad","gainDb":3.5}');
  });
});

function makeCtx(hook?: NonNullable<McpToolContext["diagnoseMix"]>): McpToolContext {
  return {
    getDoc: () => ({}) as never,
    execute: () => undefined,
    undo: () => undefined,
    redo: () => undefined,
    undoStackLength: () => 0,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
    ...(hook ? { diagnoseMix: hook } : {}),
  };
}

describe("kyx_diagnose_mix transport contract", () => {
  it("the tool is registered with its schema", () => {
    const def = MCP_TOOLS.find((tool) => tool.name === "kyx_diagnose_mix");
    expect(def).toBeDefined();
    expect((def!.inputSchema as { properties: Record<string, unknown> }).properties.scope).toBeDefined();
  });

  it("honestly refuses without the diagnose hook (headless transport)", async () => {
    const result = await executeMcpToolAsync(makeCtx(), "kyx_diagnose_mix", {});
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("not available over this MCP transport");
    expect(result.text).toContain("kyx_render_summary");
  });

  it("passes through the hook: formatted text + machine-readable data, never mutating", async () => {
    const data: MixDiagnosisData = {
      scope: "master",
      referenceLufs: -14,
      master: {
        lufs: -12,
        peakDb: -0.4,
        crestDb: 7.9,
        lowEndShare: 0.8,
        hfShare: 0.1,
        stereoCorrelation: 0.95,
        clippedSamples: 0,
        headroomDb: 0.4,
        lufsVsTarget: 2,
        flags: [],
        autoFix: null,
      },
      strips: [],
      findings: [
        {
          severity: "yellow",
          check: "lufs-off-target",
          detail: "master sits 2.0 LU above the -14 streaming target",
          suggest: { tool: "kyx_loudness", args: { op: "match", targetDb: -14 }, why: "lands the gap" },
        },
      ],
      attributions: [],
      suggestedActions: ['kyx_loudness {"op":"match","targetDb":-14} — lands the gap'],
    };
    const result = await executeMcpToolAsync(
      makeCtx(async () => data),
      "kyx_diagnose_mix",
      {},
    );
    expect(result.mutated).toBe(false);
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("MASTER — -12.0 LUFS");
    expect(result.text).toContain("2.0 LU above target");
    expect(result.data).toEqual(data);
  });

  it("a throwing hook answers as an error instead of crashing the transport", async () => {
    const result = await executeMcpToolAsync(
      makeCtx(async () => {
        throw new Error("render exploded");
      }),
      "kyx_diagnose_mix",
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("mix diagnosis failed: render exploded");
  });

  it("scope:tracks reaches the hook, renders without a MASTER line (fast verify loop)", async () => {
    let seenScope = "";
    const data: MixDiagnosisData = {
      scope: "tracks",
      referenceLufs: -14,
      master: null,
      strips: [
        strip({ id: "drums", name: "Drums", lufs: -8.3, deltaVsLoudest: 0 }),
        strip({ id: "pad", name: "Pad", lufs: -15.2, lowEndShare: 0.05, deltaVsLoudest: -6.9, kind: "instrument" }),
      ],
      findings: [],
      attributions: [],
      suggestedActions: [],
    };
    const result = await executeMcpToolAsync(
      makeCtx(async (request) => {
        seenScope = request.scope ?? "";
        return data;
      }),
      "kyx_diagnose_mix",
      { scope: "tracks" },
    );
    expect(seenScope).toBe("tracks");
    expect(result.data).toEqual(data);
    expect(result.text).not.toContain("MASTER —");
    expect(result.text).toContain("findings:");
  });
});
