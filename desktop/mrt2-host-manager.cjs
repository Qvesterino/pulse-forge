/**
 * Owns the optional MRT2 native process and bridges its bounded binary IPC
 * protocol to exactly one authorized Electron renderer per transport.
 * Renderer data can never choose the executable, model root, or arguments.
 */
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn: spawnProcess } = require("node:child_process");

const MAX_READY_LINE_BYTES = 4096;
const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_PACKET_BYTES = 5_760_032;
const MAX_CHILD_FRAME_BYTES = MAX_PACKET_BYTES + 256;
const MAX_PENDING_STDIN_BYTES = 12 * 1024 * 1024;
const MAX_TRANSPORT_ID_BYTES = 128;
const ALLOWED_CONTROL_TYPES = new Set([
  "hello",
  "session.create",
  "input.update",
  "session.start",
  "session.stop",
  "session.close",
  "capture.start",
]);

function getModelPaths(homeDirectory) {
  const modelRoot = path.join(homeDirectory, "Documents", "Magenta", "magenta-rt-v2");
  return {
    modelRoot,
    resources: path.join(modelRoot, "resources", "musiccoca"),
    model: path.join(modelRoot, "models", "mrt2_small", "mrt2_small.mlxfn"),
  };
}

function parseReadyLine(line) {
  if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > MAX_READY_LINE_BYTES) {
    throw new Error("MRT2 native host ready line is invalid");
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("MRT2 native host emitted invalid startup JSON");
  }
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    value.type !== "ready" ||
    value.providerId !== "mrt2" ||
    value.modelId !== "mrt2_small"
  ) {
    throw new Error("MRT2 native host reported an incompatible runtime");
  }
  const ready = { version: 1, type: "ready", providerId: "mrt2", modelId: "mrt2_small" };
  if (value.runtimeProfile !== undefined) {
    const profile = value.runtimeProfile;
    if (
      !profile ||
      typeof profile !== "object" ||
      typeof profile.backendId !== "string" ||
      profile.backendId.length === 0 ||
      !["capture", "near-realtime", "realtime"].includes(profile.executionMode)
    ) {
      throw new Error("MRT2 native host runtime profile is invalid");
    }
    for (const name of ["measuredLatencyMs", "frameP95Ms", "realtimeFactor"]) {
      if (
        profile[name] !== undefined &&
        (typeof profile[name] !== "number" ||
          !Number.isFinite(profile[name]) ||
          profile[name] < 0 ||
          profile[name] > 60_000)
      ) {
        throw new Error(`MRT2 native host runtime profile ${name} is invalid`);
      }
    }
    ready.runtimeProfile = {
      backendId: profile.backendId,
      executionMode: profile.executionMode,
      ...(typeof profile.runtimeVersion === "string" ? { runtimeVersion: profile.runtimeVersion } : {}),
      ...(typeof profile.measuredLatencyMs === "number" ? { measuredLatencyMs: profile.measuredLatencyMs } : {}),
      ...(typeof profile.frameP95Ms === "number" ? { frameP95Ms: profile.frameP95Ms } : {}),
      ...(typeof profile.realtimeFactor === "number" ? { realtimeFactor: profile.realtimeFactor } : {}),
      ...(typeof profile.warning === "string" ? { warning: profile.warning } : {}),
    };
  }
  return ready;
}

function asBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error(`${label} must be binary data`);
}

function validateControlMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.version !== 1) {
    throw new Error("MRT2 control message is invalid");
  }
  if (!ALLOWED_CONTROL_TYPES.has(message.type)) throw new Error("MRT2 control message type is not allowed");
  if (typeof message.requestId !== "string" || message.requestId.length < 1 || message.requestId.length > 160) {
    throw new Error("MRT2 control request id is invalid");
  }
  if (message.type === "hello" && message.client !== "kyx") throw new Error("MRT2 client is invalid");
  if (message.type === "session.create") {
    const config = message.config;
    if (
      !config ||
      config.modelId !== "mrt2_small" ||
      config.outputSampleRate !== 48_000 ||
      config.outputChannels !== 2
    ) {
      throw new Error("MRT2 session config is unsupported");
    }
  }
  const json = JSON.stringify(message);
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_CONTROL_BYTES) {
    throw new Error("MRT2 control message is too large");
  }
  return Buffer.from(json, "utf8");
}

