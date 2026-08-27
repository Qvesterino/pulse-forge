import { AudioEngine } from "../audio-engine/AudioEngine";
import type { SampleBank } from "../sample-library/factory";
import type { AutomationPoint, Pattern, PlayMode, ProjectDocument } from "../project-model/types";
import { BAR_TICKS, PPQ, STEP_TICKS, getActivePattern } from "../project-model/types";
import { drumHitsInWindow } from "../project-model/groove";
import { noteEventsInWindow } from "../project-model/events";
import { loadWorkletModules } from "../audio-worklets/loader";

export interface RenderOptions {
  mode: PlayMode;
  sampleRate: number;
  tailSeconds?: number;
}

interface ClipWindow {
  pattern: Pattern;
  base: number;
  from: number;
  to: number;
}

export function computeRenderTicks(doc: ProjectDocument, mode: PlayMode): number {
  if (mode === "song") {
    const end = doc.arrangement.clips.reduce((max, c) => Math.max(max, c.startBar + c.lengthBars), 0);
    if (end > 0) return end * BAR_TICKS;
  }
  return getActivePattern(doc).stepCount * STEP_TICKS;
}

function collectClipWindows(doc: ProjectDocument, mode: PlayMode): ClipWindow[] {
  if (mode === "song") {
    const windows: ClipWindow[] = [];
    for (const clip of [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar)) {
      const scene = doc.scenes.find((s) => s.id === clip.sceneId);
      if (!scene) continue;
      const pattern = doc.patterns.find((p) => p.id === scene.patternId);
      if (!pattern) continue;
      const base = clip.startBar * BAR_TICKS;
      windows.push({ pattern, base, from: base, to: base + clip.lengthBars * BAR_TICKS });
    }
    if (windows.length > 0) return windows;
  }
  const pattern = getActivePattern(doc);
  const patternTicks = pattern.stepCount * STEP_TICKS;
  return [{ pattern, base: 0, from: 0, to: patternTicks }];
}

export async function renderProject(
  doc: ProjectDocument,
  bank: SampleBank,
  options: RenderOptions,
): Promise<AudioBuffer> {
  const tail = options.tailSeconds ?? 2;
  const secondsPerTick = 60 / (doc.bpm * PPQ);
  const totalTicks = computeRenderTicks(doc, options.mode);
  const duration = totalTicks * secondsPerTick + tail;
  const sampleRate = options.sampleRate;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
  // Load AudioWorklet processors into THIS offline context so bitcrusher
  // downsample and sidechain ducking render correctly (the fallbacks are
  // broken offline: WaveShaper has no state, setInterval never fires).
  // Never rejects — factories fall back gracefully when unavailable.
  await loadWorkletModules(ctx);

  const engine = new AudioEngine();
  engine.attachBank(bank);
  engine.useContext(ctx);
  engine.setProject(doc);

  const timeAt = (tick: number) => tick * secondsPerTick;
  const windows = collectClipWindows(doc, options.mode);

  for (const window of windows) {
    scheduleDrums(doc, window, timeAt, engine);
    scheduleNotes(window, timeAt, secondsPerTick, engine);
  }
  scheduleAutomation(doc, windows, timeAt, engine);
  // Schedulable track modulators (random S&H / step) share the same window
  // sweep so offline exports match live playback deterministically.
  engine.scheduleModulatorsOffline(
    windows.map((w) => ({ from: w.from, to: w.to })),
    timeAt,
  );

  return ctx.startRendering();
}

function scheduleDrums(
  doc: ProjectDocument,
  window: ClipWindow,
  timeAt: (tick: number) => number,
  engine: AudioEngine,
): void {
  // Shared groove engine — export swings/humanizes/rolls exactly like playback.
  for (const hit of drumHitsInWindow(doc, window.pattern, window.base, window.from, window.to)) {
    engine.trigger(hit.trackId, hit.pad, timeAt(hit.tick), hit.velocity);
  }
}

function scheduleNotes(
  window: ClipWindow,
  timeAt: (tick: number) => number,
  secondsPerTick: number,
  engine: AudioEngine,
): void {
  const { base, from, to } = window;
  for (const event of noteEventsInWindow(window.pattern, base, from, to)) {
    engine.noteOn(
      event.trackId,
      event.note.pitch,
      event.note.velocity,
      timeAt(event.tick),
      event.note.duration * secondsPerTick,
    );
  }
}

function scheduleAutomation(
  doc: ProjectDocument,
  windows: ClipWindow[],
  timeAt: (tick: number) => number,
  engine: AudioEngine,
): void {
  if (doc.automation.length === 0 || windows.length === 0) return;
  for (const lane of doc.automation) {
    if (lane.points.length === 0) continue;
    const expanded = expandAutomationAcrossWindows(lane.points, windows);
    if (expanded.length === 0) continue;
    switch (lane.target.kind) {
      case "trackGain":
        engine.scheduleTrackAutomation(lane.target.trackId, "gain", expanded, timeAt);
        break;
      case "trackPan":
        engine.scheduleTrackAutomation(lane.target.trackId, "pan", expanded, timeAt);
        break;
      case "fxParam": {
        if (!lane.target.fxId) break;
        engine.scheduleDeviceAutomation(
          lane.target.trackId,
          "fx",
          lane.target.fxId,
          lane.target.paramId,
          expanded,
          timeAt,
        );
        break;
      }
      case "instParam": {
        engine.scheduleDeviceAutomation(
          lane.target.trackId,
          "inst",
          undefined,
          lane.target.paramId,
          expanded,
          timeAt,
        );
        break;
      }
    }
  }
}

/**
 * Expand pattern-relative automation points across all pattern cycles that fall
 * inside each render window.
 *
 * In the project model, FX and instrument parameter automation lanes are
 * authored in pattern-relative tick space. During offline rendering the
 * scheduler has to translate those points to absolute song ticks, otherwise
 * the parameter would only ever be set in the first pattern cycle and the
 * looping behaviour of the realtime scheduler would be lost in the export.
 *
 * This is the same approach the realtime `applyAutomation` uses internally
 * (`valueAt(points, relOf(tick))`), but pre-expanded so it can drive
 * `scheduleDeviceAutomation` which plans individual automation events.
 */
export function expandAutomationAcrossWindows(
  points: AutomationPoint[],
  windows: ClipWindow[],
): AutomationPoint[] {
  const expanded: AutomationPoint[] = [];
  for (const window of windows) {
    const patternTicks = window.pattern.stepCount * STEP_TICKS;
    const windowTicks = window.to - window.from;
    if (patternTicks <= 0 || windowTicks <= 0) continue;
    const cycles = Math.max(1, Math.ceil(windowTicks / patternTicks));
    for (let cycle = 0; cycle < cycles; cycle++) {
      const cycleBase = window.from + cycle * patternTicks;
      for (const point of points) {
        const absoluteTick = cycleBase + point.tick;
        if (absoluteTick >= window.to) continue;
        expanded.push({ tick: absoluteTick, value: point.value });
      }
    }
  }
  return expanded;
}
