import { describe, it, expect, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_TOOLS } from "../src/mcp/tools";
import { startMcpDesktopHost, type DesktopMcpApi } from "../src/mcp/desktop-host";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import type { Services } from "../src/services";

/**
 * DESKTOP MCP (Phase D2) — the real CommonJS transport artifacts under
 * desktop/ are loaded NATIVELY (createRequire) and exercised over real
 * HTTP/stdio: the loopback bridge, the stdio forwarder subprocess, and the
 * host manager's IPC + pending-call lifecycle.
 */

const require_ = createRequire(import.meta.url);
const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../desktop");

interface BridgeModule {
  createMcpBridgeServer(options: {
    token: string;
    port?: number;
    executeTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  }): {
    server: http.Server;
    setExecutor(next: (name: string, args: Record<string, unknown>) => Promise<unknown>): void;
  };
  MCP_TOOL_DEFS: Array<{ name: string; description: string; inputSchema: unknown; outputSchema?: unknown }>;
}
interface ManagerLike {
  enable(preferredPort?: number): Promise<{ enabled: boolean; bridgeUrl: string | null; token: string | null }>;
  disable(): Promise<void>;
  readonly status: {
    enabled: boolean;
    running: boolean;
    bridgeUrl: string | null;
    token: string | null;
    clientConfig: { command: string; args: string[]; env: Record<string, string> } | null;
  };
  forwardCall: (call: { id?: string; name: string; args?: unknown }) => Promise<unknown>;
  resolveCall(payload: { id: string; result?: unknown }): boolean;
  readonly pendingCalls: Map<string, unknown>;
}
interface ManagerModule {
  McpHostManager: new (options?: Record<string, unknown>) => ManagerLike;
  registerMcpIpcHandlers(
    ipcMain: { handle(name: string, fn: (...args: unknown[]) => unknown): void },
    options?: Record<string, unknown>,
  ): { manager: ManagerLike };
  generateToken(): string;
  tokenMatches(a: unknown, b: unknown): boolean;
}

const bridgeModule = require_(path.join(DESKTOP_DIR, "mcp-bridge-server.cjs")) as BridgeModule;
const managerModule = require_(path.join(DESKTOP_DIR, "mcp-host-manager.cjs")) as ManagerModule;

function post(
  port: number,
  body: string,
  options: { method?: string; token?: string; path?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    const req = http.request(
      { host: "127.0.0.1", port, method: options.method ?? "POST", path: options.path ?? "/rpc", headers },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(options.method === "POST" || options.method === undefined ? body : undefined);
  });
}

async function listenOnEphemeralPort(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no ephemeral port");
  return address.port;
}

const runningServers: http.Server[] = [];
const runningProcesses: Array<{ kill(): void }> = [];
afterEach(() => {
  while (runningProcesses.length > 0) runningProcesses.pop()?.kill();
  for (const server of runningServers.splice(0)) server.close();
});

describe("desktop mcp tool defs — mirror pin", () => {
  it("MCP_TOOL_DEFS mirrors src/mcp/tools.ts MCP_TOOLS exactly (names, descriptions, schemas, annotations)", () => {
    expect(bridgeModule.MCP_TOOL_DEFS).toEqual(
      MCP_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema != null ? { outputSchema: tool.outputSchema } : {}),
        ...(tool.annotations != null ? { annotations: tool.annotations } : {}),
      })),
    );
  });
});

