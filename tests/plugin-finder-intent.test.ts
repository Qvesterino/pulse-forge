import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePluginFinderIntent } from "../src/intent/pluginFinderIntent";
import { parseChaseIntent } from "../src/intent/chaseIntent";

const require = createRequire(import.meta.url);
const { listInstalledClapFiles, defaultScanDirectories, registerClapIpcHandlers } = require("../desktop/clap-host-manager.cjs") as {
  listInstalledClapFiles: (dirs?: string[]) => string[];
  defaultScanDirectories: (env?: Record<string, string | undefined>) => string[];
  registerClapIpcHandlers: (ipcMain: unknown, options?: Record<string, unknown>) => unknown;
};

/**
 * Plugin finder verb (ADR 0016 intent surface): "aké clapy mám?" —
 * detection is clap-stem-scoped, and the scan side enumerates the standard
 * CLAP directories flat (spec layout) with a bounded cap.
 */

describe("plugin finder detection", () => {
  it("detects clap questions in EN and SK", () => {
    expect(parsePluginFinderIntent("aké clapy mám?")).toEqual({ kind: "list-claps" });
    expect(parsePluginFinderIntent("ake clapy mam")).toEqual({ kind: "list-claps" });
    expect(parsePluginFinderIntent("what clap plugins do I have")).toEqual({ kind: "list-claps" });
    expect(parsePluginFinderIntent("scan my claps")).toEqual({ kind: "list-claps" });
    expect(parseChaseDisjoint()).toBe(true);
  });

  it("returns null for non-clap sentences", () => {
    expect(parsePluginFinderIntent("chase my timecode")).toBeNull();
    expect(parsePluginFinderIntent("make the bass deeper")).toBeNull();
    expect(parsePluginFinderIntent("")).toBeNull();
  });
});

// The chase verb is a sibling route — the finder must not swallow it.
function parseChaseDisjoint(): boolean {
  // imported lazily to keep this file's require surface small
  return parseChaseIntent("chase my timecode") !== null;
}

describe("CLAP directory enumeration (desktop scan tier 1)", () => {
  it("lists .clap files flat and skips missing directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clap-scan-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "clap-empty-"));
    try {
      fs.writeFileSync(path.join(root, "Tone.clap"), "MZ");
      fs.writeFileSync(path.join(root, "bass.clap"), "MZ");
      fs.writeFileSync(path.join(root, "readme.txt"), "not a plugin");
      fs.mkdirSync(path.join(root, "nested"));
      fs.writeFileSync(path.join(root, "nested", "deep.clap"), "MZ"); // flat scan: not listed

      const files = listInstalledClapFiles([root, other, path.join(root, "does-not-exist")]);
      expect(files).toHaveLength(2);
      expect(files.some((f) => f.toLowerCase().endsWith("tone.clap"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("derives the standard directories from the environment", () => {
    const dirs = defaultScanDirectories({
      COMMONPROGRAMFILES: "C:/Program Files/Common",
      LOCALAPPDATA: "C:/Users/x/AppData/Local",
    });
    expect(dirs).toEqual([
      path.join("C:/Program Files/Common", "CLAP"),
      path.join("C:/Users/x/AppData/Local", "Programs", "Common", "CLAP"),
    ]);
    expect(defaultScanDirectories({})).toEqual([]);
  });
});

describe("CLAP IPC registration (kyx:clap:scan)", () => {
  it("registers a handler that scans the given directories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clap-scan-"));
    fs.writeFileSync(path.join(root, "only.clap"), "MZ");
    try {
      const handlers = new Map<string, () => Promise<unknown>>();
      const fakeIpcMain = { handle: (channel: string, handler: () => Promise<unknown>) => handlers.set(channel, handler) };
      registerClapIpcHandlers(fakeIpcMain, {
        directories: [root],
        manager: {
          scanPaths: async (files: string[]) => ({ status: "ok", plugins: files.map((f) => ({ file: f })), counts: { ok: 1, notClap: 0, failed: 0 } }),
        },
      });
      expect(handlers.has("kyx:clap:scan")).toBe(true);
      const result = (await handlers.get("kyx:clap:scan")!()) as {
        status: string;
        plugins: Array<{ file: string }>;
        scannedDirectories: string[];
      };
      expect(result.status).toBe("ok");
      expect(result.plugins).toHaveLength(1);
      expect(result.scannedDirectories).toEqual([root]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a real ipcMain", () => {
    expect(() => registerClapIpcHandlers(undefined)).toThrow(/ipcMain is required/);
  });
});
