import type { DrumPad, ProjectDocument } from "../project-model/types";
import { BAR_TICKS } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import type { InstrumentRuntime } from "../instruments/types";
import { connectAudioClipSourceChannel } from "./audioClipChannels";
import { timeStretch } from "./time-stretch";
import { DECLICK_TAIL_SEC, resolveSlicePlayback, declickFadeOut } from "./declick";
import { audioClipPlayWindow, buildWarpSegments, type WarpSegment, type WarpManager } from "./warpManager";

export interface TriggerVoice {
  source: AudioScheduledSourceNode;
  gain: GainNode;
  trackId: string;
  chokeGroup: number | null;
  filter?: BiquadFilterNode;
  /** Per-pad mod nodes (LFO osc + depth gain) — disconnected with the voice. */
  extras?: AudioNode[];
  /**
   * Owner tag stamped by `withVoiceOwner` — a transient player (ghost
   * preview) tags its voices so its stop() can kill exactly its own overhang.
   * Untagged voices belong to the live scheduler/transport and are never
   * matched by `stopVoicesForOwner`.
   */
  owner?: string;
}

/**
 * Compute a time-stretched AudioBuffer from source at the given rate.
 * Uses the grain-based `timeStretch` algorithm from time-stretch.ts.
 * The stretched buffer plays at rate=1 so pitch is preserved.
 */
function computeStretchedBuffer(
  ctx: BaseAudioContext,
  source: AudioBuffer,
  stretchRate: number,
  reverse: boolean,
): AudioBuffer {
  const sr = source.sampleRate;
  const ch = source.numberOfChannels;
  const stretchFactor = Math.min(4, Math.max(0.25, stretchRate));
  // timeStretch changes duration by stretchFactor: >1 = longer (slower), <1 = shorter (faster)
  const outFrames = Math.max(1, Math.round(source.duration * stretchFactor * sr));
  const out = ctx.createBuffer(ch, outFrames, sr);
  for (let c = 0; c < ch; c++) {
    const src = source.getChannelData(c);
    const stretched = timeStretch(src, sr, stretchFactor);
    // timeStretch returns the input array itself on its fallback paths —
    // reversing it in place would corrupt the bank's shared source buffer.
    const channel = reverse ? (stretched === src ? stretched.slice() : stretched).reverse() : stretched;
    out.getChannelData(c).set(channel);
  }
  return out;
}

/** Narrow view of one instrument runtime slot (the engine owns the map). */
export interface InstrumentStateView {
  runtime: InstrumentRuntime;
  pitchBend: number;
}

/** Narrow read-view of a track's graph input (the engine owns the nodes). */
export interface TriggerTrackView {
  input: GainNode;
}

/**
 * Identity of one clip-triggered one-shot source, recorded alongside the
 * generic one-shot registry so the engine can tell WHICH clip a sounding
 * source belongs to. The live-editing sync compares this snapshot against the
 * current document: a source whose clip vanished (delete, split, undo) or
 * whose timeline geometry changed (move, resize, trim) is an orphan and gets
 * de-click-cancelled instead of ringing to its originally scheduled end.
 */
export interface ClipSourceMeta {
  clipId: string;
  startBar: number;
  lengthBars: number;
  /** Mute state at trigger time — muting a sounding clip makes it an orphan too. */
  muted: boolean;
  /** The node whose gain envelope owns this source's audibility (per-segment for warp clips). */
  gainNode: GainNode;
}

export interface TriggerEngineDeps {
  ctx: () => BaseAudioContext | null;
  doc: () => ProjectDocument | null;
  bank: () => SampleBank | null;
  currentTime: () => number;
  /** Read-only views over the engine's node maps (values are mutated in place). */
  trackNodes: Map<string, TriggerTrackView>;
  groupNodes: Map<string, TriggerTrackView>;
  instrumentStates: Map<string, InstrumentStateView>;
  /** Warp/freeze manager (frozen guards, warp cache + warming). */
  warp: WarpManager;
  /** One-shot source tracking (panic/seek hard-stops these). */
  trackOneShot(source: AudioScheduledSourceNode, clipMeta?: ClipSourceMeta): void;
  releaseOneShot(source: AudioScheduledSourceNode): void;
  /** Report an asset that failed to resolve (engine diagnostics). */
  missAsset(assetId: string): void;
}

/**
 * TriggerEngine — Wave 4f (FINAL) of the AudioEngine decomposition
 * (docs/AUDIOENGINE-DECOMPOSITION-PLAN.md).
 *
 * Owns the realtime performance path: drum-pad triggers (sampler voices
 * with p-locks, choke groups, per-pad mod envelopes), synth-pad voices
 * (per-type DSP graphs), instrument noteOn/noteOff with pitch-bend
 * adjustment + ratio p-locks + FL portamento slides, AudioClips (stretch
 * and repitch-warp playback), polyphonic aftertouch / MPE timbre and MIDI
 * pitch bends. Voice state (the voices set, the 64-voice retirement cap,
 * choke) lives here; the engine keeps orchestration (panic), the one-shot
 * tracker (markers/clicks), and graph sync.
 *
 * Facade law: this module never imports AudioEngine. Deps arrive as getter
 * closures + read-only map views (values mutated in place, same discipline
 * as the automation bridge). VERBATIM move from AudioEngine.ts — same
 * bodies, same clamps, same voice accounting.
 */

/** Default micro-crossfade at repitch-warp segment joints (de-click only). */
export const WARP_MICRO_FADE_SEC = 0.003;

/**
 * One repitch-warp segment's exact playback envelope: where its source
 * starts/stops (wall + buffer offsets, both relative to the clip start) and
 * the micro-fade automation on its private gain. Interior joints overlap:
 * the outgoing voice rings `o` past the boundary while the incoming voice
 * started `o` early — a 3 ms crossfade that kills boundary clicks without
 * moving any boundary in time. Edge fades (clip start/end) are capped at
 * half the segment so a sub-6 ms segment never folds its ramps over.
 */
export interface WarpSegmentRender {
  /** Wall offset (sec) from the clip `when` to start the source. */
  startOffsetSec: number;
  /** Buffer offset (sec) to start reading. */
  bufOffsetSec: number;
  /** Wall seconds to keep the source playing (stop = when + start + play). */
  playDurSec: number;
  /** Fade-in on the private gain (sec, relative to the clip start). */
  fadeInAt: number;
  fadeInDur: number;
  /** Fade-out on the private gain (sec, relative to the clip start). */
  fadeOutAt: number;
  fadeOutDur: number;
}

/**
 * Expand warp segments into click-free render plans. Pure — shared by the
 * live trigger and the offline render (both go through `triggerAudioClip`).
 */
