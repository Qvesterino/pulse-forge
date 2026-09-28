import type { OfflineDocument, SyncedDocument } from "@audiotool/nexus";
import type { NexusPreset } from "@audiotool/nexus/api";
import type { NexusEntity, SafeTransactionBuilder } from "@audiotool/nexus/document";
import {
  AUDIOTOOL_BEATBOX_STEP_TICKS,
  MAX_AUDIOTOOL_BEATBOX_STEPS,
  type AudiotoolBeatboxStep,
  type AudiotoolWritePlan,
} from "./mapping";

export interface AudiotoolWriteReceipt {
  status: "created" | "already-imported";
  parts: number;
  notes: number;
  devices: number;
  beatboxDevices: number;
  drumPatterns: number;
  drumHits: number;
  collapsedDrumHits: number;
  mixerChannels: number;
  cables: number;
}

export interface AudiotoolWriteOptions {
  /** Rechecked after Nexus acquires its transaction lock and before any entity is created. */
  isWriteStillAuthorized?: () => boolean;
  /** Optional Audiotool GM soundfont presets, keyed by 0-based GM program. */
  gakkiPresets?: ReadonlyMap<number, NexusPreset<"gakki">>;
}

const MARKER_PREFIX = "KYX-NEXUS";

const emptyWriteReceipt = (status: AudiotoolWriteReceipt["status"]): AudiotoolWriteReceipt => ({
  status,
  parts: 0,
  notes: 0,
  devices: 0,
  beatboxDevices: 0,
  drumPatterns: 0,
  drumHits: 0,
  collapsedDrumHits: 0,
  mixerChannels: 0,
  cables: 0,
});

