// @ts-expect-error — plain .mjs server module without declarations
import { createMcpHub, handleMcpRequest, isValidToken, parseRpc, MCP_TOOL_DEFS } from "../server/mcp-core.mjs";
import { describe, it, expect } from "vitest";
import { MCP_TOOLS } from "../src/mcp/tools";

/**
 * KYX MCP SERVER CORE — JSON-RPC framing, auth, session relay. The gate:
 * an MCP client can list the 5 tools and call kyx_intent through the hub
 * (forwarded to a fake KYX session), with token auth and timeouts enforced.
 */

const TOKEN = "test-token-123";

function rpc(method: string, params: Record<string, unknown> | null, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params != null ? { params } : {}) });
}

describe("mcp core — framing + auth", () => {
  it("token check: exact match required, empty expected token disables", () => {
    expect(isValidToken("abc", "abc")).toBe(true);
    expect(isValidToken("abc", "abd")).toBe(false);
    expect(isValidToken("abc", "")).toBe(false);
    expect(isValidToken("", "abc")).toBe(false);
  });

  it("parse error → -32700; invalid envelope → -32600", () => {
    const bad = parseRpc("{not json");
    expect(bad.ok).toBe(false);
    expect(bad.error.error.code).toBe(-32700);
    const invalid = parseRpc({ jsonrpc: "1.0", id: 2, method: 5 });
    expect(invalid.ok).toBe(false);
    expect(invalid.error.error.code).toBe(-32600);
  });

  it("auth: wrong token → -32001 even before parsing", async () => {
    const hub = createMcpHub({ token: TOKEN, sendToSession: () => {} });
    const response = await handleMcpRequest(hub, "wrong", TOKEN, rpc("tools/list", {}, 7));
    expect(response.error.code).toBe(-32001);
  });

  it("no token configured → server disabled", async () => {
    const hub = createMcpHub({ token: "", sendToSession: () => {} });
    const response = await handleMcpRequest(hub, "", TOKEN, rpc("tools/list", {}, 7));
    expect(response.error.code).toBe(-32001);
  });
});

