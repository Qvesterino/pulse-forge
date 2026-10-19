/**
 * Windows Studio WASAPI I/O request/session contract (ADR 0050).
 *
 * The exact-endpoint shared-mode path is implemented and connected to the
 * AudioEngine. Its physical-device latency, dropout and recovery qualification
 * remains open. Device identities and channel maps are exact user intent. The
 * Electron utility process cannot receive the renderer's SharedArrayBuffer,
 * so PCM uses bounded Float32Array packets over a dedicated MessagePort. Do
 * not send audio in invoke payloads or through React state.
 */

export type WindowsAudioBackend = "wasapi-shared" | "wasapi-exclusive" | "asio";
export type WindowsAudioFlow = "capture" | "render";
export type WindowsNativeSampleFormat = "f32le" | "s16le" | "s24le" | "s32le";

export interface WindowsAudioEndpoint {
  /** Opaque MMDevice or ASIO endpoint identity. Never substitute another ID. */
  id: string;
  name: string;
  flow: WindowsAudioFlow;
  backend: WindowsAudioBackend;
  channelCount: number;
  sampleRatesHz: number[];
  /** Queried from IAudioClient3 for the selected shared-mode format. */
  sharedPeriods?: { minFrames: number; maxFrames: number; fundamentalFrames: number };
}

export interface WindowsAudioIoRequest {
  backend: WindowsAudioBackend;
  inputEndpointId: string;
  outputEndpointId: string;
  sampleRateHz: number;
  /** Exact requested endpoint period; reject if the backend cannot honor it. */
  periodFrames: number;
  /** Zero-based hardware channel indexes, in the requested project-routing order. */
  inputChannelMap: number[];
  outputChannelMap: number[];
  /** Exclusive mode can interrupt other applications and needs explicit consent. */
  exclusiveAcknowledged: boolean;
}

export interface WindowsAudioIoNegotiation {
  backend: WindowsAudioBackend;
  inputEndpointId: string;
  outputEndpointId: string;
  sampleRateHz: number;
  periodFrames: number;
  nativeSampleFormat: WindowsNativeSampleFormat;
  /** Native ring protocol is always interleaved float32, regardless of driver format. */
  ringSampleFormat: "f32le";
  inputChannelCount: number;
  outputChannelCount: number;
  inputChannelMap: number[];
  outputChannelMap: number[];
  inputBufferFrames: number;
  outputBufferFrames: number;
  /** Endpoint-reported stream latency only; this is not acoustic round-trip latency. */
  reportedInputLatencyFrames?: number;
  reportedOutputLatencyFrames?: number;
  sharedPeriods?: { minFrames: number; maxFrames: number; fundamentalFrames: number };
}

/** One bounded interleaved float32 block sent over the session's dedicated port. */
export interface WindowsAudioIoPcmPacket {
  type: WindowsAudioFlow;
  sessionId: string;
  sequence: number;
  frames: number;
  channels: number;
  samples: ArrayBuffer;
}

export type WindowsAudioIoSessionEvent =
  | { type: "xrun"; direction: WindowsAudioFlow; count: number }
  | { type: "device-lost"; endpointId: string; message: string }
  | { type: "stream-error"; message: string }
  | { type: "stopped" };

export interface WindowsAudioIoSession {
  id: string;
  negotiation: WindowsAudioIoNegotiation;
  /** Dedicated renderer/worklet ↔ native utility port carrying bounded ArrayBuffers. */
  port: MessagePort;
  subscribe(listener: (event: WindowsAudioIoSessionEvent) => void): () => void;
  /** Idempotent; releases both endpoints and rejects stale buffers by session ID. */
  stop(): Promise<void>;
}

export interface WindowsAudioIoBackend {
  enumerateEndpoints(): Promise<WindowsAudioEndpoint[]>;
  startDuplex(request: WindowsAudioIoRequest): Promise<WindowsAudioIoSession>;
}

const MAX_PCM_PACKET_FRAMES = 8192;
const MAX_PCM_PACKET_BYTES = 1 * 1024 * 1024;

export type WindowsAudioIoValidation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBackend(value: unknown): value is WindowsAudioBackend {
  return value === "wasapi-shared" || value === "wasapi-exclusive" || value === "asio";
}

function isChannelMap(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 32 &&
    value.every((channel) => Number.isSafeInteger(channel) && channel >= 0) &&
    new Set(value).size === value.length
  );
}

function isExactEndpointId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 2048;
}

function isBoundedPositiveInteger(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max;
}

function isBoundedNonNegativeInteger(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
}

