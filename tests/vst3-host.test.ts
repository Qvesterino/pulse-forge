import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const { Vst3ProbeManager, validateModuleDescriptor, defaultScanDirectories } =
  require("../desktop/vst3-host-manager.cjs") as {
    Vst3ProbeManager: new (options?: Record<string, unknown>) => {
      probeEntry: (entryPath: string) => Promise<Record<string, unknown>>;
      scanEntries: (entries: string[]) => Promise<Record<string, unknown>>;
    };
    validateModuleDescriptor: (value: unknown) => Record<string, unknown> | null;
    defaultScanDirectories: (env?: Record<string, string | undefined>) => string[];
  };

/**
 * VST3 probe manager Wave 1 (ADR 0035) — structural scan of .vst3 entries.
 *
 * All tests drive the manager through a FAKE spawn (no MSVC toolchain
 * needed): the fake child writes canned JSON lines to stdout, ends the
 * stream, and then emits "close" — mirroring the real probe's contract
 * (JSON lines, then exit code). The manager's own logic is what's under
 * test: strict module validation, bounded IO, timeout kill, classification
 * by exit code, aggregation.
 *
 * Native-gated tests (real exe) skip when the toolchain hasn't built
 * npm run build:vst3-probe.
 */

const MODULE_LINE = JSON.stringify({
  path: "C:\\VST3\\X.vst3\\Contents\\x86_64-win\\X.vst3",
  arch: "x86_64-win",
  bytes: 1234,
});

/** Fake child: replays scripted stdout/exit behavior (clap test pattern —
 *  everything async so the manager's listeners attach first). */
function fakeChild(lines: string[], exitCode: number) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: vi.fn(),
  });
  setImmediate(() => {
    for (const line of lines) stdout.write(line + "\n");
    child.emit("close", exitCode, null);
  });
  return child;
}

function makeManager(lines: string[], exitCode: number, spawn?: unknown) {
  return new Vst3ProbeManager({
    spawn: spawn ?? (() => fakeChild(lines, exitCode)),
    timeoutMs: 5000,
  });
}

describe("validateModuleDescriptor", () => {
  it("accepts a bounded module with arch and optional bytes", () => {
    const ok = validateModuleDescriptor({
      path: "C:\\VST3\\Serum.vst3\\Contents\\x86_64-win\\Serum.vst3",
      arch: "x86_64-win",
      bytes: 123,
    });
    expect(ok).not.toBeNull();
    expect(ok!["arch"]).toBe("x86_64-win");
    expect(ok!["bytes"]).toBe(123);
  });

  it("rejects unbounded strings, unknown arch values are kept bounded but present, non-objects", () => {
    expect(validateModuleDescriptor({ path: "x".repeat(3000), arch: "x86_64-win" })).toBeNull();
    expect(
      validateModuleDescriptor({ path: "p", arch: "x86_64-win", bytes: Number.MAX_SAFE_INTEGER + 1 }),
    ).not.toBeNull();
    expect(validateModuleDescriptor(null)).toBeNull();
    expect(validateModuleDescriptor("n-0")).toBeNull();
    expect(validateModuleDescriptor(42)).toBeNull();
  });
});