describe("desktop mcp bridge server (real HTTP)", () => {
  it("initialize / ping / tools-list answer over the loopback with the shared token", async () => {
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async () => ({ text: "unused" }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const init = await post(port, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), {
      token: "tok",
    });
    expect(init.status).toBe(200);
    const initBody = JSON.parse(init.body) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(initBody.result.protocolVersion).toBe("2026-07-28");
    expect(initBody.result.serverInfo.name).toBe("kyx-mcp-bridge");

    const ping = await post(port, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }), { token: "tok" });
    expect(JSON.parse(ping.body)).toEqual({ jsonrpc: "2.0", id: 2, result: {} });

    const list = await post(port, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }), { token: "tok" });
    const tools = (JSON.parse(list.body) as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name));
  });

  it("tools/call wraps the executor result; a thrown error becomes isError content", async () => {
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async (name, args) => {
        if (name === "kyx_state") throw new Error("honest failure");
        return { text: `ran:${name}:${JSON.stringify(args)}`, mutated: true };
      },
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const ok = await post(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "kyx_intent", arguments: { a: 1 } },
      }),
      { token: "tok" },
    );
    const okBody = JSON.parse(ok.body) as {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    expect(okBody.result.isError).toBeUndefined();
    expect(okBody.result.content[0]?.text).toBe('ran:kyx_intent:{"a":1}');

    const bad = await post(
      port,
      JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "kyx_state", arguments: {} } }),
      { token: "tok" },
    );
    const badBody = JSON.parse(bad.body) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(badBody.result.isError).toBe(true);
    expect(badBody.result.content[0]?.text).toBe("honest failure");
  });

  it("exposes machine-readable error codes in MCP text content", async () => {
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async () => ({
        text: "choose a fresh requestId",
        mutated: false,
        isError: true,
        errorCode: "REQUEST_ID_CONFLICT",
      }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const response = await post(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 61,
        method: "tools/call",
        params: { name: "kyx_groove", arguments: { direction: "more", requestId: "same" } },
      }),
      { token: "tok" },
    );
    const result = (JSON.parse(response.body) as { result: { content: Array<{ text: string }>; isError: boolean } })
      .result;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("REQUEST_ID_CONFLICT: choose a fresh requestId");
  });

  it("renderer host passes the complete result envelope through its IPC answer", async () => {
    const previous = Object.getOwnPropertyDescriptor(window, "kyxDesktop");
    let onCall: Parameters<DesktopMcpApi["onCall"]>[0] | null = null;
    let resolveAnswer!: (payload: Parameters<DesktopMcpApi["answer"]>[0]) => void;
    const answer = new Promise<Parameters<DesktopMcpApi["answer"]>[0]>((resolve) => {
      resolveAnswer = resolve;
    });
    const api: DesktopMcpApi = {
      status: async () => ({
        enabled: true,
        running: true,
        bridgeUrl: "http://127.0.0.1",
        token: "t",
        clientConfig: null,
      }),
      enable: async () => undefined,
      disable: async () => undefined,
      onCall: (listener) => {
        onCall = listener;
        return () => {};
      },
      answer: async (payload) => resolveAnswer(payload),
    };
    Object.defineProperty(window, "kyxDesktop", {
      configurable: true,
      value: { isDesktop: true, mcp: api },
    });
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const services = {
      store,
      transport: {
        play: () => {},
        stop: () => {},
        pause: () => {},
        setLoop: () => {},
        setMetronome: () => {},
      },
    } as unknown as Services;

    const unbind = startMcpDesktopHost(services);
    try {
      expect(onCall).toBeTypeOf("function");
      onCall!({
        id: "host-structured",
        name: "kyx_batch",
        args: {
          calls: [{ tool: "kyx_markers", args: { op: "add", bar: 2, name: "ipc-result" } }],
        },
      });
      const response = await answer;
      expect(response.result.data).toMatchObject({ mutations: 1 });
      expect(response.result.docId).toBe(store.getDoc().id);
      expect(response.result.mutated).toBe(true);
    } finally {
      unbind();
      if (previous) Object.defineProperty(window, "kyxDesktop", previous);
      else delete (window as { kyxDesktop?: unknown }).kyxDesktop;
    }
  });

  it("returns standard MCP audio content blocks from the renderer executor", async () => {
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async () => ({
        text: "preview ready",
        mutated: false,
        audio: { data: "UklGRg==", mimeType: "audio/wav" },
        data: { bars: 1, durationSec: 2, sampleRate: 22050, byteLength: 44144, mimeType: "audio/wav" },
      }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const response = await post(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "kyx_audio_preview", arguments: { bars: 1 } },
      }),
      { token: "tok" },
    );
    const body = JSON.parse(response.body) as {
      result: { content: Array<Record<string, string>>; structuredContent: Record<string, unknown> };
    };
    expect(body.result.content).toEqual([
      { type: "text", text: "preview ready" },
      { type: "audio", data: "UklGRg==", mimeType: "audio/wav" },
    ]);
    expect(body.result.structuredContent).toEqual({
      bars: 1,
      durationSec: 2,
      sampleRate: 22050,
      byteLength: 44144,
      mimeType: "audio/wav",
    });
  });

  it("returns the blind A/B trial read-back as structuredContent over desktop HTTP", async () => {
    const data = {
      op: "record",
      status: "recorded",
      trial: {
        lane: "tilt-vs-flat",
        xWas: "A",
        answer: "B",
        correct: false,
        reactionMs: 2500,
        receivedAt: 1000,
      },
    };
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async () => ({ text: "trial recorded", mutated: false, data }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const response = await post(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "kyx_blind_ab", arguments: { op: "record", lane: "tilt-vs-flat", xWas: "A", answer: "B" } },
      }),
      { token: "tok" },
    );
    const body = JSON.parse(response.body) as {
      result: { isError?: boolean; content: Array<Record<string, string>>; structuredContent: Record<string, unknown> };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content).toEqual([{ type: "text", text: "trial recorded" }]);
    expect(body.result.structuredContent).toEqual(data);
  });

  it("returns mix plans as structuredContent over desktop HTTP", async () => {
    const data = {
      status: "planned",
      ok: true,
      applied: false,
      interpreter: "production",
      targets: ["drums"],
      goals: ["warmer"],
      label: "Warm the drums",
      steps: [{ trackId: "track-1", track: "Drums", device: "Tape Sat", params: "drive=0.2", reason: "warmth" }],
      warnings: [],
    };
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async () => ({ text: "Planned: Warm the drums", mutated: false, data }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const response = await post(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "kyx_mix_idea", arguments: { idea: "warm up the drums" } },
      }),
      { token: "tok" },
    );
    const body = JSON.parse(response.body) as {
      result: { isError?: boolean; content: Array<Record<string, string>>; structuredContent: Record<string, unknown> };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content).toEqual([{ type: "text", text: "Planned: Warm the drums" }]);
    expect(body.result.structuredContent).toEqual(data);
  });

  it("returns an applied mix profile as structuredContent over desktop HTTP", async () => {
    const data = {
      status: "applied",
      genre: "techno",
      decisionCount: 4,
      summary: ["tone: dark", "punch: more", "reverb: less", "pump: on"],
    };
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async () => ({ text: "mix applied (4 decisions)", mutated: true, data }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const response = await post(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "kyx_mix", arguments: { genre: "techno", energy: 0.8 } },
      }),
      { token: "tok" },
    );
    const body = JSON.parse(response.body) as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual(data);
  });

  it("returns created arrangement IDs as structuredContent over desktop HTTP", async () => {
    const data = {
      status: "arranged",
      genre: "house",
      sections: [{ label: "Intro", role: "intro", startBar: 1, bars: 4, intensity: 0.4 }],
      scenes: [{ id: "scene-1", name: "Intro", role: "intro", intensity: 0.4 }],
      clips: [{ id: "clip-1", sceneId: "scene-1", startBar: 0, lengthBars: 4 }],
      markers: [{ id: "marker-1", name: "Intro", type: "cue", tick: 0 }],
      sceneCount: 1,
      clipCount: 1,
      cueMarkerCount: 1,
      totalBars: 4,
      undoSteps: 1,
    };
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async () => ({ text: "arranged house: 1 scene, 1 clip, 1 cue marker", mutated: true, data }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const response = await post(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "kyx_arrange", arguments: { genre: "house" } },
      }),
      { token: "tok" },
    );
    const body = JSON.parse(response.body) as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual(data);
  });

  it("returns take-group inventory as structuredContent over desktop HTTP", async () => {
    const data = {
      status: "listed",
      groups: [
        {
          id: "take-group-1",
          trackId: "track-vocal-1",
          track: "Vocal",
          activeTakeId: "take-a",
          compTakeId: null,
          takes: [
            { takeId: "take-a", clipCount: 2 },
            { takeId: "take-b", clipCount: 1 },
          ],
        },
      ],
    };
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async () => ({ text: "take inventory", mutated: false, data }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const response = await post(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "kyx_takes", arguments: { op: "list" } },
      }),
      { token: "tok" },
    );
    const body = JSON.parse(response.body) as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual(data);
  });

  it("returns committed routing state as structuredContent over desktop HTTP", async () => {
    const data = {
      status: "send_set",
      returnId: "return-1",
      returnName: "Plate",
      trackIds: ["track-drums"],
      changedTrackIds: ["track-drums"],
      requestedLevel: 0.4,
      sendLevel: 0.4,
      undoSteps: 1,
    };
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async () => ({ text: "Drums → Plate 0.4 — one undo step", mutated: true, data }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const response = await post(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: {
          name: "kyx_routing",
          arguments: { op: "setSend", trackId: "track-drums", returnId: "return-1", level: 0.4 },
        },
      }),
      { token: "tok" },
    );
    const body = JSON.parse(response.body) as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual(data);
  });

  it("returns committed marker read-back as structuredContent over desktop HTTP", async () => {
    const data = {
      status: "created",
      markerId: "marker-1",
      name: "Drop",
      markerType: "cue",
      tick: 7680,
      bar: 5,
      undoSteps: 1,
    };
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async () => ({ text: 'created marker "Drop" (id=marker-1) at bar 5', mutated: true, data }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const response = await post(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: { name: "kyx_markers", arguments: { op: "add", bar: 5, name: "Drop" } },
      }),
      { token: "tok" },
    );
    const body = JSON.parse(response.body) as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual(data);
  });

  it("returns section read-back as structuredContent over desktop HTTP", async () => {
    const data = {
      status: "resized",
      sections: [],
      sectionId: "scene-1",
      name: "Intro",
      role: "intro",
      index: 1,
      startBar: 1,
      bars: 3,
      intensity: 0.4,
      clipCount: 1,
      undoSteps: 1,
    };
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async () => ({ text: 'resized "Intro" at bar 1, 3 bars (one undo step)', mutated: true, data }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const response = await post(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 15,
        method: "tools/call",
        params: { name: "kyx_sections", arguments: { op: "resize", sceneId: "scene-1", bars: 3 } },
      }),
      { token: "tok" },
    );
    const body = JSON.parse(response.body) as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual(data);
  });

  it("returns musical-state read-back as structuredContent over desktop HTTP", async () => {
    const data = { status: "set", op: "setTempo", bpm: 140, undoSteps: 1 };
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async () => ({ text: "tempo is now 140 BPM (one undo step)", mutated: true, data }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const response = await post(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 16,
        method: "tools/call",
        params: { name: "kyx_music", arguments: { op: "setTempo", bpm: 140 } },
      }),
      { token: "tok" },
    );
    const body = JSON.parse(response.body) as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual(data);
  });

  it("returns note IDs and verified note read-back as structuredContent over desktop HTTP", async () => {
    const data = {
      status: "listed",
      op: "list",
      trackId: "track-bass",
      trackName: "808",
      noteCount: 1,
      undoSteps: 0,
      offset: 0,
      limit: 40,
      notes: [
        {
          id: "note-1",
          index: 0,
          pitch: 33,
          noteName: "A1",
          startTicks: 0,
          startBeat: 0,
          durationTicks: 240,
          durationBeats: 0.5,
          velocity: 0.8,
        },
      ],
    };
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async () => ({ text: "listed 1 note", mutated: false, data }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const response = await post(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 17,
        method: "tools/call",
        params: { name: "kyx_notes", arguments: { op: "list", trackId: "track-bass" } },
      }),
      { token: "tok" },
    );
    const body = JSON.parse(response.body) as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual(data);
  });

  it("returns exact pad-step read-back as structuredContent over desktop HTTP", async () => {
    const data = {
      status: "changed",
      op: "add",
      family: "kick",
      patternId: "pattern-1",
      patternName: "Beat",
      stepCount: 16,
      targetPadCount: 1,
      pads: [{ padId: "pad-kick", padName: "Kick", beforeHitCount: 0, afterHitCount: 1 }],
      requestedSteps: [1],
      changedCellCount: 1,
      changedSteps: [1],
      changes: [{ padId: "pad-kick", padName: "Kick", step: 1, velocity: 0.8, probability: 1 }],
      beforeHitCount: 0,
      afterHitCount: 1,
      undoSteps: 1,
    };
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async () => ({ text: "kick add: 0 → 1 hits", mutated: true, data }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const response = await post(
      port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 18,
        method: "tools/call",
        params: { name: "kyx_steps", arguments: { op: "add", family: "kick", steps: [1] } },
      }),
      { token: "tok" },
    );
    const body = JSON.parse(response.body) as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual(data);
  });

  it("protocol completeness: version negotiation, instructions, resources, batch, unknown-tool -32602", async () => {
    const { server } = bridgeModule.createMcpBridgeServer({
      token: "tok",
      executeTool: async (name, args) => {
        // The hidden resource channel rides tools/call — the real renderer
        // answers through readMcpResource; the echo here pins the ROUTING.
        if (name === "__kyx_resource") return { text: `resource:${String((args as { uri?: string }).uri)}` };
        return { text: "ok", mutated: false };
      },
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    // negotiate: supported version echoes; unknown → our latest
    const init = await post(
      port,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
      { token: "tok" },
    );
    const initBody = JSON.parse(init.body) as {
      result: { protocolVersion: string; capabilities: Record<string, unknown>; instructions?: string };
    };
    expect(initBody.result.protocolVersion).toBe("2025-03-26");
    expect(initBody.result.capabilities.resources).toBeDefined();
    expect(initBody.result.instructions).toContain("deterministic command layer");
    const future = await post(
      port,
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2999-01-01" } }),
      { token: "tok" },
    );
    expect((JSON.parse(future.body) as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      "2026-07-28",
    );

    // resources/list advertises the mirror; unknown read → -32602
    const list = await post(port, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/list" }), {
      token: "tok",
    });
    const resources = (JSON.parse(list.body) as { result: { resources: Array<{ uri: string }> } }).result.resources;
    expect(resources.map((resource) => resource.uri)).toContain("kyx://project/overview");
    const unknownRead = await post(
      port,
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "kyx://nope" } }),
      { token: "tok" },
    );
    expect((JSON.parse(unknownRead.body) as { error: { code: number } }).error.code).toBe(-32602);

    // resources/read rides the hidden channel and returns contents[]
    const read = await post(
      port,
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "kyx://project/pattern" } }),
      { token: "tok" },
    );
    const readBody = JSON.parse(read.body) as { result: { contents: Array<{ uri: string; text: string }> } };
    expect(readBody.result.contents[0]?.uri).toBe("kyx://project/pattern");
    expect(readBody.result.contents[0]?.text).toBe("resource:kyx://project/pattern");

    // batch: two requests + one notification → two responses, in order
    const batch = await post(
      port,
      JSON.stringify([
        { jsonrpc: "2.0", id: 10, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 11, method: "tools/list" },
      ]),
      { token: "tok" },
    );
    const batchBody = JSON.parse(batch.body) as Array<{ id: number }>;
    expect(batchBody.map((entry) => entry.id)).toEqual([10, 11]);

    // unknown tool over tools/call is a PROTOCOL error (-32602), not content
    const unknownTool = await post(
      port,
      JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "boom", arguments: {} } }),
      { token: "tok" },
    );
    const unknownBody = JSON.parse(unknownTool.body) as { error?: { code: number }; result?: unknown };
    expect(unknownBody.error?.code).toBe(-32602);
    expect(unknownBody.result).toBeUndefined();
  });

  it("auth + transport guards: wrong token 401, GET 404, parse error 400, unknown method -32601, oversize 413", async () => {
    const { server } = bridgeModule.createMcpBridgeServer({ token: "tok", executeTool: async () => ({ text: "" }) });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    expect((await post(port, "{}", { token: "wrong" })).status).toBe(401);
    expect((await post(port, "{}", {})).status).toBe(401);
    expect((await post(port, "{}", { method: "GET", token: "tok", path: "/rpc" })).status).toBe(404);
    expect((await post(port, "{}", { token: "tok", path: "/nope" })).status).toBe(404);

    const parse = await post(port, "not-json", { token: "tok" });
    expect(parse.status).toBe(400);
    expect((JSON.parse(parse.body) as { error: { code: number } }).error.code).toBe(-32700);

    const unknown = await post(port, JSON.stringify({ jsonrpc: "2.0", id: 9, method: "nope/method" }), {
      token: "tok",
    });
    expect((JSON.parse(unknown.body) as { error: { code: number } }).error.code).toBe(-32601);

    const oversized = await post(
      port,
      JSON.stringify({ jsonrpc: "2.0", id: 10, method: "ping" }) + "x".repeat(1_100_000),
      {
        token: "tok",
      },
    );
    expect(oversized.status).toBe(413);
  }, 15_000);
});