/** Validate untrusted renderer/IPC input without normalizing away user intent. */
export function validateWindowsAudioIoRequest(value: unknown): WindowsAudioIoValidation<WindowsAudioIoRequest> {
  if (!isRecord(value)) return { ok: false, errors: ["request must be an object"] };
  const errors: string[] = [];

  if (!isBackend(value.backend)) errors.push("backend is unsupported");
  if (!isExactEndpointId(value.inputEndpointId)) errors.push("inputEndpointId must select an exact endpoint");
  if (!isExactEndpointId(value.outputEndpointId)) errors.push("outputEndpointId must select an exact endpoint");
  if (!isBoundedPositiveInteger(value.sampleRateHz, 384_000) || Number(value.sampleRateHz) < 8_000)
    errors.push("sampleRateHz must be an integer between 8000 and 384000");
  if (!isBoundedPositiveInteger(value.periodFrames, 131_072))
    errors.push("periodFrames must be a positive bounded integer");
  if (!isChannelMap(value.inputChannelMap))
    errors.push("inputChannelMap must contain unique zero-based channel indexes");
  if (!isChannelMap(value.outputChannelMap))
    errors.push("outputChannelMap must contain unique zero-based channel indexes");
  if (typeof value.exclusiveAcknowledged !== "boolean") errors.push("exclusiveAcknowledged must be explicit");
  else if (value.backend === "wasapi-exclusive" && value.exclusiveAcknowledged !== true)
    errors.push("WASAPI exclusive mode requires explicit acknowledgement");

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      backend: value.backend as WindowsAudioBackend,
      inputEndpointId: value.inputEndpointId as string,
      outputEndpointId: value.outputEndpointId as string,
      sampleRateHz: value.sampleRateHz as number,
      periodFrames: value.periodFrames as number,
      inputChannelMap: [...(value.inputChannelMap as number[])],
      outputChannelMap: [...(value.outputChannelMap as number[])],
      exclusiveAcknowledged: value.exclusiveAcknowledged as boolean,
    },
  };
}

/** Validate an untrusted PCM message before it enters an audio or native queue. */
export function validateWindowsAudioIoPcmPacket(
  value: unknown,
  direction: WindowsAudioFlow,
  sessionId: string,
  expectedChannels: number,
): WindowsAudioIoValidation<WindowsAudioIoPcmPacket> {
  if (!isRecord(value)) return { ok: false, errors: ["PCM packet must be an object"] };
  const errors: string[] = [];
  if (value.type !== direction) errors.push("PCM packet direction is invalid");
  if (value.sessionId !== sessionId) errors.push("PCM packet belongs to a different session");
  if (!isBoundedNonNegativeInteger(value.sequence, Number.MAX_SAFE_INTEGER))
    errors.push("PCM packet sequence is invalid");
  if (!isBoundedPositiveInteger(value.frames, MAX_PCM_PACKET_FRAMES)) errors.push("PCM packet frame count is invalid");
  if (!isBoundedPositiveInteger(value.channels, 32) || value.channels !== expectedChannels)
    errors.push("PCM packet channel count does not match the selected channel map");
  if (!(value.samples instanceof ArrayBuffer)) errors.push("PCM packet samples must be an ArrayBuffer");

  if (
    isBoundedPositiveInteger(value.frames, MAX_PCM_PACKET_FRAMES) &&
    isBoundedPositiveInteger(value.channels, 32) &&
    value.samples instanceof ArrayBuffer
  ) {
    const expectedBytes = value.frames * value.channels * Float32Array.BYTES_PER_ELEMENT;
    if (expectedBytes > MAX_PCM_PACKET_BYTES) errors.push("PCM packet exceeds the one-megabyte transfer limit");
    if (value.samples.byteLength !== expectedBytes) errors.push("PCM packet sample buffer length is inconsistent");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      type: direction,
      sessionId,
      sequence: value.sequence as number,
      frames: value.frames as number,
      channels: value.channels as number,
      samples: value.samples as ArrayBuffer,
    },
  };
}

/**
 * Reject silent renegotiation, endpoint substitution and illegal shared
 * periods before exposing a session to the engine. The host must query the
 * endpoint's actual supported formats/periods before returning this record.
 */
