/**
 * KYX MCP BRIDGE SERVER — loopback HTTP JSON-RPC endpoint (Phase D2, the
 * desktop stdio transport's local half).
 *
 * An external MCP client (Claude Desktop & co.) spawns desktop/mcp-server.cjs
 * over stdio; that forwarder POSTs every tools/call HERE — into the Electron
 * main process — and the host relays it to the renderer, where the
 * deterministic command layer executes it (clamps, strict targets, undo).
 *
 * Security model (docs/INTENT-MCP-EXPANSION-PLAN.md §D4):
 *  - binds 127.0.0.1 ONLY (never 0.0.0.0) — the loopback is the boundary
 *  - every request needs the shared token (constant-time compare)
 *  - opt-in: the bridge does not exist until the user enables MCP
 *  - the MCP layer is a transport, never a bypass — no document mutation
 *    happens outside the command layer
 */
const { createServer } = require("node:http");
const { MCP_TOOL_DEFS, MCP_RESOURCE_DEFS } = require("./mcp-tool-defs.cjs");

const MAX_BODY_BYTES = 1_000_000;
const RPC_ERRORS = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601 };
// Rate limiting (C-security): a token bucket refilling at RATE_LIMIT_REFILL
// requests/minute with a burst capacity of RATE_LIMIT_BURST. The bucket is
// per-bridge-instance (there is exactly one bridge per KYX window) and
// starts full. 429 tells the client to back off; this is a cheap DoS guard,
// not a quota system — the auth token is still the primary gate.
const RATE_LIMIT_BURST = 30;
const RATE_LIMIT_REFILL_PER_SEC = 0.5; // 30/min sustained
let bucketTokens = RATE_LIMIT_BURST;
let bucketLastRefill = Date.now();

function tryConsumeToken() {
  const now = Date.now();
  const elapsed = (now - bucketLastRefill) / 1000;
  bucketLastRefill = now;
  bucketTokens = Math.min(RATE_LIMIT_BURST, bucketTokens + elapsed * RATE_LIMIT_REFILL_PER_SEC);
  if (bucketTokens >= 1) {
    bucketTokens -= 1;
    return true;
  }
  return false;
}

/** Test hook — resets the bucket to full. */
function resetRateLimitBucket() {
  bucketTokens = RATE_LIMIT_BURST;
  bucketLastRefill = Date.now();
}
/**
 * Protocol eras this server speaks (MCP 2026-07-28 "Versioning"): MODERN
 * (2026-07-28+) declares version/identity in per-request `_meta` and uses
 * `server/discover`; LEGACY (2025-11-25 and earlier) uses the `initialize`
 * handshake. A dual-era server serves both from the same endpoint.
 */
const PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS];
const UNSUPPORTED_PROTOCOL_CODE = -32022;
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const SERVER_INFO = { name: "kyx-mcp-bridge", version: "1.0.0" };
const SERVER_INSTRUCTIONS =
  "KYX is a browser DAW whose MCP surface executes through the deterministic " +
  "command layer: every mutation is ONE undo step and returns a verification " +
  "read-back of the resulting state. Read before acting (kyx_state or the " +
  "kyx://project/* resources), prefer the structured tools over free-text " +
  "kyx_intent, and expect honest refusals: generation-by-description is " +
  "refused (candidates need in-app auditioning — use kyx_generate) and " +
  "destructive ops stay locked until the user allows them in the KYX window.";

/** MCP initialize version negotiation: echo the client's supported version,
 * otherwise answer with our latest. */
function negotiateProtocolVersion(requested) {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[0];
}

/** The modern per-request protocol version from `_meta`, or null. */
function requestProtocolVersion(params) {
  const meta = params?._meta;
  if (meta == null || typeof meta !== "object") return null;
  const version = meta[META_PROTOCOL_VERSION];
  return typeof version === "string" && version.length > 0 ? version : null;
}

/** Attach the server identity to a modern result's `_meta` (SHOULD). */
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

