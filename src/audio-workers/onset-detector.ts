/**
 * Onset Detector Web Worker.
 *
 * Runs `detectTransients` off the main thread so long samples don't
 * block the SliceLab waveform canvas. Pure math — no AudioContext.
 *
 * Input:  { channelData: Float32Array, sampleRate: number, sensitivity?: number }
 * Output: { times: number[] }
 */

export interface OnsetDetectorRequest {
  channelData: Float32Array;
  sampleRate: number;
  sensitivity?: number;
}

export interface OnsetDetectorResponse {
  times: number[];
}

export function detectTransients(data: Float32Array, sampleRate: number, sensitivity = 1): number[] {
  const windowSize = 1024;
  const hop = 256;
  const frames = Math.max(0, Math.floor((data.length - windowSize) / hop) + 1);
  if (frames < 4) return [];
  const envelope = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = start; i < start + windowSize; i++) sum += data[i] * data[i];
    envelope[f] = Math.sqrt(sum / windowSize);
  }
  const flux = new Float64Array(frames);
  for (let f = 1; f < frames; f++) {
    const a = Math.log(envelope[f - 1] + 1e-10);
    const b = Math.log(envelope[f] + 1e-10);
    flux[f] = Math.max(0, b - a);
  }
  const localFrames = Math.max(1, Math.round((0.5 * sampleRate) / hop));
  let globalMaxFlux = 0;
  for (let f = 0; f < frames; f++) if (flux[f] > globalMaxFlux) globalMaxFlux = flux[f];
  const onsets: number[] = [];
  let lastOnsetEnvelope = 0;
  let armed = true;
  for (let f = 1; f < frames; f++) {
    const env = envelope[f];
    if (!armed) {
      if (env < lastOnsetEnvelope * 0.5) armed = true;
      else continue;
    }
    if (flux[f] <= 0) continue;
    let sum = 0;
    let envSum = 0;
    let n = 0;
    for (let j = Math.max(0, f - localFrames); j < Math.min(frames, f + localFrames); j++) {
      sum += flux[j];
      envSum += envelope[j];
      n++;
    }
    const mean = sum / n;
    const envMean = envSum / n;
    const settledEnv = Math.max(env, envelope[f + 1] ?? 0, envelope[f + 2] ?? 0);
    if (settledEnv < envMean * 1.5) continue;
    const threshold = mean * 2.5 * sensitivity + globalMaxFlux * 0.2;
    if (flux[f] < threshold) continue;
    if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue;
    lastOnsetEnvelope = env;
    armed = false;
    onsets.push(Math.max(0, (f * hop - windowSize * 0.5) / sampleRate));
  }
  return onsets;
}

if (typeof self !== "undefined" && typeof (self as unknown as { postMessage?: unknown }).postMessage === "function") {
  (self as unknown as { onmessage: (e: MessageEvent<OnsetDetectorRequest>) => void }).onmessage = (
    e: MessageEvent<OnsetDetectorRequest>,
  ) => {
    const { channelData, sampleRate, sensitivity } = e.data;
    const times = detectTransients(channelData, sampleRate, sensitivity ?? 1);
    (self as unknown as { postMessage: (msg: OnsetDetectorResponse) => void }).postMessage({
      times,
    });
  };
}
