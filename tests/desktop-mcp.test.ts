import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_TOOLS } from "../src/mcp/tools";

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
  MCP_TOOL_DEFS: Array<{ name: string; description: string; inputSchema: unknown }>;
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
  it("MCP_TOOL_DEFS mirrors src/mcp/tools.ts MCP_TOOLS exactly (names, descriptions, schemas)", () => {
    expect(bridgeModule.MCP_TOOL_DEFS).toEqual(
      MCP_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
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
    expect(initBody.result.protocolVersion).toBe("2025-03-26");
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
        if (name === "boom") throw new Error("honest failure");
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
      JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "boom", arguments: {} } }),
      { token: "tok" },
    );
    const badBody = JSON.parse(bad.body) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(badBody.result.isError).toBe(true);
    expect(badBody.result.content[0]?.text).toBe("honest failure");
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

  it("renderer answer resolves an in-flight forwarded call (answer → HTTP response)", async () => {
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
  });
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
      '  executeTool: async (name, args) => ({ text: "echo:" + name + ":" + JSON.stringify(args), mutated: false }),',
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

  it("initialize → tools/list (16 tools) → tools/call round-trips through the bridge", async () => {
    const { child, writeLine, nextLine } = await startChain(true);
    writeLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = JSON.parse(await nextLine()) as { id: number; result: { serverInfo: { name: string } } };
    expect(init.id).toBe(1);
    expect(init.result.serverInfo.name).toBe("kyx-mcp");

    writeLine({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = JSON.parse(await nextLine()) as { id: number; result: { tools: Array<{ name: string }> } };
    expect(list.id).toBe(2);
    expect(list.result.tools.map((tool) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name));

    writeLine({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "kyx_intent", arguments: { instruction: "mute the drums" } },
    });
    const call = JSON.parse(await nextLine()) as { id: number; result: { content: Array<{ text: string }> } };
    expect(call.id).toBe(3);
    expect(call.result.content[0]?.text).toBe('echo:kyx_intent:{"instruction":"mute the drums"}');
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
