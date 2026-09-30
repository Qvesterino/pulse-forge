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
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26"];
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
    if (rpc.method === "initialize") {
      return rpcResult(rpc.id ?? null, {
        protocolVersion: negotiateProtocolVersion(rpc.params?.protocolVersion),
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "kyx-mcp-bridge", version: "1.0.0" },
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    if (rpc.method === "notifications/initialized") return undefined;
    if (rpc.method === "ping") return rpcResult(rpc.id ?? null, {});
    if (rpc.method === "tools/list") return rpcResult(rpc.id ?? null, { tools: MCP_TOOL_DEFS });
    if (rpc.method === "resources/list") return rpcResult(rpc.id ?? null, { resources: MCP_RESOURCE_DEFS });
    if (rpc.method === "resources/read") {
      const uri = String(rpc.params?.uri ?? "");
      if (!MCP_RESOURCE_DEFS.some((resource) => resource.uri === uri)) {
        return rpcError(rpc.id ?? null, -32602, `unknown resource: ${uri}`);
      }
      return callToolWrapped("__kyx_resource", { uri }, rpc.id ?? null, (payload) =>
        rpcResult(rpc.id ?? null, {
          contents: [{ uri, mimeType: "text/plain", text: payload }],
        }),
      );
    }
    if (rpc.method === "tools/call") {
      const name = typeof rpc.params?.name === "string" ? rpc.params.name : "";
      const args = rpc.params?.arguments ?? {};
      if (!MCP_TOOL_DEFS.some((tool) => tool.name === name)) {
        return rpcError(rpc.id ?? null, -32602, `unknown tool: ${name}`);
      }
      return callToolWrapped(name, args, rpc.id ?? null);
    }
    return rpcError(rpc.id ?? null, RPC_ERRORS.methodNotFound, `method not found: ${rpc.method}`);
  }

  async function callToolWrapped(name, args, id, mapResult) {
    if (typeof toolExecutor !== "function") {
      return rpcResult(id, {
        content: [{ type: "text", text: "no executor attached" }],
        isError: true,
      });
    }
    try {
      const result = await toolExecutor(name, args);
      if (typeof mapResult === "function") return mapResult(result?.text ?? "");
      const payload = { content: [{ type: "text", text: result?.text ?? "" }] };
      if (result?.isError === true) payload.isError = true;
      return rpcResult(id, payload);
    } catch (error) {
      if (typeof mapResult === "function") {
        return rpcError(id, -32603, error instanceof Error ? error.message : String(error));
      }
      return rpcResult(id, {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      });
    }
  }

  return {
    server,
    setExecutor(next) {
      toolExecutor = next;
    },
  };
}

module.exports = { createMcpBridgeServer, MCP_TOOL_DEFS };
