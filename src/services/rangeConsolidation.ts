import type { AudioEngine } from "../audio-engine/AudioEngine";
import { consolidateTimeRangeToAudio } from "../commands/commands";
import type { Command } from "../commands/types";
import { type ProjectDocument } from "../project-model/types";
import { ticksPerBar } from "../project-model/schema";
import type { IUserSampleRepository } from "../persistence/contracts";
import { userSampleId } from "../persistence/UserSampleRepository";
import { SampleBank } from "../sample-library/factory";
import type { renderProject, RenderOptions } from "../rendering/renderer";
import { encodeWav } from "../rendering/wav";
import { buildBounceZoneDoc, buildTimeRangeConsolidationDoc } from "../rendering/bounce";

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
const consumedRangePreviews = new WeakSet<object>();

/** Runtime-only A/B material. None of these buffers or references enter project state. */
export interface PreparedRangeConsolidationPreview {
  readonly sourceDoc: ProjectDocument;
  readonly range: { fromTick: number; toTick: number };
  readonly sourceDurationsByBufferId: ReadonlyMap<string, number>;
  readonly candidatePrint: AudioBuffer;
  readonly before: AudioBuffer;
  readonly after: AudioBuffer;
  readonly beforeGain: number;
  readonly afterGain: number;
  readonly printLengthBars: number;
  readonly bankRevision: number;
  readonly fromBar: number;
  readonly toBar: number;
}

