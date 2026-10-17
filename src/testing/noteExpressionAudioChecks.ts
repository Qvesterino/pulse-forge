import { defaultInstrumentParams, INSTRUMENT_DEFS } from "../instruments/registry";
import type { InstrumentRuntime } from "../instruments/types";
import type { InstrumentKind, InstrumentTrack, NoteExpression } from "../project-model/types";
import { loadCoreWorklets } from "../audio-worklets/loader";

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

function expressionScenarios(kind: InstrumentKind): { scenarios: Scenario[]; hasFilter: boolean; hasRelease: boolean } {
  const definition = INSTRUMENT_DEFS[kind];
  const hasFilter = FILTER_TARGETS.every((target) => definition.noteExpressionTargets?.includes(target));
  const hasRelease = definition.noteExpressionTargets?.includes("releaseVelocity") === true;
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
  return { scenarios, hasFilter, hasRelease };
}

export async function runNoteExpressionAudioChecks(): Promise<NoteExpressionAudioCheckResult[]> {
  const results: NoteExpressionAudioCheckResult[] = [];
  const record = (name: string, ok: boolean, message: string) => results.push({ name, ok, message });
  const kinds = [
    ...new Set(
      Object.values(INSTRUMENT_DEFS)
        .filter((definition) =>
          definition.noteExpressionTargets?.some((target) =>
            [...FILTER_TARGETS, "releaseVelocity"].includes(target as never),
          ),
        )
        .map((definition) => definition.kind),
    ),
  ];

  for (const kind of kinds) {
    const definition = INSTRUMENT_DEFS[kind];
    const { scenarios, hasFilter, hasRelease } = expressionScenarios(kind);
    let runtimes: InstrumentRuntime[] = [];
    try {
      // Each case is an independent runtime started at the same instant. A
      // channel merger retains its samples separately, avoiding same-pitch
      // note-off interference and keeping LFO phase identical across cases.
      const ctx = new OfflineAudioContext(scenarios.length, Math.floor(SAMPLE_RATE * 1.3), SAMPLE_RATE);
      await loadCoreWorklets(ctx);
      const merger = ctx.createChannelMerger(scenarios.length);
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
          ...(kind === "808" ? { gate: 1 } : {}),
        },
        effects: [],
        sends: {},
      };
      const channels = new Map<string, number>();
      for (let index = 0; index < scenarios.length; index++) {
        const scenario = scenarios[index]!;
        const runtime = definition.factory(ctx, track, {
          bpm: 120,
          getSample: (id) => (id === SAMPLE_ID ? sample : undefined),
        });
        runtimes.push(runtime);
        runtime.output.connect(merger, 0, index);
        channels.set(scenario.id, index);
        const start = 0.05;
        // Keep the runtime's declared gate length aligned with the explicit
        // note-off event. Otherwise pre-scheduled envelopes and voice-stop
        // callbacks disagree about when the release begins.
        runtime.noteOn(60, 0.9, start, scenario.noteOff ?? 1.15, undefined, scenario.expression);
        if (scenario.noteOff !== undefined) runtime.noteOff?.(60, start + scenario.noteOff);
      }

      const buffer = await ctx.startRendering();
      for (const runtime of runtimes) runtime.dispose();
      runtimes = [];
      const rmsWindow = (channel: number, startSec: number, endSec: number) => {
        const data = buffer.getChannelData(channel);
        const start = Math.floor(startSec * SAMPLE_RATE);
        const end = Math.floor(endSec * SAMPLE_RATE);
        let energy = 0;
        for (let i = start; i < end; i++) energy += data[i]! * data[i]!;
        return Math.sqrt(energy / Math.max(1, end - start));
      };
      const rmsDifference = (first: string, second: string, startSec: number, endSec: number) => {
        const left = buffer.getChannelData(channels.get(first)!);
        const right = buffer.getChannelData(channels.get(second)!);
        const start = Math.floor(startSec * SAMPLE_RATE);
        const end = Math.floor(endSec * SAMPLE_RATE);
        let energy = 0;
        for (let i = start; i < end; i++) {
          const difference = left[i]! - right[i]!;
          energy += difference * difference;
        }
        return Math.sqrt(energy / Math.max(1, end - start));
      };
      const filterWindow = kind === "logdrum" ? [0.06, 0.16] : [0.15, 0.5];
      const base = rmsWindow(channels.get("base")!, filterWindow[0]!, filterWindow[1]!);
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
        const shortLevel = rmsWindow(channels.get("release-short")!, releaseWindowStart, releaseWindowEnd);
        const longLevel = rmsWindow(channels.get("release-long")!, releaseWindowStart, releaseWindowEnd);
        const releaseRatio = longLevel / Math.max(1e-8, shortLevel);
        record(
          `${kind}: per-note release velocity changes the rendered note-off tail`,
          longLevel > 0.00001 && releaseRatio > 1.5,
          `short=${shortLevel.toFixed(5)} long=${longLevel.toFixed(5)} ratio×${releaseRatio.toFixed(2)}`,
        );
      }
    } catch (error) {
      record(`${kind}: per-note filter/release browser render`, false, String(error));
    } finally {
      for (const runtime of runtimes) runtime.dispose();
    }
  }

  return results;
}
