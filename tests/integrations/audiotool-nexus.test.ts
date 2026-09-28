import { createElement } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import type { AuthenticatedClient, SyncedDocument } from "@audiotool/nexus";
import { createDefaultProject } from "../../src/project-model/schema";
import type { DrumPad, DrumTrack, Pattern } from "../../src/project-model/types";
import { audiotoolProjectIdFromUrl, buildAudiotoolWritePlan } from "../../src/integrations/audiotool-nexus/mapping";
import { writeAudiotoolPlan } from "../../src/integrations/audiotool-nexus/writer";
import { readAudiotoolProjectTempo } from "../../src/integrations/audiotool-nexus/tempo";
import { AudiotoolNexusExport } from "../../src/ui/AudiotoolNexusExport";

const { audiotoolPopupMock, createOfflineDocumentMock } = vi.hoisted(() => ({
  audiotoolPopupMock: vi.fn(),
  createOfflineDocumentMock: vi.fn(),
}));
vi.mock("@audiotool/nexus", () => ({
  audiotoolPopup: audiotoolPopupMock,
  createOfflineDocument: createOfflineDocumentMock,
}));

function makeDrumPad(id: string, assetId: string | null, synth: DrumPad["synth"] = null): DrumPad {
  return {
    id,
    name: id,
    assetId,
    gain: 1,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    chokeGroup: null,
    synth,
  };
}

