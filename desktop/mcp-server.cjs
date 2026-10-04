#!/usr/bin/env node
/**
 * KYX MCP STDIO SERVER — the process an external MCP client (Claude Desktop
 * & co.) spawns. Speaks JSON-RPC 2.0 over stdin/stdout, forwards every
 * request to the KYX app's loopback bridge (desktop/mcp-bridge-server.cjs
 * inside Electron main) over HTTP POST, and writes the response to stdout.
 *
 * Config (env, set in the MCP client's config):
 *   KYX_MCP_BRIDGE_URL  default http://127.0.0.1:8787/rpc
 *   KYX_MCP_TOKEN       shared secret — REQUIRED; without it the server
 *                       refuses every call (opt-in by design)
 *
 * THIS PROCESS IS STATELESS: it holds no project data, executes nothing,
 * and only relays. All execution happens inside the KYX window through the
 * deterministic command layer (clamps, strict targets, undo).
 */
const { MCP_TOOL_DEFS, MCP_RESOURCE_DEFS } = require("./mcp-tool-defs.cjs");

const BRIDGE_URL = process.env.KYX_MCP_BRIDGE_URL || "http://127.0.0.1:8787/rpc";
/**
 * Dual-era support (MCP 2026-07-28 "Versioning"): MODERN clients declare the
 * version in per-request `_meta` and may call `server/discover`; LEGACY
 * clients use the `initialize` handshake. Both are answered here.
 */
const PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS];
const UNSUPPORTED_PROTOCOL_CODE = -32022;
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const SERVER_INFO = { name: "kyx-mcp", version: "1.0.0" };
let negotiatedProtocolVersion = LEGACY_PROTOCOL_VERSIONS[0];

function requestProtocolVersion(params) {
  const meta = params?._meta;
  if (meta == null || typeof meta !== "object") return null;
  const version = meta[META_PROTOCOL_VERSION];
  return typeof version === "string" && version.length > 0 ? version : null;
}

function withServerMeta(result, modern) {
  if (!modern || result == null || typeof result !== "object") return result;
  const meta = result._meta != null && typeof result._meta === "object" ? result._meta : {};
  return { ...result, _meta: { ...meta, [META_SERVER_INFO]: SERVER_INFO } };
}

function unsupportedProtocolError(id, requested) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: UNSUPPORTED_PROTOCOL_CODE,
      message: "Unsupported protocol version",
      data: { supported: SUPPORTED_PROTOCOL_VERSIONS, requested },
    },
  };
}
const SERVER_INSTRUCTIONS =
  "KYX is a browser DAW whose MCP surface executes through the deterministic " +
  "command layer: every mutation is ONE undo step and returns a verification " +
  "read-back of the resulting state. Read before acting (kyx_state or the " +
  "kyx://project/* resources), prefer the structured tools over free-text " +
  "kyx_intent, and expect honest refusals: generation-by-description is " +
  "refused (candidates need in-app auditioning — use kyx_generate) and " +
  "destructive ops stay locked until the user allows them in the KYX window.";

function negotiateProtocolVersion(requested) {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[0];
}

