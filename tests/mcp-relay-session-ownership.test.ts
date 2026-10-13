import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error - plain .mjs server module without declarations
import { createMcpHub } from "../server/mcp-core.mjs";
// collab-server.mjs resolves types through the same allowJs path as mcp-core
import { createCollabServer } from "../server/collab-server.mjs";
import { MCP_RELAY_DISPLACED_CODE, McpBridge } from "../src/mcp/bridge";
import type { McpBridgeDeps } from "../src/mcp/bridge";

/**
 * MCP RELAY SESSION OWNERSHIP (audit P1-D).
 *
 * P1-D was filed as "first resolve the UNKNOWN: does the web relay share the
 * single-session model?". It does — and the answer was a defect, not a design
 * preference:
 *
 *   `createMcpHub` held ONE boolean (`sessionConnected`) and the collab server
 *   held ONE `mcpRelaySocket`. A second KYX window overwrote both silently.
 *   The displaced window stayed connected and kept sending `mcp-result`
 *   frames, which the hub accepted from ANY socket — so an agent's tool call
 *   could be executed against a DIFFERENT project's document and still
 *   resolve successfully. That is the Phase 3 failure this whole audit exists
 *   to close: a change that reports success while missing its real target.
 *
 * These specs pin the fixed contract on BOTH sides of the wire:
 *   1. the hub routes answers by session identity (answer-side, unit level)
 *   2. the server takes ownership over explicitly and closes the loser with a
 *      code the browser understands (wire level, real server + real sockets)
 *   3. the browser treats that code as final instead of reconnecting
 *
 * The bridge specs use the REAL McpBridge over a stubbed WebSocket. The
 * server spec drives the REAL collab server over real `ws` sockets — a hub
 * unit test cannot prove the close code, and a source-string check on the
 * number would prove nothing at all.
 */

const TOKEN = "relay-ownership-token";

/** A hub with one captured outbound frame list and no transport of its own. */
function makeHub() {
  const sent: Array<{ id: number; tool: string }> = [];
  const hub = createMcpHub({
    token: TOKEN,
    sendToSession: (payload: { id: number; tool: string }) => {
      sent.push(payload);
    },
  });
  return { hub, sent };
}

const resultFrame = (id: number, text: string) => ({ type: "mcp-result", id, result: { text, mutated: false } });

