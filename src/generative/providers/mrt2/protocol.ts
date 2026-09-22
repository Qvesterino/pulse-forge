import type {
  GenerativeInput,
  GenerativeMacroName,
  GenerativeMacroSupport,
  GenerativeSessionConfig,
} from "../../types";

/** Versioned control/audio protocol shared by a future native MRT2 companion. */
export const MRT2_PROTOCOL_VERSION = 1 as const;
export const MRT2_CONTROL_MAX_BYTES = 64 * 1024;
export const MRT2_PACKET_MAX_FRAMES = 48_000 * 15;
const MRT2_PACKET_MAGIC = "KYXMRT2\0";
const MRT2_PACKET_HEADER_BYTES = 32;

export type Mrt2PacketKind = "output" | "style";

export interface Mrt2StyleDescriptor {
  kind: "text" | "audio";
  text?: string;
  sampleRate?: number;
  channels?: number;
  frames?: number;
}

export interface Mrt2SerializableInput extends Omit<GenerativeInput, "style"> {
  style: Mrt2StyleDescriptor;
}

export type Mrt2ControlMessage =
  | {
      version: typeof MRT2_PROTOCOL_VERSION;
      type: "hello";
      requestId: string;
      client: "kyx";
      authToken?: string;
    }
  | {
      version: typeof MRT2_PROTOCOL_VERSION;
      type: "hello.ok";
      requestId: string;
      providerId: string;
      modelIds: string[];
      outputSampleRates: number[];
      outputChannels: number[];
      supportsRealtime: boolean;
      supportsCapture: boolean;
      supportsTextStyle: boolean;
      supportsNoteConditioning: boolean;
      supportsAudioStyle: boolean;
      supportsDrumsMode: boolean;
      supportsSeed: boolean;
      maxCaptureSeconds: number;
      macroSupport?: Partial<Record<GenerativeMacroName, GenerativeMacroSupport>>;
    }
  | {
      version: typeof MRT2_PROTOCOL_VERSION;
      type: "session.create";
      requestId: string;
      config: GenerativeSessionConfig;
    }
  | {
      version: typeof MRT2_PROTOCOL_VERSION;
      type: "session.ok";
      requestId: string;
      sessionId: string;
    }
  | {
      version: typeof MRT2_PROTOCOL_VERSION;
      type: "input.update";
      requestId: string;
      sessionId: string;
      input: Mrt2SerializableInput;
    }
  | {
      version: typeof MRT2_PROTOCOL_VERSION;
      type: "session.start" | "session.stop" | "session.close";
      requestId: string;
      sessionId: string;
    }
  | {
      version: typeof MRT2_PROTOCOL_VERSION;
      type: "capture.start";
      requestId: string;
      sessionId: string;
      durationSec: number;
    }
  | {
      version: typeof MRT2_PROTOCOL_VERSION;
      type: "capture.ok";
      requestId: string;
      sessionId: string;
      frames: number;
      durationSec: number;
      inputHash: string;
    }
  | {
      version: typeof MRT2_PROTOCOL_VERSION;
      type: "status";
      requestId?: string;
      sessionId?: string;
      state:
        | "idle"
        | "loading"
        | "downloading"
        | "starting"
        | "ready"
        | "running"
        | "buffering"
        | "capturing"
        | "reconnecting"
        | "error"
        | "unavailable";
      message?: string;
    }
  | {
      version: typeof MRT2_PROTOCOL_VERSION;
      type: "error";
      requestId?: string;
      sessionId?: string;
      code: string;
      message: string;
    };

