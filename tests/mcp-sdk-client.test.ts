import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createCollabServer } from "../server/collab-server.mjs";
// @ts-expect-error - plain .mjs hub module without declarations
import { createMcpHub } from "../server/mcp-core.mjs";

/**
 * REAL-CLIENT MCP WIRE GATE.
 *
 * Every other MCP test speaks the protocol by hand (raw fetch + JSON). This
 * one drives the server through the OFFICIAL `@modelcontextprotocol/sdk`
 * client — the same code path a real agent host (Claude Desktop & co.) uses —
 * so a wire contract that only "passes by accident" against hand-rolled
 * JSON is caught here.
 *
 * Covered:
 *  - legacy handshake: initialize → tools/list → tools/call over Streamable
 *    HTTP, with the SDK's own schema validation of every response;
 *  - structured content: the SDK client REQUIRES `structuredContent` when a
 *    tool declares `outputSchema` (it throws otherwise) — this is the
 *    machine-enforced form of the output-schema contract;
 *  - audio content: an audio block survives the wire as a standard MCP
 *    `audio` content item;
 *  - modern era: a per-request `_meta` version + `server/discover`, plus the
 *    `UnsupportedProtocolVersionError` (-32022) retry contract.
 *
 * The server executes tool calls through a connected KYX session; the gate
 * injects a hub whose session is a scripted executor, so the WHOLE wire path
 * (HTTP → MCP core → relay frame → result → HTTP) is exercised for real.
 *
 * Runs under NODE (not the default jsdom): the SDK's fetch path needs the
 * runtime's real AbortSignal/undici globals, which jsdom replaces.
 *
 * @vitest-environment node
 */

type CollabServer = ReturnType<typeof createCollabServer>;

const TOKEN = "sdk-wire-token";
const opened: CollabServer[] = [];

type Executor = (name: string, args: Record<string, unknown>) => unknown;

/** A hub whose "session" is a scripted executor — no WebSocket needed. */
function scriptedHub(executor: Executor) {
  const hub = createMcpHub({
    token: TOKEN,
    sendToSession: (payload: { id: number; tool: string; args: Record<string, unknown> }) => {
      // Resolve on the next tick so the pending-call entry is registered first,
      // exactly like a real relay answer arriving over the wire.
      setTimeout(() => {
        Promise.resolve(executor(payload.tool, payload.args ?? {}))
          .then((result) => hub.handleSessionMessage({ type: "mcp-result", id: payload.id, result }))
          .catch((error) =>
            hub.handleSessionMessage({
              type: "mcp-result",
              id: payload.id,
              result: { text: String(error), isError: true },
            }),
          );
      }, 0);
    },
  });
  hub.connectSession();
  return hub;
}

async function boot(executor: Executor) {
  const galleryFile = join(mkdtempSync(join(tmpdir(), "pf-mcp-sdk-")), "gallery.json");
  const collab = createCollabServer({
    galleryFile,
    mcpToken: TOKEN,
    mcpHub: scriptedHub(executor),
  });
  await new Promise<void>((resolve) => collab.server.listen(0, "127.0.0.1", resolve));
  opened.push(collab);
  const { port } = collab.server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(
      (c) =>
        new Promise<void>((resolve) => {
          c.server.close(() => resolve());
          c.wss.close();
        }),
    ),
  );
});