function discoverResult() {
  return {
    resultType: "complete",
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    capabilities: { tools: {}, resources: {} },
    _meta: { [META_SERVER_INFO]: SERVER_INFO },
    instructions: SERVER_INSTRUCTIONS,
  };
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Create the loopback bridge server.
 *
 * @param options
 * @param options.token       shared secret; empty string fails every request
 * @param options.executeTool (name, args) => Promise<{ text, mutated }>
 * @param options.port        preferred port (0 = ephemeral; the server binds
 *                            127.0.0.1 only)
 * @returns {{ server: import("node:http").Server, setExecutor(next): void }}
 *          — call server.listen() yourself
 */
function createMcpBridgeServer({ token, executeTool, port = 0 }) {
  void port;
  let toolExecutor = executeTool;

  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/rpc") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (!constantTimeEqual(req.headers.authorization ?? "", `Bearer ${token}`)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (!tryConsumeToken()) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "rate limited — slow down (bucket refill: 30/min)" }));
      return;
    }
    let body = "";
    let oversized = false;
    req.on("data", (chunk) => {
      // Drain but discard past the cap — destroy() would reset the socket
      // before the 413 can be delivered.
      if (!oversized) body += chunk;
      if (body.length > MAX_BODY_BYTES) oversized = true;
    });
    req.on("end", () => {
      if (oversized) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "payload too large" }));
        return;
      }
      let rpc;
      try {
        rpc = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify(rpcError(null, RPC_ERRORS.parse, "Parse error")));
        return;
      }
      const isBatch = Array.isArray(rpc);
      if (
        rpc == null ||
        typeof rpc !== "object" ||
        (!isBatch && (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string"))
      ) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify(rpcError(rpc?.id ?? null, RPC_ERRORS.invalidRequest, "Invalid Request")));
        return;
      }
      void handleRpc(rpc)
        .then((response) => {
          if (response === undefined) {
            // notifications need no body; close without content
            res.writeHead(204);
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(response));
        })
        .catch(() => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify(rpcError(rpc.id ?? null, -32603, "Internal error")));
        });
    });
  });

  async function handleRpc(rpc) {
    // JSON-RPC batch (2025-03-26): fan out; notifications yield no entry.
    if (Array.isArray(rpc)) {
      const responses = [];
      for (const item of rpc) {
        const response = await handleSingleRpc(item);
        if (response !== undefined) responses.push(response);
      }
      return responses;
    }
    return handleSingleRpc(rpc);
  }

  async function handleSingleRpc(rpc) {
    // Modern (2026-07-28+) requests declare their version in per-request
    // `_meta`; unsupported versions answer UnsupportedProtocolVersionError.
    const modernVersion = requestProtocolVersion(rpc.params);
    const modern = modernVersion != null;
    if (modern && !SUPPORTED_PROTOCOL_VERSIONS.includes(modernVersion)) {
      return unsupportedProtocolError(rpc.id ?? null, modernVersion);
    }
    if (rpc.method === "server/discover") {
      if (!modern) return rpcError(rpc.id ?? null, RPC_ERRORS.methodNotFound, `method not found: ${rpc.method}`);
      return rpcResult(rpc.id ?? null, discoverResult());
    }
    if (rpc.method === "initialize") {
      return rpcResult(
        rpc.id ?? null,
        withServerMeta(
          {
            protocolVersion: negotiateProtocolVersion(rpc.params?.protocolVersion),
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
    if (rpc.method === "tools/list")
      return rpcResult(
        rpc.id ?? null,
        withServerMeta({ ...(modern ? { resultType: "complete" } : {}), tools: MCP_TOOL_DEFS }, modern),
      );
    if (rpc.method === "resources/list")
      return rpcResult(
        rpc.id ?? null,
        withServerMeta({ ...(modern ? { resultType: "complete" } : {}), resources: MCP_RESOURCE_DEFS }, modern),
      );
    if (rpc.method === "resources/read") {
      const uri = String(rpc.params?.uri ?? "");
      if (!MCP_RESOURCE_DEFS.some((resource) => resource.uri === uri)) {
        return rpcError(rpc.id ?? null, -32602, `unknown resource: ${uri}`);
      }
      return callToolWrapped("__kyx_resource", { uri }, rpc.id ?? null, (payload) =>
        rpcResult(
          rpc.id ?? null,
          withServerMeta(
            { resultType: "complete", contents: [{ uri, mimeType: "text/plain", text: payload }] },
            modern,
          ),
        ),
      );
    }
    if (rpc.method === "tools/call") {
      const name = typeof rpc.params?.name === "string" ? rpc.params.name : "";
      const args = rpc.params?.arguments ?? {};
      if (!MCP_TOOL_DEFS.some((tool) => tool.name === name)) {
        return rpcError(rpc.id ?? null, -32602, `unknown tool: ${name}`);
      }
      return callToolWrapped(name, args, rpc.id ?? null, undefined, modern);
    }
    return rpcError(rpc.id ?? null, RPC_ERRORS.methodNotFound, `method not found: ${rpc.method}`);
  }

  async function callToolWrapped(name, args, id, mapResult, modern = false) {
    if (typeof toolExecutor !== "function") {
      return rpcResult(
        id,
        withServerMeta({ content: [{ type: "text", text: "no executor attached" }], isError: true }, modern),
      );
    }
    try {
      const result = await toolExecutor(name, args);
      if (typeof mapResult === "function") return mapResult(result?.text ?? "");
      const content = [{ type: "text", text: result?.text ?? "" }];
      if (result?.audio && typeof result.audio.data === "string" && typeof result.audio.mimeType === "string") {
        content.push({ type: "audio", data: result.audio.data, mimeType: result.audio.mimeType });
      }
      const payload = { resultType: "complete", content };
      const hasStructuredContent =
        result?.data != null && typeof result.data === "object" && !Array.isArray(result.data);
      if (hasStructuredContent) payload.structuredContent = result.data;
      const outputSchema = MCP_TOOL_DEFS.find((tool) => tool.name === name)?.outputSchema;
      const missingStructuredContent = outputSchema != null && result?.isError !== true && !hasStructuredContent;
      if (missingStructuredContent) {
        content[0].text = `tool ${name} did not return structuredContent required by its outputSchema — ${content[0].text}`;
      }
      if (result?.isError === true) payload.isError = true;
      if (missingStructuredContent) payload.isError = true;
      return rpcResult(id, withServerMeta(payload, modern));
    } catch (error) {
      if (typeof mapResult === "function") {
        return rpcError(id, -32603, error instanceof Error ? error.message : String(error));
      }
      return rpcResult(
        id,
        withServerMeta(
          {
            resultType: "complete",
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          },
          modern,
        ),
      );
    }
  }

  return {
    server,
    setExecutor(next) {
      toolExecutor = next;
    },
  };
}

module.exports = {
  createMcpBridgeServer,
  MCP_TOOL_DEFS,
  RATE_LIMIT_BURST,
  RATE_LIMIT_REFILL_PER_SEC,
  resetRateLimitBucket,
};