/** Create-only write. Every new synth, note lane and output route is one SDK transaction. */
export async function writeAudiotoolPlan(
  document: SyncedDocument | OfflineDocument,
  plan: AudiotoolWritePlan,
  options: AudiotoolWriteOptions = {},
): Promise<AudiotoolWriteReceipt> {
  const assertWritable = () => {
    if (options.isWriteStillAuthorized && !options.isWriteStillAuthorized()) {
      throw new Error("The KYX source changed before the Audiotool write began.");
    }
    if ("start" in document && !document.connected.getValue()) {
      throw new Error("Audiotool is disconnected. Reconnect and review the project before retrying.");
    }
  };
  assertWritable();
  if (plan.instrumentMode === "gakki" && !options.gakkiPresets) {
    throw new Error("Audiotool Gakki presets must be loaded before writing this plan.");
  }
  if (plan.instrumentMode === "gakki" && options.gakkiPresets) {
    for (const part of plan.parts) {
      if (!options.gakkiPresets.has(part.gmProgram)) {
        throw new Error(`The selected Audiotool GM sound ${part.gmProgram + 1} was not loaded.`);
      }
    }
  }
  const midiMarkers = midiPlanMarkers(plan, plan.fingerprint);
  const drumMarker = plan.drumPattern ? `${MARKER_PREFIX}:${plan.fingerprint}:drums` : null;
  const expectedMarkers = [...midiMarkers, ...(drumMarker ? [drumMarker] : [])];
  const currentMidiMarkers = plan.parts.length > 0 ? midiPlanMarkers(plan, fingerprintMidiOnlyPlan(plan)) : [];
  const previousMidiMarkers = plan.parts.length > 0 ? midiPlanMarkers(plan, fingerprintLegacyMidiOnlyPlan(plan)) : [];

  const decision = await document.modify((transaction) => {
    // modify() can wait for the Nexus transaction lock. Revalidate the exact source
    // after acquiring it, before touching the remote project.
    assertWritable();
    const countsBefore = entityCounts(transaction.entities);
    const deviceNames = [
      ...transaction.entities
        .ofTypes("heisenberg", "gakki")
        .get()
        .map((device) => device.fields.displayName.value),
      ...transaction.entities
        .ofTypes("beatbox8")
        .get()
        .map((device) => device.fields.displayName.value),
    ];
    const found = expectedMarkers.filter((marker) => deviceNames.some((name) => name.startsWith(`${marker} · `)));
    if (
      found.length === expectedMarkers.length &&
      hasCompleteImport(transaction.entities, plan, midiMarkers, drumMarker)
    ) {
      return {
        countsBefore,
        alreadyImported: true,
        createMidi: false,
        createDrums: false,
        midiMarkersToVerify: midiMarkers,
      };
    }

    const currentMidiFound = currentMidiMarkers.filter((marker) =>
      deviceNames.some((name) => name.startsWith(`${marker} · `)),
    );
    const previousMidiFound = previousMidiMarkers.filter((marker) =>
      deviceNames.some((name) => name.startsWith(`${marker} · `)),
    );
    const currentMidiComplete =
      currentMidiMarkers.length > 0 &&
      currentMidiFound.length === currentMidiMarkers.length &&
      hasCompleteMidiImport(transaction.entities, plan, currentMidiMarkers);
    const previousMidiComplete =
      plan.instrumentMode === "heisenberg" &&
      previousMidiMarkers.length > 0 &&
      previousMidiFound.length === previousMidiMarkers.length &&
      hasCompleteMidiImport(transaction.entities, plan, previousMidiMarkers);
    const legacyMidiComplete = currentMidiComplete || previousMidiComplete;
    const legacyMidiMarkers = currentMidiComplete ? currentMidiMarkers : previousMidiMarkers;
    const legacyFound = [...new Set([...currentMidiFound, ...previousMidiFound])];
    const legacyDrumFound = drumMarker && deviceNames.some((name) => name.startsWith(`${drumMarker} · `));
    if (legacyMidiComplete) {
      if (!plan.drumPattern) {
        return {
          countsBefore,
          alreadyImported: true,
          createMidi: false,
          createDrums: false,
          midiMarkersToVerify: legacyMidiMarkers,
        };
      }
      if (legacyDrumFound) {
        if (hasCompleteDrumImport(transaction.entities, plan, drumMarker)) {
          return {
            countsBefore,
            alreadyImported: true,
            createMidi: false,
            createDrums: false,
            midiMarkersToVerify: legacyMidiMarkers,
          };
        }
        throw new Error("A partial KYX Beatbox8 import marker already exists in this Audiotool project.");
      }
    }
    if (found.length > 0) {
      throw new Error("A partial KYX import marker already exists in this Audiotool project.");
    }
    if (legacyFound.length > 0 && !legacyMidiComplete) {
      throw new Error("A partial legacy KYX MIDI import marker already exists in this Audiotool project.");
    }

    const timelineTracks = transaction.entities
      .ofTypes("noteTrack", "audioTrack", "automationTrack", "patternTrack")
      .get();
    let nextTrackOrder =
      timelineTracks.reduce((maximum, entity) => Math.max(maximum, entity.fields.orderAmongTracks.value), -1) + 1;

    const existingStrips = transaction.entities
      .ofTypes("mixerChannel", "mixerGroup", "mixerAux", "mixerDelayAux", "mixerReverbAux")
      .get();
    let nextStripOrder =
      existingStrips.reduce(
        (maximum, entity) => Math.max(maximum, entity.fields.displayParameters.fields.orderAmongStrips.value),
        -1,
      ) + 1;

    const midiTrackCount = !legacyMidiComplete ? plan.parts.length : 0;
    if (midiTrackCount > 0)
      createMidiEntities(transaction, plan, midiMarkers, nextTrackOrder, nextStripOrder, options.gakkiPresets);
    if (plan.drumPattern && drumMarker) {
      createBeatboxEntities(
        transaction,
        plan,
        drumMarker,
        nextTrackOrder + midiTrackCount,
        nextStripOrder + midiTrackCount,
      );
    }
    return {
      countsBefore,
      alreadyImported: false,
      createMidi: !legacyMidiComplete && plan.parts.length > 0,
      createDrums: plan.drumPattern !== undefined,
      midiMarkersToVerify: legacyMidiComplete ? legacyMidiMarkers : midiMarkers,
    };
  });

  if (decision.alreadyImported) return emptyWriteReceipt("already-imported");

  const after = entityCounts(document.queryEntities);
  const countsBefore = decision.countsBefore;
  const expectedMidiParts = decision.createMidi ? plan.parts.length : 0;
  const expectedMidiNotes = decision.createMidi ? plan.noteCount : 0;
  const expectedDrumDevices = decision.createDrums ? 1 : 0;
  if (
    after.midiDevices - countsBefore.midiDevices < expectedMidiParts ||
    after.noteTrack - countsBefore.noteTrack < expectedMidiParts ||
    after.noteRegion - countsBefore.noteRegion < expectedMidiParts ||
    after.noteCollection - countsBefore.noteCollection < expectedMidiParts ||
    after.note - countsBefore.note < expectedMidiNotes ||
    after.beatbox8 - countsBefore.beatbox8 < expectedDrumDevices ||
    after.beatbox8Pattern - countsBefore.beatbox8Pattern < expectedDrumDevices ||
    after.patternTrack - countsBefore.patternTrack < expectedDrumDevices ||
    after.patternRegion - countsBefore.patternRegion < expectedDrumDevices ||
    after.mixerChannel - countsBefore.mixerChannel < expectedMidiParts + expectedDrumDevices ||
    after.desktopAudioCable - countsBefore.desktopAudioCable < expectedMidiParts + expectedDrumDevices
  ) {
    throw new Error(
      "Audiotool did not confirm every new KYX MIDI, Beatbox8, and mixer entity. Inspect the target project before retrying.",
    );
  }

  if (!hasCompleteImport(document.queryEntities, plan, decision.midiMarkersToVerify, drumMarker)) {
    throw new Error(
      "Audiotool did not confirm a complete KYX MIDI/Beatbox8 timeline and mixer route graph. Inspect the target project before retrying.",
    );
  }

  return {
    status: "created",
    parts: expectedMidiParts,
    notes: expectedMidiNotes,
    devices: expectedMidiParts,
    beatboxDevices: expectedDrumDevices,
    drumPatterns: expectedDrumDevices,
    drumHits: decision.createDrums ? (plan.drumPattern?.hitCount ?? 0) : 0,
    collapsedDrumHits: decision.createDrums ? plan.collapsedDrumHits : 0,
    mixerChannels: expectedMidiParts + expectedDrumDevices,
    cables: expectedMidiParts + expectedDrumDevices,
  };
}