export interface Mrt2AudioPacket {
  kind: Mrt2PacketKind;
  sequence: number;
  sampleRate: number;
  channels: number;
  frames: number;
  data: Float32Array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 400) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function finitePositive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return value;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function boundedInteger(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${label} must be a bounded non-negative integer`);
  }
  return value;
}

function validateSerializableInput(value: unknown): Mrt2SerializableInput {
  if (!isRecord(value)) throw new Error("input must be an object");
  const bpm = finitePositive(value.bpm, "input.bpm");
  if (bpm < 20 || bpm > 300) throw new Error("input.bpm is outside the supported range");
  if (value.frameRateHz !== 25) throw new Error("input.frameRateHz must be 25");
  finiteNonNegative(value.startTick, "input.startTick");
  if (value.drumsMode !== "off" && value.drumsMode !== "on" && value.drumsMode !== "provider-default") {
    throw new Error("input.drumsMode is invalid");
  }
  if (!isRecord(value.macros)) throw new Error("input.macros is invalid");
  for (const name of ["energy", "density", "variation", "texture"] as const) {
    const macro = value.macros[name];
    if (typeof macro !== "number" || !Number.isFinite(macro) || macro < 0 || macro > 1) {
      throw new Error(`input.macros.${name} is invalid`);
    }
  }
  if (value.seed !== undefined) requiredString(value.seed, "input.seed");
  const styleValue = value.style;
  if (!isRecord(styleValue) || (styleValue.kind !== "text" && styleValue.kind !== "audio")) {
    throw new Error("input.style is invalid");
  }
  const style: Mrt2StyleDescriptor = { kind: styleValue.kind };
  if (style.kind === "text") {
    style.text = requiredString(styleValue.text, "input.style.text");
  } else {
    style.sampleRate = finitePositive(styleValue.sampleRate, "input.style.sampleRate");
    style.channels = boundedInteger(styleValue.channels, "input.style.channels", 2);
    if (style.channels < 1) throw new Error("input.style.channels is invalid");
    style.frames = boundedInteger(styleValue.frames, "input.style.frames", MRT2_PACKET_MAX_FRAMES);
  }
  const noteFrames = value.noteFrames;
  if (!Array.isArray(noteFrames) || noteFrames.length > 25 * 60 * 10) {
    throw new Error("input.noteFrames is invalid");
  }
  for (let index = 0; index < noteFrames.length; index++) {
    const frame = noteFrames[index];
    if (!isRecord(frame)) throw new Error(`input.noteFrames[${index}] is invalid`);
    boundedInteger(frame.frameIndex, `input.noteFrames[${index}].frameIndex`, 25 * 60 * 10);
    if (!Array.isArray(frame.pitchState) || frame.pitchState.length !== 128) {
      throw new Error(`input.noteFrames[${index}].pitchState is invalid`);
    }
    for (const state of frame.pitchState) {
      if (!Number.isInteger(state) || state < 0 || state > 3) {
        throw new Error(`input.noteFrames[${index}].pitchState contains an invalid state`);
      }
    }
  }
  return { ...(value as unknown as Omit<GenerativeInput, "style">), style, noteFrames };
}

/** Validate and parse an untrusted WebSocket/Electron control payload. */
export function parseMrt2ControlMessage(raw: unknown): Mrt2ControlMessage {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > MRT2_CONTROL_MAX_BYTES) throw new Error("MRT2 control message is too large");
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("MRT2 control message is not valid JSON");
    }
  }
  if (!isRecord(value)) throw new Error("MRT2 control message must be an object");
  if (value.version !== MRT2_PROTOCOL_VERSION) throw new Error("Unsupported MRT2 protocol version");
  const type = requiredString(value.type, "message.type");
  if (typeof value.requestId !== "undefined") requiredString(value.requestId, "message.requestId");
  if (typeof value.sessionId !== "undefined") requiredString(value.sessionId, "message.sessionId");

  switch (type) {
    case "hello":
      if (value.client !== "kyx") throw new Error("MRT2 hello client is invalid");
      requiredString(value.requestId, "message.requestId");
      if (typeof value.authToken !== "undefined") requiredString(value.authToken, "message.authToken");
      return value as unknown as Mrt2ControlMessage;
    case "hello.ok":
      requiredString(value.requestId, "message.requestId");
      requiredString(value.providerId, "message.providerId");
      if (
        !Array.isArray(value.modelIds) ||
        !Array.isArray(value.outputSampleRates) ||
        !Array.isArray(value.outputChannels)
      ) {
        throw new Error("MRT2 hello.ok capabilities are invalid");
      }
      for (const modelId of value.modelIds) requiredString(modelId, "hello.ok.modelIds[]");
      for (const sampleRate of value.outputSampleRates) finitePositive(sampleRate, "hello.ok.outputSampleRates[]");
      for (const channels of value.outputChannels) {
        boundedInteger(channels, "hello.ok.outputChannels[]", 2);
        if (channels < 1) throw new Error("hello.ok.outputChannels[] is invalid");
      }
      for (const capability of [
        "supportsRealtime",
        "supportsCapture",
        "supportsTextStyle",
        "supportsNoteConditioning",
        "supportsAudioStyle",
        "supportsDrumsMode",
        "supportsSeed",
      ] as const) {
        if (typeof value[capability] !== "boolean") throw new Error(`hello.ok.${capability} is invalid`);
      }
      const maxCaptureSeconds = value.maxCaptureSeconds;
      if (
        typeof maxCaptureSeconds !== "number" ||
        !Number.isFinite(maxCaptureSeconds) ||
        maxCaptureSeconds < 0 ||
        maxCaptureSeconds > 120
      ) {
        throw new Error("hello.ok.maxCaptureSeconds is invalid");
      }
      if (value.macroSupport !== undefined) {
        if (!isRecord(value.macroSupport)) throw new Error("hello.ok.macroSupport is invalid");
        for (const [name, support] of Object.entries(value.macroSupport)) {
          if (!["energy", "density", "variation", "texture"].includes(name)) {
            throw new Error("hello.ok.macroSupport contains an unknown macro");
          }
          if (support !== "native" && support !== "wrapper" && support !== "unsupported") {
            throw new Error("hello.ok.macroSupport contains an invalid capability");
          }
        }
      }
      return value as unknown as Mrt2ControlMessage;
    case "session.create":
      requiredString(value.requestId, "message.requestId");
      if (!isRecord(value.config)) throw new Error("MRT2 session config is invalid");
      finitePositive(value.config.outputSampleRate, "config.outputSampleRate");
      boundedInteger(value.config.outputChannels, "config.outputChannels", 2);
      requiredString(value.config.modelId, "config.modelId");
      return value as unknown as Mrt2ControlMessage;
    case "session.ok":
      requiredString(value.requestId, "message.requestId");
      requiredString(value.sessionId, "message.sessionId");
      return value as unknown as Mrt2ControlMessage;
    case "input.update":
      requiredString(value.requestId, "message.requestId");
      requiredString(value.sessionId, "message.sessionId");
      validateSerializableInput(value.input);
      return value as unknown as Mrt2ControlMessage;
    case "session.start":
    case "session.stop":
    case "session.close":
      requiredString(value.requestId, "message.requestId");
      requiredString(value.sessionId, "message.sessionId");
      return value as unknown as Mrt2ControlMessage;
    case "capture.start":
      requiredString(value.requestId, "message.requestId");
      requiredString(value.sessionId, "message.sessionId");
      finitePositive(value.durationSec, "message.durationSec");
      return value as unknown as Mrt2ControlMessage;
    case "capture.ok":
      requiredString(value.requestId, "message.requestId");
      requiredString(value.sessionId, "message.sessionId");
      boundedInteger(value.frames, "message.frames", MRT2_PACKET_MAX_FRAMES);
      finitePositive(value.durationSec, "message.durationSec");
      requiredString(value.inputHash, "message.inputHash");
      return value as unknown as Mrt2ControlMessage;
    case "status":
      if (
        ![
          "idle",
          "loading",
          "downloading",
          "starting",
          "ready",
          "running",
          "buffering",
          "capturing",
          "reconnecting",
          "error",
          "unavailable",
        ].includes(String(value.state))
      ) {
        throw new Error("MRT2 status state is invalid");
      }
      if (typeof value.message !== "undefined") requiredString(value.message, "status.message");
      return value as unknown as Mrt2ControlMessage;
    case "error":
      requiredString(value.code, "message.code");
      requiredString(value.message, "message.message");
      return value as unknown as Mrt2ControlMessage;
    default:
      throw new Error(`Unsupported MRT2 control message: ${type}`);
  }
}

export function serializeMrt2ControlMessage(message: Mrt2ControlMessage): string {
  const parsed = parseMrt2ControlMessage(message);
  const serialized = JSON.stringify(parsed);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MRT2_CONTROL_MAX_BYTES) throw new Error("MRT2 control message is too large");
  return serialized;
}

/** Encode PCM as a versioned binary frame; control messages never carry PCM. */
export function encodeMrt2AudioPacket(packet: Mrt2AudioPacket): ArrayBuffer {
  if (packet.kind !== "output" && packet.kind !== "style") throw new Error("MRT2 packet kind is invalid");
  if (!Number.isSafeInteger(packet.sequence) || packet.sequence < 0 || packet.sequence > 0xffffffff) {
    throw new Error("MRT2 packet sequence is invalid");
  }
  const sampleRate = finitePositive(packet.sampleRate, "packet.sampleRate");
  const channels = boundedInteger(packet.channels, "packet.channels", 2);
  if (channels < 1) throw new Error("MRT2 packet channels are invalid");
  const frames = boundedInteger(packet.frames, "packet.frames", MRT2_PACKET_MAX_FRAMES);
  if (packet.data.length !== frames * channels) throw new Error("MRT2 packet PCM shape is invalid");
  for (const sample of packet.data)
    if (!Number.isFinite(sample)) throw new Error("MRT2 packet contains non-finite PCM");
  const dataBytes = packet.data.byteLength;
  const buffer = new ArrayBuffer(MRT2_PACKET_HEADER_BYTES + dataBytes);
  const bytes = new Uint8Array(buffer, 0, 8);
  for (let index = 0; index < MRT2_PACKET_MAGIC.length; index++) bytes[index] = MRT2_PACKET_MAGIC.charCodeAt(index);
  const view = new DataView(buffer);
  view.setUint16(8, MRT2_PROTOCOL_VERSION, true);
  view.setUint8(10, packet.kind === "output" ? 0 : 1);
  view.setUint8(11, channels);
  view.setUint32(12, sampleRate, true);
  view.setUint32(16, frames, true);
  view.setUint32(20, packet.sequence, true);
  view.setUint32(24, dataBytes, true);
  view.setUint32(28, 0, true);
  new Float32Array(buffer, MRT2_PACKET_HEADER_BYTES).set(packet.data);
  return buffer;
}

export function decodeMrt2AudioPacket(raw: ArrayBuffer): Mrt2AudioPacket {
  if (raw.byteLength < MRT2_PACKET_HEADER_BYTES) throw new Error("MRT2 audio packet is truncated");
  const view = new DataView(raw);
  for (let index = 0; index < MRT2_PACKET_MAGIC.length; index++) {
    if (view.getUint8(index) !== MRT2_PACKET_MAGIC.charCodeAt(index))
      throw new Error("MRT2 audio packet magic is invalid");
  }
  if (view.getUint16(8, true) !== MRT2_PROTOCOL_VERSION) throw new Error("Unsupported MRT2 audio packet version");
  const kindValue = view.getUint8(10);
  if (kindValue > 1) throw new Error("MRT2 audio packet kind is invalid");
  const channels = view.getUint8(11);
  if (channels < 1 || channels > 2) throw new Error("MRT2 audio packet channels are invalid");
  const sampleRate = view.getUint32(12, true);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("MRT2 audio packet sample rate is invalid");
  const frames = view.getUint32(16, true);
  const sequence = view.getUint32(20, true);
  const dataBytes = view.getUint32(24, true);
  if (frames > MRT2_PACKET_MAX_FRAMES || dataBytes !== frames * channels * 4) {
    throw new Error("MRT2 audio packet size is invalid");
  }
  if (MRT2_PACKET_HEADER_BYTES + dataBytes !== raw.byteLength) throw new Error("MRT2 audio packet has trailing bytes");
  const data = new Float32Array(raw, MRT2_PACKET_HEADER_BYTES, frames * channels);
  for (const sample of data) if (!Number.isFinite(sample)) throw new Error("MRT2 audio packet contains non-finite PCM");
  return { kind: kindValue === 0 ? "output" : "style", sequence, sampleRate, channels, frames, data };
}
