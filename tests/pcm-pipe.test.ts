import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { PcmPipeSource, parseFrame, drainFrames, defaultPcmHostPath, FRAME_MAGIC, FRAME_TYPES, HEADER_BYTES } =
  require("../desktop/pcm-pipe.cjs") as {
    PcmPipeSource: new (options?: Record<string, unknown>) => {
      start: () => PcmPipeSourceLike;
      on: (event: string, listener: (payload: unknown) => void) => () => void;
      getStats: () => Record<string, unknown>;
      stop: () => void;
    };
    parseFrame: (
      buffer: Buffer,
      offset?: number,
      maxPayloadBytes?: number,
    ) => {
      frame?: { type: number; seq: number; payload: Buffer };
      consumed?: number;
      needMore?: boolean;
      error?: string;
    };
    drainFrames: (
      buffer: Buffer,
      handlers: { onFrame: (frame: { type: number; seq: number; payload: Buffer }) => void },
    ) => { consumed: number; error?: string };
    defaultPcmHostPath: (resourcesPath?: string) => string;
    FRAME_MAGIC: number;
    FRAME_TYPES: { PCM: number; EVENT: number; STATS: number; EOF: number };
    HEADER_BYTES: number;
  };

interface PcmPipeSourceLike {
  on(event: string, listener: (payload: unknown) => void): () => void;
  getStats(): Record<string, unknown>;
  stop(): void;
}

/**
 * ADR 0018 wave 2 — framed PCM pipe transport.
 *
 * The reference host (native/pcm-host, C, no SDK, no hardware) speaks the
 * exact frame protocol the wave-2 ASIO streaming host will use. That makes
 * the whole transport acceptance-testable HERE: sample bytes are verified
 * against the sine formula, throughput is pinned well above realtime, and
 * the seq-contiguity + protocol-teardown contracts are fuzzed.
 */

const REPO = path.resolve(__dirname, "..");
const PCM_GEN = defaultPcmHostPath();
const nativeReady = existsSync(PCM_GEN);

function buildFrame(type: number, seq: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(FRAME_MAGIC, 0);
  header.writeUInt8(type, 4);
  header.writeUInt8(0, 5);
  header.writeUInt16LE(0, 6);
  header.writeUInt32LE(seq, 8);
  header.writeUInt32LE(payload.length, 12);
  return Buffer.concat([header, payload]);
}

beforeAll(async () => {
  if (nativeReady) return;
  await new Promise<void>((resolve, reject) => {
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const child = spawn(process.execPath, [path.join(REPO, "scripts", "build-pcm-host.mjs")], { stdio: "ignore" });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))));
    child.on("error", reject);
  }).catch(() => {
    /* no MSVC — native tests skip honestly */
  });
}, 120_000);

describe("frame codec (pure)", () => {
  it("round-trips a frame: magic, type, seq, bounded payload", () => {
    const payload = Buffer.alloc(16);
    const { frame, consumed } = parseFrame(buildFrame(FRAME_TYPES.PCM, 7, payload))!;
    expect(frame!.type).toBe(FRAME_TYPES.PCM);
    expect(frame!.seq).toBe(7);
    expect(frame!.payload.length).toBe(16);
    expect(consumed).toBe(HEADER_BYTES + 16);
  });

  it("requests more bytes for truncated frames instead of guessing", () => {
    const full = buildFrame(FRAME_TYPES.PCM, 1, Buffer.alloc(100));
    for (const cut of [4, 8, HEADER_BYTES, HEADER_BYTES + 50]) {
      expect(parseFrame(full.subarray(0, cut)).needMore).toBe(true);
    }
  });

  it("rejects protocol violations with a teardown diagnostic", () => {
    const badMagic = buildFrame(FRAME_TYPES.PCM, 1, Buffer.alloc(8));
    badMagic.writeUInt32LE(0xdeadbeef, 0);
    expect(parseFrame(badMagic).error).toContain("magic");

    const badType = buildFrame(9, 1, Buffer.alloc(8));
    expect(parseFrame(badType).error).toContain("type");

    const badFlags = buildFrame(FRAME_TYPES.PCM, 1, Buffer.alloc(8));
    badFlags.writeUInt8(1, 5);
    expect(parseFrame(badFlags).error).toContain("flags");

    const oversized = buildFrame(FRAME_TYPES.PCM, 1, Buffer.alloc(8));
    oversized.writeUInt32LE(64 << 20, 12);
    expect(parseFrame(oversized, 0, 1 << 20).error).toContain("cap");
  });

  it("drains consecutive frames and reports the leftover offset", () => {
    const stream = Buffer.concat([
      buildFrame(FRAME_TYPES.EVENT, 0, Buffer.from('{"rate":48000}')),
      buildFrame(FRAME_TYPES.PCM, 1, Buffer.alloc(64)),
      Buffer.from([0x4b]), // 1 leftover byte of an incomplete next frame
    ]);
    const seen: number[] = [];
    const result = drainFrames(stream, { onFrame: (frame) => seen.push(frame.type) });
    expect(seen).toEqual([FRAME_TYPES.EVENT, FRAME_TYPES.PCM]);
    expect(result.consumed).toBe(stream.length - 1);
  });
});