export function warpSegmentRenders(
  segs: ReadonlyArray<WarpSegment>,
  opts: {
    clipTicks: number;
    clipDurSec: number;
    contentStartSec: number;
    contentDurSec: number;
    fadeSec?: number;
  },
): WarpSegmentRender[] {
  const { clipTicks, clipDurSec, contentStartSec, contentDurSec } = opts;
  const fade = Math.max(0, opts.fadeSec ?? WARP_MICRO_FADE_SEC);
  if (segs.length === 0 || !(clipTicks > 0) || !(clipDurSec > 0)) return [];
  const contentEnd = contentStartSec + contentDurSec;
  const wallAt = (tick: number): number => (tick / clipTicks) * clipDurSec;
  return segs.map((s, i) => {
    const wallStart = wallAt(s.startTick);
    const wallEnd = wallAt(s.endTick);
    const segWall = Math.max(0, wallEnd - wallStart);
    // Overlap with the previous joint: limited by the fade and by readable
    // content on both sides of the shared buffer break.
    let overlapIn = 0;
    if (i > 0 && fade > 0 && s.rate > 0) {
      const prev = segs[i - 1];
      overlapIn = Math.min(
        fade,
        (s.bufStartSec - contentStartSec) / s.rate,
        (contentEnd - prev.bufEndSec) / Math.max(1e-6, prev.rate),
      );
      if (!Number.isFinite(overlapIn) || overlapIn < 0.0005) overlapIn = 0;
    }
    // Overlap past the next joint (symmetric readability check).
    let overlapOut = 0;
    if (i + 1 < segs.length && fade > 0 && s.rate > 0) {
      const next = segs[i + 1];
      overlapOut = Math.min(
        fade,
        (contentEnd - s.bufEndSec) / s.rate,
        (next.bufStartSec - contentStartSec) / Math.max(1e-6, next.rate),
      );
      if (!Number.isFinite(overlapOut) || overlapOut < 0.0005) overlapOut = 0;
    }
    const startOffsetSec = wallStart - overlapIn;
    const bufOffsetSec = s.bufStartSec - overlapIn * s.rate;
    const playDurSec = Math.max(0.005, wallEnd + overlapOut - startOffsetSec);
    // Edge fades cap at half the segment; interior joints use the overlap.
    const edgeFade = Math.min(fade, segWall / 2);
    const fadeInAt = startOffsetSec;
    const fadeInDur = i > 0 ? overlapIn : edgeFade;
    const fadeOutAt = i + 1 < segs.length ? wallEnd : wallEnd - edgeFade;
    const fadeOutDur = i + 1 < segs.length ? overlapOut : edgeFade;
    return { startOffsetSec, bufOffsetSec, playDurSec, fadeInAt, fadeInDur, fadeOutAt, fadeOutDur };
  });
}

export class TriggerEngine {
  private voices = new Set<TriggerVoice>();
  private synthNoise: AudioBuffer | null = null;
  /** Scope tag for voices created inside `withVoiceOwner` — see that method. */
  private pendingVoiceOwner: string | undefined;

  constructor(
    private readonly deps: TriggerEngineDeps,
    private readonly warp: WarpManager,
  ) {}

  /** Diagnostics surface (engine getDiagnostics reads this). */
  get voiceCount(): number {
    return this.voices.size;
  }

  /** Context-swap teardown: stop + disconnect + clear (no ramps — the graph is dying). */
  disposeVoicesForContextSwap(): void {
    for (const voice of this.voices) {
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
    this.voices.clear();
    this.synthNoise = null;
  }

  /** No-context panic: the Sets must clear even with nothing to stop. */
  hardClearVoices(): void {
    this.voices.clear();
    this.synthNoise = null;
  }

  /**
   * Tag every voice created inside `fn` with `owner` (nesting-safe: inner
   * scopes inherit the outer tag unless they override it, and the previous
   * tag is restored on exit). Exists so a transient player can claim its
   * voices WITHOUT threading another parameter through trigger/noteOn —
   * the scheduler/live path simply never scopes.
   */
  withVoiceOwner<T>(owner: string, fn: () => T): T {
    const previous = this.pendingVoiceOwner;
    this.pendingVoiceOwner = owner;
    try {
      return fn();
    } finally {
      this.pendingVoiceOwner = previous;
    }
  }

  /**
   * De-clicked stop of ONLY the voices an owner tagged — a transient player
   * kills its own overhang (events already committed to the WebAudio clock:
   * pending starts in the lookahead window plus notes still ringing) without
   * touching scheduler/live-transport sound, which is never tagged. Same
   * de-click idiom as `panicVoices`.
   */
  stopVoicesForOwner(owner: string, now: number): void {
    for (const voice of this.voices) {
      if (voice.owner !== owner) continue;
      this.voices.delete(voice);
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0, now, 0.008);
      const stopAll = (voice as unknown as { _stopAll?: (t: number) => void })._stopAll;
      try {
        if (stopAll) stopAll(now + 0.05);
        else voice.source.stop(now + 0.05);
      } catch {
        /* already stopped */
      }
    }
  }