function midiPlanMarkers(plan: AudiotoolWritePlan, fingerprint: string): string[] {
  return plan.parts.map((_, index) => `${MARKER_PREFIX}:${fingerprint}:${index + 1}`);
}

function fingerprintLegacyMidiOnlyPlan(plan: AudiotoolWritePlan): string {
  const value = JSON.stringify({
    projectId: plan.projectId,
    sourceBpm: plan.sourceBpm,
    timeSignature: plan.timeSignature,
    durationTicks: plan.durationTicks,
    parts: plan.parts.map(({ name, notes }) => ({ name, notes })),
  });
  return stableFingerprint(value);
}

function fingerprintMidiOnlyPlan(plan: AudiotoolWritePlan): string {
  const value = JSON.stringify({
    projectId: plan.projectId,
    instrumentMode: plan.instrumentMode,
    sourceBpm: plan.sourceBpm,
    timeSignature: plan.timeSignature,
    durationTicks: plan.durationTicks,
    parts: plan.parts.map(({ name, gmProgram, notes }) => ({ name, gmProgram, notes })),
  });
  return stableFingerprint(value);
}

function createMidiEntities(
  transaction: SafeTransactionBuilder,
  plan: AudiotoolWritePlan,
  markers: readonly string[],
  nextTrackOrder: number,
  nextStripOrder: number,
  gakkiPresets?: ReadonlyMap<number, NexusPreset<"gakki">>,
): void {
  plan.parts.forEach((part, index) => {
    const marker = markers[index];
    if (!marker) throw new Error("The Audiotool write plan is incomplete.");
    const title = `${marker} · ${part.name}`.slice(0, 96);
    const positionX = 1000 + index * 320;
    const preset = plan.instrumentMode === "gakki" ? gakkiPresets?.get(part.gmProgram) : undefined;
    if (plan.instrumentMode === "gakki" && !preset) {
      throw new Error(`The selected Audiotool GM sound ${part.gmProgram + 1} was not loaded.`);
    }
    const player = preset
      ? transaction.createDeviceFromPreset(preset)
      : transaction.create("heisenberg", {
          displayName: title,
          positionX,
          positionY: 250,
          isActive: true,
          operatorA: { gain: 1, waveformIndex: 1 },
        });
    if (preset) {
      transaction.update(player.fields.displayName, title);
      transaction.update(player.fields.positionX, positionX);
      transaction.update(player.fields.positionY, 250);
    }
    const noteTrack = transaction.create("noteTrack", {
      orderAmongTracks: nextTrackOrder++,
      player: player.location,
      isEnabled: true,
    });
    const collection = transaction.create("noteCollection", {});
    transaction.create("noteRegion", {
      track: noteTrack.location,
      collection: collection.location,
      region: {
        positionTicks: 0,
        durationTicks: plan.durationTicks,
        collectionOffsetTicks: 0,
        loopOffsetTicks: 0,
        loopDurationTicks: plan.durationTicks,
        isEnabled: true,
        displayName: `${part.name} · KYX`,
      },
    });

    for (const note of part.notes) {
      transaction.create("note", {
        collection: collection.location,
        positionTicks: note.positionTicks,
        durationTicks: note.durationTicks,
        pitch: note.pitch,
        velocity: note.velocity,
        doesSlide: note.doesSlide,
      });
    }

    const mixerChannel = transaction.create("mixerChannel", {
      displayParameters: {
        displayName: `${part.name} · KYX`,
        orderAmongStrips: nextStripOrder + index,
      },
    });
    transaction.create("desktopAudioCable", {
      fromSocket: player.fields.audioOutput.location,
      toSocket: mixerChannel.fields.audioInput.location,
    });
  });
}

