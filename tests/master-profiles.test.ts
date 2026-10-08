import { describe, expect, it } from "vitest";
import { MASTER_PROFILES, profileFor, verdictAgainst, worstStatus } from "../src/mcp/master-profiles";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import type { ProjectDocument } from "../src/project-model/types";
import { evaluateMasterVerdict } from "../src/audio-engine/metering";
import {
  CUSTOM_PROFILE,
  MASTER_PROFILE_FILE_SOURCES,
  evaluateDelivery,
  evaluateMasterFileDelivery,
  masterProfileExportSettings,
  masterProfileProvenance,
  masterProfileRecommendedFormat,
} from "../src/mastering/profiles";

/** Minimal local fixtures (the ones in mcp-tools.test.ts are file-local). */
function datasetDoc(): ProjectDocument {
  return createProjectFromTemplate("house") as ProjectDocument;
}

function storeCtx(store: ProjectStore): McpToolContext {
  return {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
  } as McpToolContext;
}

/**
 * MASTERING PROFILES + CLOSED-LOOP LANDING (mastering wave, ADR 0020
 * lineage). Profiles are the delivery contract per platform; op:land closes
 * the loop measure → master loudness trim → RE-MEASURE (the meters are
 * coupled to the store's loudness trim, simulating the engine applying it)
 * until |delta| ≤ 0.3 LU, bounded at 3 steps.
 */