describe("mcp core — protocol with an authenticated session", () => {
  function makeHub(): { hub: any; delivered: any[] } {
    const delivered: unknown[] = [];
    const hub = createMcpHub({
      token: TOKEN,
      sendToSession: (payload: { id: number }) => {
        delivered.push(payload);
      },
    });
    hub.connectSession();
    return { hub, delivered };
  }

  it("initialize returns capabilities + serverInfo; tools/list returns the 33 tools", async () => {
    const { hub } = makeHub();
    const init = await handleMcpRequest(hub, TOKEN, TOKEN, rpc("initialize", {}, 1));
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.capabilities.tools).toBeDefined();
    const list = await handleMcpRequest(hub as any, TOKEN, TOKEN, rpc("tools/list", {}, 2));
    expect((list.result as { tools: Array<{ name: string }> }).tools).toHaveLength(33);
    expect((list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual([
      "kyx_intent",
      "kyx_state",
      "kyx_undo",
      "kyx_transport",
      "kyx_export",
      "kyx_generate",
      "kyx_groove",
      "kyx_fx",
      "kyx_sections",
      "kyx_markers",
      "kyx_tracks",
      "kyx_pattern",
      "kyx_steps",
      "kyx_notes",
      "kyx_music",
      "kyx_catalog",
      "kyx_plugin_param",
      "kyx_meter",
      "kyx_automation",
      "kyx_clips",
      "kyx_batch",
      "kyx_loudness",
      "kyx_import_sfz",
      "kyx_publish_gallery",
      "kyx_render_summary",
      "kyx_diagnose_mix",
      "kyx_checkpoint",
      "kyx_mix",
      "kyx_arrange",
      "kyx_song",
      "kyx_routing",
      "kyx_takes",
      "kyx_blind_ab",
    ]);
  });

  it("tools/call relays to the KYX session and resolves the read-back", async () => {
    const { hub, delivered } = makeHub() as { hub: any; delivered: unknown[] };
    const promise = handleMcpRequest(
      hub,
      TOKEN,
      TOKEN,
      rpc("tools/call", { name: "kyx_intent", arguments: { instruction: "mute the drums" } }, 5),
    );
    // the relay delivers the forwarded call back into the hub
    expect(delivered).toHaveLength(1);
    hub.handleSessionMessage({
      type: "mcp-result",
      id: (delivered[0] as { id: number }).id,
      result: { text: "mute the drums — Drums mute ✓ (undone-able in KYX)" },
    });
    const response = await promise;
    const content = (response.result as { content: Array<{ text: string }> }).content;
    // Live E2E 2025 regression: the relay frame to the window must be
    // { type: mcp-call, id, tool, args } — NOT the raw JSON-RPC envelope.
    // The two dialects once drifted apart and no unit test noticed.
    const frame = delivered[0] as { type?: string; tool?: string; args?: unknown };
    expect(frame.type).toBe("mcp-call");
    expect(frame.tool).toBe("kyx_intent");
    expect(frame.args).toEqual({ instruction: "mute the drums" });
    expect(content[0].text).toContain("Drums mute ✓");
  });

  it("unknown tool → -32602 without touching the session", async () => {
    const { hub, delivered } = makeHub() as { hub: any; delivered: unknown[] };
    const response = await handleMcpRequest(hub, TOKEN, TOKEN, rpc("tools/call", { name: "nope", arguments: {} }, 3));
    expect(response.error.code).toBe(-32602);
    expect(delivered).toHaveLength(0);
  });

  it("session disconnect returns an honest isError result (no hang, no reject)", async () => {
    const { hub, delivered } = makeHub() as { hub: any; delivered: unknown[] };
    const promise = handleMcpRequest(
      hub,
      TOKEN,
      TOKEN,
      rpc("tools/call", { name: "kyx_intent", arguments: { instruction: "mute the drums" } }, 9),
    );
    hub.disconnectSession();
    const response = await promise;
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain("disconnected");
    expect(delivered).toHaveLength(1);
  });

  it("tool definitions match the KYX surface (33 tools, known names)", () => {
    expect(MCP_TOOL_DEFS.map((tool: { name: string }) => tool.name)).toEqual([
      "kyx_intent",
      "kyx_state",
      "kyx_undo",
      "kyx_transport",
      "kyx_export",
      "kyx_generate",
      "kyx_groove",
      "kyx_fx",
      "kyx_sections",
      "kyx_markers",
      "kyx_tracks",
      "kyx_pattern",
      "kyx_steps",
      "kyx_notes",
      "kyx_music",
      "kyx_catalog",
      "kyx_plugin_param",
      "kyx_meter",
      "kyx_automation",
      "kyx_clips",
      "kyx_batch",
      "kyx_loudness",
      "kyx_import_sfz",
      "kyx_publish_gallery",
      "kyx_render_summary",
      "kyx_diagnose_mix",
      "kyx_checkpoint",
      "kyx_mix",
      "kyx_arrange",
      "kyx_song",
      "kyx_routing",
      "kyx_takes",
      "kyx_blind_ab",
    ]);
  });

  it("server tool defs are a VERBATIM mirror of src/mcp/tools.ts (anti-drift pin)", () => {
    // The 2026-09-29 audit found the server list had silently drifted (3
    // missing kyx_state subjects, missing kyx_generate bars/replaceMode) —
    // names-only pinning was not enough. Deep-pin names + descriptions +
    // input schemas: change the surface in tools.ts, then mirror it here.
    expect(MCP_TOOL_DEFS).toEqual(MCP_TOOLS);
  });

  it("an isError result from the session reaches the MCP client as isError (not a fake success)", async () => {
    const { hub, delivered } = makeHub() as { hub: any; delivered: unknown[] };
    const promise = handleMcpRequest(
      hub,
      TOKEN,
      TOKEN,
      rpc("tools/call", { name: "kyx_fx", arguments: { effect: "reverb", family: "vocal", action: "more" } }, 12),
    );
    hub.handleSessionMessage({
      type: "mcp-result",
      id: (delivered[0] as { id: number }).id,
      result: { text: "fx op failed: no tracks match the target", mutated: false, isError: true },
    });
    const response = await promise;
    expect((response.result as { isError: boolean }).isError).toBe(true);
  });
});
