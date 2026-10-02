import type { AudioEngine } from "../audio-engine/AudioEngine";
import { consolidateTimeRangeToAudio } from "../commands/commands";
import type { Command } from "../commands/types";
import { BAR_TICKS, type ProjectDocument } from "../project-model/types";
import type { IUserSampleRepository } from "../persistence/contracts";
import { userSampleId } from "../persistence/UserSampleRepository";
import type { SampleBank } from "../sample-library/factory";
import { encodeWav } from "../rendering/wav";
import { buildTimeRangeConsolidationDoc } from "../rendering/bounce";
import { buildTempoMap, renderProject, resolveRenderTailSeconds } from "../rendering/renderer";

export interface RangeConsolidationRuntime {
  store: {
    getDoc(): ProjectDocument;
    execute(command: Command): void;
  };
  engine: Pick<AudioEngine, "getLiveAudioContext">;
  bank: SampleBank;
  userSamples: IUserSampleRepository;
}

const storesInFlight = new WeakSet<object>();

/** Render the selected arrangement range, persist the print, then commit one undoable replacement. */
export async function consolidateRangeToAudio(
  runtime: RangeConsolidationRuntime,
  range: { fromTick: number; toTick: number },
  isSelectionCurrent: () => boolean = () => true,
  render: typeof renderProject = renderProject,
): Promise<Command> {
  const store = runtime.store;
  if (storesInFlight.has(store)) throw new Error("A range consolidation is already in progress.");
  storesInFlight.add(store);

  let bufferId: string | undefined;
  let saveAttempted = false;
  let bankAdded = false;
  let committed = false;
  try {
    if (!isSelectionCurrent()) throw new Error("The time selection changed. Review the range and try again.");
    const sourceDoc = store.getDoc();
    const fromBar = Math.min(range.fromTick, range.toTick) / BAR_TICKS;
    const toBar = Math.max(range.fromTick, range.toTick) / BAR_TICKS;
    const sourceDurationsByBufferId = new Map<string, number>();
    for (const clip of sourceDoc.arrangement.audioClips ?? []) {
      if (clip.startBar >= toBar || clip.startBar + clip.lengthBars <= fromBar) continue;
      const sourceBuffer = runtime.bank.get(clip.bufferId);
      if (!sourceBuffer) {
        throw new Error(`Load the source audio for clip ${clip.id} before consolidating this range.`);
      }
      sourceDurationsByBufferId.set(clip.bufferId, sourceBuffer.duration);
    }
    const plan = buildTimeRangeConsolidationDoc(sourceDoc, range.fromTick, range.toTick, sourceDurationsByBufferId);
    const sampleRate = runtime.engine.getLiveAudioContext()?.sampleRate ?? 44100;
    const durationTicks = plan.lengthBars * BAR_TICKS;
    const tailSeconds = resolveRenderTailSeconds(plan.project);
    const rangeStartTick = Math.min(range.fromTick, range.toTick);
    const rangeEndTick = Math.max(range.fromTick, range.toTick);
    const sourceTempoMap = buildTempoMap(
      sourceDoc,
      sourceDoc.arrangement.clips.flatMap((clip) => {
        const scene = sourceDoc.scenes.find((candidate) => candidate.id === clip.sceneId);
        return scene
          ? [
              {
                from: clip.startBar * BAR_TICKS,
                to: (clip.startBar + clip.lengthBars) * BAR_TICKS,
                bpm: scene.bpm ?? sourceDoc.bpm,
              },
            ]
          : [];
      }),
    );
    const printEndTick = sourceTempoMap.tickAt(sourceTempoMap.timeAt(rangeEndTick) + tailSeconds);
    const printLengthBars =
      Math.ceil(Math.max(plan.lengthBars, (printEndTick - rangeStartTick) / BAR_TICKS) * 100) / 100;
    const buffer = await render(plan.project, runtime.bank, {
      mode: "song",
      sampleRate,
      tailSeconds,
      masterProcessing: false,
      minimumDurationTicks: durationTicks,
      arrangementOnly: true,
    });

    if (store.getDoc() !== sourceDoc || !isSelectionCurrent()) {
      throw new Error("The project or time selection changed while rendering. Try consolidation again.");
    }
    assertUsablePrint(buffer);

    bufferId = userSampleId(`consolidated-range-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
    saveAttempted = true;
    await runtime.userSamples.save(
      {
        id: bufferId,
        name: `Consolidated bars ${fromBar + 1}–${toBar}`,
        fileName: `${bufferId}.wav`,
        category: "Custom",
        duration: buffer.duration,
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        createdAt: new Date().toISOString(),
      },
      encodeWav(buffer, 32),
    );
    runtime.bank.add(bufferId, buffer);
    bankAdded = true;

    if (store.getDoc() !== sourceDoc || !isSelectionCurrent()) {
      throw new Error("The project or time selection changed while saving. The rendered print was discarded.");
    }
    const command = consolidateTimeRangeToAudio(
      sourceDoc,
      range.fromTick,
      range.toTick,
      bufferId,
      sourceDurationsByBufferId,
      printLengthBars,
    );
    try {
      store.execute(command);
      committed = true;
    } catch (error) {
      committed = hasPrintClip(store.getDoc(), bufferId);
      if (!committed) throw error;
    }
    return command;
  } catch (error) {
    if (!committed && bufferId) {
      if (bankAdded) runtime.bank.remove(bufferId);
      if (saveAttempted) {
        try {
          await runtime.userSamples.remove(bufferId);
        } catch {
          // Best-effort cleanup after persistence or project validation failed.
        }
      }
    }
    throw error;
  } finally {
    storesInFlight.delete(store);
  }
}

function hasPrintClip(doc: ProjectDocument, bufferId: string): boolean {
  return doc.arrangement.audioClips?.some((clip) => clip.bufferId === bufferId) === true;
}

function assertUsablePrint(buffer: AudioBuffer): void {
  if (buffer.length <= 0 || buffer.numberOfChannels <= 0 || buffer.sampleRate <= 0) {
    throw new Error("The selected range rendered no audio frames.");
  }
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let frame = 0; frame < samples.length; frame++) {
      const value = samples[frame]!;
      if (!Number.isFinite(value))
        throw new Error("The selected range rendered invalid audio; source material was not changed.");
      peak = Math.max(peak, Math.abs(value));
    }
  }
  if (peak < 1e-9) throw new Error("The selected range rendered silence; source material was not changed.");
}