describe("mcp host manager", () => {
  it("token helpers: generateToken is hex, tokenMatches is constant-shape equality", () => {
    const token = managerModule.generateToken();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(managerModule.tokenMatches(token, token)).toBe(true);
    expect(managerModule.tokenMatches(token, `${token}x`)).toBe(false);
    expect(managerModule.tokenMatches("", "")).toBe(true);
  });

  it("enable → status exposes clientConfig; disable tears the bridge down", async () => {
    const manager = new managerModule.McpHostManager();
    expect(manager.status.enabled).toBe(false);

    await manager.enable(0);
    expect(manager.status.enabled).toBe(true);
    expect(manager.status.bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/rpc$/);
    expect(manager.status.token).toMatch(/^[0-9a-f]{48}$/);
    expect(manager.status.clientConfig?.command).toBe(process.execPath);
    expect(manager.status.clientConfig?.env.KYX_MCP_TOKEN).toBe(manager.status.token);
    // The desktop exe must run the stdio forwarder AS node (packaged KYX.exe
    // would otherwise boot the whole app instead of speaking JSON-RPC).
    expect(manager.status.clientConfig?.env.ELECTRON_RUN_AS_NODE).toBe("1");

    await manager.disable();
    expect(manager.status.enabled).toBe(false);
    expect(manager.status.bridgeUrl).toBeNull();
    expect(manager.status.token).toBeNull();
    expect(manager.status.clientConfig).toBeNull();
  });

  it("forwardCall + resolveCall round-trip through pendingCalls (the IPC answer path)", async () => {
    const manager = new managerModule.McpHostManager();
    await manager.enable(0);

    // Mirror registerMcpIpcHandlers: forwardCall parks the call in the
    // manager's pendingCalls map; resolveCall resolves it.
    let issuedId = "";
    manager.forwardCall = (call) => {
      issuedId = `call-${call.name}`;
      return new Promise((resolve, reject) => {
        manager.pendingCalls.set(issuedId, { resolve, reject, timer: setTimeout(() => reject(new Error("t")), 5000) });
      });
    };

    const pending = manager.forwardCall({ name: "kyx_state", args: {} });
    expect(manager.pendingCalls.has(issuedId)).toBe(true);
    expect(manager.resolveCall({ id: "unknown-id", result: { text: "no" } })).toBe(false);
    expect(manager.resolveCall({ id: issuedId, result: { text: "overview ok" } })).toBe(true);
    await expect(pending).resolves.toEqual({ text: "overview ok" });
    expect(manager.pendingCalls.size).toBe(0);

    await manager.disable();
  });

  it("registerMcpIpcHandlers wires status/enable/disable/answer end-to-end over a fake ipcMain", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const { manager } = managerModule.registerMcpIpcHandlers(
      { handle: (name: string, fn: (...args: unknown[]) => unknown) => void handlers.set(name, fn) },
      { getWebContents: () => null },
    );
    expect(handlers.has("kyx:mcp:status")).toBe(true);
    expect(handlers.has("kyx:mcp:enable")).toBe(true);
    expect(handlers.has("kyx:mcp:disable")).toBe(true);
    expect(handlers.has("kyx:mcp:answer")).toBe(true);

    expect((handlers.get("kyx:mcp:status") as () => unknown)()).toEqual(manager.status);

    const enabled = (await (handlers.get("kyx:mcp:enable") as () => Promise<unknown>)()) as {
      enabled: boolean;
    };
    expect(enabled.enabled).toBe(true);

    // With no window the forward rejects honestly (executor → isError text).
    // The adapter mirrors enable(): bridge (name, args) → forwardCall(call).
    const { createMcpBridgeServer } = require_(path.join(DESKTOP_DIR, "mcp-bridge-server.cjs")) as BridgeModule;
    const { server } = createMcpBridgeServer({
      token: manager.status.token ?? "",
      executeTool: async (name, args) => manager.forwardCall({ name, args }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);
    const response = await post(
      port,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kyx_state", arguments: {} } }),
      { token: manager.status.token ?? "" },
    );
    const body = JSON.parse(response.body) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("window not available");

    await (handlers.get("kyx:mcp:disable") as () => Promise<unknown>)();
    expect(manager.status.enabled).toBe(false);
  });

  it("extends the desktop wait only for render and generation calls", async () => {
    vi.useFakeTimers();
    try {
      const { manager } = managerModule.registerMcpIpcHandlers(
        { handle: () => {} },
        {
          callTimeoutMs: 10,
          longCallTimeoutMs: 60,
          getWebContents: () => ({ isDestroyed: () => false, send: () => {} }),
        },
      );
      const normal = manager.forwardCall({ name: "kyx_state" });
      const slow = manager.forwardCall({ name: "kyx_arrange" });
      const normalRejected = expect(normal).rejects.toThrow("KYX window timed out");
      const slowRejected = expect(slow).rejects.toThrow("KYX window timed out");

      await vi.advanceTimersByTimeAsync(10);
      await normalRejected;
      expect(manager.pendingCalls.size).toBe(1);

      await vi.advanceTimersByTimeAsync(50);
      await slowRejected;
      expect(manager.pendingCalls.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renderer answer resolves an in-flight forwarded call (answer → HTTP response)", async () => {
    // Timeout headroom only: real HTTP + forwarding round-trip measured ~1 s
    // alone, past the 5 s default when the FULL suite saturates the machine.
    // Fake window whose webContents captures the forwarded payload.
    const sent: Array<{ id: string; name: string; args: unknown }> = [];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const { manager } = managerModule.registerMcpIpcHandlers(
      { handle: (name: string, fn: (...args: unknown[]) => unknown) => void handlers.set(name, fn) },
      {
        getWebContents: () => ({
          isDestroyed: () => false,
          send: (channel: string, payload: { id: string; name: string; args: unknown }) => {
            expect(channel).toBe("kyx:mcp:call");
            sent.push(payload);
          },
        }),
      },
    );
    await (handlers.get("kyx:mcp:enable") as () => Promise<unknown>)();
    const { createMcpBridgeServer } = require_(path.join(DESKTOP_DIR, "mcp-bridge-server.cjs")) as BridgeModule;
    const { server } = createMcpBridgeServer({
      token: manager.status.token ?? "",
      executeTool: async (name, args) => manager.forwardCall({ name, args }),
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    // manager.forwardCall (the IPC override) parked the call and sent it to
    // the fake window; answer through the IPC handler like the renderer would.
    const responsePromise = post(
      port,
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "kyx_intent", arguments: {} } }),
      { token: manager.status.token ?? "" },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe("kyx_intent");
    // ipcMain.handle signature: (event, payload)
    (handlers.get("kyx:mcp:answer") as (event: unknown, payload: unknown) => unknown)(null, {
      id: sent[0]?.id,
      result: { text: "mute read-back", mutated: true },
    });
    const response = await responsePromise;
    const body = JSON.parse(response.body) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(body.result.content[0]?.text).toBe("mute read-back");
    expect(body.result.isError).toBeUndefined();
  }, 15000);
});

describe("desktop mcp stdio forwarder (subprocess)", () => {
  /**
   * Real chain: `node desktop/mcp-server.cjs` ↔ loopback bridge driver ↔
   * executor. The driver prints PORT:<n>; JSON-RPC lines flow over stdio.
   */
  async function startChain(hasToken: boolean): Promise<{
    child: ReturnType<typeof spawn>;
    writeLine: (payload: unknown) => void;
    nextLine: () => Promise<string>;
  }> {
    const token = managerModule.generateToken();
    const driver = [
      `const { createMcpBridgeServer } = require(${JSON.stringify(path.join(DESKTOP_DIR, "mcp-bridge-server.cjs"))});`,
      "const server = createMcpBridgeServer({",
      `  token: ${JSON.stringify(token)},`,
      '  executeTool: async (name, args) => name === "kyx_audio_preview" ? { text: "preview", mutated: false, data: { bars: 1, durationSec: 2, sampleRate: 22050, byteLength: 44144, mimeType: "audio/wav" }, audio: { data: "UklGRg==", mimeType: "audio/wav" } } : ({ text: "echo:" + name + ":" + JSON.stringify(args), mutated: false }),',
      "});",
      'server.server.listen(0, "127.0.0.1", () => console.log("PORT:" + server.server.address().port));',
    ].join("\n");
    const driverChild = spawn(process.execPath, ["-e", driver], { stdio: ["ignore", "pipe", "inherit"] });
    runningProcesses.push(driverChild);
    const port = await new Promise<number>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("driver timeout")), 10_000);
      driverChild.stdout.setEncoding("utf8");
      driverChild.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const match = /PORT:(\d+)/.exec(buffer);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      driverChild.on("exit", (code) => reject(new Error(`driver exited early: ${code}`)));
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KYX_MCP_BRIDGE_URL: `http://127.0.0.1:${port}/rpc`,
      ...(hasToken ? { KYX_MCP_TOKEN: token } : {}),
    };
    const child = spawn(process.execPath, [path.join(DESKTOP_DIR, "mcp-server.cjs")], {
      env,
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    });
    runningProcesses.push(child);
    let buffer = "";
    const nextLine = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`stdio timeout; buffer=${buffer}`)), 10_000);
        const pump = () => {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex < 0) return;
          clearTimeout(timer);
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          child.stdout.off("data", onData);
          resolve(line);
        };
        const onData = (chunk: string) => {
          buffer += chunk;
          pump();
        };
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", onData);
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`stdio server exited early: ${code}`));
        });
      });

    const writeLine = (payload: unknown) => child.stdin.write(JSON.stringify(payload) + "\n");
    return { child, writeLine, nextLine };
  }

  it("initialize → tools/list (37 tools) → tools/call round-trips through the bridge", async () => {
    const { child, writeLine, nextLine } = await startChain(true);
    writeLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = JSON.parse(await nextLine()) as {
      id: number;
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(init.id).toBe(1);
    expect(init.result.protocolVersion).toBe("2026-07-28");
    expect(init.result.serverInfo.name).toBe("kyx-mcp");

    writeLine({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = JSON.parse(await nextLine()) as {
      id: number;
      result: { tools: Array<{ name: string; outputSchema?: Record<string, unknown> }> };
    };
    expect(list.id).toBe(2);
    expect(list.result.tools.map((tool) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name));
    expect(list.result.tools.find((tool) => tool.name === "kyx_audio_preview")?.outputSchema).toEqual(
      MCP_TOOLS.find((tool) => tool.name === "kyx_audio_preview")?.outputSchema,
    );
    expect(list.result.tools.find((tool) => tool.name === "kyx_blind_ab")?.outputSchema).toEqual(
      MCP_TOOLS.find((tool) => tool.name === "kyx_blind_ab")?.outputSchema,
    );
    expect(list.result.tools.find((tool) => tool.name === "kyx_mix_idea")?.outputSchema).toEqual(
      MCP_TOOLS.find((tool) => tool.name === "kyx_mix_idea")?.outputSchema,
    );
    expect(list.result.tools.find((tool) => tool.name === "kyx_mix")?.outputSchema).toEqual(
      MCP_TOOLS.find((tool) => tool.name === "kyx_mix")?.outputSchema,
    );
    expect(list.result.tools.find((tool) => tool.name === "kyx_arrange")?.outputSchema).toEqual(
      MCP_TOOLS.find((tool) => tool.name === "kyx_arrange")?.outputSchema,
    );
    expect(list.result.tools.find((tool) => tool.name === "kyx_takes")?.outputSchema).toEqual(
      MCP_TOOLS.find((tool) => tool.name === "kyx_takes")?.outputSchema,
    );
    expect(list.result.tools.find((tool) => tool.name === "kyx_routing")?.outputSchema).toEqual(
      MCP_TOOLS.find((tool) => tool.name === "kyx_routing")?.outputSchema,
    );
    expect(list.result.tools.find((tool) => tool.name === "kyx_markers")?.outputSchema).toEqual(
      MCP_TOOLS.find((tool) => tool.name === "kyx_markers")?.outputSchema,
    );
    expect(list.result.tools.find((tool) => tool.name === "kyx_sections")?.outputSchema).toEqual(
      MCP_TOOLS.find((tool) => tool.name === "kyx_sections")?.outputSchema,
    );
    expect(list.result.tools.find((tool) => tool.name === "kyx_music")?.outputSchema).toEqual(
      MCP_TOOLS.find((tool) => tool.name === "kyx_music")?.outputSchema,
    );
    expect(list.result.tools.find((tool) => tool.name === "kyx_notes")?.outputSchema).toEqual(
      MCP_TOOLS.find((tool) => tool.name === "kyx_notes")?.outputSchema,
    );
    expect(list.result.tools.find((tool) => tool.name === "kyx_steps")?.outputSchema).toEqual(
      MCP_TOOLS.find((tool) => tool.name === "kyx_steps")?.outputSchema,
    );

    writeLine({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "kyx_intent", arguments: { instruction: "mute the drums" } },
    });
    const call = JSON.parse(await nextLine()) as { id: number; result: { content: Array<{ text: string }> } };
    expect(call.id).toBe(3);
    expect(call.result.content[0]?.text).toBe('echo:kyx_intent:{"instruction":"mute the drums"}');

    writeLine({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "kyx_audio_preview", arguments: {} } });
    const preview = JSON.parse(await nextLine()) as {
      id: number;
      result: { structuredContent: Record<string, unknown>; content: Array<Record<string, unknown>> };
    };
    expect(preview.result.structuredContent).toEqual({
      bars: 1,
      durationSec: 2,
      sampleRate: 22050,
      byteLength: 44144,
      mimeType: "audio/wav",
    });
    expect(preview.result.content[1]).toEqual({ type: "audio", data: "UklGRg==", mimeType: "audio/wav" });
    child.stdin?.end();
  }, 30_000);

  it("2025-03-26 clients keep the legacy surface without outputSchema or structuredContent", async () => {
    const { child, writeLine, nextLine } = await startChain(true);
    writeLine({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    const init = JSON.parse(await nextLine()) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe("2025-03-26");

    writeLine({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = JSON.parse(await nextLine()) as { result: { tools: Array<{ name: string; outputSchema?: unknown }> } };
    expect(list.result.tools.find((tool) => tool.name === "kyx_audio_preview")?.outputSchema).toBeUndefined();

    writeLine({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kyx_audio_preview", arguments: {} } });
    const preview = JSON.parse(await nextLine()) as {
      result: { structuredContent?: unknown; content: Array<Record<string, unknown>> };
    };
    expect(preview.result.structuredContent).toBeUndefined();
    expect(preview.result.content[1]).toEqual({ type: "audio", data: "UklGRg==", mimeType: "audio/wav" });
    child.stdin?.end();
  }, 30_000);

  it("without KYX_MCP_TOKEN the forwarder refuses tools/list and tools/call", async () => {
    const { child, writeLine, nextLine } = await startChain(false);
    writeLine({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kyx_state", arguments: {} } });
    const call = JSON.parse(await nextLine()) as { id: number; error: { code: number; message: string } };
    expect(call.error.code).toBe(-32001);
    expect(call.error.message).toContain("KYX_MCP_TOKEN");
    child.stdin?.end();
  }, 30_000);
});

describe("official MCP SDK client over the desktop stdio transport", () => {
  it("discovers KYX tools and receives structured audio through the client config path", async () => {
    const token = managerModule.generateToken();
    const { server } = bridgeModule.createMcpBridgeServer({
      token,
      executeTool: async (name) =>
        name === "kyx_audio_preview"
          ? {
              text: "preview ready",
              mutated: false,
              data: { bars: 1, durationSec: 1, sampleRate: 22050, byteLength: 44, mimeType: "audio/wav" },
              audio: {
                data: "UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAABErAAABAAgAZGF0YQAAAAA=",
                mimeType: "audio/wav",
              },
            }
          : { text: `ran ${name}`, mutated: false },
    });
    const port = await listenOnEphemeralPort(server);
    runningServers.push(server);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(DESKTOP_DIR, "mcp-server.cjs")],
      env: {
        ...getDefaultEnvironment(),
        KYX_MCP_BRIDGE_URL: `http://127.0.0.1:${port}/rpc`,
        KYX_MCP_TOKEN: token,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "kyx-stdio-wire-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(37);
      expect(tools.tools.find((tool) => tool.name === "kyx_audio_preview")?.outputSchema).toBeDefined();

      const preview = await client.callTool({ name: "kyx_audio_preview", arguments: { bars: 1 } });
      expect(preview.structuredContent).toMatchObject({ bars: 1, mimeType: "audio/wav" });
      expect(preview.content).toContainEqual(
        expect.objectContaining({ type: "audio", mimeType: "audio/wav", data: expect.any(String) }),
      );
    } finally {
      await client.close();
    }
  }, 30_000);
});