function write(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function forwardToBridge(rpc) {
  const response = await fetch(BRIDGE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.KYX_MCP_TOKEN || ""}`,
    },
    body: JSON.stringify(rpc),
  });
  if (response.status === 204) return undefined;
  const parsed = await response.json();
  if (parsed.error) {
    const error = new Error(parsed.error.message || "bridge error");
    error.code = parsed.error.code;
    throw error;
  }
  return parsed.result;
}

async function handleRequest(rpc) {
  // JSON-RPC batching was removed in 2025-06-18. Keep it only for clients
  // that explicitly negotiated the earlier 2025-03-26 protocol.
  if (Array.isArray(rpc)) {
    if (negotiatedProtocolVersion !== "2025-03-26") {
      return rpcError(null, -32600, "JSON-RPC batching is unavailable in this protocol version; use kyx_batch instead");
    }
    const responses = [];
    for (const item of rpc) {
      const response = await handleSingle(item);
      if (response !== undefined) responses.push(response);
    }
    return responses;
  }
  return handleSingle(rpc);
}

async function handleSingle(rpc) {
  // Modern (2026-07-28+) requests carry their version in per-request `_meta`;
  // unsupported versions answer UnsupportedProtocolVersionError.
  const modernVersion = requestProtocolVersion(rpc.params);
  const modern = modernVersion != null;
  if (modern && !SUPPORTED_PROTOCOL_VERSIONS.includes(modernVersion)) {
    return unsupportedProtocolError(rpc.id ?? null, modernVersion);
  }
  if (rpc.method === "server/discover") {
    if (!modern) return rpcError(rpc.id ?? null, -32601, `method not found: ${rpc.method}`);
    return rpcResult(rpc.id ?? null, {
      resultType: "complete",
      supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
      capabilities: { tools: {}, resources: {} },
      _meta: { [META_SERVER_INFO]: SERVER_INFO },
      instructions: SERVER_INSTRUCTIONS,
    });
  }
  if (rpc.method === "initialize") {
    negotiatedProtocolVersion = negotiateProtocolVersion(rpc.params?.protocolVersion);
    return rpcResult(
      rpc.id ?? null,
      withServerMeta(
        {
          protocolVersion: negotiatedProtocolVersion,
          capabilities: { tools: {}, resources: {} },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        },
        modern,
      ),
    );
  }
  if (rpc.method === "notifications/initialized") return undefined;
  if (rpc.method === "ping") return rpcResult(rpc.id ?? null, withServerMeta({}, modern));
  if (rpc.method === "tools/list") {
    if (!process.env.KYX_MCP_TOKEN) return rpcError(rpc.id ?? null, -32001, "KYX_MCP_TOKEN is not set");
    // Legacy 2025-03-26 predates outputSchema; strip it for that era only.
    const tools =
      !modern && negotiatedProtocolVersion === "2025-03-26"
        ? MCP_TOOL_DEFS.map(({ outputSchema, ...tool }) => tool)
        : MCP_TOOL_DEFS;
    return rpcResult(rpc.id ?? null, withServerMeta({ tools }, modern));
  }
  if (rpc.method === "resources/list") {
    if (!process.env.KYX_MCP_TOKEN) return rpcError(rpc.id ?? null, -32001, "KYX_MCP_TOKEN is not set");
    return rpcResult(rpc.id ?? null, withServerMeta({ resources: MCP_RESOURCE_DEFS }, modern));
  }
  if (rpc.method === "resources/read") {
    if (!process.env.KYX_MCP_TOKEN) return rpcError(rpc.id ?? null, -32001, "KYX_MCP_TOKEN is not set");
    const uri = String(rpc.params?.uri ?? "");
    if (!MCP_RESOURCE_DEFS.some((resource) => resource.uri === uri)) {
      return rpcError(rpc.id ?? null, -32602, `unknown resource: ${uri}`);
    }
    // Content is live in the KYX window — relay through the hidden channel.
    const result = await forwardToBridge({
      jsonrpc: "2.0",
      id: rpc.id ?? 0,
      method: "tools/call",
      params: { name: "__kyx_resource", arguments: { uri } },
    });
    const text = result?.content?.[0]?.text ?? "";
    return rpcResult(
      rpc.id ?? null,
      withServerMeta({ resultType: "complete", contents: [{ uri, mimeType: "text/plain", text }] }, modern),
    );
  }
  if (rpc.method === "tools/call") {
    if (!process.env.KYX_MCP_TOKEN) return rpcError(rpc.id ?? null, -32001, "KYX_MCP_TOKEN is not set");
    if (!MCP_TOOL_DEFS.some((tool) => tool.name === rpc.params?.name)) {
      return rpcError(rpc.id ?? null, -32602, `unknown tool: ${String(rpc.params?.name)}`);
    }
    const result = await forwardToBridge(rpc);
    if (!modern && negotiatedProtocolVersion === "2025-03-26" && result != null && typeof result === "object") {
      const { structuredContent: _structuredContent, ...legacyResult } = result;
      return rpcResult(rpc.id ?? null, legacyResult);
    }
    return rpcResult(rpc.id ?? null, withServerMeta(result, modern));
  }
  return rpcError(rpc.id ?? null, -32601, `method not found: ${rpc.method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line === "") continue;
    let rpc;
    try {
      rpc = JSON.parse(line);
    } catch {
      write(rpcError(null, -32700, "Parse error"));
      continue;
    }
    handleRequest(rpc)
      .then((response) => {
        if (response != null) write(response);
      })
      .catch((error) => {
        write(rpcError(rpc?.id ?? null, -32603, error instanceof Error ? error.message : String(error)));
      });
  }
});
process.stdin.on("end", () => process.exit(0));

process.on("disconnect", () => process.exit(0));
