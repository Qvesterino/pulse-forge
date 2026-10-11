/**
 * Browser-engine CPU probe for the REZONANS DSP core.
 *
 * Chromium's AudioWorkletGlobalScope does not expose performance.now(), so a
 * precise per-quantum timer cannot run inside the real audio thread. This
 * entry measures the same DSP core in Chromium's main JavaScript runtime and
 * labels the result accordingly; it is not an AudioWorklet deadline test.
 */
import { RezonansProcessor } from "../src/effects/rezonans-core/dsp/rezonansProcessor.ts";
import {
  buildDefaultParams,
  QUALITY_FINE,
  REZ_PARAM,
  voiceParamId,
} from "../src/effects/rezonans-core/contracts/parameters.ts";

const BLOCK = 128;
const C_MAJOR = 0b101010110101;

function makeProcessor(sampleRate) {
  const processor = new RezonansProcessor();
  processor.prepare(sampleRate, 2, BLOCK, 120);
  const params = buildDefaultParams();
  params[REZ_PARAM.quality] = QUALITY_FINE;
  params[REZ_PARAM.harmonyMode] = 2;
  params[REZ_PARAM.voices] = 4;
  params[REZ_PARAM.mix] = 1;
  params[REZ_PARAM.bodyGate] = 0.5;
  for (let voice = 0; voice < 4; voice++) {
    params[voiceParamId(voice, "enabled")] = 1;
    params[voiceParamId(voice, "degree")] = [2, 4, 6, 8][voice];
    params[voiceParamId(voice, "level")] = 0.35;
    params[voiceParamId(voice, "pan")] = [-0.75, -0.25, 0.25, 0.75][voice];
    params[voiceParamId(voice, "humanize")] = 0.15;
  }
  processor.loadState(params);
  processor.setHarmonyContext({ keyRootPc: 0, scaleMask: C_MAJOR, chords: [] });
  processor.prepareOfflineRender();
  return processor;
}

export function benchmarkRezonansBrowser(source, sampleRate, warmupSeconds, measureSeconds) {
  const framesPerRun = Math.floor(measureSeconds * sampleRate);
  const blocksPerRun = Math.ceil(framesPerRun / BLOCK);
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  const channels = [left, right];
  const processor = makeProcessor(sampleRate);

  const processBlocks = (blocks) => {
    let sourceCursor = 0;
    const startedAt = performance.now();
    for (let block = 0; block < blocks; block++) {
      for (let i = 0; i < BLOCK; i++) {
        const sample = source[sourceCursor] ?? 0;
        left[i] = sample;
        right[i] = sample;
        sourceCursor++;
        if (sourceCursor === source.length) sourceCursor = 0;
      }
      processor.process(channels, BLOCK);
    }
    const elapsedMs = performance.now() - startedAt;
    return { elapsedMs };
  };

  processBlocks(Math.ceil((warmupSeconds * sampleRate) / BLOCK));
  processor.reset();

  const repeats = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const measured = processBlocks(blocksPerRun);
    const audioMs = (blocksPerRun * BLOCK * 1000) / sampleRate;
    repeats.push({
      cpuPercent: (measured.elapsedMs / audioMs) * 100,
      meanLoopTimePerBlockMs: measured.elapsedMs / blocksPerRun,
      elapsedMs: measured.elapsedMs,
    });
  }
  const cpuSamples = repeats.map((repeat) => repeat.cpuPercent).sort((a, b) => a - b);
  const blockTimeSamples = repeats.map((repeat) => repeat.meanLoopTimePerBlockMs).sort((a, b) => a - b);
  return {
    sampleRate,
    blockFrames: BLOCK,
    quality: "fine / 4096 FFT",
    harmonyVoices: 4,
    warmupSeconds,
    measuredSecondsPerRepeat: (blocksPerRun * BLOCK) / sampleRate,
    repeats,
    cpuPercentMedian: cpuSamples[Math.floor((cpuSamples.length - 1) * 0.5)] ?? 0,
    cpuPercentMax: Math.max(...cpuSamples),
    meanLoopTimePerBlockMedianMs: blockTimeSamples[Math.floor((blockTimeSamples.length - 1) * 0.5)] ?? 0,
  };
}
