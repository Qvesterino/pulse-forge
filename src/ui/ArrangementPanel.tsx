import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  useArrangement,
  useArrangementCapture,
  useMarkers,
  usePatterns,
  useScenes,
  useSelection,
  useSelectionStore,
  useServices,
  useTool,
  useToolStore,
  useTracks,
} from "./context";
import { ScenesPanel } from "./arrangement/ScenesPanel";
import { ArrangementViewControls } from "./arrangement/ArrangementViewControls";
import { MidiClipLanes } from "./arrangement/MidiClipLanes";
import { requestMidiClipEditorNavigation } from "./arrangement/midiClipEditorNavigation";
import {
  VIEWPORT_COMMIT_QUANTUM_PX,
  viewportDecision,
  type ArrangementViewport,
  type CommittedViewport,
} from "./arrangement/viewport";
import { AutomationClipLanes } from "./arrangement/AutomationClipLanes";
import {
  clearTimelineGroupDragPreview,
  groupDragPreviewStartBar,
  publishTimelineGroupDragPreview,
  useTimelineGroupDragPreview,
} from "./arrangement/groupDragPreview";
import { ChordProgressionPanel, type ChordGenForm } from "./arrangement/ChordProgressionPanel";
import { notifyOnboardingProgress } from "./OnboardingHint";
import { publishSessionRecordingState, IDLE_SESSION_STATE } from "./sessionStateSurface";
import { useActivePatternId } from "./context";
import { useShortcutHints } from "./useShortcutHints";
import { SpectralEditPanel } from "./SpectralEditPanel";
import {
  addArrangementClip,
  addArrangementTransition,
  addAudioClip,
  addMarker,
  audioClipDurationSec,
  consolidateAudioClips,
  compAudioTakeRange,
  autoArrangeSong,
  createArrangementSkeleton,
  createScene,
  createVariationAndPlaceClip,
  deleteArrangementClip,
  deleteAutomationClip,
  deleteAudioClip,
  deleteMidiClip,
  deleteScene,
  duplicateArrangementClip,
  duplicateAudioClip,
  duplicatePatternForScene,
  duplicateSceneAsVariation,
  fitAudioClipTempo,
  previewStretchRate,
  quantizeAudioBar,
  stretchAudioClip,
  stealGrooveIntoPattern,
  moveArrangementClip,
  moveAudioClip,
  removeArrangementTransition,
  removeMarker,
  renameScene,
  reorderScenes,
  resizeArrangementClip,
  setActivePattern,
  transitionsForClips,
  resizeArrangementClipRipple,
  nudgeClips,
  moveArrangementClipRipple,
  trimArrangementClipStart,
  deleteArrangementClipRipple,
  setArrangementClipScene,
  setArrangementClipLoop,
  setSceneIntensityCurve,
  setSceneRole,
  resizeAudioClip,
  slipAudioClip,
  setActiveAudioTake,
  splitArrangementClipAtTick,
  splitAudioClipAtTick,
  stripSilenceAudioClip,
  trimAudioClipStart,
  updateArrangementTransition,
  updateAudioClip,
  sliceToPads,
  MIN_NEW_AUDIO_CLIP_BARS,
} from "../commands/commands";
import { generatePatternCommand } from "../commands/aiPattern";
import { makeMidiClipUnique } from "../commands/midiClips";
import { MAX_ARRANGEMENT_CLIP_BARS, sceneRoleOf, ticksPerBar } from "../project-model/schema";
import {
  audioClipAudibleWidthFraction,
  audioClipPlayedSourceSec,
  audioClipSourceSecondsPerWallSecond,
  audioClipWallSourceSec,
} from "../project-model/audio-clip-warp";
import { stepsPerBar } from "../project-model/grid";
import { applySmartComp, planBars, planSmartComp, type SmartCompPlan } from "../commands/smart-comp";
import { sectionFxChips } from "./arrangement/sectionFxChips";
import {
  arrangementSecondsBetweenTicks,
  effectiveSceneBpm,
  sceneBarsToSeconds,
  sceneSecondsToBars,
  tempoAtTick,
} from "../project-model/scene-time";
import { timelineItemsOf } from "../project-model/timeline";
import { usePointerDragGuard } from "./usePointerDragGuard";
import { SNAP_GRIDS, snapBar, snapBarToTargets, snapBarsFor, snapController, snapDelta, snapTick } from "./snap";
import { chordName } from "../project-model/chords";
import {
  addChord,
  conformInstrumentClipsToChordTrack,
  generateChordProgression,
  moveChord,
  removeChord,
  resizeChord,
  setChord,
  transposeInstrumentClips,
} from "../commands/chordTrack";
import type { ChordQuality } from "../project-model/chords";
import type { SnapGridId } from "./snap";
import { computeSceneIntensity } from "../project-model/intensity";
import type {
  ArrangementClip,
  ArrangementTransitionType,
  AudioClip,
  ArrangementAutomationClip,
  IntensityPoint,
  MidiClip,
  ProjectDocument,
} from "../project-model/types";
import { PPQ, STEP_TICKS } from "../project-model/types";
import { detectLoopBpm } from "../audio-engine/bpm-detect";
import { audioClipChannelData, audioClipWaveformWindow } from "../audio-engine/audioClipChannels";
import { warpBufferTimeAtTick } from "../audio-engine/AudioEngine";
import { nearestOnset } from "../audio-workers/onset-detector";
import { extractGroove } from "../audio-engine/groove-extract";
import { detectTransientsAsync } from "../audio-workers/onset-detector-client";
import { analyzeLoopForFlip, buildFlipOptions, flipSeed } from "../ai/flip";
import { recordedTakeSampleId, userSampleId } from "../persistence/UserSampleRepository";
import { RECORDING_OWNER_ID, type RecordingSession } from "../persistence/RecordingRecoveryRepository";
import { materializePcmTake } from "../audio-engine/pcmRecording";
import { recordingAlignment } from "../audio-engine/recordingAlignment";
import {
  listRecordingInputDevices,
  loadRecordingInputDeviceId,
  loadRecordingInputGainDb,
  saveRecordingInputDeviceId,
  saveRecordingInputGainDb,
  type RecordingInputDevice,
} from "../audio-engine/recordingInput";
import {
  clampInputGainDb,
  MAX_INPUT_GAIN_DB,
  MIN_INPUT_GAIN_DB,
  type PcmCaptureInfo,
} from "../audio-engine/PcmMicRecorder";
import { buildAudioClipConsolidationDoc, buildBounceZoneDoc } from "../rendering/bounce";
import {
  audioTakeAuditionStartOffsetSec,
  createAudioTakeAuditionDoc,
  createLiveAudioTakeAuditionProject,
} from "../rendering/take-audition";
import { encodeWav, encodeWavAsync } from "../rendering/wav";
import {
  addRecordedAudioClips,
  addRecordedLoopSession,
  addRecordedAudioTakeClip,
  clipLengthBars,
  compensateRecordingStartBar,
  recordedLoopPasses,
  recordedTakeAlreadyPlaced,
  resolveRecordedAudioDestinations,
  recordedPunchWindow,
  recordingStartBar,
} from "./timelineRec";
import {
  MANUAL_ALIGN_SEARCH_SEC,
  autoAlignShiftSec,
  formatShiftMs,
  measurePhraseOnset,
  passAlignShifts,
} from "../audio-engine/vocal-alignment";
import { useCurrentItemId, usePlayheadBar } from "./playhead";
import { useLongPress } from "./useLongPress";
import type { Transport } from "../transport/Transport";
import { useSceneRuntimeState } from "./SceneLauncher";
import { StretchDialog } from "./StretchDialog";

const BASE_BAR_WIDTH = 30;
/**
 * Arrangement zoom range (× on BASE_BAR_WIDTH): 0.05× = 1.5 px/bar shows a
 * 1300-bar project in one viewport; 40× = 1200 px/bar is sample-editor
 * territory. The old 0.35–4 could show ~190 bars max — a long arrangement
 * never fit the screen. Grid/ruler marks and clip windowing stay legible at
 * both extremes (marks every 4 bars are ≥ 6 px apart at min zoom).
 */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 40;
const LANE_HEIGHT = 56;
/**
 * Extra bars rendered either side of the viewport.
 *
 * The lane is scrolled by the wheel AND dragged by the pointer, so a clip that
 * is half a screen away still becomes reachable within one gesture. Two bar
 * widths of slack is not enough: a fast horizontal flick covers more than that
 * between two frames, and the clip the user is reaching for would flicker out
 * of the DOM and back.
 */
const VIEWPORT_OVERSCAN_BARS = 12;
/**
 * Transient times (sec) per audio buffer for the warp-pin magnet. Module
 * scope: detection is async (worker for long samples) and outlives renders.
 * A placement miss simply stays un-snapped and kicks off detection, so the
 * next pin on the same buffer snaps.
 */
const warpOnsetCache = new Map<string, number[]>();
const warpOnsetInflight = new Set<string>();
/** FIFO bound on cached onset arrays (see getWarpOnsets). */
const WARP_ONSET_CACHE_LIMIT = 96;
/** Grab radius of the transient magnet around the pointed sample time. */
const WARP_SNAP_SEC = 0.06;
/** Shared in-flight onset renders so parallel warmers/hooks never double-detect. */
const warpOnsetPromises = new Map<string, Promise<number[]>>();
function warpOnsetKey(bufferId: string, sourceChannel?: number): string {
  return `${bufferId}:channel-${Number.isSafeInteger(sourceChannel) && sourceChannel! >= 0 ? sourceChannel : "all"}`;
}

function sameRecordingInputDevices(a: RecordingInputDevice[], b: RecordingInputDevice[]): boolean {
  return (
    a.length === b.length &&
    a.every((device, index) => device.deviceId === b[index].deviceId && device.label === b[index].label)
  );
}

function formatCaptureRate(sampleRate: number): string {
  return `${Number.isInteger(sampleRate / 1_000) ? sampleRate / 1_000 : (sampleRate / 1_000).toFixed(1)} kHz`;
}

function formatChannelRange(range: NonNullable<PcmCaptureInfo["supportedChannelCount"]>): string {
  const { min, max } = range;
  if (min !== null && max !== null) return min === max ? String(min) : `${min}–${max}`;
  if (max !== null) return `up to ${max}`;
  if (min !== null) return `at least ${min}`;
  return "unspecified";
}

function createRecordingTakeId(prefix: string): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}-${crypto.randomUUID()}`;
    }
  } catch {
    // Fall through to a collision-resistant local identifier.
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Parse `#rrggbb` (or `#rgb`) into [r, g, b]; null when unparseable. */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^\s*#([0-9a-f]{6}|[0-9a-f]{3})\s*$/i.exec(hex);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  const int = parseInt(h, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

/**
 * Transient times for a buffer, shared across warmers and waveform hooks:
 * cache hit resolves immediately, otherwise detection runs once (worker for
 * long samples) and every waiter resolves from the same promise.
 */
function getWarpOnsets(
  bank: { get(bufferId: string): AudioBuffer | null | undefined },
  bufferId: string,
  sourceChannel?: number,
): Promise<number[]> | null {
  const key = warpOnsetKey(bufferId, sourceChannel);
  const cached = warpOnsetCache.get(key);
  if (cached) return Promise.resolve(cached);
  const inflight = warpOnsetPromises.get(key);
  if (inflight) return inflight;
  const buf = bank.get(bufferId);
  if (!buf || !(buf.duration > 0) || buf.duration > 600) return null;
  warpOnsetInflight.add(key);
  const p = detectTransientsAsync(audioClipChannelData(buf, sourceChannel), buf.sampleRate).then(
    (times) => {
      warpOnsetCache.set(key, times);
      // FIFO bound (Map preserves insertion order), mirroring the engine's
      // STRETCH_CACHE_LIMIT discipline: a long session importing many samples
      // must not grow this map forever.
      while (warpOnsetCache.size > WARP_ONSET_CACHE_LIMIT) {
        const oldest = warpOnsetCache.keys().next().value;
        if (oldest === undefined) break;
        warpOnsetCache.delete(oldest);
      }
      warpOnsetPromises.delete(key);
      warpOnsetInflight.delete(key);
      return times;
    },
    () => {
      warpOnsetPromises.delete(key);
      warpOnsetInflight.delete(key);
      return [];
    },
  );
  warpOnsetPromises.set(key, p);
  return p;
}
const TRANSITION_TYPES: ArrangementTransitionType[] = ["fill", "riser", "impact", "drop", "break", "custom"];

interface DragState {
  mode: "move" | "resize" | "trimStart";
  clipId: string;
  /**
   * The pointer this gesture captured. Terminals read it from here rather than
   * from the releasing event, because a `pointerup` can carry a different
   * `pointerId` than the one capture was taken on, and releasing the wrong id
   * silently leaves the capture on the element.
   */
  pointerId: number;
  origStart: number;
  origLength: number;
  grabBar: number;
  /**
   * px-per-bar captured when the gesture began. A live gesture must convert
   * pixels to bars in ONE unit system: `grabBar` and every subsequent `bar`
   * have to share a divisor, or the delta is a difference of two scales and
   * the clip lands where the pointer never was. The Ctrl+wheel handler is live
   * during a drag, so `barWidth` can change mid-gesture.
   */
  barWidth: number;
  /** Multi-select move: every selected clip id + its start when the drag began. */
  movingIds?: string[];
  origStarts?: Record<string, number>;
  /**
   * §29: a block move writes the document by hand, so it never reaches
   * `assertClipEditable` the way the single-clip drag does — the lock has to
   * be captured here, at pointerdown, and enforced by the commit. Sampled
   * once for the whole gesture (like `barWidth`): the lock state belongs to
   * the gesture, and re-reading it per pointermove would let a mid-drag lock
   * flip the preview and the commit apart.
   */
  movingHasLocked?: boolean;
  /** Cross-lane group drag state shared with MIDI and automation lanes. */
  groupId?: string;
  groupClipIds?: string[];
  groupHasScene?: boolean;
  groupDeltaTicks?: number;
}

/**
 * Grid cells the UNMEASURED fallback will build. The windowed path renders only
 * what the viewport shows; this one runs before the first measurement and
 * exists so that frame is never empty. It must therefore stay a number the
 * browser can allocate, whatever the document claims.
 *
 * This budget bounds NODE COUNT ONLY. It used to bound the timeline's extent
 * as well, and that made every clip past bar 512 unreachable: the lane's
 * scrollable width stopped there, the browser clamped `scrollLeft` to
 * `scrollWidth - clientWidth`, and the clips were filtered out of the DOM as
 * well — so they could be neither seen, selected nor edited. The extent has its
 * own ceiling below; this one only decides how many grid cells one frame
 * allocates.
 */
const UNMEASURED_GRID_BAR_CAP = 512;

/**
 * Ruler marks (one per 4 bars) the ruler allocates. The ruler is a SIBLING of
 * the lane and is NOT windowed, so its node count follows the timeline's
 * extent. 4096 bars = 1024 marks, which covers any real arrangement while
 * keeping a pathological document from turning every pointermove into a
 * thousand-node reconciliation.
 */
const RULER_MARK_BAR_BUDGET = 4096;

/**
 * The furthest bar the timeline extent may reach.
 *
 * This is a PIXEL budget, not a musical one: the lane's width is
 * `extent × BASE_BAR_WIDTH × zoom`, and at the maximum zoom (40 → 1200 px per
 * bar) 16384 bars is 19.7 Mpx — inside the ~33.5 Mpx element ceiling every
 * browser enforces. 16384 bars in 4/4 is about 11.6 hours of music, far
 * beyond the `MAX_ARRANGEMENT_CLIP_BARS` (8192) the document model already
 * treats as the outer edge of a real arrangement, so no legal song can reach
 * this ceiling.
 */
const MAX_TIMELINE_BARS = 16384;

/**
 * Timeline extent in bars: the furthest bar any clip reaches, plus 4 bars of
 * tail, floored at 16.
 *
 * Non-finite contributions are dropped rather than clamped into range. A clip
 * whose position is NaN has no position to clamp, and inventing one (0) would
 * drag the whole timeline to bar 0; an absurd FINITE position is a real
 * distance, so it is capped — which shortens the ruler's tail, not the song.
 *
 * The extent is the TIMELINE's reach, not a rendering budget: it decides how
 * wide the scrollable lane is, and therefore how far the user can scroll. A
 * clip that exists in the document must be scrollable to, or it is content the
 * editor cannot reach.
 */
function timelineExtentBars(
  clips: readonly Pick<ArrangementClip, "startBar" | "lengthBars">[],
  audioClips: readonly Pick<AudioClip, "startBar" | "lengthBars">[],
  midiClips: readonly Pick<MidiClip, "startTick" | "lengthTicks">[],
  automationClips: readonly Pick<ArrangementAutomationClip, "startTick" | "lengthTicks">[],
  /** The document's bar length in ticks (ADR 0056) — tick-based clips are read in the document's meter. */
  barUnitTicks: number,
): number {
  let extent = 16;
  for (const list of [clips, audioClips]) {
    for (const clip of list) {
      const end = clip.startBar + clip.lengthBars + 4;
      if (!Number.isFinite(end)) continue;
      if (end > extent) extent = end;
    }
  }
  for (const clip of midiClips) {
    const end = (clip.startTick + clip.lengthTicks) / barUnitTicks + 4;
    if (!Number.isFinite(end)) continue;
    if (end > extent) extent = end;
  }
  for (const clip of automationClips) {
    const end = (clip.startTick + clip.lengthTicks) / barUnitTicks + 4;
    if (!Number.isFinite(end)) continue;
    if (end > extent) extent = end;
  }
  return Math.min(MAX_TIMELINE_BARS, Math.max(16, Math.ceil(extent)));
}

/**
 * Release pointer capture without ever throwing.
 *
 * `releasePointerCapture` throws `NotFoundError` when the element is not
 * capturing that pointer, which is a normal state here: the HTML spec releases
 * capture implicitly on `pointerup`/`pointercancel`, and a gesture that was
 * cancelled or lost its capture can reach a terminal with nothing to release.
 * A terminal that throws is a terminal that can abort its own cleanup.
 *
 * This is the single safe shape for all four drag terminals; the lane and
 * ruler handlers already wrap their calls in `try/catch` for the same reason.
 */
function releasePointerCaptureSafely(target: EventTarget | null | undefined, pointerId: number | undefined): void {
  if (!target || pointerId === undefined) return;
  const release = (target as Element).releasePointerCapture;
  if (typeof release !== "function") return;
  try {
    release.call(target, pointerId);
  } catch {
    /* not capturing that pointer (already released, or never captured) */
  }
}

interface TransitionBoundary {
  fromClipId: string;
  toClipId: string;
}

interface TransitionDraft {
  type: ArrangementTransitionType;
  lengthBars: number;
  cueAssetId: string;
}

interface AudioTakeLaneRange {
  groupId: string;
  sourceTakeId: string;
  startTick: number;
  endTick: number;
}

interface AudioTakeLaneDrag extends AudioTakeLaneRange {
  pointerId: number;
  currentTick: number;
  anchorClientX: number;
  moved: boolean;
  /**
   * Lane geometry CAPTURED at pointerdown (px width + px/bar). Ctrl+wheel can
   * zoom mid-gesture and re-render the lane at a different barWidth —
   * converting the live pointer against the NEW geometry teleports the range
   * (same pixel, different tick). Same discipline as DragState.barWidth and
   * audioDragRef.barWidth.
   */
  geometry: { width: number; barWidthAt: number };
}

interface AudioTakeAudition {
  groupId: string;
  takeId: string;
  state: "rendering" | "playing" | "live";
}

interface AudioTakeAuditionRequest extends AudioTakeAudition {
  controller: AbortController;
}

/**
 * AUDIT 17: which loop bounds are legitimate audio-clip snap targets.
 *
 * `Transport.setLoop` keeps `end === 0` on purpose — it is the sentinel for
 * "loop to the end of the current content", which `Scheduler.resolveLoopEnd`
 * expands. It is NOT tick 0. Pushing it as a snap target made every dragged
 * audio clip jump to the top of the arrangement as soon as the loop was
 * enabled without an explicit end.
 *
 * Exported so the rule is testable without reproducing a full pointer drag.
 */
export function loopSnapTargetBars(
  loopEnabled: boolean,
  loopStart: number,
  loopEnd: number,
  /** The document's bar length in ticks (ADR 0056). */
  barUnitTicks: number,
): number[] {
  if (!loopEnabled) return [];
  const targets = [loopStart / barUnitTicks];
  if (loopEnd > 0) targets.push(loopEnd / barUnitTicks);
  return targets;
}