describe("mcp hub — one executor session, answers routed by identity", () => {
  it("a DISPLACED window's answer cannot resolve the live window's call", async () => {
    // This is the defect, reduced to its smallest honest form: two windows,
    // one pending call, and the loser answering first.
    const { hub, sent } = makeHub();
    hub.connectSession("window-A");
    const call = hub.callTool("kyx_state", {});
    expect(sent).toHaveLength(1);
    const callId = sent[0].id;

    // Window B opens the relay and takes ownership (last writer wins).
    hub.connectSession("window-B");
    expect(hub.sessionId()).toBe("window-B");

    // A still believes it is the session and answers. Its answer describes A's
    // document; accepting it would hand the agent a success for an edit that
    // never touched the project the agent is holding.
    expect(hub.handleSessionMessage(resultFrame(callId, "mutated window-A doc"), "window-A")).toBe(false);

    // Only B's answer resolves, and the call is still pending (not rejected).
    expect(hub.handleSessionMessage(resultFrame(callId, "mutated window-B doc"), "window-B")).toBe(true);
    await expect(call).resolves.toMatchObject({ text: "mutated window-B doc" });
  });

  it("a displaced window CLOSING does not tear down the session that replaced it", async () => {
    const { hub, sent } = makeHub();
    hub.connectSession("window-A");
    hub.connectSession("window-B");
    // A's socket dies right after the takeover (tab closed, network drop).
    hub.disconnectSession("window-A");
    expect(hub.hasSession()).toBe(true);
    expect(hub.sessionId()).toBe("window-B");

    // ...so B's call still routes and still resolves.
    const call = hub.callTool("kyx_state", {});
    expect(sent).toHaveLength(1);
    expect(hub.handleSessionMessage(resultFrame(sent[0].id, "ok"), "window-B")).toBe(true);
    await expect(call).resolves.toMatchObject({ text: "ok" });
  });

  it("the OWNER closing still rejects in-flight calls (unchanged contract)", async () => {
    const { hub } = makeHub();
    hub.connectSession("window-A");
    const call = hub.callTool("kyx_export", {});
    hub.disconnectSession("window-A");
    await expect(call).rejects.toThrow(/disconnected/i);
    expect(hub.hasSession()).toBe(false);
    expect(hub.sessionId()).toBeNull();
  });

  it("a single-window host keeps working with no ids at all (desktop signature)", async () => {
    // The desktop bridge and the existing suites call connectSession() with no
    // argument. The identity must default, not become a second dialect.
    const { hub, sent } = makeHub();
    hub.connectSession();
    expect(hub.sessionId()).toBe("default");
    const call = hub.callTool("kyx_state", {});
    expect(hub.handleSessionMessage(resultFrame(sent[0].id, "ok"))).toBe(true);
    await expect(call).resolves.toMatchObject({ text: "ok" });

    hub.disconnectSession();
    expect(hub.hasSession()).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* wire level — the real server, real sockets                           */
/* ------------------------------------------------------------------ */

interface OpenServer {
  port: number;
  wss: { clients: Set<WebSocket>; close: () => void };
  close: () => Promise<void>;
}

async function listen(): Promise<OpenServer> {
  // Real temp paths: the stores derive sibling files from galleryFile, so a
  // null path is a TypeError rather than "no persistence".
  const dir = mkdtempSync(join(tmpdir(), "kyx-relay-ownership-"));
  const { server, wss } = createCollabServer({
    mcpToken: TOKEN,
    // Keep every store out of the repo so a suite run never touches real data.
    galleryFile: join(dir, "gallery.json"),
    battlesFile: join(dir, "gallery-battles.json"),
    intakeFile: join(dir, "intake.json"),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address != null ? address.port : 0;
  return {
    port,
    wss,
    close: async () => {
      // Both halves, and both BEFORE the await: `server.close()` alone waits
      // on live WebSocket clients forever, and a hung teardown fails the whole
      // file with a hook timeout instead of a readable assertion.
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function relay(port: number): WebSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/mcp-relay?token=${TOKEN}`);
  // A refusal or reset surfaces as an error event; without a listener `ws`
  // rethrows it and vitest reports an uncaught exception instead of a failure.
  socket.on("error", () => {});
  return socket;
}

/**
 * Wait for one socket event with a BOUNDED timeout.
 *
 * A bare `once()` here is a trap: if the event never arrives the spec hangs
 * until the global test timeout and reports "timed out" with no indication of
 * which wait failed. This fails with the event name instead.
 */
function waitFor<T>(socket: WebSocket, event: "open" | "close" | "message", ms = 3000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay socket never emitted "${event}"`)), ms);
    socket.on(event, ((value: T) => {
      clearTimeout(timer);
      resolve(value);
    }) as (...args: unknown[]) => void);
  });
}

/** Resolve immediately when already open — a socket can open before we await. */
async function waitOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await waitFor(socket, "open");
}

/**
 * `ws` emits close as `(code, reason)` — TWO positional arguments, not one
 * object. A handler that takes only the first silently hands back the bare
 * code, which then reads as "the close arrived but had no code".
 */
function waitClosed(socket: WebSocket, ms = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay socket never emitted "close"')), ms);
    socket.on("close", (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reason) });
    });
  });
}