describe("Vst3ProbeManager classification", () => {
  it("exit 0 + module lines → ok with validated modules", async () => {
    const m = makeManager(
      [
        MODULE_LINE,
        JSON.stringify({ path: "C:\\VST3\\X.vst3\\Contents\\arm64-win\\X.vst3", arch: "arm64-win", bytes: 12 }),
      ],
      0,
    );
    const result = (await m.probeEntry("C:\\VST3\\X.vst3")) as { status: string; modules: Array<{ arch: string }> };
    expect(result.status).toBe("ok");
    expect(result.modules).toHaveLength(2);
    expect(result.modules[0]!.arch).toBe("x86_64-win");
  });

  it("exit 2 → not-vst3", async () => {
    const m = makeManager([], 2);
    const result = await m.probeEntry("C:\\not\\a\\bundle");
    expect(result["status"]).toBe("not-vst3");
  });

  it("nonzero non-2 exit → crashed with exitCode", async () => {
    const m = makeManager([], 70);
    const result = await m.probeEntry("C:\\VST3\\X.vst3");
    expect(result["status"]).toBe("crashed");
    expect(result["exitCode"]).toBe(70);
  });

  it("malformed JSON lines count as malformed; valid ones still parse", async () => {
    const m = makeManager(["{not json", MODULE_LINE, ""], 0);
    const result = (await m.probeEntry("C:\\VST3\\X.vst3")) as {
      status: string;
      modules: unknown[];
      malformed: number;
    };
    expect(result.status).toBe("ok");
    expect(result.modules).toHaveLength(1);
    expect(result.malformed).toBe(1);
  });

  it("a probe line beyond MAX_LINE_BYTES is rejected as malformed - a flood is not trusted", async () => {
    const overlong = MODULE_LINE + " " + "A".repeat(2 * 8192);
    const m = makeManager([MODULE_LINE, overlong], 0);
    const result = (await m.probeEntry("C:\VST3\X.vst3")) as {
      status: string;
      modules: unknown[];
      malformed: number;
    };
    expect(result.status).toBe("ok");
    expect(result.modules).toHaveLength(1);
    expect(result.malformed).toBe(1);
  });

  it("unbounded path argument → error classification without spawning", async () => {
    const spawned: unknown[] = [];
    const m = makeManager([], 0, () => {
      spawned.push(1);
      return fakeChild([], 0);
    });
    const result = await m.probeEntry("x".repeat(3000));
    expect(result["status"]).toBe("error");
    expect(spawned).toHaveLength(0);
  });
});

describe("scanEntries aggregation", () => {
  it("aggregates ok/not-vst3/crashed across entries with module collection", async () => {
    const responses: Array<{ lines: string[]; code: number }> = [
      { lines: [MODULE_LINE], code: 0 },
      { lines: [], code: 2 },
      { lines: [MODULE_LINE], code: 0 },
    ];
    let call = 0;
    const m = new Vst3ProbeManager({
      spawn: () => {
        const r = responses[Math.min(call, responses.length - 1)]!;
        call += 1;
        return fakeChild(r.lines, r.code);
      },
      timeoutMs: 5000,
    });
    const result = (await m.scanEntries(["a", "b", "c"])) as {
      scanned: number;
      counts: { ok: number; notVst3: number; failed: number };
      modules: unknown[];
    };
    expect(result.scanned).toBe(3);
    expect(result.counts).toEqual({ ok: 2, notVst3: 1, failed: 0 });
    expect(result.modules).toHaveLength(2);
  });

  it("unbounded entry array → error classification", async () => {
    const m = makeManager([], 0);
    const result = await m.scanEntries(new Array(5000).fill("x"));
    expect(result["status"]).toBe("error");
  });
});

describe("standard directories (environment mapping)", () => {
  it("maps Common Files and AppData VST3 folders", () => {
    // The expected paths are built with path.join, like the CLAP sibling
    // spec: the manager joins with the PLATFORM separator, so a hardcoded
    // "C:\\..." literal is only correct on Windows — on Linux the join
    // produces forward slashes and the assertion failed there (measured
    // 2026-10-28: red on CI, green on the dev machine).
    const dirs = defaultScanDirectories({
      CommonProgramFiles: "C:/Program Files/Common Files",
      APPDATA: "C:/Users/x/AppData/Roaming",
      ProgramFiles: "C:/Program Files",
    });
    expect(dirs).toContain(path.join("C:/Program Files/Common Files", "VST3"));
    expect(dirs).toContain(path.join("C:/Users/x/AppData/Roaming", "Programs", "Common", "VST3"));
  });

  it("missing environment variables yield no directories (no throw)", () => {
    expect(defaultScanDirectories({})).toEqual([]);
  });
});