  /** Live panic: de-clicked ramps, then stop (verbatim from the old panic loop). */
  panicVoices(now: number): void {
    for (const voice of this.voices) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0, now, 0.008);
      const stopAll = (voice as unknown as { _stopAll?: (t: number) => void })._stopAll;
      if (stopAll) {
        try {
          stopAll(now + 0.05);
        } catch {
          /* already */
        }
      } else {
        try {
          voice.source.stop(now + 0.05);
        } catch {
          // already stopped
        }
      }
    }
    this.voices.clear();
  }

  private ensureSynthNoise(): AudioBuffer | null {
    const ctx = this.deps.ctx();
    if (this.synthNoise && ctx && this.synthNoise.sampleRate === ctx.sampleRate) return this.synthNoise;
    if (!ctx) return null;
    const len = Math.floor(ctx.sampleRate * 1);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 0x12345;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 4294967296) * 2 - 1;
    }
    this.synthNoise = buf;
    return buf;
  }

  noteOn(
    trackId: string,
    pitch: number,
    velocity: number,
    when: number,
    durationSec: number,
    slideFromTick?: number,
    slideFromPitch?: number,
    locks?: Partial<Record<import("../project-model/types").StepLockKey, number>>,
    slideFromWhen?: number,
  ): void {
    // Frozen tracks play back a pre-rendered buffer — skip individual noteOn
    if (this.warp.isFrozen(trackId)) return;
    const inst = this.deps.instrumentStates.get(trackId);
    if (!inst) return;
    const bendSemitones = inst.pitchBend ?? 0;
    const adjustedPitch = bendSemitones !== 0 ? pitch + bendSemitones : pitch;
    const slideFrom =
      slideFromTick !== undefined && slideFromPitch !== undefined
        ? {
            tick: slideFromTick,
            pitch: bendSemitones !== 0 ? slideFromPitch + bendSemitones : slideFromPitch,
          }
        : undefined;
    // Ratio p-lock: for Keys, override bell ratio for this voice only (Elektron-style)
    const docTrack = this.deps.doc()?.tracks.find((t) => t.id === trackId) as
      import("../project-model/types").InstrumentTrack | undefined;
    const lockedRatio = locks?.ratio;
    const needsRatioLock = lockedRatio !== undefined && docTrack?.instrument === "keys";
    const savedRatio: number | undefined = needsRatioLock ? (docTrack!.params as any).ratio : undefined;
    if (needsRatioLock) {
      // Capability check, NOT `??`: setParameterAt returns void, so the old
      // `??` fallback executed the immediate setParameter on EVERY call —
      // the locked value landed now (on ringing voices) instead of only at
      // the scheduled `when`.
      if (inst.runtime.setParameterAt) {
        inst.runtime.setParameterAt("ratio", Math.max(1, Math.min(7, lockedRatio as number)), when);
      } else {
        inst.runtime.setParameter("ratio", Math.max(1, Math.min(7, lockedRatio as number)));
      }
    }
    if (slideFrom) {
      // Glide origin in AudioContext seconds. The scheduler passes the
      // origin's own time from the SAME transport tick→time map that
      // produced `when` — the previous doc.bpm-based conversion was an
      // identity no-op that desynced the glide after any pause, seek or
      // scene-tempo change (glideStart clamped to 0 or landing after `when`).
      const glideStart =
        slideFromWhen !== undefined && Number.isFinite(slideFromWhen) && slideFromWhen < when
          ? slideFromWhen
          : Math.max(0, when - durationSec);
      inst.runtime.noteOn(adjustedPitch, velocity, when, durationSec, {
        pitch: slideFrom.pitch,
        when: Math.max(0, glideStart),
      });
    } else {
      inst.runtime.noteOn(adjustedPitch, velocity, when, durationSec);
    }
    if (needsRatioLock) {
      // Restore after voice captured ratio (next tick) — keep automation clean
      const restoreAt = when + 0.001;
      if (savedRatio === undefined) {
        // No prior ratio — restore the instrument default on the RUNTIME only.
        // The live doc must never be mutated from the audio path: it bypasses
        // the command/undo system, breaks immutable-doc delta capture, and in
        // a race (user sets a ratio param while the note sounds) would delete
        // their fresh edit.
        // if/else, not `??` — setParameterAt returns void, so the old fallback
        // fired the restore IMMEDIATELY, undoing the p-lock on ringing voices
        // a full lookahead before the note even played.
        if (inst.runtime.setParameterAt) inst.runtime.setParameterAt("ratio", 3.5, restoreAt);
        else inst.runtime.setParameter("ratio", 3.5);
      } else {
        if (inst.runtime.setParameterAt) inst.runtime.setParameterAt("ratio", savedRatio, restoreAt);
        else inst.runtime.setParameter("ratio", savedRatio);
      }
    }
  }

  /**
   * Schedule an AudioClip buffer segment through its track's FX chain.
   * Reuses frozenPlaybackOffset semantics (tick→sec + loop offset not needed
   * for one-shots; we use the same tick→sec conversion so live==offline).
   * The clip's timeline is `startBar→lengthBars` (bars), playback offset is
   * `offsetSec+trimStart`, duration is capped to the buffer length minus trims.
   *
   * stretchMode:
   * - "resample" (default): playbackRate changes pitch + time together
   * - "stretch": non-destructive time-stretch preserves pitch (pre-rendered
   *   grain buffer cached per bufferId+rate, deterministic live==offline)
   */
  triggerAudioClip(
    clip: import("../project-model/types").AudioClip,
    when: number,
    durationSec?: number,
    resumeOffsetSec = 0,
  ): void {
    const ctx = this.deps.ctx();
    const doc = this.deps.doc();
    if (!ctx || !doc) return;
    if (this.warp.isFrozen(clip.trackId)) return;
    const nodes = this.deps.trackNodes.get(clip.trackId) ?? this.deps.groupNodes.get(clip.trackId);
    if (!nodes) return;
    const srcBuffer = this.deps.bank()?.get(clip.bufferId);
    if (!srcBuffer) return;

    const rate = Math.min(4, Math.max(0.25, clip.stretchRate ?? 1));
    const reverse = clip.reverse;
    const resumedBy = Number.isFinite(resumeOffsetSec) ? Math.max(0, resumeOffsetSec) : 0;
    if (
      resumedBy > 0 &&
      (reverse ||
        clip.loop ||
        (clip.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01) ||
        (clip.warpMarkers?.length ?? 0) > 0)
    ) {
      return;
    }

    // --- stretchMode selection ---
    let playBuffer: AudioBuffer;
    let playbackRate: number;
    let clipDurSec: number;
    // offsetSec/trimStart/trimEnd are seconds in the ORIGINAL sample; the
    // stretched buffer's timeline is original × rate, so positions must be
    // scaled by `timeScale` before they can index into the play buffer.
    let timeScale: number;

    if (clip.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01) {
      // Lazy-compute stretched buffer and cache it (LRU: re-inserting on a hit
      // moves the key to the newest slot; eviction drops only the oldest —
      // same policy as the sampler's pitch cache in registry.ts).
      const cacheKey = `${clip.bufferId}|${rate}|${reverse ? 1 : 0}`;
      let stretched = this.warp.getStretched(cacheKey);
      if (stretched) {
        this.warp.storeStretched(cacheKey, stretched);
      } else {
        stretched = computeStretchedBuffer(ctx, srcBuffer, rate, reverse);
        this.warp.storeStretched(cacheKey, stretched);
      }
      playBuffer = stretched;
      playbackRate = 1;
      clipDurSec = durationSec ?? stretched.duration;
      timeScale = rate;
    } else {
      // Default resample: playbackRate controls both pitch and time
      playBuffer = srcBuffer;
      playbackRate = (reverse ? -1 : 1) * rate;
      clipDurSec = durationSec ?? srcBuffer.duration / Math.abs(playbackRate);
      timeScale = 1;
    }

    const source = ctx.createBufferSource();
    source.buffer = playBuffer;
    source.playbackRate.value = playbackRate;

    const gain = ctx.createGain();
    const clipGain = Math.min(2, Math.max(0, clip.gain ?? 1));
    gain.gain.value = clipGain;
    // Musical comp overlaps use deterministic equal-power curves. Ordinary
    // clip fades keep their existing linear behavior.
    const isCompClip = clip.compSourceTakeId !== undefined;
    let fadeIn = Math.max(0, clip.fadeIn ?? 0);
    let fadeOut = Math.max(0, clip.fadeOut ?? 0);
    const originalClipDurSec = clipDurSec + resumedBy;
    if (isCompClip && fadeIn + fadeOut > originalClipDurSec) {
      const scale = originalClipDurSec / Math.max(0.001, fadeIn + fadeOut);
      fadeIn *= scale;
      fadeOut *= scale;
    } else if (!isCompClip) {
      // Match the original non-comp envelopes: linear fade-in tops out at
      // half the clip duration, and fade-out can span at most the clip.
      // Use the full pre-resume duration so a mid-clip start evaluates the
      // same envelope progress the source had reached before audition began.
      fadeIn = Math.min(fadeIn, originalClipDurSec / 2);
      fadeOut = Math.min(fadeOut, originalClipDurSec);
    }
    const fadeInActive = fadeIn > 0.001 && resumedBy < fadeIn;
    const fadeInProgress = fadeIn > 0 ? Math.min(1, resumedBy / fadeIn) : 1;
    const fadeInRemaining = fadeInActive ? fadeIn - resumedBy : 0;
    const fadeOutStartSec = originalClipDurSec - fadeOut;
    const fadeOutActive = fadeOut > 0.001 && resumedBy >= fadeOutStartSec;
    const fadeOutProgress =
      fadeOutActive && fadeOut > 0 ? Math.min(1, Math.max(0, (resumedBy - fadeOutStartSec) / fadeOut)) : 0;
    const fadeOutRemaining = fadeOutActive ? clipDurSec : fadeOut;
    const fadeOutAt = fadeOutActive ? when : when + Math.max(0, clipDurSec - fadeOut);
    // Equal-power envelope curves (sine rising / cosine falling) — the shape
    // comp clips always use, and the shape `fadeCurve: "equal"` opts regular
    // clip fades into: two complementary equal-power fades over the same span
    // sum to constant power, which is what makes a crossfade not dip.
    const scheduleCurve = (
      gainNode: GainNode,
      startAt: number,
      duration: number,
      rising: boolean,
      startProgress = 0,
    ): void => {
      const pointCount = 64;
      const values = new Float32Array(pointCount + 1);
      for (let index = 0; index <= pointCount; index++) {
        const progress = startProgress + (index / pointCount) * (1 - startProgress);
        const angle = (progress * Math.PI) / 2;
        values[index] = clipGain * (rising ? Math.sin(angle) : Math.cos(angle));
      }
      gainNode.gain.setValueCurveAtTime(values, startAt, duration);
    };

    if (isCompClip) {
      const scheduleCurve = (startAt: number, duration: number, rising: boolean, startProgress = 0): void => {
        const pointCount = 64;
        const values = new Float32Array(pointCount + 1);
        for (let index = 0; index <= pointCount; index++) {
          const progress = startProgress + (index / pointCount) * (1 - startProgress);
          const angle = (progress * Math.PI) / 2;
          values[index] = clipGain * (rising ? Math.sin(angle) : Math.cos(angle));
        }
        gain.gain.setValueCurveAtTime(values, startAt, duration);
      };
      const initialEnvelope = fadeOutActive ? Math.cos((fadeOutProgress * Math.PI) / 2) : 1;
      gain.gain.setValueAtTime(clipGain * initialEnvelope, when);
      if (fadeInActive) scheduleCurve(when, Math.min(fadeInRemaining, clipDurSec), true, fadeInProgress);
      if (fadeOutRemaining > 0.001 && clipDurSec > 0.01) {
        scheduleCurve(fadeOutAt, Math.min(fadeOutRemaining, clipDurSec), false, fadeOutProgress);
      }
    } else {
      const equalPower = clip.fadeCurve === "equal";
      const initialEnvelope = equalPower
        ? (fadeOutActive ? Math.cos((fadeOutProgress * Math.PI) / 2) : 1) *
          (fadeInActive ? Math.sin((fadeInProgress * Math.PI) / 2) : 1)
        : (fadeInActive ? fadeInProgress : 1) * (fadeOutActive ? 1 - fadeOutProgress : 1);
      gain.gain.setValueAtTime(clipGain * initialEnvelope, when);
      if (fadeInActive) {
        if (equalPower) scheduleCurve(gain, when, Math.min(fadeInRemaining, clipDurSec / 2), true, fadeInProgress);
        else gain.gain.linearRampToValueAtTime(clipGain, when + Math.min(fadeInRemaining, clipDurSec / 2));
      }
      if (fadeOutRemaining > 0.001 && clipDurSec > 0.01) {
        const outStart = fadeOutAt;
        if (equalPower) {
          scheduleCurve(gain, outStart, Math.min(fadeOutRemaining, clipDurSec), false, fadeOutProgress);
        } else {
          if (!fadeOutActive) gain.gain.setValueAtTime(clipGain, outStart);
          gain.gain.linearRampToValueAtTime(0, when + clipDurSec);
        }
      }
    }
    const sourceSplitter = connectAudioClipSourceChannel(ctx, source, gain, clip.sourceChannel);
    gain.connect(nodes.input);

    // Offset / trim handling
    const { duration, bufferDuration, playOffset, contentDur, loopStart, loopEnd } = audioClipPlayWindow(
      clip,
      playBuffer.duration,
      clipDurSec,
      timeScale,
    );

    const hasWarpPins = (clip.warpMarkers?.length ?? 0) > 0;
    const clipTicks = clip.lengthBars * BAR_TICKS;
    // Pitch-preserving warp: stretch mode + pins → pre-rendered phase-vocoder
    // buffer (cached, tempo-exact). A cache miss warms in the background while
    // THIS trigger plays legacy straight-stretched, so timing never gaps —
    // the next loop iteration is exact.
    let warpedHit: AudioBuffer | null = null;
    if (hasWarpPins && !reverse && clip.loop !== true && clip.stretchMode === "stretch") {
      warpedHit = this.warp.getWarp(this.warp.warpCacheKey(clip, clipDurSec));
      if (warpedHit) {
        source.buffer = warpedHit;
        source.playbackRate.value = 1;
      } else {
        this.warp.warmWarp(clip, clipDurSec);
      }
    }

    // Repitch warp (FL/Slicex-style): warp markers pin sample time to the
    // arrangement grid. Resample mode only — pitch follows time; stretch mode
    // is served by the preserving path above, reverse keeps its legacy path.
    // Loop is skipped when warp maps the clip (warp already spans it fully).
    const warpSegs =
      warpedHit !== null || clip.reverse === true || clip.stretchMode === "stretch" || clip.loop === true
        ? null
        : buildWarpSegments({
            markers: clip.warpMarkers ?? [],
            clipStartTick: clip.startBar * BAR_TICKS,
            clipTicks,
            spt: clipTicks > 0 ? clipDurSec / clipTicks : 0,
            contentStartSec: playOffset,
            contentDurSec: contentDur,
          });

    // Texture-bed loop: cycle the trimmed content for the whole clip length
    // (a 4-bar atmosphere fills 16 bars). Native buffer loop over the content
    // window; the `start(when, offset, duration)` below still bounds total
    // playback and fades still apply at the clip edges. Skipped for reverse
    // (negative-rate looping is undefined behaviour in Web Audio).
    if (!warpSegs && clip.loop === true && !reverse && contentDur > 0.02) {
      if (loopEnd - loopStart >= 0.01) {
        source.loop = true;
        source.loopStart = loopStart;
        source.loopEnd = loopEnd;
      }
    }

    if (warpSegs) {
      // The primary `source` is never started on the segmented path — only
      // per-segment sources are. Disconnect it now so the connected-but-silent
      // BufferSource (and its source→gain edge) does not accumulate in the
      // render graph on every re-trigger of a looped warp clip.
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      try {
        sourceSplitter?.disconnect();
      } catch {
        /* already disconnected */
      }
      // One repitch source per segment through a private micro-fade gain, all
      // sharing the clip gain (musical fades still span the whole clip).
      // Interior joints overlap into a 3 ms crossfade (see
      // `warpSegmentRenders`): boundaries stay grid-exact, clicks do not.
      // Live and offline schedule identically.
      const renders = warpSegmentRenders(warpSegs, {
        clipTicks,
        clipDurSec,
        contentStartSec: playOffset,
        contentDurSec: contentDur,
      });
      let pending = warpSegs.length;
      for (let s = 0; s < warpSegs.length; s++) {
        const seg = warpSegs[s];
        const render = renders[s] ?? {
          startOffsetSec: (seg.startTick / clipTicks) * clipDurSec,
          bufOffsetSec: seg.bufStartSec,
          playDurSec: Math.max(0.005, seg.bufEndSec - seg.bufStartSec),
          fadeInAt: (seg.startTick / clipTicks) * clipDurSec,
          fadeInDur: 0,
          fadeOutAt: (seg.endTick / clipTicks) * clipDurSec,
          fadeOutDur: 0,
        };
        const segSource = ctx.createBufferSource();
        segSource.buffer = playBuffer;
        segSource.playbackRate.value = seg.rate;
        const segGain = ctx.createGain();
        const segSplitter = connectAudioClipSourceChannel(ctx, segSource, segGain, clip.sourceChannel);
        segGain.connect(gain);
        const segWhen = when + render.startOffsetSec;
        if (render.fadeInDur > 0.0001) {
          segGain.gain.setValueAtTime(0, segWhen);
          segGain.gain.linearRampToValueAtTime(1, segWhen + render.fadeInDur);
        } else {
          segGain.gain.setValueAtTime(1, segWhen);
        }
        if (render.fadeOutDur > 0.0001) {
          const foutAt = when + render.fadeOutAt;
          segGain.gain.setValueAtTime(1, foutAt);
          segGain.gain.linearRampToValueAtTime(0, foutAt + render.fadeOutDur);
        }
        try {
          // start() duration is buffer-domain: wall play length × rate.
          segSource.start(segWhen, render.bufOffsetSec, Math.max(0.005, render.playDurSec * seg.rate));
          segSource.stop(segWhen + render.playDurSec + 0.01);
        } catch {
          /* already started */
        }
        this.deps.trackOneShot(segSource, {
          clipId: clip.id,
          startBar: clip.startBar,
          lengthBars: clip.lengthBars,
          muted: clip.muted === true,
          gainNode: segGain,
        });
        segSource.onended = () => {
          this.deps.releaseOneShot(segSource);
          try {
            segSource.disconnect();
          } catch {}
          try {
            segGain.disconnect();
          } catch {}
          try {
            segSplitter?.disconnect();
          } catch {}
          if (--pending <= 0) {
            try {
              gain.disconnect();
            } catch {}
          }
        };
      }
    } else {
      // A preserving-warp hit plays the pre-rendered clip from its head.
      const effOffset = warpedHit ? 0 : playOffset;
      const effWallDuration = warpedHit ? Math.min(clipDurSec, warpedHit.duration) : duration;
      const effBufferDuration = warpedHit ? effWallDuration : bufferDuration;
      try {
        if (source.loop) {
          // Keep the loop's source window separate from its starting phase.
          // The optional duration argument counts source-buffer seconds, so
          // stop() owns the arrangement-time boundary for repeated loops.
          source.start(when, effOffset);
          source.stop(when + effWallDuration + 0.01);
        } else {
          source.start(when, effOffset, effBufferDuration);
          source.stop(when + effWallDuration + 0.01);
        }
      } catch {
        /* already started */
      }
      this.deps.trackOneShot(source, {
        clipId: clip.id,
        startBar: clip.startBar,
        lengthBars: clip.lengthBars,
        muted: clip.muted === true,
        gainNode: gain,
      });
      source.onended = () => {
        this.deps.releaseOneShot(source);
        try {
          source.disconnect();
        } catch {}
        try {
          sourceSplitter?.disconnect();
        } catch {}
        try {
          gain.disconnect();
        } catch {}
      };
    }
  }

  trigger(
    trackId: string,
    pad: DrumPad,
    when: number,
    velocity: number,
    locks?: Partial<Record<import("../project-model/types").StepLockKey, number>>,
    /** Resolved velocity-layer / round-robin sample for this hit (see groove.ts). */
    sampleId?: string | null,
  ): void {
    const ctx = this.deps.ctx();
    const trackNodes = this.deps.trackNodes.get(trackId);
    if (!ctx || !trackNodes) return;
    // Frozen tracks play back a pre-rendered buffer — skip individual triggers
    if (this.warp.isFrozen(trackId)) return;
    const buffer = this.deps.bank()?.get(sampleId ?? pad.assetId ?? "");
    if (!buffer) {
      if (pad.synth) {
        if (pad.chokeGroup !== null) this.choke(trackId, pad.chokeGroup, when);
        this.triggerSynth(trackId, pad, when, velocity, locks);
        return;
      }
      if (pad.assetId) this.deps.missAsset(pad.assetId);
      return;
    }
    if (pad.chokeGroup !== null) this.choke(trackId, pad.chokeGroup, when);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    let slice = resolveSlicePlayback(pad, buffer.duration);
    // Sample-start p-lock: normalized 0..1 → absolute start, preserve slice duration
    if (locks?.sampleStart !== undefined) {
      const frac = Math.min(1, Math.max(0, locks.sampleStart));
      const originalDur = slice.duration;
      const maxStart = Math.max(0, buffer.duration - originalDur - 0.001);
      const newStart = frac * maxStart;
      const newEnd = Math.min(buffer.duration, newStart + originalDur);
      const newDur = Math.max(0.001, newEnd - newStart);
      slice = { ...slice, start: newStart, end: newEnd, duration: newDur, offset: slice.reverse ? newEnd : newStart };
    }
    // Length p-lock: multiplier of slice duration (0.1 = 10%, 2 = 200%)
    if (locks?.length !== undefined) {
      const mul = Math.min(2, Math.max(0.1, locks.length));
      const baseDur = slice.duration;
      const newDurRaw = baseDur * mul;
      if (!slice.reverse) {
        const maxDur = Math.max(0.02, buffer.duration - slice.start);
        const newDur = Math.max(0.02, Math.min(maxDur, newDurRaw));
        slice = { ...slice, duration: newDur, end: slice.start + newDur, offset: slice.start };
      } else {
        const maxDur = Math.max(0.02, slice.end);
        const newDur = Math.max(0.02, Math.min(maxDur, newDurRaw));
        const newStart = Math.max(0, slice.end - newDur);
        slice = { ...slice, start: newStart, duration: newDur, offset: slice.end };
      }
    }
    const effectivePitch = locks?.pitch !== undefined ? locks.pitch : pad.pitch;
    const rateMagnitude = Math.pow(2, (Number.isFinite(effectivePitch) ? effectivePitch : 0) / 12);
    source.playbackRate.value = (slice.reverse ? -1 : 1) * rateMagnitude;
    const gain = ctx.createGain();
    const effectiveGain = locks?.gain !== undefined ? locks.gain : pad.gain;
    const peak = Math.max(0, velocity * effectiveGain);
    // MPC-style pad loop: play the head into the region, then cycle
    // loopStart→loopEnd until choked, retriggered or a 30 s safety cap.
    const loopPlayback = pad.sliceLoop === true && !slice.reverse;
    // De-click: every one-shot gets a guaranteed 2 ms tail even when no slice
    // fade is configured (default) and when a `length` p-lock cut the slice
    // mid-body. A step to zero at full amplitude is a click — this is the
    // single place that makes every drum voice safe. Attack is never touched.
    // A LOOPED pad schedules no slice-end fade (that would mute the loop) —
    // its de-click lives on the safety stop below and on the choke path.
    const fadeOut = declickFadeOut(slice.fadeOut, slice.duration);
    const endWhen = when + slice.duration;
    gain.gain.setValueAtTime(slice.fadeIn > 0 ? 0 : peak, when);
    if (slice.fadeIn > 0) gain.gain.linearRampToValueAtTime(peak, when + slice.fadeIn);
    if (!loopPlayback && fadeOut > 0) {
      const fadeOutAt = Math.max(when + slice.fadeIn, endWhen - fadeOut);
      gain.gain.setValueAtTime(peak, fadeOutAt);
      gain.gain.linearRampToValueAtTime(0, fadeOutAt + fadeOut);
    }
    const panner = ctx.createStereoPanner();
    panner.pan.value = locks?.pan !== undefined ? locks.pan : pad.pan;

    // Per-voice lowpass for cutoff p-lock — or for a filter-target pad mod
    const mod = pad.mod;
    const modActive = !!(mod && mod.depth > 0 && mod.rateHz > 0);
    const wantsFilter = locks?.cutoff !== undefined || (modActive && mod!.target === "filter");
    let voiceFilter: BiquadFilterNode | null = null;
    let voiceOutput: AudioNode = panner;
    if (wantsFilter) {
      voiceFilter = ctx.createBiquadFilter();
      voiceFilter.type = "lowpass";
      const baseFreq = locks?.cutoff ?? (modActive && mod!.target === "filter" ? mod!.base : undefined) ?? 8000;
      voiceFilter.frequency.value = Math.min(16000, Math.max(80, baseFreq));
      voiceFilter.Q.value = 0.7;
      // Chain: source -> gain -> panner -> filter -> trackInput
      source.connect(gain).connect(panner).connect(voiceFilter).connect(trackNodes.input);
      voiceOutput = voiceFilter;
    } else {
      source.connect(gain).connect(panner).connect(trackNodes.input);
    }

    const voice: TriggerVoice = {
      source,
      gain,
      trackId,
      chokeGroup: pad.chokeGroup,
      filter: voiceFilter ?? undefined,
      ...(this.pendingVoiceOwner !== undefined ? { owner: this.pendingVoiceOwner } : {}),
    };
    if (modActive) this.attachPadMod(voice, mod!, peak, when, endWhen);
    this.addDrumVoice(voice);
    source.onended = () => {
      this.voices.delete(voice);
      gain.disconnect();
      panner.disconnect();
      if (voiceFilter) voiceFilter.disconnect();
      if (voice.extras) {
        for (const n of voice.extras) {
          try {
            (n as OscillatorNode).stop?.();
          } catch {
            /* already stopped */
          }
          try {
            n.disconnect();
          } catch {
            /* already */
          }
        }
      }
      source.disconnect();
    };
    // Slice playback uses the native buffer offset/duration path — realtime
    // and export share the exact same samples.
    if (pad.sliceLoop === true && !slice.reverse) {
      // MPC-style pad loop: play the head into the region, then cycle
      // loopStart→loopEnd until choked, retriggered or a 30 s safety cap.
      const loopStart = Math.min(
        Math.max(slice.start, Number.isFinite(pad.sliceLoopStart) ? pad.sliceLoopStart! : slice.start),
        buffer.duration - 0.005,
      );
      const loopEnd = Math.min(
        Math.max(loopStart + 0.005, Number.isFinite(pad.sliceLoopEnd) ? pad.sliceLoopEnd! : slice.end),
        buffer.duration,
        Math.max(loopStart + 0.005, slice.end),
      );
      if (loopEnd - loopStart >= 0.005) {
        source.loop = true;
        source.loopStart = loopStart;
        source.loopEnd = loopEnd;
        source.start(when, slice.offset);
        // Safety cap: looped pads ring until choke/retrigger, at most 30 s.
        // De-click the cap itself — a hard source.stop mid-loop clicks.
        const safetyStop = when + 30;
        const safetyFade = Math.min(DECLICK_TAIL_SEC, 0.05);
        gain.gain.setValueAtTime(peak, safetyStop - safetyFade);
        gain.gain.linearRampToValueAtTime(0, safetyStop);
        source.stop(safetyStop);
        void voiceOutput;
        return;
      }
    }
    source.start(when, slice.offset, slice.duration);
    void voiceOutput;
  }

  private attachPadMod(
    voice: TriggerVoice,
    mod: NonNullable<import("../project-model/types").DrumPad["mod"]>,
    peak: number,
    when: number,
    _endWhen: number,
  ): void {
    const ctx = this.deps.ctx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = mod.wave;
    osc.frequency.value = mod.rateHz;
    const depth = ctx.createGain();
    osc.connect(depth);
    if (mod.target === "gain") {
      // Tremolo: LFO adds on TOP of the envelope automation (params sum inputs).
      depth.gain.value = mod.depth * Math.max(0.0001, peak);
      depth.connect(voice.gain.gain);
    } else if (mod.target === "filter") {
      const target = voice.filter;
      if (!target) return;
      depth.gain.value = mod.depth;
      depth.connect(target.frequency);
    } else {
      // Pitch wobble in semitones → cents on the source detune param.
      depth.gain.value = mod.depth * 100;
      const detune = (voice.source as AudioBufferSourceNode).detune;
      if (detune) {
        depth.connect(detune);
      } else {
        // Engines without source detune: wobble playbackRate (±depth semitones).
        depth.gain.value = Math.pow(2, mod.depth / 12) - 1;
        depth.connect((voice.source as AudioBufferSourceNode).playbackRate);
      }
    }
    // Looping pads ring up to the 30 s safety cap; one-shot voices are
    // disconnected at onended, this stop is just the upper bound.
    osc.start(when);
    try {
      osc.stop(when + 30.5);
    } catch {
      /* already scheduled */
    }
    voice.extras = [osc, depth];
  }

  /**
   * Drum voice ceiling (PERFORMANCE.md flag: the one-shot voice Set used to
   * be uncapped — a roll grew it without limit). Insertion-ordered Set, so
   * the first entry is the oldest sounding voice: fade + stop it and let its
   * onended run the normal node cleanup.
   */
  private addDrumVoice(voice: TriggerVoice): void {
    this.voices.add(voice);
    const MAX_ACTIVE_DRUM_VOICES = 64;
    let voicesToRetire = this.voices.size - MAX_ACTIVE_DRUM_VOICES;
    if (voicesToRetire <= 0) return;
    const now = this.deps.ctx()?.currentTime ?? 0;
    for (const oldest of this.voices) {
      if (voicesToRetire-- <= 0) break;
      try {
        oldest.gain.gain.cancelScheduledValues(now);
        oldest.gain.gain.setTargetAtTime(0.0001, now, 0.004);
        oldest.source.stop(now + 0.03);
      } catch {
        /* already ended — onended removes it */
      }
    }
  }

  private triggerSynth(
    trackId: string,
    pad: DrumPad,
    when: number,
    velocity: number,
    locks?: Partial<Record<import("../project-model/types").StepLockKey, number>>,
  ): void {
    const ctx = this.deps.ctx();
    const trackNodes = this.deps.trackNodes.get(trackId);
    if (!ctx || !trackNodes || !pad.synth) return;
    const synth = pad.synth;
    const effectiveGain = locks?.gain !== undefined ? locks.gain : pad.gain;
    const peak = Math.max(0, velocity * effectiveGain);
    const pan = locks?.pan !== undefined ? locks.pan : pad.pan;
    const cutoff = locks?.cutoff !== undefined ? locks.cutoff : synth.tone;
    const lengthMul = locks?.length !== undefined ? Math.min(2, Math.max(0.1, locks.length)) : 1;
    const pitchOffset = locks?.pitch !== undefined ? locks.pitch : pad.pitch;
    const baseDecay = synth.decay * lengthMul;
    const noise = this.ensureSynthNoise();
    if (!noise) return;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, when);
    // Decay is handled per-type below; for hat we use exponential ramp
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    gain.connect(panner).connect(trackNodes.input);

    const sources: AudioScheduledSourceNode[] = [];
    const extraNodes: AudioNode[] = [gain, panner];

    const addVoice = (src: AudioScheduledSourceNode, g: GainNode, filter?: BiquadFilterNode) => {
      sources.push(src);
      extraNodes.push(g);
      if (filter) extraNodes.push(filter);
      // Connect src -> filter? Handled per-type
    };

    const finishVoice = (dur: number) => {
      const voiceGain = gain;
      const voice: TriggerVoice = {
        source: sources[0] ?? (gain as unknown as AudioScheduledSourceNode),
        gain: voiceGain,
        trackId,
        chokeGroup: pad.chokeGroup,
        ...(this.pendingVoiceOwner !== undefined ? { owner: this.pendingVoiceOwner } : {}),
      };
      // Store all sources for choke/silence
      const allSources = [...sources];
      // Per-pad mod on synth voices: gain wobble on the voice gain, pitch via
      // per-source detune, filter via an extra lowpass after the panner.
      const synthMod = pad.mod;
      if (synthMod && synthMod.depth > 0 && synthMod.rateHz > 0) {
        const osc = ctx.createOscillator();
        osc.type = synthMod.wave;
        osc.frequency.value = synthMod.rateHz;
        const depth = ctx.createGain();
        osc.connect(depth);
        if (synthMod.target === "gain") {
          depth.gain.value = synthMod.depth * Math.max(0.0001, peak);
          depth.connect(gain.gain);
        } else if (synthMod.target === "filter") {
          const vf = ctx.createBiquadFilter();
          vf.type = "lowpass";
          vf.frequency.value = Math.min(16000, Math.max(80, synthMod.base ?? 8000));
          vf.Q.value = 0.7;
          try {
            panner.disconnect();
          } catch {
            /* not yet connected */
          }
          panner.connect(vf).connect(trackNodes.input);
          depth.gain.value = synthMod.depth;
          depth.connect(vf.frequency);
          extraNodes.push(vf);
        } else {
          depth.gain.value = synthMod.depth * 100;
          for (const s of allSources) {
            const d = (s as OscillatorNode).detune;
            if (d) depth.connect(d);
          }
        }
        extraNodes.push(osc, depth);
        osc.start(when);
        try {
          osc.stop(when + dur + 0.6);
        } catch {
          /* already scheduled */
        }
      }
      // Override voice stop to stop all
      const stopAll = (t: number) => {
        for (const s of allSources) {
          try {
            (s as AudioBufferSourceNode).stop(t);
          } catch {
            try {
              (s as OscillatorNode).stop(t);
            } catch {
              /* already */
            }
          }
        }
        voiceGain.gain.cancelScheduledValues(t);
        voiceGain.gain.setTargetAtTime(0.0001, t, 0.005);
      };
      // Patch voice's stop/silence to use stopAll
      (voice as any)._stopAll = stopAll;
      this.addDrumVoice(voice);
      const primary = sources[0];
      if (primary) {
        primary.onended = () => {
          this.voices.delete(voice);
          for (const n of extraNodes) {
            try {
              n.disconnect();
            } catch {
              /* already */
            }
          }
          for (const s of allSources) {
            try {
              s.disconnect();
            } catch {
              /* already */
            }
          }
        };
      }
      // Schedule stop after dur
      const stopAt = when + dur + 0.05;
      for (const s of allSources) {
        try {
          if ((s as AudioBufferSourceNode).buffer) (s as AudioBufferSourceNode).stop(stopAt);
          else (s as OscillatorNode).stop(stopAt);
        } catch {
          /* already */
        }
      }
    };

    switch (synth.type) {
      case "hatClosed":
      case "hatOpen": {
        const isOpen = synth.type === "hatOpen";
        const snap = (synth as any).snap ?? 0.35;
        const body = (synth as any).body ?? 0.5;
        // decay now respects user value (schema def already 0.08/0.32); sizzle via snap, body darkens
        const baseDecay = synth.decay * lengthMul;
        const hpFreq = Math.max(1000, Math.min(12000, cutoff * (1 + snap * 0.35) - body * 600));
        const src = ctx.createBufferSource();
        src.buffer = noise!;
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = hpFreq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(peak, when);
        g.gain.exponentialRampToValueAtTime(0.0001, when + baseDecay);
        src.connect(hp).connect(g).connect(gain);
        src.start(when);
        addVoice(src, g, hp);
        // shimmer layer for open hats when snap high
        if (isOpen && snap > 0.5) {
          const shSrc = ctx.createBufferSource();
          shSrc.buffer = noise!;
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.value = 9200;
          bp.Q.value = 1.2;
          const sg = ctx.createGain();
          sg.gain.setValueAtTime(peak * 0.22 * snap, when);
          sg.gain.exponentialRampToValueAtTime(0.0001, when + baseDecay * 0.7);
          shSrc.connect(bp).connect(sg).connect(gain);
          shSrc.start(when);
          addVoice(shSrc, sg, bp);
        }
        finishVoice(baseDecay);
        break;
      }
      case "clap": {
        const decays = [0.02, 0.018, 0.16];
        const times = [0, 0.011, 0.03];
        for (let i = 0; i < 3; i++) {
          const src = ctx.createBufferSource();
          src.buffer = noise!;
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.value = i < 2 ? 1150 : 1100;
          bp.Q.value = i < 2 ? 1.6 : 1.1;
          const g = ctx.createGain();
          const at = when + times[i];
          const dec = decays[i] * lengthMul;
          g.gain.setValueAtTime(0.55, at);
          g.gain.exponentialRampToValueAtTime(0.0001, at + dec);
          src.connect(bp).connect(g).connect(gain);
          src.start(at);
          addVoice(src, g, bp);
        }
        finishVoice(0.4 * lengthMul);
        break;
      }
      case "kick": {
        const snap = (synth as any).snap ?? 0.35;
        const body = (synth as any).body ?? 0.5;
        const baseDecay = synth.decay * lengthMul;
        const startHz = 150 * Math.pow(2, pitchOffset / 12) * (1 + body * 0.15);
        const endHz = 45 * Math.pow(2, pitchOffset / 12);
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(startHz, when);
        osc.frequency.exponentialRampToValueAtTime(endHz, when + Math.min(0.09, baseDecay * (0.35 + body * 0.15)));
        const ampOsc = ctx.createGain();
        ampOsc.gain.setValueAtTime(peak, when);
        ampOsc.gain.exponentialRampToValueAtTime(0.0001, when + baseDecay);
        osc.connect(ampOsc).connect(gain);
        osc.start(when);
        addVoice(osc, ampOsc);
        // Click — snap controls transient, tone controls brightness
        const clickSrc = ctx.createBufferSource();
        clickSrc.buffer = noise!;
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 1500;
        const clickGain = ctx.createGain();
        const clickLevel = 0.2 + (cutoff / 12000) * 0.3 + snap * 0.28;
        const clickDur = 0.008 + snap * 0.014;
        clickGain.gain.setValueAtTime(peak * clickLevel, when);
        clickGain.gain.exponentialRampToValueAtTime(0.0001, when + clickDur);
        clickSrc.connect(hp).connect(clickGain).connect(gain);
        clickSrc.start(when);
        addVoice(clickSrc, clickGain, hp);
        finishVoice(baseDecay);
        break;
      }
      case "snare": {
        const snap = (synth as any).snap ?? 0.35;
        const body = (synth as any).body ?? 0.5;
        const baseDecay = synth.decay * lengthMul;
        const toneHz = 192 * Math.pow(2, pitchOffset / 12) * (1 + body * 0.08);
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(toneHz, when);
        osc.frequency.exponentialRampToValueAtTime(toneHz * 0.6, when + 0.11 * (0.8 + body * 0.4));
        const oscGain = ctx.createGain();
        const bodyGain = 0.62 + body * 0.28;
        oscGain.gain.setValueAtTime(peak * bodyGain, when);
        oscGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.11 * lengthMul * (0.8 + body * 0.4));
        osc.connect(oscGain).connect(gain);
        osc.start(when);
        addVoice(osc, oscGain);
        const nSrc = ctx.createBufferSource();
        nSrc.buffer = noise!;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = Math.max(500, Math.min(8000, cutoff));
        if (locks?.cutoff === undefined)
          bp.frequency.value = Math.max(500, Math.min(8000, (synth as any).tone ?? 1750));
        bp.Q.value = 0.9 + snap * 0.7;
        const nGain = ctx.createGain();
        const snapGain = 0.55 + snap * 0.35;
        const noiseDecay = baseDecay * (0.6 + snap * 0.5);
        nGain.gain.setValueAtTime(peak * snapGain, when);
        nGain.gain.exponentialRampToValueAtTime(0.0001, when + noiseDecay);
        nSrc.connect(bp).connect(nGain).connect(gain);
        nSrc.start(when);
        addVoice(nSrc, nGain, bp);
        finishVoice(Math.max(0.11, baseDecay));
        break;
      }
      case "perc": {
        const snap = (synth as any).snap ?? 0.35;
        const body = (synth as any).body ?? 0.5;
        const freq = 2100 * Math.pow(2, pitchOffset / 12);
        const src = ctx.createBufferSource();
        src.buffer = noise!;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = Math.max(500, Math.min(8000, cutoff));
        if (locks?.cutoff === undefined)
          bp.frequency.value = Math.max(500, Math.min(8000, (synth as any).tone ?? freq));
        bp.Q.value = 2.5 + snap * 3;
        const g = ctx.createGain();
        g.gain.setValueAtTime(peak, when);
        g.gain.exponentialRampToValueAtTime(0.0001, when + (0.04 + body * 0.04) * lengthMul);
        src.connect(bp).connect(g).connect(gain);
        src.start(when);
        addVoice(src, g, bp);
        finishVoice(0.08);
        break;
      }
      case "cowbell": {
        const snap = (synth as any).snap ?? 0.35;
        const body = (synth as any).body ?? 0.5;
        const base = 540 * Math.pow(2, pitchOffset / 12);
        const freqs = [base, base * 1.485];
        for (const f of freqs) {
          const osc = ctx.createOscillator();
          osc.type = "square";
          osc.frequency.value = f;
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.value = f;
          bp.Q.value = 2 + snap * 1.2;
          const g = ctx.createGain();
          g.gain.setValueAtTime(peak * (0.38 + body * 0.14), when);
          g.gain.exponentialRampToValueAtTime(0.0001, when + (0.32 + body * 0.12) * lengthMul);
          osc.connect(bp).connect(g).connect(gain);
          osc.start(when);
          addVoice(osc, g, bp);
        }
        finishVoice(0.36);
        break;
      }
      default: {
        const src = ctx.createBufferSource();
        src.buffer = noise!;
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = cutoff;
        const g = ctx.createGain();
        g.gain.setValueAtTime(peak, when);
        g.gain.exponentialRampToValueAtTime(0.0001, when + baseDecay);
        src.connect(hp).connect(g).connect(gain);
        src.start(when);
        addVoice(src, g, hp);
        finishVoice(baseDecay);
        break;
      }
    }

    // Choke already handled via this.voices; triggerSynth voices are in same set
    // so choke will find them by trackId/chokeGroup
    // Patch voices' silence to use stopAll
    // Already handled via _stopAll, but choke calls voice.gain and voice.source.stop
    // For synth, we need to ensure choke stops all sources, not just primary
    // Our _stopAll is stored but choke doesn't know it — we should monkey-patch voice's silence
    // For now, handle via storing allSources on voice instance
    for (const v of this.voices) {
      if ((v as any)._stopAll && v.trackId === trackId && v.chokeGroup === pad.chokeGroup) {
        // Keep reference for choke
      }
    }
  }

  private choke(trackId: string, chokeGroup: number, when: number): void {
    const ctx = this.deps.ctx();
    if (!ctx) return;
    // Defect 6.2 (lifecycle / leak audit): the previous implementation
    // iterated `this.voices` directly and called `this.voices.delete`
    // mid-loop. ECMAScript tolerates that today, but the code is one
    // future `continue` or thrown callback away from skipping or
    // leaking voices. Take a defensive snapshot — choke fires only
    // on the trigger path (not every tick), so the per-call cost is
    // bounded and worth the safety.
    // FL-style cut: the choke lands EXACTLY on the new hit's scheduled time
    // (`when` from the same tick→time map), not on `currentTime`. The
    // scheduler runs ~120 ms ahead, so cutting at `now` let the old hat ring
    // over the new one. Clamped to `now` for live/immediate hits.
    const cutAt = Number.isFinite(when) ? Math.max(when, ctx.currentTime) : ctx.currentTime;
    for (const voice of [...this.voices]) {
      if (voice.trackId !== trackId || voice.chokeGroup !== chokeGroup) continue;
      voice.gain.gain.cancelScheduledValues(cutAt);
      voice.gain.gain.setTargetAtTime(0, cutAt, 0.005);
      const stopAll = (voice as any)._stopAll as ((t: number) => void) | undefined;
      if (stopAll) {
        try {
          stopAll(cutAt + 0.02);
        } catch {
          /* already */
        }
      } else {
        try {
          voice.source.stop(cutAt + 0.02);
        } catch {
          // already stopped
        }
      }
      this.voices.delete(voice);
    }
  }

  setMidiPitchBend(trackId: string, semitones: number): void {
    const inst = this.deps.instrumentStates.get(trackId);
    if (!inst) return;
    inst.pitchBend = semitones;
  }

  /** Apply polyphonic aftertouch to a specific note on an instrument track. */
  /**
   * MPE timbre dimension (CC74). Convention mirrors polyPressure: per-note,
   * 0..1 bipolar with 0.5 = the note's base — instruments map it to their
   * brightness control (filter cutoff; FM scales INDEX). No-op for tracks
   * whose runtime does not implement it.
   */
  polyTimbre(trackId: string, pitch: number, timbre: number): void {
    const inst = this.deps.instrumentStates.get(trackId);
    if (!inst) return;
    inst.runtime.polyTimbre?.(pitch, timbre, this.deps.ctx()?.currentTime ?? 0);
  }

  polyPressure(trackId: string, pitch: number, pressure: number): void {
    const inst = this.deps.instrumentStates.get(trackId);
    if (!inst?.runtime.polyPressure) return;
    inst.runtime.polyPressure(pitch, pressure, this.deps.ctx()?.currentTime ?? 0);
  }

  /** Release a specific voice by pitch. */
  noteOff(trackId: string, pitch: number, when: number): void {
    const inst = this.deps.instrumentStates.get(trackId);
    if (!inst?.runtime.noteOff) return;
    inst.runtime.noteOff(pitch, when);
  }
}
