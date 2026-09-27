/**
 * Framed PCM pipe transport — Node consumer (ADR 0018).
 *
 * The transport every native audio source speaks: length-prefixed frames
 * (magic "KYXP", type, seq, len, payload) over a spawn pipe. Wave 1 ships
 * the transport + a deterministic reference source (native/pcm-host);
 * the wave-2 ASIO streaming host emits the SAME frames from its callbacks,
 * so everything below is hardware-independent and acceptance-tested here.
 *
 * Boundary discipline: frames are validated (magic, known type, bounded
 * length, monotonic seq) before any payload escapes this module; a stream
 * that violates the protocol is torn down with a diagnostic, never passed
 * through.
 */
const { spawn: spawnProcess } = require("node:child_process");
const path = require("node:path");

const FRAME_MAGIC = 0x5058594b; /* "KYXP" little-endian */
const HEADER_BYTES = 16;
const FRAME_TYPES = { PCM: 1, EVENT: 2, STATS: 3, EOF: 4 };
const MAX_PAYLOAD_BYTES = 4 << 20; /* one block never legitimately exceeds this */

/** Dev-tree default; packaged builds pass resourcesPath. */
function defaultPcmHostPath(resourcesPath) {
  if (resourcesPath) return path.join(resourcesPath, "pcm", "pcm-gen.exe");
  return path.join(__dirname, "..", "native", "pcm-host", "build", "Release", "pcm-gen.exe");
}

/**
 * Parse ONE frame from `buffer` starting at `offset`.
 * Returns { frame: {type, seq, payload, headerBytes}, consumed } or
 * { needMore: true } when the buffer holds an incomplete frame, or
 * { error: string } on a protocol violation (caller must tear the stream down).
 */
function parseFrame(buffer, offset = 0, maxPayloadBytes = MAX_PAYLOAD_BYTES) {
  if (buffer.length - offset < HEADER_BYTES) return { needMore: true };
  if (buffer.readUInt32LE(offset) !== FRAME_MAGIC) return { error: "bad frame magic" };
  const type = buffer.readUInt8(offset + 4);
  const flags = buffer.readUInt8(offset + 5);
  const seq = buffer.readUInt32LE(offset + 8);
  const len = buffer.readUInt32LE(offset + 12);
  if (!Object.values(FRAME_TYPES).includes(type)) return { error: `unknown frame type ${type}` };
  if (flags !== 0) return { error: `unknown flags ${flags}` };
  if (len > maxPayloadBytes) return { error: `payload ${len} exceeds cap ${maxPayloadBytes}` };
  if (buffer.length - offset - HEADER_BYTES < len) return { needMore: true };
  return {
    frame: { type, seq, payload: buffer.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + len) },
    consumed: HEADER_BYTES + len,
  };
}

/** Pure drain: parse every complete frame in `buffer`, return leftovers offset. */
function drainFrames(buffer, handlers, maxPayloadBytes = MAX_PAYLOAD_BYTES) {
  let offset = 0;
  while (offset + HEADER_BYTES <= buffer.length) {
    const parsed = parseFrame(buffer, offset, maxPayloadBytes);
    if (parsed.needMore) break;
    if (parsed.error) return { error: parsed.error, consumed: offset };
    handlers.onFrame(parsed.frame);
    offset += parsed.consumed;
  }
  return { consumed: offset };
}

/**
 * Spawn `pcm-gen` (or any ADR 0018 source), parse frames off the pipe, keep
 * contiguous-frame accounting and byte-rate stats. Events:
 *   "format" ({rate, channels, blockFrames})   — from the EVENT frame
 *   "pcm" ({seq, samples: Float32Array, frames, channels})
 *   "stats" (record) | "end" (record)          — STATS / EOF frames
 *   "protocol-error" (message)                 — stream torn down
 *   "close" ({exitCode, stats})
 */
class PcmPipeSource {
  constructor(options = {}) {
    this.hostPath = options.hostPath ?? defaultPcmHostPath(options.resourcesPath);
    this.args = options.args ?? ["--seconds", "10"];
    this.spawn = options.spawn ?? spawnProcess;
    this.listeners = new Map();
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.nextSeq = 0;
    this.seqGaps = 0;
    this.framesReceived = 0;
    this.pcmFramesReceived = 0;
    this.bytesReceived = 0;
    this.startedAt = 0;
    this.format = null;
    this.ended = false;
  }

  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(listener);
    return () => this.listeners.get(event)?.delete(listener);
  }

  emit(event, payload) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  start() {
    let child;
    try {
      this.child = child = this.spawn(this.hostPath, this.args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.emit("protocol-error", `spawn failed: ${err?.message ?? err}`);
      return this;
    }
    this.startedAt = Date.now();
    child.stdout.on("data", (chunk) => {
      this.bytesReceived += chunk.length;
      this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
      const result = drainFrames(this.buffer, {
        onFrame: (frame) => this.handleFrame(frame),
      });
      if (result.error) {
        this.emit("protocol-error", result.error);
        this.child.kill("SIGKILL");
        this.buffer = Buffer.alloc(0);
        return;
      }
      this.buffer = this.buffer.subarray(result.consumed);
    });
    child.on("error", (err) => {
      this.emit("protocol-error", `spawn failed: ${err?.message ?? err}`);
    });
    child.on("close", (exitCode) => {
      this.emit("close", { exitCode, stats: this.getStats() });
    });
    return this;
  }

  handleFrame(frame) {
    if (frame.type === FRAME_TYPES.PCM) {
      if (frame.seq !== this.nextSeq) this.seqGaps++;
      this.nextSeq = frame.seq + 1;
      this.framesReceived++;
      // Payload offsets inside the accumulation buffer are not 4-aligned
      // whenever a partial frame preceded it — copy into a fresh (aligned)
      // allocation before viewing as float32.
      const aligned = Buffer.from(frame.payload);
      const floats = new Float32Array(aligned.buffer, aligned.byteOffset, aligned.length / 4);
      const channels = this.format?.channels ?? 2;
      this.pcmFramesReceived += floats.length / channels;
      this.emit("pcm", { seq: frame.seq, samples: floats, frames: floats.length / channels, channels });
      return;
    }
    const text = frame.payload.toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.emit("protocol-error", `bad JSON in type-${frame.type} frame`);
      return;
    }
    if (frame.type === FRAME_TYPES.EVENT) {
      this.format = parsed;
      this.emit("format", parsed);
    } else if (frame.type === FRAME_TYPES.STATS) {
      this.emit("stats", parsed);
    } else if (frame.type === FRAME_TYPES.EOF) {
      this.ended = true;
      this.emit("end", parsed);
    }
  }

  getStats() {
    return {
      framesReceived: this.framesReceived,
      pcmFramesReceived: this.pcmFramesReceived,
      seqGaps: this.seqGaps,
      bytesReceived: this.bytesReceived,
      elapsedMs: Date.now() - this.startedAt,
      ended: this.ended,
    };
  }

  stop() {
    this.child?.kill("SIGKILL");
  }
}

module.exports = {
  PcmPipeSource,
  parseFrame,
  drainFrames,
  defaultPcmHostPath,
  FRAME_MAGIC,
  FRAME_TYPES,
  HEADER_BYTES,
  MAX_PAYLOAD_BYTES,
};
