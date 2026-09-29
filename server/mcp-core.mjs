/**
 * KYX MCP SERVER CORE — JSON-RPC framing + auth + session relay plumbing.
 *
 * Pure and dependency-free so vitest can import it directly. The collab
 * server wires this into its HTTP server:
 *
 *   POST /mcp         — MCP JSON-RPC (initialize / tools/list / tools/call),
 *                       Authorization: Bearer <MCP_TOKEN>
 *   WS  /mcp-relay?token=<MCP_TOKEN> — the connected KYX browser session
 *                       that EXECUTES tool calls (services live there)
 *
 * Security model (docs/INTENT-MCP-EXPANSION-PLAN.md §D4): the endpoint is
 * opt-in — without the MCP_TOKEN env var the hub refuses everything with
 * 404-style "disabled", so an unconfigured deployment costs nothing and
 * leaks nothing. Every tool call is relayed to the KYX window and executed
 * through the deterministic command layer — the MCP layer is a transport,
 * never a bypass.
 */

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "kyx-mcp", version: "1.0.0" };
const CALL_TIMEOUT_MS = 15_000;

export function isValidToken(token, expected) {
  const t = String(token ?? "").trim();
  const e = String(expected ?? "").trim();
  if (e.length === 0) return false; // no token configured → server disabled
  if (t.length !== e.length) return false; // length check avoids timing leak on length
  let diff = 0;
  for (let i = 0; i < e.length; i++) diff |= t.charCodeAt(i) ^ e.charCodeAt(i);
  return diff === 0;
}

/** Parse a JSON-RPC 2.0 request body. Returns a typed envelope or an error. */
export function parseRpc(body) {
  let rpc;
  try {
    rpc = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, error: rpcError(null, -32700, "Parse error") };
  }
  if (rpc == null || typeof rpc !== "object" || Array.isArray(rpc)) {
    return { ok: false, error: rpcError(null, -32600, "Invalid Request") };
  }
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return { ok: false, error: rpcError(rpc.id ?? null, -32600, "Invalid Request") };
  }
  return { ok: true, id: rpc.id, method: rpc.method, params: rpc.params ?? {} };
}

export function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32601,
};

/** Static MCP tool descriptors the server advertises (execution is relayed
 * to the KYX window — the server holds no project state). */
export const MCP_TOOL_DEFS = [
  {
    name: "kyx_intent",
    description:
      "Drive the KYX DAW with a natural-language producer instruction (EN/SK): " +
      '"mute the drums", "zníž basu", "set tempo to 140", "more reverb send on the lead". ' +
      "Executes through the deterministic command layer and returns a verification read-back.",
    inputSchema: {
      type: "object",
      properties: { instruction: { type: "string", description: "Producer instruction, EN or SK" } },
      required: ["instruction"],
    },
  },
  {
    name: "kyx_state",
    description: "Read-only project snapshot: tempo, key, track list, markers, groove, or the FX chain of one family.",
    inputSchema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          enum: ["overview", "tempo", "key", "tracks", "markers", "groove", "fxChain"],
        },
        family: { type: "string" },
      },
      required: ["subject"],
    },
  },
  {
    name: "kyx_undo",
    description: "Undo or redo the last N document commands (default 1).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["undo", "redo"] },
        steps: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["action"],
    },
  },
  {
    name: "kyx_transport",
    description: "Transport control: play, stop, pause, loop on/off, metronome on/off.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["play", "stop", "pause", "loopOn", "loopOff", "metronomeOn", "metronomeOff"] },
      },
      required: ["action"],
    },
  },
  {
    name: "kyx_export",
    description: "Request a bounce of the current project. The download happens in the KYX app window.",
    inputSchema: {
      type: "object",
      properties: { format: { type: "string", enum: ["wav", "mp3"] } },
      required: ["format"],
    },
  },
  {
    name: "kyx_generate",
    description: "Generate a new pattern from an intent spec (deterministic engine, one undo step).",
    inputSchema: {
      type: "object",
      properties: {
        genre: {
          type: "string",
          enum: [
            "house",
            "techno",
            "trap",
            "ambient",
            "drill",
            "phonk",
            "jersey",
            "dnb",
            "ukg",
            "amapiano",
            "postrock",
            "drone",
            "chiptune",
            "eurodance",
            "latin",
          ],
        },
        seed: { type: "string" },
        energy: { type: "number", minimum: 0, maximum: 1 },
        density: { type: "number", minimum: 0, maximum: 1 },
        bpm: { type: "integer", minimum: 40, maximum: 220 },
        roles: {
          type: "array",
          items: { type: "string", enum: ["drums", "bass", "chords", "lead"] },
        },
      },
      required: ["genre"],
    },
  },
  {
    name: "kyx_groove",
    description:
      "Groove/swing: global (no section) adjusts project swing; section-scoped " +
      "bakes microtiming into that section's pattern.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["more", "less", "tighter", "set"] },
        section: {
          type: "string",
          enum: ["intro", "build", "chorus", "verse", "bridge", "drop", "break", "outro", "fill"],
        },
        percent: { type: "integer", minimum: 0, maximum: 100 },
      },
      required: ["direction"],
    },
  },
  {
    name: "kyx_fx",
    description:
      "Structured effect op on a track family: more/less turn the primary knob, " +
      "remove deletes, bypass/enable flags instances.",
    inputSchema: {
      type: "object",
      properties: {
        effect: {
          type: "string",
          enum: [
            "reverb",
            "delay",
            "saturation",
            "distortion",
            "chorus",
            "flanger",
            "phaser",
            "tremolo",
            "bitcrusher",
            "compressor",
            "pump",
            "eq",
          ],
        },
        family: { type: "string", enum: ["drums", "bass", "chords", "lead", "vocal"] },
        action: { type: "string", enum: ["more", "less", "remove", "bypass", "enable"] },
      },
      required: ["effect", "family", "action"],
    },
  },
  {
    name: "kyx_sections",
    description: "Arrangement ops on named sections (intro/drop/chorus/...).",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add", "remove", "duplicate", "reorder", "resize"] },
        role: {
          type: "string",
          enum: ["intro", "build", "chorus", "verse", "bridge", "drop", "break", "outro", "fill"],
        },
        bars: { type: "integer", minimum: 1, maximum: 64 },
      },
      required: ["op", "role"],
    },
  },
  {
    name: "kyx_markers",
    description: "Add a cue marker at a bar, or remove the marker nearest a bar.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add", "remove"] },
        bar: { type: "integer", minimum: 1 },
        name: { type: "string" },
      },
      required: ["op", "bar"],
    },
  },
  {
    name: "kyx_tracks",
    description:
      "Track CRUD: add drum/instrument track, remove or rename by family. " + "Removing the last track is declined.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["addDrum", "addInstrument", "remove", "rename"] },
        family: {
          type: "string",
          enum: ["drums", "bass", "lead", "chords", "kick", "snare", "clap", "hat", "perc", "tom"],
        },
        instrument: {
          type: "string",
          enum: ["analog", "bass", "808", "keys", "pluck", "acid", "reese", "brass", "flute", "sampler"],
        },
        name: { type: "string" },
      },
      required: ["op"],
    },
  },
];