export function ArrangementPanel() {
  const services = useServices();
  const shortcutHints = useShortcutHints();
  // Fine-grained selectors (GOAL 04): ArrangementPanel reads scenes, the
  // arrangement (clips, audioClips, transitions), tracks, markers, patterns
  // and the active pattern id. Subscribing to the whole document via
  // `useDoc()` re-renders this whole panel on every unrelated mutation
  // (a track-mute, a marker add, an automation-point move). With structural
  // sharing in `normalizeProject`, the slices we actually read keep their
  // array identity across most edits, so a fine-grained `useSyncExternalStore`
  // subscription skips the re-render.
  const scenes = useScenes();
  const arrangement = useArrangement();
  const tracks = useTracks();
  const markers = useMarkers();
  const patterns = usePatterns();
  const activePatternId = useActivePatternId();
  const groupDragPreview = useTimelineGroupDragPreview();
  // `doc` is still needed for the BPM scalar, the project id, and command
  // arguments. It's a plain getter (no React subscription).
  const doc = services.store.getDoc();
  // The document's bar length in ticks (ADR 0056). The arrangement lane's pixel
  // grid is one MUSICAL bar wide, so every tick↔pixel and tick↔bar conversion
  // uses this unit — otherwise a 6/8 project's clips sit a quarter-bar off the
  // drawn bar lines.
  const barUnit = ticksPerBar(doc);
  const projectBpm = useSyncExternalStore(
    services.store.subscribe,
    () => services.store.getDoc().bpm,
    () => services.store.getDoc().bpm,
  );
  const capture = useArrangementCapture();
  const [selectedSceneId, setSelectedSceneId] = useState(scenes[0]?.id ?? "");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [rulerMode, setRulerMode] = useState<"bars" | "seconds">("bars");
  const [showIntensity, setShowIntensity] = useState(true);
  // Arrangement zoom: px per bar = BASE_BAR_WIDTH * zoom. Ctrl+wheel zooms
  // around the cursor, −/+ step, FIT squeezes the whole song into the view.
  const [zoom, setZoom] = useState(1);
  const barWidth = BASE_BAR_WIDTH * zoom;
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const zoomAnchorRef = useRef<{ tick: number; cursorX: number } | null>(null);
  zoomRef.current = zoom;
  /**
   * The document's bar length in ticks, in a REF.
   *
   * The Ctrl+wheel listener below is registered once (a native, non-passive
   * listener cannot be re-registered per render without dropping the gesture),
   * so it must not close over a render-scope value. It used to close over
   * `barUnit`, which is `ticksPerBar(doc)` — so after the document's meter
   * changed (ADR 0057) the anchor computed its tick with the OLD bar length
   * while the lanes drew with the NEW one, and every Ctrl+wheel zoom jumped
   * to the wrong place.
   */
  const barUnitRef = useRef(barUnit);
  barUnitRef.current = barUnit;
  /**
   * The bar range the lane is actually showing. `null` means "never measured"
   * and renders the whole song — the safe direction, because an unmeasured
   * window must never mean "nothing renders".
   *
   * The range is QUANTIZED, so the panel does not re-render at pixel frequency:
   * `scrollLeft` changes on every pixel of a wheel event, and storing the raw
   * value would trade an O(n) render for an O(1) one plus a re-render per
   * pixel.
   *
   * The quantum is in PIXELS, not in bars (performance-cliff audit C-2). A bar
   * is 1.5 px at min zoom and 1200 px at max zoom, so a bar quantum cost up to
   * 800× more renders per pixel of scroll when the user zoomed out to survey
   * the song — and each of those renders paid the arrangement's super-linear
   * per-clip cost. The pixel quantum makes the commit cadence zoom-independent;
   * `src/ui/arrangement/viewport.ts` owns the decision and the margin that
   * keeps the visible area rendered while a commit is deferred.
   */
  const [viewport, setViewport] = useState<ArrangementViewport | null>(null);
  const viewportCommitRef = useRef<CommittedViewport | null>(null);
  const measureViewport = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const width = el.clientWidth;
    // No layout (jsdom, or a hidden panel) — keep whatever we already had
    // rather than collapsing the window to "nothing is visible".
    if (width <= 0) return;
    const pxPerBar = BASE_BAR_WIDTH * zoomRef.current;
    if (pxPerBar <= 0) return;
    const decision = viewportDecision({
      scrollLeft: el.scrollLeft,
      width,
      pxPerBar,
      overscanBars: VIEWPORT_OVERSCAN_BARS,
      quantumPx: VIEWPORT_COMMIT_QUANTUM_PX,
      committed: viewportCommitRef.current,
    });
    viewportCommitRef.current = decision.committed;
    if (!decision.changed) return;
    setViewport(decision.viewport);
  }, []);
  const [showSkeletonPreview, setShowSkeletonPreview] = useState(false);
  const [autoArrangeMinutes, setAutoArrangeMinutes] = useState(3);
  const autoArrangeTargetBars = Math.max(
    7,
    Math.round(sceneSecondsToBars(autoArrangeMinutes * 60, projectBpm, ticksPerBar(doc))),
  );
  const autoArrangeEstimatedSeconds = sceneBarsToSeconds(autoArrangeTargetBars, projectBpm, ticksPerBar(doc));
  const autoArrangeRoundedSeconds = Math.round(autoArrangeEstimatedSeconds);
  const autoArrangeDuration = `${Math.floor(autoArrangeRoundedSeconds / 60)}:${String(autoArrangeRoundedSeconds % 60).padStart(2, "0")}`;
  const [transitionBoundary, setTransitionBoundary] = useState<TransitionBoundary | null>(null);
  const [transitionDraft, setTransitionDraft] = useState<TransitionDraft>({
    type: "custom",
    lengthBars: 1,
    cueAssetId: "",
  });
  const [actionError, setActionError] = useState<string | null>(null);
  // App-level shortcuts that edit this panel's clips (Ctrl+E split at
  // playhead) surface their failures here — the error strip renders next to
  // the clips the user is editing, instead of a silent catch.
  useEffect(() => {
    const onError = (event: Event): void => {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail === "string" && detail !== "") setActionError(detail);
    };
    window.addEventListener("pf-arrangement-action-error", onError);
    return () => window.removeEventListener("pf-arrangement-action-error", onError);
  }, []);
  // Clip multi-select: marquee on empty-lane drag, ctrl/shift+click toggles.
  // The ids live in the shared SelectionStore — keyboard Delete, the P
  // (locators to selection) shortcut and the context menu already read them.
  const [marquee, setMarquee] = useState<{ from: number; to: number } | null>(null);
  const marqueeStartRef = useRef<number | null>(null);
  const [multiDrag, setMultiDrag] = useState<number | null>(null);
  const [deleteToast, setDeleteToast] = useState<{ label: string } | null>(null);
  // SCENE SECS authoring (VISION §10): type a wall-clock duration for the
  // selected clip — committed as whole bars at the clip's effective tempo.
  const [secsDraft, setSecsDraft] = useState<string | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<{ startBar: number; lengthBars: number } | null>(null);
  // Live drag position mirrored out of state (audit 16).
  //
  // `pointermove` is a CONTINUOUS event in React 18: its setState is scheduled
  // at ContinuousEventPriority and flushed from a Scheduler macrotask, not
  // synchronously at the end of the event. A fast flick can release before the
  // last move commits, and `onClipPointerUp` — a DISCRETE handler — would then
  // read the PREVIOUS render's `drag`/`multiDrag` and commit a bar the pointer
  // never reached. The refs are the authority at release time; state stays the
  // render source for the live preview. Same reasoning the warp-pin drag below
  // already documents, and the shape `PianoRoll` already uses (dragRef deltas).
  const dragLiveRef = useRef<{ startBar: number; lengthBars: number } | null>(null);
  const multiDragLiveRef = useRef<number | null>(null);
  /** Record the live clip-drag position in BOTH the ref and state. */
  const setClipDrag = (next: { startBar: number; lengthBars: number } | null) => {
    dragLiveRef.current = next;
    setDrag(next);
  };
  const setClipMultiDrag = (next: number | null) => {
    multiDragLiveRef.current = next;
    setMultiDrag(next);
  };
  // Window fallback for gestures whose captured element unmounts mid-drag
  // (undo/collab delete): the element's own pointerup never fires. Handlers
  // are wired to the global terminator below, once both exist.
  const dragGuard = usePointerDragGuard();
  const selection = useSelection();
  const selectionStore = useSelectionStore();
  const [timeDrag, setTimeDrag] = useState<{ startBar: number; currentBar: number } | null>(null);
  const runtime = useSceneRuntimeState();
  const [selectedAudioClipId, setSelectedAudioClipId] = useState<string | null>(null);
  const [showAudioTakeLanes, setShowAudioTakeLanes] = useState(false);
  const [compCrossfadeTicks, setCompCrossfadeTicks] = useState(120);
  const [audioTakeLaneRange, setAudioTakeLaneRange] = useState<AudioTakeLaneRange | null>(null);
  const audioTakeLaneDragRef = useRef<AudioTakeLaneDrag | null>(null);
  /**
   * Bumped by the global gesture terminator (Escape / window blur) so the
   * overlay drags that live in CHILD components — warp pins and scene
   * intensity points — learn a cancel happened. They own their own refs and
   * this panel cannot reach into them, so a monotonically increasing token is
   * the contract: each child resets its drag when the token changes.
   */
  const [overlayCancelEpoch, setOverlayCancelEpoch] = useState(0);
  const suppressTakeLaneClickRef = useRef(false);
  const [audioTakeAudition, setAudioTakeAudition] = useState<AudioTakeAudition | null>(null);
  const audioTakeAuditionRef = useRef<AudioTakeAuditionRequest | null>(null);
  /**
   * SMART COMP preview state. The plan is computed on demand (it measures
   * real PCM), held here while the producer reads the evidence, and applied
   * as ONE undoable command — the source takes are never touched until then.
   */
  const [smartCompPlan, setSmartCompPlan] = useState<SmartCompPlan | null>(null);
  const [smartCompBusy, setSmartCompBusy] = useState(false);
  const selectedAudioClip = (arrangement.audioClips ?? []).find((clip) => clip.id === selectedAudioClipId) ?? null;
  const selectedAudioTakeGroup = selectedAudioClip?.takeGroupId
    ? arrangement.takeGroups?.find((group) => group.id === selectedAudioClip.takeGroupId)
    : undefined;
  const selectedAudioTakeIds = selectedAudioTakeGroup
    ? Array.from(
        new Set(
          (arrangement.audioClips ?? [])
            .filter(
              (clip) =>
                clip.takeGroupId === selectedAudioTakeGroup.id &&
                clip.takeId &&
                clip.takeId !== selectedAudioTakeGroup.compTakeId,
            )
            .map((clip) => clip.takeId!),
        ),
      )
    : [];
  useEffect(() => {
    setAudioTakeLaneRange(null);
    audioTakeLaneDragRef.current = null;
    suppressTakeLaneClickRef.current = false;
  }, [selectedAudioTakeGroup?.id, showAudioTakeLanes]);
  // ── Timeline recording: arm a track, REC an audio input straight into the song ──
  const [armedTrackId, setArmedTrackId] = useState<string>("");
  const [armedSecondTrackId, setArmedSecondTrackId] = useState<string>("");
  const [armedAdditionalTrackIds, setArmedAdditionalTrackIds] = useState<string[]>([]);
  const [independentInputRoutes, setIndependentInputRoutes] = useState<
    Array<{ trackId: string; deviceId: string; monitoring: boolean }>
  >([]);
  const [requestedChannelCount, setRequestedChannelCount] = useState<number | null>(null);
  const [recordingTakeGroupSelection, setRecordingTakeGroupSelection] = useState("");
  const [loopTakeCapture, setLoopTakeCapture] = useState(false);
  const [punchCapture, setPunchCapture] = useState(false);
  const recordingTakeGroups = (arrangement.takeGroups ?? []).filter((group) => group.trackId === armedTrackId);
  const recordingTakeMode =
    recordingTakeGroupSelection === "new" ||
    recordingTakeGroups.some((group) => group.id === recordingTakeGroupSelection)
      ? recordingTakeGroupSelection
      : "";
  const [recState, setRecState] = useState<"idle" | "starting" | "recording" | "saving">("idle");
  const [recSeconds, setRecSeconds] = useState(0);
  const [micMonitoring, setMicMonitoring] = useState(false);
  const [recordingInputDeviceId, setRecordingInputDeviceId] = useState(loadRecordingInputDeviceId);
  const [recordingInputDevices, setRecordingInputDevices] = useState<RecordingInputDevice[]>([]);
  const [recordingInputListError, setRecordingInputListError] = useState(false);
  const independentInputTrackIds = [armedTrackId, ...independentInputRoutes.map((route) => route.trackId)];
  const independentInputDeviceIds = [recordingInputDeviceId, ...independentInputRoutes.map((route) => route.deviceId)];
  const independentInputReady =
    independentInputRoutes.length === 0 ||
    (independentInputTrackIds.every(Boolean) &&
      independentInputDeviceIds.every(Boolean) &&
      new Set(independentInputTrackIds).size === independentInputTrackIds.length &&
      new Set(independentInputDeviceIds).size === independentInputDeviceIds.length);
  const [lastCaptureInfo, setLastCaptureInfo] = useState<PcmCaptureInfo | null>(null);
  const routingChannelCount = Math.min(8, requestedChannelCount ?? lastCaptureInfo?.capturedChannels ?? 2);
  // Publish the recording-adjacent axes to the global session state surface
  // (footer indicator) — other views must see what is armed/hot. Publish
  // merges shallowly and skips no-op notifications.
  useEffect(() => {
    const names = [
      armedTrackId,
      armedSecondTrackId,
      ...armedAdditionalTrackIds,
      ...independentInputRoutes.map((route) => route.trackId),
    ]
      .filter(Boolean)
      .map((id) => doc.tracks.find((t) => t.id === id)?.name ?? "?");
    publishSessionRecordingState({
      armedTrackNames: names,
      recState,
      punchRange: punchCapture
        ? `${(services.transport.loopStart / barUnit).toFixed(1)} → ${(services.transport.loopEnd / barUnit).toFixed(
            1,
          )}`
        : null,
      loopTakes: loopTakeCapture,
      takeModeLabel: recordingTakeMode ? (recordingTakeMode === "new" ? "NEW TAKE GROUP" : "TAKE GROUP") : null,
    });
  }, [
    armedTrackId,
    armedSecondTrackId,
    armedAdditionalTrackIds.join(","),
    independentInputRoutes.map((route) => route.trackId).join(","),
    recState,
    punchCapture,
    loopTakeCapture,
    recordingTakeMode,
    doc.tracks,
  ]);
  // Leaving the arrangement view resets the surface — a stale ARMED chip on a
  // panel that can no longer record would be a lie.
  useEffect(() => {
    return () => publishSessionRecordingState(IDLE_SESSION_STATE);
  }, []);

  const [inputGainDb, setInputGainDb] = useState<number>(() => clampInputGainDb(loadRecordingInputGainDb()));
  /** Live input level (peak 0..1) polled from the recorder while wiring exists. */
  const [micPeak, setMicPeak] = useState(0);
  /** Peak-hold since the last reset — a clip warning that does not blink. */
  const micClippedRef = useRef(false);
  const [micClipped, setMicClipped] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [recStorageWarning, setRecStorageWarning] = useState<string | null>(null);
  /** Post-placement informational line (e.g. "phrase aligned +38 ms"). */
  const [recNotice, setRecNotice] = useState<string | null>(null);
  const recRef = useRef<import("../audio-engine/PcmMicRecorder").PcmMicRecorder | null>(null);
  const recGroupRef = useRef<import("../audio-engine/PcmMicRecorderGroup").PcmMicRecorderGroup | null>(null);
  const recStartPendingRef = useRef(false);
  const recStartAttemptRef = useRef(0);
  const recPanelMountedRef = useRef(true);
  const stoppingRecRef = useRef(false);
  const loopBoundaryUnsubscribeRef = useRef<(() => void) | null>(null);
  const punchBoundaryUnsubscribeRef = useRef<(() => void) | null>(null);
  const recoveryRepoRef = useRef(services.recordingRecovery);
  const [recoverableTakes, setRecoverableTakes] = useState<RecordingSession[]>([]);
  const recoverableTakesRef = useRef<RecordingSession[]>([]);
  const [recoveringTakeId, setRecoveringTakeId] = useState<string | null>(null);
  const sliceAnalysisRef = useRef<AbortController | null>(null);

  const refreshRecordingInputs = useCallback(async (): Promise<void> => {
    try {
      const devices = await listRecordingInputDevices();
      if (recPanelMountedRef.current) {
        setRecordingInputDevices((current) => (sameRecordingInputDevices(current, devices) ? current : devices));
        setRecordingInputListError(false);
      }
    } catch {
      if (recPanelMountedRef.current) setRecordingInputListError(true);
    }
  }, []);

  useEffect(() => {
    let live = true;
    const mediaDevices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    const refresh = async () => {
      try {
        const devices = await listRecordingInputDevices(mediaDevices ?? null);
        if (live) {
          setRecordingInputDevices((current) => (sameRecordingInputDevices(current, devices) ? current : devices));
          setRecordingInputListError(false);
        }
      } catch {
        if (live) setRecordingInputListError(true);
      }
    };
    void refresh();
    mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      live = false;
      mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  // Input meter loop: ~15 Hz poll of the recorder's input analyser while a
  // session is wired (permission prompt onward). Peak-hold flags clipping
  // until the level is reset or the recorder unwires.
  useEffect(() => {
    const wired = recState === "starting" || recState === "recording";
    if (!wired) {
      setMicPeak(0);
      return;
    }
    const timer = setInterval(() => {
      const recorder = recRef.current;
      const group = recGroupRef.current;
      // Feature-detect: the input meter is PcmMicRecorder-specific, and a
      // recorder substitute (test mock, MediaRecorder fallback) may not
      // implement it — a UI poll timer must never throw.
      if (!recorder && !group) {
        setMicPeak(0);
        return;
      }
      const recorders = group ? group.inputIds.map((id) => group.getRecorder(id)).filter(Boolean) : [recorder];
      const peak = recorders.reduce((max, input) => {
        if (!input || typeof input.getInputLevel !== "function") return max;
        return Math.max(max, input.getInputLevel().peak);
      }, 0);
      setMicPeak((prev) => (Math.abs(prev - peak) > 0.01 ? peak : prev));
      if (peak >= 0.99 && !micClippedRef.current) {
        micClippedRef.current = true;
        setMicClipped(true);
      }
    }, 66);
    return () => clearInterval(timer);
  }, [recState]);

  const resetMicClip = () => {
    micClippedRef.current = false;
    setMicClipped(false);
  };

  const changeInputGain = (db: number): void => {
    const clamped = clampInputGainDb(db);
    setInputGainDb(clamped);
    saveRecordingInputGainDb(clamped);
    recRef.current?.setInputGainDb(clamped);
    recGroupRef.current?.setInputGainDb(clamped);
    resetMicClip();
  };

  const publishRecoverableTakes = useCallback((sessions: RecordingSession[]): void => {
    const current = recoverableTakesRef.current;
    const unchanged =
      current.length === sessions.length &&
      current.every(
        (session, index) =>
          session.id === sessions[index].id &&
          session.updatedAt === sessions[index].updatedAt &&
          session.totalFrames === sessions[index].totalFrames,
      );
    if (!unchanged) {
      recoverableTakesRef.current = sessions;
      setRecoverableTakes(sessions);
    }
  }, []);

  const refreshRecoverableTakes = useCallback(async (): Promise<void> => {
    try {
      publishRecoverableTakes(await recoveryRepoRef.current!.listRecoverable(Date.now(), RECORDING_OWNER_ID));
    } catch {
      setRecError("Could not check local recording recovery storage. Your current project is unchanged.");
    }
  }, []);

  useEffect(() => {
    let live = true;
    // One-shot per project open: garbage-collect staging from takes that
    // crashed so long ago no recovery offer is realistic anymore (keeps
    // IndexedDB quota for project saves). Non-fatal — a failed prune
    // retries on the next open.
    void recoveryRepoRef.current!.pruneAncient().catch((error) => {
      console.error("[recording] recovery staging prune failed:", error);
    });
    const refresh = () => {
      void recoveryRepoRef.current!.listRecoverable(Date.now(), RECORDING_OWNER_ID).then(
        (sessions) => {
          if (live) publishRecoverableTakes(sessions);
        },
        () => {
          if (live) setRecError("Could not check local recording recovery storage. Your current project is unchanged.");
        },
      );
    };
    refresh();
    // A take in another tab becomes recoverable after its last committed
    // block goes stale; poll slowly rather than depending on the UI frame loop.
    const timer = setInterval(refresh, 3_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [doc.id, publishRecoverableTakes]);

  // Ctrl+wheel zoom on the arrangement — needs a NON-passive native listener
  // (React 17+ attaches wheel passively at the root, so preventDefault in
  // onWheel is ignored and the browser zooms the page instead).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const tickAtCursor = ((el.scrollLeft + cursorX) / (BASE_BAR_WIDTH * zoomRef.current)) * barUnitRef.current;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomRef.current * Math.exp(-event.deltaY * 0.002)));
      if (next === zoomRef.current) return;
      // Keep the tick under the cursor stable across the zoom.
      zoomAnchorRef.current = { tick: tickAtCursor, cursorX };
      setZoom(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Re-anchor the scroll position after a zoom render.
  useEffect(() => {
    const el = scrollRef.current;
    const anchor = zoomAnchorRef.current;
    if (!el || !anchor) return;
    el.scrollLeft = Math.max(0, (anchor.tick / barUnit) * (BASE_BAR_WIDTH * zoom) - anchor.cursorX);
    zoomAnchorRef.current = null;
  }, [zoom]);

  // Re-measure the window on mount and after every zoom. Declared AFTER the
  // re-anchor effect on purpose: effects run in declaration order, so this one
  // sees the scrollLeft that zoom just set instead of the pre-zoom value.
  // Assigning scrollLeft fires a scroll event in the browser, which would
  // eventually correct the window anyway — but relying on that is how a zoom
  // ends up one render behind.
  useEffect(() => {
    measureViewport();
  }, [measureViewport, zoom]);

  // A PANE RESIZE changes the visible bar range without any scroll or zoom.
  //
  // The window was only re-measured on mount, on zoom and on scroll — so
  // widening the arrangement pane left the new right-hand part of the
  // timeline BLANK: the windowing filter still cut at the old `lastBar`, and
  // the clips now inside the viewport were not rendered until the next scroll
  // event. Narrowing it left the opposite (extra DOM, no wrong geometry).
  //
  // `ResizeObserver` is absent in jsdom and in older browsers; the guard
  // keeps the panel working without it (the scroll/zoom paths still measure).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureViewport());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measureViewport]);

  // Actionable delete toast — dismisses itself; UNDO stays available while shown.
  useEffect(() => {
    if (!deleteToast) return;
    const id = setTimeout(() => setDeleteToast(null), 6000);
    return () => clearTimeout(id);
  }, [deleteToast]);

  // A recorder left running at unmount (panel switch, project close) would
  // keep the audio-input stream and its chunk buffer alive forever.
  useEffect(() => {
    recPanelMountedRef.current = true;
    return () => {
      recPanelMountedRef.current = false;
      recStartAttemptRef.current++;
      recStartPendingRef.current = false;
      const recorder = recRef.current;
      recRef.current = null;
      const group = recGroupRef.current;
      recGroupRef.current = null;
      loopBoundaryUnsubscribeRef.current?.();
      loopBoundaryUnsubscribeRef.current = null;
      punchBoundaryUnsubscribeRef.current?.();
      punchBoundaryUnsubscribeRef.current = null;
      if (recorder) {
        recorder.onError = null;
        recorder.onPunchOut = null;
        void recorder.cancel();
      }
      if (group) void group.cancel();
      sliceAnalysisRef.current?.abort();
      sliceAnalysisRef.current = null;
    };
  }, []);

  const cancelRecStart = () => {
    if (recState !== "starting") return;
    const recorder = recRef.current;
    const group = recGroupRef.current;
    recStartAttemptRef.current++;
    recStartPendingRef.current = false;
    if (recorder) {
      if (recRef.current === recorder) recRef.current = null;
      recorder.onError = null;
      recorder.onPunchOut = null;
      void recorder.cancel();
    }
    if (group) {
      if (recGroupRef.current === group) recGroupRef.current = null;
      void group.cancel();
    }
    setRecState("idle");
    setRecError(null);
  };

  const startRec = async () => {
    if (!armedTrackId || recState !== "idle" || recRef.current || recGroupRef.current || recStartPendingRef.current)
      return;
    recStartPendingRef.current = true;
    const attempt = ++recStartAttemptRef.current;
    setRecState("starting");
    setRecError(null);
    setRecNotice(null);
    setRecStorageWarning(null);
    setLastCaptureInfo(null);
    let recorder: import("../audio-engine/PcmMicRecorder").PcmMicRecorder | null = null;
    let recorderGroup: import("../audio-engine/PcmMicRecorderGroup").PcmMicRecorderGroup | null = null;
    try {
      if (independentInputRoutes.length > 0) {
        if (!independentInputReady) {
          throw new Error("Choose a different track and explicit audio input for every independent stream");
        }
        if (loopTakeCapture || punchCapture || recordingTakeMode) {
          throw new Error(
            "Independent input groups currently record standalone takes; turn off loop, punch and alternate takes",
          );
        }
        if (armedSecondTrackId || armedAdditionalTrackIds.some(Boolean)) {
          throw new Error("Clear the split-channel routes before arming independent input streams");
        }
        const mediaDevices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
        const getUserMedia = mediaDevices?.getUserMedia?.bind(mediaDevices);
        if (!getUserMedia) throw new Error("Independent input streams need browser audio-input support");
        services.engine.ensureContext();
        const ctx = services.engine.getLiveAudioContext();
        if (!ctx) throw new Error("Audio engine is not ready");
        const [nativeBridge, { PcmMicRecorderGroup }] = await Promise.all([
          import("../audio-engine/windowsAudioIoBridge"),
          import("../audio-engine/PcmMicRecorderGroup"),
        ]);
        if (!recPanelMountedRef.current || attempt !== recStartAttemptRef.current) return;
        if (nativeBridge.getWindowsAudioIoEngineConnection(services.engine)) {
          throw new Error(
            "The active native WASAPI session owns one capture endpoint. Stop it before opening separate browser input streams.",
          );
        }
        const routes = [
          { trackId: armedTrackId, deviceId: recordingInputDeviceId, monitoring: micMonitoring },
          ...independentInputRoutes,
        ];
        const currentDoc = services.store.doc;
        const leadInTicks = services.transport.leadInTicks();
        const leadInWillApply =
          !services.transport.playing &&
          !services.transport.paused &&
          leadInTicks > 0 &&
          services.transport.position >= leadInTicks;
        recorderGroup = new PcmMicRecorderGroup(
          routes.map((route) => ({
            id: route.trackId,
            dependencies: {
              ctx,
              recovery: recoveryRepoRef.current!,
              inputDeviceId: route.deviceId,
              getUserMedia,
              inputGainDb,
              ...(requestedChannelCount !== null ? { requestedChannelCount } : {}),
              routeMonitorOutput: (monitorOutput) =>
                services.engine.attachDryInputMonitor(route.trackId, monitorOutput),
              refreshStartBar: (scheduledStartDelaySec = 0) => {
                const ticks =
                  services.transport.position +
                  (services.transport.playing ? scheduledStartDelaySec / services.transport.secondsPerTick : 0);
                return Number.isFinite(ticks) && ticks >= 0 ? recordingStartBar(ticks, ticksPerBar(doc)) : null;
              },
            },
            getMetadata: () => {
              const latestDoc = services.store.doc;
              const track = latestDoc.tracks.find((item) => item.id === route.trackId);
              if (!track || latestDoc.id !== currentDoc.id) return null;
              const ticks = services.transport.position;
              return {
                projectId: latestDoc.id,
                trackId: track.id,
                trackName: track.name,
                placeOnTimeline: true,
                startBar: recordingStartBar(ticks, ticksPerBar(latestDoc)),
                bpm: latestDoc.bpm,
                recordingInputOffsetMs: recordingAlignment.getSnapshot(),
                leadInSec: leadInWillApply ? leadInTicks * services.transport.secondsPerTick : 0,
              };
            },
          })),
        );
        for (const route of routes) recorderGroup.setInputMonitoring(route.trackId, route.monitoring);
        recGroupRef.current = recorderGroup;
        recorderGroup.onFailure = (inputId, message, results) => {
          if (recGroupRef.current !== recorderGroup || stoppingRecRef.current) return;
          const trackName = services.store.doc.tracks.find((track) => track.id === inputId)?.name ?? inputId;
          const recoverableCount = results.filter((result) => result.take).length;
          recGroupRef.current = null;
          stoppingRecRef.current = false;
          if (recPanelMountedRef.current) {
            setRecError(
              `${trackName} input failed: ${message}. All streams stopped; ${recoverableCount} take(s) are available for recovery.`,
            );
            setRecState("idle");
            void refreshRecoverableTakes();
          }
        };
        await recorderGroup.start();
        if (
          !recPanelMountedRef.current ||
          attempt !== recStartAttemptRef.current ||
          recGroupRef.current !== recorderGroup
        ) {
          void recorderGroup.cancel();
          return;
        }
        setRecSeconds(0);
        setLastCaptureInfo(recorderGroup.getRecorder(armedTrackId)?.captureInfo ?? null);
        setRecState("recording");
        notifyOnboardingProgress("recorded");
        void refreshRecordingInputs();
        if (!services.transport.playing) services.playback.playPause();
        return;
      }
      if (loopTakeCapture && !services.transport.loopEnabled) {
        throw new Error("Enable the transport loop and set its locators before recording loop passes");
      }
      if (punchCapture && services.transport.playing) {
        throw new Error("Stop playback before arming a punch; REC will start from the punch-in locator");
      }
      if (punchCapture && services.transport.loopEnabled) {
        throw new Error("Turn LOOP off for a single punch pass; punch uses the transport start/end locators");
      }
      if (
        punchCapture &&
        (services.transport.loopEnd <= services.transport.loopStart || services.transport.loopStart < 0)
      ) {
        throw new Error("Set valid transport start and end locators before recording a punch");
      }
      if (punchCapture && (loopTakeCapture || recordingTakeMode)) {
        throw new Error("Punch recording currently uses one take at a time; turn off loop passes and take groups");
      }
      if (loopTakeCapture && services.transport.loopEnd <= services.transport.loopStart) {
        throw new Error("Set an explicit loop end locator before recording loop passes");
      }
      if (loopTakeCapture && armedSecondTrackId) {
        throw new Error("Loop take groups record one stereo track at a time. Set CH 2 to keep stereo.");
      }
      if (loopTakeCapture && armedAdditionalTrackIds.some(Boolean)) {
        throw new Error("Loop take groups record one track at a time. Turn off extra input-channel routing first.");
      }
      if (recordingTakeMode && armedSecondTrackId) {
        throw new Error("Take groups record one stereo track at a time. Set CH 2 to keep stereo, then record again.");
      }
      if (recordingTakeMode && armedAdditionalTrackIds.some(Boolean)) {
        throw new Error("Take groups record one track at a time. Turn off extra input-channel routing first.");
      }
      if ((loopTakeCapture || recordingTakeMode) && (requestedChannelCount ?? 0) > 2) {
        throw new Error("Loop and alternate-take capture currently support at most two input channels per take");
      }
      if (requestedChannelCount !== null && requestedChannelCount > 2) {
        const routedTrackIds = [armedTrackId, armedSecondTrackId, ...armedAdditionalTrackIds].slice(
          0,
          requestedChannelCount,
        );
        if (
          routedTrackIds.length !== requestedChannelCount ||
          routedTrackIds.some((trackId) => !trackId) ||
          new Set(routedTrackIds).size !== requestedChannelCount
        ) {
          throw new Error(
            `Assign each of the ${requestedChannelCount} requested input channels to a different track before recording`,
          );
        }
      }
      const loopTakeLocators = loopTakeCapture
        ? { start: services.transport.loopStart, end: services.transport.loopEnd }
        : null;
      const punchLocators = punchCapture
        ? { start: services.transport.loopStart, end: services.transport.loopEnd }
        : null;
      const takeGroupId = loopTakeCapture
        ? recordingTakeMode && recordingTakeMode !== "new"
          ? recordingTakeMode
          : createRecordingTakeId("take-group")
        : recordingTakeMode === "new"
          ? createRecordingTakeId("take-group")
          : recordingTakeMode || undefined;
      const takeId = takeGroupId ? createRecordingTakeId("take") : undefined;
      let takeAnchorApplied = false;
      let punchSuppressLeadIn = false;
      let punchLeadInTicks = 0;
      services.engine.ensureContext();
      const ctx = services.engine.getLiveAudioContext();
      if (!ctx) throw new Error("Audio engine is not ready");
      // Load the PCM capture engine only when the user starts an audio take.
      const { PcmMicRecorder } = await import("../audio-engine/PcmMicRecorder");
      // The component may have unmounted while the lazy module was loading.
      if (!recPanelMountedRef.current || attempt !== recStartAttemptRef.current) return;
      const splitMonitorChannels = Boolean(armedSecondTrackId) || (requestedChannelCount ?? 0) > 2;
      const monitorChannelCount = splitMonitorChannels ? (requestedChannelCount ?? 2) : 1;
      const monitorTrackIds = [armedTrackId, armedSecondTrackId, ...armedAdditionalTrackIds].slice(
        0,
        monitorChannelCount,
      );
      recorder = new PcmMicRecorder({
        ctx,
        recovery: recoveryRepoRef.current!,
        inputDeviceId: recordingInputDeviceId,
        inputGainDb,
        ...(splitMonitorChannels ? { monitorChannelCount } : {}),
        routeMonitorOutput: (monitorOutput, channelIndex) => {
          const destinationTrackId = splitMonitorChannels ? monitorTrackIds[channelIndex] : armedTrackId;
          return destinationTrackId ? services.engine.attachDryInputMonitor(destinationTrackId, monitorOutput) : null;
        },
        // Overdub anchor: re-read the transport position immediately before
        // capture arms. The metadata snapshot predates the durable session
        // begin commit; while the transport is rolling, that IndexedDB gap
        // would land on the timeline as a per-take start-offset error.
        refreshStartBar: () => {
          const ticks = punchLocators?.start ?? services.transport.position;
          return Number.isFinite(ticks) && ticks >= 0 ? recordingStartBar(ticks, ticksPerBar(doc)) : null;
        },
        ...(requestedChannelCount !== null ? { requestedChannelCount } : {}),
      });
      // Publish ownership before the permission prompt/async start so an
      // unmount or a second REC action can cancel this exact pending take.
      recRef.current = recorder;
      recorder.setMonitoring(micMonitoring);
      const startPromise = recorder.start(() => {
        const currentDoc = services.store.doc;
        const track = currentDoc.tracks.find((item) => item.id === armedTrackId);
        if (!track) return null;
        if (
          loopTakeLocators &&
          (services.transport.loopStart !== loopTakeLocators.start ||
            services.transport.loopEnd !== loopTakeLocators.end)
        ) {
          throw new Error("Transport loop locators changed while the audio input was opening; start REC again");
        }
        if (
          punchLocators &&
          (services.transport.loopStart !== punchLocators.start || services.transport.loopEnd !== punchLocators.end)
        ) {
          throw new Error("Punch locators changed while the audio input was opening; start REC again");
        }
        if (punchLocators) {
          const requestedLeadInTicks = services.transport.paused ? 0 : services.transport.leadInTicks();
          const canRollIntoPunch = requestedLeadInTicks > 0 && punchLocators.start >= requestedLeadInTicks;
          punchSuppressLeadIn = requestedLeadInTicks > 0 && !canRollIntoPunch;
          punchLeadInTicks = canRollIntoPunch ? requestedLeadInTicks : 0;
          services.transport.seek(punchLocators.start - punchLeadInTicks);
        }
        if (takeGroupId) {
          if (armedSecondTrackId || armedAdditionalTrackIds.some(Boolean)) return null;
          const group = currentDoc.arrangement.takeGroups?.find((item) => item.id === takeGroupId);
          if (loopTakeCapture) {
            if (recordingTakeMode && recordingTakeMode !== "new" && (!group || group.trackId !== track.id)) return null;
            if (!takeAnchorApplied) {
              const loopStart = services.transport.loopStart;
              if (Math.abs(services.transport.position - loopStart) > 1) {
                if (services.transport.playing) services.playback.seek(loopStart);
                else services.transport.seek(loopStart);
              }
              takeAnchorApplied = true;
            }
          } else if (recordingTakeMode !== "new") {
            if (!group || group.trackId !== track.id) return null;
            const groupClips = (currentDoc.arrangement.audioClips ?? []).filter(
              (clip) => clip.takeGroupId === takeGroupId && clip.takeId,
            );
            if (groupClips.length === 0) return null;
            if (!takeAnchorApplied) {
              const activePassClips = groupClips.filter((clip) => clip.takeId === group.activeTakeId);
              const anchorClips = activePassClips.length > 0 ? activePassClips : groupClips;
              const anchorBar = Math.min(...anchorClips.map((clip) => clip.startBar));
              services.transport.seek(Math.round(anchorBar * barUnit));
              takeAnchorApplied = true;
            }
          }
        }
        const channelTrackIds = [armedTrackId, armedSecondTrackId, ...armedAdditionalTrackIds].slice(
          0,
          requestedChannelCount ?? routingChannelCount,
        );
        const channelDestinations = channelTrackIds.flatMap((destinationTrackId, channelIndex) => {
          if (!destinationTrackId) return [];
          const destinationTrack = currentDoc.tracks.find((item) => item.id === destinationTrackId);
          if (!destinationTrack) return [];
          return [{ channelIndex, trackId: destinationTrack.id, trackName: destinationTrack.name }];
        });
        const hasSplitChannelRouting = channelDestinations.some((destination) => destination.channelIndex > 0);
        const startBar = Math.max(
          0,
          recordingStartBar(punchLocators?.start ?? services.transport.position, ticksPerBar(doc)),
        );
        // Audit 07 D1: capture whether the imminent playPause() will roll a
        // count-in/pre-roll lead-in BEFORE the content — the buffer starts at
        // the REC press, so without this the take landed one lead-in late
        // with the count-in room audio at its head. Placement trims it via
        // clip offsetSec (non-destructive).
        const leadInTicks = services.transport.leadInTicks();
        const leadInWillApply = punchLocators
          ? punchLeadInTicks > 0
          : !loopTakeCapture &&
            !services.transport.playing &&
            !services.transport.paused &&
            leadInTicks > 0 &&
            services.transport.position >= leadInTicks;
        return {
          projectId: currentDoc.id,
          trackId: track.id,
          trackName: track.name,
          ...(hasSplitChannelRouting ? { channelDestinations } : {}),
          ...(takeGroupId && takeId ? { takeGroupId, takeId } : {}),
          ...(loopTakeCapture ? { loopCapture: true } : {}),
          ...(punchLocators ? { punchCapture: { startTick: punchLocators.start, endTick: punchLocators.end } } : {}),
          placeOnTimeline: true,
          startBar,
          bpm: currentDoc.bpm,
          recordingInputOffsetMs: recordingAlignment.getSnapshot(),
          leadInSec: leadInWillApply ? leadInTicks * services.transport.secondsPerTick : 0,
        };
      });
      recorder.onError = (message) => {
        setRecError(message);
        void stopRec();
      };
      recorder.onPunchOut = () => void stopRec();
      recorder.onStorageWarning = setRecStorageWarning;
      await startPromise;
      // An error during the "starting" phase already routed this take through
      // stopRec, which cleared the recorder slot. If start() resolved anyway
      // (late permission/resume), don't resurrect the recording state or the
      // recorder — a fresh take may already own the slot.
      if (!recPanelMountedRef.current || attempt !== recStartAttemptRef.current || recRef.current !== recorder) {
        void recorder.cancel();
        return;
      }
      setRecSeconds(0);
      setLastCaptureInfo(recorder.captureInfo ?? null);
      setRecState("recording");
      // First real take — the onboarding journey is complete.
      notifyOnboardingProgress("recorded");
      void refreshRecordingInputs();
      if (loopTakeCapture && typeof services.scheduler.subscribeLoopBoundaries === "function") {
        loopBoundaryUnsubscribeRef.current = services.scheduler.subscribeLoopBoundaries((boundary) => {
          if (recRef.current !== recorder) return;
          if (
            loopTakeLocators &&
            (boundary.loopStartTick !== loopTakeLocators.start || boundary.loopEndTick !== loopTakeLocators.end)
          ) {
            recorder?.onError?.(
              "Transport loop locators changed during loop recording; the saved audio is kept for recovery",
            );
            return;
          }
          if (boundary.cancelled) {
            if (typeof recorder?.cancelTakeBoundary === "function") recorder.cancelTakeBoundary(boundary.audioTime);
          } else if (typeof recorder?.scheduleTakeBoundary === "function") {
            recorder.scheduleTakeBoundary(boundary.audioTime);
          }
        });
      }
      if (punchLocators && typeof services.scheduler.subscribeTickBoundary === "function") {
        const onPunchInBoundary = (boundary: import("../scheduler/Scheduler").ScheduledTickBoundary) => {
          if (recRef.current !== recorder) return;
          if (boundary.cancelled) {
            recorder?.cancelTakeBoundary(boundary.audioTime);
          } else if (!recorder?.scheduleTakeBoundary(boundary.audioTime)) {
            recorder?.onError?.(
              "Punch-in could not be queued at the exact audio frame; the staged take remains recoverable",
            );
          }
        };
        const onPunchOutBoundary = (boundary: import("../scheduler/Scheduler").ScheduledTickBoundary) => {
          if (recRef.current !== recorder) return;
          if (boundary.cancelled) {
            recorder?.cancelPunchOut(boundary.audioTime);
          } else if (!recorder?.schedulePunchOut(boundary.audioTime)) {
            recorder?.onError?.(
              "Punch-out could not be queued at the exact audio frame; the staged take remains recoverable",
            );
          }
        };
        const unsubscribePunchIn = services.scheduler.subscribeTickBoundary(punchLocators.start, onPunchInBoundary);
        const unsubscribePunchOut = services.scheduler.subscribeTickBoundary(punchLocators.end, onPunchOutBoundary);
        punchBoundaryUnsubscribeRef.current = () => {
          unsubscribePunchIn();
          unsubscribePunchOut();
        };
      }
      // Performers record against the backing track — roll the transport.
      if (!services.transport.playing) {
        if (loopTakeCapture) {
          const countIn = services.transport.countInBars;
          const preRoll = services.transport.preRollBars;
          services.transport.setCountIn(0);
          services.transport.setPreRoll(0);
          try {
            services.playback.playPause();
          } finally {
            services.transport.setCountIn(countIn);
            services.transport.setPreRoll(preRoll);
          }
        } else if (punchLocators && punchSuppressLeadIn) {
          const countIn = services.transport.countInBars;
          const preRoll = services.transport.preRollBars;
          services.transport.setCountIn(0);
          services.transport.setPreRoll(0);
          try {
            services.playback.playPause();
          } finally {
            services.transport.setCountIn(countIn);
            services.transport.setPreRoll(preRoll);
          }
        } else {
          services.playback.playPause();
        }
      }
    } catch (error) {
      if (recorder) {
        if (recRef.current === recorder) recRef.current = null;
        void recorder.cancel();
      }
      if (recorderGroup) {
        if (recGroupRef.current === recorderGroup) recGroupRef.current = null;
        void recorderGroup.cancel();
      }
      if (recPanelMountedRef.current && attempt === recStartAttemptRef.current) {
        setRecState("idle");
        setRecError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (attempt === recStartAttemptRef.current) recStartPendingRef.current = false;
    }
  };

  const placeIndependentGroupTakes = async (
    results: import("../audio-engine/PcmMicRecorderGroup").PcmMicRecorderGroupStopResult[],
  ): Promise<void> => {
    const warnings = results.flatMap((result) =>
      result.error ? [`${result.inputId}: ${result.error}. Its committed audio remains in recovery.`] : [],
    );
    const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const commands: import("../commands/types").Command[] = [];
    let projectedDoc = services.store.doc;

    for (const result of results) {
      const take = result.take;
      if (!take) {
        if (!result.error) warnings.push(`${result.inputId}: no audio was captured; staged audio remains in recovery.`);
        continue;
      }
      const bufferId = recordedTakeSampleId(take.session.id);
      const asset = {
        id: bufferId,
        name: `REC ${stamp} · ${take.session.trackName}`,
        fileName: `${bufferId}.wav`,
        category: "Custom" as const,
        duration: take.buffer.duration,
        sampleRate: take.buffer.sampleRate,
        channels: take.buffer.numberOfChannels,
        createdAt: new Date().toISOString(),
      };
      try {
        await recoveryRepoRef.current!.finalize(take.session.id, asset);
        services.userSamples.invalidateCache();
      } catch (error) {
        const detail = error instanceof Error ? ` (${error.message})` : "";
        warnings.push(`${take.session.trackName}: sample-library save failed${detail}; PCM remains recoverable.`);
      }
      services.bank.add(bufferId, take.buffer);

      try {
        if (projectedDoc.id !== take.session.projectId) {
          throw new Error("The original project is no longer open");
        }
        const track = projectedDoc.tracks.find((item) => item.id === take.session.trackId);
        if (!track) throw new Error("The armed destination track no longer exists");
        const startBar = compensateRecordingStartBar(
          take.session.startBar,
          take.session.recordingInputOffsetMs ?? 0,
          projectedDoc.bpm,
          ticksPerBar(projectedDoc),
        );
        const leadInSec = take.session.leadInSec ?? 0;
        const lengthBars = clipLengthBars(
          take.buffer.duration - leadInSec,
          projectedDoc.bpm,
          ticksPerBar(projectedDoc),
        );
        const alignmentChannels: Float32Array[] = [];
        try {
          for (let channel = 0; channel < take.buffer.numberOfChannels; channel += 1) {
            const data = take.buffer.getChannelData(channel);
            if (data != null && data.length > 0) alignmentChannels.push(data);
          }
        } catch {
          /* onset alignment is best-effort; placement still proceeds */
        }
        const alignShiftSec = autoAlignShiftSec(measurePhraseOnset(alignmentChannels, take.buffer.sampleRate));
        const command = addRecordedAudioClips(projectedDoc, [{ trackId: track.id }], bufferId, startBar, lengthBars, {
          fadeIn: 0.005,
          fadeOut: 0.02,
          offsetSec: Math.max(0, leadInSec + alignShiftSec),
        });
        projectedDoc = command.execute(projectedDoc);
        commands.push(command);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warnings.push(`${take.session.trackName}: saved as a sample but not placed on the timeline (${detail}).`);
      }
    }

    if (commands.length > 0) {
      const compound: import("../commands/types").Command = {
        type: "recordIndependentInputGroup",
        label: `Record ${commands.length} input takes`,
        execute: (doc) => commands.reduce((next, command) => command.execute(next), doc),
        undo: (doc) => [...commands].reverse().reduce((next, command) => command.undo(next), doc),
      };
      services.store.execute(compound);
    }
    if (warnings.length > 0) setRecError(warnings.join(" "));
    else setRecError(null);
    await refreshRecoverableTakes();
  };

  const stopRec = async () => {
    const rec = recRef.current;
    const group = recGroupRef.current;
    if ((!rec && !group) || stoppingRecRef.current) return;
    stoppingRecRef.current = true;
    loopBoundaryUnsubscribeRef.current?.();
    loopBoundaryUnsubscribeRef.current = null;
    punchBoundaryUnsubscribeRef.current?.();
    punchBoundaryUnsubscribeRef.current = null;
    setRecState("saving");
    try {
      if (group) {
        const results = await group.stop();
        await placeIndependentGroupTakes(results);
        return;
      }
      if (!rec) return;
      const take = await rec.stop();
      if (!take) {
        setRecError("No audio was captured. Any staged audio remains available in recovery.");
        return;
      }
      const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const bufferId = recordedTakeSampleId(take.session.id);
      const asset = {
        id: bufferId,
        name: `REC ${stamp}`,
        fileName: `${bufferId}.wav`,
        category: "Custom" as const,
        duration: take.buffer.duration,
        sampleRate: take.buffer.sampleRate,
        channels: take.buffer.numberOfChannels,
        createdAt: new Date().toISOString(),
      };
      let persistenceWarning: string | null = null;
      try {
        await recoveryRepoRef.current!.finalize(take.session.id, asset);
        services.userSamples.invalidateCache();
      } catch (error) {
        const detail = error instanceof Error ? ` (${error.message})` : "";
        persistenceWarning = `The take could not be moved to the sample library${detail}. Its committed PCM blocks remain in recovery storage.`;
      }

      // Keep the materialized audio usable in-session even if library storage
      // failed; in that case the staged PCM session remains crash-recoverable.
      services.bank.add(bufferId, take.buffer);
      try {
        const currentDoc = services.store.doc;
        if (currentDoc.id !== take.session.projectId) {
          throw new Error("The original project or armed track is no longer open");
        }
        const routing = resolveRecordedAudioDestinations(
          currentDoc,
          take.session.trackId,
          take.session.channelDestinations,
          take.buffer.numberOfChannels,
        );
        if (routing.destinations.length === 0) throw new Error("No recorded channel destination still exists");
        const startBar = compensateRecordingStartBar(
          take.session.startBar,
          take.session.recordingInputOffsetMs ?? 0,
          currentDoc.bpm,
          ticksPerBar(currentDoc),
        );
        const punchWindow = take.session.punchCapture
          ? recordedPunchWindow(take.session, ticksPerBar(currentDoc))
          : null;
        if (take.session.punchCapture && !punchWindow) {
          throw new Error(
            "Punch-in was not reached cleanly; the recovered audio is kept as a sample, not placed on the timeline",
          );
        }
        const lengthBars =
          punchWindow?.lengthBars ??
          clipLengthBars(take.buffer.duration - (take.session.leadInSec ?? 0), currentDoc.bpm, ticksPerBar(currentDoc));
        // VOCAL-FIRST ALIGNMENT. The device path is already compensated above
        // (recordingInputOffsetMs); this is the HUMAN path: a phrase that
        // started a latency-scale step late gets its leading silence skipped,
        // so it lands on the entry it was recorded for. Bounded on purpose —
        // a deliberate late entry (pickup, beat 3) is a musical choice, so only
        // a confident shift within AUTO_ALIGN_MAX_SHIFT_SEC is applied, and it
        // rides INSIDE the placement command: one undo removes take and
        // correction together.
        // The measurement is OPTIONAL — the placement is not. A buffer without
        // channel data (a stub, a broken decode) gets no alignment instead of
        // taking the whole take down with it.
        const alignmentChannels: Float32Array[] = [];
        try {
          for (let channel = 0; channel < take.buffer.numberOfChannels; channel += 1) {
            const data = take.buffer.getChannelData(channel);
            if (data != null && data.length > 0) alignmentChannels.push(data);
          }
        } catch {
          /* alignment is best-effort by design */
        }
        // The same pure derivation the loop builder performs from the session's
        // own numbers; a length mismatch there is ignored rather than guessed.
        const loopPasses = take.session.loopCapture
          ? recordedLoopPasses(
              take.session.totalFrames,
              take.session.sampleRate,
              take.session.takeBoundaries,
              take.session.bpm,
              take.session.id,
              ticksPerBar(doc),
            )
          : [];
        const alignShifts = take.session.loopCapture
          ? passAlignShifts(alignmentChannels, take.session.sampleRate, loopPasses)
          : [];
        const singleAlignShift = take.session.loopCapture
          ? 0
          : autoAlignShiftSec(measurePhraseOnset(alignmentChannels, take.buffer.sampleRate));
        const appliedShifts = take.session.loopCapture
          ? alignShifts.filter((shift) => shift > 0)
          : singleAlignShift > 0
            ? [singleAlignShift]
            : [];
        if (appliedShifts.length > 0) {
          const average = appliedShifts.reduce((sum, shift) => sum + shift, 0) / appliedShifts.length;
          setRecNotice(
            take.session.loopCapture
              ? `${appliedShifts.length} take pass(es) aligned onto their entry (${formatShiftMs(average)} average).`
              : `Take placed — the phrase was aligned onto its entry (${formatShiftMs(average)}).`,
          );
        } else {
          setRecNotice(null);
        }
        const patch = {
          fadeIn: 0.005,
          fadeOut: 0.02,
          // D1: skip the count-in/pre-roll head captured before content; then
          // the measured phrase alignment, if any.
          offsetSec: Math.max(0, (punchWindow?.offsetSec ?? take.session.leadInSec ?? 0) + singleAlignShift),
        };
        if (take.session.loopCapture && take.session.takeGroupId) {
          if (routing.destinations.length !== 1 || routing.destinations[0]?.trackId !== take.session.trackId) {
            throw new Error("The saved loop take no longer has its original single-track routing");
          }
          services.store.execute(addRecordedLoopSession(currentDoc, take.session, bufferId, patch, alignShifts));
          setRecordingTakeGroupSelection(take.session.takeGroupId);
        } else if (take.session.takeGroupId && take.session.takeId) {
          if (routing.destinations.length !== 1 || routing.destinations[0]?.trackId !== take.session.trackId) {
            throw new Error("The saved take lane no longer has its original single-track routing");
          }
          services.store.execute(
            addRecordedAudioTakeClip(
              currentDoc,
              take.session.takeGroupId,
              take.session.takeId,
              take.session.trackId,
              bufferId,
              startBar,
              lengthBars,
              patch,
            ),
          );
          setRecordingTakeGroupSelection(take.session.takeGroupId);
        } else {
          services.store.execute(
            addRecordedAudioClips(currentDoc, routing.destinations, bufferId, startBar, lengthBars, patch),
          );
        }
        const routingWarnings = [
          ...(routing.unavailableChannels.length
            ? [
                `Captured channel${routing.unavailableChannels.length > 1 ? "s" : ""} ${routing.unavailableChannels.map((channel) => channel + 1).join(", ")} unavailable; remaining channel audio was placed.`,
              ]
            : []),
          ...(routing.missingTracks.length
            ? [
                `Missing destination track${routing.missingTracks.length > 1 ? "s" : ""}: ${routing.missingTracks.join(", ")}; available channels were placed.`,
              ]
            : []),
          ...(routing.usedFallback && take.session.channelDestinations?.length
            ? ["The saved channel map was unavailable; the complete take was restored on its primary track."]
            : []),
        ];
        if (routingWarnings.length)
          persistenceWarning = [persistenceWarning, ...routingWarnings].filter(Boolean).join(" ");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        persistenceWarning = [
          persistenceWarning,
          `${persistenceWarning ? "The take remains in recovery storage" : "The take is saved as a sample"}, but could not be placed on the timeline: ${detail}.`,
        ]
          .filter(Boolean)
          .join(" ");
      }
      if (persistenceWarning) setRecError(persistenceWarning);
      await refreshRecoverableTakes();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setRecError(`${detail}. The staged recording has been kept for recovery where storage succeeded.`);
      await refreshRecoverableTakes();
    } finally {
      if (recRef.current === rec) recRef.current = null;
      if (recGroupRef.current === group) recGroupRef.current = null;
      setRecState("idle");
      stoppingRecRef.current = false;
    }
  };

  const recoverTake = async (session: RecordingSession) => {
    if (recoveringTakeId) return;
    setRecoveringTakeId(session.id);
    setRecError(null);
    try {
      services.engine.ensureContext();
      const ctx = services.engine.getLiveAudioContext();
      if (!ctx) throw new Error("Audio engine is not ready to open the recovered take");
      // Turn a stale cross-tab capture into a stopped session before reading
      // blocks, so a still-open source tab cannot extend it mid-recovery.
      await recoveryRepoRef.current!.markRecoverable(session.id);
      const take = await materializePcmTake(recoveryRepoRef.current!, session.id, ctx);
      const bufferId = recordedTakeSampleId(session.id);
      const asset = {
        id: bufferId,
        name: `RECOVERED ${session.trackName}`,
        fileName: `${bufferId}.wav`,
        category: "Custom" as const,
        duration: take.buffer.duration,
        sampleRate: take.buffer.sampleRate,
        channels: take.buffer.numberOfChannels,
        createdAt: new Date().toISOString(),
      };
      await recoveryRepoRef.current!.finalize(session.id, asset);
      services.userSamples.invalidateCache();
      services.bank.add(bufferId, take.buffer);

      const currentDoc = services.store.doc;
      const sameProject = session.placeOnTimeline !== false && currentDoc.id === session.projectId;
      if (sameProject) {
        if (recordedTakeAlreadyPlaced(currentDoc, bufferId)) {
          setRecError(`Recovered ${session.trackName}; its existing timeline clip now has restored audio.`);
          await refreshRecoverableTakes();
          return;
        }
        try {
          const routing = resolveRecordedAudioDestinations(
            currentDoc,
            session.trackId,
            session.channelDestinations,
            take.buffer.numberOfChannels,
          );
          if (routing.destinations.length === 0) throw new Error("No recorded channel destination still exists");
          const startBar = compensateRecordingStartBar(
            session.startBar,
            session.recordingInputOffsetMs ?? 0,
            currentDoc.bpm,
            ticksPerBar(currentDoc),
          );
          const punchWindow = session.punchCapture ? recordedPunchWindow(session, ticksPerBar(currentDoc)) : null;
          if (session.punchCapture && !punchWindow) {
            throw new Error("Punch-in was not reached; the recovered audio remains in the sample library");
          }
          const lengthBars =
            punchWindow?.lengthBars ??
            clipLengthBars(take.buffer.duration - (session.leadInSec ?? 0), currentDoc.bpm, ticksPerBar(currentDoc));
          const patch = { fadeIn: 0.005, fadeOut: 0.02, offsetSec: punchWindow?.offsetSec ?? session.leadInSec ?? 0 };
          if (session.loopCapture && session.takeGroupId) {
            if (routing.destinations.length !== 1 || routing.destinations[0]?.trackId !== session.trackId) {
              throw new Error("The saved loop take no longer has its original single-track routing");
            }
            services.store.execute(addRecordedLoopSession(currentDoc, session, bufferId, patch));
            setRecordingTakeGroupSelection(session.takeGroupId);
          } else if (session.takeGroupId && session.takeId) {
            if (routing.destinations.length !== 1 || routing.destinations[0]?.trackId !== session.trackId) {
              throw new Error("The saved take lane no longer has its original single-track routing");
            }
            services.store.execute(
              addRecordedAudioTakeClip(
                currentDoc,
                session.takeGroupId,
                session.takeId,
                session.trackId,
                bufferId,
                startBar,
                lengthBars,
                patch,
              ),
            );
            setRecordingTakeGroupSelection(session.takeGroupId);
          } else {
            services.store.execute(
              addRecordedAudioClips(currentDoc, routing.destinations, bufferId, startBar, lengthBars, patch),
            );
          }
          const warningParts = [
            ...(routing.unavailableChannels.length
              ? [
                  `captured channel${routing.unavailableChannels.length > 1 ? "s" : ""} ${routing.unavailableChannels.map((channel) => channel + 1).join(", ")} unavailable`,
                ]
              : []),
            ...(routing.missingTracks.length
              ? [
                  `destination track${routing.missingTracks.length > 1 ? "s" : ""} missing: ${routing.missingTracks.join(", ")}`,
                ]
              : []),
            ...(routing.usedFallback && session.channelDestinations?.length
              ? ["restored the full take to the primary track"]
              : []),
          ];
          setRecError(
            `Recovered ${session.trackName} and placed it back on the timeline.${warningParts.length ? ` Routing note: ${warningParts.join("; ")}.` : ""}`,
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          setRecError(`Take recovered to the sample library, but timeline placement failed: ${detail}`);
        }
      } else {
        setRecError("Recovered take to the sample library; its original project or track is not open.");
      }
      await refreshRecoverableTakes();
    } catch (error) {
      setRecError(error instanceof Error ? error.message : String(error));
    } finally {
      setRecoveringTakeId(null);
    }
  };

  const discardTake = async (session: RecordingSession) => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Permanently discard the unrecovered take from ${session.trackName}?`)
    )
      return;
    try {
      await recoveryRepoRef.current!.remove(session.id);
      await refreshRecoverableTakes();
    } catch (error) {
      setRecError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (recState !== "recording") return;
    const timer = setInterval(() => {
      setRecSeconds(recRef.current?.elapsedSeconds ?? recGroupRef.current?.elapsedSeconds ?? 0);
    }, 200);
    return () => clearInterval(timer);
  }, [recState]);
  const audioDragRef = useRef<{
    clipId: string;
    /**
     * Gesture modes that actually have a branch in `onAudioPointerMove`.
     * `"trimEnd"` was removed deliberately: the right edge sends `"resize"`
     * (see the handle's onPointerDown), and no branch ever produced a trimEnd
     * gesture. Leaving it in the union meant a future `trimEnd` branch would
     * type-check and look wired when nothing routed to it.
     */
    mode: "move" | "resize" | "trimStart" | "fadeIn" | "fadeOut" | "gain" | "stretch" | "slip";
    /** Stretch anchor: right edge pins the start, left edge pins the end. */
    edge: "left" | "right";
    /** The pointer this gesture captured — see DragState.pointerId. */
    pointerId: number;
    origStart: number;
    origLength: number;
    origRate: number;
    /**
     * The clip's SOURCE seconds per WALL second at pointerdown — the factor
     * that converts a timeline gesture into a source position. Captured with
     * the rest of the gesture state, for the same reason `barWidth` is: a
     * gesture must use one unit system for its whole span.
     */
    sourcePerWallSecond: number;
    origTrimStart: number;
    /** Slip gesture: the captured content offset and its content-coverage ceiling. */
    origOffsetSec: number;
    maxOffsetSec: number | null;
    /** px-per-bar captured at pointerdown — see DragState.barWidth. */
    barWidth: number;
    origFadeIn: number;
    origFadeOut: number;
    origGain: number;
    grabBar: number;
    grabY: number;
    /**
     * Wall-clock seconds per bar averaged over THIS clip's span, at the
     * scenes' effective tempos (scheduler contract: a pinned scene runs at
     * its own bpm, gaps at the project tempo). doc.bpm here made fade and
     * trim sensitivity disagree with what the transport actually plays.
     */
    secPerBar: number;
    /** Block move: every selected audio clip slides by one shared delta. */
    movingIds?: string[];
    origStarts?: Record<string, number>;
    /** §29 — see DragState.movingHasLocked: the block move writes the document
     * by hand, so the lock has to be sampled here and enforced at the commit. */
    movingHasLocked?: boolean;
    /** Cross-lane group drag state shared with scene, MIDI and automation lanes. */
    groupId?: string;
    groupClipIds?: string[];
    groupHasScene?: boolean;
    groupDeltaTicks?: number;
  } | null>(null);
  const [audioStretchPreview, setAudioStretchPreview] = useState<{ clipId: string; rate: number } | null>(null);
  const [audioDrag, setAudioDrag] = useState<{ startBar: number; lengthBars: number } | null>(null);
  const [audioFadePreview, setAudioFadePreview] = useState<{ clipId: string; fadeIn: number; fadeOut: number } | null>(
    null,
  );
  const [audioGainPreview, setAudioGainPreview] = useState<{ clipId: string; gain: number } | null>(null);
  // Slip preview (Alt+drag in the clip body): which part of the source plays.
  const [audioSlipPreview, setAudioSlipPreview] = useState<{ clipId: string; offsetSec: number } | null>(null);
  // Live audio-drag values mirrored out of state (audit 16) — see the
  // dragLiveRef note above. `onAudioPointerUp` is a DISCRETE handler that
  // commits move / resize / stretch / trim / fade / gain from these values.
  // Read from state instead, a release landing in the same batch as the final
  // move committed the previous frame's geometry; and for the fade and gain
  // modes the `> 0.005` staleness guard then compared the ORIGINAL value with
  // itself, turning a real gesture into no commit at all.
  const audioDragLiveRef = useRef<{ startBar: number; lengthBars: number } | null>(null);
  const audioFadeLiveRef = useRef<{ clipId: string; fadeIn: number; fadeOut: number } | null>(null);
  const audioGainLiveRef = useRef<{ clipId: string; gain: number } | null>(null);
  const audioStretchLiveRef = useRef<{ clipId: string; rate: number } | null>(null);
  const audioSlipLiveRef = useRef<{ clipId: string; offsetSec: number } | null>(null);
  /** Write-through setters: the ref is the event authority, state the render. */
  const setAudioDragLive = (next: { startBar: number; lengthBars: number } | null) => {
    audioDragLiveRef.current = next;
    setAudioDrag(next);
  };
  const setAudioFadeLive = (next: { clipId: string; fadeIn: number; fadeOut: number } | null) => {
    audioFadeLiveRef.current = next;
    setAudioFadePreview(next);
  };
  const setAudioGainLive = (next: { clipId: string; gain: number } | null) => {
    audioGainLiveRef.current = next;
    setAudioGainPreview(next);
  };
  const setAudioStretchLive = (next: { clipId: string; rate: number } | null) => {
    audioStretchLiveRef.current = next;
    setAudioStretchPreview(next);
  };
  const setAudioSlipLive = (next: { clipId: string; offsetSec: number } | null) => {
    audioSlipLiveRef.current = next;
    setAudioSlipPreview(next);
  };
  // Block-move preview: the shared delta every selected audio clip slides by.
  // Same write-through discipline as the other live values — pointerup is a
  // discrete handler that must read the latest frame, not batched state.
  const [audioMultiDrag, setAudioMultiDrag] = useState<number | null>(null);
  const audioMultiDragLiveRef = useRef<number | null>(null);
  const setAudioMultiDragLive = (next: number | null) => {
    audioMultiDragLiveRef.current = next;
    setAudioMultiDrag(next);
  };
  /** Clear every live audio-drag value — used by all three abort paths. */
  const clearAudioDragLive = () => {
    audioDragLiveRef.current = null;
    audioFadeLiveRef.current = null;
    audioGainLiveRef.current = null;
    audioStretchLiveRef.current = null;
    audioSlipLiveRef.current = null;
    audioMultiDragLiveRef.current = null;
    setAudioDrag(null);
    setAudioFadePreview(null);
    setAudioGainPreview(null);
    setAudioStretchPreview(null);
    setAudioSlipPreview(null);
    setAudioMultiDrag(null);
  };
  const [audioMenu, setAudioMenu] = useState<{ clipId: string; x: number; y: number } | null>(null);
  // CHORD TRACK (v17): selection + gesture state for the chord lane.
  const [chordSel, setChordSel] = useState<string | null>(null);
  // Progression generator form state (deterministic — same form = same chords).
  const [chordGenOpen, setChordGenOpen] = useState(false);
  const [chordGen, setChordGen] = useState<ChordGenForm>({
    genre: "house",
    tonic: 0,
    mode: "minor",
    bars: 8,
    startBar: 0,
    index: 0,
  });
  const [chordDrag, setChordDrag] = useState<{ startBar: number; lengthBars: number } | null>(null);
  const chordDragLiveRef = useRef<{ startBar: number; lengthBars: number } | null>(null);
  const chordDragRef = useRef<{
    mode: "move" | "resize";
    chordId: string;
    pointerId: number;
    grabBar: number;
    origStart: number;
    origLength: number;
    barWidth: number;
  } | null>(null);
  const setChordDragLive = (next: { startBar: number; lengthBars: number } | null) => {
    chordDragLiveRef.current = next;
    setChordDrag(next);
  };
  const clipLongPressTargetRef = useRef<string | null>(null);
  const audioLongPressTargetRef = useRef<{ clipId: string; x: number; y: number } | null>(null);
  const markerLongPressTargetRef = useRef<string | null>(null);

  // Touch equivalents of the right-click workflows (LONGEVITY §3 / mobile):
  // long-press deletes a scene clip (same toast+UNDO), opens the audio-clip
  // menu, and deletes a marker. Mice keep the real context menu.
  const clipLongPress = useLongPress(() => {
    const clipId = clipLongPressTargetRef.current;
    if (!clipId) return;
    const ids = selectionStore.isClipSelected(clipId) ? [...selection.clipIds] : [clipId];
    if (ids.length > 0) deleteClipsWithToast(ids);
  });
  const audioLongPress = useLongPress(() => {
    const target = audioLongPressTargetRef.current;
    if (target) setAudioMenu(target);
  });
  const markerLongPress = useLongPress(() => {
    const markerId = markerLongPressTargetRef.current;
    if (markerId) execute(removeMarker(services.store.doc, markerId));
  });
  const markerLongPressHandlers = {
    onPointerMove: markerLongPress.onPointerMove,
    onPointerUp: markerLongPress.onPointerUp,
    onPointerLeave: markerLongPress.onPointerLeave,
    onPointerCancel: markerLongPress.onPointerCancel,
  };
  // Time-stretch dialog — open from the AUDIO CLIP menu (replaces prompt()).
  const [stretchClipId, setStretchClipId] = useState<string | null>(null);
  // Spectral Lab (RX-style clip surgery) — open from the AUDIO CLIP menu.
  const [spectralEditClipId, setSpectralEditClipId] = useState<string | null>(null);
  useEffect(() => {
    if (!audioMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".context-menu")) return;
      setAudioMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [audioMenu]);

  // Audit 15/16: the playhead hook re-renders this panel ~2x/s during
  // playback — clip copies+sorts (and totalBars) must not rerun per tick.
  // Memoized on arrangement identity (structural sharing keeps it stable
  // across unrelated mutations).
  const clips = useMemo(() => [...arrangement.clips].sort((a, b) => a.startBar - b.startBar), [arrangement.clips]);
  const audioClips = useMemo(
    () => [...(arrangement.audioClips ?? [])].sort((a, b) => a.startBar - b.startBar),
    [arrangement.audioClips],
  );
  // Stretch dialog data — resolved once per opened clip (BPM detection is an
  // autocorrelation pass; never run it per render).
  const stretchTarget = stretchClipId ? (audioClips.find((c) => c.id === stretchClipId) ?? null) : null;
  const stretchBuffer = stretchTarget ? services.bank.get(stretchTarget.bufferId) : null;
  const stretchSourceSec = stretchBuffer?.duration ?? 0;
  const stretchDetectedBpm = useMemo(
    () =>
      stretchBuffer
        ? (detectLoopBpm(audioClipChannelData(stretchBuffer, stretchTarget?.sourceChannel), stretchBuffer.sampleRate)
            ?.bpm ?? null)
        : null,
    [stretchClipId, stretchBuffer, stretchTarget?.sourceChannel],
  );
  // Playhead leaves own the 1/8-bar rAF subscription (see ArrPlayheadLine);
  // the panel itself only re-renders when the playhead CROSSES a clip.
  const currentClipId = useCurrentItemId(clips, services.transport, barUnit);
  /**
   * Timeline extent, in bars, used for the ruler and the grid.
   *
   * `Math.max` PROPAGATES NaN, so one clip with a non-finite position used to
   * poison this number for the whole document: NaN silently emptied the grid,
   * and a finite-but-absurd position (`1e308` from a collab peer or an older
   * build) reached `Array.from({ length: totalBars })` on the unmeasured-
   * viewport path — which is the FIRST render of every session, before
   * `measureViewport()` runs — and threw `RangeError: Invalid array length`,
   * unmounting the panel. §36 asks the editor to isolate one bad entity, and a
   * non-finite position is not a position: it is skipped, not rendered around.
   */
  const midiClips = arrangement.midiClips ?? [];
  const automationClips = arrangement.automationClips ?? [];
  const totalBars = timelineExtentBars(clips, audioClips, midiClips, automationClips, barUnit);
  const visibleMidiClips = useMemo(() => {
    if (!viewport) return midiClips;
    const fromTick = Math.max(0, viewport.firstBar) * barUnit;
    const toTick = Math.min(totalBars, viewport.lastBar) * barUnit;
    return midiClips.filter(
      (clip) =>
        (groupDragPreview?.projectId === doc.id && groupDragPreview.clipIds.includes(clip.id)) ||
        (clip.startTick < toTick && clip.startTick + clip.lengthTicks > fromTick),
    );
  }, [doc.id, groupDragPreview, midiClips, totalBars, viewport]);
  const visibleAutomationClips = useMemo(() => {
    if (!viewport) return automationClips;
    const fromTick = Math.max(0, viewport.firstBar) * barUnit;
    const toTick = Math.min(totalBars, viewport.lastBar) * barUnit;
    return automationClips.filter(
      (clip) =>
        (groupDragPreview?.projectId === doc.id && groupDragPreview.clipIds.includes(clip.id)) ||
        (clip.startTick < toTick && clip.startTick + clip.lengthTicks > fromTick),
    );
  }, [automationClips, doc.id, groupDragPreview, totalBars, viewport]);

  /**
   * VIEWPORT WINDOWING.
   *
   * The lane used to map EVERY clip on every render, plus one grid div per bar.
   * Measured cost: O(n) nodes per React commit, and the panel commits on every
   * pointermove, so a 200-clip song reconciled hundreds of nodes per mouse move
   * while audio played. The audio map was worse — `compSourceTakeNumber` rebuilds
   * a Set over all audio clips and `arrangementSecondsBetweenTicks` walks
   * `clips`, so its outer loop was O(n²).
   *
   * Both lists are sorted by startBar (see the memos above), which is what makes
   * this cheap: the time window maps to a CONTIGUOUS index range and the scan
   * stops at `lastBar`.
   *
   * Two things this deliberately does NOT do:
   *
   * - It does not touch the `.arr-role-flow` strip, which also maps `clips`. That
   *   widget is an ordered A → B → C section flow in a container with its own
   *   `overflow-x`, positioned in document order and unrelated to `barWidth`.
   *   Culling it by bar range would delete the arrows that are its entire point.
   *
   * - It never lets the window drop a clip a live gesture owns. The element a
   *   pointer is captured on unmounting mid-drag is the failure this whole change
   *   would otherwise introduce: `usePointerDragGuard` covers undo/collab deletes
   *   today, but scrolling and dragging are now a far more common cause.
   *
   * Entries keep their ORIGINAL index because `clips[index + 1]` renders the
   * transition mark to the next section — resolved against the full list, not the
   * window, or the last visible clip silently loses its "+" button.
   */
  const windowed = useMemo(() => {
    const forced = new Set<string>();
    const sceneDrag = dragRef.current;
    if (sceneDrag?.clipId) forced.add(sceneDrag.clipId);
    if (sceneDrag?.movingIds) for (const id of sceneDrag.movingIds) forced.add(id);
    const audioDrag = audioDragRef.current;
    // Audio gestures are single-clip (no `movingIds` on this ref), so `clipId`
    // is the whole forced set on the audio side.
    if (audioDrag?.clipId) forced.add(audioDrag.clipId);
    if (groupDragPreview?.projectId === doc.id) {
      for (const id of groupDragPreview.clipIds) forced.add(id);
    }

    const pick = <T extends { id: string; startBar: number; lengthBars: number }>(
      list: readonly T[],
    ): { clip: T; index: number }[] => {
      if (!viewport) return list.map((clip, index) => ({ clip, index }));
      const out: { clip: T; index: number }[] = [];
      const taken = new Set<number>();
      for (let i = 0; i < list.length; i++) {
        const clip = list[i]!;
        if (clip.startBar > viewport.lastBar) break; // sorted by startBar
        if (clip.startBar + clip.lengthBars >= viewport.firstBar) {
          out.push({ clip, index: i });
          taken.add(i);
        }
      }
      for (let i = 0; i < list.length; i++) {
        const clip = list[i]!;
        if (!taken.has(i) && forced.has(clip.id)) out.push({ clip, index: i });
      }
      return out.sort((a, b) => a.index - b.index);
    };

    return { clips: pick(clips), audioClips: pick(audioClips) };
    // The drag refs are read, not tracked: `drag` / `multiDrag` are the state
    // that changes during a gesture, and both force a recompute anyway.
  }, [clips, audioClips, viewport, drag, multiDrag, groupDragPreview, doc.id]);
  const visibleClips = windowed.clips;
  const visibleAudioClips = windowed.audioClips;

  /** Grid cells for the visible bars only — one div per bar was O(totalBars). */
  const visibleBarIndices = useMemo(() => {
    if (!viewport) return null;
    const first = Math.max(0, viewport.firstBar);
    const last = Math.min(totalBars, viewport.lastBar + 1);
    const out: number[] = [];
    for (let bar = first; bar < last; bar++) out.push(bar);
    return out;
  }, [viewport, totalBars]);

  /**
   * Ruler marks for the visible bars only — one mark every 4 bars.
   *
   * The ruler is a SIBLING of the lane inside the scroller and it was NOT
   * windowed: one mark per 4 bars over the WHOLE timeline, so its node count
   * grew with the project's length. That was hidden by the extent cap, which
   * is exactly the cap that made every clip past bar 512 unreachable — the two
   * facts are the same fact seen from opposite ends.
   *
   * The marks are absolutely positioned inside the scrollable content, so the
   * ones outside the window are off-screen anyway; rendering only the visible
   * ones is a pure win, and it keeps the DOM census flat as the project grows
   * (the gate is `tests/ui/arrangement-dom-census.test.tsx`).
   *
   * The UNMEASURED fallback keeps a bounded budget so the first frame — the
   * one that runs before the panel knows its width — cannot allocate a mark
   * per bar of a huge project.
   */
  const rulerMarkIndices = useMemo(() => {
    if (!viewport) {
      const count = Math.ceil(Math.min(totalBars, RULER_MARK_BAR_BUDGET) / 4);
      return Array.from({ length: count }, (_, index) => index);
    }
    const first = Math.max(0, Math.floor(viewport.firstBar / 4));
    const last = Math.min(Math.ceil(totalBars / 4), Math.ceil(viewport.lastBar / 4) + 1);
    const out: number[] = [];
    for (let index = first; index < last; index++) out.push(index);
    return out;
  }, [viewport, totalBars]);

  const selectedScene = scenes.find((scene) => scene.id === selectedSceneId) ?? scenes[0];
  const selectedClip = clips.find((clip) => clip.id === selectedClipId);
  const selectedClipScene = selectedClip ? scenes.find((scene) => scene.id === selectedClip.sceneId) : undefined;
  const selectedClipBpm = effectiveSceneBpm(selectedClipScene?.bpm, doc.bpm);
  const selectedClipSeconds = selectedClip
    ? sceneBarsToSeconds(selectedClip.lengthBars, selectedClipBpm, ticksPerBar(doc))
    : 0;
  const commitClipSecs = (): void => {
    if (!selectedClip || secsDraft === null) return;
    const seconds = Number.parseFloat(secsDraft);
    setSecsDraft(null);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const bars = Math.max(1, Math.round(sceneSecondsToBars(seconds, selectedClipBpm, ticksPerBar(doc))));
    if (bars === selectedClip.lengthBars) return;
    // The command clamps to MAX_ARRANGEMENT_CLIP_BARS; clamping here too keeps
    // the field from silently accepting a value the document will refuse.
    execute(resizeArrangementClip(services.store.doc, selectedClip.id, Math.min(MAX_ARRANGEMENT_CLIP_BARS, bars)));
  };
  const queuedScene = runtime.pendingPatternId
    ? scenes.find((scene) => scene.patternId === runtime.pendingPatternId)
    : undefined;
  const selectedTransition = transitionBoundary
    ? arrangement.transitions?.find(
        (transition) =>
          transition.fromClipId === transitionBoundary.fromClipId &&
          transition.toClipId === transitionBoundary.toClipId,
      )
    : undefined;

  const execute = (command: Parameters<typeof services.store.execute>[0]): boolean => {
    try {
      setActionError(null);
      services.store.execute(command);
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Operation failed");
      return false;
    }
  };

  const openMidiClipSource = (clip: MidiClip): void => {
    const currentDoc = services.store.getDoc();
    const currentClip = currentDoc.arrangement.midiClips?.find((candidate) => candidate.id === clip.id) ?? clip;
    if (!currentDoc.tracks.some((track) => track.id === currentClip.trackId && track.kind === "instrument")) return;
    if (!currentDoc.patterns.some((pattern) => pattern.id === currentClip.patternId)) return;

    setSelectedClipId(null);
    setSelectedAudioClipId(null);
    selectionStore.setClips([]);
    selectionStore.setTracks([currentClip.trackId]);
    selectionStore.clearNotes();
    selectionStore.setStepSelection(null);
    selectionStore.clearTimeRange();
    if (
      currentDoc.activePatternId !== currentClip.patternId &&
      !execute(setActivePattern(currentDoc, currentClip.patternId))
    )
      return;

    services.playback.seek(currentClip.startTick);
    requestMidiClipEditorNavigation(currentClip);
  };

  const makeMidiClipUniqueAndEdit = (clipId: string): void => {
    const currentDoc = services.store.getDoc();
    if (!execute(makeMidiClipUnique(currentDoc, clipId))) return;
    const uniqueClip = services.store.getDoc().arrangement.midiClips?.find((clip) => clip.id === clipId);
    if (uniqueClip) openMidiClipSource(uniqueClip);
  };

  const compAudioRange = (groupId: string, sourceTakeId: string, startTick: number, endTick: number): void => {
    try {
      if (
        execute(compAudioTakeRange(services.store.doc, groupId, sourceTakeId, startTick, endTick, compCrossfadeTicks))
      ) {
        setAudioTakeLaneRange(null);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Comp range failed");
    }
  };

  /**
   * SUGGEST COMP — measure every source take in the group and lay out the
   * bar-by-bar winners with their evidence, WITHOUT touching the document.
   * The producer reads the plan (and can cancel) before anything is
   * committed; APPLY is the single undoable edit.
   *
   * The PCM read is the take's PLAYABLE window (the same trim window
   * `audioClipPlayWindow` feeds the renderer), because a comp plays exactly
   * that material — measuring the raw buffer would judge content the comp
   * never plays (count-in head, trimmed tail).
   */
  const suggestSmartComp = (groupId: string): void => {
    setSmartCompBusy(true);
    setActionError(null);
    try {
      const group = services.store.doc.arrangement.takeGroups?.find((item) => item.id === groupId);
      const plan = planSmartComp(services.store.doc, groupId, (takeId) => {
        const clip = (services.store.doc.arrangement.audioClips ?? [])
          .filter(
            (candidate) =>
              candidate.takeGroupId === groupId && candidate.takeId === takeId && candidate.trackId === group?.trackId,
          )
          .sort((a, b) => a.startBar - b.startBar)
          .find((candidate) => !candidate.reverse && !candidate.loop && candidate.stretchMode !== "stretch");
        if (!clip) return null;
        const buffer = services.bank.get(clip.bufferId);
        if (!buffer) return null;
        const windowSec = audioClipWaveformWindow(
          buffer.duration,
          clip.offsetSec,
          clip.trimStart,
          clip.trimEnd,
          audioClipPlayedSourceSec(
            clip,
            buffer.duration,
            audioClipDurationSec(services.store.doc, clip.lengthBars, clip.startBar),
          ),
        );
        const channel = audioClipChannelData(buffer, clip.sourceChannel);
        const from = Math.max(0, Math.floor(windowSec.startSec * buffer.sampleRate));
        const to = Math.min(channel.length, Math.ceil(windowSec.endSec * buffer.sampleRate));
        if (to <= from) return null;
        return { data: channel.subarray(from, to), sampleRate: buffer.sampleRate };
      });
      if (plan.segments.length === 0) {
        setActionError("Smart comp needs a compable source take in this group");
        setSmartCompPlan(null);
        return;
      }
      setSmartCompPlan(plan);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Smart comp failed");
      setSmartCompPlan(null);
    } finally {
      setSmartCompBusy(false);
    }
  };

  const applySmartCompPlan = (groupId: string): void => {
    if (!smartCompPlan) return;
    try {
      if (execute(applySmartComp(services.store.doc, groupId, smartCompPlan, compCrossfadeTicks))) {
        setAudioTakeLaneRange(null);
        setSmartCompPlan(null);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Smart comp apply failed");
    }
  };

  const takeLaneTickAtPointer = (
    event: ReactPointerEvent<HTMLDivElement>,
    geometry?: { width: number; barWidthAt: number },
  ): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = geometry ? geometry.width : rect.width || totalBars * barWidth;
    const barWidthAt = geometry ? geometry.barWidthAt : barWidth;
    const left = rect.width ? rect.left : 0;
    const x = Math.max(0, Math.min(width, event.clientX - left));
    return (x / Math.max(1, barWidthAt)) * barUnit;
  };

  const startTakeLaneRangeDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    groupId: string,
    sourceTakeId: string,
  ): void => {
    if (event.button !== 0 || sourceTakeId === selectedAudioTakeGroup?.compTakeId) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const geometry = { width: rect.width || totalBars * barWidth, barWidthAt: barWidth };
    const startTick = takeLaneTickAtPointer(event, geometry);
    audioTakeLaneDragRef.current = {
      groupId,
      sourceTakeId,
      startTick,
      endTick: startTick,
      currentTick: startTick,
      pointerId: event.pointerId,
      anchorClientX: event.clientX,
      moved: false,
      geometry,
    };
    setAudioTakeLaneRange({ groupId, sourceTakeId, startTick, endTick: startTick });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const updateTakeLaneRangeDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = audioTakeLaneDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // Comp ranges are timeline positions — snap to the grid (Shift suspends).
    const grid = event.shiftKey ? null : snapBarsFor(snapGrid);
    const currentTick = snapTick(takeLaneTickAtPointer(event, drag.geometry), grid, barUnit);
    const moved = drag.moved || Math.abs(event.clientX - drag.anchorClientX) > 2;
    audioTakeLaneDragRef.current = { ...drag, currentTick, moved };
    if (moved) {
      setAudioTakeLaneRange({
        groupId: drag.groupId,
        sourceTakeId: drag.sourceTakeId,
        startTick: Math.min(drag.startTick, currentTick),
        endTick: Math.max(drag.startTick, currentTick),
      });
    }
  };

  const finishTakeLaneRangeDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = audioTakeLaneDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    audioTakeLaneDragRef.current = null;
    const grid = event.shiftKey ? null : snapBarsFor(snapGrid);
    const endTick = snapTick(takeLaneTickAtPointer(event, drag.geometry), grid, barUnit);
    if (drag.moved && Math.abs(endTick - drag.startTick) >= 1) {
      suppressTakeLaneClickRef.current = true;
      window.setTimeout(() => {
        suppressTakeLaneClickRef.current = false;
      }, 0);
      setAudioTakeLaneRange({
        groupId: drag.groupId,
        sourceTakeId: drag.sourceTakeId,
        startTick: Math.min(drag.startTick, endTick),
        endTick: Math.max(drag.startTick, endTick),
      });
    } else {
      setAudioTakeLaneRange(null);
    }
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const stopAudioTakeAudition = (): void => {
    const request = audioTakeAuditionRef.current;
    if (!request) return;
    audioTakeAuditionRef.current = null;
    request.controller.abort();
    if (request.state === "live") services.setLiveTakeAuditionProject(null);
    else services.engine.stopPreview();
    setAudioTakeAudition(null);
  };

  const auditionAudioTake = async (groupId: string, takeId: string): Promise<void> => {
    const current = audioTakeAuditionRef.current;
    if (current?.groupId === groupId && current.takeId === takeId) {
      stopAudioTakeAudition();
      return;
    }
    if (services.transport.playing && services.playback.mode !== "song") {
      setActionError("Switch to Song mode to audition a take lane during playback");
      return;
    }
    stopAudioTakeAudition();
    const request: AudioTakeAuditionRequest = {
      groupId,
      takeId,
      state: "rendering",
      controller: new AbortController(),
    };
    audioTakeAuditionRef.current = request;
    setAudioTakeAudition(request);

    if (services.transport.playing) {
      try {
        const sourceDoc = services.store.getDoc();
        const audition = createLiveAudioTakeAuditionProject(sourceDoc, groupId, takeId, services.transport.position);
        services.setLiveTakeAuditionProject(audition.project, audition.resumedAudioClipOffsets);
        if (audioTakeAuditionRef.current !== request) {
          services.setLiveTakeAuditionProject(null);
          return;
        }
        request.state = "live";
        setAudioTakeAudition(request);
      } catch (error) {
        if (audioTakeAuditionRef.current === request) {
          audioTakeAuditionRef.current = null;
          setAudioTakeAudition(null);
        }
        setActionError(error instanceof Error ? error.message : "Live take audition failed");
      }
      return;
    }

    try {
      services.engine.ensureContext();
      const sourceDoc = services.store.getDoc();
      const auditionDoc = createAudioTakeAuditionDoc(sourceDoc, groupId, takeId);
      const auditionStartOffsetSec = audioTakeAuditionStartOffsetSec(sourceDoc, groupId, takeId);
      const { renderProject } = await import("../rendering/renderer");
      const buffer = await renderProject(auditionDoc, services.bank, {
        mode: "song",
        // From the LIVE context, not a literal. This was hardcoded to 48_000
        // while every sibling render in this file already derives it
        // (:3378, :3449). On a 44.1 kHz session that meant two defects in one
        // feature: the audition's filter coefficients and delay lines were
        // built for the wrong rate, and `previewBuffer` then played a 48 kHz
        // buffer into a 44.1 kHz context — Web Audio resamples on playback, so
        // the take came out ~8.8% slow and low. The whole point of an audition
        // is A/B-ing a take against the project it belongs to (AGENTS.md
        // invariant 3: exports must sound exactly like the project).
        sampleRate: services.engine.getLiveAudioContext()?.sampleRate ?? 44100,
        // Track/group/return FX are baked into the audition buffer. The
        // live preview bus applies this project's master chain exactly once.
        masterProcessing: false,
        signal: request.controller.signal,
      });
      if (audioTakeAuditionRef.current !== request) return;
      if (services.transport.playing || services.store.getDoc() !== sourceDoc) {
        audioTakeAuditionRef.current = null;
        setAudioTakeAudition(null);
        return;
      }
      request.state = "playing";
      setAudioTakeAudition(request);
      services.engine.previewBuffer(
        buffer,
        0.9,
        () => {
          if (audioTakeAuditionRef.current !== request) return;
          audioTakeAuditionRef.current = null;
          setAudioTakeAudition(null);
        },
        auditionStartOffsetSec,
      );
    } catch (error) {
      if (!request.controller.signal.aborted) {
        setActionError(error instanceof Error ? error.message : "Take audition failed");
      }
      if (audioTakeAuditionRef.current === request) {
        audioTakeAuditionRef.current = null;
        setAudioTakeAudition(null);
      }
    }
  };

  useEffect(() => {
    if (!showAudioTakeLanes || audioTakeAuditionRef.current?.groupId !== selectedAudioTakeGroup?.id) {
      stopAudioTakeAudition();
    }
  }, [selectedAudioTakeGroup?.id, showAudioTakeLanes]);

  useEffect(() => {
    const request = audioTakeAuditionRef.current;
    if (!request || request.state !== "live") return;
    const sourceDoc = services.store.getDoc();
    const stopIfStale = (): void => {
      if (audioTakeAuditionRef.current !== request) return;
      if (services.store.getDoc() !== sourceDoc || !services.transport.playing || services.playback.mode !== "song") {
        stopAudioTakeAudition();
      }
    };
    const unsubscribeStore = services.store.subscribe(stopIfStale);
    const unsubscribePlayback = services.playback.subscribe(stopIfStale);
    return () => {
      unsubscribeStore();
      unsubscribePlayback();
    };
  }, [audioTakeAudition?.state, services]);

  useEffect(
    () => () => {
      const request = audioTakeAuditionRef.current;
      audioTakeAuditionRef.current = null;
      if (request) {
        request.controller.abort();
        if (request.state === "live") services.setLiveTakeAuditionProject(null);
        else services.engine.stopPreview();
      }
    },
    [services.engine],
  );

  /** AI FLIP for one genre chip — analyse the loop, generate the pattern, bake the groove. */
  const runAiFlip = (clipId: string, genre: "house" | "techno" | "trap" | "ambient"): void => {
    const c = audioClips.find((x) => x.id === clipId);
    const buf = c ? services.bank.get(c.bufferId) : null;
    if (!buf || !c) {
      setActionError("Loop not loaded");
      setAudioMenu(null);
      return;
    }
    const analysis = analyzeLoopForFlip(audioClipChannelData(buf, c.sourceChannel), buf.sampleRate);
    if (!analysis) {
      setActionError("Could not analyse the loop — no steady groove found");
      setAudioMenu(null);
      return;
    }
    try {
      execute(
        generatePatternCommand(
          services.store.doc,
          buildFlipOptions(analysis, genre, flipSeed(analysis), stepsPerBar(services.store.doc)),
          `Flip ${c.startBar}b`,
        ),
      );
      // The generated pattern is now active — bake the loop's groove on top.
      execute(stealGrooveIntoPattern(services.store.doc, activePatternId, analysis.groove, { applyVelocity: true }));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "AI Flip failed");
    }
    setAudioMenu(null);
  };

  /**
   * Background transient detection for one buffer (worker when worthwhile,
   * sync fallback otherwise — see `detectTransientsAsync`). Idempotent:
   * cached and in-flight buffers are skipped.
   */
  const warmWarpOnsets = (bufferId: string, sourceChannel?: number): void => {
    const key = warpOnsetKey(bufferId, sourceChannel);
    if (warpOnsetCache.has(key) || warpOnsetInflight.has(key)) return;
    // Fire-and-forget: the shared promise caches the result for pins and dots.
    void getWarpOnsets(services.bank, bufferId, sourceChannel);
  };

  /**
   * Add a warp pin at an absolute tick (neutral insertion: the pin lands on
   * the current warp map / straight playback, so the sound does not jump —
   * dragging it afterwards bends time). Time grabs the nearest detected
   * transient within 60 ms (transient magnet); the tick stays where the
   * user pointed. Shared by the context-menu action and double-click on
   * the waveform.
   */
  const addWarpPinAtTick = (clip: AudioClip, tick: number): void => {
    if (clip.reverse) {
      setActionError("Warp pins need forward playback — switch off Reverse first");
      return;
    }
    if (clip.loop) {
      setActionError("Warp is bypassed on looped clips — switch off Loop first");
      return;
    }
    const buf = services.bank.get(clip.bufferId);
    if (!buf) {
      setActionError("Buffer not loaded");
      return;
    }
    const clipStartTick = clip.startBar * barUnit;
    const clipTicks = clip.lengthBars * barUnit;
    const rel = tick - clipStartTick;
    if (!(rel > 0) || !(rel < clipTicks)) return;
    // The engine derives its warp mapping from the clip's START tempo
    // (durationSec is scheduled at the covering scene's effective bpm) — pin
    // placement must divide ticks by the same spt or pins land off-transient.
    const spt = 60 / (tempoAtTick(clips, scenes, clipStartTick, doc.bpm, ticksPerBar(doc)) * PPQ);
    const contentStart = (clip.offsetSec ?? 0) + (clip.trimStart ?? 0);
    const contentDur = Math.max(0.01, buf.duration - contentStart - (clip.trimEnd ?? 0));
    const contentEnd = contentStart + contentDur;
    const bufTime =
      warpBufferTimeAtTick({
        markers: clip.warpMarkers ?? [],
        clipStartTick,
        clipTicks,
        tick: Math.round(tick),
        spt,
        contentStartSec: contentStart,
        contentDurSec: contentDur,
        stretchRate: clip.stretchRate ?? 1,
        stretchMode: clip.stretchMode,
      }) ?? contentStart;
    // Transient magnet: grab the nearest onset when one is close, so pins
    // land on hits instead of between them. First placement warms the
    // detector and stays un-snapped; later placements snap.
    let finalTime = bufTime;
    const cached = warpOnsetCache.get(warpOnsetKey(clip.bufferId, clip.sourceChannel));
    if (cached) {
      const snapped = nearestOnset(bufTime, cached, WARP_SNAP_SEC);
      if (snapped !== null) finalTime = Math.min(contentEnd, Math.max(contentStart, snapped));
    } else {
      warmWarpOnsets(clip.bufferId, clip.sourceChannel);
    }
    const markers = [
      ...(clip.warpMarkers ?? []),
      { timeSec: Math.round(finalTime * 1000) / 1000, tick: Math.round(tick) },
    ]
      .sort((a, b) => a.tick - b.tick)
      .slice(0, 256);
    try {
      execute(updateAudioClip(services.store.doc, clip.id, { warpMarkers: markers }));
      // Warm the pitch-preserving warp cache (stretch + pins) so
      // the next play is exact instead of repitch-fallback.
      services.engine.warmWarpForClip({ ...clip, warpMarkers: markers });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Warp pin failed");
    }
  };

  // Warm transient detection for every audio clip's buffer (magnet for
  // future pins). Keyed by buffer set — a project edit re-runs it, a
  // re-render does not.
  const warpBufferIds = audioClips.map((c) => warpOnsetKey(c.bufferId, c.sourceChannel)).join(",");
  useEffect(() => {
    for (const c of audioClips) warmWarpOnsets(c.bufferId, c.sourceChannel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warpBufferIds]);

  // Piecewise bar→seconds map (VISION §10): every clip's span runs at its
  // scene's EFFECTIVE tempo (scene.bpm pin, else project tempo), gaps at the
  // project tempo. Cumulative — bar N's wall-clock position accounts for the
  // tempo of everything before it, so SECS ruler labels stay honest.
  const barToSeconds = (bar: number): number => {
    const scenesById = new Map(scenes.map((scene) => [scene.id, scene]));
    let seconds = 0;
    let cursor = 0;
    for (const clip of clips) {
      const start = clip.startBar;
      const end = start + clip.lengthBars;
      if (bar <= start) break;
      const scene = scenesById.get(clip.sceneId);
      const bpm = effectiveSceneBpm(scene?.bpm, doc.bpm);
      const segEnd = Math.min(bar, end);
      if (segEnd > cursor) {
        seconds += sceneBarsToSeconds(segEnd - Math.max(cursor, start), bpm, ticksPerBar(doc));
        cursor = segEnd;
      }
    }
    if (bar > cursor) seconds += sceneBarsToSeconds(bar - cursor, doc.bpm, ticksPerBar(doc));
    return seconds;
  };

  const formatBarAsSeconds = (bar: number): string => `${barToSeconds(bar).toFixed(1)}s`;

  /**
   * px→bar with an EXPLICIT divisor.
   *
   * `barFromEvent` below closes over the render's `barWidth`, which is only
   * correct for code that is not spanning a gesture. A drag must convert both
   * its grab and its live position with the same captured width, so the two
   * are always measured in the same unit system.
   */
  const barFromEventAt = (event: React.PointerEvent | React.DragEvent, width: number): number => {
    const lane = laneRef.current;
    if (!lane || !(width > 0)) return 0;
    const rect = lane.getBoundingClientRect();
    return Math.max(0, Math.floor((event.clientX - rect.left) / width));
  };

  const barFromEvent = (event: React.PointerEvent | React.DragEvent): number => barFromEventAt(event, barWidth);

  // Audio trim/move/fade gestures need sub-bar precision. Keep the snapped
  // bar helper above for scene clips, whose arrangement moves are bar-based.
  //
  // Unlike `barFromEvent` this one has no `width`-less form: EVERY audio
  // gesture spans a pointerdown→pointerup window in which Ctrl+wheel can
  // change the zoom, so each call site must pass the width it captured for
  // that gesture (`cur.barWidth`).
  const audioBarFromEventAt = (event: React.PointerEvent, width: number): number => {
    const lane = laneRef.current;
    if (!lane || !(width > 0)) return 0;
    const rect = lane.getBoundingClientRect();
    return Math.max(0, (event.clientX - rect.left) / width);
  };

  /**
   * RIPPLE LEFT FLOOR (command twin lives in moveArrangementClipRipple): the
   * end bar of the stationary clip directly before a ripple block — the block
   * may slide left up to it, never across it. Without the floor the ghost
   * previewed an overlap the commit then wrote (and the per-clip max(0, …)
   * piled the tail onto bar 0).
   */
  const ripplePredecessorEnd = (movingIds: readonly string[], origStarts: Record<string, number>): number => {
    const minStart = Math.min(...Object.values(origStarts));
    const moving = new Set(movingIds);
    return doc.arrangement.clips
      .filter((c) => !moving.has(c.id) && c.startBar + c.lengthBars <= minStart)
      .reduce((max, c) => Math.max(max, c.startBar + c.lengthBars), 0);
  };

  const beginClipDrag = (event: React.PointerEvent, clipId: string, mode: "move" | "resize" | "trimStart") => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const clip = clips.find((candidate) => candidate.id === clipId);
    if (!clip) return;
    setSelectedClipId(clipId);
    // Ctrl+click toggles the clip in the multi-selection (no drag).
    if (event.ctrlKey || event.metaKey) {
      const ids = selectionStore.isClipSelected(clipId)
        ? selection.clipIds.filter((id) => id !== clipId)
        : [...selection.clipIds, clipId];
      selectionStore.setClips(ids);
      return;
    }
    // Shift+click selects the range from the last selected clip.
    if (event.shiftKey) {
      const last = selection.clipIds.at(-1);
      const a = clips.findIndex((c) => c.id === last);
      const b = clips.findIndex((c) => c.id === clipId);
      selectionStore.setClips(
        a !== -1 && b !== -1 ? clips.slice(Math.min(a, b), Math.max(a, b) + 1).map((c) => c.id) : [clipId],
      );
      return;
    }
    // A grouped clip always moves its complete cross-lane group, even when
    // the group selection is active. This keeps the gesture semantics the
    // same whichever lane supplied the pointerdown.
    if (mode === "move") {
      const liveDoc = services.store.doc;
      const group = liveDoc.arrangement.clipGroups?.find((candidate) => candidate.clipIds.includes(clipId));
      const liveIds = new Set(timelineItemsOf(liveDoc).map((item) => item.id));
      const groupClipIds = group?.clipIds ?? [];
      const liveGroupIds = groupClipIds.filter((id) => liveIds.has(id));
      if (group && liveGroupIds.length > 1) {
        const liveClip = liveDoc.arrangement.clips.find((candidate) => candidate.id === clipId);
        if (!liveClip) return;
        const groupHasScene = liveDoc.arrangement.clips.some((candidate) => liveGroupIds.includes(candidate.id));
        selectionStore.setClips(liveGroupIds);
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          mode,
          clipId,
          pointerId: event.pointerId,
          origStart: liveClip.startBar,
          origLength: liveClip.lengthBars,
          grabBar: barFromEventAt(event, barWidth),
          barWidth,
          groupId: group.id,
          groupClipIds: [...groupClipIds],
          groupHasScene,
          groupDeltaTicks: 0,
        };
        setClipDrag({ startBar: liveClip.startBar, lengthBars: liveClip.lengthBars });
        setClipMultiDrag(null);
        publishTimelineGroupDragPreview(liveDoc, group.id, groupClipIds);
        dragGuard.arm();
        return;
      }
    }
    // Plain press on a clip inside an active multi-selection moves ALL
    // selected clips together (resize stays single-clip).
    if (mode === "move" && selection.clipIds.length > 1 && selectionStore.isClipSelected(clipId)) {
      const movingIds = selection.clipIds.filter((id) => clips.some((c) => c.id === id));
      const origStarts = Object.fromEntries(movingIds.map((id) => [id, clips.find((c) => c.id === id)!.startBar]));
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        mode,
        clipId,
        pointerId: event.pointerId,
        origStart: clip.startBar,
        origLength: clip.lengthBars,
        grabBar: barFromEventAt(event, barWidth),
        barWidth,
        movingIds,
        origStarts,
        movingHasLocked: movingIds.some((id) => clips.find((c) => c.id === id)?.locked === true),
      };
      setClipDrag({ startBar: clip.startBar, lengthBars: clip.lengthBars });
      setClipMultiDrag(0);
      dragGuard.arm();
      return;
    }
    if (!selectionStore.isClipSelected(clipId)) selectionStore.setClips([clipId]);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      mode,
      clipId,
      pointerId: event.pointerId,
      origStart: clip.startBar,
      origLength: clip.lengthBars,
      grabBar: barFromEventAt(event, barWidth),
      barWidth,
    };
    setClipDrag({ startBar: clip.startBar, lengthBars: clip.lengthBars });
    dragGuard.arm();
  };

  const onClipPointerMove = (event: React.PointerEvent) => {
    const current = dragRef.current;
    if (!current) return;
    // The gesture's OWN scale, not the render's: Ctrl+wheel can change
    // `barWidth` mid-drag, and mixing the two scales silently mis-places the clip.
    const bar = barFromEventAt(event, current.barWidth);
    if (current.groupId && current.groupClipIds) {
      const liveDoc = services.store.doc;
      const liveGroup = liveDoc.arrangement.clipGroups?.find((group) => group.id === current.groupId);
      const groupStillMatches =
        liveGroup?.clipIds.length === current.groupClipIds.length &&
        current.groupClipIds.every((id) => liveGroup.clipIds.includes(id)) &&
        timelineItemsOf(liveDoc).some((item) => item.id === current.clipId);
      if (!groupStillMatches) {
        dragRef.current = null;
        setClipDrag(null);
        clearTimelineGroupDragPreview();
        return;
      }
      const deltaBars = current.groupHasScene
        ? Math.round(bar - current.grabBar)
        : snapDelta(bar - current.grabBar, snapBarsFor(snapGrid));
      const deltaTicks = Math.round(deltaBars * barUnit);
      const planned = nudgeClips(liveDoc, [current.clipId], deltaTicks / barUnit).execute(liveDoc);
      const nextScene = planned.arrangement.clips.find((clip) => clip.id === current.clipId);
      dragRef.current = { ...current, groupDeltaTicks: deltaTicks };
      if (nextScene) setClipDrag({ startBar: nextScene.startBar, lengthBars: nextScene.lengthBars });
      publishTimelineGroupDragPreview(planned, current.groupId, current.groupClipIds);
      return;
    }
    if (current.movingIds) {
      // A locked member refuses the whole block: the ghost must not promise a
      // move the commit will reject. The preview still writes 0 rather than
      // null — the commit distinguishes "no pointermove at all" (a plain
      // click, which must stay silent) from "moved, but refused" by that.
      if (current.movingHasLocked) {
        setClipMultiDrag(0);
        return;
      }
      let delta = Math.max(bar - current.grabBar, -Math.min(...Object.values(current.origStarts ?? { 0: 0 })));
      // Ripple preview never crosses the stationary predecessor — the ghost
      // must show the position the commit actually writes.
      if (rippleMode && current.origStarts) {
        delta = Math.max(
          delta,
          ripplePredecessorEnd(current.movingIds, current.origStarts) - Math.min(...Object.values(current.origStarts)),
        );
      }
      setClipMultiDrag(delta);
      return;
    }
    if (current.mode === "move") {
      let startBar = Math.max(0, current.origStart + bar - current.grabBar);
      if (rippleMode)
        startBar = Math.max(startBar, ripplePredecessorEnd([current.clipId], { [current.clipId]: current.origStart }));
      setClipDrag({ startBar, lengthBars: current.origLength });
    } else if (current.mode === "trimStart") {
      // Left-trim: the START edge moves right (whole-bar contract), the end
      // edge never moves — at least one whole bar must remain.
      const newStart = Math.max(current.origStart + 1, Math.floor(bar));
      setClipDrag({ startBar: newStart, lengthBars: current.origStart + current.origLength - newStart });
    } else {
      setClipDrag({ startBar: current.origStart, lengthBars: Math.max(1, bar - current.origStart + 1) });
    }
  };

  // `event` is optional: the drag guard's stuck-drag fallback terminal calls
  // this without one. Capture release then no-ops, which is correct — there is
  // no live event target, and the spec releases capture implicitly anyway.
  const onClipPointerUp = (event?: React.PointerEvent) => {
    dragGuard.disarm();
    const current = dragRef.current;
    // Release before the ref is cleared — the pointerId only exists on the
    // gesture record. Idempotent and non-throwing (see the helper).
    releasePointerCaptureSafely(event?.currentTarget, current?.pointerId);
    // The refs, not the state: a release that lands in the same batch as the
    // final move would otherwise commit the previous frame's bar (see the
    // dragLiveRef note).
    const finalDrag = dragLiveRef.current;
    const delta = multiDragLiveRef.current;
    dragRef.current = null;
    setClipDrag(null);
    setClipMultiDrag(null);
    if (current?.groupId && current.groupClipIds) {
      clearTimelineGroupDragPreview();
      if (current.groupDeltaTicks === 0) return;
      const beforeDoc = services.store.doc;
      const liveGroup = beforeDoc.arrangement.clipGroups?.find((group) => group.id === current.groupId);
      const groupStillMatches =
        liveGroup?.clipIds.length === current.groupClipIds.length &&
        current.groupClipIds.every((id) => liveGroup.clipIds.includes(id)) &&
        timelineItemsOf(beforeDoc).some((item) => item.id === current.clipId);
      if (!groupStillMatches) return;
      execute(nudgeClips(beforeDoc, [current.clipId], (current.groupDeltaTicks ?? 0) / barUnit));
      return;
    }
    if (!current || !finalDrag) return;
    if (current.movingIds) {
      // Ahead of the `!delta` short-circuit: a click on a locked selection is
      // still just a selection, so only a gesture that actually moved reports.
      if (current.movingHasLocked) {
        if (delta !== null) setActionError("Selection contains a locked clip — unlock it to move the block");
        return;
      }
      if (!delta) return;
      const beforeDoc = services.store.doc;
      // A clip in the block can be deleted mid-drag (undo/collab). Moving a
      // dead id wrote a target from its stale startBar and could false-trip
      // the overlap guard with length 0 — drag only what is still live.
      const movingIds = current.movingIds.filter((id) => beforeDoc.arrangement.clips.some((c) => c.id === id));
      if (movingIds.length === 0) return;
      if (rippleMode) {
        // RIPPLE multi-move: the block and every later clip slide by the
        // same delta — gaps after the strip stay exactly as before. No
        // collision guard for the TAIL: later clips move WITH the block, so
        // they cannot collide with it. The one hard floor is the stationary
        // clip BEFORE the block (same discipline as the command twin): an
        // unclamped leftward drag landed the block ON its predecessor and
        // the per-clip Math.max(0, …) piled the tail onto bar 0.
        const minStart = Math.min(...movingIds.map((id) => current.origStarts?.[id] ?? 0));
        const flooredDelta = current.origStarts
          ? Math.max(delta, ripplePredecessorEnd(current.movingIds, current.origStarts) - minStart)
          : delta;
        const clips = beforeDoc.arrangement.clips
          .map((c) =>
            movingIds.includes(c.id) || c.startBar >= minStart
              ? // Round like the non-ripple branch below: `delta` comes from a
                // fractional pointer position, and a fractional startBar
                // persists off-grid (it also makes later resizes report an
                // overlap the user cannot see on the grid).
                { ...c, startBar: Math.max(0, Math.round(c.startBar + flooredDelta)) }
              : c,
          )
          .sort((a, b) => a.startBar - b.startBar);
        // ADR 0025: ripple is timeline-wide — audio clips at/after the block
        // ride the same whole-bar delta (the command twin does the same).
        const rippleAudio = (beforeDoc.arrangement.audioClips ?? []).map((c) =>
          c.startBar >= minStart
            ? { ...c, startBar: Math.max(0, quantizeAudioBar(c.startBar + flooredDelta, ticksPerBar(beforeDoc))) }
            : c,
        );
        // Tick-addressed lanes ride the same delta in TICKS: midi/automation
        // clips are bar-quantized here (the drag is whole-bar), which keeps
        // them tick-exact — the command twin applies the identical math.
        const barUnit = ticksPerBar(beforeDoc);
        const deltaTicks = Math.round(flooredDelta * barUnit);
        const rippleTickLane = <T extends { startTick: number }>(lane: readonly T[] | undefined): T[] | undefined =>
          (lane ?? []).map((c) =>
            c.startTick >= minStart * barUnit ? { ...c, startTick: Math.max(0, c.startTick + deltaTicks) } : c,
          );
        const nextDoc: ProjectDocument = {
          ...beforeDoc,
          arrangement: {
            ...beforeDoc.arrangement,
            clips,
            audioClips: rippleAudio,
            midiClips: rippleTickLane(beforeDoc.arrangement.midiClips),
            automationClips: rippleTickLane(beforeDoc.arrangement.automationClips),
            transitions: transitionsForClips(beforeDoc, clips),
          },
        };
        services.store.execute({
          type: "moveClipsRipple",
          label: `Ripple move ${current.movingIds.length} clips`,
          execute: () => nextDoc,
          undo: () => beforeDoc,
        });
        return;
      }
      // One gesture = one undo entry, regardless of how many clips moved.
      // The whole BLOCK moves to its final state at once: applying per-clip
      // `moveArrangementClip` would validate overlaps against INTERMEDIATE
      // states (moving adjacent clips by the same delta collides mid-way
      // even though the final layout is clean). Only stationary clips guard.
      const target = (id: string) => Math.max(0, Math.round((current.origStarts?.[id] ?? 0) + delta));
      for (const id of movingIds) {
        const start = target(id);
        const length = beforeDoc.arrangement.clips.find((c) => c.id === id)?.lengthBars ?? 0;
        const collides = beforeDoc.arrangement.clips.some(
          (c) => !movingIds.includes(c.id) && c.startBar < start + length && c.startBar + c.lengthBars > start,
        );
        if (collides) {
          setActionError("Clips would overlap — move cancelled");
          return;
        }
      }
      const nextDoc: ProjectDocument = {
        ...beforeDoc,
        arrangement: {
          ...beforeDoc.arrangement,
          clips: beforeDoc.arrangement.clips
            .map((c) => (movingIds.includes(c.id) ? { ...c, startBar: target(c.id) } : c))
            .sort((a, b) => a.startBar - b.startBar),
        },
      };
      services.store.execute({
        type: "moveClips",
        label: `Move ${movingIds.length} clips`,
        execute: () => nextDoc,
        undo: () => beforeDoc,
      });
      return;
    }
    if (current.mode === "move" && finalDrag.startBar !== current.origStart) {
      try {
        if (rippleMode) execute(moveArrangementClipRipple(services.store.doc, current.clipId, finalDrag.startBar));
        else execute(moveArrangementClip(services.store.doc, current.clipId, finalDrag.startBar));
      } catch (error) {
        // The factory throws before `execute`'s guard can run. Surfaced rather
        // than swallowed: a locked clip refused here is information the user
        // needs, and "drag did nothing" is not a self-explaining outcome.
        setActionError(error instanceof Error ? error.message : "Operation failed");
      }
    }
    if (current.mode === "resize" && finalDrag.lengthBars !== current.origLength) {
      try {
        if (rippleMode) execute(resizeArrangementClipRipple(services.store.doc, current.clipId, finalDrag.lengthBars));
        else execute(resizeArrangementClip(services.store.doc, current.clipId, finalDrag.lengthBars));
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Operation failed");
      }
    }
    if (current.mode === "trimStart" && finalDrag.startBar !== current.origStart) {
      try {
        execute(trimArrangementClipStart(services.store.doc, current.clipId, finalDrag.startBar));
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Operation failed");
      }
    }
  };

  // Interrupted clip drag — abort without moving/resizing.
  const onClipPointerCancel = (event?: React.PointerEvent) => {
    dragGuard.disarm();
    releasePointerCaptureSafely(event?.currentTarget, dragRef.current?.pointerId);
    dragRef.current = null;
    setClipDrag(null);
    setClipMultiDrag(null);
    clearTimelineGroupDragPreview();
  };

  // Ripple mode (arrangement-as-a-tool): moves/resizes/deletes shift every
  // later clip to preserve the gaps after the edit.
  const [rippleMode, setRippleMode] = useState(false);
  // Editing tool (select | cut) — see ToolStore for why the union is two
  // entries. The cut branch lives in the clip pointerdown handlers below.
  const tool = useTool();
  const toolStore = useToolStore();
  // Snap grid (view preference, persisted per-browser — see ./snap.ts for the
  // scope/precision/modifier contracts). "off" keeps the exact pre-snap
  // behavior (free position at tick storage precision).
  // One UI-wide snap preference: the toolbar select AND the J key read the
  // same controller, so they can never disagree.
  const snapGrid = useSyncExternalStore(snapController.subscribe, snapController.getGrid);
  const changeSnapGrid = (id: SnapGridId): void => snapController.setGrid(id);
  /** Delete arrangement clips (single or multi) as ONE undoable gesture + toast. */
  const deleteClipsWithToast = (ids: string[], ripple = false) => {
    if (ids.length === 0) return;
    const beforeDoc = services.store.doc;
    let nextDoc = beforeDoc;
    let firstName = "";
    if (ripple || rippleMode) {
      // RIPPLE delete: every removed clip closes its gap. Deleting from the
      // LAST clip backwards keeps earlier shifts exact, and each command
      // re-derives transitions for the shifted layout.
      const removed = ids
        .map((id) => beforeDoc.arrangement.clips.find((c) => c.id === id))
        .filter((clip): clip is NonNullable<typeof clip> => Boolean(clip))
        .sort((a, b) => b.startBar - a.startBar);
      firstName =
        removed.length > 0
          ? (scenes.find((sceneItem) => sceneItem.id === removed[0]!.sceneId)?.name ?? "clip")
          : "clip";
      for (const clip of removed) {
        nextDoc = deleteArrangementClipRipple(nextDoc, clip.id).execute(nextDoc);
      }
    } else {
      for (const id of ids) {
        const clip = beforeDoc.arrangement.clips.find((c) => c.id === id);
        if (clip) {
          if (!nextDoc.arrangement.clips.some((candidate) => candidate.id === id)) continue;
          const scene = scenes.find((sceneItem) => sceneItem.id === clip.sceneId);
          if (!firstName) firstName = scene?.name ?? "clip";
          nextDoc = deleteArrangementClip(nextDoc, id).execute(nextDoc);
          continue;
        }
        const item = timelineItemsOf(beforeDoc).find((candidate) => candidate.id === id);
        if (!item) continue;
        if (!firstName) firstName = item.kind === "automation" ? "automation" : item.kind === "midi" ? "MIDI" : "audio";
        if (item.kind === "audio") nextDoc = deleteAudioClip(nextDoc, id).execute(nextDoc);
        else if (item.kind === "midi") nextDoc = deleteMidiClip(nextDoc, id).execute(nextDoc);
        else if (item.kind === "automation") nextDoc = deleteAutomationClip(nextDoc, id).execute(nextDoc);
      }
    }
    if (nextDoc === beforeDoc) return;
    const label = ids.length === 1 ? `Deleted "${firstName}"` : `Deleted ${ids.length} clips`;
    services.store.execute({ type: "deleteClips", label, execute: () => nextDoc, undo: () => beforeDoc });
    if (selectedClipId && ids.includes(selectedClipId)) setSelectedClipId(null);
    // The multi-selection store is UI state the command cannot reach (same
    // ownership as pruneTrack) — dead ids here leaked into the context-menu
    // header count and left `P` locators-to-loop silently dead.
    selectionStore.retainClips([
      ...nextDoc.arrangement.clips.map((c) => c.id),
      ...(nextDoc.arrangement.audioClips ?? []).map((c) => c.id),
      ...(nextDoc.arrangement.midiClips ?? []).map((c) => c.id),
      ...(nextDoc.arrangement.automationClips ?? []).map((c) => c.id),
    ]);
    setDeleteToast({ label });
  };

  const beginAudioDrag = (
    event: React.PointerEvent,
    clipId: string,
    // Mirrors the audioDragRef `mode` union exactly — `"trimEnd"` removed with
    // it, since no call site passes it and no move branch handled it.
    mode: "move" | "resize" | "trimStart" | "fadeIn" | "fadeOut" | "gain" | "stretch" | "slip",
    edge: "left" | "right" = "right",
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const clip = audioClips.find((c) => c.id === clipId);
    if (!clip) return;
    setSelectedAudioClipId(clipId);
    setSelectedClipId(null);
    // SHARED-SELECTION PARITY: audio clips feed the same selectionStore as
    // scene clips, so keyboard Delete, `P` locators, the context menu and the
    // marquee see them identically. Semantics mirror beginClipDrag.
    if (mode === "move") {
      // Ctrl+click toggles the clip in the multi-selection (no drag).
      if (event.ctrlKey || event.metaKey) {
        selectionStore.setClips(
          selectionStore.isClipSelected(clipId)
            ? selection.clipIds.filter((id) => id !== clipId)
            : [...selection.clipIds, clipId],
        );
        return;
      }
      // Shift+click selects the range from the last selected clip (bar order).
      if (event.shiftKey) {
        const ordered = [...audioClips].sort((a, b) => a.startBar - b.startBar);
        const last = selection.clipIds.at(-1);
        const a = ordered.findIndex((c) => c.id === last);
        const b = ordered.findIndex((c) => c.id === clipId);
        selectionStore.setClips(
          a !== -1 && b !== -1 ? ordered.slice(Math.min(a, b), Math.max(a, b) + 1).map((c) => c.id) : [clipId],
        );
        return;
      }
    }
    let groupDragInfo: { groupId: string; groupClipIds: string[]; groupHasScene: boolean } | undefined;
    if (mode === "move") {
      const liveDoc = services.store.doc;
      const group = liveDoc.arrangement.clipGroups?.find((candidate) => candidate.clipIds.includes(clipId));
      const groupClipIds = group?.clipIds ?? [];
      const liveIds = new Set(timelineItemsOf(liveDoc).map((item) => item.id));
      const liveGroupIds = groupClipIds.filter((id) => liveIds.has(id));
      if (group && liveGroupIds.length > 1) {
        groupDragInfo = {
          groupId: group.id,
          groupClipIds: [...groupClipIds],
          groupHasScene: liveDoc.arrangement.clips.some((candidate) => liveGroupIds.includes(candidate.id)),
        };
        selectionStore.setClips(liveGroupIds);
      }
    }
    if (!selectionStore.isClipSelected(clipId)) selectionStore.setClips([clipId]);
    // Plain press on a selected clip inside an active multi-selection moves
    // all selected audio clips together. A persisted clip group takes the
    // cross-lane path above; this branch is for ad hoc selection blocks.
    let movingIds: string[] | undefined =
      !groupDragInfo && mode === "move" && selection.clipIds.length > 1 && selectionStore.isClipSelected(clipId)
        ? selection.clipIds.filter((id) => audioClips.some((c) => c.id === id))
        : undefined;
    const multiMoving = movingIds !== undefined && movingIds.length > 1 ? movingIds : undefined;
    const origStarts =
      multiMoving !== undefined
        ? Object.fromEntries(multiMoving.map((id) => [id, audioClips.find((c) => c.id === id)!.startBar]))
        : undefined;
    event.currentTarget.setPointerCapture(event.pointerId);
    // Wall-clock sensitivity for THIS clip's span at the scenes' effective
    // tempos (average sec/bar). doc.bpm alone disagreed with playback whenever
    // a scene pinned a different tempo — the fade handle moved at the wrong
    // rate and trim wrote offsets against a wall clock nothing runs at.
    const clipWallSec = arrangementSecondsBetweenTicks(
      clips,
      scenes,
      clip.startBar * ticksPerBar(doc),
      (clip.startBar + clip.lengthBars) * ticksPerBar(doc),
      doc.bpm,
      ticksPerBar(doc),
    );
    // SLIP gate (Alt+drag in the body): the slip writes offsetSec, whose
    // mapping is only defined for linear forward playback — reversed clips
    // read the source backwards, looped clips phase through loopPhaseOffsetSec,
    // and warp-pinned clips anchor content by arrangement tick (a slip would
    // need to shift the pins). Same family as the live-resume gate.
    if (mode === "slip" && (clip.reverse || clip.loop === true || (clip.warpMarkers?.length ?? 0) > 0)) return;
    // Content-coverage ceiling for the slip: the playable window
    // [offset+trimStart, bufferDur−trimEnd] must keep covering the clip's
    // wall length (source seconds scale by the rate). Commands cannot reach
    // the sample bank — the gesture injects the duration, the same pattern as
    // splitAudioClipAtTick's sourceDuration.
    const slipBuffer = mode === "slip" ? services.bank.get(clip.bufferId) : undefined;
    // Wall length in SOURCE seconds: the clip consumes `wall ×
    // sourceSecondsPerWallSecond` of the original sample. The factor is the
    // rate for a resample clip and `1 / rate` for a pitch-preserving stretch
    // clip — one owner for the rule (`audioClipSourceSecondsPerWallSecond`).
    const sourcePerWallSecond = audioClipSourceSecondsPerWallSecond(clip);
    const slipWallSourceSec = mode === "slip" ? clipWallSec * sourcePerWallSecond : 0;
    const maxOffsetSec =
      mode === "slip" && slipBuffer
        ? Math.max(0, slipBuffer.duration - (clip.trimStart ?? 0) - (clip.trimEnd ?? 0) - slipWallSourceSec)
        : null;
    audioDragRef.current = {
      clipId,
      mode,
      edge,
      pointerId: event.pointerId,
      origStart: clip.startBar,
      origLength: clip.lengthBars,
      origRate: clip.stretchRate ?? 1,
      sourcePerWallSecond,
      origTrimStart: clip.trimStart ?? 0,
      origOffsetSec: clip.offsetSec ?? 0,
      maxOffsetSec,
      origFadeIn: clip.fadeIn ?? 0,
      origFadeOut: clip.fadeOut ?? 0,
      origGain: clip.gain ?? 1,
      grabBar: audioBarFromEventAt(event, barWidth),
      /** Same reason as the scene drag: one unit system per gesture. */
      barWidth,
      grabY: event.clientY,
      secPerBar: clip.lengthBars > 0 ? clipWallSec / clip.lengthBars : (barUnit * 60) / (doc.bpm * PPQ),
      ...(multiMoving !== undefined
        ? {
            movingIds: multiMoving,
            origStarts,
            movingHasLocked: multiMoving.some((id) => audioClips.find((c) => c.id === id)?.locked === true),
          }
        : {}),
      ...(groupDragInfo ? { ...groupDragInfo, groupDeltaTicks: 0 } : {}),
    };
    dragGuard.arm();
    if (multiMoving !== undefined) setAudioMultiDragLive(0);
    if (mode === "fadeIn" || mode === "fadeOut")
      setAudioFadeLive({ clipId, fadeIn: clip.fadeIn ?? 0, fadeOut: clip.fadeOut ?? 0 });
    if (mode === "gain") setAudioGainLive({ clipId, gain: clip.gain ?? 1 });
    setAudioDragLive({ startBar: clip.startBar, lengthBars: clip.lengthBars });
    if (groupDragInfo)
      publishTimelineGroupDragPreview(services.store.doc, groupDragInfo.groupId, groupDragInfo.groupClipIds);
  };
  /**
   * Secondary snap targets for an audio gesture (in bars): every OTHER audio
   * clip's start/end edges, marker ticks and the transport loop bounds.
   * Recomputed per event — clip counts are small and the answer must always
   * be live (a neighbour added mid-gesture still catches the pointer).
   */
  const audioSnapTargetBars = (draggedClipId: string): number[] => {
    const targets: number[] = [];
    for (const clip of audioClips) {
      if (clip.id === draggedClipId) continue;
      targets.push(clip.startBar, clip.startBar + clip.lengthBars);
    }
    for (const marker of doc.markers ?? []) targets.push(marker.tick / barUnit);
    if (services.transport.loopEnabled) {
      // loopEnd === 0 is a SENTINEL, not bar 0 — see loopSnapTargetBars.
      targets.push(...loopSnapTargetBars(true, services.transport.loopStart, services.transport.loopEnd, barUnit));
    }
    return targets;
  };

  const onAudioPointerMove = (event: React.PointerEvent) => {
    const cur = audioDragRef.current;
    if (!cur) return;
    // The gesture's own scale, not the render's — Ctrl+wheel can zoom
    // mid-drag, and mixing scales mis-places every audio gesture.
    const bar = audioBarFromEventAt(event, cur.barWidth);
    const delta = bar - cur.grabBar;
    const secPerBar = cur.secPerBar;
    // Snap grid for THIS event: Shift suspends it (the DAW convention).
    // Fades/gain/slip live in source-time/audio-rate domains — never snapped.
    const grid = event.shiftKey ? null : snapBarsFor(snapGrid);
    // THE FLOOR OF AN EDGE GESTURE. The quarter-bar floor is a CREATION policy
    // (a clip drawn from scratch must be grabbable). A clip that is ALREADY
    // shorter than that — a split fragment, a comp fragment — must never be
    // INFLATED by an edge gesture: the preview used to show a 0.05-bar
    // fragment growing to a quarter bar while the user dragged its edge
    // *shorter*, and the commit stored that longer clip. The preview and the
    // commit share this floor, so the geometry the user is shown is the
    // geometry that lands.
    const editFloorBars = Math.min(MIN_NEW_AUDIO_CLIP_BARS, cur.origLength);
    if (cur.groupId && cur.groupClipIds) {
      const liveDoc = services.store.doc;
      const liveGroup = liveDoc.arrangement.clipGroups?.find((group) => group.id === cur.groupId);
      const groupStillMatches =
        liveGroup?.clipIds.length === cur.groupClipIds.length &&
        cur.groupClipIds.every((id) => liveGroup.clipIds.includes(id)) &&
        timelineItemsOf(liveDoc).some((item) => item.id === cur.clipId);
      if (!groupStillMatches) {
        audioDragRef.current = null;
        clearAudioDragLive();
        clearTimelineGroupDragPreview();
        return;
      }
      const deltaBars = cur.groupHasScene ? Math.round(delta) : snapDelta(delta, grid);
      const deltaTicks = Math.round(deltaBars * barUnit);
      const planned = nudgeClips(liveDoc, [cur.clipId], deltaTicks / barUnit).execute(liveDoc);
      const nextAudio = (planned.arrangement.audioClips ?? []).find((clip) => clip.id === cur.clipId);
      audioDragRef.current = { ...cur, groupDeltaTicks: deltaTicks };
      if (nextAudio) setAudioDragLive({ startBar: nextAudio.startBar, lengthBars: nextAudio.lengthBars });
      publishTimelineGroupDragPreview(planned, cur.groupId, cur.groupClipIds);
      return;
    }
    // Secondary snap targets (B-vlna): other clips' edges, markers and loop
    // bounds catch the pointer within an 8 px pull, overriding a closer grid
    // line — "snap my start to the neighbour" is the everyday case. Grid OFF
    // stays completely free; targets are part of snapping, not a separate
    // always-on layer.
    const snapTargets = grid === null ? [] : audioSnapTargetBars(cur.clipId);
    const snapThresholdBars = 8 / cur.barWidth;
    const snapTo = (bar: number): number => snapBarToTargets(bar, grid, snapTargets, snapThresholdBars);
    // Block move: one shared delta for every selected audio clip, floored so
    // the leftmost clip cannot cross bar 0 (mirrors the scene block move).
    // Delta-snapped (not per-clip absolute): the block's internal spacing
    // must survive — absolute snapping would collapse between-grid offsets.
    if (cur.movingIds) {
      if (cur.movingHasLocked) {
        // 0, not null — see the scene block move: the commit needs to tell a
        // refused drag apart from a click that never moved.
        setAudioMultiDragLive(0);
        return;
      }
      setAudioMultiDragLive(Math.max(snapDelta(delta, grid), -Math.min(...Object.values(cur.origStarts ?? { 0: 0 }))));
      return;
    }
    if (cur.mode === "move")
      setAudioDragLive({
        startBar: Math.max(0, snapTo(cur.origStart + delta)),
        lengthBars: cur.origLength,
      });
    else if (cur.mode === "resize") {
      // Snap the END edge (musical: land on a grid line), start stays put.
      const endEdge = snapTo(cur.origStart + cur.origLength + delta);
      setAudioDragLive({ startBar: cur.origStart, lengthBars: Math.max(editFloorBars, endEdge - cur.origStart) });
    } else if (cur.mode === "trimStart") {
      // Snap the START edge; the length is whatever remains up to the fixed end.
      //
      // EXTEND-LEFT IS BOUNDED BY THE SOURCE'S HEADROOM. `offsetSec` is a
      // position in the ORIGINAL sample, so the source can only move back as
      // far as the file goes back: `origOffsetSec` seconds of headroom, which
      // is `headroom / factor` wall seconds, which is `headroomBars` bars.
      // Without the bound the head moved left with no material behind it, the
      // commit clamped the source position to 0, and the clip silently grew
      // while playing the SAME material — the gesture stopped meaning "reveal
      // earlier material". The head now stops at the file's start.
      const headroomBars = cur.origOffsetSec / cur.sourcePerWallSecond / secPerBar;
      const newStart = Math.max(0, cur.origStart - headroomBars, snapTo(cur.origStart + delta));
      const newLen = Math.max(editFloorBars, cur.origStart + cur.origLength - newStart);
      setAudioDragLive({ startBar: newStart, lengthBars: newLen });
    } else if (cur.mode === "stretch") {
      // Alt+drag: length follows the pointer like resize/trim, the rate
      // follows the length ratio (previewStretchRate) — the content keeps
      // filling the clip. Right edge pins the start (snap the end edge like
      // resize), left edge pins the end (snap the start like trimStart).
      if (cur.edge === "right") {
        const newLen = Math.max(editFloorBars, snapTo(cur.origStart + cur.origLength + delta) - cur.origStart);
        setAudioDragLive({ startBar: cur.origStart, lengthBars: newLen });
        setAudioStretchLive({
          clipId: cur.clipId,
          rate: previewStretchRate(cur.origRate, cur.origLength, newLen),
        });
      } else {
        const newStart = Math.max(0, snapTo(cur.origStart + delta));
        const newLen = Math.max(editFloorBars, cur.origStart + cur.origLength - newStart);
        setAudioDragLive({ startBar: newStart, lengthBars: newLen });
        setAudioStretchLive({
          clipId: cur.clipId,
          rate: previewStretchRate(cur.origRate, cur.origLength, newLen),
        });
      }
    } else if (cur.mode === "slip") {
      // Content follows the pointer: dragging the content LEFT reveals later
      // source material (offset grows), right reveals earlier (offset
      // shrinks). Ceiling keeps the playable window covering the whole clip.
      //
      // `offsetSec` is a position in the ORIGINAL sample, so the pointer's
      // WALL travel has to be converted before it is written: one wall second
      // of drag moves the source by `sourceSecondsPerWallSecond` source
      // seconds (the rate for a resample clip, `1 / rate` for a
      // pitch-preserving stretch clip). Without the factor the content lagged
      // the pointer by the rate on a stretched clip — and the ceiling above,
      // which is source-denominated, disagreed with the movement.
      const next = Math.max(
        0,
        Math.min(
          cur.maxOffsetSec ?? Number.POSITIVE_INFINITY,
          cur.origOffsetSec - delta * secPerBar * cur.sourcePerWallSecond,
        ),
      );
      setAudioSlipLive({ clipId: cur.clipId, offsetSec: next });
    } else if (cur.mode === "fadeIn") {
      const deltaSec = delta * secPerBar;
      const clipSec = cur.origLength * secPerBar;
      const maxFade = Math.min(2, clipSec * 0.5);
      const next = Math.max(0, Math.min(maxFade, cur.origFadeIn + deltaSec));
      setAudioFadeLive({ clipId: cur.clipId, fadeIn: next, fadeOut: cur.origFadeOut });
    } else if (cur.mode === "fadeOut") {
      const deltaSec = delta * secPerBar;
      const clipSec = cur.origLength * secPerBar;
      const maxFade = Math.min(2, clipSec * 0.5);
      const next = Math.max(0, Math.min(maxFade, cur.origFadeOut - deltaSec));
      setAudioFadeLive({ clipId: cur.clipId, fadeIn: cur.origFadeIn, fadeOut: next });
    } else if (cur.mode === "gain") {
      const deltaY = cur.grabY - event.clientY;
      const nextGain = Math.max(0, Math.min(2, cur.origGain + deltaY / 80));
      setAudioGainLive({ clipId: cur.clipId, gain: nextGain });
    }
  };
  const onAudioPointerUp = (event?: React.PointerEvent) => {
    dragGuard.disarm();
    const cur = audioDragRef.current;
    // Release before the ref is cleared. Falls back to the releasing event for
    // the case where the gesture record is already gone.
    releasePointerCaptureSafely(event?.currentTarget, cur?.pointerId ?? event?.pointerId);
    // The refs, not the state: a release that lands in the same batch as the
    // final move would otherwise commit the previous frame's geometry — and
    // for the fade/gain modes the staleness guard would swallow the commit
    // entirely (see the audioDragLiveRef note).
    const final = audioDragLiveRef.current;
    const fadePrev = audioFadeLiveRef.current;
    const gainPrev = audioGainLiveRef.current;
    const stretchPrev = audioStretchLiveRef.current;
    const slipPrev = audioSlipLiveRef.current;
    const multiDelta = audioMultiDragLiveRef.current;
    audioDragRef.current = null;
    clearAudioDragLive();
    if (!cur) return;
    if (cur.groupId && cur.groupClipIds) {
      clearTimelineGroupDragPreview();
      if (cur.groupDeltaTicks === 0) return;
      const beforeDoc = services.store.doc;
      const liveGroup = beforeDoc.arrangement.clipGroups?.find((group) => group.id === cur.groupId);
      const groupStillMatches =
        liveGroup?.clipIds.length === cur.groupClipIds.length &&
        cur.groupClipIds.every((id) => liveGroup.clipIds.includes(id)) &&
        timelineItemsOf(beforeDoc).some((item) => item.id === cur.clipId);
      if (!groupStillMatches) return;
      execute(nudgeClips(beforeDoc, [cur.clipId], (cur.groupDeltaTicks ?? 0) / barUnit));
      return;
    }
    // BLOCK MOVE: every selected audio clip slides by the shared delta in ONE
    // command (one gesture = one undo entry). AudioClips LAYER — the
    // documented overlap contract means no collision guard, unlike the scene
    // block move. 0.01-bar quantize matches moveAudioClip.
    if (cur.movingIds) {
      // Ahead of the `!multiDelta` short-circuit, for the same reason as the
      // scene block move: a click is silent, a refused drag reports.

      if (cur.movingHasLocked) {
        if (multiDelta !== null) setActionError("Selection contains a locked clip — unlock it to move the block");
        return;
      }
      // Press+release without movement is a click — selection already changed
      // at pointerdown; nothing to commit (mirrors the scene block move).
      if (!multiDelta) return;
      const beforeDoc = services.store.doc;
      // A clip in the block can be deleted mid-gesture (undo/collab) — move
      // only what is still live (same discipline as the scene block move).
      const movingIds = cur.movingIds.filter((id) => (beforeDoc.arrangement.audioClips ?? []).some((c) => c.id === id));
      if (movingIds.length === 0) return;

      const nextAudioClips = (beforeDoc.arrangement.audioClips ?? [])
        .map((c) =>
          movingIds.includes(c.id)
            ? {
                ...c,
                // Tick storage precision (matches moveAudioClip) — a snapped
                // delta survives the commit exactly.
                startBar: Math.max(
                  0,
                  quantizeAudioBar((cur.origStarts?.[c.id] ?? c.startBar) + multiDelta, ticksPerBar(doc)),
                ),
              }
            : c,
        )
        .sort((a, b) => a.startBar - b.startBar);
      const nextDoc: ProjectDocument = {
        ...beforeDoc,
        arrangement: { ...beforeDoc.arrangement, audioClips: nextAudioClips },
      };
      services.store.execute({
        type: "moveAudioClips",
        label: `Move ${movingIds.length} audio clips`,
        execute: () => nextDoc,
        undo: () => beforeDoc,
      });
      return;
    }
    // The command FACTORIES below throw before `execute`'s own try/catch can
    // run — `execute(factory(...))` evaluates the factory first. A locked clip
    // (or a clip deleted mid-drag) therefore reached this handler as an
    // UNCAUGHT exception: no message, no commit, an error in the console. One
    // guard here covers every branch below, exactly like `execute` covers the
    // store call itself.
    try {
      if (cur.mode === "move" && final && final.startBar !== cur.origStart)
        execute(moveAudioClip(services.store.doc, cur.clipId, final.startBar));
      else if (cur.mode === "resize" && final && final.lengthBars !== cur.origLength)
        execute(resizeAudioClip(services.store.doc, cur.clipId, final.lengthBars));
      else if (cur.mode === "stretch" && final && stretchPrev && stretchPrev.clipId === cur.clipId) {
        const rateChanged = Math.abs(stretchPrev.rate - cur.origRate) > 0.005;
        if (final.lengthBars !== cur.origLength || rateChanged)
          execute(stretchAudioClip(services.store.doc, cur.clipId, final.lengthBars, stretchPrev.rate));
      } else if (cur.mode === "trimStart" && final) {
        // Source-time delta of the drag, integrated at the scenes' effective
        // tempos (signed: a leftward trim goes negative). doc.bpm here wrote
        // trim/offset against a wall clock nothing plays at under a pinned
        // scene — the trim handle and the audible skip disagreed.
        const deltaSec = arrangementSecondsBetweenTicks(
          clips,
          scenes,
          cur.origStart * ticksPerBar(doc),
          final.startBar * ticksPerBar(doc),
          doc.bpm,
          ticksPerBar(doc),
        );
        const lengthChanged = final.lengthBars !== cur.origLength;
        const startChanged = final.startBar !== cur.origStart;
        if (Math.abs(deltaSec) > 0.001 || lengthChanged || startChanged) {
          // The clip can be edited or deleted under this gesture (collab merge,
          // undo). `audioClips` is a render-scope memo, so it still holds the
          // PRE-change offsetSec here — passing that to a command that runs
          // against the LIVE document writes the new length onto the old source
          // position. `trimAudioClipStart` throws on a missing clip, so only a
          // changed offset slipped through: silently, the clip played the wrong
          // region of its sample. Same reasoning as the mid-drag dead-id filter
          // in `onClipPointerUp`; read the live clip, never the memo.
          const liveClip = (services.store.doc.arrangement.audioClips ?? []).find((c) => c.id === cur.clipId);
          if (!liveClip) return;
          // `deltaSec` above is WALL time on the timeline; `trimStart` and
          // `offsetSec` are positions in the ORIGINAL sample, so ONE WALL
          // SECOND of trim moves the source by `sourceSecondsPerWallSecond`
          // source seconds. Without the factor the trim skipped the wrong
          // amount of the sample and the clip played a different region than
          // its waveform showed.
          //
          // The factor is NOT simply the rate: a pitch-preserving "stretch"
          // clip plays a pre-rendered `original × rate` buffer at
          // `playbackRate = 1`, so it consumes `1 / rate` original seconds
          // per wall second. `audioClipSourceSecondsPerWallSecond` is the one
          // owner of that rule (the split and the stem renderer use it too).
          const sourceDeltaSec = deltaSec * audioClipSourceSecondsPerWallSecond(liveClip);
          // ONE command for the whole trim: the source offset and the new length
          // are the same gesture. Two commands here meant a single Ctrl+Z undid
          // only the resize, leaving the clip playing a different region of the
          // sample at its original length.
          //
          // The AUDIBLE source start is `offsetSec + trimStart`
          // (audioClipPlayWindow). The trim advances that sum by exactly
          // `sourceDeltaSec`, so it advances `offsetSec` ONLY and leaves
          // `trimStart` riding untouched: advancing both counted the same skip
          // twice and the clip played twice as deep into the sample as the
          // gesture asked for. `offsetSec` is also the field the SPLIT uses to
          // carry the source advance (`elapsedSec * clip.stretchRate`), so the
          // two structural edits agree on where the source position lives.
          execute(
            trimAudioClipStart(services.store.doc, cur.clipId, {
              // The start edge moves RIGHT and the end edge never moves — the
              // same contract the scene-clip twin `trimArrangementClipStart`
              // owns. The commit used to leave `startBar` alone, so the clip
              // stayed where it was and shrank from the RIGHT while the drag
              // preview showed it moving right: the committed geometry and the
              // preview the user was looking at were two different clips.
              startBar: final.startBar,
              lengthBars: final.lengthBars,
              trimStart: liveClip.trimStart ?? 0,
              offsetSec: liveClip.offsetSec + sourceDeltaSec,
            }),
          );
        }
      } else if (cur.mode === "slip" && slipPrev && slipPrev.clipId === cur.clipId) {
        // 1 ms quantize: slip is audio-position precision, not a 2dp UI knob.
        if (Math.abs(slipPrev.offsetSec - cur.origOffsetSec) > 0.001)
          execute(slipAudioClip(services.store.doc, cur.clipId, Math.round(slipPrev.offsetSec * 1000) / 1000));
      } else if (cur.mode === "fadeIn" && fadePrev && fadePrev.clipId === cur.clipId) {
        if (Math.abs(fadePrev.fadeIn - cur.origFadeIn) > 0.005)
          execute(updateAudioClip(services.store.doc, cur.clipId, { fadeIn: Math.round(fadePrev.fadeIn * 100) / 100 }));
      } else if (cur.mode === "fadeOut" && fadePrev && fadePrev.clipId === cur.clipId) {
        if (Math.abs(fadePrev.fadeOut - cur.origFadeOut) > 0.005)
          execute(
            updateAudioClip(services.store.doc, cur.clipId, { fadeOut: Math.round(fadePrev.fadeOut * 100) / 100 }),
          );
      } else if (cur.mode === "gain" && gainPrev && gainPrev.clipId === cur.clipId) {
        if (Math.abs(gainPrev.gain - cur.origGain) > 0.01)
          execute(updateAudioClip(services.store.doc, cur.clipId, { gain: Math.round(gainPrev.gain * 100) / 100 }));
        void event;
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Operation failed");
    }
  };

  // Interrupted audio drag — abort; previews clear with the drag state.
  const onAudioPointerCancel = (event?: React.PointerEvent) => {
    dragGuard.disarm();
    releasePointerCaptureSafely(event?.currentTarget, audioDragRef.current?.pointerId);
    audioDragRef.current = null;
    clearAudioDragLive();
    clearTimelineGroupDragPreview();
  };

  /**
   * GLOBAL GESTURE TERMINATOR (§20 cancel and recovery).
   *
   * Every drag machine in this panel wired exactly two terminals:
   * `onPointerUp` (commit) and `onPointerCancel` (abort). Escape and
   * window-blur are neither — and this panel registers no `window` pointerup
   * or blur listener, unlike its siblings `Sequencer.tsx:1766-1768` and
   * `App.tsx:422-423`.
   *
   * The consequence was destructive, not cosmetic: pressing Escape mid-drag
   * did NOT cancel. `dragRef.current` still held the `movingIds` captured at
   * gesture start, so releasing the mouse afterwards COMMITTED the move —
   * after the user pressed the cancel key. Worse, `App.tsx`'s contextual
   * Escape handler calls `selectionStore.clear()` at that same moment, so the
   * selection visibly vanished while the clip slid anyway.
   *
   * Losing window focus had the second half of the same bug: no pointercancel
   * is delivered, so the preview stayed latched — the clip painted at a drag
   * offset with no gesture behind it, until an unrelated re-render cleared it.
   *
   * One listener set, fanned out to every ref, closes both. It deliberately
   * does NOT stopPropagation: `App.tsx` still owns contextual Escape
   * (close menu → close help → clear selection → reset tool → blur input),
   * and cancelling a gesture is independent of that cascade.
   *
   * `pointercancel` is registered too: when the browser DOES deliver it to
   * the window (rather than the captured element) this is a backstop, and
   * both paths are idempotent.
   */
  const cancelAllArrangementGestures = useCallback(() => {
    dragRef.current = null;
    clearTimelineGroupDragPreview();
    // Live drag refs are cleared directly rather than through the
    // write-through setters: this callback has an empty dep array, and only
    // refs + setState are identity-stable. A stale live ref would otherwise
    // survive the cancel and leak into the NEXT drag's release commit.
    dragLiveRef.current = null;
    multiDragLiveRef.current = null;
    setDrag(null);
    setMultiDrag(null);
    audioDragRef.current = null;
    audioDragLiveRef.current = null;
    audioFadeLiveRef.current = null;
    audioGainLiveRef.current = null;
    audioStretchLiveRef.current = null;
    audioSlipLiveRef.current = null;
    audioMultiDragLiveRef.current = null;
    chordDragRef.current = null;
    chordDragLiveRef.current = null;
    setChordDrag(null);
    setAudioDrag(null);
    setAudioFadePreview(null);
    setAudioGainPreview(null);
    setAudioStretchPreview(null);
    setAudioSlipPreview(null);
    setAudioMultiDrag(null);
    marqueeStartRef.current = null;
    setMarquee(null);
    setTimeDrag(null);
    audioTakeLaneDragRef.current = null;
    setAudioTakeLaneRange(null);
    // Overlay drags (warp pins, scene-intensity points) live in child
    // components with their own refs. Bumping the epoch is how they learn a
    // cancel happened without this panel reaching into their internals.
    setOverlayCancelEpoch((n) => n + 1);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // Only act when a gesture is actually live — otherwise Escape stays
      // entirely with the app-level cascade.
      const live =
        dragRef.current !== null ||
        audioDragRef.current !== null ||
        marqueeStartRef.current !== null ||
        timeDrag !== null ||
        audioTakeLaneDragRef.current !== null;
      if (!live) return;
      cancelAllArrangementGestures();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", cancelAllArrangementGestures);
    window.addEventListener("pointercancel", cancelAllArrangementGestures);
    // Unmount mid-gesture (panel closed, project switched) must not leave the
    // child overlays armed against a parent that no longer exists.
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", cancelAllArrangementGestures);
      window.removeEventListener("pointercancel", cancelAllArrangementGestures);
    };
  }, [cancelAllArrangementGestures, timeDrag]);
  // The terminator above covers Escape / blur / window pointercancel. The one
  // case it cannot see: the captured CLIP ELEMENT unmounts mid-drag (its
  // delete command raced the gesture, via undo or a collab peer) — no
  // pointerup is delivered anywhere. The guard's window listener routes that
  // orphaned pointerup to the same commit handlers, and an unmount of this
  // panel to the same cancel. Handlers must stay latest-ref: the commit reads
  // the drag preview state, which moves on every pointermove re-render.
  dragGuard.handlers.current = {
    onEnd: () => {
      if (dragRef.current) onClipPointerUp();
      if (audioDragRef.current) onAudioPointerUp();
    },
    onCancel: cancelAllArrangementGestures,
  };
  const [bouncingZone, setBouncingZone] = useState(false);
  const [consolidatingAudio, setConsolidatingAudio] = useState(false);
  const consolidatingAudioRef = useRef(false);
  const consolidateSelectedAudioClips = async (clipIds: string[]): Promise<void> => {
    if (consolidatingAudioRef.current) return;
    consolidatingAudioRef.current = true;
    setConsolidatingAudio(true);
    let bufferId: string | undefined;
    let committed = false;
    try {
      const sourceDoc = services.store.doc;
      const plan = buildAudioClipConsolidationDoc(sourceDoc, clipIds);
      const sampleRate = services.engine.getLiveAudioContext()?.sampleRate ?? 44100;
      const { renderProject } = await import("../rendering/renderer");
      const buffer = await renderProject(plan.project, services.bank, {
        mode: "song",
        sampleRate,
        tailSeconds: 0,
        masterProcessing: false,
      });
      if (services.store.doc !== sourceDoc) {
        throw new Error("The project changed while rendering. Try consolidation again.");
      }

      const trackName = sourceDoc.tracks.find((track) => track.id === plan.trackId)?.name ?? "Audio";
      const uniqueSuffix = Math.random().toString(36).slice(2, 8);
      bufferId = userSampleId(`consolidated-${trackName}-${Date.now()}-${uniqueSuffix}`);
      const audioBytes = await encodeWavAsync(buffer, 32);
      await services.userSamples.save(
        {
          id: bufferId,
          name: `Consolidated ${trackName}`,
          fileName: `${bufferId}.wav`,
          category: "Custom",
          duration: buffer.duration,
          sampleRate: buffer.sampleRate,
          channels: buffer.numberOfChannels,
          createdAt: new Date().toISOString(),
        },
        audioBytes,
      );
      services.bank.add(bufferId, buffer);
      if (!execute(consolidateAudioClips(sourceDoc, clipIds, bufferId))) {
        services.bank.remove(bufferId);
        try {
          await services.userSamples.remove(bufferId);
        } catch {
          /* best-effort cleanup if the project command is rejected */
        }
        return;
      }
      committed = true;
    } catch (error) {
      if (bufferId && !committed) {
        services.bank.remove(bufferId);
        try {
          await services.userSamples.remove(bufferId);
        } catch {
          /* best-effort cleanup after a failed render or save */
        }
      }
      setActionError(error instanceof Error ? error.message : "Audio consolidation failed");
    } finally {
      consolidatingAudioRef.current = false;
      setConsolidatingAudio(false);
    }
  };
  const bounceZoneToClip = async () => {
    if (!selection.timeRange || bouncingZone) return;
    const fromBar = selection.timeRange.fromTick / barUnit;
    const lenBars = (selection.timeRange.toTick - selection.timeRange.fromTick) / barUnit;
    if (lenBars < 0.25) return;
    // Audit 11 D6: the fallback target must skip GROUP tracks — a group
    // alone renders silence (no generators on group nodes) and plants a
    // silent audio clip over the zone.
    const bounceable = tracks.filter((t) => t.kind !== "group");
    const trackIds = selection.trackIds.length > 0 ? selection.trackIds : bounceable.slice(0, 1).map((t) => t.id);
    setBouncingZone(true);
    try {
      // REAL bounce: offline-render the selected tracks (FX, groups, sends
      // included) for exactly the selected zone, then flip it to an audio
      // clip. No more placeholder sample standing in for the render.
      const zoneDoc = buildBounceZoneDoc(services.store.doc, trackIds, { startBar: fromBar, lengthBars: lenBars });
      const sr = services.engine.getLiveAudioContext()?.sampleRate ?? 44100;
      const { renderProject } = await import("../rendering/renderer");
      const buffer = await renderProject(zoneDoc, services.bank, { mode: "song", sampleRate: sr, tailSeconds: 2 });
      const bufferId = userSampleId(`bounce-${Math.round(fromBar)}b`);
      services.bank.add(bufferId, buffer);
      // Persist the WAV so the bounce survives reloads (bank is runtime-only).
      try {
        const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const detected = detectLoopBpm(buffer.getChannelData(0), buffer.sampleRate);
        await services.userSamples.save(
          {
            id: bufferId,
            name: `Bounce ${stamp}`,
            fileName: `${bufferId}.wav`,
            category: "Custom",
            duration: buffer.duration,
            sampleRate: buffer.sampleRate,
            channels: buffer.numberOfChannels,
            createdAt: new Date().toISOString(),
            ...(detected ? { bpm: detected.bpm } : {}),
          },
          encodeWav(buffer, 16),
        );
      } catch {
        /* persistence is best-effort — the take still plays this session */
      }
      if (
        !execute(addAudioClip(services.store.doc, trackIds[0], bufferId, fromBar, lenBars, { gain: 1, stretchRate: 1 }))
      ) {
        services.bank.remove(bufferId);
        try {
          await services.userSamples.remove(bufferId);
        } catch {
          /* best-effort cleanup */
        }
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Bounce failed");
    } finally {
      setBouncingZone(false);
    }
  };

  const placeScene = (sceneId: string, bar: number, lengthBars = 4) => {
    execute(addArrangementClip(services.store.doc, sceneId, bar, lengthBars));
  };

  const appendBar = (): number => clips.reduce((max, clip) => Math.max(max, clip.startBar + clip.lengthBars), 0);

  const createRoleVariation = (role: "fill" | "drop" | "break") => {
    if (!selectedScene) return;
    const length = role === "fill" ? 1 : (selectedClip?.lengthBars ?? 4);
    execute(createVariationAndPlaceClip(services.store.doc, selectedScene.id, appendBar(), length, role));
  };

  const selectTransitionBoundary = (fromClipId: string, toClipId: string) => {
    const existing = arrangement.transitions?.find(
      (transition) => transition.fromClipId === fromClipId && transition.toClipId === toClipId,
    );
    setTransitionBoundary({ fromClipId, toClipId });
    setTransitionDraft({
      type: existing?.type ?? "custom",
      lengthBars: existing?.lengthBars ?? 1,
      cueAssetId: existing?.cueAssetId ?? "",
    });
  };

  const applyTransition = () => {
    if (!transitionBoundary) return;
    if (selectedTransition) {
      execute(updateArrangementTransition(services.store.doc, selectedTransition.id, transitionDraft));
    } else {
      execute(
        addArrangementTransition(
          services.store.doc,
          transitionBoundary.fromClipId,
          transitionBoundary.toClipId,
          transitionDraft.type,
          transitionDraft.lengthBars,
          transitionDraft.cueAssetId,
        ),
      );
    }
  };

  // RIPPLE GHOST (ADR 0025): while a ripple drag moves, show where
  // every later clip will land (dashed outline at the shifted slot) —
  // scene AND audio clips. The audio threshold differs from the scene
  // one for single move/resize: audio clips may STRADDLE the moved clip
  // (layering), and the command only shifts audio at or after its END,
  // so the ghost must not preview a shift the commit will not make.
  const rippleGhost = (() => {
    if (!rippleMode) return null;
    const cur = dragRef.current;
    if (!cur) return null;
    if (cur.movingIds && multiDrag !== null) {
      const minStart = Math.min(...Object.values(cur.origStarts ?? { 0: 0 }));
      if (multiDrag === 0) return null;
      return { skip: cur.movingIds, fromScene: minStart, fromAudio: minStart, delta: multiDrag };
    }
    if (!drag) return null;
    if (cur.mode === "move" && drag.startBar !== cur.origStart) {
      return {
        skip: [cur.clipId],
        fromScene: cur.origStart,
        fromAudio: cur.origStart + cur.origLength,
        delta: drag.startBar - cur.origStart,
      };
    }
    if (cur.mode === "resize" && drag.lengthBars !== cur.origLength) {
      return {
        skip: [cur.clipId],
        fromScene: cur.origStart + cur.origLength,
        fromAudio: cur.origStart + cur.origLength,
        delta: drag.lengthBars - cur.origLength,
      };
    }
    return null;
  })();
  const ghostShiftFor = (id: string, startBar: number, threshold: number): number =>
    rippleGhost && !rippleGhost.skip.includes(id) && startBar >= threshold ? rippleGhost.delta : 0;
  return (
    <section className="arr-panel" aria-label="Arrangement and scenes">
      <ScenesPanel
        selectedScene={selectedScene}
        currentClipId={currentClipId}
        onCreateScene={() => execute(createScene(services.store.doc))}
        onDuplicatePattern={(scene) => execute(duplicatePatternForScene(services.store.doc, scene.id))}
        onCreateVariation={(scene) => execute(duplicateSceneAsVariation(services.store.doc, scene.id))}
        onSelectScene={(scene) => setSelectedSceneId(scene.id)}
        onRenameScene={(scene, name) => execute(renameScene(services.store.doc, scene.id, name))}
        onDeleteScene={(scene) => execute(deleteScene(services.store.doc, scene.id))}
        onReorderScenes={(fromIndex, toIndex) => execute(reorderScenes(services.store.doc, fromIndex, toIndex))}
        onSetSceneRole={(sceneId, role) => execute(setSceneRole(services.store.doc, sceneId, role))}
        onCreateRoleVariation={(role) => createRoleVariation(role)}
      />

      <div className="arr-timeline">
        <div className="arr-timeline-header">
          <div className="arr-timeline-title-group">
            <h2 className="panel-title">ARRANGEMENT</h2>
            <div className="arr-status-strip" aria-live="polite">
              <span className="arr-status-badge arr-status-mode">{runtime.mode.toUpperCase()}</span>
              <span className="arr-status-badge arr-status-quantize">
                QUANTIZE <strong>1 BAR</strong>
              </span>
              {queuedScene ? (
                <span className="arr-status-badge arr-status-queued">
                  QUEUED <strong>{queuedScene.name}</strong> · NEXT BAR
                </span>
              ) : (
                <span className="arr-status-badge arr-status-ready">READY</span>
              )}
            </div>
          </div>
          <div className="arr-timeline-actions">
            <div className="arr-record-toolbar" role="group" aria-label="Audio recording controls">
              <select
                className="arr-arm-select"
                aria-label="Arm track for recording"
                title="Arm a track — recorded audio-input takes land here as audio clips"
                value={armedTrackId}
                disabled={recState !== "idle"}
                onChange={(event) => {
                  const trackId = event.target.value;
                  setArmedTrackId(trackId);
                  if (trackId === armedSecondTrackId) setArmedSecondTrackId("");
                  if (trackId) setArmedAdditionalTrackIds((current) => current.map((id) => (id === trackId ? "" : id)));
                  if (trackId)
                    setIndependentInputRoutes((current) =>
                      current.map((route) => (route.trackId === trackId ? { ...route, trackId: "" } : route)),
                    );
                }}
              >
                <option value="">ARM: pick track…</option>
                {tracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.name}
                  </option>
                ))}
              </select>
              <details className="arr-capture-setup" aria-label="Recording and input configuration">
                <summary>
                  <span>CAPTURE SETUP</span>
                  <span className="arr-capture-setup-state">
                    {loopTakeCapture
                      ? "LOOP TAKES"
                      : punchCapture
                        ? "PUNCH"
                        : recordingTakeMode
                          ? "ALT TAKE"
                          : independentInputRoutes.length > 0
                            ? `${independentInputRoutes.length + 1} INPUTS`
                            : `${requestedChannelCount ?? "AUTO"} CH`}
                  </span>
                </summary>
                <div className="arr-capture-setup-grid">
                  <select
                    className="arr-arm-select"
                    aria-label="Captured channel 2 destination"
                    title="Optionally place browser-captured channel 2 on another track. This is the capture stream channel order, not a verified physical interface connector mapping."
                    value={armedSecondTrackId}
                    disabled={
                      recState !== "idle" || !!recordingTakeMode || loopTakeCapture || requestedChannelCount === 1
                    }
                    onChange={(event) => {
                      const trackId = event.target.value;
                      setArmedSecondTrackId(trackId);
                      if (trackId)
                        setArmedAdditionalTrackIds((current) => current.map((id) => (id === trackId ? "" : id)));
                    }}
                  >
                    <option value="">CH 2: keep stereo</option>
                    {tracks
                      .filter((track) => track.id !== armedTrackId && !armedAdditionalTrackIds.includes(track.id))
                      .map((track) => (
                        <option key={track.id} value={track.id}>
                          CH 2 → {track.name}
                        </option>
                      ))}
                  </select>
                  <details className="arr-input-channel-routing" hidden={routingChannelCount <= 2}>
                    <summary>INPUT ROUTING · {routingChannelCount} CHANNELS</summary>
                    {Array.from({ length: Math.max(0, routingChannelCount - 2) }, (_, routeIndex) => {
                      const channelIndex = routeIndex + 2;
                      const currentTrackId = armedAdditionalTrackIds[routeIndex] ?? "";
                      const assignedElsewhere = new Set([
                        armedTrackId,
                        armedSecondTrackId,
                        ...armedAdditionalTrackIds.filter((_, index) => index !== routeIndex),
                      ]);
                      return (
                        <select
                          key={channelIndex}
                          className="arr-arm-select"
                          aria-label={`Captured channel ${channelIndex + 1} destination`}
                          title={`Route captured input channel ${channelIndex + 1} to a separate timeline track; channel order is not verified against physical connectors.`}
                          value={currentTrackId}
                          disabled={recState !== "idle" || !!recordingTakeMode || loopTakeCapture}
                          onChange={(event) => {
                            const trackId = event.target.value;
                            setArmedAdditionalTrackIds((current) => {
                              const next = current.slice();
                              while (next.length <= routeIndex) next.push("");
                              next[routeIndex] = trackId;
                              return trackId
                                ? next.map((id, index) => (index !== routeIndex && id === trackId ? "" : id))
                                : next;
                            });
                          }}
                        >
                          <option value="">CH {channelIndex + 1}: select track…</option>
                          {tracks
                            .filter((track) => track.id === currentTrackId || !assignedElsewhere.has(track.id))
                            .map((track) => (
                              <option key={track.id} value={track.id}>
                                CH {channelIndex + 1} → {track.name}
                              </option>
                            ))}
                        </select>
                      );
                    })}
                  </details>
                  <select
                    className="arr-arm-select"
                    aria-label="Recording take mode"
                    title="Record one standalone take, start a take group, or add an alternate pass aligned to an existing take group."
                    value={recordingTakeMode}
                    disabled={!armedTrackId || recState !== "idle" || punchCapture}
                    onChange={(event) => {
                      const mode = event.target.value;
                      setRecordingTakeGroupSelection(mode);
                      if (mode) {
                        setArmedSecondTrackId("");
                        setArmedAdditionalTrackIds([]);
                      }
                    }}
                  >
                    <option value="">SINGLE TAKE</option>
                    <option value="new">NEW TAKE GROUP</option>
                    {recordingTakeGroups.map((group, index) => {
                      const passCount = new Set(
                        (arrangement.audioClips ?? [])
                          .filter((clip) => clip.takeGroupId === group.id && clip.takeId)
                          .map((clip) => clip.takeId),
                      ).size;
                      return (
                        <option key={group.id} value={group.id}>
                          ALT TAKE · GROUP {index + 1} ({passCount} pass{passCount === 1 ? "" : "es"})
                        </option>
                      );
                    })}
                  </select>
                  <button
                    type="button"
                    className={`btn btn-small${loopTakeCapture ? " active-solo" : ""}`}
                    aria-pressed={loopTakeCapture}
                    aria-label="Record transport loop as alternate takes"
                    title="Capture each complete transport-loop pass as a selectable alternate. Requires explicit loop start and end locators; single-track capture only."
                    disabled={
                      recState !== "idle" ||
                      punchCapture ||
                      !services.transport.loopEnabled ||
                      services.transport.loopEnd <= services.transport.loopStart
                    }
                    onClick={() => {
                      setLoopTakeCapture((enabled) => !enabled);
                      setArmedSecondTrackId("");
                      setArmedAdditionalTrackIds([]);
                    }}
                  >
                    LOOP PASSES {loopTakeCapture ? "ON" : "OFF"}
                  </button>
                  <button
                    type="button"
                    className={`btn btn-small${punchCapture ? " active-solo" : ""}`}
                    aria-pressed={punchCapture}
                    aria-label="Arm punch-in and punch-out recording"
                    title="Use the transport IN/OUT locators as one punch range. REC rolls into IN using the existing count-in/pre-roll; PCM is trimmed at the exact in frame, stops at the exact out frame, and playback continues. Turn LOOP off first."
                    disabled={
                      recState !== "idle" ||
                      !armedTrackId ||
                      services.transport.playing ||
                      services.transport.loopEnabled ||
                      services.transport.loopEnd <= services.transport.loopStart ||
                      loopTakeCapture ||
                      !!recordingTakeMode
                    }
                    onClick={() => setPunchCapture((enabled) => !enabled)}
                  >
                    PUNCH {punchCapture ? "ON" : "OFF"}
                  </button>
                  <select
                    className="arr-arm-select"
                    aria-label="Capture input channel count"
                    title="Request an exact independent input-channel count from the selected device. Unsupported counts stop before recording; Auto leaves browser defaults unchanged."
                    value={requestedChannelCount ?? "auto"}
                    disabled={recState !== "idle"}
                    onChange={(event) => {
                      const value = event.target.value;
                      const next = value === "auto" ? null : Number(value);
                      setRequestedChannelCount(next);
                      if (next === 1) setArmedSecondTrackId("");
                      if (next !== null) {
                        setArmedAdditionalTrackIds((current) => current.slice(0, Math.max(0, next - 2)));
                      }
                    }}
                  >
                    <option value="auto">INPUT CH: AUTO</option>
                    {Array.from({ length: 8 }, (_, index) => index + 1).map((count) => (
                      <option
                        key={count}
                        value={count}
                        disabled={(!!recordingTakeMode || loopTakeCapture) && count > 2}
                      >
                        INPUT CH: {count}
                      </option>
                    ))}
                  </select>
                  <select
                    className="arr-arm-select"
                    aria-label="Audio input device"
                    title="Choose a microphone or audio-interface input for recording. Device names may be hidden until input permission is granted."
                    value={recordingInputDeviceId}
                    disabled={recState !== "idle"}
                    onChange={(event) => {
                      const deviceId = event.target.value;
                      setRecordingInputDeviceId(deviceId);
                      if (deviceId)
                        setIndependentInputRoutes((current) =>
                          current.map((route) => (route.deviceId === deviceId ? { ...route, deviceId: "" } : route)),
                        );
                      setLastCaptureInfo(null);
                      saveRecordingInputDeviceId(deviceId);
                    }}
                  >
                    <option value="">INPUT: system default</option>
                    {recordingInputDeviceId &&
                      !recordingInputDevices.some((device) => device.deviceId === recordingInputDeviceId) && (
                        <option value={recordingInputDeviceId}>Saved audio input (not listed)</option>
                      )}
                    {recordingInputDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label}
                      </option>
                    ))}
                  </select>
                  <details className="arr-input-channel-routing" open={independentInputRoutes.length > 0}>
                    <summary>INDEPENDENT INPUT STREAMS · {independentInputRoutes.length + 1}</summary>
                    <p className="arr-independent-input-note">
                      Each stream records to its own track. Select a distinct browser input for every row. Native WASAPI
                      capture currently exposes one input endpoint at a time.
                    </p>
                    {independentInputRoutes.map((route, routeIndex) => {
                      const inputNumber = routeIndex + 2;
                      const assignedTrackIds = new Set([
                        armedTrackId,
                        ...independentInputRoutes
                          .filter((_, index) => index !== routeIndex)
                          .map((item) => item.trackId),
                      ]);
                      const assignedDeviceIds = new Set([
                        recordingInputDeviceId,
                        ...independentInputRoutes
                          .filter((_, index) => index !== routeIndex)
                          .map((item) => item.deviceId),
                      ]);
                      const selectedTrackName =
                        tracks.find((track) => track.id === route.trackId)?.name ?? `Input ${inputNumber}`;
                      return (
                        <div className="arr-independent-input-route" key={routeIndex}>
                          <span className="arr-independent-input-label">INPUT {inputNumber}</span>
                          <select
                            className="arr-arm-select"
                            aria-label={`Independent input ${inputNumber} track`}
                            value={route.trackId}
                            disabled={recState !== "idle"}
                            onChange={(event) => {
                              const trackId = event.target.value;
                              setIndependentInputRoutes((current) =>
                                current.map((item, index) =>
                                  index === routeIndex
                                    ? { ...item, trackId }
                                    : trackId && item.trackId === trackId
                                      ? { ...item, trackId: "" }
                                      : item,
                                ),
                              );
                            }}
                          >
                            <option value="">Track: select destination…</option>
                            {tracks
                              .filter((track) => track.id === route.trackId || !assignedTrackIds.has(track.id))
                              .map((track) => (
                                <option key={track.id} value={track.id}>
                                  {track.name}
                                </option>
                              ))}
                          </select>
                          <select
                            className="arr-arm-select"
                            aria-label={`Independent input ${inputNumber} device`}
                            value={route.deviceId}
                            disabled={recState !== "idle"}
                            onChange={(event) => {
                              const deviceId = event.target.value;
                              setIndependentInputRoutes((current) =>
                                current.map((item, index) =>
                                  index === routeIndex
                                    ? { ...item, deviceId }
                                    : deviceId && item.deviceId === deviceId
                                      ? { ...item, deviceId: "" }
                                      : item,
                                ),
                              );
                            }}
                          >
                            <option value="">Input: select distinct device…</option>
                            {route.deviceId &&
                              !recordingInputDevices.some((device) => device.deviceId === route.deviceId) && (
                                <option value={route.deviceId}>Saved input (not listed)</option>
                              )}
                            {recordingInputDevices
                              .filter(
                                (device) =>
                                  device.deviceId === route.deviceId || !assignedDeviceIds.has(device.deviceId),
                              )
                              .map((device) => (
                                <option key={device.deviceId} value={device.deviceId}>
                                  {device.label}
                                </option>
                              ))}
                          </select>
                          <label className="arr-independent-input-monitor">
                            <input
                              type="checkbox"
                              aria-label={`Monitor ${selectedTrackName} input`}
                              checked={route.monitoring}
                              disabled={recState === "saving"}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setIndependentInputRoutes((current) =>
                                  current.map((item, index) =>
                                    index === routeIndex ? { ...item, monitoring: enabled } : item,
                                  ),
                                );
                                if (route.trackId) recGroupRef.current?.setInputMonitoring(route.trackId, enabled);
                              }}
                            />
                            MON
                          </label>
                          <button
                            type="button"
                            className="btn btn-small"
                            aria-label={`Remove independent input ${inputNumber}`}
                            disabled={recState !== "idle"}
                            onClick={() =>
                              setIndependentInputRoutes((current) => current.filter((_, index) => index !== routeIndex))
                            }
                          >
                            REMOVE
                          </button>
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      className="btn btn-small"
                      aria-label="Add independent input stream"
                      disabled={
                        recState !== "idle" ||
                        independentInputRoutes.length >= 7 ||
                        !!recordingTakeMode ||
                        loopTakeCapture ||
                        punchCapture
                      }
                      onClick={() => {
                        setArmedSecondTrackId("");
                        setArmedAdditionalTrackIds([]);
                        setIndependentInputRoutes((current) => [
                          ...current,
                          { trackId: "", deviceId: "", monitoring: false },
                        ]);
                      }}
                    >
                      + ADD INPUT STREAM
                    </button>
                    {independentInputRoutes.length > 0 && !independentInputReady && (
                      <span className="arr-rec-saving" role="status">
                        Assign a different track and explicit device to every stream before REC.
                      </span>
                    )}
                  </details>
                </div>
              </details>
              <button
                type="button"
                className={`btn btn-small${micMonitoring ? " active-solo" : ""}`}
                aria-pressed={micMonitoring}
                title="Dry software monitoring routes each split input channel through its destination track mixer, bypassing track FX. Latency depends on the browser and device. For lowest latency, use the interface's hardware direct-monitor control. Headphones recommended; speakers can cause feedback."
                onClick={() => {
                  const next = !micMonitoring;
                  setMicMonitoring(next);
                  recRef.current?.setMonitoring(next);
                  if (armedTrackId) recGroupRef.current?.setInputMonitoring(armedTrackId, next);
                }}
              >
                {micMonitoring ? "DRY SOFT MON ON" : "DRY SOFT MON OFF"}
              </button>
              <label className="arr-arm-gain" aria-label="Audio input gain">
                <span
                  className="arr-arm-gain-value"
                  title="Pre-capture input trim (applies to the saved take and monitoring)"
                >
                  GAIN {inputGainDb > 0 ? "+" : ""}
                  {inputGainDb.toFixed(1)} dB
                </span>
                <input
                  type="range"
                  min={MIN_INPUT_GAIN_DB}
                  max={MAX_INPUT_GAIN_DB}
                  step={0.5}
                  value={inputGainDb}
                  disabled={recState !== "idle"}
                  aria-label="Audio input gain"
                  title="Trim the input before capture: raise until peaks are healthy but never clipped; lower if the clip warning shows"
                  onChange={(event) => changeInputGain(Number(event.target.value))}
                />
              </label>
              <div
                className="arr-mic-meter"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={1}
                aria-valuenow={Number(micPeak.toFixed(2))}
                aria-label="Audio input level"
              >
                <div className="arr-mic-meter-fill" style={{ width: `${Math.min(100, micPeak * 100)}%` }} />
                {micClipped && (
                  <button
                    type="button"
                    className="arr-mic-clip"
                    role="status"
                    title="Input clipped since the last reset — lower GAIN, then click to clear"
                    onClick={resetMicClip}
                  >
                    CLIP
                  </button>
                )}
              </div>
              {lastCaptureInfo && (
                <span
                  className="arr-rec-input-report"
                  role="status"
                  aria-label="Observed audio input capture format"
                  title="Web Audio reports the live stream and PCM capture format. Browser channel limits and mapping may differ from the physical interface."
                >
                  LAST CAPTURE: {lastCaptureInfo.capturedChannels} ch @{" "}
                  {formatCaptureRate(lastCaptureInfo.capturedSampleRate)}
                  {lastCaptureInfo.inputTrackChannels !== null &&
                    ` · track ${lastCaptureInfo.inputTrackChannels} ch${
                      lastCaptureInfo.inputTrackSampleRate !== null
                        ? ` @ ${formatCaptureRate(lastCaptureInfo.inputTrackSampleRate)}`
                        : ""
                    }`}
                  {lastCaptureInfo.supportedChannelCount
                    ? ` · browser range ${formatChannelRange(lastCaptureInfo.supportedChannelCount)} ch`
                    : " · browser channel range unavailable"}
                  <span className="arr-rec-input-report-note">
                    Browser capture may limit or remap channels; this does not verify physical interface routing.
                  </span>
                </span>
              )}
              {recState === "recording" ? (
                <button type="button" className="btn btn-small btn-rec btn-rec-stop" onClick={() => void stopRec()}>
                  ■ STOP {recSeconds.toFixed(0)}s
                </button>
              ) : recState === "starting" ? (
                <button
                  type="button"
                  className="btn btn-small btn-rec btn-rec-stop"
                  aria-label="Cancel audio input startup"
                  title="Cancel opening the selected audio input"
                  onClick={cancelRecStart}
                >
                  × CANCEL
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-small btn-rec"
                  title="Record the selected audio input onto the armed track at the playhead (rolls the transport)"
                  disabled={
                    !armedTrackId ||
                    recState !== "idle" ||
                    !independentInputReady ||
                    (punchCapture && services.transport.playing)
                  }
                  onClick={() => void startRec()}
                >
                  ● REC
                </button>
              )}
              {recState === "starting" && <span className="arr-rec-saving">opening audio input…</span>}
              {recState === "saving" && <span className="arr-rec-saving">placing clip…</span>}
              {recordingInputListError && (
                <span className="arr-rec-saving" role="status" aria-live="polite">
                  audio input list unavailable; system default remains usable
                </span>
              )}
              {loopTakeCapture && (
                <span className="arr-rec-saving" role="status">
                  Each transport-loop wrap marks an alternate pass in the PCM source; stop to place and select the
                  captured passes.
                </span>
              )}
              {!loopTakeCapture && recordingTakeMode && (
                <span className="arr-rec-saving" role="status">
                  Alternate passes align to the group start; stereo stays together on the armed track.
                </span>
              )}
              {punchCapture && (
                <span className="arr-rec-saving" role="status">
                  Punch range is armed: REC rolls into IN, audio is trimmed at that frame, capture ends at OUT, and
                  playback rolls on for post-roll.
                </span>
              )}
              {recError && (
                <span className="arr-rec-error" role="alert">
                  {recError}
                </span>
              )}
              {recNotice && !recError && (
                <span className="arr-rec-saving" role="status" aria-live="polite">
                  {recNotice}
                </span>
              )}
              {recStorageWarning && (
                <span className="arr-rec-warning" role="status" aria-live="polite">
                  {recStorageWarning}
                </span>
              )}
            </div>
            <div className="arr-edit-toolbar" role="group" aria-label="Arrangement editing controls">
              <div
                className="arr-edit-cluster arr-edit-cluster-view"
                role="group"
                aria-label="Arrangement view controls"
              >
                <ArrangementViewControls
                  rulerMode={rulerMode}
                  onToggleRulerMode={() => setRulerMode(rulerMode === "bars" ? "seconds" : "bars")}
                  showIntensity={showIntensity}
                  onToggleIntensity={() => setShowIntensity((value) => !value)}
                  onZoomOut={() => setZoom((value) => Math.max(MIN_ZOOM, value / 1.4))}
                  onFit={() => {
                    const viewport = scrollRef.current?.clientWidth ?? 800;
                    setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, viewport / Math.max(1, totalBars * BASE_BAR_WIDTH))));
                    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
                  }}
                  onZoomIn={() => setZoom((value) => Math.min(MAX_ZOOM, value * 1.4))}
                />
              </div>
              <div
                className="arr-edit-cluster arr-edit-cluster-clips"
                role="group"
                aria-label="Arrangement clip actions"
              >
                {selectedClip && (
                  <label className="arr-clip-secs">
                    SECS
                    <input
                      type="number"
                      min={0.5}
                      // The field is in seconds; the cap is a bar count, so convert
                      // it at the clip's own tempo (a bar is 4 beats).
                      max={Math.round(sceneBarsToSeconds(MAX_ARRANGEMENT_CLIP_BARS, selectedClipBpm, ticksPerBar(doc)))}
                      step={0.5}
                      aria-label="Clip length in seconds"
                      title={`${selectedClip.lengthBars} bars at ${Math.round(selectedClipBpm)} BPM — Enter resizes the clip`}
                      value={secsDraft ?? selectedClipSeconds.toFixed(2)}
                      onFocus={() => setSecsDraft(selectedClipSeconds.toFixed(2))}
                      onChange={(event) => setSecsDraft(event.target.value)}
                      onBlur={commitClipSecs}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitClipSecs();
                        if (event.key === "Escape") setSecsDraft(null);
                      }}
                    />
                  </label>
                )}
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={!selectedScene}
                  onClick={() => selectedScene && placeScene(selectedScene.id, appendBar())}
                >
                  + CLIP
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={!selectedClipId}
                  onClick={() =>
                    selectedClipId && execute(duplicateArrangementClip(services.store.doc, selectedClipId))
                  }
                >
                  DUP
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-danger"
                  disabled={!selectedClipId}
                  onClick={() => {
                    if (!selectedClipId) return;
                    // The SHARED delete path (context menu / long-press): one
                    // undoable gesture, the delete toast, ripple-mode support,
                    // and SelectionStore pruning. This header button used to
                    // execute deleteArrangementClip directly and cleared only the
                    // panel-local mirror — selectionStore.clipIds kept the dead
                    // id (third copy of the same stale-selection hole).
                    deleteClipsWithToast([selectedClipId]);
                  }}
                >
                  DEL
                </button>
                {selectedAudioClipId && (
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    onClick={() => {
                      execute(deleteAudioClip(services.store.doc, selectedAudioClipId));
                      setSelectedAudioClipId(null);
                    }}
                  >
                    DEL AUDIO
                  </button>
                )}
              </div>
              <div
                className="arr-edit-cluster arr-edit-cluster-capture"
                role="group"
                aria-label="Arrangement capture actions"
              >
                {!capture.capturing ? (
                  <button type="button" className="btn btn-small" onClick={() => services.capture.start()}>
                    CAPTURE
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn btn-small active-solo"
                      onClick={() => {
                        try {
                          services.capture.finish();
                        } catch (error) {
                          setActionError(error instanceof Error ? error.message : "Capture failed");
                        }
                      }}
                    >
                      FINISH {capture.launchCount}
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      onClick={() => services.capture.cancel()}
                    >
                      CANCEL
                    </button>
                  </>
                )}
              </div>
              <div
                className="arr-edit-cluster arr-edit-cluster-audio"
                role="group"
                aria-label="Arrangement audio and take tools"
              >
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={!selection.timeRange || bouncingZone}
                  title="Bounce the selected zone (selected tracks, with FX/groups/sends) to an editable audio clip via an offline render. Shift the zone, hit bounce, flip it to a pad."
                  onClick={() => void bounceZoneToClip()}
                >
                  BOUNCE ZONE
                </button>
                {selectedAudioTakeGroup && (selectedAudioTakeIds.length > 0 || selectedAudioTakeGroup.compTakeId) && (
                  <label className="arr-arm-gain">
                    <span>ACTIVE PASS</span>
                    <select
                      className="arr-arm-select"
                      aria-label="Active audio take"
                      title="Only the active pass plays and exports; alternate passes stay editable and undoable."
                      value={selectedAudioTakeGroup.activeTakeId}
                      onChange={(event) => {
                        const nextTakeId = event.target.value;
                        execute(setActiveAudioTake(doc, selectedAudioTakeGroup.id, nextTakeId));
                        const nextClip = (arrangement.audioClips ?? []).find(
                          (clip) => clip.takeGroupId === selectedAudioTakeGroup.id && clip.takeId === nextTakeId,
                        );
                        if (nextClip) setSelectedAudioClipId(nextClip.id);
                      }}
                    >
                      {selectedAudioTakeIds.map((takeId, index) => (
                        <option key={takeId} value={takeId}>
                          TAKE {index + 1}
                        </option>
                      ))}
                      {selectedAudioTakeGroup.compTakeId && (
                        <option value={selectedAudioTakeGroup.compTakeId}>COMP</option>
                      )}
                    </select>
                  </label>
                )}
                {selectedAudioTakeGroup && (selectedAudioTakeIds.length > 0 || selectedAudioTakeGroup.compTakeId) && (
                  <button
                    type="button"
                    className={`btn btn-small${showAudioTakeLanes ? " active-solo" : ""}`}
                    aria-label={showAudioTakeLanes ? "Hide audio take lanes" : "Show audio take lanes"}
                    aria-expanded={showAudioTakeLanes}
                    onClick={() => setShowAudioTakeLanes((visible) => !visible)}
                  >
                    TAKE LANES {showAudioTakeLanes ? "ON" : "OFF"}
                  </button>
                )}
                {selectedAudioTakeGroup &&
                  selectedAudioTakeGroup.activeTakeId !== selectedAudioTakeGroup.compTakeId &&
                  selectedAudioTakeIds.includes(selectedAudioTakeGroup.activeTakeId) && (
                    <button
                      type="button"
                      className="btn btn-small"
                      aria-label="Comp selected transport range from active take"
                      title="Replace the current comp inside the transport start/end locators with the active source take. Source takes remain unchanged; the edit is undoable."
                      onClick={() =>
                        compAudioRange(
                          selectedAudioTakeGroup.id,
                          selectedAudioTakeGroup.activeTakeId,
                          services.transport.loopStart,
                          services.transport.loopEnd,
                        )
                      }
                    >
                      COMP RANGE
                    </button>
                  )}
                {selectedAudioTakeGroup && selectedAudioTakeIds.length >= 2 && (
                  <button
                    type="button"
                    className={`btn btn-small${smartCompPlan ? " active-solo" : ""}`}
                    aria-label="Suggest a comp from the best parts of every take"
                    aria-expanded={smartCompPlan !== null}
                    title="Measure every take (groove lock, pitch drift, noise floor, clipping) and propose which take should feed each bar. Nothing is edited until you apply the plan."
                    disabled={smartCompBusy}
                    onClick={() => {
                      if (smartCompPlan) setSmartCompPlan(null);
                      else suggestSmartComp(selectedAudioTakeGroup.id);
                    }}
                  >
                    {smartCompBusy ? "ANALYSING…" : "SUGGEST COMP"}
                  </button>
                )}
              </div>
              {smartCompPlan && selectedAudioTakeGroup && (
                <div className="arr-smart-comp" role="group" aria-label="Smart comp suggestion">
                  <div className="arr-smart-comp-head">
                    <strong>SMART COMP SUGGESTION</strong>
                    <span>
                      {planBars(smartCompPlan)} bars · {smartCompPlan.segments.length} segment
                      {smartCompPlan.segments.length === 1 ? "" : "s"} · {smartCompPlan.segments.length - 1} seam
                      {smartCompPlan.segments.length - 1 === 1 ? "" : "s"}
                      {smartCompPlan.uncoveredBars.length > 0
                        ? ` · ${smartCompPlan.uncoveredBars.length} bar${
                            smartCompPlan.uncoveredBars.length === 1 ? "" : "s"
                          } no take covers`
                        : ""}
                    </span>
                  </div>
                  <div className="arr-smart-comp-takes">
                    {smartCompPlan.takeSummaries
                      .slice()
                      .sort((a, b) => b.score.score - a.score.score)
                      .map((entry) => {
                        const laneIndex = selectedAudioTakeIds.indexOf(entry.takeId) + 1;
                        return (
                          <div className="arr-smart-comp-take" key={entry.takeId}>
                            <span className="arr-smart-comp-take-name">
                              TAKE {laneIndex > 0 ? laneIndex : entry.takeId} · {entry.score.score.toFixed(0)}
                            </span>
                            <span className="arr-smart-comp-take-evidence">{entry.score.evidence.join(" · ")}</span>
                          </div>
                        );
                      })}
                  </div>
                  <div className="arr-smart-comp-segments">
                    {smartCompPlan.segments.map((segment) => {
                      const laneIndex = selectedAudioTakeIds.indexOf(segment.sourceTakeId) + 1;
                      return (
                        <span className="arr-smart-comp-segment" key={`${segment.sourceTakeId}:${segment.startBar}`}>
                          bars {segment.startBar + 1}–{segment.endBar} → TAKE {laneIndex}
                        </span>
                      );
                    })}
                  </div>
                  <div className="arr-smart-comp-actions">
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => setSmartCompPlan(null)}
                      title="Discard the suggestion — the document was never touched"
                    >
                      CANCEL
                    </button>
                    <button
                      type="button"
                      className="btn btn-small intent-use-btn"
                      onClick={() => applySmartCompPlan(selectedAudioTakeGroup.id)}
                      title="Apply the suggested comp as ONE undoable edit. Source takes stay intact."
                    >
                      APPLY COMP
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="arr-production-toolbar" role="group" aria-label="Song building controls">
              <button type="button" className="btn btn-small" onClick={() => setShowSkeletonPreview((value) => !value)}>
                BUILD SKELETON
              </button>
              <select
                className="arr-arm-select"
                aria-label="Auto-arrange target song length"
                title="Approximate duration at project BPM; scene tempo pins can change the final length."
                value={autoArrangeMinutes}
                onChange={(event) => setAutoArrangeMinutes(Number(event.target.value))}
              >
                <option value={1}>SONG · 1:00</option>
                <option value={2}>SONG · 2:00</option>
                <option value={3}>SONG · 3:00</option>
                <option value={4}>SONG · 4:00</option>
              </select>
              <span
                className="arr-song-length-preview"
                aria-label="Estimated song duration"
                aria-live="polite"
                title="Estimate at the project BPM. Scenes with their own tempo can change the final duration."
              >
                ≈ {autoArrangeDuration} · {autoArrangeTargetBars} bars @ {projectBpm.toFixed(1)} BPM
              </span>
              <button
                type="button"
                className="btn btn-small btn-export btn-primary"
                title="Replace the current arrangement with all scenes in a full song form sized to SONG LENGTH"
                onClick={() => {
                  try {
                    const currentDoc = services.store.getDoc();
                    const targetBars = sceneSecondsToBars(
                      autoArrangeMinutes * 60,
                      currentDoc.bpm,
                      ticksPerBar(currentDoc),
                    );
                    execute(autoArrangeSong(currentDoc, targetBars));
                  } catch (err) {
                    setActionError(err instanceof Error ? err.message : "Auto-arrange failed");
                  }
                }}
              >
                AUTO ARRANGE
              </button>
            </div>
          </div>
        </div>

        {recoverableTakes.length > 0 && (
          <section className="arr-recording-recovery" aria-label="Recoverable audio recordings">
            <strong>RECOVERABLE AUDIO TAKES</strong>
            {recoverableTakes.map((session) => {
              const canPlaceOnTimeline =
                session.placeOnTimeline !== false &&
                session.projectId === doc.id &&
                tracks.some((track) => track.id === session.trackId);
              return (
                <div className="arr-recording-recovery-row" key={session.id}>
                  <span>
                    {session.trackName} · {new Date(session.createdAt).toLocaleString()} ·{" "}
                    {(session.totalFrames / session.sampleRate).toFixed(1)}s
                    {session.status === "recording" && (
                      <span className="arr-rec-saving" role="status">
                        {" "}
                        · interrupted capture; the final uncommitted audio may be incomplete
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={recoveringTakeId !== null || recState !== "idle"}
                    onClick={() => void recoverTake(session)}
                  >
                    {recoveringTakeId === session.id
                      ? "RECOVERING…"
                      : canPlaceOnTimeline
                        ? "RESTORE TO TIMELINE"
                        : "RECOVER TO SAMPLES"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    disabled={recoveringTakeId !== null || recState !== "idle"}
                    onClick={() => void discardTake(session)}
                  >
                    DISCARD
                  </button>
                </div>
              );
            })}
          </section>
        )}

        {showSkeletonPreview && (
          <div className="arr-skeleton-preview">
            <span className="arr-skeleton-title">
              {clips.length > 0 ? "REPLACE CURRENT ARRANGEMENT:" : "ARRANGEMENT PREVIEW:"}
            </span>
            {(() => {
              const roles = ["intro", "build", "drop", "break", "outro"] as const;
              const preview = roles.flatMap((role) => {
                const scene = scenes.find((candidate) => sceneRoleOf(candidate) === role);
                if (!scene) return [];
                return [
                  <span key={scene.id} className="arr-skeleton-item">
                    {role.toUpperCase()} {role === "drop" ? 16 : 8}B
                  </span>,
                ];
              });
              return preview.length > 0 ? preview : <span className="arr-skeleton-empty">No role scenes found</span>;
            })()}
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                try {
                  execute(createArrangementSkeleton(services.store.doc));
                  setShowSkeletonPreview(false);
                } catch (error) {
                  setActionError(error instanceof Error ? error.message : "Cannot build skeleton");
                }
              }}
            >
              APPLY SKELETON
            </button>
          </div>
        )}
        <div className="arr-ripple-row">
          <button
            type="button"
            className={`arr-ripple-toggle${rippleMode ? " on" : ""}`}
            aria-pressed={rippleMode}
            title="Ripple edit — moves/resizes/deletes shift every later clip to preserve the gaps"
            onClick={() => setRippleMode((on) => !on)}
          >
            RIPPLE {rippleMode ? "ON" : "OFF"}
          </button>
          <span className="arr-ripple-hint">shifts later clips to keep the gaps</span>
          <button
            type="button"
            className={`arr-ripple-toggle${tool === "cut" ? " on" : ""}`}
            aria-pressed={tool === "cut"}
            title="Cut tool — click any clip to split it at the click position (V = select, C = cut). Scene clips split on their bar grid, audio clips sample-precise."
            onClick={() => toolStore.setTool(tool === "cut" ? "select" : "cut")}
          >
            CUT
          </button>
        </div>

        <div className="arr-ripple-row">
          <label
            className="arr-snap-label"
            title="Snap grid for audio clips, take-lane ranges, time ranges and markers. Hold Shift during a drag to suspend it. Scene clips stay bar-aligned by contract."
          >
            SNAP
            <select
              className="arr-arm-select"
              aria-label="Snap grid"
              value={snapGrid}
              onChange={(event) => changeSnapGrid(event.target.value as SnapGridId)}
            >
              <option value="off">OFF</option>
              {SNAP_GRIDS.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
          <span className="arr-ripple-hint">Shift suspends during a drag</span>
          <button
            type="button"
            className={`arr-ripple-toggle${chordGenOpen ? " on" : ""}`}
            aria-pressed={chordGenOpen}
            title="Generate a chord progression onto the chord track — genre tables from the AI harmony library, deterministic by progression index"
            onClick={() => setChordGenOpen((open) => !open)}
          >
            ✨ GEN
          </button>
        </div>
        {chordGenOpen && (
          <ChordProgressionPanel
            form={chordGen}
            onChange={(patch) => setChordGen((current) => ({ ...current, ...patch }))}
            onGenerate={() => {
              try {
                execute(
                  generateChordProgression(services.store.doc, chordGen.startBar, chordGen.bars, {
                    genre: chordGen.genre,
                    tonic: chordGen.tonic,
                    mode: chordGen.mode,
                    progressionIndex: chordGen.index,
                  }),
                );
                setActionError(null);
              } catch (error) {
                setActionError(error instanceof Error ? error.message : String(error));
              }
            }}
          />
        )}

        <div className="arr-role-flow" aria-label="Arrangement role flow">
          {clips.length === 0 ? (
            <span className="arr-role-flow-empty">EMPTY ARRANGEMENT</span>
          ) : (
            clips.map((clip, index) => {
              const scene = scenes.find((candidate) => candidate.id === clip.sceneId);
              const role = scene ? (sceneRoleOf(scene) ?? "custom") : "custom";
              // Wave: FX chips — devices gated/swept by this section's
              // sceneAutomation (vinyl in the break, the build's riser…).
              const fxChips = sectionFxChips(services.store.doc, clip.sceneId);
              return (
                <span key={clip.id} className={`arr-role-flow-item role-${role}`}>
                  <span className="arr-role-flow-role">{role.toUpperCase()}</span>
                  {fxChips.map((chip) => (
                    <span
                      key={`${chip.type}-${chip.label}`}
                      className={`arr-role-flow-fx${chip.sweep ? " sweep" : ""}`}
                      title={
                        chip.sweep
                          ? `${chip.label} — automated through this section`
                          : `${chip.label} — active in this section`
                      }
                    >
                      {chip.sweep ? `${chip.label} →` : chip.label}
                    </span>
                  ))}
                  <span className="arr-role-flow-length">{clip.lengthBars}B</span>
                  {index < clips.length - 1 && (
                    <span className="arr-role-flow-arrow" aria-hidden="true">
                      →
                    </span>
                  )}
                </span>
              );
            })
          )}
        </div>

        {selectedClipId &&
          clips.some((c) => c.id === selectedClipId) &&
          (() => {
            const clip = clips.find((c) => c.id === selectedClipId)!;
            const clipScene = scenes.find((candidate) => candidate.id === clip.sceneId);
            return (
              <div className="arr-swap-bar" role="toolbar" aria-label="Selected clip tools">
                <span className="arr-swap-label">
                  CLIP · {clipScene?.name ?? "?"} · {clip.startBar + 1}–{clip.startBar + clip.lengthBars}
                </span>
                <label className="arr-swap-variant">
                  VARIANT{" "}
                  <select
                    value={clip.sceneId}
                    aria-label="Swap clip variant"
                    onChange={(event) => {
                      try {
                        execute(setArrangementClipScene(services.store.doc, clip.id, event.target.value));
                      } catch (err) {
                        setActionError(err instanceof Error ? err.message : String(err));
                      }
                    }}
                  >
                    {scenes.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className={`arr-swap-loop${clip.loop ? " on" : ""}`}
                  aria-pressed={Boolean(clip.loop)}
                  title="Loop this clip's content for its whole length"
                  onClick={() => execute(setArrangementClipLoop(services.store.doc, clip.id, !clip.loop))}
                >
                  LOOP
                </button>
                <button
                  type="button"
                  className="arr-swap-delete"
                  title={rippleMode ? "Delete and close the gap" : "Delete"}
                  onClick={() => deleteClipsWithToast([clip.id], true)}
                >
                  {rippleMode ? "DEL GAP" : "DEL"}
                </button>
              </div>
            );
          })()}
        <div className="arr-lane-scroll" ref={scrollRef} onScroll={measureViewport}>
          <div
            className="arr-ruler"
            style={{ width: totalBars * barWidth }}
            title="Click to seek · drag to select time range · shift+click adds a marker"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              // The ruler and the lane are SIBLINGS, and every px→bar
              // conversion here is measured against the LANE's rect. Read the
              // lane through the same `if (!lane) return` guard the panel's
              // own `barFromEvent` / `audioBarFromEventAt` helpers already
              // use — a non-null assertion on a sibling's ref turns a missing
              // lane into a TypeError inside a pointer handler.
              const lane = laneRef.current;
              if (!lane) return;
              const bar = Math.max(0, (event.clientX - lane.getBoundingClientRect().left) / barWidth);
              if (event.shiftKey) {
                // Shift here IS the feature key (add marker), so it does not
                // act as snap-suspend — the grid applies to the placement.
                execute(
                  addMarker(services.store.doc, {
                    tick: Math.floor(snapBar(bar, snapBarsFor(snapGrid)) * barUnit),
                    type: "cue",
                  }),
                );
                return;
              }
              setTimeDrag({ startBar: bar, currentBar: bar });
              (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!timeDrag) return;
              const lane = laneRef.current;
              if (!lane) return;
              const bar = Math.max(
                0,
                Math.min(totalBars, (event.clientX - lane.getBoundingClientRect().left) / barWidth),
              );
              setTimeDrag({ startBar: timeDrag.startBar, currentBar: bar });
              // Range edges snap to the grid (Shift suspends) — a snap-to-zero
              // span (< grid apart) reads as a click, same as the 0.15 check.
              const grid = event.shiftKey ? null : snapBarsFor(snapGrid);
              const from = snapBar(Math.min(timeDrag.startBar, bar), grid);
              const to = snapBar(Math.max(timeDrag.startBar, bar), grid);
              if (Math.abs(to - from) > 0.15) {
                selectionStore.setTimeRange({
                  fromTick: Math.floor(from * barUnit),
                  toTick: Math.floor(to * barUnit),
                });
              } else {
                selectionStore.setTimeRange(null);
              }
            }}
            onPointerUp={(event) => {
              if (!timeDrag) return;
              const from = Math.min(timeDrag.startBar, timeDrag.currentBar);
              const to = Math.max(timeDrag.startBar, timeDrag.currentBar);
              if (Math.abs(to - from) < 0.15) {
                services.playback.seek(Math.floor(from * barUnit));
                selectionStore.setTimeRange(null);
              }
              setTimeDrag(null);
              try {
                (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
              } catch {
                /* pointer already gone (cancelled) */
              }
            }}
            onPointerCancel={() => {
              // Interrupted drag — drop the in-progress range selection.
              setTimeDrag(null);
              selectionStore.setTimeRange(null);
            }}
            onPointerLeave={() => {
              // keep drag active, don't clear
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              const lane = laneRef.current;
              if (!lane) return;
              const x = event.clientX - lane.getBoundingClientRect().left;
              const closest = markers
                .map((marker) => ({ id: marker.id, dist: Math.abs((marker.tick / barUnit) * barWidth - x) }))
                .filter((marker) => marker.dist < 8)
                .sort((a, b) => a.dist - b.dist)[0];
              if (closest) execute(removeMarker(services.store.doc, closest.id));
            }}
          >
            {rulerMarkIndices.map((index) => {
              const barNum = index * 4 + 1;
              return (
                <span key={index} className="arr-ruler-mark" style={{ left: index * 4 * barWidth }}>
                  {rulerMode === "seconds" ? formatBarAsSeconds(barNum - 1) : barNum}
                </span>
              );
            })}
            {markers.map((marker) => (
              <div
                key={marker.id}
                className={`arr-marker arr-marker-${marker.type}`}
                style={{ left: (marker.tick / barUnit) * barWidth - 6 }}
                title={`${marker.name} (${marker.type})`}
                onPointerDown={(event) => {
                  markerLongPressTargetRef.current = marker.id;
                  markerLongPress.onPointerDown(event);
                }}
                onContextMenu={markerLongPress.wrapContextMenu((event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  execute(removeMarker(services.store.doc, marker.id));
                })}
                {...markerLongPressHandlers}
              />
            ))}
            {selection.timeRange && (
              <div
                className="arr-time-range"
                style={{
                  left: (Math.min(selection.timeRange.fromTick, selection.timeRange.toTick) / barUnit) * barWidth,
                  width: (Math.abs(selection.timeRange.toTick - selection.timeRange.fromTick) / barUnit) * barWidth,
                }}
              />
            )}
            <ArrPlayheadLine
              transport={services.transport}
              barWidth={barWidth}
              className="arr-playhead"
              barUnitTicks={barUnit}
            />
          </div>
          <div
            className="arr-chord-lane"
            style={{ width: totalBars * barWidth }}
            // A bare div cannot carry an accessible name (axe: prohibited
            // attribute) — the lane is a labelled group of chord blocks.
            role="group"
            aria-label="Chord track"
            title="Chord track — click empty space to add a chord · drag to move · right edge resizes · click a chord to edit it"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const lane = laneRef.current;
              if (!lane) return;
              const bar = Math.max(0, Math.floor((event.clientX - lane.getBoundingClientRect().left) / barWidth));
              const block = (event.target as HTMLElement).closest(".arr-chord") as HTMLElement | null;
              if (block) {
                const chordId = block.dataset.chordId!;
                const chord = (doc.arrangement.chords ?? []).find((c) => c.id === chordId)!;
                setChordSel(chordId);
                event.currentTarget.setPointerCapture(event.pointerId);
                chordDragRef.current = {
                  mode: event.clientX > block.getBoundingClientRect().right - 10 ? "resize" : "move",
                  chordId,
                  pointerId: event.pointerId,
                  grabBar: bar,
                  origStart: chord.startBar,
                  origLength: chord.lengthBars,
                  barWidth,
                };
                setChordDragLive({ startBar: chord.startBar, lengthBars: chord.lengthBars });
                return;
              }
              setChordSel(null);
              const startBar = Math.max(0, Math.floor(bar));
              try {
                execute(addChord(services.store.doc, startBar, 2, 0, "maj"));
                setChordSel(
                  (services.store.doc.arrangement.chords ?? []).find((c) => c.startBar === startBar)?.id ?? null,
                );
              } catch (error) {
                setActionError(String(error));
              }
            }}
            onPointerMove={(event) => {
              const cur = chordDragRef.current;
              if (!cur) return;
              const lane = laneRef.current;
              if (!lane) return;
              const bar = Math.max(0, (event.clientX - lane.getBoundingClientRect().left) / cur.barWidth);
              const next =
                cur.mode === "move"
                  ? Math.max(0, cur.origStart + Math.round(bar - cur.grabBar))
                  : Math.max(cur.origStart + 1, Math.round(bar));
              const length = cur.mode === "move" ? cur.origLength : next - cur.origStart;
              setChordDragLive({ startBar: cur.mode === "move" ? next : cur.origStart, lengthBars: length });
            }}
            onPointerUp={() => {
              const cur = chordDragRef.current;
              if (!cur) return;
              const final = chordDragLiveRef.current;
              chordDragRef.current = null;
              setChordDragLive(null);
              if (!final) return;
              try {
                if (cur.mode === "move" && final.startBar !== cur.origStart) {
                  execute(moveChord(services.store.doc, cur.chordId, final.startBar));
                } else if (cur.mode === "resize" && final.lengthBars !== cur.origLength) {
                  execute(resizeChord(services.store.doc, cur.chordId, final.lengthBars));
                }
              } catch (error) {
                setActionError(String(error));
              }
            }}
            onPointerCancel={() => {
              chordDragRef.current = null;
              setChordDragLive(null);
            }}
          >
            {(doc.arrangement.chords ?? []).map((chord) => {
              const drag = chordDrag && chordSel === chord.id && chordDragRef.current ? chordDrag : null;
              const startBar = drag ? drag.startBar : chord.startBar;
              const lengthBars = drag ? drag.lengthBars : chord.lengthBars;
              const selected = chordSel === chord.id;
              return (
                <div
                  key={chord.id}
                  data-chord-id={chord.id}
                  className={`arr-chord${selected ? " selected" : ""}`}
                  style={{ left: startBar * barWidth, width: lengthBars * barWidth - 2 }}
                  title={`${chordName(chord.root, chord.quality)} · bars ${chord.startBar + 1}–${chord.startBar + chord.lengthBars}`}
                >
                  {chordName(chord.root, chord.quality)}
                </div>
              );
            })}
            {chordSel &&
              chordDrag === null &&
              (() => {
                const selected = (doc.arrangement.chords ?? []).find((c) => c.id === chordSel);
                if (!selected) return null;
                // Transpose/conform operate on the shared CLIP selection's
                // scene clips; audio clips keep their own per-clip pitch offset.
                const hasSceneClipSelection = doc.arrangement.clips.some((c) => selection.clipIds.includes(c.id));
                return (
                  <div className="arr-chord-editor" style={{ left: 6 }}>
                    <select
                      aria-label="Chord root"
                      value={selected.root}
                      onChange={(event) => {
                        try {
                          execute(setChord(services.store.doc, selected.id, { root: Number(event.target.value) }));
                        } catch (error) {
                          setActionError(String(error));
                        }
                      }}
                    >
                      {["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"].map((name, index) => (
                        <option key={name} value={index}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Chord quality"
                      value={selected.quality}
                      onChange={(event) => {
                        try {
                          execute(
                            setChord(services.store.doc, selected.id, {
                              quality: event.target.value as ChordQuality,
                            }),
                          );
                        } catch (error) {
                          setActionError(String(error));
                        }
                      }}
                    >
                      {(["maj", "min", "dim", "dom7", "maj7", "min7", "sus4", "sus2"] as const).map((quality) => (
                        <option key={quality} value={quality}>
                          {chordName(selected.root, quality)}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label="Remove chord"
                      onClick={() => {
                        execute(removeChord(services.store.doc, selected.id));
                        setChordSel(null);
                      }}
                    >
                      ✕
                    </button>
                    <span className="arr-chord-editor-sep" aria-hidden="true" />
                    <button
                      type="button"
                      className="arr-chord-edit-apply"
                      title="Transpose the selected scene clips' notes one octave up"
                      disabled={!hasSceneClipSelection}
                      onClick={() => {
                        try {
                          execute(transposeInstrumentClips(services.store.doc, selection.clipIds, 12));
                        } catch (error) {
                          setActionError(error instanceof Error ? error.message : String(error));
                        }
                      }}
                    >
                      +12
                    </button>
                    <button
                      type="button"
                      className="arr-chord-edit-apply"
                      title="Transpose the selected scene clips' notes one octave down"
                      disabled={!hasSceneClipSelection}
                      onClick={() => {
                        try {
                          execute(transposeInstrumentClips(services.store.doc, selection.clipIds, -12));
                        } catch (error) {
                          setActionError(error instanceof Error ? error.message : String(error));
                        }
                      }}
                    >
                      −12
                    </button>
                    <button
                      type="button"
                      className="arr-chord-edit-apply"
                      title="Snap the selected scene clips' notes to the tones of the chord under them (chord track)"
                      disabled={!hasSceneClipSelection}
                      onClick={() => {
                        try {
                          execute(conformInstrumentClipsToChordTrack(services.store.doc, selection.clipIds));
                        } catch (error) {
                          setActionError(error instanceof Error ? error.message : String(error));
                        }
                      }}
                    >
                      CONFORM
                    </button>
                  </div>
                );
              })()}
          </div>
          <div
            className={`arr-lane${tool === "cut" ? " arr-cut-tool" : ""}`}
            ref={laneRef}
            style={{ width: totalBars * barWidth, height: LANE_HEIGHT }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              // FL: Ctrl+drag on lane → range select (Cubase Range Tool)
              if ((event.ctrlKey || event.metaKey) && event.target === laneRef.current) {
                const bar = Math.max(0, (event.clientX - laneRef.current!.getBoundingClientRect().left) / barWidth);
                setTimeDrag({ startBar: bar, currentBar: bar });
                (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                event.preventDefault();
                return;
              }
              if (event.target !== laneRef.current) return;
              // Empty-lane drag = marquee-select clips. A plain click still
              // places the selected scene (handled at pointerup).
              const bar = barFromEvent(event);
              marqueeStartRef.current = bar;
              setMarquee({ from: bar, to: bar });
              (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
              event.preventDefault();
            }}
            onPointerMove={(event) => {
              if (marqueeStartRef.current !== null) {
                const bar = Math.max(0, (event.clientX - laneRef.current!.getBoundingClientRect().left) / barWidth);
                setMarquee({ from: marqueeStartRef.current, to: bar });
                return;
              }
              if (!timeDrag) return;
              // Only handle lane Ctrl+drag here; ruler has its own handler
              if (!(event.ctrlKey || event.metaKey) && event.buttons === 1) {
                // If we started via lane Ctrl+drag, keep updating even if Ctrl released
              }
              const bar = Math.max(
                0,
                Math.min(totalBars, (event.clientX - laneRef.current!.getBoundingClientRect().left) / barWidth),
              );
              setTimeDrag({ startBar: timeDrag.startBar, currentBar: bar });
              // Same snap contract as the ruler's range drag (Shift suspends).
              const grid = event.shiftKey ? null : snapBarsFor(snapGrid);
              const from = snapBar(Math.min(timeDrag.startBar, bar), grid);
              const to = snapBar(Math.max(timeDrag.startBar, bar), grid);
              if (Math.abs(to - from) > 0.15)
                selectionStore.setTimeRange({
                  fromTick: Math.floor(from * barUnit),
                  toTick: Math.floor(to * barUnit),
                });
              else selectionStore.setTimeRange(null);
            }}
            onPointerUp={(event) => {
              if (marqueeStartRef.current !== null) {
                // Floor: a plain click PLACES a clip — fractional bars used
                // to persist off-grid (moveArrangementClip rounds, this
                // path did not; addArrangementClip even toasted "bar 4.37").
                const bar = Math.max(
                  0,
                  Math.floor((event.clientX - laneRef.current!.getBoundingClientRect().left) / barWidth),
                );
                const from = Math.min(marqueeStartRef.current, bar);
                const to = Math.max(marqueeStartRef.current, bar);
                marqueeStartRef.current = null;
                setMarquee(null);
                try {
                  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
                } catch {
                  /* pointer already gone */
                }
                if (to - from < 0.15) {
                  // Plain click on empty lane: place the selected scene.
                  if (selectedScene) placeScene(selectedScene.id, from);
                  selectionStore.setClips([]);
                  setSelectedClipId(null);
                  setSelectedAudioClipId(null);
                } else {
                  // Marquee spans BOTH clip systems (ADR 0025) — one
                  // projection, one intersect, either kind in the selection.
                  selectionStore.setClips(
                    timelineItemsOf(services.store.doc)
                      .filter((item) => item.startBar < to && item.startBar + item.lengthBars > from)
                      .map((item) => item.id),
                  );
                  setSelectedClipId(null);
                }
                return;
              }
              if (!timeDrag) return;
              const from = Math.min(timeDrag.startBar, timeDrag.currentBar);
              const to = Math.max(timeDrag.startBar, timeDrag.currentBar);
              if (Math.abs(to - from) < 0.15 && !(event.ctrlKey || event.metaKey)) {
                // Small drag without Ctrl was actually a click → place already handled
                selectionStore.setTimeRange(null);
              }
              setTimeDrag(null);
              try {
                (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
              } catch {
                /* pointer already gone (cancelled) */
              }
            }}
            onPointerCancel={() => {
              marqueeStartRef.current = null;
              setMarquee(null);
              setTimeDrag(null);
              selectionStore.setTimeRange(null);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const sceneId = event.dataTransfer.getData("application/x-pulse-forge-scene");
              if (!sceneId) return;
              // Drop ON a clip swaps that clip's variant (arrangement-as-a-tool);
              // drop on empty space places a new clip — one gesture, two intents.
              const bar = barFromEvent(event);
              const hit = clips.find((c) => bar >= c.startBar && bar < c.startBar + c.lengthBars);
              if (hit && hit.sceneId !== sceneId) {
                try {
                  execute(setArrangementClipScene(services.store.doc, hit.id, sceneId));
                } catch (err) {
                  setActionError(err instanceof Error ? err.message : String(err));
                }
                return;
              }
              placeScene(sceneId, bar);
            }}
          >
            <ArrPlayheadLine
              transport={services.transport}
              barWidth={barWidth}
              className="arr-playhead arr-playhead-lane"
              barUnitTicks={barUnit}
            />
            {selection.timeRange && (
              <div
                className="arr-time-range arr-time-range-lane"
                style={{
                  left: (Math.min(selection.timeRange.fromTick, selection.timeRange.toTick) / barUnit) * barWidth,
                  width: (Math.abs(selection.timeRange.toTick - selection.timeRange.fromTick) / barUnit) * barWidth,
                }}
              />
            )}
            {marquee && (
              <div
                className="arr-marquee"
                style={{
                  left: Math.min(marquee.from, marquee.to) * barWidth,
                  width: Math.abs(marquee.to - marquee.from) * barWidth,
                }}
              />
            )}
            {(
              visibleBarIndices ??
              Array.from({ length: Math.min(totalBars, UNMEASURED_GRID_BAR_CAP) }, (_, index) => index)
            ).map((index) => (
              <div
                key={index}
                className={`arr-bar-grid${index % 4 === 0 ? " bar-strong" : ""}`}
                style={{ left: index * barWidth }}
              />
            ))}
            {visibleClips.map(({ clip, index }) => {
              const scene = scenes.find((candidate) => candidate.id === clip.sceneId);
              const role = scene ? (sceneRoleOf(scene) ?? "custom") : "custom";
              const isDragging = dragRef.current?.clipId === clip.id && drag !== null;
              const ghostShift = ghostShiftFor(clip.id, clip.startBar, rippleGhost?.fromScene ?? 0);
              const multiMoving = dragRef.current?.movingIds?.includes(clip.id) && multiDrag !== null;
              const groupStartBar =
                groupDragPreview?.projectId === doc.id
                  ? groupDragPreviewStartBar(groupDragPreview, clip.id, clip.startBar)
                  : undefined;
              const startBar =
                groupStartBar ?? (multiMoving ? clip.startBar + multiDrag : isDragging ? drag.startBar : clip.startBar);
              const lengthBars = isDragging ? drag.lengthBars : clip.lengthBars;
              const nextClip = clips[index + 1];
              const selected = selectedClipId === clip.id || selectionStore.isClipSelected(clip.id);
              const isCurrentClip = clip.id === currentClipId;
              return (
                <div key={clip.id}>
                  <div
                    className={`arr-clip role-${role}${selected ? " selected" : ""}${isCurrentClip ? " current" : ""}${runtime.playing && isCurrentClip ? " playing" : ""}${clip.locked ? " locked" : ""}${arrangement.clipGroups?.some((g) => g.clipIds.includes(clip.id)) ? " grouped" : ""}`}
                    style={{ left: startBar * barWidth, width: lengthBars * barWidth - 4 }}
                    title={`${scene?.name ?? "?"} · ${role.toUpperCase()}${clip.locked ? " · LOCKED" : ""} · bars ${startBar + 1}–${startBar + lengthBars}`}
                    onPointerDown={(event) => {
                      // CUT TOOL (ADR 0025): the razor splits scene OR audio
                      // clips at the click — the one interaction a drag
                      // gesture cannot express. Scene clips land on their bar
                      // grid (the command floors), audio clips cut
                      // sample-precise, snapped when the grid is on.
                      if (tool === "cut") {
                        event.stopPropagation();
                        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                        const bar = Math.max(0, clip.startBar + (event.clientX - rect.left) / Math.max(1, barWidth));
                        execute(
                          splitArrangementClipAtTick(
                            services.store.doc,
                            clip.id,
                            Math.floor(snapBar(bar, snapBarsFor(snapGrid)) * barUnit),
                          ),
                        );
                        return;
                      }
                      clipLongPressTargetRef.current = clip.id;
                      clipLongPress.onPointerDown(event);
                      const rect = event.currentTarget.getBoundingClientRect();
                      const zone =
                        event.clientX < rect.left + 10
                          ? "trimStart"
                          : event.clientX > rect.right - 10
                            ? "resize"
                            : "move";
                      beginClipDrag(event, clip.id, zone);
                    }}
                    onPointerMove={(event) => {
                      clipLongPress.onPointerMove();
                      onClipPointerMove(event);
                    }}
                    onPointerLeave={clipLongPress.onPointerLeave}
                    onPointerUp={(event) => {
                      clipLongPress.onPointerUp();
                      onClipPointerUp(event);
                    }}
                    onPointerCancel={(event) => {
                      clipLongPress.onPointerCancel();
                      onClipPointerCancel(event);
                    }}
                    onClick={() => setSelectedClipId(clip.id)}
                    onContextMenu={clipLongPress.wrapContextMenu((event) => {
                      event.preventDefault();
                      // Right-click deletes the whole active selection (or the
                      // clicked clip) as one undoable gesture + toast with UNDO.
                      const ids = selectionStore.isClipSelected(clip.id) ? [...selection.clipIds] : [clip.id];
                      deleteClipsWithToast(ids);
                    })}
                  >
                    <span className="arr-clip-copy">
                      <span className="arr-clip-role">{role.toUpperCase()}</span>
                      <span className="arr-clip-name">{scene?.name ?? "?"}</span>
                    </span>
                    <span className="arr-clip-bars">{lengthBars}b</span>
                    <span className="arr-clip-resize" />
                  </div>
                  {ghostShift !== 0 && (
                    <div
                      className="arr-ripple-ghost"
                      style={{ left: (clip.startBar + ghostShift) * barWidth, width: clip.lengthBars * barWidth - 4 }}
                    />
                  )}
                  {nextClip && (
                    <button
                      type="button"
                      className={`arr-transition-mark${transitionBoundary?.fromClipId === clip.id && transitionBoundary.toClipId === nextClip.id ? " selected" : ""}`}
                      style={{ left: (clip.startBar + clip.lengthBars) * barWidth - 8 }}
                      title="Edit transition to next clip"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => selectTransitionBoundary(clip.id, nextClip.id)}
                    >
                      {arrangement.transitions?.some(
                        (transition) => transition.fromClipId === clip.id && transition.toClipId === nextClip.id,
                      )
                        ? "TR"
                        : "+"}
                    </button>
                  )}
                </div>
              );
            })}
            {visibleAudioClips.map(({ clip }) => {
              const isDragging = audioDragRef.current?.clipId === clip.id && audioDrag !== null;
              // Block move: every selected audio clip previews the shared delta.
              const multiMovingAudio = audioDragRef.current?.movingIds?.includes(clip.id) && audioMultiDrag !== null;
              // Ripple ghost (ADR 0025): at/after the moved clip's END — the
              // same threshold the ripple commands shift audio by.
              const audioGhostShift =
                isDragging || multiMovingAudio ? 0 : ghostShiftFor(clip.id, clip.startBar, rippleGhost?.fromAudio ?? 0);
              const groupStartBar =
                groupDragPreview?.projectId === doc.id
                  ? groupDragPreviewStartBar(groupDragPreview, clip.id, clip.startBar)
                  : undefined;
              const startBar =
                groupStartBar ??
                (multiMovingAudio
                  ? Math.max(0, clip.startBar + audioMultiDrag)
                  : isDragging
                    ? audioDrag.startBar
                    : clip.startBar + audioGhostShift);
              const lengthBars = isDragging ? audioDrag.lengthBars : clip.lengthBars;
              // Shared selection drives the visual, same as scene clips; the
              // local mirror stays for panel features that follow ONE clip
              // (take lanes, warp pins, context menu).
              const selected = selectedAudioClipId === clip.id || selectionStore.isClipSelected(clip.id);
              const isCurrent = clip.id === currentClipId;
              const track = tracks.find((t) => t.id === clip.trackId);
              const clipTakeGroup = clip.takeGroupId
                ? arrangement.takeGroups?.find((group) => group.id === clip.takeGroupId)
                : undefined;
              const compSourceTakeNumber = clip.compSourceTakeId
                ? Array.from(
                    new Set(
                      (arrangement.audioClips ?? [])
                        .filter(
                          (candidate) =>
                            candidate.takeGroupId === clip.takeGroupId &&
                            candidate.takeId &&
                            candidate.takeId !== clipTakeGroup?.compTakeId,
                        )
                        .map((candidate) => candidate.takeId!),
                    ),
                  ).indexOf(clip.compSourceTakeId) + 1
                : 0;
              // Alt+drag stretch preview: badge + tooltip show the live rate.
              const effRate =
                audioStretchPreview?.clipId === clip.id ? audioStretchPreview.rate : (clip.stretchRate ?? 1);
              const buffer = services.bank.get(clip.bufferId);
              const effFadeIn = audioFadePreview?.clipId === clip.id ? audioFadePreview.fadeIn : (clip.fadeIn ?? 0);
              const effFadeOut = audioFadePreview?.clipId === clip.id ? audioFadePreview.fadeOut : (clip.fadeOut ?? 0);
              const effGain = audioGainPreview?.clipId === clip.id ? audioGainPreview.gain : (clip.gain ?? 1);
              // Slip preview: the waveform draws the shifted source window.
              const effOffsetSec =
                audioSlipPreview?.clipId === clip.id ? audioSlipPreview.offsetSec : (clip.offsetSec ?? 0);
              // Fade overlay widths use the clip's OWN wall duration (scene
              // tempo aware, matching the drag sensitivity in beginAudioDrag),
              // not doc.bpm — under a pinned scene the handle sat at the
              // wrong fraction of the clip.
              const clipSecPerBar =
                lengthBars > 0
                  ? arrangementSecondsBetweenTicks(
                      clips,
                      scenes,
                      startBar * ticksPerBar(doc),
                      (startBar + lengthBars) * ticksPerBar(doc),
                      doc.bpm,
                      ticksPerBar(doc),
                    ) / lengthBars
                  : (barUnit * 60) / (doc.bpm * PPQ);
              return (
                <div
                  key={clip.id}
                  className={`arr-audio-clip${selected ? " selected" : ""}${isCurrent ? " current" : ""}${clip.takeId === clipTakeGroup?.compTakeId ? " comp" : ""}${clip.muted ? " muted" : ""}${clip.locked ? " locked" : ""}${arrangement.clipGroups?.some((g) => g.clipIds.includes(clip.id)) ? " grouped" : ""}`}
                  style={{ left: startBar * barWidth, width: lengthBars * barWidth - 4 }}
                  title={`${track?.name ?? clip.trackId} · ${clip.bufferId} · ${clip.locked ? "LOCKED " : ""}${clip.muted ? "MUTED " : ""}${clip.reverse ? "REV " : ""}${clip.loop ? "LOOP " : ""}${(clip.warpMarkers?.length ?? 0) > 0 ? `WARP${clip.warpMarkers!.length} ` : ""}${clip.pitchSemitones ? `PITCH${clip.pitchSemitones > 0 ? "+" : ""}${clip.pitchSemitones}st ` : ""}${clip.stretchMode === "stretch" ? `STRETCH×${effRate.toFixed(2)} ` : effRate !== 1 ? `×${effRate.toFixed(2)} ` : ""}${lengthBars}b · trim ${clip.trimStart.toFixed(2)}/${clip.trimEnd.toFixed(2)} fade ${effFadeIn.toFixed(2)}/${effFadeOut.toFixed(2)} gain ${effGain.toFixed(2)} — M mutes · PT: top corners fade, top middle clip gain, Alt+edge stretches, Alt+body slips${clip.reverse || clip.loop || (clip.warpMarkers?.length ?? 0) > 0 ? " (slip off: REV/LOOP/WARP)" : ""}`}
                  onPointerDown={(event) => {
                    // CUT TOOL: sample-precise split at the pointer, snapped
                    // when the grid is on (same click contract as the scene
                    // razor — see that branch).
                    if (tool === "cut") {
                      event.stopPropagation();
                      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                      const bar = Math.max(0, clip.startBar + (event.clientX - rect.left) / Math.max(1, barWidth));
                      execute(
                        splitAudioClipAtTick(
                          services.store.doc,
                          clip.id,
                          Math.floor(snapBar(bar, snapBarsFor(snapGrid)) * barUnit),
                          services.bank.get(clip.bufferId)?.duration,
                        ),
                      );
                      return;
                    }
                    audioLongPressTargetRef.current = { clipId: clip.id, x: event.clientX, y: event.clientY };
                    audioLongPress.onPointerDown(event);
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                    const x = event.clientX - rect.left;
                    const w = rect.width;
                    if (x < 8) beginAudioDrag(event, clip.id, event.altKey ? "stretch" : "trimStart", "left");
                    else if (x > w - 8) beginAudioDrag(event, clip.id, event.altKey ? "stretch" : "resize", "right");
                    else beginAudioDrag(event, clip.id, event.altKey ? "slip" : "move");
                  }}
                  onPointerMove={(event) => {
                    audioLongPress.onPointerMove();
                    onAudioPointerMove(event);
                  }}
                  onPointerLeave={audioLongPress.onPointerLeave}
                  onPointerUp={(event) => {
                    audioLongPress.onPointerUp();
                    onAudioPointerUp(event);
                  }}
                  onPointerCancel={(event) => {
                    audioLongPress.onPointerCancel();
                    onAudioPointerCancel(event);
                  }}
                  onClick={() => {
                    setSelectedAudioClipId(clip.id);
                    setSelectedClipId(null);
                  }}
                  onDoubleClick={(event) => {
                    // Double-click empty waveform = add a neutral warp pin.
                    // Pin handles / trim / fade / gain zones keep their own
                    // gestures — only the bare waveform adds pins.
                    const target = event.target as HTMLElement | null;
                    if (
                      target?.closest(
                        ".warp-pin, .arr-audio-clip-handle, .arr-audio-clip-handle-fade, .arr-audio-clip-handle-gain",
                      )
                    )
                      return;
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                    if (rect.width <= 0) return;
                    const frac = (event.clientX - rect.left) / rect.width;
                    addWarpPinAtTick(clip, Math.round(clip.startBar * barUnit + frac * clip.lengthBars * barUnit));
                  }}
                  onContextMenu={audioLongPress.wrapContextMenu((event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setAudioMenu({ clipId: clip.id, x: event.clientX, y: event.clientY });
                  })}
                >
                  <AudioClipWaveform
                    buffer={buffer ?? null}
                    bufferId={clip.bufferId}
                    sourceChannel={clip.sourceChannel}
                    reverse={clip.reverse}
                    showOnsets={selected || (clip.warpMarkers?.length ?? 0) > 0}
                    offsetSec={effOffsetSec}
                    trimStart={clip.trimStart ?? 0}
                    trimEnd={clip.trimEnd ?? 0}
                    playedSourceSec={audioClipPlayedSourceSec(
                      { ...clip, offsetSec: effOffsetSec, stretchRate: effRate },
                      buffer?.duration ?? 0,
                      lengthBars * clipSecPerBar,
                    )}
                    wallSourceSec={audioClipWallSourceSec(
                      { ...clip, stretchRate: effRate },
                      lengthBars * clipSecPerBar,
                    )}
                  />
                  <WarpPinsOverlay
                    clip={clip}
                    cancelEpoch={overlayCancelEpoch}
                    barUnitTicks={barUnit}
                    disabledReason={
                      clip.reverse
                        ? "Warp needs forward playback — switch off Reverse"
                        : clip.loop
                          ? "Warp is bypassed on looped clips — switch off Loop"
                          : null
                    }
                    onCommit={(markers) => {
                      try {
                        execute(updateAudioClip(services.store.doc, clip.id, { warpMarkers: markers }));
                        services.engine.warmWarpForClip({ ...clip, warpMarkers: markers });
                      } catch (err) {
                        setActionError(err instanceof Error ? err.message : "Warp edit failed");
                      }
                    }}
                  />
                  <span className="arr-audio-clip-label">
                    {clip.compSourceTakeId
                      ? `COMP · TAKE ${compSourceTakeNumber}`
                      : clip.sourceChannel !== undefined
                        ? `CH ${clip.sourceChannel + 1} · `
                        : ""}
                    {track?.name ?? clip.bufferId.slice(0, 8)}
                  </span>
                  {selected && (clip.warpMarkers ?? []).length === 0 && !clip.reverse && !clip.loop && buffer && (
                    <span
                      className="arr-audio-clip-hint"
                      title="Double-click the waveform to drop a warp pin, then drag pins to bend time (Shift = snap 1/16)"
                    >
                      2×click: +pin · drag pins to bend
                    </span>
                  )}
                  <span
                    className="arr-audio-clip-handle left"
                    title="Trim start (Alt = stretch, pins the end)"
                    onPointerDown={(e) => beginAudioDrag(e, clip.id, e.altKey ? "stretch" : "trimStart", "left")}
                  />
                  <span
                    className="arr-audio-clip-handle right"
                    title="Resize / trim end (Alt = stretch, pins the start)"
                    onPointerDown={(e) => beginAudioDrag(e, clip.id, e.altKey ? "stretch" : "resize", "right")}
                  />
                  <span
                    className="arr-audio-clip-handle-fade left"
                    title={`Fade in ${effFadeIn.toFixed(2)}s — drag horizontal (PT top corner)`}
                    onPointerDown={(e) => beginAudioDrag(e, clip.id, "fadeIn")}
                  />
                  <span
                    className="arr-audio-clip-handle-fade right"
                    title={`Fade out ${effFadeOut.toFixed(2)}s — drag horizontal`}
                    onPointerDown={(e) => beginAudioDrag(e, clip.id, "fadeOut")}
                  />
                  <span
                    className="arr-audio-clip-handle-gain"
                    title={`Clip gain ${effGain.toFixed(2)} (${(20 * Math.log10(Math.max(effGain, 0.001))).toFixed(1)} dB) — drag vertical (PT top middle)`}
                    onPointerDown={(e) => beginAudioDrag(e, clip.id, "gain")}
                  />
                  {selected && (
                    <div className="arr-audio-clip-fades">
                      <span
                        className="arr-audio-fade in"
                        style={{
                          width: Math.min(24, (effFadeIn / (clipSecPerBar * lengthBars)) * lengthBars * barWidth),
                        }}
                      />
                      <span
                        className="arr-audio-fade out"
                        style={{
                          width: Math.min(24, (effFadeOut / (clipSecPerBar * lengthBars)) * lengthBars * barWidth),
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <MidiClipLanes
            doc={services.store.getDoc()}
            tracks={tracks}
            midiClips={visibleMidiClips}
            selectedClipIds={selection.clipIds.filter((id) => midiClips.some((clip) => clip.id === id))}
            totalBars={totalBars}
            barWidth={barWidth}
            snapGrid={snapGrid}
            playheadTick={services.transport.position}
            onExecute={execute}
            onSelect={(id, mode = "replace") => {
              setSelectedClipId(null);
              setSelectedAudioClipId(null);
              if (mode === "toggle") {
                selectionStore.setClips([id], "add");
              } else if (mode === "range") {
                const trackOrder = new Map(tracks.map((track, index) => [track.id, index]));
                const ordered = [...midiClips].sort(
                  (a, b) =>
                    (trackOrder.get(a.trackId) ?? Number.MAX_SAFE_INTEGER) -
                      (trackOrder.get(b.trackId) ?? Number.MAX_SAFE_INTEGER) || a.startTick - b.startTick,
                );
                const lastSelected = selection.clipIds.at(-1);
                const from = ordered.findIndex((clip) => clip.id === lastSelected);
                const to = ordered.findIndex((clip) => clip.id === id);
                selectionStore.setClips(
                  from !== -1 && to !== -1
                    ? ordered.slice(Math.min(from, to), Math.max(from, to) + 1).map((clip) => clip.id)
                    : [id],
                );
              } else if (!selectionStore.isClipSelected(id)) {
                selectionStore.setClips([id]);
              }
            }}
            onEditSource={openMidiClipSource}
            onMakeUniqueAndEdit={makeMidiClipUniqueAndEdit}
          />
          <AutomationClipLanes
            doc={services.store.getDoc()}
            automationClips={visibleAutomationClips}
            selectedClipId={selection.clipIds.find((id) => automationClips.some((clip) => clip.id === id)) ?? null}
            totalBars={totalBars}
            barWidth={barWidth}
            snapGrid={snapGrid}
            playheadTick={services.transport.position}
            onExecute={execute}
            onSelect={(id) => {
              setSelectedClipId(null);
              setSelectedAudioClipId(null);
              selectionStore.setClips([id]);
            }}
          />
          {/* The intensity strip is a SIBLING of the clip lane, not its last
              child. Inside a fixed-height `.arr-lane` the 44px strip overflowed
              the clips (both `z-index: auto`, so tree order gave the strip the
              top hit): with INT on — the default — every press on a scene clip
              landed on the strip, so clips could be neither selected nor
              dragged. In flow below the lane it is what the toolbar title and
              this component's own doc comment already promise: one strip
              UNDER the clip lane. */}
          {showIntensity && (
            <IntensityLane
              scenes={scenes}
              clips={clips}
              totalBars={totalBars}
              transport={services.transport}
              barWidth={barWidth}
              cancelEpoch={overlayCancelEpoch}
              barUnitTicks={barUnit}
              onEdit={(sceneId, curve) => execute(setSceneIntensityCurve(services.store.doc, sceneId, curve))}
            />
          )}
          {showAudioTakeLanes && selectedAudioTakeGroup && (
            <section
              id="arr-audio-take-lanes"
              className="arr-audio-take-lanes"
              aria-label="Audio take lanes"
              style={{ width: totalBars * barWidth }}
            >
              <div className="arr-audio-take-lanes-heading">
                <span>TAKE LANES</span>
                <label className="arr-arm-gain">
                  <span>CROSSFADE</span>
                  <select
                    className="arr-arm-select"
                    aria-label="Comp crossfade duration"
                    title="Equal-power overlap at changed comp boundaries; undo restores the previous comp."
                    value={compCrossfadeTicks}
                    onChange={(event) => setCompCrossfadeTicks(Number(event.target.value))}
                  >
                    <option value={0}>OFF</option>
                    <option value={30}>1/64</option>
                    <option value={60}>1/32</option>
                    <option value={120}>1/16</option>
                    <option value={240}>1/8</option>
                  </select>
                </label>
                {audioTakeLaneRange?.groupId === selectedAudioTakeGroup.id &&
                  selectedAudioTakeIds.includes(audioTakeLaneRange.sourceTakeId) && (
                    <button
                      type="button"
                      className="btn btn-small"
                      aria-label="Comp selected take-lane range"
                      title="Replace this exact arrangement range with the selected source take. The source pass stays unchanged; undo restores the previous comp."
                      onClick={() =>
                        compAudioRange(
                          audioTakeLaneRange.groupId,
                          audioTakeLaneRange.sourceTakeId,
                          audioTakeLaneRange.startTick,
                          audioTakeLaneRange.endTick,
                        )
                      }
                    >
                      COMP SELECTED RANGE
                    </button>
                  )}
                <span className="arr-audio-take-lanes-track-name">
                  {tracks.find((track) => track.id === selectedAudioTakeGroup.trackId)?.name ?? "AUDIO"}
                </span>
              </div>
              {[
                ...selectedAudioTakeIds,
                ...(selectedAudioTakeGroup.compTakeId ? [selectedAudioTakeGroup.compTakeId] : []),
              ].map((takeId, laneIndex) => {
                const isCompTake = takeId === selectedAudioTakeGroup.compTakeId;
                const laneLabel = isCompTake ? "COMP" : `TAKE ${laneIndex + 1}`;
                const laneClips = (arrangement.audioClips ?? []).filter(
                  (clip) => clip.takeGroupId === selectedAudioTakeGroup.id && clip.takeId === takeId,
                );
                if (laneClips.length === 0) return null;
                const isActive = selectedAudioTakeGroup.activeTakeId === takeId;
                const isAuditioning =
                  audioTakeAudition?.groupId === selectedAudioTakeGroup.id && audioTakeAudition.takeId === takeId;
                const activateTake = () => {
                  if (!isActive) execute(setActiveAudioTake(services.store.doc, selectedAudioTakeGroup.id, takeId));
                  setSelectedAudioClipId(laneClips[0]!.id);
                };
                return (
                  <div className={`arr-audio-take-lane${isActive ? " active" : ""}`} key={takeId}>
                    <div className="arr-audio-take-lane-header">
                      <button
                        type="button"
                        className="arr-audio-take-lane-select"
                        aria-label={`Activate ${laneLabel}`}
                        aria-pressed={isActive}
                        title="Make this pass the audible take. Other takes remain intact and can be restored with undo."
                        onClick={activateTake}
                      >
                        <span className="arr-audio-take-lane-name">{laneLabel}</span>
                        <span className="arr-audio-take-lane-status">{isActive ? "ACTIVE" : "ACTIVATE"}</span>
                        <span className="arr-audio-take-lane-count">
                          {laneClips.length} CLIP{laneClips.length === 1 ? "" : "S"}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-small arr-audio-take-lane-audition"
                        aria-label={
                          isAuditioning
                            ? `${audioTakeAudition?.state === "live" ? "Stop live audition" : "Stop audition"} ${laneLabel}`
                            : `${services.transport.playing ? "Live solo" : "Audition"} ${laneLabel}`
                        }
                        aria-pressed={isAuditioning}
                        title={
                          services.transport.playing
                            ? "Solo this take in the live song mix. It ends on stop, pause, project edit, or when take lanes close."
                            : "Render and audition this take lane alone through its track and master effects"
                        }
                        onClick={() => void auditionAudioTake(selectedAudioTakeGroup.id, takeId)}
                      >
                        {isAuditioning
                          ? audioTakeAudition?.state === "rendering"
                            ? "CANCEL"
                            : "STOP"
                          : services.transport.playing
                            ? "LIVE SOLO"
                            : "AUDITION"}
                      </button>
                    </div>
                    <div
                      className="arr-audio-take-lane-track"
                      aria-label={`${laneLabel} timeline segments`}
                      title={
                        isCompTake
                          ? `${laneLabel} · click to activate the comp`
                          : `${laneLabel} · drag to select a comp range`
                      }
                      style={{ width: totalBars * barWidth, backgroundSize: `${barWidth}px 100%` }}
                      onPointerDown={(event) => startTakeLaneRangeDrag(event, selectedAudioTakeGroup.id, takeId)}
                      onPointerMove={updateTakeLaneRangeDrag}
                      onPointerUp={finishTakeLaneRangeDrag}
                      onPointerCancel={() => {
                        audioTakeLaneDragRef.current = null;
                        setAudioTakeLaneRange(null);
                      }}
                      onClickCapture={(event) => {
                        if (!suppressTakeLaneClickRef.current) return;
                        suppressTakeLaneClickRef.current = false;
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                    >
                      {audioTakeLaneRange?.groupId === selectedAudioTakeGroup.id &&
                        audioTakeLaneRange.sourceTakeId === takeId &&
                        audioTakeLaneRange.endTick > audioTakeLaneRange.startTick && (
                          <div
                            className="arr-audio-take-lane-range"
                            aria-label={`Selected comp range from ${laneLabel}`}
                            style={{
                              left: (audioTakeLaneRange.startTick / barUnit) * barWidth,
                              width: ((audioTakeLaneRange.endTick - audioTakeLaneRange.startTick) / barUnit) * barWidth,
                            }}
                          />
                        )}
                      {laneClips.map((clip) => {
                        const laneBuffer = services.bank.get(clip.bufferId) ?? null;
                        return (
                          <button
                            type="button"
                            className={`arr-audio-take-lane-segment${isCompTake ? " comp" : ""}`}
                            key={clip.id}
                            aria-label={`Select ${laneLabel} segment at bar ${Math.floor(clip.startBar) + 1}`}
                            title={`${laneLabel} · bars ${clip.startBar + 1}–${clip.startBar + clip.lengthBars}`}
                            style={{
                              left: clip.startBar * barWidth,
                              width: Math.max(12, clip.lengthBars * barWidth - 3),
                            }}
                            onClick={activateTake}
                          >
                            <AudioClipWaveform
                              buffer={laneBuffer}
                              bufferId={clip.bufferId}
                              sourceChannel={clip.sourceChannel}
                              reverse={clip.reverse}
                              showOnsets={false}
                              offsetSec={clip.offsetSec ?? 0}
                              trimStart={clip.trimStart ?? 0}
                              trimEnd={clip.trimEnd ?? 0}
                              playedSourceSec={audioClipPlayedSourceSec(
                                clip,
                                laneBuffer?.duration ?? 0,
                                audioClipDurationSec(doc, clip.lengthBars, clip.startBar),
                              )}
                              wallSourceSec={audioClipWallSourceSec(
                                clip,
                                audioClipDurationSec(doc, clip.lengthBars, clip.startBar),
                              )}
                            />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </section>
          )}
        </div>

        {deleteToast && (
          <div className="arr-delete-toast" role="status">
            <span>{deleteToast.label}</span>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                services.store.undo();
                setDeleteToast(null);
              }}
            >
              UNDO
            </button>
          </div>
        )}

        {transitionBoundary && (
          <div className="arr-transition-editor">
            <span className="arr-transition-label">
              TRANSITION{" "}
              {scenes.find(
                (scene) => scene.id === clips.find((clip) => clip.id === transitionBoundary.fromClipId)?.sceneId,
              )?.name ?? "?"}{" "}
              →{" "}
              {scenes.find(
                (scene) => scene.id === clips.find((clip) => clip.id === transitionBoundary.toClipId)?.sceneId,
              )?.name ?? "?"}
            </span>
            <select
              value={transitionDraft.type}
              onChange={(event) =>
                setTransitionDraft((draftValue) => ({
                  ...draftValue,
                  type: event.target.value as ArrangementTransitionType,
                }))
              }
            >
              {TRANSITION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type.toUpperCase()}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              max={4}
              step={1}
              value={transitionDraft.lengthBars}
              aria-label="Transition length in bars"
              onChange={(event) =>
                setTransitionDraft((draftValue) => ({
                  ...draftValue,
                  lengthBars: Math.min(4, Math.max(1, Number(event.target.value) || 1)),
                }))
              }
            />
            <input
              value={transitionDraft.cueAssetId}
              placeholder="cue asset (optional)"
              aria-label="Transition cue asset"
              onChange={(event) =>
                setTransitionDraft((draftValue) => ({ ...draftValue, cueAssetId: event.target.value }))
              }
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={!transitionDraft.cueAssetId.trim()}
              onClick={() => services.engine.previewAsset(transitionDraft.cueAssetId.trim())}
            >
              PREVIEW CUE
            </button>
            <button type="button" className="btn btn-small" onClick={applyTransition}>
              {selectedTransition ? "UPDATE" : "ADD"}
            </button>
            {selectedTransition && (
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={() => {
                  execute(removeArrangementTransition(services.store.doc, selectedTransition.id));
                  setTransitionBoundary(null);
                }}
              >
                DELETE
              </button>
            )}
          </div>
        )}
        {audioMenu && (
          <div
            className="context-menu"
            role="menu"
            style={{ left: audioMenu.x, top: audioMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="context-menu-header">AUDIO CLIP</div>
            {(() => {
              const menuClip = audioClips.find((item) => item.id === audioMenu.clipId);
              if (!menuClip) return null;
              return (
                <div role="group" aria-label="Fade curve">
                  <div className="context-menu-header">FADE CURVE</div>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={menuClip.fadeCurve !== "equal"}
                    onClick={() => {
                      execute(updateAudioClip(services.store.doc, menuClip.id, { fadeCurve: "linear" }));
                      setAudioMenu(null);
                    }}
                  >
                    Linear (default)
                  </button>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={menuClip.fadeCurve === "equal"}
                    onClick={() => {
                      execute(updateAudioClip(services.store.doc, menuClip.id, { fadeCurve: "equal" }));
                      setAudioMenu(null);
                    }}
                  >
                    Equal power (crossfades)
                  </button>
                </div>
              );
            })()}
            {(() => {
              const clip = audioClips.find((item) => item.id === audioMenu.clipId);
              const buffer = clip ? services.bank.get(clip.bufferId) : null;
              if (!clip || !buffer || buffer.numberOfChannels < 2) return null;
              return (
                <div role="group" aria-label="Audio clip channel routing">
                  <div className="context-menu-header">SOURCE CHANNEL</div>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={clip.sourceChannel === undefined}
                    onClick={() => {
                      execute(updateAudioClip(services.store.doc, clip.id, { sourceChannel: null }));
                      setAudioMenu(null);
                    }}
                  >
                    All source channels (stereo)
                  </button>
                  {Array.from({ length: buffer.numberOfChannels }, (_, channel) => (
                    <button
                      key={channel}
                      type="button"
                      role="menuitemradio"
                      aria-checked={clip.sourceChannel === channel}
                      onClick={() => {
                        execute(updateAudioClip(services.store.doc, clip.id, { sourceChannel: channel }));
                        setAudioMenu(null);
                      }}
                    >
                      Captured channel {channel + 1} (mono)
                    </button>
                  ))}
                </div>
              );
            })()}
            <button
              type="button"
              role="menuitem"
              title="RX-style spectral surgery — select a time×frequency region and attenuate or boost it"
              onClick={() => {
                setSpectralEditClipId(audioMenu.clipId);
                setAudioMenu(null);
              }}
            >
              Spectral Edit…
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                if (c) execute(updateAudioClip(services.store.doc, c.id, { reverse: !c.reverse }));
                setAudioMenu(null);
              }}
            >
              Reverse ({audioClips.find((x) => x.id === audioMenu.clipId)?.reverse ? "ON" : "OFF"})
            </button>
            <button
              type="button"
              role="menuitem"
              title="Loop the trimmed content for the whole clip length — texture beds across N bars without duplicating clips"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                if (c) execute(updateAudioClip(services.store.doc, c.id, { loop: !c.loop }));
                setAudioMenu(null);
              }}
            >
              Loop ({audioClips.find((x) => x.id === audioMenu.clipId)?.loop ? "ON" : "OFF"})
            </button>
            <button
              type="button"
              role="menuitem"
              title="Pin the sample time playing at the playhead to the grid — grabs the nearest transient within 60 ms. Resample clips bend pitch (repitch warp), Stretch clips keep pitch (phase-vocoder pre-render, warmed in background)"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                if (!c) {
                  setAudioMenu(null);
                  return;
                }
                const pos = services.transport.position;
                const clipStartTick = c.startBar * barUnit;
                const clipTicks = c.lengthBars * barUnit;
                if (!(pos > clipStartTick) || !(pos < clipStartTick + clipTicks)) {
                  setActionError("Move playhead inside the clip, then pin");
                  setAudioMenu(null);
                  return;
                }
                addWarpPinAtTick(c, pos);
                setAudioMenu(null);
              }}
            >
              Warp pin at playhead ({(audioClips.find((x) => x.id === audioMenu.clipId)?.warpMarkers ?? []).length})
            </button>
            {(audioClips.find((x) => x.id === audioMenu.clipId)?.warpMarkers ?? []).length > 0 && (
              <button
                type="button"
                role="menuitem"
                title="Remove all warp pins — back to straight playback"
                onClick={() => {
                  const c = audioClips.find((x) => x.id === audioMenu.clipId);
                  if (c) {
                    try {
                      execute(updateAudioClip(services.store.doc, c.id, { warpMarkers: [] }));
                    } catch (err) {
                      setActionError(err instanceof Error ? err.message : "Clear warp failed");
                    }
                  }
                  setAudioMenu(null);
                }}
              >
                Clear warp pins
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                const buf = c ? services.bank.get(c.bufferId) : null;
                if (c && buf) {
                  let max = 0;
                  const ch = audioClipChannelData(buf, c.sourceChannel);
                  for (let i = 0; i < ch.length; i++) max = Math.max(max, Math.abs(ch[i]));
                  const gain = max > 0.001 ? Math.min(2, 0.99 / max) : 1;
                  execute(updateAudioClip(services.store.doc, c.id, { gain }));
                }
                setAudioMenu(null);
              }}
            >
              Normalize (gain→0.99 peak)
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                const buf = c ? services.bank.get(c.bufferId) : null;
                const detected = buf
                  ? detectLoopBpm(audioClipChannelData(buf, c?.sourceChannel), buf.sampleRate)
                  : null;
                if (c && detected) {
                  try {
                    execute(fitAudioClipTempo(services.store.doc, c.id, detected.bpm));
                  } catch (err) {
                    setActionError(err instanceof Error ? err.message : "Fit failed");
                  }
                } else {
                  setActionError("No steady tempo detected in this sample");
                }
                setAudioMenu(null);
              }}
              title="Detect the loop's tempo and pitch-preserving time-stretch it to the project BPM"
            >
              Fit to project BPM ({doc.bpm})
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                const buf = c ? services.bank.get(c.bufferId) : null;
                const measurement = buf
                  ? measurePhraseOnset([audioClipChannelData(buf, c?.sourceChannel)], buf.sampleRate, {
                      searchWindowSec: MANUAL_ALIGN_SEARCH_SEC,
                    })
                  : null;
                // Latency scale only, and only on a measured rise: beyond the
                // search window the phrase start is a musical choice (a
                // deliberate late entry), not a correction. The applied shift
                // is reported and is a normal undoable content slip.
                const shift = autoAlignShiftSec(measurement, { maxShiftSec: MANUAL_ALIGN_SEARCH_SEC });
                if (c && shift > 0) {
                  execute(slipAudioClip(services.store.doc, c.id, Math.max(0, (c.offsetSec ?? 0) + shift)));
                  setRecNotice(
                    `Clip aligned onto its phrase start (${formatShiftMs(shift)}) — ${shortcutHints.label("undo")} if that entry was deliberate.`,
                  );
                } else {
                  setActionError(
                    measurement
                      ? "No confident phrase start in the first 0.5 s — it may be a deliberate late entry; slip-edit the clip if you want it moved."
                      : "Sample not loaded",
                  );
                }
                setAudioMenu(null);
              }}
              title="Skip the measured leading silence so the phrase starts on the clip's own entry (undoable content slip)"
            >
              Align to phrase start
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                const buf = c ? services.bank.get(c.bufferId) : null;
                const pattern = patterns.find((p) => p.id === activePatternId);
                if (!buf || !c || !pattern) {
                  setActionError("Loop not loaded");
                  setAudioMenu(null);
                  return;
                }
                // The groove lives in the loop's OWN tempo — use the detected
                // one (falling back to the project tempo for steady loops).
                const channelData = audioClipChannelData(buf, c.sourceChannel);
                const bpm = detectLoopBpm(channelData, buf.sampleRate)?.bpm ?? doc.bpm;
                const map = extractGroove(channelData, buf.sampleRate, bpm, pattern.stepCount);
                if (!map) {
                  setActionError("No groove found — need a rhythmic loop");
                  setAudioMenu(null);
                  return;
                }
                // Auto-save to the groove pool — reusable on any pattern later.
                void services.groovePool
                  .save({
                    id: `groove-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
                    name: `Groove ${Math.round(bpm)} BPM`,
                    timing: map.timing,
                    accent: map.accent,
                    createdAt: new Date().toISOString(),
                  })
                  .catch(() => {});
                try {
                  execute(stealGrooveIntoPattern(doc, pattern.id, map, { applyVelocity: true }));
                } catch (err) {
                  setActionError(err instanceof Error ? err.message : "Steal groove failed");
                }
                setAudioMenu(null);
              }}
              title="Extract the loop's timing feel and accents onto the active pattern's existing steps"
            >
              Steal groove → active pattern
            </button>
            <div role="group" aria-label="AI FLIP genre">
              <div className="context-menu-header">AI FLIP → NEW SCENE</div>
              {(["house", "techno", "trap", "ambient"] as const).map((genre) => (
                <button
                  key={genre}
                  type="button"
                  role="menuitem"
                  onClick={() => runAiFlip(audioMenu.clipId, genre)}
                  title={`Generate a fresh ${genre} pattern from this loop's feel — your BPM, your key, its groove. Lands as a new scene.`}
                >
                  {genre[0].toUpperCase() + genre.slice(1)}
                </button>
              ))}
            </div>
            <button
              type="button"
              role="menuitem"
              title="Adjust time-stretch, independent pitch and tempo fit"
              onClick={() => {
                setStretchClipId(audioMenu.clipId);
                setAudioMenu(null);
              }}
            >
              Time & pitch…
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                if (!c) {
                  setAudioMenu(null);
                  return;
                }
                setAudioMenu(null);
                const buf = services.bank.get(c.bufferId);
                if (!buf) {
                  setActionError("Buffer not loaded");
                  setAudioMenu(null);
                  return;
                }
                sliceAnalysisRef.current?.abort();
                const controller = new AbortController();
                sliceAnalysisRef.current = controller;
                // Long sample analysis runs in the onset worker so slicing
                // cannot freeze the arrangement/timeline interaction.
                try {
                  const times = await detectTransientsAsync(
                    audioClipChannelData(buf, c.sourceChannel),
                    buf.sampleRate,
                    1,
                    controller.signal,
                  );
                  if (controller.signal.aborted) return;
                  const currentDoc = services.store.doc;
                  const currentClip = (currentDoc.arrangement.audioClips ?? []).find((clip) => clip.id === c.id);
                  if (
                    !currentClip ||
                    currentClip.bufferId !== c.bufferId ||
                    currentClip.sourceChannel !== c.sourceChannel ||
                    services.bank.get(currentClip.bufferId) !== buf
                  )
                    return;
                  const slices: Array<{ start: number; end: number }> = [];
                  for (let i = 0; i < Math.min(16, times.length + 1); i++) {
                    const start = i === 0 ? 0 : times[i - 1];
                    const end = i < times.length ? times[i] : buf.duration;
                    if (end - start > 0.02) slices.push({ start, end });
                  }
                  if (slices.length === 0) slices.push({ start: 0, end: buf.duration });
                  const drumTrack = currentDoc.tracks.find((t) => t.kind === "drum");
                  if (!drumTrack) {
                    setActionError("No drum track");
                  } else {
                    // Store bounced buffer as temp asset then slice
                    const bounceId = `stem-${c.id}`;
                    services.bank.add(bounceId, buf);
                    execute(sliceToPads(currentDoc, drumTrack.id, bounceId, slices, "Slice"));
                  }
                } catch (error) {
                  if (!controller.signal.aborted) setActionError(String(error));
                } finally {
                  if (sliceAnalysisRef.current === controller) sliceAnalysisRef.current = null;
                }
              }}
            >
              Slice to pads (onset)
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const pos = services.transport.position;
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                if (!c) {
                  setAudioMenu(null);
                  return;
                }
                const s = c.startBar * barUnit;
                const e = s + c.lengthBars * barUnit;
                if (pos <= s || pos >= e) {
                  setActionError("Move playhead inside clip then Ctrl+E");
                  setAudioMenu(null);
                  return;
                }
                try {
                  execute(splitAudioClipAtTick(services.store.doc, c.id, pos, services.bank.get(c.bufferId)?.duration));
                } catch (err) {
                  setActionError(String(err));
                }
                setAudioMenu(null);
              }}
            >
              Separate at playhead (Ctrl+E)
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                if (!c) {
                  setAudioMenu(null);
                  return;
                }
                const buf = services.bank.get(c.bufferId);
                if (!buf) {
                  setActionError("Buffer not loaded");
                  setAudioMenu(null);
                  return;
                }
                const data = audioClipChannelData(buf, c.sourceChannel);
                const win = 1024,
                  hop = 256,
                  thresh = 0.015;
                const frames = Math.floor((data.length - win) / hop) + 1;
                const env = new Float64Array(frames);
                for (let f = 0; f < frames; f++) {
                  let s = 0;
                  for (let i = f * hop; i < f * hop + win; i++) s += data[i] * data[i];
                  env[f] = Math.sqrt(s / win);
                }
                const segments: Array<{ startSec: number; endSec: number }> = [];
                let inSeg = false,
                  segStart = 0;
                for (let f = 0; f < frames; f++) {
                  const sec = (f * hop) / buf.sampleRate;
                  const isSilent = env[f] < thresh;
                  if (!isSilent && !inSeg) {
                    inSeg = true;
                    segStart = sec;
                  } else if (isSilent && inSeg) {
                    // require 0.08s silence to close
                    let silentFrames = 0;
                    for (let k = f; k < Math.min(frames, f + 8); k++) if (env[k] < thresh) silentFrames++;
                    if (silentFrames >= 6) {
                      segments.push({ startSec: segStart, endSec: sec });
                      inSeg = false;
                    }
                  }
                }
                if (inSeg) segments.push({ startSec: segStart, endSec: buf.duration });
                const filtered = segments.filter((s) => s.endSec - s.startSec > 0.06);
                if (filtered.length === 0) {
                  setActionError("No silence found");
                  setAudioMenu(null);
                  return;
                }
                if (filtered.length === 1 && Math.abs(filtered[0].startSec - (c.offsetSec ?? 0)) < 0.01) {
                  setActionError("Already stripped");
                  setAudioMenu(null);
                  return;
                }
                try {
                  execute(stripSilenceAudioClip(services.store.doc, c.id, filtered, buf.duration));
                } catch (err) {
                  setActionError(String(err));
                }
                setAudioMenu(null);
              }}
            >
              Strip Silence (PT)
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                let clipIds: string[];
                if (selection.timeRange) {
                  const { fromTick, toTick } = selection.timeRange;
                  clipIds = (arrangement.audioClips ?? [])
                    .filter((clip) => {
                      const startTick = clip.startBar * barUnit;
                      const endTick = startTick + clip.lengthBars * barUnit;
                      return startTick >= fromTick && endTick <= toTick;
                    })
                    .map((clip) => clip.id);
                  if (clipIds.length < 2) {
                    setActionError("Select a time range containing at least two audio clips to consolidate");
                    setAudioMenu(null);
                    return;
                  }
                } else {
                  const clip = audioClips.find((item) => item.id === audioMenu.clipId);
                  if (!clip) {
                    setAudioMenu(null);
                    return;
                  }
                  const sameTrack = (arrangement.audioClips ?? [])
                    .filter((item) => item.trackId === clip.trackId)
                    .sort((a, b) => a.startBar - b.startBar);
                  const index = sameTrack.findIndex((item) => item.id === clip.id);
                  const next = sameTrack[index + 1];
                  if (!next || Math.abs(next.startBar - (clip.startBar + clip.lengthBars)) > 0.5) {
                    setActionError("Select a time range or an adjacent clip on the same track to consolidate");
                    setAudioMenu(null);
                    return;
                  }
                  clipIds = [clip.id, next.id];
                }
                setAudioMenu(null);
                void consolidateSelectedAudioClips(clipIds);
              }}
              disabled={consolidatingAudio}
              title="Render the selected clips into a persisted audio asset. Source takes remain intact; undo restores the original clips."
            >
              {consolidatingAudio ? "Consolidating…" : "Consolidate"}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                if (c) execute(duplicateAudioClip(services.store.doc, c.id));
                setAudioMenu(null);
              }}
            >
              Duplicate
            </button>
            <button
              type="button"
              role="menuitem"
              className="btn-danger"
              onClick={() => {
                const id = audioMenu.clipId;
                execute(deleteAudioClip(services.store.doc, id));
                if (selectedAudioClipId === id) setSelectedAudioClipId(null);
                setAudioMenu(null);
              }}
            >
              Delete
            </button>
            <button type="button" role="menuitem" onClick={() => setAudioMenu(null)}>
              Close
            </button>
          </div>
        )}
        {actionError && (
          <div className="arr-error" role="status">
            {actionError}
          </div>
        )}
        {spectralEditClipId &&
          (() => {
            const c = audioClips.find((x) => x.id === spectralEditClipId);
            const buf = c ? services.bank.get(c.bufferId) : null;
            if (!c || !buf) return null;
            return <SpectralEditPanel clip={c} buffer={buf} onClose={() => setSpectralEditClipId(null)} />;
          })()}
        {stretchTarget && (
          <StretchDialog
            clipName={tracks.find((t) => t.id === stretchTarget.trackId)?.name ?? stretchTarget.trackId}
            sourceSec={stretchSourceSec}
            initialRate={stretchTarget.stretchRate ?? 1}
            initialMode={stretchTarget.stretchMode ?? "resample"}
            initialPitch={stretchTarget.pitchSemitones ?? 0}
            detectedBpm={stretchDetectedBpm}
            projectBpm={tempoAtTick(
              doc.arrangement.clips,
              doc.scenes,
              stretchTarget.startBar * ticksPerBar(doc),
              doc.bpm,
              ticksPerBar(doc),
            )}
            onApply={(rate, mode, pitchSemitones) => {
              // The factory throws before `execute`'s guard can run: stretch is
              // a direct editing verb, so a locked clip refuses here exactly as
              // it does on the stretch drag (`stretchAudioClip`). Without this
              // the refusal left the handler as an uncaught exception.
              try {
                execute(
                  updateAudioClip(services.store.doc, stretchTarget.id, {
                    stretchRate: rate,
                    stretchMode: mode,
                    pitchSemitones,
                  }),
                );
                setStretchClipId(null);
              } catch (err) {
                setActionError(err instanceof Error ? err.message : "Stretch failed");
              }
            }}
            onClose={() => setStretchClipId(null)}
          />
        )}
      </div>
    </section>
  );
}

/**
 * Transient times for one waveform's onset dots. Resolves from the shared
 * warp-onset cache (warmed by the arrangement effect); every hook awaiting
 * the same buffer shares one detection promise.
 */
function useOnsetDots(bufferId: string, sourceChannel: number | undefined, enabled: boolean): number[] | null {
  const services = useServices();
  const key = warpOnsetKey(bufferId, sourceChannel);
  const [times, setTimes] = useState<number[] | null>(() => warpOnsetCache.get(key) ?? null);
  useEffect(() => {
    if (!enabled) {
      setTimes(null);
      return;
    }
    const cached = warpOnsetCache.get(key);
    if (cached) {
      setTimes(cached);
      return;
    }
    let live = true;
    const p = getWarpOnsets(services.bank, bufferId, sourceChannel);
    if (!p) {
      setTimes(null);
      return;
    }
    p.then((result) => {
      if (live) setTimes(result);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bufferId, sourceChannel, enabled]);
  return times;
}

function AudioClipWaveform({
  buffer,
  bufferId,
  sourceChannel,
  reverse,
  showOnsets,
  offsetSec = 0,
  trimStart = 0,
  trimEnd = 0,
  playedSourceSec,
  wallSourceSec,
}: {
  buffer: AudioBuffer | null;
  bufferId: string;
  sourceChannel?: number;
  reverse: boolean;
  showOnsets: boolean;
  /** Content window — must mirror audioClipPlayWindow so the drawn envelope
   * matches what the clip actually plays (recorded trims, loop passes). */
  offsetSec?: number;
  trimStart?: number;
  trimEnd?: number;
  /** How much of the ORIGINAL sample the clip actually plays, in source
   * seconds (`audioClipPlayedSourceSec`). The drawn envelope must stop here:
   * past this point the picture shows material the clip never plays. */
  playedSourceSec?: number;
  /** The source seconds the clip's WALL LENGTH is worth
   * (`audioClipWallSourceSec`). When the source is shorter than that, the
   * clip plays what it has and the rest of its span is silence — so the
   * envelope covers only the fraction of the width that carries material. */
  wallSourceSec?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const onsets = useOnsetDots(bufferId, sourceChannel, showOnsets && buffer !== null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !buffer) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const data = audioClipChannelData(buffer, sourceChannel);
    const columns = Math.min(w, 240);
    // Map columns onto the clip's playable window (offsetSec+trimStart →
    // duration-trimEnd), not the raw buffer, so the envelope tracks playback.
    // `playedSourceSec` stops the envelope where the sound stops: a clip
    // shorter than its source draws only the part it actually plays.
    const windowSec = audioClipWaveformWindow(buffer.duration, offsetSec, trimStart, trimEnd, playedSourceSec);
    const windowDur = windowSec.endSec - windowSec.startSec;
    // HOW MUCH OF THE WIDTH CARRIES MATERIAL. A clip longer than its source
    // plays the source and then silence; drawn across the full width, the
    // envelope would claim sound where the transport plays nothing. The
    // fraction is the engine's own ratio: the material covers the first
    // `played / (wall × factor)` of the clip's span.
    const audibleFraction = audioClipAudibleWidthFraction(playedSourceSec ?? windowDur, wallSourceSec ?? windowDur);
    const envelopeWidth = w * audibleFraction;
    const sampleRate = buffer.sampleRate > 0 ? buffer.sampleRate : 1;
    const startSample = Math.max(0, Math.min(data.length - 1, Math.round(windowSec.startSec * sampleRate)));
    const endSample = Math.max(startSample + 1, Math.min(data.length, Math.round(windowSec.endSec * sampleRate)));
    const per = Math.max(1, Math.floor((endSample - startSample) / columns));
    const dim = getComputedStyle(canvas).getPropertyValue("--text-faint") || "#3a3d44";
    const rawAccent = getComputedStyle(canvas).getPropertyValue("--accent") || "#f59e0b";
    const baseHex = reverse ? "#f87171" : rawAccent.trim();
    const rgb = hexToRgb(baseHex) ?? [245, 158, 11];
    // Molten body: bright core fading to transparent at the extremes.
    const body = ctx.createLinearGradient(0, 0, 0, h);
    body.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.12)`);
    body.addColorStop(0.5, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.95)`);
    body.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.12)`);
    ctx.strokeStyle = body;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    for (let c = 0; c < columns; c++) {
      let min = 1,
        max = -1;
      // Reversed playback consumes the window END-first: column c must show
      // the mirrored slice, or the envelope does not represent the content
      // that actually plays (the fade handles already sit on wall-time edges).
      const s = reverse ? Math.max(startSample, endSample - (c + 1) * per) : startSample + c * per;
      const e = reverse ? endSample - c * per : Math.min(startSample + (c + 1) * per, endSample);
      if (s >= e) break;
      for (let i = s; i < e; i++) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const x = (c / columns) * envelopeWidth;
      const y0 = h / 2 - max * (h / 2 - 2);
      const y1 = h / 2 - min * (h / 2 - 2);
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    ctx.stroke();
    // Transient ticks: where the warp magnet would grab (selected/warped clips).
    if (onsets && onsets.length > 0 && windowDur > 0) {
      ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.6)`;
      for (const t of onsets) {
        if (t < windowSec.startSec || t > windowSec.endSec) continue;
        const x = ((reverse ? windowSec.endSec - t : t - windowSec.startSec) / windowDur) * envelopeWidth;
        if (x < 0 || x > w) continue;
        ctx.fillRect(x - 1, h - 6, 2, 5);
      }
    }
    // faint envelope line like WavetablePreview
    ctx.strokeStyle = dim;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, w, h);
  }, [
    buffer,
    bufferId,
    sourceChannel,
    reverse,
    showOnsets,
    onsets,
    offsetSec,
    trimStart,
    trimEnd,
    playedSourceSec,
    wallSourceSec,
  ]);
  if (!buffer) return <div className="audio-waveform-empty">no buffer</div>;
  return (
    <canvas
      ref={ref}
      className="audio-waveform"
      style={{ width: "100%", height: 28 }}
      aria-label="Audio waveform (min/max envelope like WavetablePreview)"
    />
  );
}

