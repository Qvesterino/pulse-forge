import { createProjectFromTemplate } from "../project-model/templates";
import type { MasterConfig, ProjectDocument } from "../project-model/types";
import { BAR_TICKS, PPQ } from "../project-model/types";
import { uid } from "../shared/ids";
import { SampleBank } from "../sample-library/factory";
import type { SampleBank as SampleBankType } from "../sample-library/factory";
import { estimateRenderPcmBytes, renderProject } from "../rendering/renderer";
import type { ExportQuality } from "../rendering/renderer";

export const MAX_MASTERING_SESSION_SECONDS = 12 * 60;
export const MAX_MASTERING_SESSION_WORKING_SET_BYTES = 512 * 1024 * 1024;

export interface MasteringSessionRenderOptions {
  sampleRate: 44_100 | 48_000;
  quality?: ExportQuality;
  signal?: AbortSignal;
}

/**
 * Build a throwaway document that routes only one external stereo source
 * through KYX's normal project master chain. An internal tempo makes the
 * audio clip end at the source duration without exposing musical bars in the
 * file-mastering workflow.
 */
export function createMasteringSessionRenderDocument(
  sourceDurationSeconds: number,
  master: MasterConfig,
  sourceBufferId: string,
): ProjectDocument {
  if (
    !Number.isFinite(sourceDurationSeconds) ||
    sourceDurationSeconds < 0.8 ||
    sourceDurationSeconds > MAX_MASTERING_SESSION_SECONDS
  ) {
    throw new Error("Mastering source duration must be between 0.8 seconds and 12 minutes.");
  }
  if (!sourceBufferId || sourceBufferId.length > 200) throw new Error("Mastering source buffer id is invalid.");

  const barCount = Math.max(1, Math.round(sourceDurationSeconds / 2));
  const bpm = (barCount * 240) / sourceDurationSeconds;
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) {
    throw new Error("Could not create an exact source timeline for this mastering session.");
  }

  const doc = createProjectFromTemplate("empty");
  const sourceTrack = doc.tracks[0];
  if (!sourceTrack || sourceTrack.kind !== "drum")
    throw new Error("Could not create the mastering render source track.");

  doc.name = "External Mastering Session";
  doc.bpm = bpm;
  doc.tracks = [
    { ...sourceTrack, name: "Source Mix", gain: 1, pan: 0, mute: false, solo: false, effects: [], sends: {} },
  ];
  doc.returns = [];
  doc.arrangement = {
    clips: [],
    audioClips: [
      {
        id: uid("mastering-source-clip"),
        trackId: sourceTrack.id,
        bufferId: sourceBufferId,
        startBar: 0,
        lengthBars: barCount,
        offsetSec: 0,
        trimStart: 0,
        trimEnd: 1,
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        stretchRate: 1,
        reverse: false,
      },
    ],
  };
  doc.automation = [];
  doc.sceneAutomation = [];
  doc.lfos = [];
  doc.master = JSON.parse(JSON.stringify(master)) as MasterConfig;
  return doc;
}

/**
 * Conservative peak working-set estimate: decoded source PCM, rendered PCM,
 * and a worst-case 32-bit-float WAV encoding resident at the same time.
 */
export function estimateMasteringSessionWorkingSetBytes(
  source: Pick<AudioBuffer, "duration" | "length" | "numberOfChannels" | "sampleRate">,
  master: MasterConfig,
  sampleRate: MasteringSessionRenderOptions["sampleRate"],
): number {
  if (
    !Number.isFinite(source.duration) ||
    source.duration < 0.8 ||
    source.duration > MAX_MASTERING_SESSION_SECONDS ||
    !Number.isSafeInteger(source.length) ||
    source.length <= 0 ||
    (source.numberOfChannels !== 1 && source.numberOfChannels !== 2) ||
    !Number.isFinite(source.sampleRate) ||
    source.sampleRate <= 0
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const doc = createMasteringSessionRenderDocument(source.duration, master, "mastering-session-estimate");
  const renderBytes = estimateRenderPcmBytes(doc, { mode: "song", sampleRate });
  const sourceBytes = source.length * source.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
  return sourceBytes + renderBytes * 2;
}

/** Peak estimate while A is retained for audition as B renders. */
export function estimateMasteringSessionComparisonBytes(
  source: Pick<AudioBuffer, "duration" | "length" | "numberOfChannels" | "sampleRate">,
  masterA: MasterConfig,
  masterB: MasterConfig,
  sampleRate: MasteringSessionRenderOptions["sampleRate"],
): number {
  const sourceBytes = source.length * source.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
  const workingA = estimateMasteringSessionWorkingSetBytes(source, masterA, sampleRate);
  const workingB = estimateMasteringSessionWorkingSetBytes(source, masterB, sampleRate);
  if (!Number.isFinite(sourceBytes) || !Number.isFinite(workingA) || !Number.isFinite(workingB)) {
    return Number.POSITIVE_INFINITY;
  }
  const outputABytes = Math.max(0, (workingA - sourceBytes) / 2);
  const outputBBytes = Math.max(0, (workingB - sourceBytes) / 2);
  return Math.max(workingA + outputBBytes, workingB + outputABytes);
}

export function assertMasteringSessionWorkingSetBudget(estimatedBytes: number): void {
  if (!Number.isFinite(estimatedBytes) || estimatedBytes <= 0) {
    throw new Error("KYX could not estimate the memory needed for this file-mastering render.");
  }
  if (estimatedBytes > MAX_MASTERING_SESSION_WORKING_SET_BYTES) {
    const estimateMiB = Math.ceil(estimatedBytes / (1024 * 1024));
    const limitMiB = Math.floor(MAX_MASTERING_SESSION_WORKING_SET_BYTES / (1024 * 1024));
    throw new Error(
      `This file-mastering operation needs about ${estimateMiB} MiB across source, render, and output buffers, above KYX's ${limitMiB} MiB session limit. Use a shorter source or lower the render rate.`,
    );
  }
}

/** Render a decoded mono/stereo source through an isolated copy of a sample bank. */
export async function renderMasteringSessionSource(
  source: AudioBuffer,
  master: MasterConfig,
  bank: SampleBankType,
  options: MasteringSessionRenderOptions,
): Promise<AudioBuffer> {
  const workingSetBytes = estimateMasteringSessionWorkingSetBytes(source, master, options.sampleRate);
  assertMasteringSessionWorkingSetBudget(workingSetBytes);
  const sourceBufferId = uid("mastering-session-source");
  const doc = createMasteringSessionRenderDocument(source.duration, master, sourceBufferId);
  const renderBank = new SampleBank();
  for (const [id, buffer] of bank.entries()) renderBank.add(id, buffer);
  renderBank.add(sourceBufferId, source);

  try {
    const rendered = await renderProject(doc, renderBank, {
      mode: "song",
      sampleRate: options.sampleRate,
      quality: options.quality ?? "studio",
      signal: options.signal,
    });
    if (options.signal?.aborted) throw new DOMException("File mastering render cancelled", "AbortError");
    return rendered;
  } finally {
    renderBank.remove(sourceBufferId);
  }
}

/** Seconds represented by the scratch source clip, for alignment assertions. */
export function masteringSessionTimelineSeconds(doc: ProjectDocument): number {
  const clip = doc.arrangement.audioClips?.[0];
  return clip ? clip.lengthBars * BAR_TICKS * (60 / (doc.bpm * PPQ)) : 0;
}
