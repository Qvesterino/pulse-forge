import { createElement, type ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { vi } from "vitest";
import { ServicesContext } from "../src/ui/context";
import type { Services } from "../src/services";
import type { ProjectDocument } from "../src/project-model/types";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { LatencyCalibrationController } from "../src/audio-engine/latencyCalibration";
import { NoteRepeatController } from "../src/audio-engine/NoteRepeat";
import { Transport } from "../src/transport/Transport";
import type { Command } from "../src/commands/types";

export function mockServices(doc?: ProjectDocument): Services {
  const project = doc ?? createProjectFromTemplate("house");
  const listeners = new Set<() => void>();
  const latency = new LatencyCalibrationController(null);
  const libraryState = { favoriteAssets: [], recentAssets: [], favoritePresets: [], recentPresets: [] };
  const captureSnapshot = { capturing: false, launchCount: 0, firstBar: null };
  const mockTransport = new Transport({ now: () => 0 }, 120);
  let countInBars = 0;
  let preRollBars = 0;
  let metronome = false;

  return {
    core: {
      engine: {
        ensureContext: vi.fn(),
        panic: vi.fn(),
        automationReset: vi.fn(),
        transportStarted: vi.fn(),
        setProject: vi.fn(),
        trigger: vi.fn(),
        noteOn: vi.fn(),
        preview: vi.fn(),
        previewSlice: vi.fn(),
        previewAsset: vi.fn(),
        previewInstrumentPreset: vi.fn(),
        stopPreview: vi.fn(),
        applyAutomation: vi.fn(),
        applySceneAutomationLane: vi.fn(),
        setSceneIntensity: vi.fn(),
        getMasterLevels: vi.fn(() => ({
          left: { peak: 0, rms: 0, peakDb: -60, rmsDb: -70 },
          right: { peak: 0, rms: 0, peakDb: -60, rmsDb: -70 },
          correlation: 1,
        })),
        getMasterPeakHoldDb: vi.fn(() => -60),
        getTrackLevel: vi.fn(() => 0),
        getTrackMeterSnapshot: vi.fn(() => ({ level: 0, peakDb: -120, clipping: false })),
        getReturnLevel: vi.fn(() => 0),
        getReturnMeterSnapshot: vi.fn(() => ({ level: 0, peakDb: -120, clipping: false })),
        getDiagnostics: vi.fn(() => ({})),
        get currentTime() {
          return 0;
        },
        get context() {
          return {
            decodeAudioData: vi.fn(async (_bytes) => ({
              duration: 1,
              sampleRate: 44100,
              numberOfChannels: 1,
              getChannelData: () => new Float32Array(44100),
            })),
          };
        },
        attachBank: vi.fn(),
      } as any,
      bank: (() => {
        const m = new Map();
        return {
          get size() {
            return m.size;
          },
          get: vi.fn((id: string) => m.get(id)),
          has: vi.fn((id: string) => m.has(id)),
          add: vi.fn((id: string, b: unknown) => m.set(id, b)),
          remove: vi.fn((id: string) => m.delete(id)),
          names: vi.fn(() => []),
          entries: vi.fn(() => []),
        } as any;
      })(),
      repo: { save: vi.fn(), load: vi.fn(), list: vi.fn() } as any,
      snapshots: {
        save: vi.fn(async (_projectId: string, doc: unknown, label: string) => ({
          id: `snap-${Date.now()}`,
          projectId: "p",
          label,
          createdAt: new Date().toISOString(),
          doc,
        })),
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        delete: vi.fn(async () => {}),
        prune: vi.fn(async () => {}),
      } as any,
      presets: { save: vi.fn(), load: vi.fn(), list: vi.fn(async () => []) } as any,
      library: {
        get: vi.fn(() => libraryState),
        subscribe: vi.fn(() => () => {}),
        toggleAssetFavorite: vi.fn(),
        togglePresetFavorite: vi.fn(),
        recordAsset: vi.fn(),
        recordPreset: vi.fn(),
      } as any,
      latency,
    } as any,
    store: {
      getDoc: () => project,
      subscribe: (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      execute: vi.fn<(c: Command) => void>(),
      undo: vi.fn(),
      redo: vi.fn(),
      canUndo: false,
      canRedo: false,
      lastCommandLabel: null as string | null,
      undoStackLength: 0,
      history: [] as unknown[],
      get saveStatus() {
        return "saved" as const;
      },
      getSaveStatus: () => "saved" as const,
      getLastSavedAt: () => null,
      setSaveStatus: vi.fn(),
      get doc() {
        return project;
      },
      onDocChanged: null as ((doc: ProjectDocument) => void) | null,
      _emit: () => {
        for (const l of listeners) l();
      },
    } as any,
    engine: {
      ensureContext: vi.fn(),
      panic: vi.fn(),
      preview: vi.fn(),
      previewSlice: vi.fn(),
      previewAsset: vi.fn(),
      previewInstrumentPreset: vi.fn(),
      stopPreview: vi.fn(),
      get context() {
        return {
          decodeAudioData: async (_b: ArrayBuffer) => ({
            duration: 1,
            sampleRate: 44100,
            numberOfChannels: 1,
            getChannelData: () => new Float32Array(44100),
            length: 44100,
          }),
        };
      },
      setProject: vi.fn(),
      trigger: vi.fn(),
      noteOn: vi.fn(),
      getMasterLevels: vi.fn(() => ({
        left: { peak: 0, rms: 0, peakDb: -60, rmsDb: -70 },
        right: { peak: 0, rms: 0, peakDb: -60, rmsDb: -70 },
        correlation: 1,
      })),
      getMasterPeakHoldDb: vi.fn(() => -60),
      getTrackLevel: vi.fn(() => 0),
      getTrackMeterSnapshot: vi.fn(() => ({ level: 0, peakDb: -120, clipping: false })),
      getReturnLevel: vi.fn(() => 0),
      getReturnMeterSnapshot: vi.fn(() => ({ level: 0, peakDb: -120, clipping: false })),
      getDiagnostics: vi.fn(() => ({})),
      get currentTime() {
        return 0;
      },
    } as any,
    transport: {
      position: 0,
      playing: false,
      loopEnabled: false,
      bpm: 120,
      get countInBars() {
        return countInBars;
      },
      get preRollBars() {
        return preRollBars;
      },
      get metronome() {
        return metronome;
      },
      get paused() {
        return false;
      },
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      seek: vi.fn(),
      setBpm: vi.fn(),
      setCountIn: vi.fn((bars: number) => {
        countInBars = Math.max(0, Math.min(2, Math.round(bars)));
      }),
      setPreRoll: vi.fn((bars: number) => {
        preRollBars = Math.max(0, Math.min(1, Math.round(bars)));
      }),
      setMetronome: vi.fn((enabled: boolean) => {
        metronome = !!enabled;
      }),
      leadInBars: vi.fn(() => countInBars + preRollBars),
    } as any,
    scheduler: {
      start: vi.fn(),
      stop: vi.fn(),
      resync: vi.fn(),
      queuePatternLaunch: vi.fn(),
      isRunning: false,
      pendingPatternId: null,
      subscribe: vi.fn(() => () => {}),
      stats: { scheduledEvents: 0, lastHorizonTick: 0, windows: 0 },
    } as any,
    repo: { save: vi.fn(), load: vi.fn(), list: vi.fn() } as any,
    bank: (() => {
      const m = new Map();
      return {
        get size() {
          return m.size;
        },
        get: vi.fn((id: string) => m.get(id)),
        has: vi.fn((id: string) => m.has(id)),
        add: vi.fn((id: string, b: unknown) => m.set(id, b)),
        remove: vi.fn((id: string) => m.delete(id)),
        names: vi.fn(() => []),
        entries: vi.fn(() => []),
      } as any;
    })(),
    library: {
      get: vi.fn(() => libraryState),
      subscribe: vi.fn(() => () => {}),
      toggleAssetFavorite: vi.fn(),
      togglePresetFavorite: vi.fn(),
      recordAsset: vi.fn(),
      recordPreset: vi.fn(),
    } as any,
    playback: {
      mode: "pattern" as const,
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => "pattern"),
      playPause: vi.fn(),
      stop: vi.fn(),
      seek: vi.fn(),
      setMode: vi.fn(),
      launchScene: vi.fn(),
    } as any,
    midi: {
      getDevices: vi.fn(() => []),
      subscribeDevices: vi.fn(() => () => {}),
    } as any,
    midiOutput: {} as any,
    midiClock: {} as any,
    collab: null,
    flushSave: vi.fn(),
    closeProject: vi.fn(),
    frozenAudio: {
      save: vi.fn(async () => {}),
      load: vi.fn(async () => undefined),
      remove: vi.fn(async () => {}),
      list: vi.fn(async () => []),
    } as any,
    userSamples: {
      list: vi.fn(async () => []),
      save: vi.fn(async () => {}),
      loadAudio: vi.fn(async () => undefined),
      remove: vi.fn(async () => {}),
      listAudio: vi.fn(async () => []),
    } as any,
    latency,
    noteRepeat: new NoteRepeatController({
      getTransport: () => mockTransport,
      getAudioTime: () => 0,
      fire: vi.fn(),
    }),
    capture: {
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => captureSnapshot),
      start: vi.fn(),
      finish: vi.fn(() => false),
      cancel: vi.fn(),
    } as any,
    ghost: {
      play: vi.fn(),
      stop: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => ({ playing: false })),
      get isPlaying() {
        return false;
      },
    } as any,
    getDiagnostics: vi.fn(() => ({
      playMode: "pattern",
      bpm: 120,
      transportPlaying: false,
      transportTick: 0,
      schedulerRunning: false,
      scheduledEvents: 0,
      nextStepTick: 0,
      schedulerWindows: 0,
      trackCount: project.tracks.length,
      patternCount: project.patterns.length,
      schemaVersion: project.schemaVersion,
      saveStatus: "saved",
    })),
  } as unknown as Services;
}

export function renderWithContext(ui: ReactElement, options?: RenderOptions & { services?: Services }) {
  const services = options?.services ?? mockServices();
  return {
    ...render(createElement(ServicesContext.Provider, { value: services }, ui)),
    services,
  };
}