/**
 * Draggable warp pins directly on the audio waveform (FL/Slicex-style).
 *
 * Each pin locks one sample time to one grid position; dragging it
 * horizontally bends time around it (pitch follows in Resample clips,
 * pitch is preserved in Stretch clips). Model edits commit through the
 * same undoable `updateAudioClip` command as every other clip edit.
 *
 * - drag: move the pin in time (Shift = snap to 1/16)
 * - double-click empty waveform: add a neutral pin (sound does not jump)
 * - Alt-click / right-click a pin: delete it
 */
/**
 * Warp-pin drag math (pure): pointer delta → absolute tick, clamped to the
 * clip span. Shift snaps to 1/16. Shared by the move preview and the pointer
 * release — the release MUST recompute from the event (not from the preview
 * state, which can lag one batched render behind a fast flick).
 */
export function warpPinTickFromClientX(
  originTick: number,
  startX: number,
  clientX: number,
  widthPx: number,
  clipTicks: number,
  clipStartTick: number,
  snap: boolean,
): number | null {
  if (!(widthPx > 0) || !(clipTicks > 0)) return null;
  let next = originTick + ((clientX - startX) / widthPx) * clipTicks;
  if (snap) next = Math.round(next / STEP_TICKS) * STEP_TICKS;
  return Math.max(clipStartTick + 1, Math.min(clipStartTick + clipTicks - 1, Math.round(next)));
}