function createBeatboxEntities(
  transaction: SafeTransactionBuilder,
  plan: AudiotoolWritePlan,
  marker: string,
  nextTrackOrder: number,
  nextStripOrder: number,
): void {
  const drums = plan.drumPattern;
  if (!drums) throw new Error("The Audiotool drum plan is incomplete.");
  const beatbox = transaction.create("beatbox8", {
    displayName: `${marker} · Beatbox 8`,
    positionX: 1000 + plan.parts.length * 320,
    positionY: 520,
    isActive: true,
    accentAmount: 0.35,
    patternIndex: 0,
  });
  const patternSlot = beatbox.fields.patternSlots.array[0];
  if (!patternSlot) throw new Error("Audiotool Beatbox8 did not expose its first pattern slot.");
  transaction.create("beatbox8Pattern", {
    slot: patternSlot.location,
    length: drums.length,
    stepScaleIndex: 3,
    steps: drums.steps,
  });
  const patternTrack = transaction.create("patternTrack", {
    orderAmongTracks: nextTrackOrder,
    player: beatbox.location,
    isEnabled: true,
  });
  const durationTicks = drumRegionDuration(plan);
  const loopDurationTicks = Math.min(durationTicks, drums.length * AUDIOTOOL_BEATBOX_STEP_TICKS);
  transaction.create("patternRegion", {
    track: patternTrack.location,
    patternIndex: 0,
    restart: true,
    region: {
      positionTicks: 0,
      durationTicks,
      collectionOffsetTicks: 0,
      loopOffsetTicks: 0,
      loopDurationTicks,
      isEnabled: true,
      displayName: "KYX Drums · Beatbox 8",
    },
  });
  const mixerChannel = transaction.create("mixerChannel", {
    displayParameters: {
      displayName: "KYX Drums · Beatbox 8",
      orderAmongStrips: nextStripOrder + plan.parts.length,
    },
  });
  transaction.create("desktopAudioCable", {
    fromSocket: beatbox.fields.audioOutput.location,
    toSocket: mixerChannel.fields.audioInput.location,
  });
}