describe("real MCP SDK client over Streamable HTTP", () => {
  it("legacy handshake lists tools and executes a call with schema validation", async () => {
    // The server wires the executor into the hub's scripted session; answer
    // the two tools this gate actually calls.
    const { base } = await boot(async (name) => {
      if (name === "kyx_loudness") {
        return { text: "measured", mutated: false, data: { integratedLufs: -14.2 } };
      }
      return { text: `ran ${name}`, mutated: false };
    });

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: "sdk-wire-test", version: "1.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(30);
    // kyx_loudness carries an outputSchema — the SDK client enforces the
    // structured-output contract for it on the call below.
    const loudness = tools.tools.find((tool) => tool.name === "kyx_loudness");
    expect(loudness?.outputSchema).toBeDefined();

    // The SDK client THROWS when a tool declares outputSchema but the server
    // omits structuredContent — a passing call here proves the contract.
    const result = await client.callTool({ name: "kyx_loudness", arguments: { op: "measure" } });
    expect(result.structuredContent).toMatchObject({ integratedLufs: -14.2 });

    await client.close();
  });

  it("a structured result is passed through as the executor's actual data", async () => {
    // Deliberately NOT asserting schema validation: the wire layer checks
    // that a tool declaring `outputSchema` returns SOME structuredContent
    // (and flags the miss as isError), but it does not run a JSON-Schema
    // validator at runtime. That keeps the transport cheap and lets the
    // TypeScript contract on `McpToolResult.data` carry the exact shape —
    // this test pins the pass-through behaviour so a future "helpful"
    // filter/rewrite of structured data would be caught.
    const { base } = await boot(async () => ({
      text: "measured",
      mutated: false,
      data: { integratedLufs: -14.2, note: "extra keys are allowed" },
    }));

    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
    };
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "kyx_loudness", arguments: { op: "measure" } },
      }),
    });
    const body = (await response.json()) as {
      result?: {
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
        resultType?: string;
      };
    };
    expect(body.result?.structuredContent).toEqual({ integratedLufs: -14.2, note: "extra keys are allowed" });
    expect(body.result?.isError).toBe(false);
    expect(body.result?.resultType).toBe("complete");
  });

  it("a missing structuredContent for an outputSchema tool is flagged as a tool error", async () => {
    // The executor returns no `data` at all for a tool that declares an
    // outputSchema — the wire contract catches the miss and reports it as a
    // tool-level isError instead of silently handing the agent a result it
    // cannot parse.
    const { base } = await boot(async () => ({ text: "measured", mutated: false }));

    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
    };
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "kyx_loudness", arguments: { op: "measure" } },
      }),
    });
    const body = (await response.json()) as {
      result?: { structuredContent?: unknown; isError?: boolean; content?: Array<{ text: string }> };
    };
    expect(body.result?.structuredContent).toBeUndefined();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("did not return structuredContent");
  });

  it("audio content blocks survive the official client round-trip", async () => {
    const { base } = await boot(async () => ({
      text: "preview ready",
      mutated: false,
      data: { bars: 1, durationSec: 1, sampleRate: 22050, byteLength: 44, mimeType: "audio/wav" },
      audio: { data: "UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAABErAAABAAgAZGF0YQAAAAA=", mimeType: "audio/wav" },
    }));

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: "sdk-wire-audio", version: "1.0.0" });
    await client.connect(transport);

    const result = await client.callTool({ name: "kyx_audio_preview", arguments: { bars: 1 } });
    const blocks = result.content as Array<{ type: string; data?: string; mimeType?: string }>;
    const audio = blocks.find((block) => block.type === "audio");
    expect(audio).toBeDefined();
    expect(audio?.mimeType).toBe("audio/wav");
    expect(audio?.data?.length).toBeGreaterThan(0);
    expect(result.structuredContent).toMatchObject({ bars: 1, mimeType: "audio/wav" });

    await client.close();
  });

  it("modern requests carry _meta; server/discover advertises versions; bad version answers -32022", async () => {
    const { base } = await boot(async () => ({ text: "ok", mutated: false }));
    const headers = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const post = async (payload: unknown) => {
      const response = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(payload) });
      return (await response.json()) as {
        result?: Record<string, unknown>;
        error?: { code: number; data?: { supported?: string[] } };
      };
    };

    // A modern client discovers support first.
    const discover = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    });
    expect(discover.error).toBeUndefined();
    expect(discover.result?.supportedVersions).toContain("2026-07-28");
    expect(discover.result?.resultType).toBe("complete");
    expect(discover.result?.capabilities).toBeDefined();

    // A modern tools/list request is served statelessly and carries serverInfo.
    const list = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    });
    expect(list.error).toBeUndefined();
    expect(Array.isArray((list.result as { tools?: unknown[] }).tools)).toBe(true);

    // An unsupported version answers UnsupportedProtocolVersionError with the
    // supported list, which a client uses to retry.
    const bad = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
    });
    expect(bad.error?.code).toBe(-32022);
    expect(bad.error?.data?.supported).toContain("2026-07-28");

    // The modern era also carries the version in the MCP-Protocol-Version
    // header; the server must accept and honor it on a plain (meta-less) POST.
    const headerResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, "MCP-Protocol-Version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
    });
    const headerBody = (await headerResponse.json()) as {
      result?: { resultType?: string; tools?: unknown[] };
      error?: { code: number };
    };
    expect(headerBody.error).toBeUndefined();
    expect(headerBody.result?.resultType).toBe("complete");
    expect(Array.isArray(headerBody.result?.tools)).toBe(true);

    // An unsupported header version is refused the same way.
    const badHeader = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, "MCP-Protocol-Version": "1900-01-01" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }),
    });
    const badHeaderBody = (await badHeader.json()) as { error?: { code: number } };
    expect(badHeaderBody.error?.code).toBe(-32022);
  });
});
