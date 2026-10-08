import type { DrumPad, InstrumentTrack, ProjectDocument } from "../project-model/types";
import { PPQ } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import type { InstrumentRuntime } from "../instruments/types";
import type { InstrumentPreset } from "../presets/types";
import { clampInstrumentParam, INSTRUMENT_DEFS } from "../instruments/registry";
import { dbToLinear, presetNormalizationGainDb } from "../presets/normalization";
import { previewCleanupDelayMs, previewNoteDuration } from "../presets/audioQuality";
import { DECLICK_TAIL_SEC, declickFadeOut, resolveSlicePlayback } from "./declick";

/**
 * PreviewDeck — Wave 4c of the AudioEngine decomposition
 * (docs/AUDIOENGINE-DECOMPOSITION-PLAN.md).
 *
 * Owns the AUDITION deck: short, isolated listens that bypass the project's
 * scheduling — pad previews, preset auditions (temporary instrument
 * runtimes), slice/buffer/asset playback and transport-synced browser
 * previews. Two voice sets live here: sample voices (BufferSource + gain,
 * self-removing on `onended`) and instrument-preview voices (temporary
 * runtimes with a cleanup timer).
 *
 * Scope note (honest cut): the graph-param previews (previewTrackGain /
 * previewFxParam / the effect-intent audition session) STAY in the engine —
 * they are one-line writes into engine-owned node maps and FX runtimes, not
 * voice lifecycle. Marker cue previews stay with the marker trigger path
 * (they share the engine's oneShotSources set).
 *
 * Facade law: this module never imports AudioEngine. Everything it needs
 * arrives as getter closures in the deps, so the engine's module graph
 * stays acyclic toward its collaborators.
 *
 * Everything below is a VERBATIM move from AudioEngine.ts — same bodies,
 * same de-click constants, same headroom gains.
 */

interface PreviewVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  masterCompare?: boolean;
  comparePairId?: number;
}

export type MasterCompareSide = "project" | "reference";

interface ComparePairRamp {
  startAt: number;
  endAt: number;
  fromProject: number;
  fromReference: number;
  toProject: number;
  toReference: number;
}

interface MasterComparePair {
  id: number;
  project: PreviewVoice;
  reference: PreviewVoice;
  selectedSide: MasterCompareSide;
  projectGain: number;
  referenceGain: number;
  mono: boolean;
  ramp: ComparePairRamp;
  endedCount: number;
  onEnded?: () => void;
}

const MASTER_COMPARE_CROSSFADE_SEC = 0.02;
const MASTER_COMPARE_START_DELAY_SEC = 0.01;

