import { defaultInstrumentParams, INSTRUMENT_DEFS } from "../instruments/registry";
import type { InstrumentRuntime } from "../instruments/types";
import { midiToFreq, type InstrumentKind, type InstrumentTrack, type NoteExpression } from "../project-model/types";
import { loadCoreWorklets } from "../audio-worklets/loader";
import { supportsHeldVoiceSlideNote } from "../instruments/noteExpressionCapabilities";
import { TriggerEngine } from "../audio-engine/triggerEngine";

export interface NoteExpressionAudioCheckResult {
  name: string;
  ok: boolean;
  message: string;
}

interface Scenario {
  id: string;
  expression?: NoteExpression;
  noteOff?: number;
}

const SAMPLE_RATE = 44100;
const FILTER_TARGETS = ["filterCutoffHz", "filterResonance", "modX", "modY"] as const;
const SAMPLE_INSTRUMENTS = new Set<InstrumentKind>(["sampler", "granular", "vocalchop"]);
const SAMPLE_ID = "check-note-expression-fixture";

function makeFixtureSample(ctx: OfflineAudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(SAMPLE_RATE * 1.5), SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / SAMPLE_RATE;
    data[i] =
      0.32 * Math.sin(2 * Math.PI * 110 * t) +
      0.21 * Math.sin(2 * Math.PI * 330 * t) +
      0.13 * Math.sin(2 * Math.PI * 770 * t) +
      0.08 * Math.sin(2 * Math.PI * 2200 * t);
  }
  return buffer;
}

function expressionScenarios(kind: InstrumentKind): {
  scenarios: Scenario[];
  hasFilter: boolean;
  hasRelease: boolean;
  hasPan: boolean;
  hasSlide: boolean;
} {
  const definition = INSTRUMENT_DEFS[kind];
  const hasFilter = FILTER_TARGETS.every((target) => definition.noteExpressionTargets?.includes(target));
  const hasRelease = definition.noteExpressionTargets?.includes("releaseVelocity") === true;
  const hasPan = definition.noteExpressionTargets?.includes("pan") === true;
  const hasSlide = supportsHeldVoiceSlideNote(kind);
  const scenarios: Scenario[] = [{ id: "base" }];
  if (hasFilter) {
    scenarios.push(
      { id: "neutral", expression: { modX: 0.5, modY: 0.5 } },
      { id: "cutoff-low", expression: { filterCutoffHz: 80, filterResonance: 0 } },
      { id: "cutoff-high", expression: { filterCutoffHz: 16000, filterResonance: 0 } },
      { id: "modx-low", expression: { modX: 0, modY: 0.5 } },
      { id: "modx-high", expression: { modX: 1, modY: 0.5 } },
      { id: "mody-low", expression: { modX: 0.5, modY: 0 } },
      { id: "mody-high", expression: { modX: 0.5, modY: 1 } },
    );
  }
  if (hasRelease) {
    const releaseNoteOff = kind === "texture" || kind === "pluck" || kind === "clav" ? 0.15 : 0.55;
    scenarios.push(
      { id: "release-short", expression: { releaseVelocity: 0 }, noteOff: releaseNoteOff },
      { id: "release-long", expression: { releaseVelocity: 1 }, noteOff: releaseNoteOff },
    );
  }
  if (hasPan) {
    scenarios.push(
      { id: "pan-center", expression: { pan: 0 } },
      { id: "pan-left", expression: { pan: -1 } },
      { id: "pan-right", expression: { pan: 1 } },
      { id: "pan-overlap" },
    );
  }
  if (hasSlide) scenarios.push({ id: "slide-note" });
  scenarios.push({ id: "pitch-octave", expression: { pitchOffsetSemitones: 12 } });
  return { scenarios, hasFilter, hasRelease, hasPan, hasSlide };
}

