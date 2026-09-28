import { createElement } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import type { AuthenticatedClient, SyncedDocument } from "@audiotool/nexus";
import type { NexusPreset } from "@audiotool/nexus/api";
import { createDefaultProject } from "../../src/project-model/schema";
import type { Pattern } from "../../src/project-model/types";
import {
  audiotoolProjectIdFromUrl,
  buildAudiotoolWritePlan,
  DEFAULT_GM_PROGRAM_BY_INSTRUMENT,
} from "../../src/integrations/audiotool-nexus/mapping";
import { readAudiotoolProjectTempo } from "../../src/integrations/audiotool-nexus/tempo";
import { writeAudiotoolPlan } from "../../src/integrations/audiotool-nexus/writer";
import { AudiotoolNexusExport } from "../../src/ui/AudiotoolNexusExport";

const { audiotoolPopupMock } = vi.hoisted(() => ({ audiotoolPopupMock: vi.fn() }));
vi.mock("@audiotool/nexus", () => ({ audiotoolPopup: audiotoolPopupMock }));

async function createOfflineGakkiPreset(): Promise<NexusPreset<"gakki">> {
  const source = await createOfflineDocument();
  let data: unknown;
  await source.modify((transaction) => {
    const device = transaction.create("gakki", {});
    data = transaction.createPresetFor(device);
  });
  return {
    meta: {} as NexusPreset<"gakki">["meta"],
    data: data as NexusPreset<"gakki">["data"],
    entityType: "gakki",
    _presetName: "presets/kyx-offline-test",
  };
}