export function validateWindowsAudioIoNegotiation(
  request: WindowsAudioIoRequest,
  value: unknown,
): WindowsAudioIoValidation<WindowsAudioIoNegotiation> {
  if (!isRecord(value)) return { ok: false, errors: ["negotiation must be an object"] };
  const errors: string[] = [];

  if (value.backend !== request.backend) errors.push("backend changed during negotiation");
  if (value.inputEndpointId !== request.inputEndpointId) errors.push("input endpoint was substituted");
  if (value.outputEndpointId !== request.outputEndpointId) errors.push("output endpoint was substituted");
  if (value.sampleRateHz !== request.sampleRateHz) errors.push("sample rate was not honored exactly");
  if (value.periodFrames !== request.periodFrames) errors.push("period was not honored exactly");
  if (value.ringSampleFormat !== "f32le") errors.push("PCM ring must use interleaved float32");
  if (!isChannelMap(value.inputChannelMap) || value.inputChannelMap.join(",") !== request.inputChannelMap.join(","))
    errors.push("input channel map was changed");
  if (!isChannelMap(value.outputChannelMap) || value.outputChannelMap.join(",") !== request.outputChannelMap.join(","))
    errors.push("output channel map was changed");
  if (!isBackend(value.backend)) errors.push("negotiated backend is unsupported");
  if (!isBoundedPositiveInteger(value.inputChannelCount, 32)) errors.push("inputChannelCount is invalid");
  if (!isBoundedPositiveInteger(value.outputChannelCount, 32)) errors.push("outputChannelCount is invalid");
  if (!isBoundedPositiveInteger(value.inputBufferFrames, 1_048_576)) errors.push("inputBufferFrames is invalid");
  if (!isBoundedPositiveInteger(value.outputBufferFrames, 1_048_576)) errors.push("outputBufferFrames is invalid");
  if (!(["f32le", "s16le", "s24le", "s32le"] as unknown[]).includes(value.nativeSampleFormat))
    errors.push("nativeSampleFormat is unsupported");

  const inputChannelCount = value.inputChannelCount;
  const outputChannelCount = value.outputChannelCount;
  const inputChannelMap = value.inputChannelMap;
  const outputChannelMap = value.outputChannelMap;
  if (isBoundedPositiveInteger(inputChannelCount, 32) && isChannelMap(inputChannelMap)) {
    if (inputChannelMap.some((channel) => channel >= inputChannelCount))
      errors.push("input channel map exceeds the negotiated endpoint channel count");
  }
  if (isBoundedPositiveInteger(outputChannelCount, 32) && isChannelMap(outputChannelMap)) {
    if (outputChannelMap.some((channel) => channel >= outputChannelCount))
      errors.push("output channel map exceeds the negotiated endpoint channel count");
  }
  if (isBoundedPositiveInteger(value.inputBufferFrames, 1_048_576) && value.inputBufferFrames < request.periodFrames)
    errors.push("input buffer is smaller than one requested period");
  if (isBoundedPositiveInteger(value.outputBufferFrames, 1_048_576) && value.outputBufferFrames < request.periodFrames)
    errors.push("output buffer is smaller than one requested period");

  if (request.backend === "wasapi-shared") {
    const periods = value.sharedPeriods;
    if (
      !isRecord(periods) ||
      !isBoundedPositiveInteger(periods.minFrames, 131_072) ||
      !isBoundedPositiveInteger(periods.maxFrames, 131_072) ||
      !isBoundedPositiveInteger(periods.fundamentalFrames, 131_072) ||
      periods.maxFrames < periods.minFrames ||
      request.periodFrames < periods.minFrames ||
      request.periodFrames > periods.maxFrames ||
      request.periodFrames % periods.fundamentalFrames !== 0
    ) {
      errors.push("shared-mode period is outside the endpoint's legal range or not fundamental-period aligned");
    }
  }

  const reportedInputLatencyFrames = value.reportedInputLatencyFrames;
  const reportedOutputLatencyFrames = value.reportedOutputLatencyFrames;
  if (reportedInputLatencyFrames !== undefined && !isBoundedNonNegativeInteger(reportedInputLatencyFrames, 1_048_576))
    errors.push("reportedInputLatencyFrames is invalid");
  if (reportedOutputLatencyFrames !== undefined && !isBoundedNonNegativeInteger(reportedOutputLatencyFrames, 1_048_576))
    errors.push("reportedOutputLatencyFrames is invalid");

  if (errors.length > 0) return { ok: false, errors };
  const sharedPeriods = request.backend === "wasapi-shared" ? value.sharedPeriods : undefined;
  return {
    ok: true,
    value: {
      backend: value.backend as WindowsAudioBackend,
      inputEndpointId: value.inputEndpointId as string,
      outputEndpointId: value.outputEndpointId as string,
      sampleRateHz: value.sampleRateHz as number,
      periodFrames: value.periodFrames as number,
      nativeSampleFormat: value.nativeSampleFormat as WindowsNativeSampleFormat,
      ringSampleFormat: "f32le",
      inputChannelCount: inputChannelCount as number,
      outputChannelCount: outputChannelCount as number,
      inputChannelMap: [...(inputChannelMap as number[])],
      outputChannelMap: [...(outputChannelMap as number[])],
      inputBufferFrames: value.inputBufferFrames as number,
      outputBufferFrames: value.outputBufferFrames as number,
      ...(reportedInputLatencyFrames === undefined
        ? {}
        : { reportedInputLatencyFrames: reportedInputLatencyFrames as number }),
      ...(reportedOutputLatencyFrames === undefined
        ? {}
        : { reportedOutputLatencyFrames: reportedOutputLatencyFrames as number }),
      ...(request.backend !== "wasapi-shared"
        ? {}
        : {
            sharedPeriods: {
              minFrames: (sharedPeriods as Record<string, unknown>).minFrames as number,
              maxFrames: (sharedPeriods as Record<string, unknown>).maxFrames as number,
              fundamentalFrames: (sharedPeriods as Record<string, unknown>).fundamentalFrames as number,
            },
          }),
    },
  };
}
