import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { Mrt2NativeHostManager, encodeFrame, parseReadyLine } = require("../desktop/mrt2-host-manager.cjs") as {
  Mrt2NativeHostManager: new (options?: Record<string, unknown>) => {
    start: () => Promise<{ ready: true }>;
    stop: () => Promise<void>;
    isReady: () => boolean;
    openTransport: () => string;
    sendControl: (transportId: string, message: Record<string, unknown>) => void;
    sendBinary: (transportId: string, packet: ArrayBuffer) => void;
    closeTransport: (transportId: string) => void;
    on: (event: string, listener: (event: Record<string, unknown>) => void) => void;
  };
  encodeFrame: (type: number, transportId: string, payload?: Buffer) => Buffer;
  parseReadyLine: (line: string) => { version: number; type: string; providerId: string; modelId: string };
};

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  writes: Buffer[] = [];
  stdin = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      this.writes.push(Buffer.from(chunk));
      callback();
    },
  });
  killedWith: string | null = null;

  constructor() {
    super();
    this.stdin.on("finish", () => queueMicrotask(() => this.emit("exit", 0, null)));
  }

  kill(signal: string): boolean {
    this.killedWith = signal;
    queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }
}

function fixture(options: Record<string, unknown> = {}) {
  const resourcesPath = "C:/KYX/resources";
  const homeDirectory = "C:/Users/producer";
  const modelRoot = path.join(homeDirectory, "Documents", "Magenta", "magenta-rt-v2");
  const executable = path.join(resourcesPath, "mrt2-host", "kyx-mrt2-host");
  const present = new Set([
    executable,
    path.join(modelRoot, "resources", "musiccoca"),
    path.join(modelRoot, "models", "mrt2_small", "mrt2_small.mlxfn"),
  ]);
  const child = new FakeChild();
  const spawn = vi.fn(() => child);
  const manager = new Mrt2NativeHostManager({
    platform: "darwin",
    arch: "arm64",
    appIsPackaged: true,
    resourcesPath,
    homeDirectory,
    fileExists: (filePath: string) => present.has(filePath),
    lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    assertExecutable: () => undefined,
    spawn,
    startTimeoutMs: 2_000,
    ...options,
  });
  return { manager, child, spawn, executable, modelRoot, present };
}

const READY = JSON.stringify({ version: 1, type: "ready", providerId: "mrt2", modelId: "mrt2_small" });

function audioPacket(kind: "input" | "output"): ArrayBuffer {
  const packet = new ArrayBuffer(40);
  const bytes = new Uint8Array(packet);
  bytes.set(new TextEncoder().encode("KYXMRT2\0"), 0);
  const view = new DataView(packet);
  view.setUint16(8, 1, true);
  view.setUint8(10, kind === "output" ? 0 : 1);
  view.setUint8(11, 2);
  view.setUint32(12, 48_000, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 0, true);
  view.setUint32(24, 8, true);
  view.setFloat32(32, 0.25, true);
  view.setFloat32(36, -0.25, true);
  return packet;
}

function emitFrame(child: FakeChild, frame: Buffer): void {
  child.stdout.write(frame);
}

function decodeFrame(frame: Buffer): { type: number; transportId: string; payload: Buffer } {
  const body = frame.subarray(4);
  const idLength = body.readUInt16BE(1);
  return {
    type: body.readUInt8(0),
    transportId: body.subarray(3, 3 + idLength).toString("utf8"),
    payload: body.subarray(3 + idLength),
  };
}