function drumRegionDuration(plan: AudiotoolWritePlan): number {
  const drums = plan.drumPattern;
  if (!drums) return 0;
  if (drums.sourceStepCount > MAX_AUDIOTOOL_BEATBOX_STEPS) {
    return Math.min(plan.durationTicks, MAX_AUDIOTOOL_BEATBOX_STEPS * AUDIOTOOL_BEATBOX_STEP_TICKS);
  }
  return plan.durationTicks;
}

function stableFingerprint(value: string): string {
  const seeds = [0x811c9dc5, 0x9747b28c, 0x85ebca6b, 0xc2b2ae35];
  return seeds
    .map((seed) => {
      let hash = seed >>> 0;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
        hash ^= hash >>> 13;
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    })
    .join("");
}

function entityCounts(query: SyncedDocument["queryEntities"]) {
  return {
    midiDevices: query.ofTypes("heisenberg", "gakki").get().length,
    noteTrack: query.ofTypes("noteTrack").get().length,
    noteRegion: query.ofTypes("noteRegion").get().length,
    noteCollection: query.ofTypes("noteCollection").get().length,
    note: query.ofTypes("note").get().length,
    beatbox8: query.ofTypes("beatbox8").get().length,
    beatbox8Pattern: query.ofTypes("beatbox8Pattern").get().length,
    patternTrack: query.ofTypes("patternTrack").get().length,
    patternRegion: query.ofTypes("patternRegion").get().length,
    mixerChannel: query.ofTypes("mixerChannel").get().length,
    desktopAudioCable: query.ofTypes("desktopAudioCable").get().length,
  };
}

function hasCompleteImport(
  query: SyncedDocument["queryEntities"],
  plan: AudiotoolWritePlan,
  midiMarkers: readonly string[],
  drumMarker: string | null,
): boolean {
  return (
    hasCompleteMidiImport(query, plan, midiMarkers) &&
    (!plan.drumPattern || (drumMarker !== null && hasCompleteDrumImport(query, plan, drumMarker)))
  );
}