function WarpPinsOverlay({
  clip,
  disabledReason,
  onCommit,
  cancelEpoch = 0,
  barUnitTicks,
}: {
  clip: AudioClip;
  disabledReason: string | null;
  onCommit: (markers: { timeSec: number; tick: number }[]) => void;
  /**
   * Bumped by the panel's global gesture terminator (Escape / window blur).
   * This overlay owns its own drag ref, so the parent cannot cancel it
   * directly — the epoch is how it learns it must abort.
   */
  cancelEpoch?: number;
  /** The document's bar length in ticks (ADR 0056). */
  barUnitTicks: number;
}) {
  const barUnit = barUnitTicks;
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ index: number; originTick: number; startX: number; moved: boolean } | null>(null);
  const [dragTick, setDragTick] = useState<number | null>(null);
  // A warp-pin drag must not survive Escape or a focus loss either — otherwise
  // the pin still commits on release after the user cancelled.
  useEffect(() => {
    if (cancelEpoch === 0) return;
    dragRef.current = null;
    setDragTick(null);
  }, [cancelEpoch]);
  const markers = clip.warpMarkers ?? [];
  if (markers.length === 0) return null;
  const clipStartTick = clip.startBar * barUnit;
  const clipTicks = clip.lengthBars * barUnit;
  if (!(clipTicks > 0)) return null;

  const commitMove = (index: number, tick: number) => {
    const target = markers[index];
    if (!target) return;
    const clamped = Math.max(clipStartTick + 1, Math.min(clipStartTick + clipTicks - 1, Math.round(tick)));
    if (clamped === target.tick) return;
    const next = markers.map((m, i) => (i === index ? { ...m, tick: clamped } : m));
    next.sort((a, b) => a.tick - b.tick);
    onCommit(next.slice(0, 256));
  };

  const commitDelete = (index: number) => {
    onCommit(markers.filter((_, i) => i !== index));
  };

  return (
    <div ref={overlayRef} className="warp-pins-overlay" aria-label={`Warp pins (${markers.length})`}>
      {markers.map((m, i) => {
        const tick = dragRef.current?.index === i && dragTick !== null ? dragTick : m.tick;
        const leftPct = ((tick - clipStartTick) / clipTicks) * 100;
        if (leftPct < 0 || leftPct > 100) return null;
        const bar = Math.floor(tick / barUnit) + 1;
        return (
          <div
            key={`${m.tick}-${m.timeSec}-${i}`}
            className={`warp-pin${disabledReason ? " disabled" : ""}${dragRef.current?.index === i ? " dragging" : ""}`}
            style={{ left: `${leftPct}%` }}
          >
            <div className="warp-pin-line" />
            <button
              type="button"
              className="warp-pin-handle"
              aria-label={`Warp pin ${i + 1}, bar ${bar}, sample ${m.timeSec.toFixed(2)}s — drag to bend time, Alt-click or right-click to delete`}
              title={
                disabledReason ??
                `Warp pin · bar ${bar} · ${m.timeSec.toFixed(2)}s — drag to bend (Shift = snap 1/16), Alt-click / right-click deletes`
              }
              onPointerDown={(e) => {
                if (disabledReason) return;
                if (e.button !== 0) return;
                if (e.altKey) {
                  e.stopPropagation();
                  e.preventDefault();
                  commitDelete(i);
                  return;
                }
                e.stopPropagation();
                e.preventDefault();
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  /* no capture */
                }
                dragRef.current = { index: i, originTick: m.tick, startX: e.clientX, moved: false };
                setDragTick(m.tick);
              }}
              onPointerMove={(e) => {
                const drag = dragRef.current;
                if (!drag || drag.index !== i) return;
                const overlay = overlayRef.current;
                const width = overlay?.getBoundingClientRect().width ?? 0;
                if (width <= 0) return;
                const dx = e.clientX - drag.startX;
                if (!drag.moved && Math.abs(dx) < 3) return;
                drag.moved = true;
                const next = warpPinTickFromClientX(
                  drag.originTick,
                  drag.startX,
                  e.clientX,
                  width,
                  clipTicks,
                  clipStartTick,
                  e.shiftKey,
                );
                if (next !== null) setDragTick(next);
              }}
              onPointerUp={(e) => {
                const drag = dragRef.current;
                if (!drag || drag.index !== i) return;
                dragRef.current = null;
                setDragTick(null);
                if (!drag.moved) return;
                // Recompute from the release event — the preview state may lag
                // a fast flick by one batched render.
                const overlay = overlayRef.current;
                const width = overlay?.getBoundingClientRect().width ?? 0;
                const final = warpPinTickFromClientX(
                  drag.originTick,
                  drag.startX,
                  e.clientX,
                  width,
                  clipTicks,
                  clipStartTick,
                  e.shiftKey,
                );
                if (final === null) return;
                e.stopPropagation();
                commitMove(i, final);
              }}
              onPointerCancel={() => {
                if (dragRef.current?.index !== i) return;
                dragRef.current = null;
                setDragTick(null);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!disabledReason) commitDelete(i);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

const INTENSITY_LANE_HEIGHT = 44;
const INTENSITY_NEUTRAL = 0.7;

interface IntensityHandle {
  sceneId: string;
  /** Index into the SCENE's full curve array (points outside visible windows keep their slot). */
  index: number;
  /** Absolute tick of the point (clip start + scene-local offset). */
  absTick: number;
  value: number;
}

/**
 * Scene-intensity lane on the arrangement timeline (VISION §11): the engine
 * already schedules `scene.intensityCurve` live and offline — this lane makes
 * the curve VISIBLE and editable in place. One strip under the clip lane,
 * one curve segment per scene clip window, points committed through the same
 * undoable `setSceneIntensityCurve` command the ModPanel editor uses.
 */
/**
 * Playhead line as a LEAF: the 1/8-bar rAF subscription lives here, so the
 * arrangement panel stops re-rendering at the playhead cadence (quality
 * backlog B4 — the panel now only re-renders when the playhead crosses a
 * clip, on an edit, or on a selection change).
 */
function ArrPlayheadLine({
  transport,
  barWidth,
  className,
  barUnitTicks,
}: {
  transport: Transport;
  barWidth: number;
  className: string;
  /** The document's bar length in ticks (ADR 0056). */
  barUnitTicks: number;
}) {
  const playheadBar = usePlayheadBar(transport, barUnitTicks);
  return <div className={className} style={{ left: playheadBar * barWidth }} />;
}

function IntensityLane({
  scenes,
  clips,
  totalBars,
  transport,
  barWidth,
  onEdit,
  cancelEpoch = 0,
  barUnitTicks,
}: {
  scenes: ProjectDocument["scenes"];
  clips: ArrangementClip[];
  totalBars: number;
  transport: Transport;
  barWidth: number;
  onEdit: (sceneId: string, curve: IntensityPoint[]) => void;
  /**
   * Bumped by the panel's global gesture terminator (Escape / window blur).
   * This lane owns its own drag ref, so the parent cancels it by token rather
   * than by reaching into its internals.
   */
  cancelEpoch?: number;
  /** The document's bar length in ticks (ADR 0056). */
  barUnitTicks: number;
}) {
  const barUnit = barUnitTicks;
  const laneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    sceneId: string;
    index: number;
    curve: IntensityPoint[];
    origOffset: number;
    origValue: number;
    /** Absolute tick of the handle when the drag began. */
    originAbsTick: number;
  } | null>(null);
  const [live, setLive] = useState<{ sceneId: string; index: number; absTick: number; value: number } | null>(null);
  // A dragged intensity point must not survive Escape or a focus loss —
  // otherwise it still writes its curve on release after the user cancelled.
  useEffect(() => {
    if (cancelEpoch === 0) return;
    dragRef.current = null;
    setLive(null);
  }, [cancelEpoch]);
  const width = totalBars * barWidth;
  const pxPerTick = barWidth / barUnit;
  const yFor = (value: number) => INTENSITY_LANE_HEIGHT - value * INTENSITY_LANE_HEIGHT;

  const scenesById = new Map(scenes.map((s) => [s.id, s]));
  /** Points of every scene curve that fall inside their owning clip window. */
  const handles: IntensityHandle[] = [];
  const segments: {
    key: string;
    sceneId: string;
    clipStartTick: number;
    clipEndTick: number;
    points: IntensityPoint[];
  }[] = [];
  for (const clip of clips) {
    const scene = scenesById.get(clip.sceneId);
    if (!scene) continue;
    const clipStartTick = clip.startBar * barUnit;
    const clipEndTick = clipStartTick + clip.lengthBars * barUnit;
    const curve = scene.intensityCurve ?? [];
    const points: IntensityPoint[] = [];
    curve.forEach((p, index) => {
      const absTick = clipStartTick + p.offset;
      if (absTick < clipStartTick || absTick > clipEndTick) return;
      handles.push({ sceneId: scene.id, index, absTick, value: p.value });
      points.push(p);
    });
    segments.push({ key: `${scene.id}:${clipStartTick}`, sceneId: scene.id, clipStartTick, clipEndTick, points });
  }

  const renderHandles = live
    ? handles.map((h) =>
        h.sceneId === live.sceneId && h.index === live.index ? { ...h, absTick: live.absTick, value: live.value } : h,
      )
    : handles;

  const localFromEvent = (event: React.PointerEvent): { absTick: number; value: number } | null => {
    const lane = laneRef.current;
    if (!lane) return null;
    const rect = lane.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    return {
      absTick: Math.round(x / pxPerTick / STEP_TICKS) * STEP_TICKS,
      value: Math.min(1, Math.max(0, 1 - y / INTENSITY_LANE_HEIGHT)),
    };
  };

  const handleAt = (event: { clientX: number; clientY: number }): IntensityHandle | null => {
    const lane = laneRef.current;
    if (!lane) return null;
    const rect = lane.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best: { handle: IntensityHandle; dist: number } | null = null;
    for (const handle of handles) {
      const dx = Math.abs(handle.absTick * pxPerTick - x);
      const dy = Math.abs(yFor(handle.value) - y);
      if (dx < 9 && dy < 9 && (!best || dx + dy < best.dist)) best = { handle, dist: dx + dy };
    }
    return best?.handle ?? null;
  };

  const clipAt = (absTick: number): ArrangementClip | null =>
    clips.find((c) => absTick >= c.startBar * barUnit && absTick < (c.startBar + c.lengthBars) * barUnit) ?? null;

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const local = localFromEvent(event);
    if (!local) return;
    const hit = handleAt(event);
    if (hit) {
      const scene = scenesById.get(hit.sceneId);
      if (!scene) return;
      const curve = [...(scene.intensityCurve ?? [])];
      dragRef.current = {
        sceneId: hit.sceneId,
        index: hit.index,
        curve,
        origOffset: curve[hit.index]?.offset ?? 0,
        origValue: curve[hit.index]?.value ?? 0,
        originAbsTick: hit.absTick,
      };
      setLive({ sceneId: hit.sceneId, index: hit.index, absTick: hit.absTick, value: hit.value });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    // Empty space inside a clip window: add a point (quantized to a step).
    const clip = clipAt(local.absTick);
    if (!clip) return;
    const scene = scenesById.get(clip.sceneId);
    if (!scene) return;
    const offset = local.absTick - clip.startBar * barUnit;
    onEdit(scene.id, [...(scene.intensityCurve ?? []), { offset, value: local.value }]);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const local = localFromEvent(event);
    if (!local) return;
    const clip =
      clipAt(local.absTick) ??
      clipAt(handles.find((h) => h.sceneId === drag.sceneId && h.index === drag.index)?.absTick ?? -1);
    if (!clip) return;
    const offset = Math.max(0, Math.min(clip.lengthBars * barUnit, local.absTick - clip.startBar * barUnit));
    setLive({
      sceneId: drag.sceneId,
      index: drag.index,
      absTick: clip.startBar * barUnit + offset,
      value: local.value,
    });
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    const livePos = live;
    dragRef.current = null;
    setLive(null);
    if (!drag || !livePos) return;
    const clip = clipAt(livePos.absTick);
    if (!clip) return;
    const newOffset = livePos.absTick - clip.startBar * barUnit;
    // The dragged handle's scene-local origin (its offset when the drag began).
    const originClip = clipAt(drag.originAbsTick);
    const origOffset = originClip ? drag.originAbsTick - originClip.startBar * barUnit : drag.origOffset;
    if (newOffset === origOffset && livePos.value === drag.origValue) return;
    const updated = [...drag.curve];
    updated[drag.index] = { offset: newOffset, value: livePos.value };
    onEdit(drag.sceneId, updated);
  };

  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const hit = handleAt(event);
    if (!hit) return;
    const scene = scenesById.get(hit.sceneId);
    if (!scene) return;
    onEdit(
      hit.sceneId,
      (scene.intensityCurve ?? []).filter((_, i) => i !== hit.index),
    );
  };

  // The lane owns its playhead subscription: only this small subtree
  // re-renders at the playhead cadence (quality backlog B4).
  const playheadBar = usePlayheadBar(transport, barUnit);
  // Live value readout at the playhead (the number the engine feeds macros).
  const activeClip = clips.find(
    (clip) => playheadBar >= clip.startBar && playheadBar < clip.startBar + clip.lengthBars,
  );
  const activeScene = activeClip ? scenesById.get(activeClip.sceneId) : undefined;
  const playheadValue =
    activeClip && activeScene
      ? computeSceneIntensity(activeScene, activeClip.startBar * barUnit, Math.round(playheadBar * barUnit))
      : null;

  return (
    <div
      className="arr-intensity-lane"
      ref={laneRef}
      style={{ width }}
      data-playhead-value={playheadValue !== null ? playheadValue.toFixed(2) : undefined}
      title="Scene intensity — click to add a point, drag to shape, right-click to delete"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        dragRef.current = null;
        setLive(null);
      }}
      onContextMenu={onContextMenu}
    >
      <span className="arr-intensity-label">INTENSITY</span>
      {playheadValue !== null && <span className="arr-intensity-value">{Math.round(playheadValue * 100)}%</span>}
      <div className="arr-intensity-neutral" style={{ top: yFor(INTENSITY_NEUTRAL) }} />
      {segments.map((segment) => (
        <div
          key={segment.key}
          className="arr-intensity-clipspan"
          style={{
            left: segment.clipStartTick * pxPerTick,
            width: (segment.clipEndTick - segment.clipStartTick) * pxPerTick,
          }}
        />
      ))}
      <svg className="arr-intensity-svg" width={width} height={INTENSITY_LANE_HEIGHT}>
        {segments.map((segment) => {
          const pts = segment.points
            .map((p) => {
              const handle = renderHandles.find(
                (h) => h.sceneId === segment.sceneId && h.absTick === segment.clipStartTick + p.offset,
              );
              const value = handle ? handle.value : p.value;
              return `${(segment.clipStartTick + p.offset) * pxPerTick},${yFor(value)}`;
            })
            .join(" ");
          return pts ? <polyline key={segment.key} className="arr-intensity-line" points={pts} /> : null;
        })}
      </svg>
      {renderHandles.map((handle, i) => (
        <span
          key={`${handle.sceneId}:${handle.index}:${i}`}
          className="arr-intensity-point"
          style={{ left: handle.absTick * pxPerTick, top: yFor(handle.value) }}
        />
      ))}
    </div>
  );
}