function validateStylePacket(value) {
  const packet = asBuffer(value, "MRT2 style packet");
  if (packet.byteLength < 32 || packet.byteLength > MAX_PACKET_BYTES)
    throw new Error("MRT2 style packet size is invalid");
  if (packet.subarray(0, 8).toString("binary") !== "KYXMRT2\0") throw new Error("MRT2 style packet magic is invalid");
  if (packet.readUInt16LE(8) !== 1) throw new Error("MRT2 style packet version is unsupported");
  if (packet.readUInt8(10) !== 1) throw new Error("Only MRT2 style packets may be sent to the native host");
  const channels = packet.readUInt8(11);
  const sampleRate = packet.readUInt32LE(12);
  const frames = packet.readUInt32LE(16);
  const dataBytes = packet.readUInt32LE(24);
  if (channels < 1 || channels > 2 || sampleRate < 1 || sampleRate > 192_000) {
    throw new Error("MRT2 style packet format is invalid");
  }
  if (frames < 1 || frames > 720_000 || dataBytes !== frames * channels * 4 || packet.byteLength !== 32 + dataBytes) {
    throw new Error("MRT2 style packet size is invalid");
  }
  for (let offset = 32; offset < packet.byteLength; offset += 4) {
    if (!Number.isFinite(packet.readFloatLE(offset))) throw new Error("MRT2 style packet contains non-finite PCM");
  }
  return packet;
}

function encodeFrame(type, transportId, payload = Buffer.alloc(0)) {
  const id = Buffer.from(transportId, "utf8");
  if (id.byteLength > MAX_TRANSPORT_ID_BYTES) throw new Error("MRT2 transport id is too long");
  const bodyLength = 3 + id.byteLength + payload.byteLength;
  if (bodyLength > MAX_CHILD_FRAME_BYTES) throw new Error("MRT2 native-host frame is too large");
  const frame = Buffer.allocUnsafe(4 + bodyLength);
  frame.writeUInt32BE(bodyLength, 0);
  frame.writeUInt8(type, 4);
  frame.writeUInt16BE(id.byteLength, 5);
  id.copy(frame, 7);
  payload.copy(frame, 7 + id.byteLength);
  return frame;
}

