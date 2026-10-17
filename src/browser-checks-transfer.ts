import { ProjectRepository } from "./persistence/ProjectRepository";
import { UserSampleRepository, restoreUserSampleAudioMemoized } from "./persistence/UserSampleRepository";
import { AudioEngine } from "./audio-engine/AudioEngine";
import { generateFactoryBank, SampleBank } from "./sample-library/factory";
import { importAudioFile } from "./ui/sample-import";
import { Scheduler } from "./scheduler/Scheduler";
import { Transport } from "./transport/Transport";
import { buildTransferProject, inspectTransferFiles } from "./export/transfer-import";
import { writeMidiFile } from "./midi/midiFile";
import { renderProject } from "./rendering/renderer";

export const DAW_TRANSFER_FIXTURE_VERSION = "daw-transfer-v1";

function makeWav(sampleRate: number, frequency: number): Uint8Array<ArrayBuffer> {
  const frames = Math.floor(sampleRate / 4);
  const dataBytes = frames * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let frame = 0; frame < frames; frame++) {
    const sample = 0.035 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate + 0.2);
    view.setInt16(44 + frame * 2, Math.round(sample * 32767), true);
  }
  return bytes;
}

function midiFixtureFile(): { file: File; bytes: Uint8Array<ArrayBuffer> } {
  const source = writeMidiFile({
    bpm: 120,
    timeSignature: { num: 4, den: 4 },
    tracks: Array.from({ length: 4 }, (_, index) => ({
      name: `Fixture MIDI ${index + 1}`,
      channel: index,
      notes: [{ pitch: 60 + index * 3, startTick: 0, endTick: 960, velocity: 0.25 }],
    })),
  });
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return { file: new File([bytes.buffer], "Fixture MIDI.mid", { type: "audio/midi" }), bytes };
}