describe("mastering platform profiles", () => {
  it("four contracts with sane targets and ceilings", () => {
    expect(MASTER_PROFILES.map((p) => p.id)).toEqual(["streaming", "apple", "loud", "vinyl"]);
    expect(profileFor("apple")!.targetLufs).toBe(-16);
    expect(profileFor("vinyl")!.maxTruePeakDb).toBe(-2);
    expect(profileFor("nope")).toBeNull();
  });

  it("keeps explicit export settings in the typed profile contract", () => {
    const streamingSettings = masterProfileExportSettings("streaming");
    expect(streamingSettings).toEqual({
      preferred: { format: "flac", bitDepth: 24 },
      alternatives: [{ format: "wav", bitDepth: 24 }],
    });
    for (const id of ["apple", "loud", "vinyl"] as const) {
      expect(masterProfileExportSettings(id)).toEqual({ preferred: { format: "wav", bitDepth: 24 } });
    }
    expect(masterProfileExportSettings("custom")).toBeNull();
    expect(masterProfileRecommendedFormat("streaming")).toBe("24-bit FLAC · 24-bit PCM WAV alternative");
    expect(masterProfileRecommendedFormat("custom")).toBe("Choose a format for the delivery destination.");
    expect(profileFor("streaming")?.recommendedFormat).toBe(masterProfileRecommendedFormat("streaming"));

    if (streamingSettings) streamingSettings.preferred = { format: "wav", bitDepth: 16 };
    expect(masterProfileExportSettings("streaming")?.preferred).toEqual({ format: "flac", bitDepth: 24 });
  });

  it("checks encoded file metadata only for a current, source-backed delivery brief", () => {
    const streaming = profileFor("streaming")!;
    const checkedAt = Date.parse("2026-10-08T00:00:00.000Z");
    const flac = evaluateMasterFileDelivery(
      { format: "flac", sampleRate: 96_000, channels: 2, bitDepth: 24 },
      streaming,
      checkedAt,
    );
    expect(flac?.status).toBe("pass");
    expect(flac?.checks.map((check) => check.status)).toEqual(["pass", "pass", "pass", "pass"]);

    const wav16 = evaluateMasterFileDelivery(
      { format: "wav", sampleRate: 44_100, channels: 2, bitDepth: 16 },
      streaming,
      checkedAt,
    );
    expect(wav16?.status).toBe("warn");
    expect(wav16?.checks.at(-1)?.line).toContain("KYX cannot verify that source condition");

    const native24Bit = evaluateMasterFileDelivery(
      { format: "flac", sampleRate: 48_000, channels: 2, bitDepth: 24, sourceBitDepth: 24 },
      streaming,
      checkedAt,
    );
    expect(native24Bit?.checks.at(-1)).toMatchObject({
      status: "pass",
      line: "24-bit output preserves the imported source's native PCM depth.",
    });

    const reducedTo16Bit = evaluateMasterFileDelivery(
      { format: "flac", sampleRate: 48_000, channels: 2, bitDepth: 16, sourceBitDepth: 24 },
      streaming,
      checkedAt,
    );
    expect(reducedTo16Bit?.checks.at(-1)).toMatchObject({
      status: "warn",
      line: expect.stringContaining("reduces the imported 24-bit source"),
    });

    const raisedFrom16Bit = evaluateMasterFileDelivery(
      { format: "wav", sampleRate: 44_100, channels: 2, bitDepth: 24, sourceBitDepth: 16 },
      streaming,
      checkedAt,
    );
    expect(raisedFrom16Bit?.checks.at(-1)).toMatchObject({
      status: "warn",
      line: expect.stringContaining("above the imported 16-bit source depth"),
    });

    const floatWav = evaluateMasterFileDelivery(
      { format: "wav", sampleRate: 48_000, channels: 2, bitDepth: 32, wavEncoding: "ieee-float" },
      streaming,
      checkedAt,
    );
    expect(floatWav?.status).toBe("fail");
    expect(floatWav?.checks.some((check) => check.line.includes("requires WAVE_FORMAT_PCM"))).toBe(true);

    const incompatible = evaluateMasterFileDelivery(
      { format: "mp3", sampleRate: 32_000, channels: 1 },
      streaming,
      checkedAt,
    );
    expect(incompatible?.status).toBe("fail");
    expect(incompatible?.checks.map((check) => check.status)).toEqual(["warn", "fail", "fail"]);

    expect(
      evaluateMasterFileDelivery(
        { format: "wav", sampleRate: 48_000, channels: 2, bitDepth: 24 },
        profileFor("vinyl")!,
        checkedAt,
      ),
    ).toBeNull();

    const staleSource = evaluateMasterFileDelivery(
      { format: "flac", sampleRate: 48_000, channels: 2, bitDepth: 24 },
      streaming,
      Date.parse("2027-04-06T00:00:00.000Z"),
    );
    expect(staleSource?.status).toBe("not-measured");
    expect(staleSource?.checks[0]?.line).toContain("needs review");
  });

  it("checks external streaming sample-rate preservation against the decoded source", () => {
    const streaming = profileFor("streaming")!;
    const checkedAt = Date.parse("2026-10-08T00:00:00.000Z");

    const preserved = evaluateMasterFileDelivery(
      {
        format: "flac",
        sampleRate: 96_000,
        channels: 2,
        bitDepth: 24,
        sourceSampleRate: 96_000,
        decodedSourceSampleRate: 96_000,
      },
      streaming,
      checkedAt,
    );
    expect(preserved?.checks.find((check) => check.line.includes("preserves the source"))).toMatchObject({
      status: "pass",
    });

    const downsampled = evaluateMasterFileDelivery(
      {
        format: "flac",
        sampleRate: 44_100,
        channels: 2,
        bitDepth: 24,
        sourceSampleRate: 96_000,
        decodedSourceSampleRate: 96_000,
      },
      streaming,
      checkedAt,
    );
    expect(downsampled?.checks.find((check) => check.line.includes("export is below"))).toMatchObject({
      status: "warn",
    });

    const resampledOnImport = evaluateMasterFileDelivery(
      {
        format: "wav",
        sampleRate: 96_000,
        channels: 2,
        bitDepth: 24,
        sourceSampleRate: 96_000,
        decodedSourceSampleRate: 44_100,
      },
      streaming,
      checkedAt,
    );
    expect(
      resampledOnImport?.checks.find((check) => check.line.includes("source detail above the decoded rate")),
    ).toMatchObject({ status: "warn" });

    const upsampledOnImport = evaluateMasterFileDelivery(
      {
        format: "wav",
        sampleRate: 44_100,
        channels: 2,
        bitDepth: 24,
        sourceSampleRate: 32_000,
        decodedSourceSampleRate: 44_100,
      },
      streaming,
      checkedAt,
    );
    expect(upsampledOnImport?.checks.find((check) => check.line.includes("upsample during decode"))).toMatchObject({
      status: "warn",
    });
  });

  it("checks Apple Music's verified source-file rules without claiming encoder certification", () => {
    const apple = profileFor("apple")!;
    const checkedAt = Date.parse("2026-10-08T00:00:00.000Z");
    expect(MASTER_PROFILE_FILE_SOURCES.apple?.url).toContain("help.apple.com/itc/videoaudioassetguide");
    expect(masterProfileProvenance("apple", checkedAt).fileSettingsReview).toBe("current");

    const wav24 = evaluateMasterFileDelivery(
      { format: "wav", sampleRate: 48_000, channels: 2, bitDepth: 24, wavEncoding: "pcm" },
      apple,
      checkedAt,
    );
    expect(wav24?.checks.map((check) => check.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "not-measured",
    ]);
    expect(wav24?.status).toBe("not-measured");
    expect(wav24?.checks.some((check) => check.line.includes("48,000 Hz is accepted"))).toBe(true);
    expect(wav24?.checks.some((check) => check.line.includes("24-bit is accepted"))).toBe(true);

    const flac16 = evaluateMasterFileDelivery(
      {
        format: "flac",
        sampleRate: 44_100,
        channels: 2,
        bitDepth: 16,
        sourceSampleRate: 96_000,
        decodedSourceSampleRate: 96_000,
        sourceBitDepth: 24,
      },
      apple,
      checkedAt,
    );
    expect(flac16?.checks.some((check) => check.line.includes("16-bit is accepted"))).toBe(true);
    expect(flac16?.checks.some((check) => check.line.includes("preserves the source"))).toBe(false);
    expect(flac16?.checks.some((check) => check.line.includes("source depth"))).toBe(false);

    const unsupportedWav = evaluateMasterFileDelivery(
      { format: "wav", sampleRate: 32_000, channels: 2, bitDepth: 32, wavEncoding: "ieee-float" },
      apple,
      checkedAt,
    );
    expect(unsupportedWav?.status).toBe("fail");
    expect(unsupportedWav?.checks.some((check) => check.status === "fail" && check.line.includes("32,000 Hz"))).toBe(
      true,
    );
    expect(unsupportedWav?.checks.some((check) => check.status === "fail" && check.line.includes("32-bit"))).toBe(true);
    expect(unsupportedWav?.checks.some((check) => check.line.includes("requires WAVE_FORMAT_PCM"))).toBe(true);

    const mp3 = evaluateMasterFileDelivery({ format: "mp3", sampleRate: 48_000, channels: 2 }, apple, checkedAt);
    expect(mp3?.status).toBe("fail");
    expect(mp3?.checks[0]).toMatchObject({
      status: "fail",
      line: "MP3 is not accepted by the checked source profile.",
    });
    expect(
      mp3?.checks.some((check) => check.status === "not-measured" && check.line.includes("qualified encoder")),
    ).toBe(true);
  });

  it("verdict: within ±1 LU passes, hot true peak fails, vinyl carries the mono note", () => {
    const streaming = profileFor("streaming")!;
    const good = verdictAgainst({ lufs: -14.4, truePeakDb: -1.6 }, streaming);
    expect(good[0]!.status).toBe("pass");
    expect(good[1]!.status).toBe("pass");
    const hot = verdictAgainst({ lufs: -10, truePeakDb: -0.2 }, streaming);
    expect(hot[0]!.status).toBe("fail");
    expect(hot[1]!.status).toBe("fail");
    const vinyl = verdictAgainst({ lufs: -12.2, truePeakDb: -2.4 }, profileFor("vinyl")!);
    expect(vinyl.some((v) => v.line.includes("mono"))).toBe(true);
    expect(worstStatus(hot)).toBe("fail");
    // Loudness and true peak pass, but the overall report stays honest until
    // its stereo compatibility measurements are available.
    expect(worstStatus(good)).toBe("not-measured");
  });

  it("uses the same loudness and true-peak thresholds in live meter and profile reports", () => {
    const profile = profileFor("streaming")!;
    const metrics = { lufs: -11.5, truePeakDb: -0.8, correlation: 0.8, monoLossDb: -0.5, lrImbalanceDb: 0 };
    const shared = evaluateDelivery(metrics, profile);
    const live = evaluateMasterVerdict(
      {
        lufsIntegrated: metrics.lufs,
        truePeakDb: metrics.truePeakDb,
        correlation: metrics.correlation,
        monoLossDb: metrics.monoLossDb,
        lrImbalanceDb: metrics.lrImbalanceDb,
      },
      profile.targetLufs,
      -1,
      profile.label.toUpperCase(),
      profile,
    );
    expect(shared.checks[0]?.status).toBe("fail");
    expect(shared.checks[1]?.status).toBe("warn");
    expect(live.level).toBe("bad");

    const custom = evaluateDelivery({ lufs: -14, truePeakDb: -0.5 }, CUSTOM_PROFILE, -14, -0.7);
    expect(custom.checks[1]?.status).toBe("warn");
  });

  it("pins pass, warning, and failure boundaries plus unavailable measurements", () => {
    const profile = profileFor("streaming")!;
    const loudnessStatus = (lufs: number | null) =>
      evaluateDelivery({ lufs, truePeakDb: profile.maxTruePeakDb }, profile).checks[0]?.status;
    expect(loudnessStatus(-13)).toBe("pass");
    expect(loudnessStatus(-12.9)).toBe("warn");
    expect(loudnessStatus(-12)).toBe("warn");
    expect(loudnessStatus(-11.9)).toBe("fail");
    expect(loudnessStatus(-15)).toBe("pass");
    expect(loudnessStatus(-16)).toBe("warn");
    // The warn band ends AT 2 LU below target — anything beyond fails hard.
    expect(loudnessStatus(-16.05)).toBe("fail");
    expect(loudnessStatus(-16.2)).toBe("fail");
    expect(loudnessStatus(null)).toBe("not-measured");
    expect(loudnessStatus(-120)).toBe("not-measured");

    const peakStatus = (truePeakDb: number) => evaluateDelivery({ lufs: -14, truePeakDb }, profile).checks[1]?.status;
    expect(peakStatus(-1)).toBe("pass");
    expect(peakStatus(-0.9)).toBe("warn");
    expect(peakStatus(-0.71)).toBe("warn");
    expect(peakStatus(-0.69)).toBe("fail");
    expect(evaluateDelivery({ lufs: -120, truePeakDb: Number.NaN }, profile).status).toBe("not-measured");

    const phase = evaluateDelivery(
      { lufs: -14, truePeakDb: -1.5, correlation: -0.1, monoLossDb: -4, lrImbalanceDb: 7 },
      profile,
    );
    expect(phase.status).toBe("fail");
    expect(phase.checks.map((check) => check.line)).toEqual(
      expect.arrayContaining([
        "Phase issues — check mono compatibility",
        "Mono fold-down loses depth — check wide elements",
        "Left/right balance off by more than 6 dB",
      ]),
    );
  });
});