describe("Audiotool Nexus MIDI mapping", () => {
  it("maps selected KYX notes to deterministic, bar-aligned MIDI without changing the source project", () => {
    const doc = createDefaultProject();
    const instrument = doc.tracks.find((track) => track.kind === "instrument");
    const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
    expect(instrument).toBeDefined();
    expect(pattern).toBeDefined();
    if (!instrument || instrument.kind !== "instrument" || !pattern) return;

    const selected: Pattern = {
      ...pattern,
      stepCount: 16,
      notes: {
        [instrument.id]: [
          { id: "note-a", pitch: 60, start: 0, duration: 480, velocity: 0.75 },
          { id: "note-b", pitch: 64, start: 960, duration: 360, velocity: 0.5, slide: true },
        ],
      },
      rows: { kick: [1, 0, 1] },
    };
    const result = buildAudiotoolWritePlan({
      pattern: selected,
      tracks: doc.tracks,
      timeSignature: { numerator: 4, denominator: 4 },
      sourceBpm: doc.bpm,
      projectId: "test-project-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.parts).toHaveLength(1);
    expect(result.plan.parts[0]).toMatchObject({
      sourceTrackId: instrument.id,
      instrumentKind: instrument.instrument,
      gmProgram: DEFAULT_GM_PROGRAM_BY_INSTRUMENT[instrument.instrument],
    });
    expect(result.plan.parts[0]?.notes).toEqual([
      { pitch: 60, positionTicks: 0, durationTicks: 3840, velocity: 0.75, doesSlide: false },
      { pitch: 64, positionTicks: 7680, durationTicks: 2880, velocity: 0.5, doesSlide: true },
    ]);
    expect(result.plan.durationTicks).toBe(15360);
    expect(result.plan.bars).toBe(1);
    expect(result.plan.unsupportedDrumHits).toBe(2);
    const repeatedPlan = buildAudiotoolWritePlan({
      pattern: selected,
      tracks: doc.tracks,
      timeSignature: { numerator: 4, denominator: 4 },
      sourceBpm: doc.bpm,
      projectId: "test-project-1",
    });
    expect(repeatedPlan.ok).toBe(true);
    if (repeatedPlan.ok) expect(result.plan.fingerprint).toBe(repeatedPlan.plan.fingerprint);
    expect(doc.patterns.find((candidate) => candidate.id === doc.activePatternId)?.notes).toEqual(pattern.notes);

    const gmResult = buildAudiotoolWritePlan({
      pattern: selected,
      tracks: doc.tracks,
      timeSignature: { numerator: 4, denominator: 4 },
      sourceBpm: doc.bpm,
      projectId: "test-project-1",
      instrumentMode: "gakki",
      gmProgramByTrackId: { [instrument.id]: 11 },
    });
    expect(gmResult.ok).toBe(true);
    if (gmResult.ok) {
      expect(gmResult.plan.instrumentMode).toBe("gakki");
      expect(gmResult.plan.parts[0]?.gmProgram).toBe(11);
      expect(gmResult.plan.fingerprint).not.toBe(result.plan.fingerprint);
    }
  });

  it("maps supported factory and synth drum roles, merges collisions, and reports unsupported hits", () => {
    const project = createDefaultProject();
    const drumTrack = project.tracks.find((track) => track.kind === "drum");
    const pattern = project.patterns.find((candidate) => candidate.id === project.activePatternId);
    expect(drumTrack?.kind).toBe("drum");
    expect(pattern).toBeDefined();
    if (!drumTrack || drumTrack.kind !== "drum" || !pattern) return;

    const kickPads = drumTrack.pads.filter((pad) => pad.assetId?.startsWith("factory.kick."));
    const snarePad = drumTrack.pads.find((pad) => pad.assetId?.startsWith("factory.snare."));
    const openHatPad = drumTrack.pads.find((pad) => pad.assetId?.startsWith("factory.hat.open"));
    const referencePad = drumTrack.pads[0];
    expect(kickPads.length).toBeGreaterThanOrEqual(2);
    expect(snarePad).toBeDefined();
    expect(openHatPad).toBeDefined();
    expect(referencePad).toBeDefined();
    if (kickPads.length < 2 || !snarePad || !openHatPad || !referencePad) return;

    const cowbellPad = {
      ...referencePad,
      id: "cowbell-synth-pad",
      assetId: null,
      synth: { type: "cowbell" as const, decay: 0.4, tone: 1200, snap: 0.3, body: 0.5 },
    };
    const customPad = { ...referencePad, id: "custom-audio-pad", assetId: "user.sample.unknown", synth: null };
    const tracks = project.tracks.map((track) =>
      track.id === drumTrack.id ? { ...drumTrack, pads: [...drumTrack.pads, cowbellPad, customPad] } : track,
    );
    const customOverflow = Array(65).fill(0) as number[];
    customOverflow[64] = 0.4;
    const selected: Pattern = {
      ...pattern,
      stepCount: 80,
      notes: {},
      rows: {
        [kickPads[0]!.id]: [0.7],
        [kickPads[1]!.id]: [0.9],
        [snarePad.id]: [0, 0.5],
        [openHatPad.id]: [0, 0, 0.3],
        [cowbellPad.id]: [0, 0, 0, 0.8],
        [customPad.id]: [0, 0, 0, 0, 0.6],
        [kickPads[0]!.id + "-overflow"]: customOverflow,
      },
    };
    const result = buildAudiotoolWritePlan({
      pattern: selected,
      tracks,
      timeSignature: { numerator: 4, denominator: 4 },
      sourceBpm: project.bpm,
      projectId: "drum-only-project",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.parts).toHaveLength(0);
    expect(result.plan.noteCount).toBe(0);
    expect(result.plan.drumPattern).toMatchObject({ length: 64, sourceStepCount: 80, hitCount: 4 });
    expect(result.plan.drumPattern?.steps[0]).toMatchObject({ bassdrumIsActive: true, isAccented: true });
    expect(result.plan.drumPattern?.steps[1]).toMatchObject({ snaredrumIsActive: true, isAccented: false });
    expect(result.plan.drumPattern?.steps[2]?.openHihatIsActive).toBe(true);
    expect(result.plan.drumPattern?.steps[3]?.cowbellIsActive).toBe(true);
    expect(result.plan.collapsedDrumHits).toBe(1);
    expect(result.plan.unsupportedDrumHits).toBe(2);
  });

  it("reads target tempo and meter without mutating Audiotool config", async () => {
    const document = await createOfflineDocument();
    const defaults = readAudiotoolProjectTempo(document);
    expect(defaults).toEqual({
      bpm: 125,
      timeSignature: { numerator: 4, denominator: 4 },
      isDefault: true,
    });
    expect(document.queryEntities.ofTypes("config").get()).toHaveLength(0);
    await document.modify((transaction) => {
      const groove = transaction.create("groove", {});
      transaction.create("config", {
        tempoBpm: 142,
        signatureNumerator: 3,
        signatureDenominator: 4,
        defaultGroove: groove.location,
      });
    });
    const config = document.queryEntities.ofTypes("config").get()[0];
    expect(config).toBeDefined();
    expect(readAudiotoolProjectTempo(document)).toEqual({
      bpm: 142,
      timeSignature: { numerator: 3, denominator: 4 },
      isDefault: false,
    });
    expect(config?.fields.tempoBpm.value).toBe(142);
    expect(config?.fields.signatureNumerator.value).toBe(3);
  });

  it("rejects invalid notes and reports note lanes that are not KYX instrument tracks", () => {
    const doc = createDefaultProject();
    const instrument = doc.tracks.find((track) => track.kind === "instrument");
    const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
    expect(instrument?.kind).toBe("instrument");
    expect(pattern).toBeDefined();
    if (!instrument || instrument.kind !== "instrument" || !pattern) return;

    const invalid = buildAudiotoolWritePlan({
      pattern: {
        ...pattern,
        notes: { [instrument.id]: [{ id: "bad", pitch: 128, start: 0, duration: 120, velocity: 0.5 }] },
      },
      tracks: doc.tracks,
      timeSignature: { numerator: 4, denominator: 4 },
      sourceBpm: doc.bpm,
      projectId: "test-project-1",
    });
    expect(invalid).toMatchObject({ ok: false, error: expect.stringContaining("invalid MIDI") });

    const unsupported = buildAudiotoolWritePlan({
      pattern: {
        ...pattern,
        notes: {
          [instrument.id]: [{ id: "ok", pitch: 60, start: 0, duration: 120, velocity: 0.5 }],
          foreignTrack: [{ id: "foreign", pitch: 62, start: 120, duration: 120, velocity: 0.5 }],
        },
      },
      tracks: doc.tracks,
      timeSignature: { numerator: 4, denominator: 4 },
      sourceBpm: doc.bpm,
      projectId: "test-project-1",
    });
    expect(unsupported.ok).toBe(true);
    if (unsupported.ok) expect(unsupported.plan.unsupportedNoteCount).toBe(1);
  });

  it("accepts only the official Audiotool Studio project URL", () => {
    expect(audiotoolProjectIdFromUrl("https://beta.audiotool.com/studio?project=abc-123")).toBe("abc-123");
    expect(audiotoolProjectIdFromUrl("https://evil.example/studio?project=abc-123")).toBeNull();
    expect(audiotoolProjectIdFromUrl("https://beta.audiotool.com.evil.example/studio?project=abc-123")).toBeNull();
    expect(audiotoolProjectIdFromUrl("https://beta.audiotool.com/studio?project=abc&project=def")).toBeNull();
    expect(audiotoolProjectIdFromUrl("javascript:alert(1)")).toBeNull();
  });

  it.each([
    [{ numerator: 3, denominator: 4 }, 11520],
    [{ numerator: 6, denominator: 8 }, 11520],
  ] as const)("scales the KYX pattern into Audiotool ticks for %j meter", (timeSignature, expectedBarTicks) => {
    const doc = createDefaultProject();
    const instrument = doc.tracks.find((track) => track.kind === "instrument");
    const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
    expect(instrument?.kind).toBe("instrument");
    expect(pattern).toBeDefined();
    if (!instrument || instrument.kind !== "instrument" || !pattern) return;

    const result = buildAudiotoolWritePlan({
      pattern: {
        ...pattern,
        stepCount: 12,
        notes: { [instrument.id]: [{ id: "quarter", pitch: 60, start: 480, duration: 120, velocity: 0.7 }] },
      },
      tracks: doc.tracks,
      timeSignature,
      sourceBpm: doc.bpm,
      projectId: "meter-project",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.parts[0]?.notes[0]).toMatchObject({ positionTicks: 3840, durationTicks: 960 });
    expect(result.plan.durationTicks).toBe(expectedBarTicks);
    expect(result.plan.bars).toBe(1);
  });
});

describe("Audiotool Nexus offline entity write", () => {
  it("creates MIDI on the selected Audiotool Gakki GM preset and keeps the import idempotent", async () => {
    const project = createDefaultProject();
    const instrument = project.tracks.find((track) => track.kind === "instrument");
    const pattern = project.patterns.find((candidate) => candidate.id === project.activePatternId);
    expect(instrument?.kind).toBe("instrument");
    expect(pattern).toBeDefined();
    if (!instrument || instrument.kind !== "instrument" || !pattern) return;

    const result = buildAudiotoolWritePlan({
      pattern: {
        ...pattern,
        notes: { [instrument.id]: [{ id: "gm-note", pitch: 64, start: 0, duration: 480, velocity: 0.7 }] },
      },
      tracks: project.tracks,
      timeSignature: { numerator: 4, denominator: 4 },
      sourceBpm: project.bpm,
      projectId: "gakki-project",
      instrumentMode: "gakki",
      gmProgramByTrackId: { [instrument.id]: 11 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const document = await createOfflineDocument();
    const preset = await createOfflineGakkiPreset();
    const first = await writeAudiotoolPlan(document, result.plan, { gakkiPresets: new Map([[11, preset]]) });
    expect(first).toMatchObject({ status: "created", devices: 1, parts: 1, notes: 1 });
    const gakki = document.queryEntities.ofTypes("gakki").get();
    expect(gakki).toHaveLength(1);
    expect(gakki[0]?.fields.displayName.value).toContain(instrument.name);
    expect(gakki[0]?.fields.soundfontId.value).not.toBe("");
    expect(document.queryEntities.ofTypes("heisenberg").get()).toHaveLength(0);
    expect(document.queryEntities.ofTypes("noteTrack").get()).toHaveLength(1);
    expect(document.queryEntities.ofTypes("note").get()).toHaveLength(1);
    expect(document.queryEntities.ofTypes("desktopAudioCable").get().length).toBeGreaterThanOrEqual(1);
    expect(await writeAudiotoolPlan(document, result.plan, { gakkiPresets: new Map([[11, preset]]) })).toMatchObject({
      status: "already-imported",
    });
    expect(document.queryEntities.ofTypes("gakki").get()).toHaveLength(1);
  });

  it("creates editable MIDI plus an audible synth/mixer route, then makes retries idempotent", async () => {
    const doc = createDefaultProject();
    const instrument = doc.tracks.find((track) => track.kind === "instrument");
    const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
    expect(instrument?.kind).toBe("instrument");
    expect(pattern).toBeDefined();
    if (!instrument || instrument.kind !== "instrument" || !pattern) return;

    const result = buildAudiotoolWritePlan({
      pattern: {
        ...pattern,
        stepCount: 16,
        notes: { [instrument.id]: [{ id: "note", pitch: 60, start: 480, duration: 120, velocity: 0.8 }] },
      },
      tracks: doc.tracks,
      timeSignature: { numerator: 4, denominator: 4 },
      sourceBpm: doc.bpm,
      projectId: "offline-project",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const openDocument = await createOfflineDocument();
    const first = await writeAudiotoolPlan(openDocument, result.plan);
    expect(first).toMatchObject({
      status: "created",
      parts: 1,
      notes: 1,
      devices: 1,
      beatboxDevices: 1,
      drumPatterns: 1,
      drumHits: result.plan.drumPattern?.hitCount,
      mixerChannels: 2,
      cables: 2,
    });
    expect(openDocument.queryEntities.ofTypes("heisenberg").get()).toHaveLength(1);
    const heisenberg = openDocument.queryEntities.ofTypes("heisenberg").get()[0];
    expect(heisenberg?.fields.isActive.value).toBe(true);
    expect(heisenberg?.fields.operatorA.fields.gain.value).toBeGreaterThan(0);
    expect(heisenberg?.fields.operatorA.fields.waveformIndex.value).toBe(1);
    expect(openDocument.queryEntities.ofTypes("noteTrack").get()).toHaveLength(1);
    expect(openDocument.queryEntities.ofTypes("noteRegion").get()).toHaveLength(1);
    const notes = openDocument.queryEntities.ofTypes("note").get();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.fields.positionTicks.value).toBe(3840);
    expect(notes[0]?.fields.durationTicks.value).toBe(960);
    expect(openDocument.queryEntities.ofTypes("mixerChannel").get()).toHaveLength(2);
    expect(openDocument.queryEntities.ofTypes("desktopAudioCable").get()).toHaveLength(2);
    const beatbox = openDocument.queryEntities.ofTypes("beatbox8").get()[0];
    const beatboxPattern = openDocument.queryEntities.ofTypes("beatbox8Pattern").get()[0];
    expect(beatbox?.fields.isActive.value).toBe(true);
    expect(beatboxPattern?.fields.length.value).toBe(result.plan.drumPattern?.length);
    expect(beatboxPattern?.fields.stepScaleIndex.value).toBe(3);
    expect(beatboxPattern?.fields.steps.array).toHaveLength(64);
    for (let index = 0; index < 64; index += 1) {
      const actual = beatboxPattern?.fields.steps.array[index];
      const expected = result.plan.drumPattern?.steps[index];
      expect(actual?.fields.isAccented.value).toBe(expected?.isAccented);
      expect(actual?.fields.bassdrumIsActive.value).toBe(expected?.bassdrumIsActive);
      expect(actual?.fields.snaredrumIsActive.value).toBe(expected?.snaredrumIsActive);
      expect(actual?.fields.closedHihatIsActive.value).toBe(expected?.closedHihatIsActive);
      expect(actual?.fields.openHihatIsActive.value).toBe(expected?.openHihatIsActive);
    }
    expect(openDocument.queryEntities.ofTypes("patternTrack").get()[0]?.fields.isEnabled.value).toBe(true);
    expect(openDocument.queryEntities.ofTypes("patternRegion").get()[0]?.fields.region.fields.isEnabled.value).toBe(
      true,
    );

    const retry = await writeAudiotoolPlan(openDocument, result.plan);
    expect(retry).toMatchObject({ status: "already-imported", parts: 0, notes: 0 });
    expect(openDocument.queryEntities.ofTypes("heisenberg").get()).toHaveLength(1);
    expect(openDocument.queryEntities.ofTypes("beatbox8").get()).toHaveLength(1);
    expect(openDocument.queryEntities.ofTypes("note").get()).toHaveLength(1);

    let preflightChecks = 0;
    await expect(
      writeAudiotoolPlan(
        openDocument,
        { ...result.plan, fingerprint: "stale-plan" },
        {
          isWriteStillAuthorized: () => ++preflightChecks === 1,
        },
      ),
    ).rejects.toThrow("KYX source changed");
    expect(preflightChecks).toBe(2);
    expect(openDocument.queryEntities.ofTypes("heisenberg").get()).toHaveLength(1);
    expect(openDocument.queryEntities.ofTypes("note").get()).toHaveLength(1);
  });

  it("supports a drum-only export and keeps its retry idempotent", async () => {
    const project = createDefaultProject();
    const drumTrack = project.tracks.find((track) => track.kind === "drum");
    const pattern = project.patterns.find((candidate) => candidate.id === project.activePatternId);
    const kick =
      drumTrack?.kind === "drum" ? drumTrack.pads.find((pad) => pad.assetId === "factory.kick.deep") : undefined;
    expect(drumTrack?.kind).toBe("drum");
    expect(kick).toBeDefined();
    expect(pattern).toBeDefined();
    if (!drumTrack || drumTrack.kind !== "drum" || !kick || !pattern) return;

    const result = buildAudiotoolWritePlan({
      pattern: { ...pattern, notes: {}, rows: { [kick.id]: [0.9] } },
      tracks: project.tracks,
      timeSignature: { numerator: 4, denominator: 4 },
      sourceBpm: project.bpm,
      projectId: "drum-only-offline-project",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.parts).toHaveLength(0);

    const document = await createOfflineDocument();
    const receipt = await writeAudiotoolPlan(document, result.plan);
    expect(receipt).toMatchObject({
      status: "created",
      parts: 0,
      notes: 0,
      beatboxDevices: 1,
      drumPatterns: 1,
      drumHits: 1,
    });
    expect(document.queryEntities.ofTypes("heisenberg").get()).toHaveLength(0);
    expect(document.queryEntities.ofTypes("beatbox8").get()).toHaveLength(1);
    expect(document.queryEntities.ofTypes("desktopAudioCable").get()).toHaveLength(1);
    expect(await writeAudiotoolPlan(document, result.plan)).toMatchObject({ status: "already-imported" });
    expect(document.queryEntities.ofTypes("beatbox8").get()).toHaveLength(1);
  });

  it("adds drums to a matching legacy MIDI import without duplicating its notes or synth", async () => {
    const project = createDefaultProject();
    const drumTrack = project.tracks.find((track) => track.kind === "drum");
    const instrument = project.tracks.find((track) => track.kind === "instrument");
    const pattern = project.patterns.find((candidate) => candidate.id === project.activePatternId);
    const kick =
      drumTrack?.kind === "drum" ? drumTrack.pads.find((pad) => pad.assetId === "factory.kick.deep") : undefined;
    expect(instrument?.kind).toBe("instrument");
    expect(kick).toBeDefined();
    expect(pattern).toBeDefined();
    if (!instrument || instrument.kind !== "instrument" || !kick || !pattern) return;

    const shared = {
      ...pattern,
      stepCount: 16,
      notes: { [instrument.id]: [{ id: "legacy-midi", pitch: 60, start: 0, duration: 480, velocity: 0.8 }] },
    };
    const legacyPlan = buildAudiotoolWritePlan({
      pattern: { ...shared, rows: {} },
      tracks: project.tracks,
      timeSignature: { numerator: 4, denominator: 4 },
      sourceBpm: project.bpm,
      projectId: "legacy-upgrade-project",
    });
    const upgradedPlan = buildAudiotoolWritePlan({
      pattern: { ...shared, rows: { [kick.id]: [0.8] } },
      tracks: project.tracks,
      timeSignature: { numerator: 4, denominator: 4 },
      sourceBpm: project.bpm,
      projectId: "legacy-upgrade-project",
    });
    expect(legacyPlan.ok).toBe(true);
    expect(upgradedPlan.ok).toBe(true);
    if (!legacyPlan.ok || !upgradedPlan.ok) return;

    const document = await createOfflineDocument();
    await writeAudiotoolPlan(document, legacyPlan.plan);
    const upgrade = await writeAudiotoolPlan(document, upgradedPlan.plan);
    expect(upgrade).toMatchObject({ status: "created", parts: 0, notes: 0, beatboxDevices: 1, drumPatterns: 1 });
    expect(document.queryEntities.ofTypes("heisenberg").get()).toHaveLength(1);
    expect(document.queryEntities.ofTypes("note").get()).toHaveLength(1);
    expect(document.queryEntities.ofTypes("beatbox8").get()).toHaveLength(1);
    expect(await writeAudiotoolPlan(document, upgradedPlan.plan)).toMatchObject({ status: "already-imported" });
    expect(document.queryEntities.ofTypes("heisenberg").get()).toHaveLength(1);
    expect(document.queryEntities.ofTypes("note").get()).toHaveLength(1);
    expect(document.queryEntities.ofTypes("beatbox8").get()).toHaveLength(1);
  });

  it("does not treat edited imported notes as an unchanged idempotent retry", async () => {
    const project = createDefaultProject();
    const instrument = project.tracks.find((track) => track.kind === "instrument");
    const pattern = project.patterns.find((candidate) => candidate.id === project.activePatternId);
    expect(instrument?.kind).toBe("instrument");
    expect(pattern).toBeDefined();
    if (!instrument || instrument.kind !== "instrument" || !pattern) return;

    const result = buildAudiotoolWritePlan({
      pattern: {
        ...pattern,
        notes: { [instrument.id]: [{ id: "edited-import", pitch: 60, start: 0, duration: 120, velocity: 0.8 }] },
      },
      tracks: project.tracks,
      timeSignature: { numerator: 4, denominator: 4 },
      sourceBpm: project.bpm,
      projectId: "edited-import-project",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const openDocument = await createOfflineDocument();
    await writeAudiotoolPlan(openDocument, result.plan);
    await openDocument.modify((transaction) => {
      const importedNote = transaction.entities.ofTypes("note").get()[0];
      if (!importedNote) throw new Error("Expected the imported note to exist.");
      transaction.update(importedNote.fields.pitch, 61);
    });
    await expect(writeAudiotoolPlan(openDocument, result.plan)).rejects.toThrow("partial KYX import marker");
    expect(openDocument.queryEntities.ofTypes("note").get()[0]?.fields.pitch.value).toBe(61);
  });

  it("does not report a marker-only project as already imported", async () => {
    const project = createDefaultProject();
    const instrument = project.tracks.find((track) => track.kind === "instrument");
    const pattern = project.patterns.find((candidate) => candidate.id === project.activePatternId);
    expect(instrument?.kind).toBe("instrument");
    expect(pattern).toBeDefined();
    if (!instrument || instrument.kind !== "instrument" || !pattern) return;

    const result = buildAudiotoolWritePlan({
      pattern: {
        ...pattern,
        notes: { [instrument.id]: [{ id: "marker-only", pitch: 60, start: 0, duration: 120, velocity: 0.8 }] },
      },
      tracks: project.tracks,
      timeSignature: { numerator: 4, denominator: 4 },
      sourceBpm: project.bpm,
      projectId: "marker-only-project",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const openDocument = await createOfflineDocument();
    const part = result.plan.parts[0];
    expect(part).toBeDefined();
    if (!part) return;
    await openDocument.modify((transaction) => {
      transaction.create("heisenberg", {
        displayName: `KYX-NEXUS:${result.plan.fingerprint}:1 · ${part.name}`,
        positionX: 1000,
        positionY: 250,
      });
    });

    await expect(writeAudiotoolPlan(openDocument, result.plan)).rejects.toThrow("partial KYX import marker");
    expect(openDocument.queryEntities.ofTypes("noteTrack").get()).toHaveLength(0);
    expect(openDocument.queryEntities.ofTypes("note").get()).toHaveLength(0);
  });
});

describe("Audiotool Nexus connection UX", () => {
  beforeEach(() => audiotoolPopupMock.mockReset());

  it("lazy-loads on demand, authenticates in the click flow, and previews before write confirmation", async () => {
    const project = createDefaultProject();
    const instrument = project.tracks.find((track) => track.kind === "instrument");
    const pattern = project.patterns.find((candidate) => candidate.id === project.activePatternId);
    expect(instrument?.kind).toBe("instrument");
    expect(pattern).toBeDefined();
    if (!instrument || instrument.kind !== "instrument" || !pattern) return;

    const selectedPattern: Pattern = {
      ...pattern,
      stepCount: 16,
      notes: { [instrument.id]: [{ id: "ui-note", pitch: 60, start: 0, duration: 480, velocity: 0.8 }] },
    };
    const setupView = render(
      createElement(AudiotoolNexusExport, {
        pattern: selectedPattern,
        tracks: project.tracks,
        timeSignature: { numerator: 4, denominator: 4 },
        sourceBpm: project.bpm,
        candidateLabel: "#1",
        isSourceCurrent: () => true,
        onClose: vi.fn(),
        clientId: "",
      }),
    );
    expect(screen.getByRole("note").textContent).toContain(window.location.origin);
    setupView.unmount();

    const callbacks = new Set<(connected: boolean) => void>();
    const connected = {
      getValue: () => true,
      subscribe: (callback: (value: boolean) => void, initialTrigger?: boolean) => {
        callbacks.add(callback);
        if (initialTrigger) callback(true);
        return { terminate: () => callbacks.delete(callback) };
      },
    };
    const offlineDocument = await createOfflineDocument();
    const session = Object.assign(offlineDocument, {
      connected,
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    }) as unknown as SyncedDocument;
    const gakkiPreset = await createOfflineGakkiPreset();
    const gmInstruments = Array.from({ length: 128 }, (_, program) => ({
      program,
      displayName: `GM ${program + 1}`,
      category: "Test",
    }));
    const auth = {
      status: "authenticated",
      userName: "KYX QA",
      open: vi.fn(async () => session),
      presets: {
        gmInstruments,
        getInstrument: vi.fn(async () => gakkiPreset),
      },
    } as unknown as AuthenticatedClient;
    audiotoolPopupMock.mockResolvedValue(auth);

    render(
      createElement(AudiotoolNexusExport, {
        pattern: selectedPattern,
        tracks: project.tracks,
        timeSignature: { numerator: 4, denominator: 4 },
        sourceBpm: project.bpm,
        candidateLabel: "#1",
        isSourceCurrent: () => true,
        onClose: vi.fn(),
        clientId: "public-test-client-id",
      }),
    );

    expect(audiotoolPopupMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "NAČÍTAŤ AUDIOTOOL CONNECTOR" }));
    fireEvent.click(await screen.findByRole("button", { name: "PRIHLÁSIŤ A PRIPOJIŤ" }));
    expect(audiotoolPopupMock).toHaveBeenCalledWith({
      clientId: "public-test-client-id",
      scope: "project:write",
      targetOrigin: window.location.origin,
    });

    const projectInput = await screen.findByLabelText("Odkaz na projekt");
    fireEvent.change(projectInput, {
      target: { value: "https://beta.audiotool.com/studio?project=ui-project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "OTVORIŤ PROJEKT" }));

    await waitFor(() => expect(screen.getByText(/· KYX QA · ONLINE/)).toBeInTheDocument());
    expect(session.start).toHaveBeenCalledOnce();
    expect(auth.open).toHaveBeenCalledWith("https://beta.audiotool.com/studio?project=ui-project");
    expect(screen.getByText(/1 MIDI part/)).toBeInTheDocument();

    const confirm = screen.getByRole("checkbox", { name: "Potvrdiť vzdialený zápis do Audiotoolu" });
    const useGakki = screen.getByRole("checkbox", { name: "Použiť vybrané Audiotool GM zvuky" });
    const sendButton = screen.getByRole("button", { name: "PRIDAŤ MIDI + DRUMS DO AUDIOTOOLU" });
    expect(useGakki).toBeChecked();
    expect(sendButton).toBeDisabled();
    fireEvent.click(confirm);
    expect(sendButton).toBeEnabled();

    act(() => {
      for (const callback of callbacks) callback(false);
    });
    await waitFor(() => expect(screen.getByText(/· KYX QA · OFFLINE/)).toBeInTheDocument());
    expect(sendButton).toBeDisabled();

    act(() => {
      for (const callback of callbacks) callback(true);
    });
    await waitFor(() => expect(sendButton).toBeEnabled());

    const gmSelect = screen.getByRole("combobox", { name: `Audiotool GM zvuk pre ${instrument.name}` });
    fireEvent.change(gmSelect, { target: { value: "11" } });
    expect(auth.presets.getInstrument).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "PRIDAŤ MIDI + DRUMS DO AUDIOTOOLU" }));
    expect(await screen.findByRole("button", { name: "ODOSLANÉ" })).toBeInTheDocument();
    expect(screen.getByText(/Pridané: 1 MIDI part/)).toBeInTheDocument();
    expect(auth.presets.getInstrument).toHaveBeenCalledWith(gmInstruments[11]);
    expect(offlineDocument.queryEntities.ofTypes("gakki").get()).toHaveLength(1);
    expect(offlineDocument.queryEntities.ofTypes("heisenberg").get()).toHaveLength(0);
    expect(offlineDocument.queryEntities.ofTypes("note").get()).toHaveLength(1);
    expect(offlineDocument.queryEntities.ofTypes("beatbox8Pattern").get()).toHaveLength(1);
    expect(offlineDocument.queryEntities.ofTypes("desktopAudioCable").get()).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "ODPOJIŤ PROJEKT" }));
    await waitFor(() => expect(session.stop).toHaveBeenCalledOnce());
    expect(await screen.findByLabelText("Odkaz na projekt")).toBeInTheDocument();
  });

  it("stops a project that finishes opening after the export panel unmounts", async () => {
    const project = createDefaultProject();
    const instrument = project.tracks.find((track) => track.kind === "instrument");
    const pattern = project.patterns.find((candidate) => candidate.id === project.activePatternId);
    expect(instrument?.kind).toBe("instrument");
    expect(pattern).toBeDefined();
    if (!instrument || instrument.kind !== "instrument" || !pattern) return;

    let resolveOpen: (document: SyncedDocument) => void = () => {};
    const openPromise = new Promise<SyncedDocument>((resolve) => {
      resolveOpen = resolve;
    });
    const session = {
      connected: {
        getValue: () => true,
        subscribe: () => ({ terminate: vi.fn() }),
      },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    } as unknown as SyncedDocument;
    const auth = {
      status: "authenticated",
      userName: "KYX QA",
      open: vi.fn(() => openPromise),
    } as unknown as AuthenticatedClient;
    audiotoolPopupMock.mockResolvedValue(auth);

    const view = render(
      createElement(AudiotoolNexusExport, {
        pattern: {
          ...pattern,
          notes: { [instrument.id]: [{ id: "late-open", pitch: 60, start: 0, duration: 120, velocity: 0.8 }] },
        },
        tracks: project.tracks,
        timeSignature: { numerator: 4, denominator: 4 },
        sourceBpm: project.bpm,
        candidateLabel: "#1",
        isSourceCurrent: () => true,
        onClose: vi.fn(),
        clientId: "public-test-client-id",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "NAČÍTAŤ AUDIOTOOL CONNECTOR" }));
    fireEvent.click(await screen.findByRole("button", { name: "PRIHLÁSIŤ A PRIPOJIŤ" }));
    fireEvent.change(await screen.findByLabelText("Odkaz na projekt"), {
      target: { value: "https://beta.audiotool.com/studio?project=late-project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "OTVORIŤ PROJEKT" }));
    await waitFor(() => expect(auth.open).toHaveBeenCalledOnce());

    view.unmount();
    await act(async () => {
      resolveOpen(session);
      await openPromise;
    });

    expect(session.start).not.toHaveBeenCalled();
    expect(session.stop).toHaveBeenCalledOnce();
  });

  it("stops an in-progress Nexus start once if the export panel unmounts", async () => {
    const project = createDefaultProject();
    const instrument = project.tracks.find((track) => track.kind === "instrument");
    const pattern = project.patterns.find((candidate) => candidate.id === project.activePatternId);
    expect(instrument?.kind).toBe("instrument");
    expect(pattern).toBeDefined();
    if (!instrument || instrument.kind !== "instrument" || !pattern) return;

    let resolveStart: () => void = () => {};
    const startPromise = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const session = {
      connected: {
        getValue: () => true,
        subscribe: () => ({ terminate: vi.fn() }),
      },
      start: vi.fn(() => startPromise),
      stop: vi.fn(async () => {}),
    } as unknown as SyncedDocument;
    const auth = {
      status: "authenticated",
      userName: "KYX QA",
      open: vi.fn(async () => session),
    } as unknown as AuthenticatedClient;
    audiotoolPopupMock.mockResolvedValue(auth);

    const view = render(
      createElement(AudiotoolNexusExport, {
        pattern: {
          ...pattern,
          notes: { [instrument.id]: [{ id: "late-start", pitch: 60, start: 0, duration: 120, velocity: 0.8 }] },
        },
        tracks: project.tracks,
        timeSignature: { numerator: 4, denominator: 4 },
        sourceBpm: project.bpm,
        candidateLabel: "#1",
        isSourceCurrent: () => true,
        onClose: vi.fn(),
        clientId: "public-test-client-id",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "NAČÍTAŤ AUDIOTOOL CONNECTOR" }));
    fireEvent.click(await screen.findByRole("button", { name: "PRIHLÁSIŤ A PRIPOJIŤ" }));
    fireEvent.change(await screen.findByLabelText("Odkaz na projekt"), {
      target: { value: "https://beta.audiotool.com/studio?project=starting-project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "OTVORIŤ PROJEKT" }));
    await waitFor(() => expect(session.start).toHaveBeenCalledOnce());

    view.unmount();
    await waitFor(() => expect(session.stop).toHaveBeenCalledOnce());
    await act(async () => {
      resolveStart();
      await startPromise;
    });

    expect(session.stop).toHaveBeenCalledOnce();
  });
});