export async function runNoteExpressionAudioChecks(): Promise<NoteExpressionAudioCheckResult[]> {
  const results: NoteExpressionAudioCheckResult[] = [];
  const record = (name: string, ok: boolean, message: string) => results.push({ name, ok, message });
  const kinds = Object.values(INSTRUMENT_DEFS).map((definition) => definition.kind);

  for (const kind of kinds) {
    const definition = INSTRUMENT_DEFS[kind];
    const { scenarios, hasFilter, hasRelease, hasPan, hasSlide } = expressionScenarios(kind);
    const slideSourcePitch = kind === "808" ? 33 : 45;
    const slideTargetPitch = slideSourcePitch + 12;
    let runtimes: InstrumentRuntime[] = [];
    try {
      // Each case is an independent runtime started at the same instant. A
      // channel merger retains its samples separately, avoiding same-pitch
      // note-off interference and keeping LFO phase identical across cases.
      const ctx = new OfflineAudioContext(scenarios.length * 2, Math.floor(SAMPLE_RATE * 1.3), SAMPLE_RATE);
      await loadCoreWorklets(ctx);
      const merger = ctx.createChannelMerger(scenarios.length * 2);
      merger.connect(ctx.destination);
      const sample = makeFixtureSample(ctx);
      const track: InstrumentTrack = {
        id: `check-note-expression-${kind}`,
        kind: "instrument",
        instrument: kind,
        name: kind,
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: SAMPLE_INSTRUMENTS.has(kind) ? SAMPLE_ID : null,
        params: {
          ...defaultInstrumentParams(kind),
          ...(kind === "texture" ? { attack: 0.01, space: 0, diffuse: 0, motion: 0 } : {}),
          ...(kind === "spectral" ? { attack: 0.01, motion: 0 } : {}),
          // The 808's one-shot mode deliberately ignores note length and
          // note-off; test the released, gated articulation explicitly.
          ...(kind === "808" ? { gate: 1, mono: 0 } : {}),
        },
        effects: [],
        sends: {},
      };
      const channels = new Map<string, number>();
      for (let index = 0; index < scenarios.length; index++) {
        const scenario = scenarios[index]!;
        const scenarioTrack: InstrumentTrack =
          kind === "808" && scenario.id === "slide-note" ? { ...track, params: { ...track.params, mono: 1 } } : track;
        const runtime = definition.factory(ctx, scenarioTrack, {
          bpm: 120,
          getSample: (id) => (id === SAMPLE_ID ? sample : undefined),
        });
        runtimes.push(runtime);
        const warp = { isFrozen: () => false } as never;
        const trigger = new TriggerEngine(
          {
            ctx: () => ctx,
            doc: () => null,
            bank: () => null,
            currentTime: () => 0,
            trackNodes: new Map(),
            groupNodes: new Map(),
            instrumentStates: new Map([[scenarioTrack.id, { runtime, pitchBend: 0 }]]),
            warp,
            trackOneShot: () => undefined,
            releaseOneShot: () => undefined,
            missAsset: () => undefined,
          },
          warp,
        );
        const splitter = ctx.createChannelSplitter(2);
        runtime.output.connect(splitter);
        splitter.connect(merger, 0, index * 2);
        splitter.connect(merger, 1, index * 2 + 1);
        channels.set(scenario.id, index);
        const start = 0.05;
        // Keep the runtime's declared gate length aligned with the explicit
        // note-off event. Otherwise pre-scheduled envelopes and voice-stop
        // callbacks disagree about when the release begins.
        if (scenario.id === "pan-overlap") {
          trigger.noteOn(scenarioTrack.id, 60, 0.9, start, 1.15, undefined, undefined, undefined, undefined, {
            pan: -0.8,
          });
          trigger.noteOn(scenarioTrack.id, 67, 0.8, start, 1.15, undefined, undefined, undefined, undefined, {
            pan: 0.8,
          });
        } else if (scenario.id === "slide-note") {
          trigger.noteOn(scenarioTrack.id, slideSourcePitch, 0.9, start, 0.8);
          trigger.noteSlide(scenarioTrack.id, slideTargetPitch, start + 0.3, 0.15);
        } else {
          trigger.noteOn(
            scenarioTrack.id,
            60,
            0.9,
            start,
            scenario.noteOff ?? 1.15,
            undefined,
            undefined,
            undefined,
            undefined,
            scenario.expression,
          );
        }
        if (scenario.noteOff !== undefined) runtime.noteOff?.(60, start + scenario.noteOff);
      }

      const buffer = await ctx.startRendering();
      for (const runtime of runtimes) runtime.dispose();
      runtimes = [];
      const rmsWindow = (scenarioId: string, startSec: number, endSec: number) => {
        const scenario = channels.get(scenarioId)!;
        const left = buffer.getChannelData(scenario * 2);
        const right = buffer.getChannelData(scenario * 2 + 1);
        const start = Math.floor(startSec * SAMPLE_RATE);
        const end = Math.floor(endSec * SAMPLE_RATE);
        let energy = 0;
        for (let i = start; i < end; i++) energy += left[i]! * left[i]! + right[i]! * right[i]!;
        return Math.sqrt(energy / Math.max(1, 2 * (end - start)));
      };
      const rmsDifference = (first: string, second: string, startSec: number, endSec: number) => {
        const firstChannel = channels.get(first)! * 2;
        const secondChannel = channels.get(second)! * 2;
        const firstLeft = buffer.getChannelData(firstChannel);
        const firstRight = buffer.getChannelData(firstChannel + 1);
        const secondLeft = buffer.getChannelData(secondChannel);
        const secondRight = buffer.getChannelData(secondChannel + 1);
        const start = Math.floor(startSec * SAMPLE_RATE);
        const end = Math.floor(endSec * SAMPLE_RATE);
        let energy = 0;
        for (let i = start; i < end; i++) {
          const leftDifference = firstLeft[i]! - secondLeft[i]!;
          const rightDifference = firstRight[i]! - secondRight[i]!;
          energy += leftDifference * leftDifference + rightDifference * rightDifference;
        }
        return Math.sqrt(energy / Math.max(1, 2 * (end - start)));
      };
      const rmsChannel = (scenarioId: string, channelIndex: 0 | 1, startSec: number, endSec: number) => {
        const data = buffer.getChannelData(channels.get(scenarioId)! * 2 + channelIndex);
        const start = Math.floor(startSec * SAMPLE_RATE);
        const end = Math.floor(endSec * SAMPLE_RATE);
        let energy = 0;
        for (let i = start; i < end; i++) energy += data[i]! * data[i]!;
        return Math.sqrt(energy / Math.max(1, end - start));
      };
      const filterWindow = kind === "logdrum" ? [0.06, 0.16] : [0.15, 0.5];
      const base = rmsWindow("base", filterWindow[0]!, filterWindow[1]!);
      if (hasFilter) {
        const neutralDelta = rmsDifference("base", "neutral", filterWindow[0]!, filterWindow[1]!);
        const cutoffDelta = rmsDifference("cutoff-low", "cutoff-high", filterWindow[0]!, filterWindow[1]!);
        const modXDelta = rmsDifference("modx-low", "modx-high", filterWindow[0]!, filterWindow[1]!);
        const modYDelta = rmsDifference("mody-low", "mody-high", filterWindow[0]!, filterWindow[1]!);
        const neutralStable = neutralDelta <= Math.max(base * 0.05, 0.000001);
        const cutoffMovesAudio = cutoffDelta > Math.max(base * 0.005, 0.000001);
        const modXMovesAudio = modXDelta > Math.max(base * 0.005, 0.000001);
        const modYMovesAudio = modYDelta > Math.max(base * 0.002, 0.000001);
        record(
          `${kind}: per-note cutoff and Mod X/Y affect rendered audio while neutral stays close`,
          base > 0.00001 && neutralStable && cutoffMovesAudio && modXMovesAudio && modYMovesAudio,
          `base=${base.toFixed(5)} neutralΔ=${neutralDelta.toFixed(5)} cutoffΔ=${cutoffDelta.toFixed(5)} ModXΔ=${modXDelta.toFixed(5)} ModYΔ=${modYDelta.toFixed(5)}`,
        );
      }
      if (hasRelease) {
        const releaseAt = 0.05 + (scenarios.find((scenario) => scenario.id === "release-short")?.noteOff ?? 1.15);
        // Start just after note-off and avoid a late sample's natural decay
        // making an otherwise valid release response look like silence. The
        // Texture has a fixed 420 ms one-tap echo, so inspect after that echo.
        const releaseWindowStart = releaseAt + (kind === "texture" ? 0.6 : 0.02);
        const releaseWindowEnd = releaseAt + (kind === "texture" ? 1 : 0.35);
        const shortLevel = rmsWindow("release-short", releaseWindowStart, releaseWindowEnd);
        const longLevel = rmsWindow("release-long", releaseWindowStart, releaseWindowEnd);
        const releaseRatio = longLevel / Math.max(1e-8, shortLevel);
        record(
          `${kind}: per-note release velocity changes the rendered note-off tail`,
          longLevel > 0.00001 && releaseRatio > 1.5,
          `short=${shortLevel.toFixed(5)} long=${longLevel.toFixed(5)} ratio×${releaseRatio.toFixed(2)}`,
        );
      }
      if (hasPan) {
        const panDelta = rmsDifference("base", "pan-center", 0.08, 0.35);
        const panBase = rmsWindow("base", 0.08, 0.35);
        const leftLevel = rmsChannel("pan-left", 0, 0.08, 0.35);
        const leftLeak = rmsChannel("pan-left", 1, 0.08, 0.35);
        const rightLevel = rmsChannel("pan-right", 1, 0.08, 0.35);
        const rightLeak = rmsChannel("pan-right", 0, 0.08, 0.35);
        const overlapLeft = rmsChannel("pan-overlap", 0, 0.08, 0.35);
        const overlapRight = rmsChannel("pan-overlap", 1, 0.08, 0.35);
        const centeredMatchesBaseline = panDelta <= Math.max(panBase * 0.05, 0.000001);
        const hardPanIsolated =
          leftLevel > 0.00001 && leftLeak < leftLevel * 0.01 && rightLevel > 0.00001 && rightLeak < rightLevel * 0.01;
        const overlappingNotesKeepBothSides = overlapLeft > 0.00001 && overlapRight > 0.00001;
        record(
          `${kind}: per-note pan preserves center and renders isolated hard-pan plus overlapping opposite pans`,
          panBase > 0.00001 && centeredMatchesBaseline && hardPanIsolated && overlappingNotesKeepBothSides,
          `centerΔ=${panDelta.toFixed(6)} base=${panBase.toFixed(5)} left=${leftLevel.toFixed(5)}/${leftLeak.toFixed(5)} right=${rightLevel.toFixed(5)}/${rightLeak.toFixed(5)} overlap=${overlapLeft.toFixed(5)}/${overlapRight.toFixed(5)}`,
        );
      }
      if (hasSlide) {
        const slideChannel = channels.get("slide-note")! * 2;
        const left = buffer.getChannelData(slideChannel);
        const right = buffer.getChannelData(slideChannel + 1);
        const tonePower = (startSec: number, endSec: number, hz: number) => {
          const start = Math.floor(startSec * SAMPLE_RATE);
          const end = Math.floor(endSec * SAMPLE_RATE);
          const coefficient = 2 * Math.cos((2 * Math.PI * hz) / SAMPLE_RATE);
          let power = 0;
          for (const data of [left, right]) {
            let previous = 0;
            let previousPrevious = 0;
            for (let i = start; i < end; i++) {
              const current = data[i]! + coefficient * previous - previousPrevious;
              previousPrevious = previous;
              previous = current;
            }
            power +=
              previous * previous + previousPrevious * previousPrevious - coefficient * previous * previousPrevious;
          }
          return power;
        };
        const sourceHz = midiToFreq(slideSourcePitch);
        const targetHz = midiToFreq(slideTargetPitch);
        const preSource = tonePower(0.12, 0.22, sourceHz);
        const preTarget = tonePower(0.12, 0.22, targetHz);
        const postSource = tonePower(0.52, 0.68, sourceHz);
        const postTarget = tonePower(0.52, 0.68, targetHz);
        record(
          `${kind}: slide note moves the held fundamental without a new attack`,
          preSource > preTarget * 1.5 && postTarget > postSource * 1.5,
          `pre ${sourceHz.toFixed(1)}/${targetHz.toFixed(1)}Hz=${preSource.toExponential(2)}/${preTarget.toExponential(2)}; post=${postSource.toExponential(2)}/${postTarget.toExponential(2)}`,
        );
      }
      const pitchBase = rmsWindow("base", 0.08, 0.35);
      const pitchDelta = rmsDifference("base", "pitch-octave", 0.08, 0.35);
      record(
        `${kind}: fine-pitch event shifts the rendered note through TriggerEngine`,
        pitchBase > 0.00001 && pitchDelta > Math.max(pitchBase * 0.005, 0.000001),
        `base=${pitchBase.toFixed(5)} octaveΔ=${pitchDelta.toFixed(5)}`,
      );
    } catch (error) {
      record(`${kind}: per-note filter/release browser render`, false, String(error));
    } finally {
      for (const runtime of runtimes) runtime.dispose();
    }
  }

  return results;
}