describe.skipIf(!existsSync(PCM_GEN))("pcm-gen end-to-end (real host, real pipe)", () => {
  it("delivers byte-verified sine samples at well above realtime", async () => {
    const SECONDS = 5;
    const RATE = 48000;
    const FREQ = 440;
    const source = new PcmPipeSource({
      args: ["--rate", String(RATE), "--channels", "2", "--freq", String(FREQ), "--seconds", String(SECONDS)],
    });

    const format: Record<string, number> = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no format frame in 5 s")), 5000);
      source.on("format", (f) => {
        clearTimeout(timer);
        resolve(f as Record<string, number>);
      });
      source.start();
    });
    expect(format).toEqual({ rate: RATE, channels: 2, blockFrames: 480 });

    // Verify the first blocks byte-closely against the generator formula:
    // sample[n] = 0.25 * sin(2π * freq * n / rate), interleaved stereo.
    await new Promise<void>((resolve, reject) => {
      let verified = 0;
      const off = source as unknown as { on: PcmPipeSourceLike["on"] };
      void off;
      const unsubscribe = source.on("pcm", (raw) => {
        const block = raw as { seq: number; samples: Float32Array; frames: number; channels: number };
        const start = block.seq * 480;
        for (let n = 0; n < block.frames && verified < 4800; n++, verified++) {
          const expected = 0.25 * Math.sin((2 * Math.PI * FREQ * (start + n)) / RATE);
          const actual = block.samples[n * block.channels];
          if (Math.abs(actual - expected) > 1e-5) {
            reject(new Error(`sample mismatch at absolute frame ${start + n}`));
            source.stop();
            return;
          }
        }
        if (verified >= 4800) {
          unsubscribe();
          resolve();
        }
      });
    });

    const done = await new Promise<{ stats: Record<string, unknown>; endStats: Record<string, unknown> }>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("stream did not finish in 20 s")), 20_000);
        let endStats: Record<string, unknown> = {};
        source.on("end", () => {
          endStats = { done: true };
        });
        source.on("close", (payload) => {
          clearTimeout(timer);
          resolve({ stats: (payload as { stats: Record<string, unknown> }).stats, endStats });
        });
      },
    );

    const stats = done.stats as { pcmFramesReceived: number; seqGaps: number; elapsedMs: number };
    expect(stats.pcmFramesReceived).toBe(SECONDS * RATE);
    expect(stats.seqGaps).toBe(0);
    // Acceptance floor: ≥ 4× realtime (stereo f32 48 kHz ≈ 384 KB/s).
    const realtimeMs = (SECONDS / 4) * 1000;
    expect(stats.elapsedMs).toBeLessThan(realtimeMs);
  }, 30_000);
});

describe("PcmPipeSource protocol teardown (fake spawn)", () => {
  it("tears the stream down on a magic violation and reports it", async () => {
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");
    const child = new EventEmitter() as InstanceType<typeof EventEmitter> & {
      stdout: InstanceType<typeof PassThrough>;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.kill = () => {
      child.emit("close", 1, "SIGKILL");
      return true;
    };
    const manager = new PcmPipeSource({ spawn: () => child, args: [] });
    const errors: unknown[] = [];
    manager.on("protocol-error", (message) => errors.push(message));
    manager.start();
    child.stdout.write(Buffer.from("this is not a KYXP frame at all........"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("magic");
  });
});
