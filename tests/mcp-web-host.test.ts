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
import { setMcpAllowMutations } from "../src/mcp/flags";
import type { McpToolResult } from "../src/mcp/tools";
import { applyIntent, type IntentCaller } from "./helpers/intentProtocol";

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

/**
 * The relay seen as an MCP CALLER.
 *
 * The bridge answers asynchronously: a call goes out as an `mcp-call`, and the
 * answer comes back as an `mcp-result` carrying the SAME id. That id round-trip
 * IS the contract this file is about, so the adapter refuses to hand back an
 * answer whose id does not match the call it sent — a mismatched id is a broken
 * relay, not a test detail.
 */
function relayCaller(socket: FakeWebSocket): IntentCaller & { callIds: number[] } {
  const callIds: number[] = [];
  let nextId = 100;
  return {
    callIds,
    async call(name: string, args?: unknown): Promise<McpToolResult> {
      const id = nextId++;
      callIds.push(id);
      socket.onmessage?.({ data: JSON.stringify({ type: "mcp-call", id, tool: name, args }) });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const answer = socket.sent
          .map((raw) => JSON.parse(raw) as { type: string; id?: number; result?: McpToolResult })
          .find((message) => message.type === "mcp-result" && message.id === id);
        if (answer?.result) return answer.result;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`the relay never answered the ${name} call (id ${id})`);
    },
  };
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
    // ADR 0065: the relay is an EXTERNAL transport. A mutating call needs the
    // user's standing consent — granted here, because this test's subject is
    // the relay ROUND-TRIP, not the consent policy.
    setMcpAllowMutations(true);
    const stop = startMcpWebBridgeIfEnabled(services);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toContain("/mcp-relay?token=tok");

    socket.onopen?.();
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: "mcp-hello" });

    // hub relays a tools call → the store mutates → mcp-result answers.
    //
    // The relay is an EXTERNAL transport, so a mutating intent speaks the
    // reviewed-plan protocol: the review first, then the apply of the planId
    // it returned. A direct call would be refused with CONFIRMATION_REQUIRED
    // and the project would never change — the protocol IS how the relay
    // reaches the store.
    const relay = relayCaller(socket);
    const result = await applyIntent(relay, "set tempo to 140");
    expect(result.isError, result.text).not.toBe(true);
    expect(result.mutated).toBe(true);
    // two calls — the review, then the apply — and each was answered with its
    // OWN id. A relay that answered with the wrong id would leave the caller
    // waiting for an answer that never arrives.
    expect(relay.callIds).toHaveLength(2);
    const answeredIds = socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; id?: number })
      .filter((message) => message.type === "mcp-result")
      .map((message) => message.id);
    expect(answeredIds).toEqual(relay.callIds);
    expect(services.store.doc.bpm).toBe(140);

    stop();
    expect(socket.closed).toBe(true);
    expect(mcpWebBridgeConnected()).toBe(false);
  });

  it("the relay may NOT mutate the project without the user's standing consent", async () => {
    // ADR 0065 — the guarantee this whole lattice exists for. The web relay
    // is reachable by an agent OUTSIDE the app; without the user's consent it
    // may READ the project, but it may not change it.
    const services = fakeServices();
    setMcpRelayToken("tok");
    setMcpRelayEnabled(true);
    setMcpAllowMutations(false);
    const stop = startMcpWebBridgeIfEnabled(services);
    const socket = FakeWebSocket.instances[0]!;
    socket.onopen?.();

    socket.onmessage?.({
      data: JSON.stringify({ type: "mcp-call", id: 9, tool: "kyx_intent", args: { instruction: "set tempo to 140" } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; id?: number; result?: McpToolResult })
      .find((m) => m.type === "mcp-result");
    expect(result?.id).toBe(9);
    // The refusal must be the CONSENT one. An external agent is refused here
    // for two different reasons — the user has not consented, and the edit was
    // never reviewed — and BOTH arrive as CONFIRMATION_REQUIRED. Naming the
    // reason keeps this spec from going green because some other gate
    // happened to block the call.
    expect(result?.result?.isError).toBe(true);
    expect(result?.result?.errorCode).toBe("CONFIRMATION_REQUIRED");
    expect(result?.result?.text).toMatch(/not allowed agent-driven edits/);
    // the project is UNCHANGED — the relay asked, and the user did not say yes
    expect(services.store.doc.bpm).not.toBe(140);
    stop();
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
    // kyx_state first self-heals the lazy factory bank (Fáza 2b warm gate)
    // before the tool body runs — that is many ticks, not one macrotask.
    // Poll for the answer with a bound: the contract under test is "the
    // relay NEVER hangs", so the poll must find the mcp-result quickly.
    const deadline = Date.now() + 5000;
    let raw: { type: string; id?: number; result?: { text?: string; isError?: boolean } } | undefined;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      raw = socket.sent
        .map(
          (entry) => JSON.parse(entry) as { type: string; id?: number; result?: { text?: string; isError?: boolean } },
        )
        .find((message) => message.type === "mcp-result");
      if (raw) break;
    }
    expect(raw?.id).toBe(11);
    expect(raw?.result?.text).toContain("tool crashed: boom");
    expect(raw?.result?.isError).toBe(true);

    services.store.getDoc = originalGetDoc;
    stop();
  });
});
