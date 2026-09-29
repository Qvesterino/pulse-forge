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
const { MCP_TOOL_DEFS } = require("./mcp-tool-defs.cjs");

const MAX_BODY_BYTES = 1_000_000;
const RPC_ERRORS = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601 };

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
      if (rpc == null || typeof rpc !== "object" || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
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
    if (rpc.method === "initialize") {
      return rpcResult(rpc.id ?? null, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "kyx-mcp-bridge", version: "1.0.0" },
      });
    }
    if (rpc.method === "notifications/initialized") return undefined;
    if (rpc.method === "ping") return rpcResult(rpc.id ?? null, {});
    if (rpc.method === "tools/list") return rpcResult(rpc.id ?? null, { tools: MCP_TOOL_DEFS });
    if (rpc.method === "tools/call") {
      const name = typeof rpc.params?.name === "string" ? rpc.params.name : "";
      const args = rpc.params?.arguments ?? {};
      if (typeof toolExecutor !== "function") {
        return rpcResult(rpc.id ?? null, {
          content: [{ type: "text", text: "no executor attached" }],
          isError: true,
        });
      }
      try {
        const result = await toolExecutor(name, args);
        const payload = { content: [{ type: "text", text: result?.text ?? "" }] };
        if (result?.isError === true) payload.isError = true;
        return rpcResult(rpc.id ?? null, payload);
      } catch (error) {
        return rpcResult(rpc.id ?? null, {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        });
      }
    }
    return rpcError(rpc.id ?? null, RPC_ERRORS.methodNotFound, `method not found: ${rpc.method}`);
  }

  return {
    server,
    setExecutor(next) {
      toolExecutor = next;
    },
  };
}

module.exports = { createMcpBridgeServer, MCP_TOOL_DEFS };