describe("Electron MRT2 native host lifecycle and framed transport", () => {
  it("launches only the fixed packaged helper and standard model root", async () => {
    const { manager, child, spawn, executable, modelRoot } = fixture();
    const starting = manager.start();
    expect(spawn).toHaveBeenCalledWith(
      executable,
      ["--model-root", modelRoot],
      expect.objectContaining({ shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], cwd: modelRoot }),
    );
    child.stdout.write(`${READY}\n`);
    await expect(starting).resolves.toEqual({ ready: true });
    expect(manager.isReady()).toBe(true);
    await manager.stop();
    expect(manager.isReady()).toBe(false);
  });

  it("coalesces concurrent starts into one helper process", async () => {
    const { manager, child, spawn } = fixture();
    const first = manager.start();
    const second = manager.start();
    child.stdout.write(`${READY}\n`);
    await expect(Promise.all([first, second])).resolves.toEqual([{ ready: true }, { ready: true }]);
    expect(spawn).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("accepts only the exact MRT2 Small ready handshake", () => {
    expect(parseReadyLine(READY)).toMatchObject({ providerId: "mrt2", modelId: "mrt2_small" });
    expect(() =>
      parseReadyLine(JSON.stringify({ version: 1, type: "ready", providerId: "other", modelId: "mrt2_small" })),
    ).toThrow(/incompatible/u);
    expect(() => parseReadyLine("not json")).toThrow(/JSON/u);
  });

  it("does not declare readiness before parsing frames buffered with the startup line", async () => {
    const { manager, child } = fixture();
    const starting = manager.start();
    const malformedFrame = Buffer.from([0, 0, 0, 3, 0, 0, 0]);
    child.stdout.write(Buffer.concat([Buffer.from(`${READY}\n`), malformedFrame]));
    await expect(starting).rejects.toThrow(/transport id/u);
    expect(manager.isReady()).toBe(false);
    await manager.stop();
  });

  it("routes control and output audio frames only to an open transport", async () => {
    const { manager, child } = fixture();
    const starting = manager.start();
    child.stdout.write(`${READY}\n`);
    await starting;
    const transportId = manager.openTransport();
    const events: Record<string, unknown>[] = [];
    manager.on("transport-event", (event) => events.push(event));
    const control = Buffer.from(JSON.stringify({ version: 1, type: "status", state: "running" }));
    emitFrame(child, encodeFrame(0, transportId, control));
    emitFrame(child, encodeFrame(1, transportId, Buffer.from(audioPacket("output"))));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ transportId, kind: "control", message: { type: "status" } });
    expect(events[1]).toMatchObject({ transportId, kind: "audio" });
    expect((events[1]?.data as Uint8Array).byteLength).toBe(40);
    await manager.stop();
  });

  it("writes bounded control and style packets using framed stdin", async () => {
    const { manager, child } = fixture();
    const starting = manager.start();
    child.stdout.write(`${READY}\n`);
    await starting;
    const transportId = manager.openTransport();
    manager.sendControl(transportId, {
      version: 1,
      type: "hello",
      requestId: "hello-1",
      client: "kyx",
    });
    manager.sendBinary(transportId, audioPacket("input"));
    const frames = child.writes.map(decodeFrame);
    expect(frames[0]).toMatchObject({
      type: 0,
      transportId,
      payload: Buffer.from(JSON.stringify({ version: 1, type: "hello", requestId: "hello-1", client: "kyx" })),
    });
    expect(frames[1]).toMatchObject({ type: 1, transportId });
    expect(() => manager.sendControl(transportId, { version: 1, type: "stop", requestId: "bad" })).toThrow(
      /not allowed/u,
    );
    expect(() => manager.sendBinary(transportId, audioPacket("output"))).toThrow(/Only MRT2 style/u);
    await manager.stop();
  });

  it("rejects unsupported platforms, missing assets, and symlink helpers", async () => {
    const spawn = vi.fn();
    const windows = new (
      Mrt2NativeHostManager as new (opts: Record<string, unknown>) => { start: () => Promise<unknown> }
    )({
      platform: "win32",
      arch: "x64",
      spawn,
    });
    expect(() => windows.start()).toThrow(/Apple Silicon/u);
    const missing = fixture({ fileExists: () => false });
    expect(() => missing.manager.start()).toThrow(/model resources/u);
    const symlink = fixture({ lstat: () => ({ isFile: () => true, isSymbolicLink: () => true }) });
    expect(() => symlink.manager.start()).toThrow(/regular file/u);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("closes every active transport when the helper exits unexpectedly", async () => {
    const { manager, child } = fixture();
    const starting = manager.start();
    child.stdout.write(`${READY}\n`);
    await starting;
    const transportId = manager.openTransport();
    const events: Record<string, unknown>[] = [];
    manager.on("transport-event", (event) => events.push(event));
    child.emit("exit", 1, null);
    expect(manager.isReady()).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ transportId, kind: "closed" }));
  });

  it("closes transports and terminates the helper on explicit stop", async () => {
    const { manager, child } = fixture();
    const starting = manager.start();
    child.stdout.write(`${READY}\n`);
    await starting;
    const transportId = manager.openTransport();
    const events: Record<string, unknown>[] = [];
    manager.on("transport-event", (event) => events.push(event));
    await manager.stop();
    expect(child.killedWith).toBeNull();
    expect(events).toContainEqual(expect.objectContaining({ transportId, kind: "closed" }));
    expect(manager.isReady()).toBe(false);
  });
});