/** Render A (source mix), the pre-master print, and B (the print through the project master). */
export async function prepareRangeConsolidationPreview(
  runtime: RangeConsolidationRuntime,
  range: { fromTick: number; toTick: number },
  isSelectionCurrent: () => boolean = () => true,
  render?: typeof renderProject,
): Promise<PreparedRangeConsolidationPreview> {
  const store = runtime.store;
  if (storesInFlight.has(store)) throw new Error("A range consolidation is already in progress.");
  storesInFlight.add(store);
  try {
    const sourceDoc = store.getDoc();
    assertPreviewCurrent(store, sourceDoc, isSelectionCurrent);
    const barUnit = ticksPerBar(sourceDoc);
    const fromTick = Math.min(range.fromTick, range.toTick);
    const toTick = Math.max(range.fromTick, range.toTick);
    const fromBar = fromTick / barUnit;
    const toBar = toTick / barUnit;
    const initialDurations = sourceDurationsForRange(runtime.bank, sourceDoc, fromBar, toBar);
    const printPlan = buildTimeRangeConsolidationDoc(sourceDoc, fromTick, toTick, initialDurations);
    const sampleRate = runtime.engine.getLiveAudioContext()?.sampleRate ?? 44100;
    const durationTicks = printPlan.lengthBars * barUnit;
    const { buildTempoMap, resolveRenderTailSeconds, estimateRenderPcmBytes, MAX_OFFLINE_RENDER_PCM_BYTES } =
      await import("../rendering/renderer");
    const tailSeconds = resolveRenderTailSeconds(printPlan.project);
    const sourceTempoMap = buildTempoMap(
      sourceDoc,
      sourceDoc.arrangement.clips.flatMap((clip) => {
        const scene = sourceDoc.scenes.find((candidate) => candidate.id === clip.sceneId);
        return scene
          ? [
              {
                from: clip.startBar * barUnit,
                to: (clip.startBar + clip.lengthBars) * barUnit,
                bpm: scene.bpm ?? sourceDoc.bpm,
              },
            ]
          : [];
      }),
    );
    const printEndTick = sourceTempoMap.tickAt(sourceTempoMap.timeAt(toTick) + tailSeconds);
    const printLengthBars = Math.ceil(Math.max(printPlan.lengthBars, (printEndTick - fromTick) / barUnit) * 100) / 100;
    const auditionDurations = sourceDurationsForRange(runtime.bank, sourceDoc, fromBar, fromBar + printLengthBars);
    for (const [id, duration] of initialDurations) auditionDurations.set(id, duration);

    const previewId = `kyx-preview-range-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const renderFn = render ?? (await import("../rendering/renderer")).renderProject;
    const printOptions: RenderOptions = {
      mode: "song",
      sampleRate,
      tailSeconds,
      masterProcessing: false,
      minimumDurationTicks: durationTicks,
      arrangementOnly: true,
    };
    const auditionOptions: RenderOptions = {
      mode: "song",
      sampleRate,
      tailSeconds,
      minimumDurationTicks: Math.ceil(printLengthBars * barUnit),
      arrangementOnly: true,
    };
    const beforeDoc = buildBounceZoneDoc(
      sourceDoc,
      sourceDoc.tracks.map((track) => track.id),
      { startBar: fromBar, lengthBars: printLengthBars },
      {
        preserveMixState: true,
        includeSubQuarterAudioClips: true,
        includeSubQuarterArrangementClips: true,
        sourceDurationsByBufferId: auditionDurations,
      },
    );
    const temporaryCommand = consolidateTimeRangeToAudio(
      sourceDoc,
      fromTick,
      toTick,
      previewId,
      initialDurations,
      printLengthBars,
    );

    // A/B preview keeps three PCM buffers alive. Bound their combined memory,
    // not only each individual render, so a long selection cannot exhaust the tab.
    const printBytes = estimateRenderPcmBytes(printPlan.project, printOptions);
    const beforeBytes = estimateRenderPcmBytes(beforeDoc, auditionOptions);
    const afterBytes = estimateRenderPcmBytes(temporaryCommand.execute(sourceDoc), auditionOptions);
    if (printBytes + beforeBytes + afterBytes > MAX_OFFLINE_RENDER_PCM_BYTES) {
      throw new Error("This range is too long for an in-memory A/B preview. Select a shorter section and try again.");
    }

    const candidatePrint = await renderFn(printPlan.project, runtime.bank, printOptions);
    assertPreviewCurrent(store, sourceDoc, isSelectionCurrent);
    assertUsablePrint(candidatePrint);

    const before = await renderFn(beforeDoc, runtime.bank, auditionOptions);
    assertPreviewCurrent(store, sourceDoc, isSelectionCurrent);
    assertUsablePrint(before);

    // Keep the speculative print out of the live sample bank. The overlay is
    // a private in-memory bank snapshot used only by this offline B render.
    const previewBank = new SampleBank();
    for (const [id, buffer] of runtime.bank.entries()) previewBank.add(id, buffer);
    previewBank.add(previewId, candidatePrint);
    const afterDoc = buildBounceZoneDoc(
      temporaryCommand.execute(sourceDoc),
      sourceDoc.tracks.map((track) => track.id),
      { startBar: fromBar, lengthBars: printLengthBars },
      {
        preserveMixState: true,
        includeSubQuarterAudioClips: true,
        includeSubQuarterArrangementClips: true,
        sourceDurationsByBufferId: new Map([...auditionDurations, [previewId, candidatePrint.duration]]),
      },
    );
    const after = await renderFn(afterDoc, previewBank, auditionOptions);
    assertPreviewCurrent(store, sourceDoc, isSelectionCurrent);
    assertUsablePrint(after);
    const [beforeRms, afterRms] = [sampledRms(before), sampledRms(after)];
    const targetRms = Math.min(beforeRms, afterRms);

    return {
      sourceDoc,
      range: { fromTick: range.fromTick, toTick: range.toTick },
      sourceDurationsByBufferId: initialDurations,
      candidatePrint,
      before,
      after,
      beforeGain: beforeRms > 0 ? targetRms / beforeRms : 1,
      afterGain: afterRms > 0 ? targetRms / afterRms : 1,
      printLengthBars,
      bankRevision: runtime.bank.revision,
      fromBar,
      toBar,
    };
  } finally {
    storesInFlight.delete(store);
  }
}

/** Persist and commit a prepared B print as exactly one undoable project command. */
export async function commitRangeConsolidationPreview(
  runtime: RangeConsolidationRuntime,
  preview: PreparedRangeConsolidationPreview,
  isSelectionCurrent: () => boolean = () => true,
): Promise<Command> {
  const store = runtime.store;
  if (storesInFlight.has(store)) throw new Error("A range consolidation is already in progress.");
  if (consumedRangePreviews.has(preview))
    throw new Error("This A/B preview has already been used. Render a fresh preview.");
  storesInFlight.add(store);
  let bufferId: string | undefined;
  let saveAttempted = false;
  let bankAdded = false;
  let committed = false;
  try {
    assertPreviewCurrent(store, preview.sourceDoc, isSelectionCurrent);
    if (runtime.bank.revision !== preview.bankRevision) {
      throw new Error("The sample library changed after the A/B preview. Render it again before applying.");
    }
    assertUsablePrint(preview.candidatePrint);
    bufferId = userSampleId(`consolidated-range-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
    saveAttempted = true;
    await runtime.userSamples.save(
      {
        id: bufferId,
        name: `Consolidated bars ${preview.fromBar + 1}–${preview.toBar}`,
        fileName: `${bufferId}.wav`,
        category: "Custom",
        duration: preview.candidatePrint.duration,
        sampleRate: preview.candidatePrint.sampleRate,
        channels: preview.candidatePrint.numberOfChannels,
        createdAt: new Date().toISOString(),
      },
      encodeWav(preview.candidatePrint, 32),
    );
    runtime.bank.add(bufferId, preview.candidatePrint);
    bankAdded = true;
    assertPreviewCurrent(store, preview.sourceDoc, isSelectionCurrent);
    if (runtime.bank.revision !== preview.bankRevision + 1) {
      throw new Error("The sample library changed while saving the print. The rendered result was discarded.");
    }
    const command = consolidateTimeRangeToAudio(
      preview.sourceDoc,
      preview.range.fromTick,
      preview.range.toTick,
      bufferId,
      preview.sourceDurationsByBufferId,
      preview.printLengthBars,
    );
    try {
      store.execute(command);
      committed = true;
    } catch (error) {
      committed = hasPrintClip(store.getDoc(), bufferId);
      if (!committed) throw error;
    }
    consumedRangePreviews.add(preview);
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

/** Render the selected arrangement range, persist the print, then commit one undoable replacement. */
export async function consolidateRangeToAudio(
  runtime: RangeConsolidationRuntime,
  range: { fromTick: number; toTick: number },
  isSelectionCurrent: () => boolean = () => true,
  render?: typeof renderProject,
): Promise<Command> {
  const store = runtime.store;
  if (storesInFlight.has(store)) throw new Error("A range consolidation is already in progress.");
  storesInFlight.add(store);

  // Renderer loads on demand (the boot graph must not carry it — it drags
  // the worklet loaders); tests may inject a render function directly.
  const renderFn = render ?? (await import("../rendering/renderer")).renderProject;
  let bufferId: string | undefined;
  let saveAttempted = false;
  let bankAdded = false;
  let committed = false;
  try {
    if (!isSelectionCurrent()) throw new Error("The time selection changed. Review the range and try again.");
    const sourceDoc = store.getDoc();
    // The document's bar length in ticks (ADR 0056) — the range is measured in
    // the project's own meter, not a fixed 4/4 bar.
    const barUnit = ticksPerBar(sourceDoc);
    const fromBar = Math.min(range.fromTick, range.toTick) / barUnit;
    const toBar = Math.max(range.fromTick, range.toTick) / barUnit;
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
    const durationTicks = plan.lengthBars * barUnit;
    const { buildTempoMap, resolveRenderTailSeconds } = await import("../rendering/renderer");
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
                from: clip.startBar * barUnit,
                to: (clip.startBar + clip.lengthBars) * barUnit,
                bpm: scene.bpm ?? sourceDoc.bpm,
              },
            ]
          : [];
      }),
    );
    const printEndTick = sourceTempoMap.tickAt(sourceTempoMap.timeAt(rangeEndTick) + tailSeconds);
    const printLengthBars = Math.ceil(Math.max(plan.lengthBars, (printEndTick - rangeStartTick) / barUnit) * 100) / 100;
    const buffer = await renderFn(plan.project, runtime.bank, {
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

function assertPreviewCurrent(
  store: RangeConsolidationRuntime["store"],
  sourceDoc: ProjectDocument,
  isSelectionCurrent: () => boolean,
): void {
  if (store.getDoc() !== sourceDoc || !isSelectionCurrent()) {
    throw new Error("The project or time selection changed during the A/B preview. Nothing was applied.");
  }
}

function sourceDurationsForRange(
  bank: SampleBank,
  doc: ProjectDocument,
  fromBar: number,
  toBar: number,
): Map<string, number> {
  const durations = new Map<string, number>();
  for (const clip of doc.arrangement.audioClips ?? []) {
    if (clip.startBar >= toBar || clip.startBar + clip.lengthBars <= fromBar) continue;
    const buffer = bank.get(clip.bufferId);
    if (!buffer) throw new Error(`Load the source audio for clip ${clip.id} before previewing this range.`);
    durations.set(clip.bufferId, buffer.duration);
  }
  return durations;
}

/** Bounded, stratified RMS sample for a fast preview-only loudness match. */
function sampledRms(buffer: AudioBuffer): number {
  const targetFrames = 8192;
  const stride = Math.max(1, Math.floor(buffer.length / targetFrames));
  let power = 0;
  let count = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let frame = 0; frame < samples.length; frame += stride) {
      const sample = samples[frame] ?? 0;
      if (!Number.isFinite(sample)) continue;
      power += sample * sample;
      count++;
    }
  }
  return count > 0 ? Math.sqrt(power / count) : 0;
}
