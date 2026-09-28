import type { OfflineDocument, SyncedDocument } from "@audiotool/nexus";
import type { NexusEntity } from "@audiotool/nexus/document";
import type { AudiotoolWritePlan } from "./mapping";

export interface AudiotoolWriteReceipt {
  status: "created" | "already-imported";
  parts: number;
  notes: number;
  devices: number;
  mixerChannels: number;
  cables: number;
}

export interface AudiotoolWriteOptions {
  /** Rechecked after Nexus acquires its transaction lock and before any entity is created. */
  isWriteStillAuthorized?: () => boolean;
}

const MARKER_PREFIX = "KYX-NEXUS";

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
  const planMarkers = plan.parts.map((_, index) => `${MARKER_PREFIX}:${plan.fingerprint}:${index + 1}`);

  let alreadyImported = false;
  const countsBefore = await document.modify((transaction) => {
    // modify() can wait for the Nexus transaction lock. Revalidate the exact source
    // after acquiring it, before touching the remote project.
    assertWritable();
    const initialCounts = entityCounts(transaction.entities);
    const existingDevices = transaction.entities.ofTypes("heisenberg").get();
    const markers = existingDevices.map((device) => device.fields.displayName.value);
    const found = planMarkers.filter((marker) => markers.some((name) => name.startsWith(`${marker} · `)));
    if (found.length === planMarkers.length && hasCompleteImport(transaction.entities, plan, planMarkers)) {
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
      const marker = planMarkers[index];
      if (!marker) throw new Error("The Audiotool write plan is incomplete.");
      const title = `${MARKER_PREFIX}:${plan.fingerprint}:${index + 1} · ${part.name}`.slice(0, 96);
      const player = transaction.create("heisenberg", {
        displayName: title,
        positionX: 1000 + index * 320,
        positionY: 250,
      });
      const noteTrack = transaction.create("noteTrack", {
        orderAmongTracks: nextTrackOrder++,
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
    return initialCounts;
  });

  if (alreadyImported) {
    return { status: "already-imported", parts: 0, notes: 0, devices: 0, mixerChannels: 0, cables: 0 };
  }

  const after = entityCounts(document.queryEntities);
  if (
    after.heisenberg - countsBefore.heisenberg < plan.parts.length ||
    after.noteTrack - countsBefore.noteTrack < plan.parts.length ||
    after.noteRegion - countsBefore.noteRegion < plan.parts.length ||
    after.noteCollection - countsBefore.noteCollection < plan.parts.length ||
    after.note - countsBefore.note < plan.noteCount ||
    after.mixerChannel - countsBefore.mixerChannel < plan.parts.length ||
    after.desktopAudioCable - countsBefore.desktopAudioCable < plan.parts.length
  ) {
    throw new Error(
      "Audiotool did not confirm every new KYX MIDI, synth, and mixer entity. Inspect the target project before retrying.",
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
  if (!hasCompleteImport(document.queryEntities, plan, planMarkers)) {
    throw new Error(
      "Audiotool did not confirm a complete KYX MIDI and mixer route graph. Inspect the target project before retrying.",
    );
  }

  return {
    status: "created",
    parts: plan.parts.length,
    notes: plan.noteCount,
    devices: plan.parts.length,
    mixerChannels: plan.parts.length,
    cables: plan.parts.length,
  };
}

function entityCounts(query: SyncedDocument["queryEntities"]) {
  return {
    heisenberg: query.ofTypes("heisenberg").get().length,
    noteTrack: query.ofTypes("noteTrack").get().length,
    noteRegion: query.ofTypes("noteRegion").get().length,
    noteCollection: query.ofTypes("noteCollection").get().length,
    note: query.ofTypes("note").get().length,
    mixerChannel: query.ofTypes("mixerChannel").get().length,
    desktopAudioCable: query.ofTypes("desktopAudioCable").get().length,
  };
}

function hasCompleteImport(
  query: SyncedDocument["queryEntities"],
  plan: AudiotoolWritePlan,
  markers: readonly string[],
): boolean {
  const devices = query.ofTypes("heisenberg").get();
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