describe("kyx_master op:land — the closed loudness loop", () => {
  /** Meters coupled to the store: source sits at baseLufs; the master trim
   * shifts the measurement exactly like the real engine does. */
  function landingCtx(store: ProjectStore, baseLufs: number, truePeakDb = -1.6): McpToolContext {
    const inner = storeCtx(store);
    return {
      ...inner,
      meters: () => ({
        master: {
          lufsIntegrated: baseLufs + (store.doc.master.loudnessTrimDb ?? 0),
          truePeakDb: truePeakDb + (store.doc.master.loudnessTrimDb ?? 0),
        },
      }),
    } as McpToolContext;
  }

  it("lands a −16.8 LUFS source at −14 in bounded steps and reports the trim", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = landingCtx(store, -16.8);
    const result = await executeMcpTool(ctx, "kyx_master", { op: "land", profile: "streaming" });
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("LANDED");
    expect(store.doc.master.loudnessTrimDb).toBeCloseTo(2.8, 1);
    expect(result.text).toContain("LUFS vs target");
  });

  it("already-landed master needs no trim (mutated: false); no meters refuses honestly", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = landingCtx(store, -14.1);
    const result = await executeMcpTool(ctx, "kyx_master", { op: "land", profile: "streaming" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("LANDED");
    expect(store.doc.master.loudnessTrimDb ?? 0).toBe(0);

    const bare = storeCtx(new ProjectStore(datasetDoc()));
    const refused = await executeMcpTool(bare, "kyx_master", { op: "land", profile: "streaming" });
    expect(refused.mutated).toBe(false);
    expect(refused.text).toContain("needs live audio meters");
  });

  it("op:platform is a read-only verdict; profile drives op:assist's target", async () => {
    const store = new ProjectStore(datasetDoc());
    const ctx = landingCtx(store, -12.5, -0.2);
    const verdict = await executeMcpTool(ctx, "kyx_master", { op: "platform", profile: "apple" });
    expect(verdict.mutated).toBe(false);
    expect(verdict.text).toContain("HOT");

    // Assist uses the APPLE true-peak limit when measured peak exceeds it;
    // loudness alone must not trigger limiting push or a ceiling change.
    const assisted = await executeMcpTool(ctx, "kyx_master", {
      op: "assist",
      family: "drums",
      profile: "apple",
      insert: true,
    });
    expect(assisted.mutated).toBe(true);
    expect(assisted.text).toContain("measured true peak");
  });

  it("MCP platform report includes the same stereo checks as the live verdict", async () => {
    const store = new ProjectStore(datasetDoc());
    const base = landingCtx(store, -11.5, -0.8);
    const ctx = {
      ...base,
      meters: () => ({
        master: {
          lufsIntegrated: -11.5,
          truePeakDb: -0.8,
          rmsDb: -14,
          lufsMomentary: -12,
          lufsShortTerm: -11.8,
          correlation: -0.2,
          clipping: false,
          monoLossDb: -4,
          lrImbalanceDb: 7,
        },
        tracks: [],
      }),
    } as McpToolContext;
    const report = await executeMcpTool(ctx, "kyx_master", { op: "platform" });
    expect(report.text).toContain("FAIL");
    expect(report.text).toContain("Phase issues");
    expect(report.text).toContain("Mono fold-down loses depth");
    expect(report.text).toContain("Left/right balance off by more than 6 dB");
  });
});
