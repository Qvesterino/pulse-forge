import type { OfflineDocument, SyncedDocument } from "@audiotool/nexus";
import type { NexusEntity } from "@audiotool/nexus/document";
import { AUDIOTOOL_BEATBOX_STEP_TICKS, MAX_AUDIOTOOL_BEATBOX_STEPS, type AudiotoolWritePlan } from "./mapping";

export interface AudiotoolWriteReceipt {
  status: "created" | "already-imported";
  parts: number;
  notes: number;
  drumPatterns: number;
  drumHits: number;
  collapsedDrumHits: number;
  devices: number;
  mixerChannels: number;
  cables: number;
}

export interface AudiotoolWriteOptions {
  /** Rechecked after Nexus acquires its transaction lock and before any entity is created. */
  isWriteStillAuthorized?: () => boolean;
}

const MARKER_PREFIX = "KYX-NEXUS";

/** Create-only write. MIDI and Beatbox8 drum graphs are committed atomically. */
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
  const midiMarkers = plan.parts.map((_, index) => `${MARKER_PREFIX}:${plan.fingerprint}:${index + 1}`);
  const drumMarker = plan.drumPattern ? `${MARKER_PREFIX}:${plan.fingerprint}:drums` : null;
  const allMarkers = [...midiMarkers, ...(drumMarker ? [drumMarker] : [])];

  let alreadyImported = false;
  const countsBefore = await document.modify((transaction) => {
    // modify() can wait for the Nexus transaction lock. Revalidate the exact source
    // after acquiring it, before touching the remote project.
    assertWritable();
    const initialCounts = entityCounts(transaction.entities);
    const existingDevices = [
      ...transaction.entities
        .ofTypes("heisenberg")
        .get()
        .map((device) => device.fields.displayName.value),
      ...transaction.entities
        .ofTypes("beatbox8")
        .get()
        .map((device) => device.fields.displayName.value),
    ];
    const found = allMarkers.filter((marker) => existingDevices.some((name) => name.startsWith(`${marker} · `)));
    if (found.length === allMarkers.length && hasCompleteImport(transaction.entities, plan, midiMarkers, drumMarker)) {
      alreadyImported = true;
      return initialCounts;
    }
    if (found.length > 0) {
      // Device names alone are not proof that the MIDI and output route survived.
      // Never report success or create a duplicate when a retry finds an incomplete graph.
      throw new Error("A partial KYX import marker already exists in this Audiotool project.");
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

    plan.parts.forEach((part, index) => {
      const marker = midiMarkers[index];
      if (!marker) throw new Error("The Audiotool write plan is incomplete.");
      const title = `${MARKER_PREFIX}:${plan.fingerprint}:${index + 1} · ${part.name}`.slice(0, 96);
      const player = transaction.create("heisenberg", {
        displayName: title,
        positionX: 1000 + index * 320,
        positionY: 250,
        isActive: true,
        operatorA: { gain: 1, waveformIndex: 1 },
      });
      const noteTrack = transaction.create("noteTrack", {
        orderAmongTracks: nextTrackOrder++,
        isEnabled: true,
        player: player.location,
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
          orderAmongStrips: nextStripOrder++,
        },
      });
      transaction.create("desktopAudioCable", {
        fromSocket: player.fields.audioOutput.location,
        toSocket: mixerChannel.fields.audioInput.location,
      });
    });

    if (plan.drumPattern && drumMarker) {
      const title = `${drumMarker} · KYX Drums`.slice(0, 96);
      const device = transaction.create("beatbox8", {
        displayName: title,
        positionX: 1000 + plan.parts.length * 320,
        positionY: 500,
        isActive: true,
        accentAmount: 0.35,
      });
      const patternSlot = device.fields.patternSlots.array[0];
      if (!patternSlot) throw new Error("Audiotool Beatbox8 did not expose pattern slot 1.");
      transaction.create("beatbox8Pattern", {
        slot: patternSlot.location,
        length: plan.drumPattern.length,
        stepScaleIndex: 3,
        steps: plan.drumPattern.steps,
      });
      const drumRegionDurationTicks = drumRegionDuration(plan);
      const drumTrack = transaction.create("patternTrack", {
        orderAmongTracks: nextTrackOrder++,
        isEnabled: true,
        player: device.location,
      });
      transaction.create("patternRegion", {
        track: drumTrack.location,
        patternIndex: 0,
        restart: true,
        region: {
          positionTicks: 0,
          durationTicks: drumRegionDurationTicks,
          collectionOffsetTicks: 0,
          loopOffsetTicks: 0,
          loopDurationTicks: drumRegionDurationTicks,
          isEnabled: true,
          displayName: "KYX Drums",
        },
      });
      const mixerChannel = transaction.create("mixerChannel", {
        displayParameters: {
          displayName: "KYX Drums",
          orderAmongStrips: nextStripOrder++,
        },
      });
      transaction.create("desktopAudioCable", {
        fromSocket: device.fields.audioOutput.location,
        toSocket: mixerChannel.fields.audioInput.location,
      });
    }
    return initialCounts;
  });

  if (alreadyImported) {
    return {
      status: "already-imported",
      parts: 0,
      notes: 0,
      drumPatterns: 0,
      drumHits: 0,
      collapsedDrumHits: 0,
      devices: 0,
      mixerChannels: 0,
      cables: 0,
    };
  }

  const after = entityCounts(document.queryEntities);
  const drumPatternCount = plan.drumPattern ? 1 : 0;
  if (
    after.heisenberg - countsBefore.heisenberg < plan.parts.length ||
    after.noteTrack - countsBefore.noteTrack < plan.parts.length ||
    after.noteRegion - countsBefore.noteRegion < plan.parts.length ||
    after.noteCollection - countsBefore.noteCollection < plan.parts.length ||
    after.note - countsBefore.note < plan.noteCount ||
    after.beatbox8 - countsBefore.beatbox8 < drumPatternCount ||
    after.beatbox8Pattern - countsBefore.beatbox8Pattern < drumPatternCount ||
    after.patternTrack - countsBefore.patternTrack < drumPatternCount ||
    after.patternRegion - countsBefore.patternRegion < drumPatternCount ||
    after.mixerChannel - countsBefore.mixerChannel < plan.parts.length + drumPatternCount ||
    after.desktopAudioCable - countsBefore.desktopAudioCable < plan.parts.length + drumPatternCount
  ) {
    throw new Error(
      "Audiotool did not confirm every new KYX MIDI/drum and mixer entity. Inspect the target project before retrying.",
    );
  }

  const devices = document.queryEntities.ofTypes("heisenberg").get();
  const created = devices.filter((device) =>
    plan.parts.some((_, index) =>
      device.fields.displayName.value.startsWith(`${MARKER_PREFIX}:${plan.fingerprint}:${index + 1} · `),
    ),
  );
  if (created.length !== plan.parts.length) {
    throw new Error("Audiotool did not confirm every new KYX synth. Inspect the target project before retrying.");
  }
  if (!hasCompleteImport(document.queryEntities, plan, midiMarkers, drumMarker)) {
    throw new Error(
      "Audiotool did not confirm a complete KYX MIDI/drum and mixer route graph. Inspect the target project before retrying.",
    );
  }

  return {
    status: "created",
    parts: plan.parts.length,
    notes: plan.noteCount,
    drumPatterns: drumPatternCount,
    drumHits: plan.drumHitCount,
    collapsedDrumHits: plan.collapsedDrumHits,
    devices: plan.parts.length + drumPatternCount,
    mixerChannels: plan.parts.length + drumPatternCount,
    cables: plan.parts.length + drumPatternCount,
  };
}