class Mrt2NativeHostManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.appIsPackaged = options.appIsPackaged ?? false;
    this.resourcesPath = options.resourcesPath ?? process.resourcesPath ?? "";
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.nativeHostPath =
      options.nativeHostPath ??
      path.join(this.resourcesPath, "mrt2-host", this.platform === "win32" ? "kyx-mrt2-host.exe" : "kyx-mrt2-host");
    this.modelPaths = getModelPaths(this.homeDirectory);
    this.fileExists = options.fileExists ?? fs.existsSync;
    this.lstat = options.lstat ?? ((filePath) => fs.lstatSync(filePath));
    this.assertExecutable = options.assertExecutable ?? ((filePath) => fs.accessSync(filePath, fs.constants.X_OK));
    this.spawn = options.spawn ?? spawnProcess;
    this.childEnv = options.childEnv ?? null;
    this.startTimeoutMs = options.startTimeoutMs ?? 60_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 3_000;
    this.stopSignalTimeoutMs = options.stopSignalTimeoutMs ?? Math.min(500, this.stopTimeoutMs);
    this.child = null;
    this.ready = false;
    this.startupComplete = false;
    this.startPromise = null;
    this.stopPromise = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.transportIds = new Set();
    this.readyProfile = null;
  }

  isReady() {
    return this.ready && !!this.child && !this.stopPromise;
  }

  isRunning() {
    return !!this.child;
  }

  assertInstallAvailable() {
    if (this.platform !== "darwin" || this.arch !== "arm64") {
      throw new Error("MRT2 realtime requires an Apple Silicon Mac");
    }
    if (!this.appIsPackaged) throw new Error("Native MRT2 is available only in a packaged KYX desktop build");
    let stat;
    try {
      stat = this.lstat(this.nativeHostPath);
    } catch {
      throw new Error("The packaged MRT2 native host is missing or not executable");
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The packaged MRT2 native host is not a regular file");
    try {
      this.assertExecutable(this.nativeHostPath);
    } catch {
      throw new Error("The packaged MRT2 native host is missing or not executable");
    }
    if (!this.fileExists(this.modelPaths.resources) || !this.fileExists(this.modelPaths.model)) {
      throw new Error("MRT2 Small model resources are not installed in ~/Documents/Magenta/magenta-rt-v2");
    }
  }

  getHostArgs() {
    return ["--model-root", this.modelPaths.modelRoot];
  }

  start() {
    if (this.isReady()) return Promise.resolve({ ready: true });
    if (this.startPromise) return this.startPromise;
    if (this.child) throw new Error("MRT2 native host is still shutting down");
    this.assertInstallAvailable();
    this.stdoutBuffer = Buffer.alloc(0);
    this.readyProfile = null;
    this.ready = false;
    this.startupComplete = false;
    const child = this.spawn(this.nativeHostPath, this.getHostArgs(), {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.modelPaths.modelRoot,
      env: this.childEnv ?? { HOME: this.homeDirectory, PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    this.child = child;
    this.attachChild(child);
    this.startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error("MRT2 native host startup timed out")), this.startTimeoutMs);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.startPromise = null;
        if (error) {
          this.ready = false;
          this.startupComplete = false;
          this._startupFinish = null;
          try {
            child.kill("SIGTERM");
          } catch {
            /* process may already be gone */
          }
          reject(error);
        } else {
          if (this.stopPromise) {
            this.startupComplete = false;
            this._startupFinish = null;
            reject(new Error("MRT2 native host was stopped during startup"));
            return;
          }
          this.ready = true;
          this.startupComplete = true;
          this._startupFinish = null;
          resolve({ ready: true });
        }
      };
      this._startupFinish = finish;
      child.once("error", (error) => finish(error));
      child.stdout.on("data", (chunk) => {
        try {
          this.onStdout(chunk, child, finish);
        } catch (error) {
          const failure = error instanceof Error ? error : new Error("MRT2 native host protocol failed");
          if (this.ready) this.failHost(child, failure.message);
          else finish(failure);
        }
      });
      child.once("exit", (code, signal) => {
        const message = `MRT2 native host exited${code === null ? ` (${signal ?? "unknown signal"})` : ` with code ${code}`}`;
        finish(new Error(message));
        this.onChildExit(child, message);
      });
      child.once("close", (code, signal) => {
        if (this.child !== child) return;
        const message = `MRT2 native host closed${code === null ? ` (${signal ?? "unknown signal"})` : ` with code ${code}`}`;
        this.onChildExit(child, message);
      });
    });
    return this.startPromise;
  }

  openTransport() {
    if (!this.isReady()) throw new Error("MRT2 native host is not ready");
    const transportId = randomUUID();
    this.transportIds.add(transportId);
    return transportId;
  }

  sendControl(transportId, message) {
    this.assertTransport(transportId);
    this.writeFrame(encodeFrame(0, transportId, validateControlMessage(message)));
  }

  sendBinary(transportId, value) {
    this.assertTransport(transportId);
    this.writeFrame(encodeFrame(1, transportId, validateStylePacket(value)));
  }

  closeTransport(transportId) {
    this.assertTransport(transportId);
    this.transportIds.delete(transportId);
    this.writeFrame(encodeFrame(2, transportId, Buffer.alloc(0)));
    this.emit("transport-event", { transportId, kind: "closed", reason: "KYX transport closed" });
  }

  assertTransport(transportId) {
    if (!this.isReady()) throw new Error("MRT2 native host is not ready");
    if (typeof transportId !== "string" || !this.transportIds.has(transportId)) {
      throw new Error("MRT2 transport is not open");
    }
  }

  writeFrame(frame) {
    const child = this.child;
    if (!this.isReady() || !child?.stdin || child.stdin.destroyed) throw new Error("MRT2 native host is not ready");
    if (child.stdin.writableLength + frame.byteLength > MAX_PENDING_STDIN_BYTES) {
      throw new Error("MRT2 native-host input queue is full");
    }
    child.stdin.write(frame);
  }

  onStdout(chunk, child, finishStartup) {
    if (this.child !== child) return;
    const incoming = Buffer.from(chunk);
    if (this.stdoutBuffer.byteLength + incoming.byteLength > MAX_CHILD_FRAME_BYTES * 2 + MAX_READY_LINE_BYTES + 1) {
      throw new Error("MRT2 native-host output buffer exceeded its limit");
    }
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, incoming]);
    if (!this.startupComplete) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline === -1) {
        if (this.stdoutBuffer.byteLength > MAX_READY_LINE_BYTES)
          throw new Error("MRT2 native-host startup line is too long");
        return;
      }
      const line = this.stdoutBuffer.subarray(0, newline).toString("utf8").replace(/\r$/u, "");
      this.readyProfile = parseReadyLine(line).runtimeProfile ?? null;
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      this.startupComplete = true;
    }
    this.consumeFrames();
    if (!this.ready && this.startupComplete) finishStartup(null);
  }

  consumeFrames() {
    while (this.stdoutBuffer.byteLength >= 4) {
      const frameLength = this.stdoutBuffer.readUInt32BE(0);
      if (frameLength < 3 || frameLength > MAX_CHILD_FRAME_BYTES)
        throw new Error("MRT2 native-host frame length is invalid");
      if (this.stdoutBuffer.byteLength < frameLength + 4) return;
      const body = this.stdoutBuffer.subarray(4, frameLength + 4);
      this.stdoutBuffer = this.stdoutBuffer.subarray(frameLength + 4);
      const type = body.readUInt8(0);
      const idLength = body.readUInt16BE(1);
      if (idLength < 1 || idLength > MAX_TRANSPORT_ID_BYTES || 3 + idLength > body.byteLength) {
        throw new Error("MRT2 native-host transport id is invalid");
      }
      const transportId = body.subarray(3, 3 + idLength).toString("utf8");
      if (!this.transportIds.has(transportId)) continue;
      const payload = body.subarray(3 + idLength);
      if (type === 0) {
        if (payload.byteLength > MAX_CONTROL_BYTES) throw new Error("MRT2 native-host control message is too large");
        let message;
        try {
          message = JSON.parse(payload.toString("utf8"));
        } catch {
          throw new Error("MRT2 native host emitted invalid control JSON");
        }
        if (!message || typeof message !== "object" || Array.isArray(message) || message.version !== 1) {
          throw new Error("MRT2 native host emitted an invalid control message");
        }
        this.emit("transport-event", { transportId, kind: "control", message });
      } else if (type === 1) {
        if (payload.byteLength > MAX_PACKET_BYTES) throw new Error("MRT2 native-host audio packet is too large");
        this.validateOutputPacket(payload);
        this.emit("transport-event", { transportId, kind: "audio", data: Uint8Array.from(payload) });
      } else if (type === 2) {
        if (payload.byteLength > 400) throw new Error("MRT2 native-host close reason is too large");
        this.transportIds.delete(transportId);
        const reason = payload.toString("utf8").slice(0, 400) || "MRT2 native transport closed";
        this.emit("transport-event", { transportId, kind: "closed", reason });
      } else {
        throw new Error("MRT2 native host emitted an unsupported frame type");
      }
    }
  }

  validateOutputPacket(packet) {
    if (packet.byteLength < 32 || packet.subarray(0, 8).toString("binary") !== "KYXMRT2\0") {
      throw new Error("MRT2 native host emitted an invalid audio packet");
    }
    if (packet.readUInt16LE(8) !== 1 || packet.readUInt8(10) !== 0) {
      throw new Error("MRT2 native host emitted an unsupported audio packet");
    }
    const channels = packet.readUInt8(11);
    const sampleRate = packet.readUInt32LE(12);
    const frames = packet.readUInt32LE(16);
    const dataBytes = packet.readUInt32LE(24);
    if (
      channels < 1 ||
      channels > 2 ||
      sampleRate < 1 ||
      sampleRate > 192_000 ||
      frames < 1 ||
      frames > 720_000 ||
      dataBytes !== frames * channels * 4 ||
      packet.byteLength !== 32 + dataBytes
    ) {
      throw new Error("MRT2 native host emitted an invalid audio packet shape");
    }
    for (let offset = 32; offset < packet.byteLength; offset += 4) {
      if (!Number.isFinite(packet.readFloatLE(offset))) throw new Error("MRT2 native host emitted non-finite PCM");
    }
  }

  onChildExit(child, reason) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
    this.startupComplete = false;
    this.stdoutBuffer = Buffer.alloc(0);
    this.readyProfile = null;
    this._startupFinish?.(new Error(reason));
    this._startupFinish = null;
    for (const transportId of this.transportIds) {
      this.emit("transport-event", { transportId, kind: "closed", reason });
    }
    this.transportIds.clear();
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) {
      this.ready = false;
      return Promise.resolve();
    }
    this.ready = false;
    for (const transportId of this.transportIds) {
      this.emit("transport-event", { transportId, kind: "closed", reason: "MRT2 native host stopped" });
    }
    this.transportIds.clear();
    try {
      child.stdin?.write(encodeFrame(3, "", Buffer.alloc(0)));
      child.stdin?.end();
    } catch {
      /* shutdown continues via signal */
    }
    this.stopPromise = new Promise((resolve) => {
      let settled = false;
      let killTimer;
      let terminateTimer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(terminateTimer);
        child.removeListener("exit", finish);
        if (this.child === child) this.child = null;
        this.stopPromise = null;
        resolve();
      };
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* process may already be gone */
        }
        finish();
      }, this.stopTimeoutMs);
      terminateTimer = setTimeout(
        () => {
          try {
            child.kill("SIGTERM");
          } catch {
            finish();
          }
        },
        Math.min(this.stopSignalTimeoutMs, this.stopTimeoutMs),
      );
      child.once("exit", finish);
    });
    return this.stopPromise;
  }

  attachChild(child) {
    child.stderr?.on("data", () => {
      // Deliberately do not forward process logs to the renderer.
    });
  }

  failHost(child, reason) {
    if (this.child !== child) return;
    this.ready = false;
    for (const transportId of this.transportIds) {
      this.emit("transport-event", { transportId, kind: "closed", reason });
    }
    this.transportIds.clear();
    try {
      child.kill("SIGTERM");
    } catch {
      /* process may already be gone */
    }
  }
}

module.exports = {
  Mrt2NativeHostManager,
  MAX_CONTROL_BYTES,
  MAX_PACKET_BYTES,
  encodeFrame,
  parseReadyLine,
  validateControlMessage,
  validateStylePacket,
};