/** Real-browser acceptance path: decode/persist 8 WAVs + 4 MIDI lanes, reopen, restore media, and render. */
export async function runDawTransferAcceptance(): Promise<{
  fixtureVersion: string;
  importedAudioTracks: number;
  importedMidiTracks: number;
  reopenedAudioStartsAtBar: number[];
  restoredAudioAssets: number;
  renderedFrames: number;
  renderedPeak: number;
  firstQuarterSecondPeak: number;
  livePlaybackPeak: number;
  liveMidiTrackPeaks: Record<string, number>;
  liveNoteOnsDispatched: number;
  liveAudioClipsDispatched: number;
  liveTransportPosition: number;
}> {
  if (typeof AudioContext === "undefined" || typeof OfflineAudioContext === "undefined") {
    throw new Error("DAW transfer acceptance requires browser AudioContext and OfflineAudioContext support.");
  }

  const audioContext = new AudioContext();
  // The browser runner calls this function from a real button click so the
  // realtime context can resume under autoplay policies. Request resume
  // synchronously before the first await consumes that user activation.
  const audioContextResume = audioContext.resume();
  const projectRepo = new ProjectRepository();
  const sampleRepo = new UserSampleRepository();
  const initialBank = new SampleBank();
  const restoredBank = new SampleBank();
  const importedIds: string[] = [];
  let savedProjectId: string | null = null;
  let liveEngine: AudioEngine | null = null;
  let liveTransport: Transport | null = null;
  let liveScheduler: Scheduler | null = null;

  try {
    const audioFiles = Array.from({ length: 8 }, (_, index) => {
      const bytes = makeWav(audioContext.sampleRate, 180 + index * 31);
      return new File([bytes.buffer], `Fixture Stem ${String(index + 1).padStart(2, "0")}.wav`, {
        type: "audio/wav",
      });
    });
    const midi = midiFixtureFile();
    const inspection = await inspectTransferFiles([...audioFiles, midi.file]);
    if (inspection.errors.length > 0 || !inspection.parsedMidi) {
      throw new Error(`Fixture preflight failed: ${inspection.errors.join("; ") || "MIDI did not parse"}`);
    }
    if (inspection.audioFiles.length !== 8 || inspection.parsedMidi.tracks.length !== 4) {
      throw new Error("Fixture preflight did not retain all 8 audio files and 4 MIDI tracks.");
    }

    const importServices = {
      engine: { context: audioContext },
      bank: initialBank,
      userSamples: sampleRepo,
    } as unknown as Parameters<typeof importAudioFile>[0];
    const audioAssets = [];
    for (const [index, file] of inspection.audioFiles.entries()) {
      const assetId = `${DAW_TRANSFER_FIXTURE_VERSION}.audio-${index + 1}`;
      importedIds.push(assetId);
      const asset = await importAudioFile(importServices, file, { id: assetId, detectBpm: false });
      audioAssets.push({ fileName: file.name, assetId: asset.id, durationSec: asset.duration });
    }

    const transfer = buildTransferProject({
      projectName: "DAW Transfer Fixture v1",
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      audioAssets,
      midiFileName: midi.file.name,
      midiBytes: midi.bytes,
      parsedMidi: inspection.parsedMidi,
    });
    savedProjectId = transfer.doc.id;
    await projectRepo.save(transfer.doc);

    const reopened = await projectRepo.load(transfer.doc.id);
    if (!reopened) throw new Error("Saved fixture project could not be reopened from IndexedDB.");
    const audioClips = reopened.arrangement.audioClips ?? [];
    if (audioClips.length !== 8 || !audioClips.every((clip) => clip.startBar === 0 && (clip.offsetSec ?? 0) === 0)) {
      throw new Error("Reopened fixture lost one or more bar-1 audio clip origins.");
    }
    const midiClips = reopened.arrangement.midiClips ?? [];
    if (midiClips.length !== 4 || !midiClips.every((clip) => clip.startTick === 0)) {
      throw new Error("Reopened fixture lost one or more bar-1 MIDI arrangement lanes.");
    }
    const expectedMidiNames = Array.from({ length: 4 }, (_, index) => `Fixture MIDI ${index + 1}`);
    if (expectedMidiNames.some((name) => !reopened.tracks.some((track) => track.name === name))) {
      throw new Error("Reopened fixture lost one or more MIDI track names.");
    }
    if (audioFiles.some((file) => !reopened.tracks.some((track) => track.name === file.name.replace(/\.wav$/i, "")))) {
      throw new Error("Reopened fixture lost one or more audio track names.");
    }

    await restoreUserSampleAudioMemoized(restoredBank);
    if (restoredBank.size !== 8) throw new Error(`Expected 8 restored media assets, found ${restoredBank.size}.`);
    const restoredAudioAssets = restoredBank.size;
    // Imported MIDI lanes currently use KYX's default sampler patch. Restore
    // that factory asset too, just as a normal project boot does; otherwise
    // this harness would exercise note scheduling with a deliberately empty
    // sampler and mistake the missing test fixture for a product playback bug.
    const midiFactoryBank = await generateFactoryBank(["factory.tonal.pluck"]);
    for (const [id, buffer] of midiFactoryBank.entries()) restoredBank.add(id, buffer);

    await audioContextResume;
    if (audioContext.state !== "running") {
      throw new Error(`Live playback could not resume its AudioContext (state: ${audioContext.state}).`);
    }
    liveEngine = new AudioEngine();
    liveEngine.attachBank(restoredBank);
    liveEngine.useContext(audioContext);
    liveEngine.setProject(reopened);
    liveTransport = new Transport({ now: () => audioContext.currentTime }, reopened.bpm);
    let liveNoteOnsDispatched = 0;
    let liveAudioClipsDispatched = 0;
    liveScheduler = new Scheduler({
      getProject: () => reopened,
      getTransport: () => liveTransport!,
      getAudioTime: () => audioContext.currentTime,
      getContextState: () => audioContext.state,
      getMode: () => "song",
      trigger: (trackId, pad, when, velocity, locks, sampleId) =>
        liveEngine!.trigger(trackId, pad, when, velocity, locks, sampleId),
      noteOn: (trackId, pitch, velocity, when, durationSec) => {
        liveNoteOnsDispatched++;
        liveEngine!.noteOn(trackId, pitch, velocity, when, durationSec);
      },
      applyAutomation: (...args) => liveEngine!.applyAutomation(...args),
      applyPatternLaunch: () => undefined,
      triggerAudioClip: (clip, when, durationSec, resumeOffsetSec) => {
        liveAudioClipsDispatched++;
        liveEngine!.triggerAudioClip(clip, when, durationSec, resumeOffsetSec);
      },
    });
    liveTransport.play(0, { leadIn: false });
    const beatPhase = (((liveTransport.position % 480) + 480) % 480) / 480;
    liveEngine.transportStarted(audioContext.currentTime, beatPhase, liveTransport.position / 480);
    liveScheduler.start();
    const midiTrackIds = reopened.tracks
      .filter((track) => expectedMidiNames.includes(track.name))
      .map((track) => track.id);
    const midiTrackPeaks = new Map(midiTrackIds.map((id) => [id, 0]));
    let livePlaybackPeak = 0;
    const meterPollCount = 12;
    for (let poll = 0; poll < meterPollCount; poll++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const master = liveEngine.getMasterMeterSnapshot();
      livePlaybackPeak = Math.max(livePlaybackPeak, master.left.peak, master.right.peak);
      for (const trackId of midiTrackIds) {
        midiTrackPeaks.set(
          trackId,
          Math.max(midiTrackPeaks.get(trackId) ?? 0, liveEngine.getTrackMeterSnapshot(trackId).level),
        );
      }
    }
    const liveTransportPosition = liveTransport.position;
    if (midiTrackIds.length !== 4 || [...midiTrackPeaks.values()].some((peak) => peak < 0.0001)) {
      const detail = midiTrackIds
        .map(
          (id) =>
            `${reopened.tracks.find((track) => track.id === id)?.name}:${(midiTrackPeaks.get(id) ?? 0).toFixed(5)}`,
        )
        .join(", ");
      throw new Error(
        `Live fixture dispatched ${liveNoteOnsDispatched} note-ons and ${liveAudioClipsDispatched} audio clips at tick ${liveTransportPosition.toFixed(1)}, but MIDI track meters were silent or missing (${detail}).`,
      );
    }
    if (!Number.isFinite(livePlaybackPeak) || livePlaybackPeak < 0.0001 || livePlaybackPeak >= 0.9) {
      throw new Error(`Live playback meter is silent or lacks headroom (peak ${livePlaybackPeak.toFixed(4)}).`);
    }
    liveScheduler.stop();
    liveTransport.stop();

    const rendered = await renderProject(reopened, restoredBank, {
      mode: "song",
      sampleRate: 22_050,
      tailSeconds: 0,
      masterProcessing: false,
    });
    if (rendered.numberOfChannels !== 2 || rendered.length < 22_000) {
      throw new Error(
        `Offline render returned an unexpected buffer (${rendered.numberOfChannels}ch, ${rendered.length} frames).`,
      );
    }
    let renderedPeak = 0;
    let firstQuarterSecondPeak = 0;
    const quarterSecondFrames = Math.min(rendered.length, Math.floor(rendered.sampleRate / 4));
    for (let channel = 0; channel < rendered.numberOfChannels; channel++) {
      const samples = rendered.getChannelData(channel);
      for (let frame = 0; frame < samples.length; frame++) {
        const magnitude = Math.abs(samples[frame] ?? 0);
        if (!Number.isFinite(magnitude)) throw new Error("Offline render contains non-finite samples.");
        renderedPeak = Math.max(renderedPeak, magnitude);
        if (frame < quarterSecondFrames) firstQuarterSecondPeak = Math.max(firstQuarterSecondPeak, magnitude);
      }
    }
    if (firstQuarterSecondPeak < 0.0001)
      throw new Error("Offline render is silent during the aligned source-audio window.");
    if (renderedPeak >= 0.9) {
      throw new Error(`Fixture render has less than 0.9 linear peak headroom (${renderedPeak.toFixed(4)}).`);
    }

    return {
      fixtureVersion: DAW_TRANSFER_FIXTURE_VERSION,
      importedAudioTracks: audioClips.length,
      importedMidiTracks: midiClips.length,
      reopenedAudioStartsAtBar: audioClips.map((clip) => clip.startBar),
      restoredAudioAssets,
      renderedFrames: rendered.length,
      renderedPeak,
      firstQuarterSecondPeak,
      livePlaybackPeak,
      liveMidiTrackPeaks: Object.fromEntries(
        midiTrackIds.map((id) => [
          reopened.tracks.find((track) => track.id === id)?.name ?? id,
          midiTrackPeaks.get(id) ?? 0,
        ]),
      ),
      liveNoteOnsDispatched,
      liveAudioClipsDispatched,
      liveTransportPosition,
    };
  } finally {
    liveScheduler?.stop();
    liveTransport?.stop();
    liveEngine?.detachBank();
    if (savedProjectId) await projectRepo.delete(savedProjectId).catch(() => undefined);
    for (const id of importedIds) await sampleRepo.remove(id);
    await audioContext.close().catch(() => undefined);
  }
}