function hasCompleteMidiImport(
  query: SyncedDocument["queryEntities"],
  plan: AudiotoolWritePlan,
  markers: readonly string[],
): boolean {
  const devices = query.ofTypes(plan.instrumentMode).get();
  const tracks = query.ofTypes("noteTrack").get();
  const regions = query.ofTypes("noteRegion").get();
  const collections = query.ofTypes("noteCollection").get();
  const notes = query.ofTypes("note").get();
  const mixerChannels = query.ofTypes("mixerChannel").get();
  const cables = query.ofTypes("desktopAudioCable").get();

  return plan.parts.every((part, index) => {
    const marker = markers[index];
    if (!marker) return false;
    const matchingDevices = devices.filter((device) => device.fields.displayName.value.startsWith(`${marker} · `));
    if (matchingDevices.length !== 1) return false;
    const device = matchingDevices[0];
    if (!device) return false;
    if (plan.instrumentMode === "heisenberg" && device.entityType === "heisenberg") {
      if (
        device.fields.isActive.value !== true ||
        device.fields.operatorA.fields.gain.value <= 0 ||
        device.fields.operatorA.fields.waveformIndex.value !== 1
      ) {
        return false;
      }
    } else if (plan.instrumentMode === "gakki" && device.entityType === "gakki") {
      if (device.fields.gain.value <= 0 || device.fields.soundfontId.value.length === 0) return false;
    } else return false;

    const matchingTracks = tracks.filter((track) => track.fields.player.value.equals(device.location));
    if (matchingTracks.length !== 1) return false;
    const track = matchingTracks[0];
    if (!track || track.fields.isEnabled.value !== true) return false;

    const matchingRegions = regions.filter((region) => region.fields.track.value.equals(track.location));
    if (matchingRegions.length !== 1) return false;
    const region = matchingRegions[0];
    if (!region) return false;
    if (
      region.fields.region.fields.positionTicks.value !== 0 ||
      region.fields.region.fields.durationTicks.value !== plan.durationTicks ||
      region.fields.region.fields.collectionOffsetTicks.value !== 0 ||
      region.fields.region.fields.loopOffsetTicks.value !== 0 ||
      region.fields.region.fields.loopDurationTicks.value !== plan.durationTicks ||
      region.fields.region.fields.isEnabled.value !== true
    ) {
      return false;
    }

    const collectionLocation = region.fields.collection.value;
    const matchingCollections = collections.filter((collection) => collection.location.equals(collectionLocation));
    if (matchingCollections.length !== 1) return false;
    const collection = matchingCollections[0];
    if (!collection) return false;

    const linkedNotes = notes.filter((note) => note.fields.collection.value.equals(collection.location));
    if (!matchesNotes(linkedNotes, part.notes)) return false;

    const outputCables = cables.filter((cable) =>
      cable.fields.fromSocket.value.equals(device.fields.audioOutput.location),
    );
    const linkedChannels = mixerChannels.filter(
      (channel) => channel.fields.displayParameters.fields.displayName.value === `${part.name} · KYX`,
    );
    if (linkedChannels.length !== 1 || !linkedChannels[0]) return false;
    const routeCount = outputCables.filter((cable) =>
      cable.fields.toSocket.value.equals(linkedChannels[0]!.fields.audioInput.location),
    ).length;
    return routeCount === 1;
  });
}