function makeDrumTrack(pads: DrumPad[], id = "test-drums"): DrumTrack {
  return {
    id,
    kind: "drum",
    name: "Test Drums",
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    pads,
    effects: [],
    sends: {},
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
  });

  it("maps supported factory drum roles into a 16th-note Beatbox8 loop, including drum-only ideas", () => {
    const doc = createDefaultProject();
    const source = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
    expect(source).toBeDefined();
    if (!source) return;
    const kick = makeDrumPad("kick-pad", "factory.kick.deep");
    const snare = makeDrumPad("snare-pad", "factory.snare.main");
    const hats = makeDrumPad("hat-pad", "factory.hat.open.short");
    const drums = makeDrumTrack([kick, snare, hats]);
    const selected: Pattern = {
      ...source,
      stepCount: 16,
      notes: {},
      rows: {
        [kick.id]: [0.6, 0, 0.9],
        [snare.id]: [0, 0.8],
        [hats.id]: [0, 0, 0, 0.4],
        unknownPad: [0.7],
      },
    };

    const result = buildAudiotoolWritePlan({
      pattern: selected,
      tracks: [...doc.tracks, drums],
      timeSignature: { numerator: 4, denominator: 4 },
      sourceBpm: doc.bpm,
      projectId: "drum-only-project",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.parts).toHaveLength(0);
    expect(result.plan.drumPattern).toMatchObject({ length: 16, hits: 4 });
    expect(result.plan.drumHitCount).toBe(4);
    expect(result.plan.unsupportedDrumHits).toBe(1);
    expect(result.plan.drumPattern?.steps).toHaveLength(64);
    expect(result.plan.drumPattern?.steps[0]).toMatchObject({ bassdrumIsActive: true, isAccented: false });
    expect(result.plan.drumPattern?.steps[1]).toMatchObject({ snaredrumIsActive: true, isAccented: true });
    expect(result.plan.drumPattern?.steps[2]).toMatchObject({ bassdrumIsActive: true, isAccented: true });
    expect(result.plan.drumPattern?.steps[3]).toMatchObject({ openHihatIsActive: true, isAccented: false });
  });

  it("reports role collisions and drum hits past Beatbox8's 64-step limit instead of truncating silently", () => {
    const doc = createDefaultProject();
    const source = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
    expect(source).toBeDefined();
    if (!source) return;
    const sampleKick = makeDrumPad("sample-kick", "factory.kick.trap");
    const synthKick = makeDrumPad("synth-kick", null, {
      type: "kick",
      decay: 0.2,
      tone: 100,
      snap: 0.4,
      body: 0.5,
    });
    const unsupported = makeDrumPad("perc-pad", null, {
      type: "perc",
      decay: 0.2,
      tone: 1000,
      snap: 0.4,
      body: 0.2,
    });
    const rows = new Array<number>(65).fill(0);
    rows[0] = 0.8;
    rows[63] = 0.5;
    const overflow = new Array<number>(65).fill(0);
    overflow[64] = 1;
    const selected: Pattern = {
      ...source,
      stepCount: 80,
      notes: {},
      rows: {
        [sampleKick.id]: rows,
        [synthKick.id]: [0.9],
        [unsupported.id]: [0.6],
        staleOverflow: overflow,
      },
    };

    const result = buildAudiotoolWritePlan({
      pattern: selected,
      tracks: [...doc.tracks, makeDrumTrack([sampleKick, synthKick, unsupported])],
      timeSignature: { numerator: 4, denominator: 4 },
      sourceBpm: doc.bpm,
      projectId: "drum-limits-project",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.drumPattern).toMatchObject({ length: 64, sourceStepCount: 80, hits: 2 });
    expect(result.plan.collapsedDrumHits).toBe(1);
    expect(result.plan.unsupportedDrumHits).toBe(2);
    expect(result.plan.drumPattern?.steps[0]).toMatchObject({ bassdrumIsActive: true, isAccented: true });
    expect(result.plan.drumPattern?.steps[63]).toMatchObject({ bassdrumIsActive: true });
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
  it("creates active MIDI and Beatbox8 tracks with mixer routes, then makes retries idempotent", async () => {
    const doc = createDefaultProject();
    const instrument = doc.tracks.find((track) => track.kind === "instrument");
    const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
    expect(instrument?.kind).toBe("instrument");
    expect(pattern).toBeDefined();
    if (!instrument || instrument.kind !== "instrument" || !pattern) return;

    const kick = makeDrumPad("offline-kick", "factory.kick.deep");
    const drums = makeDrumTrack([kick], "offline-drums");
    const result = buildAudiotoolWritePlan({
      pattern: {
        ...pattern,
        stepCount: 16,
        notes: { [instrument.id]: [{ id: "note", pitch: 60, start: 480, duration: 120, velocity: 0.8 }] },
        rows: { [kick.id]: [1, 0, 0.5] },
      },
      tracks: [...doc.tracks, drums],
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
      drumPatterns: 1,
      drumHits: 2,
      collapsedDrumHits: 0,
      devices: 2,
      mixerChannels: 2,
      cables: 2,
    });
    expect(openDocument.queryEntities.ofTypes("heisenberg").get()).toHaveLength(1);
    const synth = openDocument.queryEntities.ofTypes("heisenberg").get()[0];
    expect(synth?.fields.isActive.value).toBe(true);
    expect(synth?.fields.operatorA.fields.gain.value).toBe(1);
    expect(synth?.fields.operatorA.fields.waveformIndex.value).toBe(1);
    expect(openDocument.queryEntities.ofTypes("noteTrack").get()[0]?.fields.isEnabled.value).toBe(true);
    expect(openDocument.queryEntities.ofTypes("noteRegion").get()[0]?.fields.region.fields.isEnabled.value).toBe(true);
    const notes = openDocument.queryEntities.ofTypes("note").get();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.fields.positionTicks.value).toBe(3840);
    expect(notes[0]?.fields.durationTicks.value).toBe(960);
    expect(openDocument.queryEntities.ofTypes("beatbox8").get()).toHaveLength(1);
    expect(openDocument.queryEntities.ofTypes("beatbox8").get()[0]?.fields.isActive.value).toBe(true);
    expect(openDocument.queryEntities.ofTypes("beatbox8Pattern").get()).toHaveLength(1);
    const beatboxPattern = openDocument.queryEntities.ofTypes("beatbox8Pattern").get()[0];
    expect(beatboxPattern?.fields.length.value).toBe(16);
    expect(beatboxPattern?.fields.stepScaleIndex.value).toBe(3);
    expect(beatboxPattern?.fields.steps.array).toHaveLength(64);
    expect(beatboxPattern?.fields.steps.array[0]?.fields.bassdrumIsActive.value).toBe(true);
    expect(beatboxPattern?.fields.steps.array[2]?.fields.bassdrumIsActive.value).toBe(true);
    expect(openDocument.queryEntities.ofTypes("patternTrack").get()[0]?.fields.isEnabled.value).toBe(true);
    expect(openDocument.queryEntities.ofTypes("patternRegion").get()[0]?.fields.region.fields.isEnabled.value).toBe(
      true,
    );
    expect(openDocument.queryEntities.ofTypes("mixerChannel").get()).toHaveLength(2);
    expect(openDocument.queryEntities.ofTypes("desktopAudioCable").get()).toHaveLength(2);

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

  it("reads the target tempo and meter, with documented defaults for a blank offline document", async () => {
    const openDocument = await createOfflineDocument();
    expect(readAudiotoolProjectTempo(openDocument)).toEqual({
      bpm: 125,
      timeSignature: { numerator: 4, denominator: 4 },
      isDefault: true,
    });

    await openDocument.modify((transaction) => {
      const groove = transaction.create("groove", {});
      transaction.create("config", {
        tempoBpm: 138,
        baseFrequencyHz: 440,
        signatureNumerator: 3,
        signatureDenominator: 4,
        durationTicks: 46080,
        defaultGroove: groove.location,
      });
    });
    expect(readAudiotoolProjectTempo(openDocument)).toEqual({
      bpm: 138,
      timeSignature: { numerator: 3, denominator: 4 },
      isDefault: false,
    });
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
  beforeEach(() => {
    audiotoolPopupMock.mockReset();
    createOfflineDocumentMock.mockReset();
    createOfflineDocumentMock.mockImplementation(() => createOfflineDocument());
  });

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
      rows: {},
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
        allowOffline: false,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "NAČÍTAŤ AUDIOTOOL CONNECTOR" }));
    expect((await screen.findByRole("note")).textContent).toContain(window.location.origin);
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
    const auth = {
      status: "authenticated",
      userName: "KYX QA",
      open: vi.fn(async () => session),
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

    const confirm = screen.getByRole("checkbox");
    const sendButton = screen.getByRole("button", { name: "PRIDAŤ MIDI DO AUDIOTOOLU" });
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

    fireEvent.click(sendButton);
    expect(await screen.findByRole("button", { name: "ODOSLANÉ" })).toBeInTheDocument();
    expect(screen.getByText(/Pridané: 1 MIDI part/)).toBeInTheDocument();
    expect(offlineDocument.queryEntities.ofTypes("note").get()).toHaveLength(1);
    expect(offlineDocument.queryEntities.ofTypes("desktopAudioCable").get()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "ODPOJIŤ PROJEKT" }));
    await waitFor(() => expect(session.stop).toHaveBeenCalledOnce());
    expect(await screen.findByLabelText("Odkaz na projekt")).toBeInTheDocument();
  });

  it("creates and writes to a real local offline document when no Audiotool client id is configured", async () => {
    const project = createDefaultProject();
    const source = project.patterns.find((candidate) => candidate.id === project.activePatternId);
    expect(source).toBeDefined();
    if (!source) return;
    const kick = makeDrumPad("offline-ui-kick", "factory.kick.trap");
    const drumTrack = makeDrumTrack([kick], "offline-ui-drums");
    const localDocument = await createOfflineDocument();
    createOfflineDocumentMock.mockResolvedValue(localDocument);

    render(
      createElement(AudiotoolNexusExport, {
        pattern: { ...source, stepCount: 16, notes: {}, rows: { [kick.id]: [1, 0, 0, 0.75] } },
        tracks: [...project.tracks, drumTrack],
        timeSignature: { numerator: 4, denominator: 4 },
        sourceBpm: project.bpm,
        candidateLabel: "#1",
        isSourceCurrent: () => true,
        onClose: vi.fn(),
        clientId: "",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "NAČÍTAŤ AUDIOTOOL CONNECTOR" }));
    fireEvent.click(await screen.findByRole("button", { name: "VYTVORIŤ OFFLINE DOKUMENT" }));
    expect(await screen.findByText(/lokálny dokument/)).toBeInTheDocument();
    expect(audiotoolPopupMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "VLOŽIŤ DO LOKÁLNEHO DOKUMENTU" }));
    expect(await screen.findByRole("button", { name: "VLOŽENÉ LOKÁLNE" })).toBeInTheDocument();
    expect(localDocument.queryEntities.ofTypes("beatbox8").get()).toHaveLength(1);
    expect(localDocument.queryEntities.ofTypes("beatbox8Pattern").get()).toHaveLength(1);
    expect(localDocument.queryEntities.ofTypes("patternRegion").get()[0]?.fields.region.fields.isEnabled.value).toBe(
      true,
    );
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
