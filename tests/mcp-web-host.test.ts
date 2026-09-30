import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import {
  buildRelayUrl,
  mcpHttpEndpoint,
  mcpRelayEnabled,
  mcpRelayServerUrl,
  mcpRelayToken,
  mcpWebBridgeConnected,
  setMcpRelayEnabled,
  setMcpRelayToken,
  startMcpWebBridge,
  startMcpWebBridgeIfEnabled,
  stopMcpWebBridge,
} from "../src/mcp/web-host";
import type { Services } from "../src/services";

/**
 * WEB MCP HOST (Phase D3 wiring) — URL derivation, persistence gates and
 * the bridge lifecycle over a stubbed WebSocket. The relay contract itself
 * (mcp-hello → mcp-call → mcp-result) is exercised end-to-end here; the
 * hub side lives in tests/mcp-core.test.ts.
 */

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 1;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
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
    this.closed = true;
  }
}

function fakeServices(): Services {
  const store = new ProjectStore(createProjectFromTemplate("house"));
  return {
    store,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
  } as unknown as Services;
}

beforeEach(() => {
  localStorage.clear();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  stopMcpWebBridge();
  vi.unstubAllGlobals();
});

describe("mcp relay URL derivation", () => {
  it("buildRelayUrl appends the relay path and encodes the token", () => {
    expect(buildRelayUrl("ws://127.0.0.1:1234", "abc123")).toBe("ws://127.0.0.1:1234/mcp-relay?token=abc123");
    expect(buildRelayUrl("ws://127.0.0.1:1234/", "a/b+c")).toBe("ws://127.0.0.1:1234/mcp-relay?token=a%2Fb%2Bc");
    expect(buildRelayUrl("wss://relay.example.com", "t")).toBe("wss://relay.example.com/mcp-relay?token=t");
  });

  it("mcpHttpEndpoint mirrors the relay server to the streamable-HTTP scheme", () => {
    expect(mcpHttpEndpoint("ws://127.0.0.1:1234")).toBe("http://127.0.0.1:1234/mcp");
    expect(mcpHttpEndpoint("wss://relay.example.com/")).toBe("https://relay.example.com/mcp");
  });

  it("mcpRelayServerUrl honors an allowed ?server= override and rejects foreign hosts", () => {
    const base = mcpRelayServerUrl("");
    expect(base).toMatch(/^ws(s?):\/\//);
    const overridden = mcpRelayServerUrl("?collab=room&server=ws://localhost:1234");
    expect(overridden).toBe("ws://localhost:1234");
    const evil = mcpRelayServerUrl("?collab=room&server=ws://evil.example.com:1234");
    expect(evil).toBe(base);
  });
});

describe("web mcp bridge lifecycle", () => {
  it("persistence flags round-trip", () => {
    expect(mcpRelayEnabled()).toBe(false);
    setMcpRelayEnabled(true);
    expect(mcpRelayEnabled()).toBe(true);
    setMcpRelayEnabled(false);
    expect(mcpRelayEnabled()).toBe(false);

    setMcpRelayToken("  secret-token  ");
    expect(mcpRelayToken()).toBe("secret-token");
    setMcpRelayToken("   ");
    expect(mcpRelayToken()).toBe("");
  });

  it("startMcpWebBridge refuses without a token; ifEnabled gates on the persisted flag", () => {
    const services = fakeServices();
    expect(startMcpWebBridge(services)).toBeNull();
    expect(startMcpWebBridgeIfEnabled(services)()).toBeUndefined(); // noop stop
    expect(FakeWebSocket.instances).toHaveLength(0);

    // token but no opt-in → still inert
    setMcpRelayToken("tok");
    expect(startMcpWebBridgeIfEnabled(services)()).toBeUndefined();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("opt-in + token opens the relay socket with the tokened URL; mcp-call round-trips to the store", async () => {
    const services = fakeServices();
    setMcpRelayToken("tok");
    setMcpRelayEnabled(true);
    const stop = startMcpWebBridgeIfEnabled(services);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toContain("/mcp-relay?token=tok");

    socket.onopen?.();
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: "mcp-hello" });

    // hub relays a tools call → the store mutates → mcp-result answers.
    // The bridge answers ASYNC (awaited executor) — flush microtasks first.
    socket.onmessage?.({
      data: JSON.stringify({ type: "mcp-call", id: 7, tool: "kyx_intent", args: { instruction: "set tempo to 140" } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; id?: number })
      .find((m) => m.type === "mcp-result");
    expect(result?.id).toBe(7);
    expect(services.store.doc.bpm).toBe(140);

    stop();
    expect(socket.closed).toBe(true);
    expect(mcpWebBridgeConnected()).toBe(false);
  });

  it("a services swap reconnects through the App re-arm contract (stop closes, start re-opens)", () => {
    setMcpRelayToken("tok");
    setMcpRelayEnabled(true);
    const stopA = startMcpWebBridgeIfEnabled(fakeServices());
    expect(FakeWebSocket.instances).toHaveLength(1);
    stopA();
    const stopB = startMcpWebBridgeIfEnabled(fakeServices());
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.closed).toBe(false);
    stopB();
  });

  it("a tool that CRASHES still answers mcp-result (no relay hang) and is marked isError", async () => {
    const services = fakeServices();
    // Force a crash inside the tool execution path — the bridge must catch
    // it and answer, otherwise the server-side call hangs until timeout.
    const originalGetDoc = services.store.getDoc.bind(services.store);
    services.store.getDoc = () => {
      throw new Error("boom");
    };
    setMcpRelayToken("tok");
    setMcpRelayEnabled(true);
    const stop = startMcpWebBridgeIfEnabled(services);
    const socket = FakeWebSocket.instances[0]!;
    socket.onopen?.();

    socket.onmessage?.({
      data: JSON.stringify({ type: "mcp-call", id: 11, tool: "kyx_state", args: { subject: "overview" } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const raw = socket.sent
      .map((entry) => JSON.parse(entry) as { type: string; id?: number; result?: { text?: string; isError?: boolean } })
      .find((message) => message.type === "mcp-result");
    expect(raw?.id).toBe(11);
    expect(raw?.result?.text).toContain("tool crashed: boom");
    expect(raw?.result?.isError).toBe(true);

    services.store.getDoc = originalGetDoc;
    stop();
  });
});
