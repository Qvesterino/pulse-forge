import { transcribeWithStt } from "./stt-loader";

/**
 * VOICE CAPTURE — mic → 16 kHz mono PCM for the STT drawer (pipeline [A]).
 *
 * Minimal, dependency-free capture: getUserMedia + a ScriptProcessor tap
 * collecting raw chunks at the device rate, then a linear resample to the
 * model's 16 kHz on stop. The mic stream is ALWAYS stopped in `stop()` —
 * the track claim is released even when transcription later fails, so a
 * failed STT can never hold the user's input device.
 *
 * This is a SEPARATE stream from the recording infrastructure (PcmMicRecorder
 * owns takes): the voice tap never contends for the take lane and never
 * writes to the document — its only output is a transcript string.
 */

export interface VoiceCapture {
  /** true while the mic tap is live */
  readonly active: boolean;
  start(): Promise<boolean>;
  /** Stop capture and transcribe; resolves the transcript or null. */
  stopAndTranscribe(): Promise<string | null>;
  /** Stop and discard (no transcription). */
  cancel(): void;
}

export function createVoiceCapture(): VoiceCapture {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let chunks: Float32Array[] = [];

  const active = (): boolean => stream != null;

  async function start(): Promise<boolean> {
    if (stream) return true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      return false;
    }
    context = new AudioContext();
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(4096, 1, 1);
    chunks = [];
    processor.onaudioprocess = (event) => {
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    // ScriptProcessor needs a destination edge to pump; a zero-gain node
    // keeps the tap silent while still driving onaudioprocess.
    const sink = context.createGain();
    sink.gain.value = 0;
    processor.connect(sink).connect(context.destination);
    return true;
  }

  async function stopAndResample(): Promise<{ samples: Float32Array; sampleRate: number } | null> {
    if (!stream || !context) return null;
    for (const track of stream.getTracks()) track.stop();
    stream = null;

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    chunks = [];
    const captureRate = context.sampleRate;

    processor?.disconnect();
    processor = null;
    source?.disconnect();
    source = null;
    const ctx = context;
    context = null;
    try {
      await ctx.close();
    } catch {
      /* already closed */
    }

    if (total === 0) return null;
    // Linear resample to the STT contract (16 kHz mono) — worker re-checks.
    const targetRate = 16000;
    if (captureRate === targetRate) return { samples: merged, sampleRate: captureRate };
    const ratio = captureRate / targetRate;
    const outLength = Math.max(1, Math.floor(merged.length / ratio));
    const resampled = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const src = i * ratio;
      const left = Math.floor(src);
      const right = Math.min(left + 1, merged.length - 1);
      const frac = src - left;
      resampled[i] = merged[left] * (1 - frac) + merged[right] * frac;
    }
    return { samples: resampled, sampleRate: targetRate };
  }

  return {
    get active() {
      return active();
    },
    async start() {
      return start();
    },
    async stopAndTranscribe() {
      const captured = await stopAndResample();
      if (!captured) return null;
      // Guard: sub-300 ms taps are accidental clicks, not speech.
      if (captured.samples.length < captured.sampleRate * 0.3) return null;
      return transcribeWithStt(captured.samples, captured.sampleRate);
    },
    cancel() {
      void stopAndResample();
    },
  };
}