function entityCounts(query: SyncedDocument["queryEntities"]) {
  return {
    heisenberg: query.ofTypes("heisenberg").get().length,
    beatbox8: query.ofTypes("beatbox8").get().length,
    beatbox8Pattern: query.ofTypes("beatbox8Pattern").get().length,
    noteTrack: query.ofTypes("noteTrack").get().length,
    patternTrack: query.ofTypes("patternTrack").get().length,
    noteRegion: query.ofTypes("noteRegion").get().length,
    patternRegion: query.ofTypes("patternRegion").get().length,
    noteCollection: query.ofTypes("noteCollection").get().length,
    note: query.ofTypes("note").get().length,
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
  const devices = query.ofTypes("heisenberg").get();
  const tracks = query.ofTypes("noteTrack").get();
  const regions = query.ofTypes("noteRegion").get();
  const collections = query.ofTypes("noteCollection").get();
  const notes = query.ofTypes("note").get();
  const mixerChannels = query.ofTypes("mixerChannel").get();
  const cables = query.ofTypes("desktopAudioCable").get();

  const midiIsComplete = plan.parts.every((part, index) => {
    const marker = midiMarkers[index];
    if (!marker) return false;
    const matchingDevices = devices.filter((device) => device.fields.displayName.value.startsWith(`${marker} · `));
    if (matchingDevices.length !== 1) return false;
    const device = matchingDevices[0];
    if (!device || device.fields.isActive.value !== true || device.fields.operatorA.fields.gain.value <= 0)
      return false;

    const matchingTracks = tracks.filter((track) => track.fields.player.value.equals(device.location));
    if (matchingTracks.length !== 1) return false;
    const track = matchingTracks[0];
    if (!track) return false;

    const matchingRegions = regions.filter((region) => region.fields.track.value.equals(track.location));
    if (matchingRegions.length !== 1) return false;
    const region = matchingRegions[0];
    if (!region) return false;
    if (
      region.fields.region.fields.positionTicks.value !== 0 ||
      region.fields.region.fields.durationTicks.value !== plan.durationTicks ||
      region.fields.region.fields.collectionOffsetTicks.value !== 0 ||
      region.fields.region.fields.loopOffsetTicks.value !== 0 ||
      region.fields.region.fields.loopDurationTicks.value !== plan.durationTicks
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
    if (track.fields.isEnabled.value !== true || region.fields.region.fields.isEnabled.value !== true) return false;

    const outputCables = cables.filter((cable) =>
      cable.fields.fromSocket.value.equals(device.fields.audioOutput.location),
    );
    if (outputCables.length !== 1) return false;
    const linkedChannels = mixerChannels.filter((channel) =>
      channel.fields.audioInput.location.equals(outputCables[0]!.fields.toSocket.value),
    );
    return (
      linkedChannels.length === 1 &&
      linkedChannels[0]?.fields.displayParameters.fields.displayName.value === `${part.name} · KYX`
    );
  });
  if (!midiIsComplete) return false;
  if (!plan.drumPattern || !drumMarker) return true;

  const matchingDevices = query
    .ofTypes("beatbox8")
    .get()
    .filter((device) => device.fields.displayName.value.startsWith(`${drumMarker} · `));
  if (matchingDevices.length !== 1) return false;
  const device = matchingDevices[0];
  if (!device || device.fields.isActive.value !== true) return false;
  const patternSlot = device.fields.patternSlots.array[0];
  if (!patternSlot) return false;
  const matchingPatterns = query
    .ofTypes("beatbox8Pattern")
    .get()
    .filter((pattern) => pattern.fields.slot.value.equals(patternSlot.location));
  if (matchingPatterns.length !== 1) return false;
  const pattern = matchingPatterns[0];
  if (
    !pattern ||
    pattern.fields.length.value !== plan.drumPattern.length ||
    pattern.fields.stepScaleIndex.value !== 3 ||
    !matchesBeatboxSteps(pattern.fields.steps.array, plan.drumPattern.steps)
  ) {
    return false;
  }

  const drumTracks = query
    .ofTypes("patternTrack")
    .get()
    .filter((track) => track.fields.player.value.equals(device.location));
  if (drumTracks.length !== 1 || drumTracks[0]?.fields.isEnabled.value !== true) return false;
  const drumTrack = drumTracks[0];
  if (!drumTrack) return false;
  const drumRegions = query
    .ofTypes("patternRegion")
    .get()
    .filter((region) => region.fields.track.value.equals(drumTrack.location));
  if (drumRegions.length !== 1) return false;
  const drumRegion = drumRegions[0];
  if (
    !drumRegion ||
    drumRegion.fields.patternIndex.value !== 0 ||
    drumRegion.fields.region.fields.positionTicks.value !== 0 ||
    drumRegion.fields.region.fields.durationTicks.value !== drumRegionDuration(plan) ||
    drumRegion.fields.region.fields.collectionOffsetTicks.value !== 0 ||
    drumRegion.fields.region.fields.loopOffsetTicks.value !== 0 ||
    drumRegion.fields.region.fields.loopDurationTicks.value !== drumRegionDuration(plan) ||
    drumRegion.fields.region.fields.isEnabled.value !== true
  ) {
    return false;
  }

  const outputCables = cables.filter((cable) =>
    cable.fields.fromSocket.value.equals(device.fields.audioOutput.location),
  );
  if (outputCables.length !== 1) return false;
  const linkedChannels = mixerChannels.filter((channel) =>
    channel.fields.audioInput.location.equals(outputCables[0]!.fields.toSocket.value),
  );
  return (
    linkedChannels.length === 1 && linkedChannels[0]?.fields.displayParameters.fields.displayName.value === "KYX Drums"
  );
}

function drumRegionDuration(plan: AudiotoolWritePlan): number {
  if (!plan.drumPattern || plan.drumPattern.sourceStepCount <= MAX_AUDIOTOOL_BEATBOX_STEPS) {
    return plan.durationTicks;
  }
  return Math.min(plan.durationTicks, MAX_AUDIOTOOL_BEATBOX_STEPS * AUDIOTOOL_BEATBOX_STEP_TICKS);
}

function matchesBeatboxSteps(
  actual: readonly NexusEntity<"beatbox8Pattern">["fields"]["steps"]["array"][number][],
  expected: AudiotoolWritePlan["drumPattern"] extends infer T ? (T extends { steps: infer S } ? S : never) : never,
): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((step, index) => {
    const actualStep = actual[index];
    if (!actualStep) return false;
    return (
      actualStep.fields.bassdrumIsActive.value === step.bassdrumIsActive &&
      actualStep.fields.snaredrumIsActive.value === step.snaredrumIsActive &&
      actualStep.fields.tomCongaLowIsActive.value === step.tomCongaLowIsActive &&
      actualStep.fields.tomCongaMidIsActive.value === step.tomCongaMidIsActive &&
      actualStep.fields.tomCongaHighIsActive.value === step.tomCongaHighIsActive &&
      actualStep.fields.rimClavesIsActive.value === step.rimClavesIsActive &&
      actualStep.fields.clapMaracasIsActive.value === step.clapMaracasIsActive &&
      actualStep.fields.cowbellIsActive.value === step.cowbellIsActive &&
      actualStep.fields.cymbalIsActive.value === step.cymbalIsActive &&
      actualStep.fields.openHihatIsActive.value === step.openHihatIsActive &&
      actualStep.fields.closedHihatIsActive.value === step.closedHihatIsActive &&
      actualStep.fields.isAccented.value === step.isAccented
    );
  });
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
