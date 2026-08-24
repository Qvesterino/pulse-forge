import { summarizeLatencySamples, type AudioLatencyMeasurement } from "./latencyCalibration";

const PULSE_COUNT = 8;
const PULSE_SPACING_SEC = 0.24;
const PULSE_LEAD_SEC = 0.25;
const PULSE_TAIL_SEC = 0.35;

interface ProbeDetection {
  time: number;
}

export class AudioLatencyCalibrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioLatencyCalibrationError";
  }
}

function makeCalibrationPulse(ctx: AudioContext): AudioBuffer {
  const length = Math.max(128, Math.floor(ctx.sampleRate * 0.018));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const attack = Math.min(1, i / Math.max(1, ctx.sampleRate * 0.001));
    const release = Math.max(0, 1 - (i / length) ** 2);
    data[i] = 0.42 * attack * release * Math.sin((2 * Math.PI * 1600 * i) / ctx.sampleRate);
  }
  return buffer;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AudioLatencyCalibrationError("Calibration cancelled.");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: number | null = null;
    const cleanup = () => {
      if (timer !== null) window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new AudioLatencyCalibrationError("Calibration cancelled."));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}

function pairDetections(scheduledTimes: readonly number[], detections: readonly ProbeDetection[]): number[] {
  const remaining = [...detections].sort((a, b) => a.time - b.time);
  const delays: number[] = [];
  for (const scheduledTime of scheduledTimes) {
    let selectedIndex = -1;
    let selectedDelay = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const delay = remaining[i].time - scheduledTime;
      if (delay < -0.02 || delay > 1 || delay >= selectedDelay) continue;
      selectedIndex = i;
      selectedDelay = delay;
    }
    if (selectedIndex >= 0) {
      remaining.splice(selectedIndex, 1);
      delays.push(Math.max(0, selectedDelay) * 1000);
    }
  }
  return delays;
}

/**
 * Measure the physical output -> microphone -> input path with a short pulse
 * train. The returned value is intentionally an audio-path measurement, not a
 * claim about MIDI hardware latency.
 */
export async function measureAudioRoundTrip(
  ctx: AudioContext,
  signal?: AbortSignal,
  onMicrophoneReady?: () => void,
): Promise<AudioLatencyMeasurement> {
  if (!ctx.audioWorklet || typeof AudioWorkletNode === "undefined") {
    throw new AudioLatencyCalibrationError("This browser cannot run the audio probe.");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new AudioLatencyCalibrationError("Microphone access is not available in this browser.");
  }

  let stream: MediaStream | null = null;
  let input: MediaStreamAudioSourceNode | null = null;
  let probe: AudioWorkletNode | null = null;
  let silentSink: GainNode | null = null;
  const sources: AudioBufferSourceNode[] = [];
  const detections: ProbeDetection[] = [];

  try {
    throwIfAborted(signal);
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    throwIfAborted(signal);
    onMicrophoneReady?.();
    await ctx.audioWorklet.addModule(new URL("../audio-worklets/latency-probe-processor.js", import.meta.url).href);
    throwIfAborted(signal);
    if (ctx.state === "suspended") await ctx.resume();
    throwIfAborted(signal);

    input = ctx.createMediaStreamSource(stream);
    probe = new AudioWorkletNode(ctx, "latency-probe-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    silentSink = ctx.createGain();
    silentSink.gain.value = 0;
    input.connect(probe).connect(silentSink).connect(ctx.destination);
    probe.port.onmessage = (event: MessageEvent<ProbeDetection>) => {
      if (Number.isFinite(event.data?.time)) detections.push({ time: event.data.time });
    };

    const pulse = makeCalibrationPulse(ctx);
    const startAt = ctx.currentTime + PULSE_LEAD_SEC;
    const scheduledTimes: number[] = [];
    for (let i = 0; i < PULSE_COUNT; i++) {
      throwIfAborted(signal);
      const when = startAt + i * PULSE_SPACING_SEC;
      const source = ctx.createBufferSource();
      source.buffer = pulse;
      source.connect(ctx.destination);
      source.start(when);
      sources.push(source);
      scheduledTimes.push(when);
    }

    await wait((PULSE_LEAD_SEC + PULSE_COUNT * PULSE_SPACING_SEC + PULSE_TAIL_SEC) * 1000, signal);
    const delays = pairDetections(scheduledTimes, detections);
    if (delays.length === 0) {
      throw new AudioLatencyCalibrationError("No calibration pulse returned to the microphone.");
    }
    return summarizeLatencySamples(delays, ctx.sampleRate);
  } catch (error) {
    if (error instanceof AudioLatencyCalibrationError) throw error;
    throw new AudioLatencyCalibrationError(String(error instanceof Error ? error.message : error));
  } finally {
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Already ended.
      }
      try {
        source.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    if (probe) {
      probe.port.onmessage = null;
      try {
        probe.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    try {
      input?.disconnect();
      silentSink?.disconnect();
    } catch {
      // Already disconnected.
    }
    for (const track of stream?.getTracks() ?? []) track.stop();
  }
}
