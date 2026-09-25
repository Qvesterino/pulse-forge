import { extractAudioFeatures } from "../ai/audio-features";

export interface SongAudioFinding {
  code: "non-finite-samples" | "near-full-scale" | "near-silence";
  severity: "warning";
  message: string;
  evidence: string;
}

/** Technical signal checks only; these measurements are not an artistic-quality score. */
export interface SongAudioReview {
  durationSeconds: number;
  sampleRate: number;
  peakDbfs: number;
  rmsDbfs: number;
  crestFactor: number;
  lowBandRatio: number;
  zeroCrossingRate: number;
  nonFiniteSamples: number;
  findings: SongAudioFinding[];
}

const toDbfs = (value: number): number => (value > 0 ? Math.round(200 * Math.log10(value)) / 10 : -120);

/** Analyze the exact stereo render used by song audition, without another render or project mutation. */
export function reviewSongAudio(buffer: AudioBuffer): SongAudioReview {
  const channelCount = Math.max(0, Math.floor(buffer.numberOfChannels));
  const frameCount = Math.max(0, Math.floor(buffer.length));
  const sampleRate = Number.isFinite(buffer.sampleRate) && buffer.sampleRate > 0 ? buffer.sampleRate : 0;
  const mono = new Float32Array(frameCount);
  let peak = 0;
  let sumSquares = 0;
  let finiteSamples = 0;
  let nonFiniteSamples = 0;

  const channels = Array.from({ length: channelCount }, (_, channel) => buffer.getChannelData(channel));
  for (let frame = 0; frame < frameCount; frame++) {
    let mixed = 0;
    let mixedChannels = 0;
    for (const channel of channels) {
      const sample = channel[frame];
      if (sample === undefined || !Number.isFinite(sample)) {
        nonFiniteSamples++;
        continue;
      }
      const magnitude = Math.abs(sample);
      peak = Math.max(peak, magnitude);
      sumSquares += sample * sample;
      finiteSamples++;
      mixed += sample;
      mixedChannels++;
    }
    mono[frame] = mixedChannels > 0 ? mixed / mixedChannels : 0;
  }

  const features = extractAudioFeatures(mono, sampleRate || 44100);
  const rms = finiteSamples > 0 ? Math.sqrt(sumSquares / finiteSamples) : 0;
  const crestFactor = rms > 1e-10 ? peak / rms : 0;
  const peakDbfs = toDbfs(peak);
  const rmsDbfs = toDbfs(rms);
  const findings: SongAudioFinding[] = [];

  if (nonFiniteSamples > 0) {
    findings.push({
      code: "non-finite-samples",
      severity: "warning",
      message: "The render contains invalid sample values.",
      evidence: `${nonFiniteSamples} of ${frameCount * channelCount} channel samples were not finite.`,
    });
  }
  if (peak >= 0.999) {
    findings.push({
      code: "near-full-scale",
      severity: "warning",
      message: "The render reaches near full scale; check transient headroom and the master limiter.",
      evidence: `Sample peak ${peakDbfs.toFixed(1)} dBFS.`,
    });
  }
  if (rms < 0.001 && peak < 0.01) {
    findings.push({
      code: "near-silence",
      severity: "warning",
      message: "The rendered song is nearly silent; check instrument output and sample availability.",
      evidence: `RMS ${rmsDbfs.toFixed(1)} dBFS; peak ${peakDbfs.toFixed(1)} dBFS.`,
    });
  }

  return {
    durationSeconds: sampleRate > 0 ? frameCount / sampleRate : 0,
    sampleRate,
    peakDbfs,
    rmsDbfs,
    crestFactor: Math.round(crestFactor * 100) / 100,
    lowBandRatio: features.lowBandRatio,
    zeroCrossingRate: features.zeroCrossingRate,
    nonFiniteSamples,
    findings,
  };
}