/**
 * MCP hub — owns the one authenticated KYX relay session and turns tool
 * calls into forwarded requests. `sendToSession(payload)` is injected by
 * the host (collab server ws / desktop IPC).
 */
export function createMcpHub({ token, sendToSession, callTimeoutMs = CALL_TIMEOUT_MS }) {
  let sessionConnected = false;
  let nextCallId = 1;
  const pendingCalls = new Map();

  return {
    /** Relay session connected (KYX window). */
    connectSession() {
      sessionConnected = true;
    },
    disconnectSession() {
      sessionConnected = false;
      for (const [, entry] of pendingCalls) {
        clearTimeout(entry.timer);
        entry.reject(new Error("KYX session disconnected"));
      }
      pendingCalls.clear();
    },
    hasSession() {
      return sessionConnected;
    },
    /** Forward a tool call to the KYX session; resolves the result text. */
    async callTool(name, args) {
      if (!sessionConnected) throw new Error("KYX session not connected — open KYX and enable MCP");
      const id = nextCallId++;
      const payload = { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args ?? {} } };
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingCalls.delete(id);
          reject(new Error("KYX session timed out"));
        }, callTimeoutMs);
        pendingCalls.set(id, { resolve, reject, timer });
      });
      sendToSession(payload);
      return promise;
    },
    /** Resolve a forwarded call response arriving from the relay. */
    handleSessionMessage(message) {
      if (!sessionConnected) return false;
      if (message == null || typeof message !== "object") return false;
      if (message.type === "mcp-result" && pendingCalls.has(message.id)) {
        const entry = pendingCalls.get(message.id);
        pendingCalls.delete(message.id);
        clearTimeout(entry.timer);
        // resolve with the RESULT OBJECT ({ text, mutated }) — the RPC layer
        // reads result.text
        entry.resolve(
          message.result != null && typeof message.result === "object"
            ? message.result
            : { text: String(message.result ?? "") },
        );
        return true;
      }
      return false;
    },
    pendingCount() {
      return pendingCalls.size;
    },
  };
}

/**
 * Handle one JSON-RPC request against the hub. Returns the JSON-RPC
 * response object. `forwardTool` is async (relays to the KYX session).
 */
export async function handleMcpRequest(hub, expectedToken, authHeader, body) {
  if (!isValidToken(authHeader, expectedToken)) {
    return rpcError(null, -32001, "unauthorized (missing or wrong MCP token)");
  }
  if (!hub.hasSession()) {
    return rpcError(null, -32002, "KYX session not connected — open KYX and enable MCP");
  }
  const parsed = parseRpc(body);
  if (!parsed.ok) return parsed.error;

  if (parsed.method === "initialize") {
    return rpcResult(parsed.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (parsed.method === "notifications/initialized") {
    return undefined; // notification — no response
  }
  if (parsed.method === "tools/list") {
    return rpcResult(parsed.id, { tools: MCP_TOOL_DEFS });
  }
  if (parsed.method === "tools/call") {
    const name = parsed.params?.name;
    if (typeof name !== "string" || !MCP_TOOL_DEFS.some((tool) => tool.name === name)) {
      return rpcError(parsed.id, rpcErrorsInvalidParams(), `unknown tool: ${String(name)}`);
    }
    try {
      const result = await hub.callTool(name, parsed.params?.arguments ?? {});
      return rpcResult(parsed.id, {
        content: [{ type: "text", text: result.text ?? "" }],
        isError: result.mutated === false && result.text.startsWith("unknown"),
      });
    } catch (error) {
      return rpcResult(parsed.id, {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      });
    }
  }
  if (parsed.method === "ping") {
    return rpcResult(parsed.id, {});
  }
  return rpcError(parsed.id, RPC_ERRORS.methodNotFound, `method not found: ${parsed.method}`);
}

function rpcErrorsInvalidParams() {
  return -32602;
}
