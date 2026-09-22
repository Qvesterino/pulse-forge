import {
  GENERATIVE_FRAME_RATE_HZ,
  GENERATIVE_MAX_CAPTURE_SECONDS,
  GENERATIVE_MAX_STYLE_TEXT_LENGTH,
  GENERATIVE_PITCH_COUNT,
  type GenerativeCaptureRequest,
  type GenerativeInput,
  type GenerativeMacroValues,
  type GenerativeSessionConfig,
  type GenerativeStyle,
} from "./types";

const MIN_BPM = 20;
const MAX_BPM = 300;
const MAX_NOTE_FRAMES = 25 * 60 * 10;

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function unit(value: number, label: string): void {
  finite(value, label);
  if (value < 0 || value > 1) throw new Error(`${label} must be in 0..1`);
}

export function validateMacros(macros: GenerativeMacroValues): void {
  unit(macros.energy, "macros.energy");
  unit(macros.density, "macros.density");
  unit(macros.variation, "macros.variation");
  unit(macros.texture, "macros.texture");
}

function validateStyle(style: GenerativeStyle): void {
  if (style.kind === "text") {
    if (style.text.length > GENERATIVE_MAX_STYLE_TEXT_LENGTH) {
      throw new Error(`style.text exceeds ${GENERATIVE_MAX_STYLE_TEXT_LENGTH} characters`);
    }
    return;
  }

  finite(style.sampleRate, "style.sampleRate");
  if (style.sampleRate <= 0) throw new Error("style.sampleRate must be positive");
  if (style.channels.length < 1 || style.channels.length > 2) {
    throw new Error("style.channels must contain one or two channels");
  }
  const frameCount = style.channels[0]?.length ?? 0;
  for (const channel of style.channels) {
    if (channel.length !== frameCount) throw new Error("style channels must have equal length");
    for (const sample of channel) {
      if (!Number.isFinite(sample)) throw new Error("style audio contains a non-finite sample");
    }
  }
}

export function validateGenerativeInput(input: GenerativeInput): void {
  finite(input.bpm, "bpm");
  if (input.bpm < MIN_BPM || input.bpm > MAX_BPM) throw new Error(`bpm must be in ${MIN_BPM}..${MAX_BPM}`);
  finite(input.frameRateHz, "frameRateHz");
  if (input.frameRateHz !== GENERATIVE_FRAME_RATE_HZ) {
    throw new Error(`frameRateHz must be ${GENERATIVE_FRAME_RATE_HZ}`);
  }
  finite(input.startTick, "startTick");
  if (input.startTick < 0) throw new Error("startTick must be non-negative");
  if (input.noteFrames.length > MAX_NOTE_FRAMES) throw new Error("noteFrames exceeds the bounded input limit");
  for (let index = 0; index < input.noteFrames.length; index++) {
    const frame = input.noteFrames[index];
    if (!frame) throw new Error(`noteFrames[${index}] is missing`);
    if (!Number.isSafeInteger(frame.frameIndex) || frame.frameIndex < 0) {
      throw new Error(`noteFrames[${index}].frameIndex must be a non-negative integer`);
    }
    if (frame.pitchState.length !== GENERATIVE_PITCH_COUNT) {
      throw new Error(`noteFrames[${index}].pitchState must contain ${GENERATIVE_PITCH_COUNT} values`);
    }
    for (const state of frame.pitchState) {
      if (!Number.isInteger(state) || state < 0 || state > 3) {
        throw new Error("pitchState values must be integers in 0..3");
      }
    }
  }
  validateStyle(input.style);
  validateMacros(input.macros);
  if (input.seed !== undefined && input.seed.length > 200) throw new Error("seed exceeds 200 characters");
}

export function validateSessionConfig(config: GenerativeSessionConfig): void {
  if (!config.modelId) throw new Error("modelId is required");
  if (!Number.isFinite(config.outputSampleRate) || config.outputSampleRate <= 0) {
    throw new Error("outputSampleRate must be positive");
  }
  if (!Number.isInteger(config.outputChannels) || config.outputChannels < 1 || config.outputChannels > 2) {
    throw new Error("outputChannels must be one or two");
  }
}

export function validateCaptureRequest(
  request: GenerativeCaptureRequest,
  maxSeconds = GENERATIVE_MAX_CAPTURE_SECONDS,
): void {
  validateGenerativeInput(request.input);
  finite(request.durationSec, "durationSec");
  if (request.durationSec <= 0 || request.durationSec > maxSeconds) {
    throw new Error(`durationSec must be greater than zero and at most ${maxSeconds}`);
  }
}