function clampPreviewGain(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function rampValue(from: number, to: number, startAt: number, endAt: number, time: number): number {
  if (time <= startAt) return from;
  if (time >= endAt || endAt <= startAt) return to;
  return from + ((to - from) * (time - startAt)) / (endAt - startAt);
}

interface InstrumentPreviewVoice {
  runtime: InstrumentRuntime;
  gain: GainNode;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface PreviewDeckDeps {
  ctx: () => BaseAudioContext | null;
  doc: () => ProjectDocument | null;
  bank: () => SampleBank | null;
  masterInput: () => GainNode | null;
  /** The engine's context unlock (resumes the live context, builds master). */
  ensureContext: () => unknown;
  currentTime: () => number;
  /** Absolute transport tick now (bar-quantized synced previews). */
  transportTickNow: () => number;
  trigger(trackId: string, pad: DrumPad, when: number, velocity: number): void;
  noteOn(trackId: string, pitch: number, velocity: number, when: number, durationSec: number): void;
  /** Report a sample that failed to resolve (engine's missedAssets set). */
  missAsset: (assetId: string) => void;
}

export class PreviewDeck {
  private previewVoices = new Set<PreviewVoice>();
  private instrumentPreviewVoices = new Set<InstrumentPreviewVoice>();
  private masterComparePair: MasterComparePair | null = null;
  private nextMasterComparePairId = 1;

  constructor(private readonly deps: PreviewDeckDeps) {}

  /** Test/inspection hook: active voice counts. */
  voiceCounts(): { samples: number; instruments: number } {
    return { samples: this.previewVoices.size, instruments: this.instrumentPreviewVoices.size };
  }

  preview(pad: DrumPad, trackId: string, velocity = 1): void {
    this.deps.ensureContext();
    this.deps.trigger(trackId, pad, this.deps.currentTime() + 0.005, velocity);
  }

  previewNote(trackId: string, pitch: number): void {
    this.deps.ensureContext();
    this.deps.noteOn(trackId, pitch, 1, this.deps.currentTime() + 0.005, 0.25);
  }

  /**
   * Audition an instrument preset without touching the project document.
   *
   * PresetBrowser uses this path for a short, isolated note. The temporary
   * runtime is connected directly to the master preview bus so a muted or
   * silent track cannot make a valid preset audition look broken. Applying
   * the preset remains a separate command-owned operation in the UI.
   */
  previewInstrumentPreset(trackId: string, preset: InstrumentPreset): void {
    this.deps.ensureContext();
    this.stopPreview();
    const ctx = this.deps.ctx();
    const doc = this.deps.doc();
    const master = this.deps.masterInput();
    const track = doc?.tracks.find((candidate): candidate is InstrumentTrack => {
      return candidate.kind === "instrument" && candidate.id === trackId;
    });
    if (!ctx || !master || !track || preset.instrument !== track.instrument) return;

    const definition = INSTRUMENT_DEFS[track.instrument];
    if (!definition) return;
    const params = { ...track.params };
    for (const [id, value] of Object.entries(preset.params)) {
      params[id] = clampInstrumentParam(track.instrument, id, value);
    }
    const previewTrack: InstrumentTrack = {
      ...track,
      params,
      sampleId: preset.sampleId !== undefined ? preset.sampleId : track.sampleId,
      presetId: preset.id,
    };

    let runtime: InstrumentRuntime;
    try {
      runtime = definition.factory(ctx, previewTrack, {
        bpm: doc?.bpm ?? 124,
        getSample: (id) => this.deps.bank()?.get(id),
      });
    } catch {
      return;
    }

    // The audition must represent the applied sound: the same preset
    // normalization the live chain gets scales the fixed headroom gain.
    const normGain = ctx.createGain();
    normGain.gain.value = dbToLinear(presetNormalizationGainDb(preset.id));
    runtime.output.connect(normGain);

    const gain = ctx.createGain();
    const when = ctx.currentTime + 0.01;
    const durationSec = previewNoteDuration(params);
    // Keep audition headroom independent from the track's current mixer gain.
    gain.gain.setValueAtTime(0.78, when);
    normGain.connect(gain).connect(master);
    const voice: InstrumentPreviewVoice = { runtime, gain, timer: null };
    this.instrumentPreviewVoices.add(voice);

    try {
      runtime.noteOn(60, 0.82, when, durationSec);
    } catch {
      this.disposeInstrumentPreviewVoice(voice);
      return;
    }

    // Give envelopes a short tail before disposing the temporary runtime.
    voice.timer = setTimeout(
      () => this.disposeInstrumentPreviewVoice(voice),
      previewCleanupDelayMs(params, durationSec),
    );
  }

  private disposeInstrumentPreviewVoice(voice: InstrumentPreviewVoice): void {
    if (voice.timer) clearTimeout(voice.timer);
    voice.timer = null;
    try {
      voice.runtime.panic();
    } catch {
      /* already stopped */
    }
    try {
      voice.runtime.dispose();
    } catch {
      /* already disposed */
    }
    try {
      voice.gain.disconnect();
    } catch {
      /* already disconnected */
    }
    this.instrumentPreviewVoices.delete(voice);
  }

  /** Preview a source region directly through the master bus. */
  previewSlice(pad: DrumPad, loop = false): void {
    this.deps.ensureContext();
    this.stopPreview();
    const ctx = this.deps.ctx();
    const buffer = this.deps.bank()?.get(pad.assetId);
    if (!ctx || !this.deps.masterInput() || !buffer) {
      if (pad.assetId) this.deps.missAsset(pad.assetId);
      return;
    }
    const slice = resolveSlicePlayback(pad, buffer.duration);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = slice.rate;
    if (loop) {
      source.loop = true;
      source.loopStart = slice.start;
      source.loopEnd = slice.end;
    }
    const gain = ctx.createGain();
    const peak = Math.max(0, pad.gain);
    const when = ctx.currentTime + 0.005;
    const endWhen = when + slice.duration;
    // Same de-click guarantee as the trigger path: auditioning a slice must
    // not click either, including when a p-locked length cut it short.
    const fadeOut = declickFadeOut(slice.fadeOut, slice.duration);
    gain.gain.setValueAtTime(slice.fadeIn > 0 ? 0 : peak, when);
    if (slice.fadeIn > 0) gain.gain.linearRampToValueAtTime(peak, when + slice.fadeIn);
    if (!loop && fadeOut > 0) {
      const fadeOutAt = Math.max(when + slice.fadeIn, endWhen - fadeOut);
      gain.gain.setValueAtTime(peak, fadeOutAt);
      gain.gain.linearRampToValueAtTime(0, fadeOutAt + fadeOut);
    }
    source.connect(gain).connect(this.deps.masterInput()!);
    const voice: PreviewVoice = { source, gain };
    this.previewVoices.add(voice);
    source.onended = () => {
      this.previewVoices.delete(voice);
      gain.disconnect();
      source.disconnect();
    };
    source.start(when, slice.offset, loop ? undefined : slice.duration);
  }

  stopPreview(): void {
    const ctx = this.deps.ctx();
    const comparePair = this.masterComparePair;
    this.masterComparePair = null;
    comparePair?.onEnded?.();
    for (const voice of [...this.instrumentPreviewVoices]) this.disposeInstrumentPreviewVoice(voice);
    for (const voice of this.previewVoices) {
      try {
        // De-click the stop: a 5 ms gap between "cut" and "silent" is long
        // enough to read as a click on a sustained preview slice.
        const stopAt = ctx ? ctx.currentTime + 0.005 : 0;
        voice.gain.gain.cancelScheduledValues(stopAt);
        voice.gain.gain.setTargetAtTime(0, stopAt, DECLICK_TAIL_SEC);
        voice.source.stop(stopAt + DECLICK_TAIL_SEC * 4);
      } catch {
        // Already stopped.
      }
      try {
        voice.gain.disconnect();
      } catch {
        /* already disconnected */
      }
      try {
        voice.source.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.previewVoices.clear();
  }

  /** Hard dispose for context swaps / panic — no de-click tail, no timers left. */
  disposeAll(): void {
    const comparePair = this.masterComparePair;
    this.masterComparePair = null;
    comparePair?.onEnded?.();
    for (const voice of [...this.instrumentPreviewVoices]) this.disposeInstrumentPreviewVoice(voice);
    this.instrumentPreviewVoices.clear();
    for (const voice of this.previewVoices) {
      try {
        voice.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        voice.gain.disconnect();
      } catch {
        /* already */
      }
    }
    this.previewVoices.clear();
  }

  /** Preview a factory sample directly through the master bus (no track needed). */
  previewAsset(assetId: string): void {
    this.deps.ensureContext();
    const ctx = this.deps.ctx();
    const buffer = this.deps.bank()?.get(assetId);
    if (!ctx || !this.deps.masterInput()) return;
    if (!buffer) {
      if (assetId) this.deps.missAsset(assetId);
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.9;
    source.connect(gain).connect(this.deps.masterInput()!);
    const voice: PreviewVoice = { source, gain };
    this.previewVoices.add(voice);
    source.start(ctx.currentTime + 0.005);
    source.onended = () => {
      this.previewVoices.delete(voice);
      gain.disconnect();
      source.disconnect();
    };
  }

  /** Update gain/mono audition controls for the active direct master-comparison voice. */
  updateMasterComparePreview(gainValue: number, mono: boolean): void {
    const ctx = this.deps.ctx();
    if (!ctx) return;
    const target = clampPreviewGain(gainValue);
    for (const voice of this.previewVoices) {
      if (!voice.masterCompare || voice.comparePairId !== undefined) continue;
      voice.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.015);
      this.setCompareMono(voice.gain, mono);
    }
  }

  /**
   * Start two rendered masters against the same audition clock. Their source
   * offsets may differ, but switching sides keeps the elapsed comparison time
   * aligned and fades between direct-monitor gains without re-rendering.
   */
  previewMasterComparePair(
    projectBuffer: AudioBuffer,
    referenceBuffer: AudioBuffer,
    projectGain: number,
    referenceGain: number,
    selectedSide: MasterCompareSide,
    projectOffsetSec = 0,
    referenceOffsetSec = 0,
    mono = false,
    onEnded?: () => void,
  ): boolean {
    this.deps.ensureContext();
    const ctx = this.deps.ctx();
    if (!ctx || projectBuffer.duration <= 0 || referenceBuffer.duration <= 0) return false;

    const projectOffset = Math.max(0, Math.min(projectBuffer.duration, projectOffsetSec));
    const referenceOffset = Math.max(0, Math.min(referenceBuffer.duration, referenceOffsetSec));
    const commonDuration = Math.min(projectBuffer.duration - projectOffset, referenceBuffer.duration - referenceOffset);
    if (!Number.isFinite(commonDuration) || commonDuration < 0.01) return false;

    this.stopPreview();
    const pairId = this.nextMasterComparePairId++;
    const projectSource = ctx.createBufferSource();
    const referenceSource = ctx.createBufferSource();
    const projectGainNode = ctx.createGain();
    const referenceGainNode = ctx.createGain();
    projectSource.buffer = projectBuffer;
    referenceSource.buffer = referenceBuffer;
    projectSource.connect(projectGainNode).connect(ctx.destination);
    referenceSource.connect(referenceGainNode).connect(ctx.destination);
    this.setCompareMono(projectGainNode, mono);
    this.setCompareMono(referenceGainNode, mono);

    const targetProject = selectedSide === "project" ? clampPreviewGain(projectGain) : 0;
    const targetReference = selectedSide === "reference" ? clampPreviewGain(referenceGain) : 0;
    const startsAt = ctx.currentTime + MASTER_COMPARE_START_DELAY_SEC;
    const ramp: ComparePairRamp = {
      startAt: startsAt,
      endAt: startsAt + MASTER_COMPARE_CROSSFADE_SEC,
      fromProject: 0,
      fromReference: 0,
      toProject: targetProject,
      toReference: targetReference,
    };
    projectGainNode.gain.setValueAtTime(0, startsAt);
    referenceGainNode.gain.setValueAtTime(0, startsAt);
    projectGainNode.gain.linearRampToValueAtTime(targetProject, ramp.endAt);
    referenceGainNode.gain.linearRampToValueAtTime(targetReference, ramp.endAt);

    const project: PreviewVoice = {
      source: projectSource,
      gain: projectGainNode,
      masterCompare: true,
      comparePairId: pairId,
    };
    const reference: PreviewVoice = {
      source: referenceSource,
      gain: referenceGainNode,
      masterCompare: true,
      comparePairId: pairId,
    };
    const pair: MasterComparePair = {
      id: pairId,
      project,
      reference,
      selectedSide,
      projectGain: clampPreviewGain(projectGain),
      referenceGain: clampPreviewGain(referenceGain),
      mono,
      ramp,
      endedCount: 0,
      onEnded,
    };
    this.masterComparePair = pair;
    this.previewVoices.add(project);
    this.previewVoices.add(reference);
    projectSource.onended = () => this.finishMasterCompareVoice(project);
    referenceSource.onended = () => this.finishMasterCompareVoice(reference);
    try {
      projectSource.start(startsAt, projectOffset, commonDuration);
      referenceSource.start(startsAt, referenceOffset, commonDuration);
    } catch {
      this.stopPreview();
      return false;
    }
    return true;
  }

  selectMasterComparePairSide(side: MasterCompareSide): void {
    const pair = this.masterComparePair;
    const ctx = this.deps.ctx();
    if (!pair || !ctx || pair.selectedSide === side) return;
    pair.selectedSide = side;
    this.scheduleMasterComparePairLevels(pair, side, ctx.currentTime + MASTER_COMPARE_START_DELAY_SEC);
  }

  updateMasterComparePair(projectGain: number, referenceGain: number, side: MasterCompareSide, mono: boolean): void {
    const pair = this.masterComparePair;
    const ctx = this.deps.ctx();
    if (!pair || !ctx) return;
    const nextProjectGain = clampPreviewGain(projectGain);
    const nextReferenceGain = clampPreviewGain(referenceGain);
    const levelsChanged =
      pair.projectGain !== nextProjectGain || pair.referenceGain !== nextReferenceGain || pair.selectedSide !== side;
    if (pair.mono !== mono) {
      pair.mono = mono;
      this.setCompareMono(pair.project.gain, mono);
      this.setCompareMono(pair.reference.gain, mono);
    }
    if (!levelsChanged) return;
    pair.projectGain = nextProjectGain;
    pair.referenceGain = nextReferenceGain;
    this.scheduleMasterComparePairLevels(pair, side, ctx.currentTime + MASTER_COMPARE_START_DELAY_SEC);
  }

  private setCompareMono(gain: GainNode, mono: boolean): void {
    gain.channelCount = mono ? 1 : 2;
    gain.channelCountMode = mono ? "explicit" : "max";
    gain.channelInterpretation = "speakers";
  }

  private scheduleMasterComparePairLevels(pair: MasterComparePair, side: MasterCompareSide, startsAt: number): void {
    const fromProject = rampValue(
      pair.ramp.fromProject,
      pair.ramp.toProject,
      pair.ramp.startAt,
      pair.ramp.endAt,
      startsAt,
    );
    const fromReference = rampValue(
      pair.ramp.fromReference,
      pair.ramp.toReference,
      pair.ramp.startAt,
      pair.ramp.endAt,
      startsAt,
    );
    const toProject = side === "project" ? pair.projectGain : 0;
    const toReference = side === "reference" ? pair.referenceGain : 0;
    const endsAt = startsAt + MASTER_COMPARE_CROSSFADE_SEC;
    for (const [param, from, to] of [
      [pair.project.gain.gain, fromProject, toProject],
      [pair.reference.gain.gain, fromReference, toReference],
    ] as const) {
      param.cancelScheduledValues(startsAt);
      param.setValueAtTime(from, startsAt);
      param.linearRampToValueAtTime(to, endsAt);
    }
    pair.selectedSide = side;
    pair.ramp = { startAt: startsAt, endAt: endsAt, fromProject, fromReference, toProject, toReference };
  }

  private finishMasterCompareVoice(voice: PreviewVoice): void {
    this.previewVoices.delete(voice);
    voice.gain.disconnect();
    voice.source.disconnect();
    const pair = this.masterComparePair;
    if (!pair || pair.id !== voice.comparePairId) return;
    pair.endedCount++;
    if (pair.endedCount < 2) return;
    this.masterComparePair = null;
    pair.onEnded?.();
  }

  previewBuffer(buffer: AudioBuffer, gainValue = 0.9, onEnded?: () => void, offsetSec = 0): void {
    this.deps.ensureContext();
    const ctx = this.deps.ctx();
    if (!ctx || !this.deps.masterInput()) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, gainValue));
    source.connect(gain).connect(this.deps.masterInput()!);
    const voice: PreviewVoice = { source, gain };
    this.previewVoices.add(voice);
    source.start(ctx.currentTime + 0.005, Math.max(0, Math.min(buffer.duration, offsetSec)));
    source.onended = () => {
      this.previewVoices.delete(voice);
      gain.disconnect();
      source.disconnect();
      onEnded?.();
    };
  }

  /** Play a rendered master comparison directly to the monitor, avoiding a second master pass. */
  previewMasterCompare(buffer: AudioBuffer, gainValue = 0.9, onEnded?: () => void, offsetSec = 0, mono = false): void {
    this.deps.ensureContext();
    const ctx = this.deps.ctx();
    if (!ctx) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, gainValue));
    if (mono) {
      gain.channelCount = 1;
      gain.channelCountMode = "explicit";
      gain.channelInterpretation = "speakers";
    }
    source.connect(gain).connect(ctx.destination);
    const voice: PreviewVoice = { source, gain, masterCompare: true };
    this.previewVoices.add(voice);
    source.start(ctx.currentTime + 0.005, Math.max(0, Math.min(buffer.duration, offsetSec)));
    source.onended = () => {
      this.previewVoices.delete(voice);
      gain.disconnect();
      source.disconnect();
      onEnded?.();
    };
  }

  /**
   * Preview a sample synced to the transport (FL Browser Alt+P): the sample's
   * first beat lands on the next bar boundary and playbackRate tempo-matches
   * the project. `rate` is caller-computed (fileBPM/doc.bpm) — 1 = dry.
   */
  previewAssetSynced(assetId: string, rate = 1): void {
    this.deps.ensureContext();
    const ctx = this.deps.ctx();
    const buffer = this.deps.bank()?.get(assetId);
    const doc = this.deps.doc();
    if (!ctx || !this.deps.masterInput() || !buffer || !doc) return;
    const bpm = Math.max(1, doc.bpm);
    const barSec = (60 / bpm) * 4;
    const now = ctx.currentTime;
    // Quantized start: next bar boundary relative to transport playhead
    const pos = this.deps.transportTickNow();
    const secondsPerTick = 60 / (bpm * PPQ);
    const nextBarSec = ((Math.floor(pos / PPQ) + 1) * PPQ - pos) * secondsPerTick;
    const when = now + Math.max(0.005, (nextBarSec % Math.max(0.001, barSec)) + 0.005);
    void barSec;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = Math.min(4, Math.max(0.25, rate));
    const gain = ctx.createGain();
    gain.gain.value = 0.85;
    source.connect(gain).connect(this.deps.masterInput()!);
    // Track it as a preview voice: stopPreview()/panic() must be able to
    // cancel a bar-quantized start that has not fired yet — otherwise the
    // sample sounds after the user pressed Stop.
    const voice: PreviewVoice = { source, gain };
    this.previewVoices.add(voice);
    source.start(when);
    source.onended = () => {
      this.previewVoices.delete(voice);
      gain.disconnect();
      source.disconnect();
    };
  }
}