describe("collab server — one relay executor window", () => {
  let harness: OpenServer;
  let sockets: WebSocket[] = [];

  beforeEach(async () => {
    harness = await listen();
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets = [];
    await harness.close();
  });

  it("a second window takes the relay and the FIRST one is closed with the displacement code", async () => {
    const first = relay(harness.port);
    sockets.push(first);
    await waitOpen(first);

    // Attach BEFORE the takeover: the server closes the incumbent the moment
    // it handles the second upgrade, which can beat a listener registered on
    // the next line. That race is a property of the fix, not of the harness.
    const closed = waitClosed(first);
    const second = relay(harness.port);
    sockets.push(second);
    await waitOpen(second);

    // The incumbent is told WHY, in-band on the close frame.
    const frame = await closed;
    expect(frame.code).toBe(MCP_RELAY_DISPLACED_CODE);
    expect(frame.reason).toMatch(/another KYX window/i);

    // ...and the newcomer is a working session, not a dead socket.
    expect(second.readyState).toBe(WebSocket.OPEN);
  });

  it("a tools/call is delivered to the window that OWNS the relay, and the owner answers it", async () => {
    const first = relay(harness.port);
    sockets.push(first);
    await waitOpen(first);

    const second = relay(harness.port);
    sockets.push(second);
    const closed = waitClosed(first);
    await waitOpen(second);
    await closed;

    const call = (async () => {
      const response = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: { name: "kyx_state", arguments: {} },
        }),
      });
      return response.json() as Promise<{ result?: { text?: string }; error?: unknown }>;
    })();

    // The call frame must arrive on the OWNER (second), never on the loser.
    const frame = await waitFor<Buffer>(second, "message");
    const relayed = JSON.parse(String(frame)) as { type: string; id: number; tool: string };
    expect(relayed.type).toBe("mcp-call");
    expect(relayed.tool).toBe("kyx_state");

    second.send(
      JSON.stringify({ type: "mcp-result", id: relayed.id, result: { text: "owner answered", mutated: false } }),
    );
    const answered = await call;
    // MCP carries tool text as content parts, not a bare `text` field.
    const parts = (answered.result as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
    expect(parts[0]?.text).toBe("owner answered");
  });

  it("an unauthorized relay handshake is still refused (the fix did not widen auth)", async () => {
    // `ws` reports a rejected HTTP upgrade as an ERROR, not a close frame, so
    // the listener must be attached or the throw escapes as an unhandled
    // exception and the suite reports it as a crash rather than a refusal.
    const socket = new WebSocket(`ws://127.0.0.1:${harness.port}/mcp-relay?token=wrong`);
    sockets.push(socket);
    const refusal = await new Promise<string>((resolve) => {
      socket.on("error", (error: Error) => resolve(error.message));
      socket.on("open", () => resolve("OPENED"));
    });
    expect(refusal).not.toBe("OPENED");
    expect(refusal).toMatch(/401/);
  });
});

/* ------------------------------------------------------------------ */
/* browser side — displacement must not become a reconnect storm         */
/* ------------------------------------------------------------------ */

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function fakeDeps(onDisplaced?: (reason: string) => void): McpBridgeDeps {
  return {
    getDoc: () => ({}) as never,
    execute: () => {},
    undo: () => {},
    redo: () => {},
    undoStackLength: () => 0,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: "web-relay",
    ...(onDisplaced ? { onDisplaced } : {}),
  } as unknown as McpBridgeDeps;
}

describe("mcp web bridge — displacement is terminal, a network drop is not", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a displacement close STOPS the bridge and reports the reason", () => {
    const reasons: string[] = [];
    const bridge = new McpBridge(
      fakeDeps((reason) => reasons.push(reason)),
      "ws://127.0.0.1:1234/mcp-relay?token=t",
    );
    bridge.start();
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0].onclose?.({ code: MCP_RELAY_DISPLACED_CODE, reason: "another KYX window owns it" });

    // No reconnect was scheduled: advancing past the backoff window proves it,
    // because the OLD code would have opened a second socket by now.
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(reasons).toEqual(["another KYX window owns it"]);
    expect(bridge.connected).toBe(false);
  });

  it("CONTROL: an ordinary close still reconnects — the guard discriminates", () => {
    const bridge = new McpBridge(fakeDeps(), "ws://127.0.0.1:1234/mcp-relay?token=t");
    bridge.start();
    FakeWebSocket.instances[0].onclose?.({ code: 1006, reason: "abnormal" });

    vi.advanceTimersByTime(5_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