function hasCompleteDrumImport(
  query: SyncedDocument["queryEntities"],
  plan: AudiotoolWritePlan,
  marker: string,
): boolean {
  const drums = plan.drumPattern;
  if (!drums) return false;
  const devices = query
    .ofTypes("beatbox8")
    .get()
    .filter((device) => device.fields.displayName.value.startsWith(`${marker} · `));
  if (devices.length !== 1) return false;
  const device = devices[0];
  if (!device || device.fields.isActive.value !== true) return false;

  const slot = device.fields.patternSlots.array[0];
  if (!slot) return false;
  const patterns = query
    .ofTypes("beatbox8Pattern")
    .get()
    .filter((pattern) => pattern.fields.slot.value.equals(slot.location));
  if (patterns.length !== 1) return false;
  const pattern = patterns[0];
  if (
    !pattern ||
    pattern.fields.length.value !== drums.length ||
    pattern.fields.stepScaleIndex.value !== 3 ||
    pattern.fields.steps.array.length !== MAX_AUDIOTOOL_BEATBOX_STEPS
  ) {
    return false;
  }
  const stepFields: Array<keyof Omit<AudiotoolBeatboxStep, "isAccented">> = [
    "bassdrumIsActive",
    "snaredrumIsActive",
    "tomCongaLowIsActive",
    "tomCongaMidIsActive",
    "tomCongaHighIsActive",
    "rimClavesIsActive",
    "clapMaracasIsActive",
    "cowbellIsActive",
    "cymbalIsActive",
    "openHihatIsActive",
    "closedHihatIsActive",
  ];
  for (let index = 0; index < MAX_AUDIOTOOL_BEATBOX_STEPS; index += 1) {
    const actual = pattern.fields.steps.array[index];
    const expected = drums.steps[index];
    if (!actual || !expected) return false;
    if (actual.fields.isAccented.value !== expected.isAccented) return false;
    for (const field of stepFields) if (actual.fields[field].value !== expected[field]) return false;
  }

  const tracks = query
    .ofTypes("patternTrack")
    .get()
    .filter((track) => track.fields.player.value.equals(device.location));
  if (tracks.length !== 1 || tracks[0]?.fields.isEnabled.value !== true) return false;
  const patternTrack = tracks[0];
  if (!patternTrack) return false;
  const regions = query
    .ofTypes("patternRegion")
    .get()
    .filter((region) => region.fields.track.value.equals(patternTrack.location));
  if (regions.length !== 1) return false;
  const patternRegion = regions[0];
  if (!patternRegion) return false;
  const durationTicks = drumRegionDuration(plan);
  const loopDurationTicks = Math.min(durationTicks, drums.length * AUDIOTOOL_BEATBOX_STEP_TICKS);
  if (
    patternRegion.fields.patternIndex.value !== 0 ||
    patternRegion.fields.region.fields.positionTicks.value !== 0 ||
    patternRegion.fields.region.fields.durationTicks.value !== durationTicks ||
    patternRegion.fields.region.fields.collectionOffsetTicks.value !== 0 ||
    patternRegion.fields.region.fields.loopOffsetTicks.value !== 0 ||
    patternRegion.fields.region.fields.loopDurationTicks.value !== loopDurationTicks ||
    patternRegion.fields.region.fields.isEnabled.value !== true
  ) {
    return false;
  }

  const cables = query
    .ofTypes("desktopAudioCable")
    .get()
    .filter((cable) => cable.fields.fromSocket.value.equals(device.fields.audioOutput.location));
  if (cables.length !== 1) return false;
  const channels = query
    .ofTypes("mixerChannel")
    .get()
    .filter((channel) => channel.fields.audioInput.location.equals(cables[0]!.fields.toSocket.value));
  return (
    channels.length === 1 && channels[0]?.fields.displayParameters.fields.displayName.value === "KYX Drums · Beatbox 8"
  );
}

function matchesNotes(
  entities: readonly NexusEntity<"note">[],
  expected: AudiotoolWritePlan["parts"][number]["notes"],
): boolean {
  if (entities.length !== expected.length) return false;
  const actualNotes = entities
    .map((note) => ({
      positionTicks: note.fields.positionTicks.value,
      pitch: note.fields.pitch.value,
      durationTicks: note.fields.durationTicks.value,
      velocity: note.fields.velocity.value,
      doesSlide: note.fields.doesSlide.value,
    }))
    .sort(compareAudiotoolNotes);
  const expectedNotes = [...expected].sort(compareAudiotoolNotes);
  return actualNotes.every((note, index) => {
    const expectedNote = expectedNotes[index];
    return (
      expectedNote !== undefined &&
      note.positionTicks === expectedNote.positionTicks &&
      note.pitch === expectedNote.pitch &&
      note.durationTicks === expectedNote.durationTicks &&
      Math.abs(note.velocity - expectedNote.velocity) <= 1e-6 &&
      note.doesSlide === expectedNote.doesSlide
    );
  });
}

function compareAudiotoolNotes(
  a: { positionTicks: number; pitch: number; durationTicks: number; velocity: number; doesSlide: boolean },
  b: { positionTicks: number; pitch: number; durationTicks: number; velocity: number; doesSlide: boolean },
): number {
  return (
    a.positionTicks - b.positionTicks ||
    a.pitch - b.pitch ||
    a.durationTicks - b.durationTicks ||
    a.velocity - b.velocity ||
    Number(a.doesSlide) - Number(b.doesSlide)
  );
}
