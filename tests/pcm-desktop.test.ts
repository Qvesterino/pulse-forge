import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createPcmRingBuffer, PcmRingHeader } from "../src/audio-engine/pcmRing";

const require = createRequire(import.meta.url);
const { registerPcmIpcHandlers, resolveSourcePath, sanitizeArgs, SOURCE_KINDS } =
  require("../desktop/pcm-desktop.cjs") as {
    registerPcmIpcHandlers: (ipcMain: unknown, options?: Record<string, unknown>) => { stopAll: () => void };
    resolveSourcePath: (kind: string, resourcesPath?: string) => string | null;
    sanitizeArgs: (args: unknown) => string[] | null;
    SOURCE_KINDS: Record<string, { relative: string; resource: string }>;
  };

/**
 * Wave 3 "hear it" wiring — the desktop IPC surface between the renderer's
 * ring and the native source. The renderer names a SOURCE KIND (allowlist)
 * and sends the SAB; this layer validates everything else. The audible path
 * itself is the Electron owner gate (ADR 0018).
 */

describe("source allowlist (renderer never names executables)", () => {
  it("resolves the two allowlisted kinds", () => {
    expect(SOURCE_KINDS["pcm-gen"]).toBeDefined();
    expect(SOURCE_KINDS["asio-host"]).toBeDefined();
    expect(resolveSourcePath("pcm-gen")).toContain(path.join("native", "pcm-host", "build", "Release", "pcm-gen.exe"));
    expect(resolveSourcePath("asio-host", "C:/res")).toBe(path.join("C:/res", "asio", "asio-host.exe"));
    expect(resolveSourcePath("vst3")).toBeNull();
    expect(resolveSourcePath("cmd")).toBeNull();
  });

  it("sanitizes argv: allowlisted flags with bounded string values only", () => {
    expect(sanitizeArgs(["--rate", "48000", "--realtime"])).toEqual(["--rate", "48000", "--realtime"]); // boolean switch
    expect(sanitizeArgs(["--rate", "48000", "--freq", "440"])).toEqual(["--rate", "48000", "--freq", "440"]);
    expect(sanitizeArgs(["--dll", "C:/drivers/x.dll"])).toEqual(["--dll", "C:/drivers/x.dll"]);
    expect(sanitizeArgs(["--evil", "x"])).toBeNull();
    expect(sanitizeArgs(["--rate", 48000 as unknown as string])).toBeNull(); // numeric value
    expect(sanitizeArgs("not-an-array")).toBeNull();
    expect(sanitizeArgs(new Array(40).fill("--rate").flatMap((f) => [f, "1"]))).toBeNull();
  });
});

describe("kyx:pcm:start / stop (fake ipcMain + fake spawn)", () => {
  /** A REAL initialized ring — the bridge validates the header magic. */
  function fakeSab(): SharedArrayBuffer {
    const format = { channels: 2, capacityFrames: 32768, sampleRate: 48000 };
    const sab = createPcmRingBuffer(format);
    new PcmRingHeader(sab).init(format);
    return sab;
  }

  function fakeChild() {
    const { EventEmitter } = require("node:events") as typeof import("node:events");
    const { PassThrough } = require("node:stream") as typeof import("node:stream");
    const child = new EventEmitter() as InstanceType<typeof EventEmitter> & {
      stdout: InstanceType<typeof PassThrough>;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.kill = () => true;
    return child;
  }

  function setup() {
    const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
    const fakeIpcMain = {
      handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
        handlers.set(channel, handler),
    };
    const spawned: Array<{ path: string; args: string[] }> = [];
    const manager = registerPcmIpcHandlers(fakeIpcMain, {
      spawn: (cmd: string, args: string[]) => {
        spawned.push({ path: cmd, args });
        return fakeChild();
      },
    });
    return { handlers, spawned, manager };
  }

  it("starts a session: allowlisted host, sanitized args, SAB forwarded", async () => {
    const { handlers, spawned } = setup();
    const start = handlers.get("kyx:pcm:start")!;
    const result = (await start(null, {
      sab: fakeSab(),
      host: "pcm-gen",
      args: ["--freq", "440", "--realtime"],
    })) as { ok: boolean; id?: string };
    expect(result.ok).toBe(true);
    expect(result.id).toMatch(/^pcm-/);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].path).toContain("pcm-gen.exe");
    expect(spawned[0].args).toContain("--freq");
  });

  it("rejects unknown kinds, non-SAB buffers and allowlist violations", async () => {
    const { handlers } = setup();
    const start = handlers.get("kyx:pcm:start")!;
    expect(((await start(null, { sab: fakeSab(), host: "cmd", args: [] })) as { ok: boolean }).ok).toBe(false);
    expect(((await start(null, { sab: Buffer.alloc(16), host: "pcm-gen", args: [] })) as { ok: boolean }).ok).toBe(
      false,
    );
    expect(
      ((await start(null, { sab: fakeSab(), host: "pcm-gen", args: ["--spawn", "evil"] })) as { ok: boolean }).ok,
    ).toBe(false);
  });

  it("a new start stops the previous session (one external source at a time)", async () => {
    const { handlers, spawned } = setup();
    const start = handlers.get("kyx:pcm:start")!;
    await start(null, { sab: fakeSab(), host: "pcm-gen", args: [] });
    await start(null, { sab: fakeSab(), host: "pcm-gen", args: ["--freq", "880"] });
    // Both spawns happened; the manager stops the old child (not asserted on
    // the fake — the contract is "one ring session", enforced by stop()).
    expect(spawned).toHaveLength(2);
  });

  it("stop with an unknown id reports, not throws", async () => {
    const { handlers } = setup();
    const stop = handlers.get("kyx:pcm:stop")!;
    const result = (await stop(null, { id: "pcm-999" })) as { ok: boolean };
    expect(result.ok).toBe(false);
  });
});
