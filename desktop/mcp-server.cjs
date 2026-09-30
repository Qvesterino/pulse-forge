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
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26"];
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
  // JSON-RPC batch (2025-03-26): an array line fans out; notifications
  // produce no response line.
  if (Array.isArray(rpc)) {
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
  if (rpc.method === "initialize") {
    return rpcResult(rpc.id ?? null, {
      protocolVersion: negotiateProtocolVersion(rpc.params?.protocolVersion),
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "kyx-mcp", version: "1.0.0" },
      instructions: SERVER_INSTRUCTIONS,
    });
  }
  if (rpc.method === "notifications/initialized") return undefined;
  if (rpc.method === "ping") return rpcResult(rpc.id ?? null, {});
  if (rpc.method === "tools/list") {
    if (!process.env.KYX_MCP_TOKEN) return rpcError(rpc.id ?? null, -32001, "KYX_MCP_TOKEN is not set");
    return rpcResult(rpc.id ?? null, { tools: MCP_TOOL_DEFS });
  }
  if (rpc.method === "resources/list") {
    if (!process.env.KYX_MCP_TOKEN) return rpcError(rpc.id ?? null, -32001, "KYX_MCP_TOKEN is not set");
    return rpcResult(rpc.id ?? null, { resources: MCP_RESOURCE_DEFS });
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
    return rpcResult(rpc.id ?? null, { contents: [{ uri, mimeType: "text/plain", text }] });
  }
  if (rpc.method === "tools/call") {
    if (!process.env.KYX_MCP_TOKEN) return rpcError(rpc.id ?? null, -32001, "KYX_MCP_TOKEN is not set");
    if (!MCP_TOOL_DEFS.some((tool) => tool.name === rpc.params?.name)) {
      return rpcError(rpc.id ?? null, -32602, `unknown tool: ${String(rpc.params?.name)}`);
    }
    const result = await forwardToBridge(rpc);
    return rpcResult(rpc.id ?? null, result);
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
