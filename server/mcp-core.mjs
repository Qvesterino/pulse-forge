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

/**
 * Protocol eras this server speaks (MCP 2026-07-28 "Versioning"):
 *
 *  - MODERN (2026-07-28+): no handshake. Every request carries its version,
 *    identity and capabilities in `_meta` (`io.modelcontextprotocol/...`),
 *    and `server/discover` advertises what we support. Version mismatches
 *    answer `UnsupportedProtocolVersionError` (-32022).
 *  - LEGACY (2025-11-25 and earlier): the `initialize`/`initialized`
 *    handshake establishes a session and the negotiated version governs it.
 *
 * A dual-era server picks its behavior from how the client opens: a request
 * carrying modern `_meta` is served statelessly; an `initialize` selects
 * legacy semantics for that session. Both eras run on the same endpoint.
 */
export const PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS];
const UNSUPPORTED_PROTOCOL_CODE = -32022;
const STRUCTURED_OUTPUT_PROTOCOL_VERSIONS = new Set([PROTOCOL_VERSION, "2025-11-25", "2025-06-18"]);
const JSON_RPC_BATCH_PROTOCOL_VERSIONS = new Set(["2025-03-26", "2024-11-05", "2024-10-07"]);
const negotiatedProtocolVersionByHub = new WeakMap();
/** _meta keys defined by the modern protocol (2026-07-28 basic/index#meta). */
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const SERVER_INFO = { name: "kyx-mcp", version: "1.0.0" };
const SERVER_INSTRUCTIONS =
  "KYX is a browser DAW whose MCP surface executes through the deterministic " +
  "command layer: every mutation is ONE undo step and returns a verification " +
  "read-back of the resulting state. Read before acting (kyx_state or the " +
  "kyx://project/* resources), prefer the structured tools over free-text " +
  "kyx_intent, and expect honest refusals: generation-by-description is " +
  "refused (candidates need in-app auditioning — use kyx_generate) and " +
  "destructive ops stay locked until the user allows them in the KYX window.";

/** MCP initialize version negotiation: echo the client's version when we
 * support it, otherwise answer with our latest. */
export function negotiateProtocolVersion(requested) {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : PROTOCOL_VERSION;
}

function supportsStructuredOutput(protocolVersion) {
  return STRUCTURED_OUTPUT_PROTOCOL_VERSIONS.has(protocolVersion);
}

/** The modern per-request protocol version from `_meta`, or null. */
export function requestProtocolVersion(params) {
  const meta = params?._meta;
  if (meta == null || typeof meta !== "object") return null;
  const version = meta[META_PROTOCOL_VERSION];
  return typeof version === "string" && version.length > 0 ? version : null;
}

/** True when the request declares a modern (2026-07-28+) protocol version. */
export function isModernRequest(params) {
  return requestProtocolVersion(params) != null;
}

/** `server/discover` result (2026-07-28): supported versions + identity. */
export function discoverResult() {
  return {
    resultType: "complete",
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    capabilities: { tools: {}, resources: {} },
    _meta: { [META_SERVER_INFO]: SERVER_INFO },
    instructions: SERVER_INSTRUCTIONS,
  };
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
const CALL_TIMEOUT_MS = 15_000;
const LONG_CALL_TIMEOUT_MS = 60_000;
const LONG_RUNNING_MCP_TOOLS = new Set([
  "kyx_export",
  "kyx_audio_preview",
  "kyx_loudness",
  "kyx_import_sfz",
  "kyx_batch",
  "kyx_render_summary",
  "kyx_diagnose_mix",
  "kyx_arrange",
  "kyx_song",
]);

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
 * to the KYX window — the server holds no project state).
 *
 * VERBATIM MIRROR of MCP_TOOLS in src/mcp/tools.ts (names + descriptions +
 * input schemas). tests/mcp-core.test.ts pins this list against the TS
 * source — change the tool surface THERE, then copy it here. */
export const MCP_TOOL_DEFS = [
  {
    name: "kyx_intent",
    description:
      'Drive the KYX DAW with a natural-language producer instruction (EN/SK): "mute the drums", "zníž basu", "set tempo to 140", "more reverb send on the lead", "more swing in the drop". Executes through the deterministic command layer (one undo step) and returns a verification read-back of the resulting state. Generation requests are refused (candidates need in-app auditioning).',
    inputSchema: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "Producer instruction, EN or SK",
        },
        dry_run: {
          type: "boolean",
          description:
            "Plan only: return the resolved target, current→proposed values, clamps and warnings without mutating the project.",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["instruction"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        status: {
          type: "string",
        },
        stage: {
          type: "string",
          enum: ["read", "runtime", "applied", "persisted", "rendered", "delivered", "dry-run", "replayed", "noop"],
        },
        changed: {
          type: "boolean",
        },
        readback: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 32,
        },
        route: {
          type: "string",
        },
        moved: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
          },
          maxItems: 128,
        },
        added: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
          },
          maxItems: 128,
        },
        unchanged: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
          },
          maxItems: 128,
        },
        skipped: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
          },
          maxItems: 128,
        },
      },
      required: ["status", "stage"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_state",
    description:
      "Read-only project snapshot: tempo, key, time signature, track list, markers, groove, the ACTIVE pattern's step grid, the arrangement scenes, the send routing map (returns + per-track send levels), the undo history, the FX chain of one family, or this session's transport capabilities (hooks + cancellation contract). Never mutates.",
    inputSchema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          enum: [
            "overview",
            "tempo",
            "key",
            "tracks",
            "markers",
            "groove",
            "fxChain",
            "mixer",
            "sends",
            "pattern",
            "scenes",
            "history",
            "reference",
            "model-misses",
            "automation",
            "capabilities",
            "projects",
          ],
          description: "Which part of the project state to return",
        },
        family: {
          type: "string",
          enum: ["kick", "snare", "clap", "hat", "perc", "tom", "bass", "lead", "chords", "drums"],
          description: "Optional track family filter for fxChain and sends",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["subject"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        status: {
          type: "string",
        },
        stage: {
          type: "string",
          enum: ["read", "runtime", "applied", "persisted", "rendered", "delivered", "dry-run", "replayed", "noop"],
        },
        changed: {
          type: "boolean",
        },
        readback: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 32,
        },
        subject: {
          type: "string",
        },
        name: {
          type: "string",
        },
        bpm: {
          type: "number",
        },
        capabilities: {
          type: "object",
          additionalProperties: true,
        },
        projects: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
          },
          maxItems: 500,
        },
        mixer: {
          type: ["object", "null"],
          additionalProperties: true,
        },
      },
      required: ["status", "stage", "subject"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "kyx_save",
    description:
      'Force the autosave pipeline to flush the CURRENT project to the repository and report the durable result. `op:"saveAs"` saves a COPY under `name` and leaves the current project open (switching the open document is a human ProjectBrowser action); it requires `confirm:true`. Use this before ending an agent session when you need a persistence receipt; `mutated` is false. Refused honestly on transports without a repository hook.',
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["save", "saveAs"],
          description: "Default save (flush the current project)",
        },
        name: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description: "Copy name — required for saveAs; the current project keeps its name and stays open",
        },
        confirm: {
          type: "boolean",
          description: "saveAs only: true acknowledges that a NEW project record will be created",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: {
          type: "boolean",
        },
        saveStatus: {
          type: "string",
          enum: ["saved", "dirty", "saving", "syncing", "error"],
        },
        lastSavedAt: {
          type: ["string", "null"],
        },
        projectId: {
          type: "string",
        },
        name: {
          type: "string",
        },
        note: {
          type: "string",
        },
        stage: {
          type: "string",
          enum: ["persisted"],
        },
      },
      required: ["ok", "saveStatus", "stage"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_undo",
    description: "Undo or redo the last N document commands (default 1). Declined while a mic take is recording.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["undo", "redo"],
        },
        steps: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Default 1",
        },
        allowForeign: {
          type: "boolean",
          description:
            "Attributed agents only: consent to revert work made by OTHERS (another agent or the human). Refused without it when the top of history is foreign work.",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["action"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["undo", "redo"],
        },
        requestedSteps: {
          type: "integer",
          minimum: 1,
          maximum: 20,
        },
        completedSteps: {
          type: "integer",
          minimum: 0,
          maximum: 20,
        },
        revertedLabels: {
          type: "array",
          maxItems: 20,
          items: {
            type: "string",
            maxLength: 240,
          },
        },
        partialFailure: {
          type: "string",
          maxLength: 2000,
        },
      },
      required: ["action", "requestedSteps", "completedSteps", "revertedLabels"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_transport",
    description:
      "Transport control AND reads: play, stop, pause, loop on/off, metronome on/off — or seek to a 1-based bar (optional beat), set the loop region in bars (loopRegion), or state: a read-only read-back of the playhead position (bar/beat/tick), playing state, loop region and metronome. Bar controls are bounded to 1..8192; fractional bar/beat values are rejected. Scene launch accepts an exact sceneId, name/role, or 1-based index. Bar and beat coordinates follow the project's time signature.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "play",
            "stop",
            "pause",
            "loopOn",
            "loopOff",
            "metronomeOn",
            "metronomeOff",
            "seek",
            "loopRegion",
            "launchScene",
            "state",
          ],
        },
        bar: {
          type: "integer",
          minimum: 1,
          maximum: 8192,
          description: "For seek — 1-based destination bar",
        },
        scene: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: 'launchScene — scene NAME or ROLE (e.g. "drop", "chorus")',
        },
        sceneId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "launchScene — exact scene ID",
        },
        index: {
          type: "integer",
          minimum: 1,
          maximum: 1000000,
          description: "launchScene — 1-based index as kyx_state scenes lists them (alternative to scene)",
        },
        play: {
          type: "boolean",
          description: "launchScene — start playback after the jump (default true)",
        },
        beat: {
          type: "integer",
          minimum: 1,
          maximum: 16,
          description:
            "For seek — 1-based beat within the project's meter (default 1; runtime validates this meter's numerator)",
        },
        startBar: {
          type: "integer",
          minimum: 1,
          maximum: 8192,
          description: "For loopRegion — first looped bar (1-based)",
        },
        endBar: {
          type: "integer",
          minimum: 2,
          maximum: 8192,
          description: "For loopRegion — last looped bar (inclusive; must be > startBar)",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["action"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["read", "applied", "partial"],
        },
        action: {
          type: "string",
          enum: [
            "play",
            "stop",
            "pause",
            "loopOn",
            "loopOff",
            "metronomeOn",
            "metronomeOff",
            "seek",
            "loopRegion",
            "launchScene",
            "state",
          ],
        },
        positionTick: {
          type: ["integer", "null"],
          minimum: 0,
        },
        bar: {
          type: ["integer", "null"],
          minimum: 1,
        },
        beat: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 16,
        },
        playing: {
          type: ["boolean", "null"],
        },
        paused: {
          type: ["boolean", "null"],
        },
        loop: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: {
              type: ["boolean", "null"],
            },
            startTick: {
              type: ["integer", "null"],
              minimum: 0,
            },
            endTick: {
              type: ["integer", "null"],
              minimum: 0,
            },
            startBar: {
              type: ["integer", "null"],
              minimum: 1,
            },
            endBar: {
              type: ["integer", "null"],
              minimum: 1,
            },
          },
          required: ["enabled", "startTick", "endTick", "startBar", "endBar"],
        },
        metronome: {
          type: ["boolean", "null"],
        },
        requestedTick: {
          type: "integer",
          minimum: 0,
          maximum: 15728640,
        },
        requestedBar: {
          type: "integer",
          minimum: 1,
          maximum: 8192,
        },
        requestedBeat: {
          type: "integer",
          minimum: 1,
          maximum: 16,
        },
        requestedStartBar: {
          type: "integer",
          minimum: 1,
          maximum: 8192,
        },
        requestedEndBar: {
          type: "integer",
          minimum: 2,
          maximum: 8192,
        },
        sceneId: {
          type: "string",
        },
        sceneName: {
          type: "string",
        },
        sceneRole: {
          type: ["string", "null"],
        },
        sceneBar: {
          type: "integer",
          minimum: 1,
          maximum: 8192,
        },
        playRequested: {
          type: "boolean",
        },
      },
      required: ["status", "action", "positionTick", "bar", "beat", "playing", "paused", "loop", "metronome"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_export",
    description:
      "Bounce the current project: full mix (WAV 16/24/32-bit, MP3 320) or a STEMS zip (stems: all | drums | bass | music — stem projects bypass the master chain, same as the ExportPanel stem flow). sampleRate selects the render rate. The render runs in the KYX window and the tool AWAITS it — the result carries the completion report (duration, size). Render/generation calls get an extended 60 s MCP window; exceptionally long jobs may still time out, while the download lands in the app.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["wav", "mp3"],
        },
        sampleRate: {
          type: "number",
          enum: [44100, 48000, 96000],
          description: "Render sample rate (default 44100)",
        },
        bitDepth: {
          type: "number",
          enum: [16, 24, 32],
          description: "WAV bit depth (default 16; ignored for mp3)",
        },
        stems: {
          type: "string",
          enum: ["all", "drums", "bass", "music"],
          description: "Render stem groups into one zip instead of the full mix",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["format"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        status: {
          type: "string",
        },
        stage: {
          type: "string",
          enum: ["read", "runtime", "applied", "persisted", "rendered", "delivered", "dry-run", "replayed", "noop"],
        },
        changed: {
          type: "boolean",
        },
        readback: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 32,
        },
        format: {
          type: "string",
        },
        durationSeconds: {
          type: ["number", "null"],
        },
        sizeBytes: {
          type: ["integer", "null"],
        },
      },
      required: ["status", "stage"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_audio_preview",
    description:
      "Audition the opening of the CURRENT project without changing it or downloading a file. Returns a short stereo WAV as standard MCP audio content so compatible agents can listen before suggesting or applying edits. Defaults to 2 bars; previews are capped at 4 bars. This is a quick listening pass, not a full-quality export.",
    inputSchema: {
      type: "object",
      properties: {
        bars: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "Opening bars to render (default 2, maximum 4)",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        bars: {
          type: "number",
        },
        durationSec: {
          type: "number",
        },
        sampleRate: {
          type: "number",
        },
        byteLength: {
          type: "number",
        },
        mimeType: {
          type: "string",
        },
      },
      required: ["bars", "durationSec", "sampleRate", "byteLength", "mimeType"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_generate",
    description:
      'Generate a new pattern from an intent spec (deterministic engine, one undo step). Returns the pattern name and resolved BPM. replaceMode:"replace" overwrites the active pattern and requires the destructive-operation unlock; the default adds a new pattern.',
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
        seed: {
          type: "string",
          description: "Deterministic seed (same seed = same pattern)",
        },
        energy: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        density: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        bpm: {
          type: "integer",
          minimum: 40,
          maximum: 220,
        },
        bars: {
          type: "integer",
          minimum: 1,
          maximum: 16,
          description:
            "Metrical bars; the maximum depends on the meter and 128-step pattern limit (default engine choice)",
        },
        replaceMode: {
          type: "string",
          enum: ["new", "replace"],
          description:
            "replace = overwrite the active pattern in place (requires the destructive unlock; default: add a new pattern)",
        },
        roles: {
          type: "array",
          items: {
            type: "string",
            enum: ["drums", "bass", "chords", "lead"],
          },
          description: "Which roles the pattern plays (default all)",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["genre"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        status: {
          type: "string",
        },
        stage: {
          type: "string",
          enum: ["read", "runtime", "applied", "persisted", "rendered", "delivered", "dry-run", "replayed", "noop"],
        },
        changed: {
          type: "boolean",
        },
        readback: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 32,
        },
        patternId: {
          type: "string",
        },
        patternName: {
          type: "string",
        },
        replaceMode: {
          type: "string",
          enum: ["new", "replace"],
        },
        seed: {
          type: "string",
        },
      },
      required: ["status", "stage"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_groove",
    description:
      "Groove/swing control. Globally, more/less adjust swing by 10 percentage points; tighter reduces swing and timing humanization; set chooses an absolute swing (omitted percent = 50). With section or sectionId, the canonical command bakes microtiming into that scene's pattern. A role must match one scene; repeated roles require the stable sectionId.",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["more", "less", "tighter", "set"],
        },
        section: {
          type: "string",
          enum: ["intro", "build", "chorus", "verse", "bridge", "drop", "break", "outro", "fill"],
          description: "Target a unique scene role. Omit both section and sectionId for global groove.",
        },
        sectionId: {
          type: "string",
          maxLength: 128,
          description: "Exact stable scene ID; use this when multiple scenes share the same role.",
        },
        percent: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description: "Only for direction 'set'; if omitted, the default is 50%.",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["direction"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: [
            "applied",
            "already_at_target",
            "missing_target",
            "no_pattern",
            "no_drum_track",
            "partial",
            "rejected",
          ],
        },
        scope: {
          type: "string",
          enum: ["global", "section"],
        },
        direction: {
          type: "string",
          maxLength: 16,
        },
        requestedPercent: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 100,
        },
        sectionId: {
          type: ["string", "null"],
          maxLength: 128,
        },
        sectionName: {
          type: ["string", "null"],
          maxLength: 256,
        },
        candidateSceneIds: {
          type: "array",
          items: {
            type: "string",
            maxLength: 128,
          },
          maxItems: 64,
        },
        candidateSceneCount: {
          type: "integer",
          minimum: 0,
        },
        patternId: {
          type: ["string", "null"],
          maxLength: 128,
        },
        swingBefore: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 1,
        },
        swingAfter: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 1,
        },
        humanizeTimingBefore: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 1,
        },
        humanizeTimingAfter: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 1,
        },
        humanizeVelocityBefore: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 1,
        },
        humanizeVelocityAfter: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 1,
        },
        averageAbsMicrotimingBefore: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 1,
        },
        averageAbsMicrotimingAfter: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 1,
        },
        changedCells: {
          type: "integer",
          minimum: 0,
        },
        undoSteps: {
          type: "integer",
          minimum: 0,
          maximum: 1,
        },
        reason: {
          type: ["string", "null"],
          maxLength: 512,
        },
      },
      required: [
        "status",
        "scope",
        "direction",
        "requestedPercent",
        "sectionId",
        "sectionName",
        "candidateSceneIds",
        "candidateSceneCount",
        "patternId",
        "swingBefore",
        "swingAfter",
        "humanizeTimingBefore",
        "humanizeTimingAfter",
        "humanizeVelocityBefore",
        "humanizeVelocityAfter",
        "averageAbsMicrotimingBefore",
        "averageAbsMicrotimingAfter",
        "changedCells",
        "undoSteps",
        "reason",
      ],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_fx",
    description:
      "Structured effect operation on a track family or ONE exact track: more/less turn the effect's PRIMARY knob (percent = relative step size), remove deletes instances (destructive-gated), bypass/enable flag them, reorder moves ONE instance through the chain (direction or position). instance scopes remove/bypass/enable/reorder to the Nth same-type instance. Effect types are the knob-mapped subset for more/less — eq and other no-knob effects are refused there; use kyx_plugin_param for their parameters.",
    inputSchema: {
      type: "object",
      properties: {
        effect: {
          type: "string",
          enum: [
            "eq",
            "msEq",
            "haasWidener",
            "multiband",
            "compressor",
            "saturation",
            "tapeSat",
            "wowFlutter",
            "clipper",
            "reverb",
            "delay",
            "pump",
            "distortion",
            "bitcrusher",
            "chorus",
            "phaser",
            "sidechain",
            "transient",
            "gate",
            "shimmer",
            "fxeq",
            "ultina",
            "ozvena",
            "morphdynamics",
            "rezonans",
            "drumBuss",
            "bassBuss",
            "utility",
            "limiter",
            "stepGate",
            "svFilter",
            "flanger",
            "tremolo",
            "autowah",
            "stutter",
            "comb",
            "vowel",
            "duckDelay",
            "ringMod",
            "tapeStop",
            "freqShifter",
            "multiTapDelay",
            "pitchShift",
            "pitchCorrect",
            "zenit",
            "apeks",
            "sirka",
            "prud",
            "vinyl",
            "beatMangler",
            "vocoder",
            "reverseSwell",
            "granularFreeze",
            "kaskada",
            "bassHarmonic",
            "skrutka",
            "portal",
          ],
          description: "Any registered effect; more/less requires a primary knob (see kyx_catalog)",
        },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "Track family target — required unless trackId is given",
        },
        trackId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Exact track id (from kyx_state tracks) — overrides family when present",
        },
        action: {
          type: "string",
          enum: ["more", "less", "remove", "bypass", "enable", "reorder"],
        },
        percent: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Relative step size for more/less, as % of the knob's range (default: fixed calibrated step)",
        },
        instance: {
          type: "integer",
          minimum: 1,
          maximum: 128,
          description:
            "1-based same-type instance — scopes remove/bypass/enable/reorder to ONE instance (default: all instances of the type)",
        },
        fxId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "Stable effect instance id — preferred over instance for remove/bypass/enable/reorder; survives chain reorder",
        },
        direction: {
          type: "string",
          enum: ["earlier", "later"],
          description: "For reorder — move the instance one slot toward the input (earlier) or output (later)",
        },
        position: {
          type: "integer",
          minimum: 1,
          maximum: 128,
          description: "For reorder — 1-based final slot in the chain",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["effect", "action"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        status: {
          type: "string",
        },
        stage: {
          type: "string",
          enum: ["read", "runtime", "applied", "persisted", "rendered", "delivered", "dry-run", "replayed", "noop"],
        },
        changed: {
          type: "boolean",
        },
        readback: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 32,
        },
        effect: {
          type: "string",
        },
        action: {
          type: "string",
        },
        trackId: {
          type: "string",
        },
        trackIds: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 256,
        },
        instance: {
          type: "integer",
          minimum: 1,
          maximum: 128,
        },
        fxId: {
          type: "string",
        },
      },
      required: ["status", "stage"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_sections",
    description:
      "Read the current section inventory or add/remove/duplicate/reorder/resize named sections and set section intensity. Target existing sections by stable sceneId, exact name, 1-based index, or an unambiguous role. Writes use one undoable command and return committed section read-back. Supply requestId when retrying a non-idempotent add/duplicate request.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "add", "remove", "duplicate", "reorder", "resize", "intensity"],
        },
        intensity: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "op=intensity — target scene intensity 0..1",
        },
        scene: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          description: "Exact section name or role target for existing-section edits",
        },
        index: {
          type: "integer",
          minimum: 1,
          description: "1-based section index (alternative to sceneId/name/role)",
        },
        value: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "op=intensity — the target intensity 0..1",
        },
        sceneId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Exact stable target scene ID from kyx_sections list",
        },
        role: {
          type: "string",
          enum: ["intro", "build", "chorus", "verse", "bridge", "drop", "break", "outro", "fill"],
          description: "Section role to add, or a unique existing-role target for edits",
        },
        direction: {
          type: "string",
          enum: ["earlier", "later"],
          description: "op=reorder direction (default later)",
        },
        bars: {
          type: "integer",
          minimum: 1,
          maximum: 64,
          description: "For resize",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: [
            "listed",
            "created",
            "removed",
            "duplicated",
            "reordered",
            "already_ordered",
            "resized",
            "intensity_set",
            "already_set",
            "partial",
          ],
        },
        sections: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
              },
              name: {
                type: "string",
              },
              role: {
                type: "string",
              },
              index: {
                type: "integer",
                minimum: 1,
              },
              startBar: {
                type: "integer",
                minimum: 1,
              },
              bars: {
                type: "integer",
                minimum: 1,
              },
              intensity: {
                type: "number",
                minimum: 0,
                maximum: 1,
              },
              clipCount: {
                type: "integer",
                minimum: 0,
              },
            },
            required: ["id", "name", "role", "index", "bars", "intensity", "clipCount"],
          },
        },
        sectionId: {
          type: "string",
        },
        name: {
          type: "string",
        },
        role: {
          type: "string",
        },
        index: {
          type: "integer",
          minimum: 1,
        },
        startBar: {
          type: "integer",
          minimum: 1,
        },
        bars: {
          type: "integer",
          minimum: 1,
        },
        intensity: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        clipCount: {
          type: "integer",
          minimum: 0,
        },
        undoSteps: {
          type: "integer",
          minimum: 0,
          maximum: 1,
        },
      },
      required: ["status", "sections", "undoSteps"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_markers",
    description:
      "List timeline markers, add a cue at a 1-based bar, or rename/remove one. Exact markerId wins when provided; otherwise rename/remove target the nearest marker to bar. Writes return the committed marker read-back and explicit no-op status.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "add", "remove", "rename"],
        },
        markerId: {
          type: "string",
          maxLength: 128,
          description: "Exact target for rename/remove; overrides bar",
        },
        bar: {
          type: "integer",
          minimum: 1,
          maximum: 8192,
          description: "1-based bar for add, or nearest-marker anchor",
        },
        name: {
          type: "string",
          maxLength: 40,
          description: "Optional for add; required for rename",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["listed", "created", "renamed", "already_named", "removed", "missing", "partial"],
        },
        markers: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
              },
              name: {
                type: "string",
              },
              type: {
                type: "string",
                enum: ["drop", "buildup", "riser", "impact", "cue", "custom"],
              },
              tick: {
                type: "integer",
                minimum: 0,
              },
              bar: {
                type: "integer",
                minimum: 1,
                maximum: 8192,
              },
              linkedClipId: {
                type: "string",
              },
            },
            required: ["id", "name", "type", "tick", "bar"],
          },
        },
        markerId: {
          type: "string",
        },
        name: {
          type: "string",
        },
        markerType: {
          type: "string",
          enum: ["drop", "buildup", "riser", "impact", "cue", "custom"],
        },
        tick: {
          type: "integer",
          minimum: 0,
        },
        bar: {
          type: "integer",
          minimum: 1,
          maximum: 8192,
        },
        linkedClipId: {
          type: "string",
        },
        undoSteps: {
          type: "integer",
          minimum: 0,
          maximum: 1,
        },
      },
      required: ["status"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_tracks",
    description:
      "Track CRUD + absolute mixer setters: add a drum or instrument track, remove/rename by family or exact trackId (group tracks are not addressable here — removing the last track is declined; duplicate clones one track with its FX and routing), or set mixer values with verify-by-read: setGain (absolute gainDb −60..+3.5 or linear gain 0..1.5), setPan (−1..1), setMute/setSolo (value boolean), or MOVE a track before/after another stable track id. set* ops apply to every track the family resolves to.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
            "addDrum",
            "addInstrument",
            "loadPreset",
            "listPresets",
            "duplicate",
            "remove",
            "rename",
            "setGain",
            "setPan",
            "setMute",
            "setSolo",
            "move",
          ],
        },
        presetName: {
          type: "string",
          description: 'loadPreset — factory preset name, fuzzy-matched (e.g. "Warm Sub")',
        },
        query: {
          type: "string",
          description: "listPresets — optional name/instrument filter",
        },
        family: {
          type: "string",
          enum: ["drums", "bass", "lead", "chords", "kick", "snare", "clap", "hat", "perc", "tom"],
          description: "Which family to touch — ignored when trackId is given",
        },
        trackId: {
          type: "string",
          description: "Exact track id (from kyx_state tracks) — overrides family",
        },
        instrument: {
          type: "string",
          enum: [
            "sampler",
            "analog",
            "bass",
            "808",
            "texture",
            "wavetable",
            "granular",
            "keys",
            "organ",
            "strings",
            "bell",
            "reese",
            "clav",
            "acid",
            "brass",
            "fm",
            "pluck",
            "flute",
            "logdrum",
            "spectral",
            "vocalchop",
            "drumsynth",
            "tsar",
            "kopa",
            "choral",
            "ladic",
            "hlas",
            "strk",
            "cink",
            "struna",
            "dymka",
          ],
          description: "For addInstrument — the full kind catalog is in kyx_catalog subject:instruments",
        },
        name: {
          type: "string",
          description: "New name for rename",
        },
        gainDb: {
          type: "number",
          minimum: -60,
          maximum: 3.5,
          description: "For setGain — absolute fader value in dB",
        },
        gain: {
          type: "number",
          minimum: 0,
          maximum: 1.5,
          description: "For setGain — linear alternative to gainDb",
        },
        pan: {
          type: "number",
          minimum: -1,
          maximum: 1,
          description: "For setPan — −1 left, 0 center, 1 right",
        },
        value: {
          type: "boolean",
          description: "For setMute/setSolo — true = on",
        },
        relativeTo: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "For move — stable id of the track to move next to (from kyx_state tracks)",
        },
        where: {
          type: "string",
          enum: ["before", "after"],
          description: "For move — place the track before or after relativeTo (default after)",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        status: {
          type: "string",
        },
        stage: {
          type: "string",
          enum: ["read", "runtime", "applied", "persisted", "rendered", "delivered", "dry-run", "replayed", "noop"],
        },
        changed: {
          type: "boolean",
        },
        readback: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 32,
        },
        family: {
          type: "string",
        },
        trackId: {
          type: "string",
        },
        trackIds: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 256,
        },
        name: {
          type: "string",
        },
      },
      required: ["status", "stage"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_pattern",
    description:
      "List the project's patterns or switch the ACTIVE pattern (step edits and generation act on the active one). Select by 1-based index or name.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "select"],
        },
        pattern: {
          type: "string",
          description: "1-based index or pattern name (for select)",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        status: {
          type: "string",
        },
        stage: {
          type: "string",
          enum: ["read", "runtime", "applied", "persisted", "rendered", "delivered", "dry-run", "replayed", "noop"],
        },
        changed: {
          type: "boolean",
        },
        readback: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 32,
        },
        patternId: {
          type: "string",
        },
        patternName: {
          type: "string",
        },
        index: {
          type: "integer",
          minimum: 1,
        },
      },
      required: ["status", "stage"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_steps",
    description:
      "Structured sixteenth-note step-grid edit on the ACTIVE pattern's drum pads (1-based indexes across the whole pattern; steps per bar follow the project's meter). add sets velocity, remove clears, toggle flips, ghost places a soft probabilistic hit, clearPad empties the whole family. Returns a verification read-back with the family's before → after step counts.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["add", "remove", "toggle", "ghost", "clearPad"],
        },
        family: {
          type: "string",
          enum: ["kick", "snare", "clap", "hat", "perc", "tom"],
        },
        steps: {
          type: "array",
          items: {
            type: "integer",
            minimum: 1,
            maximum: 128,
          },
          maxItems: 128,
          description: "1-based sixteenth-note step indexes within the pattern. Not used by clearPad.",
        },
        velocity: {
          type: "number",
          minimum: 0.05,
          maximum: 1,
          description: "For add/toggle (default 0.8)",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op", "family"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["changed", "no_change", "partial"],
        },
        op: {
          type: "string",
          enum: ["add", "remove", "toggle", "ghost", "clearPad"],
        },
        family: {
          type: "string",
          enum: ["kick", "snare", "clap", "hat", "perc", "tom"],
        },
        patternId: {
          type: "string",
        },
        patternName: {
          type: "string",
        },
        stepCount: {
          type: "integer",
          minimum: 1,
          maximum: 128,
        },
        targetPadCount: {
          type: "integer",
          minimum: 1,
          maximum: 256,
        },
        pads: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              padId: {
                type: "string",
              },
              padName: {
                type: "string",
              },
              beforeHitCount: {
                type: "integer",
                minimum: 0,
                maximum: 128,
              },
              afterHitCount: {
                type: "integer",
                minimum: 0,
                maximum: 128,
              },
            },
            required: ["padId", "padName", "beforeHitCount", "afterHitCount"],
          },
          maxItems: 256,
        },
        requestedSteps: {
          type: "array",
          items: {
            type: "integer",
            minimum: 1,
            maximum: 128,
          },
          maxItems: 128,
        },
        changedCellCount: {
          type: "integer",
          minimum: 0,
          maximum: 2048,
        },
        changedSteps: {
          type: "array",
          items: {
            type: "integer",
            minimum: 1,
            maximum: 128,
          },
          maxItems: 128,
        },
        changes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              padId: {
                type: "string",
              },
              padName: {
                type: "string",
              },
              step: {
                type: "integer",
                minimum: 1,
                maximum: 128,
              },
              velocity: {
                type: "number",
                minimum: 0,
                maximum: 1,
              },
              probability: {
                type: "number",
                minimum: 0,
                maximum: 1,
              },
            },
            required: ["padId", "padName", "step", "velocity", "probability"],
          },
          maxItems: 2048,
        },
        beforeHitCount: {
          type: "integer",
          minimum: 0,
        },
        afterHitCount: {
          type: "integer",
          minimum: 0,
        },
        undoSteps: {
          type: "integer",
          minimum: 0,
          maximum: 1,
        },
      },
      required: [
        "status",
        "op",
        "family",
        "patternId",
        "patternName",
        "stepCount",
        "targetPadCount",
        "pads",
        "requestedSteps",
        "changedCellCount",
        "changedSteps",
        "changes",
        "beforeHitCount",
        "afterHitCount",
        "undoSteps",
      ],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_notes",
    description:
      "Melodic COMPOSITION on the active pattern (the melodic half kyx_steps does not cover): list/add/move/delete notes, set velocity, quantize to grid or key on one track, transpose a family's whole line. Targets accept an exact trackId or a melodic family. Notes are addressed by stable noteId (preferred) or INDEX into a paged list response; indices remain supported for compatibility. Every edit uses the audited command layer and returns committed note read-back.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "add", "move", "delete", "setVelocity", "quantize", "transpose"],
        },
        family: {
          type: "string",
          enum: ["bass", "lead", "chords"],
          description: "Target melodic family (first matching track edits; default bass). Read-back names the track.",
        },
        trackId: {
          type: "string",
          description: "Exact track ID; takes precedence over family.",
        },
        noteId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Stable note ID for move/delete/setVelocity.",
        },
        pitch: {
          type: "integer",
          minimum: 0,
          maximum: 127,
          description: "MIDI pitch (add; move absolute)",
        },
        noteName: {
          type: "string",
          description: 'Alternative to pitch: "C3", "F#4", "Bb2" (add)',
        },
        index: {
          type: "integer",
          minimum: 0,
          description: "Legacy position in the list response (move/delete/setVelocity)",
        },
        offset: {
          type: "integer",
          minimum: 0,
          maximum: 1000000,
          description: "list page start (default 0)",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 40,
          description: "list page size (default 40)",
        },
        startBeat: {
          type: "number",
          minimum: 0,
          maximum: 1000000,
          description: "Start in beats from pattern start (add; move absolute)",
        },
        durationBeats: {
          type: "number",
          minimum: 0.05,
          maximum: 1000000,
          description: "Note length in beats (add, default 0.5)",
        },
        velocity: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "add (default 0.8) / setVelocity",
        },
        pitchDelta: {
          type: "integer",
          minimum: -127,
          maximum: 127,
          description: "move relative semitones",
        },
        grid: {
          type: "string",
          enum: ["1/4", "1/8", "1/16", "1/32", "1/8T", "1/16T"],
          description: "quantize target grid",
        },
        key: {
          type: "string",
          enum: [
            "C Major",
            "C Natural Minor",
            "C Harmonic Minor",
            "C Melodic Minor",
            "C Dorian",
            "C Phrygian",
            "C Mixolydian",
            "C Pentatonic Major",
            "C Pentatonic Minor",
            "C# Major",
            "C# Natural Minor",
            "C# Harmonic Minor",
            "C# Melodic Minor",
            "C# Dorian",
            "C# Phrygian",
            "C# Mixolydian",
            "C# Pentatonic Major",
            "C# Pentatonic Minor",
            "D Major",
            "D Natural Minor",
            "D Harmonic Minor",
            "D Melodic Minor",
            "D Dorian",
            "D Phrygian",
            "D Mixolydian",
            "D Pentatonic Major",
            "D Pentatonic Minor",
            "D# Major",
            "D# Natural Minor",
            "D# Harmonic Minor",
            "D# Melodic Minor",
            "D# Dorian",
            "D# Phrygian",
            "D# Mixolydian",
            "D# Pentatonic Major",
            "D# Pentatonic Minor",
            "E Major",
            "E Natural Minor",
            "E Harmonic Minor",
            "E Melodic Minor",
            "E Dorian",
            "E Phrygian",
            "E Mixolydian",
            "E Pentatonic Major",
            "E Pentatonic Minor",
            "F Major",
            "F Natural Minor",
            "F Harmonic Minor",
            "F Melodic Minor",
            "F Dorian",
            "F Phrygian",
            "F Mixolydian",
            "F Pentatonic Major",
            "F Pentatonic Minor",
            "F# Major",
            "F# Natural Minor",
            "F# Harmonic Minor",
            "F# Melodic Minor",
            "F# Dorian",
            "F# Phrygian",
            "F# Mixolydian",
            "F# Pentatonic Major",
            "F# Pentatonic Minor",
            "G Major",
            "G Natural Minor",
            "G Harmonic Minor",
            "G Melodic Minor",
            "G Dorian",
            "G Phrygian",
            "G Mixolydian",
            "G Pentatonic Major",
            "G Pentatonic Minor",
            "G# Major",
            "G# Natural Minor",
            "G# Harmonic Minor",
            "G# Melodic Minor",
            "G# Dorian",
            "G# Phrygian",
            "G# Mixolydian",
            "G# Pentatonic Major",
            "G# Pentatonic Minor",
            "A Major",
            "A Natural Minor",
            "A Harmonic Minor",
            "A Melodic Minor",
            "A Dorian",
            "A Phrygian",
            "A Mixolydian",
            "A Pentatonic Major",
            "A Pentatonic Minor",
            "A# Major",
            "A# Natural Minor",
            "A# Harmonic Minor",
            "A# Melodic Minor",
            "A# Dorian",
            "A# Phrygian",
            "A# Mixolydian",
            "A# Pentatonic Major",
            "A# Pentatonic Minor",
            "B Major",
            "B Natural Minor",
            "B Harmonic Minor",
            "B Melodic Minor",
            "B Dorian",
            "B Phrygian",
            "B Mixolydian",
            "B Pentatonic Major",
            "B Pentatonic Minor",
          ],
          description: 'quantize this track to a supported scale, e.g. "C Major", "A Natural Minor"',
        },
        semitones: {
          type: "integer",
          minimum: -127,
          maximum: 127,
          description: "transpose shift (non-zero)",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: [
            "listed",
            "added",
            "moved",
            "already_moved",
            "deleted",
            "velocity_set",
            "already_set",
            "quantized",
            "already_quantized",
            "transposed",
            "no_notes",
            "partial",
          ],
        },
        op: {
          type: "string",
          enum: ["list", "add", "move", "delete", "setVelocity", "quantize", "transpose"],
        },
        trackId: {
          type: "string",
        },
        trackName: {
          type: "string",
        },
        noteCount: {
          type: "integer",
          minimum: 0,
        },
        notes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
              },
              index: {
                type: "integer",
                minimum: 0,
                description: "Current 0-based list position; use id for later edits.",
              },
              pitch: {
                type: "integer",
                minimum: 0,
                maximum: 127,
              },
              noteName: {
                type: "string",
              },
              startTicks: {
                type: "integer",
                minimum: 0,
                description: "Authoritative position in PPQ 480 ticks.",
              },
              startBeat: {
                type: "number",
                minimum: 0,
                description: "Position derived from startTicks at 480 ticks per beat.",
              },
              durationTicks: {
                type: "integer",
                minimum: 1,
              },
              durationBeats: {
                type: "number",
                minimum: 0,
                description: "Length derived from durationTicks at 480 ticks per beat.",
              },
              velocity: {
                type: "number",
                minimum: 0,
                maximum: 1,
                description: "Normalized MIDI velocity.",
              },
            },
            required: [
              "id",
              "index",
              "pitch",
              "noteName",
              "startTicks",
              "startBeat",
              "durationTicks",
              "durationBeats",
              "velocity",
            ],
          },
          maxItems: 40,
        },
        note: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
            },
            index: {
              type: "integer",
              minimum: 0,
              description: "Current 0-based list position; use id for later edits.",
            },
            pitch: {
              type: "integer",
              minimum: 0,
              maximum: 127,
            },
            noteName: {
              type: "string",
            },
            startTicks: {
              type: "integer",
              minimum: 0,
              description: "Authoritative position in PPQ 480 ticks.",
            },
            startBeat: {
              type: "number",
              minimum: 0,
              description: "Position derived from startTicks at 480 ticks per beat.",
            },
            durationTicks: {
              type: "integer",
              minimum: 1,
            },
            durationBeats: {
              type: "number",
              minimum: 0,
              description: "Length derived from durationTicks at 480 ticks per beat.",
            },
            velocity: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Normalized MIDI velocity.",
            },
          },
          required: [
            "id",
            "index",
            "pitch",
            "noteName",
            "startTicks",
            "startBeat",
            "durationTicks",
            "durationBeats",
            "velocity",
          ],
        },
        noteId: {
          type: "string",
        },
        index: {
          type: "integer",
          minimum: 0,
        },
        offset: {
          type: "integer",
          minimum: 0,
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 40,
        },
        nextOffset: {
          type: "integer",
          minimum: 0,
        },
        undoSteps: {
          type: "integer",
          minimum: 0,
          maximum: 1,
        },
        targetNoteCount: {
          type: "integer",
          minimum: 0,
        },
        changedNotes: {
          type: "integer",
          minimum: 0,
        },
        missingNotes: {
          type: "integer",
          minimum: 0,
        },
        transposedNotes: {
          type: "integer",
          minimum: 0,
        },
        partialNotes: {
          type: "integer",
          minimum: 0,
        },
        requestedSemitones: {
          type: "integer",
          minimum: -127,
          maximum: 127,
        },
        grid: {
          type: "string",
          enum: ["1/4", "1/8", "1/16", "1/32", "1/8T", "1/16T"],
        },
        key: {
          type: "string",
          enum: [
            "C Major",
            "C Natural Minor",
            "C Harmonic Minor",
            "C Melodic Minor",
            "C Dorian",
            "C Phrygian",
            "C Mixolydian",
            "C Pentatonic Major",
            "C Pentatonic Minor",
            "C# Major",
            "C# Natural Minor",
            "C# Harmonic Minor",
            "C# Melodic Minor",
            "C# Dorian",
            "C# Phrygian",
            "C# Mixolydian",
            "C# Pentatonic Major",
            "C# Pentatonic Minor",
            "D Major",
            "D Natural Minor",
            "D Harmonic Minor",
            "D Melodic Minor",
            "D Dorian",
            "D Phrygian",
            "D Mixolydian",
            "D Pentatonic Major",
            "D Pentatonic Minor",
            "D# Major",
            "D# Natural Minor",
            "D# Harmonic Minor",
            "D# Melodic Minor",
            "D# Dorian",
            "D# Phrygian",
            "D# Mixolydian",
            "D# Pentatonic Major",
            "D# Pentatonic Minor",
            "E Major",
            "E Natural Minor",
            "E Harmonic Minor",
            "E Melodic Minor",
            "E Dorian",
            "E Phrygian",
            "E Mixolydian",
            "E Pentatonic Major",
            "E Pentatonic Minor",
            "F Major",
            "F Natural Minor",
            "F Harmonic Minor",
            "F Melodic Minor",
            "F Dorian",
            "F Phrygian",
            "F Mixolydian",
            "F Pentatonic Major",
            "F Pentatonic Minor",
            "F# Major",
            "F# Natural Minor",
            "F# Harmonic Minor",
            "F# Melodic Minor",
            "F# Dorian",
            "F# Phrygian",
            "F# Mixolydian",
            "F# Pentatonic Major",
            "F# Pentatonic Minor",
            "G Major",
            "G Natural Minor",
            "G Harmonic Minor",
            "G Melodic Minor",
            "G Dorian",
            "G Phrygian",
            "G Mixolydian",
            "G Pentatonic Major",
            "G Pentatonic Minor",
            "G# Major",
            "G# Natural Minor",
            "G# Harmonic Minor",
            "G# Melodic Minor",
            "G# Dorian",
            "G# Phrygian",
            "G# Mixolydian",
            "G# Pentatonic Major",
            "G# Pentatonic Minor",
            "A Major",
            "A Natural Minor",
            "A Harmonic Minor",
            "A Melodic Minor",
            "A Dorian",
            "A Phrygian",
            "A Mixolydian",
            "A Pentatonic Major",
            "A Pentatonic Minor",
            "A# Major",
            "A# Natural Minor",
            "A# Harmonic Minor",
            "A# Melodic Minor",
            "A# Dorian",
            "A# Phrygian",
            "A# Mixolydian",
            "A# Pentatonic Major",
            "A# Pentatonic Minor",
            "B Major",
            "B Natural Minor",
            "B Harmonic Minor",
            "B Melodic Minor",
            "B Dorian",
            "B Phrygian",
            "B Mixolydian",
            "B Pentatonic Major",
            "B Pentatonic Minor",
          ],
        },
        clamped: {
          type: "boolean",
        },
        requestedVelocity: {
          type: "number",
        },
      },
      required: ["status", "op", "trackId", "trackName", "noteCount", "undoSteps"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_music",
    description:
      "Structured MUSICAL STATE: set tempo, set musical key, change the active pattern's length, set meter, or transpose active-pattern melodic notes. Changes use the canonical exact-intent command and return committed read-back; no-ops add no undo step. Numeric inputs are strict, and retries of transposeAll should include requestId. setTimeSignature also discloses what the new metre MEASURES — the bar in ticks and steps, the beat — and what happens to the active pattern, so read that clause before assuming the groove still lands on the downbeat.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["setTempo", "setKey", "setPatternLength", "transposeAll", "setTimeSignature"],
        },
        numerator: {
          type: "integer",
          minimum: 1,
          maximum: 16,
          description: "setTimeSignature — numerator",
        },
        denominator: {
          type: "integer",
          enum: [2, 4, 8, 16],
          description: "setTimeSignature — beat unit (denominator)",
        },
        bpm: {
          type: "integer",
          minimum: 20,
          maximum: 300,
          description: "setTempo",
        },
        key: {
          type: "string",
          enum: [
            "C Major",
            "C Natural Minor",
            "C Harmonic Minor",
            "C Melodic Minor",
            "C Dorian",
            "C Phrygian",
            "C Mixolydian",
            "C Pentatonic Major",
            "C Pentatonic Minor",
            "C# Major",
            "C# Natural Minor",
            "C# Harmonic Minor",
            "C# Melodic Minor",
            "C# Dorian",
            "C# Phrygian",
            "C# Mixolydian",
            "C# Pentatonic Major",
            "C# Pentatonic Minor",
            "D Major",
            "D Natural Minor",
            "D Harmonic Minor",
            "D Melodic Minor",
            "D Dorian",
            "D Phrygian",
            "D Mixolydian",
            "D Pentatonic Major",
            "D Pentatonic Minor",
            "D# Major",
            "D# Natural Minor",
            "D# Harmonic Minor",
            "D# Melodic Minor",
            "D# Dorian",
            "D# Phrygian",
            "D# Mixolydian",
            "D# Pentatonic Major",
            "D# Pentatonic Minor",
            "E Major",
            "E Natural Minor",
            "E Harmonic Minor",
            "E Melodic Minor",
            "E Dorian",
            "E Phrygian",
            "E Mixolydian",
            "E Pentatonic Major",
            "E Pentatonic Minor",
            "F Major",
            "F Natural Minor",
            "F Harmonic Minor",
            "F Melodic Minor",
            "F Dorian",
            "F Phrygian",
            "F Mixolydian",
            "F Pentatonic Major",
            "F Pentatonic Minor",
            "F# Major",
            "F# Natural Minor",
            "F# Harmonic Minor",
            "F# Melodic Minor",
            "F# Dorian",
            "F# Phrygian",
            "F# Mixolydian",
            "F# Pentatonic Major",
            "F# Pentatonic Minor",
            "G Major",
            "G Natural Minor",
            "G Harmonic Minor",
            "G Melodic Minor",
            "G Dorian",
            "G Phrygian",
            "G Mixolydian",
            "G Pentatonic Major",
            "G Pentatonic Minor",
            "G# Major",
            "G# Natural Minor",
            "G# Harmonic Minor",
            "G# Melodic Minor",
            "G# Dorian",
            "G# Phrygian",
            "G# Mixolydian",
            "G# Pentatonic Major",
            "G# Pentatonic Minor",
            "A Major",
            "A Natural Minor",
            "A Harmonic Minor",
            "A Melodic Minor",
            "A Dorian",
            "A Phrygian",
            "A Mixolydian",
            "A Pentatonic Major",
            "A Pentatonic Minor",
            "A# Major",
            "A# Natural Minor",
            "A# Harmonic Minor",
            "A# Melodic Minor",
            "A# Dorian",
            "A# Phrygian",
            "A# Mixolydian",
            "A# Pentatonic Major",
            "A# Pentatonic Minor",
            "B Major",
            "B Natural Minor",
            "B Harmonic Minor",
            "B Melodic Minor",
            "B Dorian",
            "B Phrygian",
            "B Mixolydian",
            "B Pentatonic Major",
            "B Pentatonic Minor",
          ],
          description: "setKey — choose from KYX's supported musical-key catalog",
        },
        steps: {
          type: "integer",
          minimum: 1,
          maximum: 128,
          description: "setPatternLength — absolute sixteenth-note step count (1..128; meter controls bars)",
        },
        bars: {
          type: "integer",
          minimum: 1,
          maximum: 16,
          description:
            "setPatternLength — length in BARS of the document's meter (4 bars is 64 steps in 4/4, 48 in 3/4). Prefer bars; a step count is only a whole number of bars in 4/4.",
        },
        semitones: {
          type: "integer",
          minimum: -127,
          maximum: 127,
          description: "transposeAll shift (non-zero)",
        },
        target: {
          type: "string",
          enum: ["all", "bass", "lead", "chords", "vocal"],
          description: 'transposeAll scope (default "all"); drum tracks do not contain pitched notes',
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["set", "already_set", "transposed", "no_notes", "partial"],
        },
        op: {
          type: "string",
          enum: ["setTempo", "setKey", "setPatternLength", "setTimeSignature", "transposeAll"],
        },
        bpm: {
          type: "integer",
          minimum: 20,
          maximum: 300,
        },
        key: {
          type: "string",
          enum: [
            "C Major",
            "C Natural Minor",
            "C Harmonic Minor",
            "C Melodic Minor",
            "C Dorian",
            "C Phrygian",
            "C Mixolydian",
            "C Pentatonic Major",
            "C Pentatonic Minor",
            "C# Major",
            "C# Natural Minor",
            "C# Harmonic Minor",
            "C# Melodic Minor",
            "C# Dorian",
            "C# Phrygian",
            "C# Mixolydian",
            "C# Pentatonic Major",
            "C# Pentatonic Minor",
            "D Major",
            "D Natural Minor",
            "D Harmonic Minor",
            "D Melodic Minor",
            "D Dorian",
            "D Phrygian",
            "D Mixolydian",
            "D Pentatonic Major",
            "D Pentatonic Minor",
            "D# Major",
            "D# Natural Minor",
            "D# Harmonic Minor",
            "D# Melodic Minor",
            "D# Dorian",
            "D# Phrygian",
            "D# Mixolydian",
            "D# Pentatonic Major",
            "D# Pentatonic Minor",
            "E Major",
            "E Natural Minor",
            "E Harmonic Minor",
            "E Melodic Minor",
            "E Dorian",
            "E Phrygian",
            "E Mixolydian",
            "E Pentatonic Major",
            "E Pentatonic Minor",
            "F Major",
            "F Natural Minor",
            "F Harmonic Minor",
            "F Melodic Minor",
            "F Dorian",
            "F Phrygian",
            "F Mixolydian",
            "F Pentatonic Major",
            "F Pentatonic Minor",
            "F# Major",
            "F# Natural Minor",
            "F# Harmonic Minor",
            "F# Melodic Minor",
            "F# Dorian",
            "F# Phrygian",
            "F# Mixolydian",
            "F# Pentatonic Major",
            "F# Pentatonic Minor",
            "G Major",
            "G Natural Minor",
            "G Harmonic Minor",
            "G Melodic Minor",
            "G Dorian",
            "G Phrygian",
            "G Mixolydian",
            "G Pentatonic Major",
            "G Pentatonic Minor",
            "G# Major",
            "G# Natural Minor",
            "G# Harmonic Minor",
            "G# Melodic Minor",
            "G# Dorian",
            "G# Phrygian",
            "G# Mixolydian",
            "G# Pentatonic Major",
            "G# Pentatonic Minor",
            "A Major",
            "A Natural Minor",
            "A Harmonic Minor",
            "A Melodic Minor",
            "A Dorian",
            "A Phrygian",
            "A Mixolydian",
            "A Pentatonic Major",
            "A Pentatonic Minor",
            "A# Major",
            "A# Natural Minor",
            "A# Harmonic Minor",
            "A# Melodic Minor",
            "A# Dorian",
            "A# Phrygian",
            "A# Mixolydian",
            "A# Pentatonic Major",
            "A# Pentatonic Minor",
            "B Major",
            "B Natural Minor",
            "B Harmonic Minor",
            "B Melodic Minor",
            "B Dorian",
            "B Phrygian",
            "B Mixolydian",
            "B Pentatonic Major",
            "B Pentatonic Minor",
          ],
        },
        patternId: {
          type: "string",
        },
        steps: {
          type: "integer",
          minimum: 1,
          maximum: 128,
        },
        bars: {
          type: "number",
          minimum: 0,
          description:
            "Pattern length in the document's bars (fractional when the length is not a whole number of bars).",
        },
        numerator: {
          type: "integer",
          minimum: 1,
          maximum: 16,
        },
        denominator: {
          type: "integer",
          enum: [2, 4, 8, 16],
        },
        target: {
          type: "string",
          enum: ["all", "bass", "lead", "chords", "vocal"],
        },
        requestedSemitones: {
          type: "integer",
          minimum: -127,
          maximum: 127,
        },
        targetNoteCount: {
          type: "integer",
          minimum: 0,
          description: "Active-pattern notes in the resolved melodic target.",
        },
        transposedNotes: {
          type: "integer",
          minimum: 0,
          description: "Notes that landed the full requested semitone shift.",
        },
        partialNotes: {
          type: "integer",
          minimum: 0,
          description: "Target notes that did not land the full shift, including MIDI-boundary clamps.",
        },
        undoSteps: {
          type: "integer",
          minimum: 0,
          maximum: 1,
        },
      },
      required: ["status", "op", "undoSteps"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_catalog",
    description:
      "Discovery — what the DAW can do, machine-readable: list every effect type with its category and primary knob, the FULL parameter table of one effect or instrument (native range, unit, description, kind, step, taper and enum options), or the instrument kind catalog. Read-only; use it before kyx_plugin_param or kyx_instrument_param instead of guessing ranges.",
    inputSchema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          enum: ["effects", "effect", "instruments", "instrument"],
        },
        effect: {
          type: "string",
          description: "Effect type for subject:effect (e.g. reverb, eq, compressor) — see subject:effects",
        },
        instrument: {
          type: "string",
          enum: [
            "sampler",
            "analog",
            "bass",
            "808",
            "texture",
            "wavetable",
            "granular",
            "keys",
            "organ",
            "strings",
            "bell",
            "reese",
            "clav",
            "acid",
            "brass",
            "fm",
            "pluck",
            "flute",
            "logdrum",
            "spectral",
            "vocalchop",
            "drumsynth",
            "tsar",
            "kopa",
            "choral",
            "ladic",
            "hlas",
            "strk",
            "cink",
            "struna",
            "dymka",
          ],
          maxLength: 32,
          description: "Instrument kind for subject:instrument (e.g. kopa or tsar) — see subject:instruments",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["subject"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["listed"],
        },
        subject: {
          type: "string",
          enum: ["effects", "effect", "instruments", "instrument"],
        },
        effects: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: {
                type: "string",
              },
              name: {
                type: "string",
              },
              category: {
                type: "string",
                enum: ["tone", "dynamics", "character", "space", "movement"],
              },
              primaryKnob: {
                type: ["string", "null"],
              },
              parameterCount: {
                type: "integer",
                minimum: 0,
              },
            },
            required: ["type", "name", "category", "primaryKnob", "parameterCount"],
          },
        },
        effect: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
            },
            name: {
              type: "string",
            },
            category: {
              type: "string",
              enum: ["tone", "dynamics", "character", "space", "movement"],
            },
            primaryKnob: {
              type: ["string", "null"],
            },
            primaryRole: {
              type: ["string", "null"],
            },
            intentControls: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  role: {
                    type: "string",
                  },
                  paramId: {
                    type: "string",
                  },
                  min: {
                    type: "number",
                  },
                  max: {
                    type: "number",
                  },
                  default: {
                    type: "number",
                  },
                  unit: {
                    type: ["string", "null"],
                  },
                },
                required: ["role", "paramId", "min", "max", "default", "unit"],
              },
            },
            parameters: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                  },
                  label: {
                    type: "string",
                  },
                  min: {
                    type: "number",
                  },
                  max: {
                    type: "number",
                  },
                  default: {
                    type: "number",
                  },
                  unit: {
                    type: ["string", "null"],
                  },
                  description: {
                    type: ["string", "null"],
                  },
                  kind: {
                    type: ["string", "null"],
                    enum: ["continuous", "enum", "toggle", "discrete", "unknown", null],
                  },
                  step: {
                    type: ["number", "null"],
                  },
                  taper: {
                    type: ["string", "null"],
                    enum: ["linear", "log", null],
                  },
                  options: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        value: {
                          type: "number",
                        },
                        label: {
                          type: "string",
                        },
                      },
                      required: ["value", "label"],
                    },
                  },
                },
                required: [
                  "id",
                  "label",
                  "min",
                  "max",
                  "default",
                  "unit",
                  "description",
                  "kind",
                  "step",
                  "taper",
                  "options",
                ],
              },
            },
          },
          required: ["type", "name", "category", "primaryKnob", "primaryRole", "intentControls", "parameters"],
        },
        instruments: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: {
                type: "string",
              },
              name: {
                type: "string",
              },
              parameterCount: {
                type: "integer",
                minimum: 0,
              },
            },
            required: ["kind", "name", "parameterCount"],
          },
        },
        instrument: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: {
              type: "string",
            },
            name: {
              type: "string",
            },
            parameterCount: {
              type: "integer",
              minimum: 0,
            },
            parameters: {
              type: "array",
              maxItems: 128,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                  },
                  label: {
                    type: "string",
                  },
                  min: {
                    type: "number",
                  },
                  max: {
                    type: "number",
                  },
                  default: {
                    type: "number",
                  },
                  unit: {
                    type: ["string", "null"],
                  },
                  description: {
                    type: ["string", "null"],
                  },
                  kind: {
                    type: ["string", "null"],
                    enum: ["continuous", "enum", "toggle", "discrete", "unknown", null],
                  },
                  step: {
                    type: ["number", "null"],
                  },
                  taper: {
                    type: ["string", "null"],
                    enum: ["linear", "log", null],
                  },
                  options: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        value: {
                          type: "number",
                        },
                        label: {
                          type: "string",
                        },
                      },
                      required: ["value", "label"],
                    },
                  },
                },
                required: [
                  "id",
                  "label",
                  "min",
                  "max",
                  "default",
                  "unit",
                  "description",
                  "kind",
                  "step",
                  "taper",
                  "options",
                ],
              },
            },
          },
          required: ["kind", "name", "parameterCount", "parameters"],
        },
      },
      required: ["status", "subject"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "kyx_plugin_param",
    description:
      "Precise plugin control on inserted FX instances: set ONE parameter to an absolute NATIVE value (clamped to its range) or list the current values of every parameter on the targeted tracks' chains. A param id is either a RACK param (see kyx_catalog subject:effect for min/max/default/unit) or a DEEP/structured param of the instance — PRISM band and crossover ids (band1.gainDb, crossoverFreq2, ...), Ozvena network ids (convolution.mode, ...) — which the list op reports per instance, so discovery does not rely on guessing. Targets a trackId or a family; `fxId` (the stable instance id returned by list) is preferred for set because it survives chain reordering; `instance` picks 1-based among same-type instances (default 1). Missing instances are reported honestly — nothing is auto-inserted (use kyx_fx more for that).",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "set"],
        },
        trackId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Exact track id — overrides family when present",
        },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "Track family target — required unless trackId is given",
        },
        effect: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Effect type (e.g. reverb, eq) — required for set, filters list when given; see kyx_catalog",
        },
        fxId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Stable effect instance id from list (preferred over instance; survives reorder/replacement)",
        },
        instance: {
          type: "integer",
          minimum: 1,
          maximum: 128,
          description: "1-based index among same-type instances in chain order (default 1)",
        },
        param: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Parameter id for set (e.g. mix, decay, freq) — see kyx_catalog",
        },
        value: {
          type: "number",
          description: "Absolute NATIVE value for set (NOT normalized 0..1 unless the param's range is 0..1)",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["listed", "empty", "updated", "no_change", "partial"],
        },
        op: {
          type: "string",
          enum: ["list", "set"],
        },
        effect: {
          type: ["string", "null"],
        },
        instance: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 128,
        },
        param: {
          type: ["string", "null"],
        },
        requestedValue: {
          type: ["number", "null"],
        },
        targetCount: {
          type: "integer",
          minimum: 0,
        },
        targets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              trackId: {
                type: "string",
              },
              trackName: {
                type: "string",
              },
            },
            required: ["trackId", "trackName"],
          },
        },
        instances: {
          type: "array",
          maxItems: 40,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              trackId: {
                type: "string",
              },
              trackName: {
                type: "string",
              },
              fxId: {
                type: "string",
              },
              effect: {
                type: "string",
              },
              instance: {
                type: "integer",
                minimum: 1,
              },
              bypassed: {
                type: "boolean",
              },
              parameters: {
                type: "array",
                maxItems: 128,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: {
                      type: "string",
                    },
                    value: {
                      type: ["number", "null"],
                    },
                    min: {
                      type: "number",
                    },
                    max: {
                      type: "number",
                    },
                    default: {
                      type: "number",
                    },
                    unit: {
                      type: ["string", "null"],
                    },
                  },
                  required: ["id", "value", "min", "max", "default", "unit"],
                },
              },
            },
            required: ["trackId", "trackName", "fxId", "effect", "instance", "bypassed", "parameters"],
          },
        },
        changes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              trackId: {
                type: "string",
              },
              trackName: {
                type: "string",
              },
              fxId: {
                type: "string",
              },
              instance: {
                type: "integer",
                minimum: 1,
              },
              param: {
                type: "string",
              },
              beforeValue: {
                type: "number",
              },
              requestedValue: {
                type: "number",
              },
              value: {
                type: ["number", "null"],
              },
              min: {
                type: "number",
              },
              max: {
                type: "number",
              },
              unit: {
                type: ["string", "null"],
              },
              clamped: {
                type: "boolean",
              },
              changed: {
                type: "boolean",
              },
            },
            required: [
              "trackId",
              "trackName",
              "fxId",
              "instance",
              "param",
              "beforeValue",
              "requestedValue",
              "value",
              "min",
              "max",
              "unit",
              "clamped",
              "changed",
            ],
          },
        },
        unmatched: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              trackId: {
                type: "string",
              },
              trackName: {
                type: "string",
              },
              reason: {
                type: "string",
                maxLength: 256,
              },
            },
            required: ["trackId", "trackName", "reason"],
          },
        },
        truncatedCount: {
          type: "integer",
          minimum: 0,
        },
        undoSteps: {
          type: "integer",
          minimum: 0,
          maximum: 1,
        },
      },
      required: [
        "status",
        "op",
        "effect",
        "instance",
        "param",
        "requestedValue",
        "targetCount",
        "targets",
        "instances",
        "changes",
        "unmatched",
        "truncatedCount",
        "undoSteps",
      ],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_instrument_param",
    description:
      "Precise instrument control on ONE exact instrument track: list its current parameter values or set ONE parameter to an absolute native value. Read the parameter contract first with kyx_catalog subject:instrument; values are range-clamped and enum/discrete choices are validated. Exact trackId is required so identically named flagship instances are never changed by accident; writes return the committed value and create one undo step.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "set"],
        },
        trackId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Exact instrument track id from kyx_state subject:tracks",
        },
        param: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Canonical parameter id from kyx_catalog subject:instrument",
        },
        value: {
          type: "number",
          description: "Absolute NATIVE parameter value (not normalized unless its declared range is 0..1)",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op", "trackId"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["listed", "updated", "no_change"],
        },
        op: {
          type: "string",
          enum: ["list", "set"],
        },
        trackId: {
          type: "string",
        },
        trackName: {
          type: "string",
        },
        instrument: {
          type: "string",
        },
        parameters: {
          type: "array",
          maxItems: 128,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
              },
              label: {
                type: "string",
              },
              value: {
                type: ["number", "null"],
              },
              min: {
                type: "number",
              },
              max: {
                type: "number",
              },
              default: {
                type: "number",
              },
              unit: {
                type: ["string", "null"],
              },
              description: {
                type: ["string", "null"],
              },
              kind: {
                type: ["string", "null"],
                enum: ["continuous", "enum", "toggle", "discrete", "unknown", null],
              },
              step: {
                type: ["number", "null"],
              },
              taper: {
                type: ["string", "null"],
                enum: ["linear", "log", null],
              },
              options: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    value: {
                      type: "number",
                    },
                    label: {
                      type: "string",
                    },
                  },
                  required: ["value", "label"],
                },
              },
            },
            required: [
              "id",
              "label",
              "value",
              "min",
              "max",
              "default",
              "unit",
              "description",
              "kind",
              "step",
              "taper",
              "options",
            ],
          },
        },
        change: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            param: {
              type: "string",
            },
            beforeValue: {
              type: ["number", "null"],
            },
            requestedValue: {
              type: "number",
            },
            value: {
              type: "number",
            },
            min: {
              type: "number",
            },
            max: {
              type: "number",
            },
            unit: {
              type: ["string", "null"],
            },
            clamped: {
              type: "boolean",
            },
            changed: {
              type: "boolean",
            },
          },
          required: ["param", "beforeValue", "requestedValue", "value", "min", "max", "unit", "clamped", "changed"],
        },
        undoSteps: {
          type: "integer",
          minimum: 0,
          maximum: 1,
        },
      },
      required: ["status", "op", "trackId", "trackName", "instrument", "parameters", "change", "undoSteps"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_meter",
    description:
      'Live audio meters — the AI\'s ears: master true peak, RMS, LUFS (momentary/short-term/integrated), stereo correlation, clip flags, plus per-track peak/RMS. scope:"fx" reports the telemetry of EVERY inserted effect (KOREŇ f0/clarity/+dB harmonics/key scaler, dynamics gain reduction, plugin frames) — the closed loop for verifying an effect change instead of assuming it. Read-only snapshot of the RUNNING engine; honestly refused when no engine/audio context is live. LUFS-I needs a few seconds of playback to stabilize.',
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["master", "tracks", "fx", "all"],
          description: "Default all",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        master: {
          type: "object",
        },
        tracks: {
          type: "array",
          items: {
            type: "object",
          },
        },
      },
      required: ["master", "tracks"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "kyx_automation",
    description:
      "Read the real inserted FX and their canonical parameters with listTargets. Add a point (a new lane is created in the same undo step) or an exact two-point ramp (one undo step), move/delete points, or clear/remove a lane (clear/remove are destructive-gated). Targets use trackId plus effect/fxId and param; see kyx_catalog for units and ranges. addPoint clamps native values; addRamp rejects out-of-range native values. Read lanes via kyx_state subject:automation.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["listTargets", "addPoint", "addRamp", "movePoint", "deletePoint", "clearLane", "removeLane"],
        },
        trackId: {
          type: "string",
          description: "Exact track id — overrides family when present",
        },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "Track family target — required unless trackId is given",
        },
        param: {
          type: "string",
          description: "'gain' or 'pan' when no effect is given; the effect's paramId when effect is given",
        },
        effect: {
          type: "string",
          description: "Effect type for fxParam lanes — resolves to the track's 1-based instance (default 1)",
        },
        fxId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Stable effect instance id — preferred over instance for fxParam lanes",
        },
        instance: {
          type: "integer",
          minimum: 1,
          description: "1-based same-type instance index (default 1)",
        },
        bar: {
          type: "integer",
          minimum: 1,
          maximum: 8192,
          description: "1-based bar — position for addPoint, anchor for movePoint/deletePoint",
        },
        startBar: {
          type: "integer",
          minimum: 1,
          maximum: 8192,
          description: "For addRamp — 1-based start bar (inclusive)",
        },
        endBar: {
          type: "integer",
          minimum: 2,
          maximum: 8192,
          description: "For addRamp — 1-based end bar (exclusive boundary)",
        },
        newBar: {
          type: "integer",
          minimum: 1,
          maximum: 8192,
          description: "For movePoint — 1-based destination bar",
        },
        newBeat: {
          type: "integer",
          minimum: 1,
          maximum: 16,
          description: "For movePoint — 1-based destination beat; runtime validates this meter's numerator",
        },
        beat: {
          type: "integer",
          minimum: 1,
          maximum: 16,
          description: "Optional 1-based beat within the project's meter (default 1)",
        },
        value: {
          type: "number",
          description: "NATIVE value for addPoint (clamped into the target's range)",
        },
        fromValue: {
          type: "number",
          description: "NATIVE start value for addRamp; must be within the target range",
        },
        toValue: {
          type: "number",
          description: "NATIVE end value for addRamp; must be within the target range",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        status: {
          type: "string",
        },
        stage: {
          type: "string",
          enum: ["read", "runtime", "applied", "persisted", "rendered", "delivered", "dry-run", "replayed", "noop"],
        },
        changed: {
          type: "boolean",
        },
        readback: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 32,
        },
        op: {
          type: "string",
        },
        laneId: {
          type: "string",
        },
        points: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
          },
          maxItems: 4096,
        },
        targets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
          },
          maxItems: 64,
        },
      },
      required: ["status", "stage"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_clips",
    description:
      "Arrangement AND audio clips: list scene clips (with ids + an audio summary), audioList the track-lane waveforms in detail, or edit. add places a scene's clip at a 1-based bar (scene by id or name — a pure add needs no D4 unlock). Every write accepts a stable clipId from list/audioList; the legacy anchor-bar form resolves the clip COVERING that bar: move/resize/split/duplicate/delete, plus moveRipple/resizeRipple/deleteRipple which close the gap after the edit the way the UI's RIPPLE toggle does, and copy/cut/paste for the clipboard (cut and delete are D4-gated; the MCP clipboard is per-session, never persisted). Audio ops address a track (trackId or family) + the anchor bar its clip covers: audioMove/audioSplit/audioUpdate (gain, fadeIn, fadeOut, reverse, loop)/audioStretch (rate 0.25..4, optional bars)/audioSlip (offsetSec - which part of the source plays)/audioDuplicate/audioMute/audioNudge (whole bars)/audioSlice (sliceTimesSec)/audioStrip (segments to keep)/audioConsolidate (bufferId + range)/audioCrossfade/audioDelete (D4). MIDI pattern clips live on instrument-track lanes: midiList, midiAdd (trackId or family + bar; patternId defaults to the active pattern), midiMove/midiResize (clipId + toBar/bars), midiDelete (D4-gated). Values are native (gain linear, fades in seconds).",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
            "list",
            "add",
            "move",
            "resize",
            "duplicate",
            "delete",
            "audioList",
            "audioMove",
            "audioSplit",
            "audioUpdate",
            "audioStretch",
            "audioSlip",
            "audioCrossfade",
            "audioDuplicate",
            "audioMute",
            "audioNudge",
            "audioSlice",
            "audioStrip",
            "audioConsolidate",
            "audioDelete",
            "midiList",
            "midiAdd",
            "midiMove",
            "midiResize",
            "midiDelete",
            "split",
            "moveRipple",
            "resizeRipple",
            "deleteRipple",
            "copy",
            "cut",
            "paste",
          ],
        },
        bar: {
          type: "integer",
          minimum: 1,
          description: "1-based anchor bar — the clip covering it is the target",
        },
        clipId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Stable clip id from list/audioList — preferred over bar; survives concurrent moves and ripples",
        },
        toBar: {
          type: "integer",
          minimum: 1,
          description: "For move/audioMove/midiMove — 1-based destination start bar",
        },
        bars: {
          type: "integer",
          minimum: 1,
          maximum: 64,
          description: "For resize/add/midiAdd/midiResize — length in bars (add defaults to 4)",
        },
        scene: {
          type: "string",
          maxLength: 64,
          description: "For add — target scene by id or name (case-insensitive); kyx_state subject:scenes lists them",
        },
        patternId: {
          type: "string",
          maxLength: 128,
          description: "For midiAdd — pattern id to place (default: the active pattern)",
        },
        trackId: {
          type: "string",
          description: "For audio ops — exact track id",
        },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "For audio ops — family alternative to trackId",
        },
        gain: {
          type: "number",
          minimum: 0,
          maximum: 2,
          description: "For audioUpdate — linear clip gain",
        },
        fadeIn: {
          type: "number",
          minimum: 0,
          description: "For audioUpdate — fade-in seconds",
        },
        rate: {
          type: "number",
          minimum: 0.25,
          maximum: 4,
          description: "For audioStretch — playback speed factor (2 = twice as fast)",
        },
        offsetSec: {
          type: "number",
          minimum: 0,
          description: "For audioSlip — seconds into the source (which part plays)",
        },
        curve: {
          type: "string",
          enum: ["linear", "equal"],
          description: "For audioCrossfade — fade curve (default linear)",
        },
        fadeOut: {
          type: "number",
          minimum: 0,
          description: "For audioUpdate — fade-out seconds",
        },
        pitchSemitones: {
          type: "number",
          minimum: -24,
          maximum: 24,
          description: "For audioUpdate — clip pitch in semitones (−24..+24; 0 clears the transpose)",
        },
        reverse: {
          type: "boolean",
          description: "For audioUpdate — play the clip backwards",
        },
        loop: {
          type: "boolean",
          description: "For audioUpdate — loop the trimmed content over the clip length",
        },
        muted: {
          type: "boolean",
          description: "For audioMute — true mutes, false unmutes (default true)",
        },
        sliceTimesSec: {
          type: "array",
          items: {
            type: "number",
            minimum: 0,
          },
          description:
            "For audioSlice — wall seconds from the clip's first audible moment; the clip is kept and segments are laid out after it",
        },
        segments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              startSec: {
                type: "number",
                minimum: 0,
              },
              endSec: {
                type: "number",
                minimum: 0,
              },
            },
            required: ["startSec", "endSec"],
          },
          description: "For audioStrip — the ranges to KEEP; the clip is replaced by them",
        },
        sourceDurationSec: {
          type: "number",
          minimum: 0,
          description: "For audioStrip — decoded source duration, bounds the audible window (optional)",
        },
        bufferId: {
          type: "string",
          description:
            "For audioConsolidate — the rendered bounce buffer the merged clip points at (the tool cannot render it itself)",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        status: {
          type: "string",
        },
        stage: {
          type: "string",
          enum: ["read", "runtime", "applied", "persisted", "rendered", "delivered", "dry-run", "replayed", "noop"],
        },
        changed: {
          type: "boolean",
        },
        readback: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 32,
        },
        op: {
          type: "string",
        },
        clipId: {
          type: "string",
        },
        arrangementClips: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
          },
          maxItems: 256,
        },
        audioClips: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
          },
          maxItems: 256,
        },
      },
      required: ["status", "stage"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_batch",
    description:
      "Run up to 10 tool calls in ONE submitted batch: calls: [{tool, args}…]. When the host supports undo frames, every mutation folds into a SINGLE undo entry (the result reports which contract applied); each call still returns its own read-back, and per-call failures never abort the batch. Async tools (kyx_export, kyx_loudness) and nested batches are refused — run those standalone.",
    inputSchema: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              tool: {
                type: "string",
                description: "One of the kyx_* tool names (not kyx_batch/kyx_export/kyx_loudness)",
              },
              args: {
                type: "object",
                description: "The tool's arguments object",
              },
            },
            required: ["tool"],
          },
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["calls"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
          },
        },
        mutations: {
          type: "number",
        },
        failures: {
          type: "number",
        },
        singleUndo: {
          type: "boolean",
        },
      },
      required: ["results", "mutations", "failures", "singleUndo"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_loudness",
    description:
      "Loudness loop (render-backed BS.1770): measure reports the CURRENT mix's integrated LUFS read-only; match runs measure→trim→verify toward an explicit targetDb (e.g. −14 for streaming) or a ±nudge in the given direction, landing the trim on the master config in one undo step. Runs in the KYX window; honestly refused where no render context is bound.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["measure", "match"],
        },
        targetDb: {
          type: "number",
          minimum: -24,
          maximum: -6,
          description: "For match — explicit LUFS target (default: −14 ±nudge)",
        },
        direction: {
          type: "string",
          enum: ["louder", "quieter"],
          description: "For match without targetDb — nudge direction (default louder)",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        integratedLufs: {
          type: "number",
        },
        measuredBefore: {
          type: "number",
        },
        measuredAfter: {
          type: ["number", "null"],
        },
        trimDb: {
          type: "number",
        },
        targetLufs: {
          type: "number",
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_import_sfz",
    description:
      "Import the user's SFZ instrument library: an .sfz file plus its WAV samples arrive as base64; KYX builds a multisample sampler mapping (keyzones, velocity windows, per-sample roots from pitch_keycenter) and applies it to a sampler track as ONE undoable step. The samples persist in the user's library and play immediately. Send the whole instrument in one call (decoded payload up to ~256 MB). Requires a live KYX session with a sampler track (create one via the UI, or use an existing sampler track id from kyx_state).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Instrument display name, e.g. 'My Cello'",
        },
        sfzBase64: {
          type: "string",
          description: "The .sfz file content, base64",
        },
        trackId: {
          type: "string",
          description: "Target sampler track id (from kyx_state tracks)",
        },
        samples: {
          type: "array",
          description: "The WAV files the SFZ references (16/24-bit PCM stereo or mono)",
          items: {
            type: "object",
            properties: {
              fileName: {
                type: "string",
                description: "File name EXACTLY as the SFZ sample= paths reference it",
              },
              base64: {
                type: "string",
                description: "WAV bytes, base64",
              },
            },
            required: ["fileName", "base64"],
          },
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["name", "sfzBase64", "trackId", "samples"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
        },
        trackId: {
          type: "string",
        },
        fallbackSampleId: {
          type: "string",
        },
        importedSamples: {
          type: "number",
        },
        velocityLayers: {
          type: "number",
        },
        missingSamples: {
          type: "number",
        },
        skippedSamples: {
          type: "number",
        },
      },
      required: [
        "name",
        "trackId",
        "fallbackSampleId",
        "importedSamples",
        "velocityLayers",
        "missingSamples",
        "skippedSamples",
      ],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_publish_gallery",
    description:
      "Publish the CURRENT KYX project to the public beat gallery as AGENT-MADE (shows with the robot badge + your agent name in the feed). The beat is a share-code entry: instant embed player, no audio upload. Call when the user asks to share/publish/showcase the beat you built together. Requires a live KYX session (web/desktop); standalone servers refuse honestly.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Beat title for the gallery card (max 64 chars)",
        },
        author: {
          type: "string",
          description: "Credit line (default: 'KYX agent')",
        },
        tags: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Up to 6 free-form tags",
        },
        agent: {
          type: "string",
          description: "Your agent display name, e.g. 'Claude (MCP)' (default: 'unknown agent')",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["title"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        galleryId: {
          type: "string",
        },
        origin: {
          type: "string",
        },
        agent: {
          type: "string",
        },
      },
      required: ["galleryId", "origin", "agent"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_render_summary",
    description:
      "THE AGENT'S EARS — offline-render the current project and report per-strip evidence: integrated LUFS (BS.1770-4), peak dBFS, crest factor (peak−RMS = punchiness) and duration, plus the master vs the −14 streaming reference and relative deltas against the loudest strip. Use before/after mix moves so decisions cite numbers, not vibes. Slow (N+1 offline renders); render-bound transports only.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["all", "tracks", "master"],
          description: "all = strips + master (default); tracks/master limit the pass",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        scope: {
          type: "string",
          enum: ["master", "tracks", "all"],
        },
        strips: {
          type: "array",
          items: {
            type: "object",
          },
        },
        master: {
          type: ["object", "null"],
        },
        referenceLufs: {
          type: "number",
        },
      },
      required: ["scope", "strips", "referenceLufs"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_diagnose_mix",
    description:
      "THE AGENT'S EARS v2 — a MIX DIAGNOSIS, not just numbers: offline-renders the master and every strip, runs mix-health analysis (band shares, clipping, crest collapse, stereo correlation, BS.1770 loudness) and returns attributed findings (who owns the low end, which strip is buried, which is over-compressed, sub collision) each mapped to a fix you can call (kyx_tracks setGain, kyx_fx more/less, kyx_loudness match). Apply the suggested moves, re-run this tool, compare — the full diagnose→fix→verify loop. Slower than kyx_render_summary (N+1 renders + analysis); render-bound transports only.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["all", "master", "tracks"],
          description:
            "all = master + per-strip attribution (default); master = master findings only (1 render); tracks = strips only, master render skipped (N renders — the fast verify loop after a strip-level fix)",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        scope: {
          type: "string",
        },
        referenceLufs: {
          type: "number",
        },
        master: {
          type: ["object", "null"],
        },
        strips: {
          type: "array",
          items: {
            type: "object",
          },
        },
        findings: {
          type: "array",
          items: {
            type: "object",
          },
        },
        attributions: {
          type: "array",
          items: {
            type: "string",
          },
        },
        suggestedActions: {
          type: "array",
          items: {
            type: "string",
          },
        },
        reactions: {
          type: ["object", "null"],
        },
      },
      required: ["scope", "strips", "findings", "suggestedActions"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_mix_idea",
    description:
      "TEXT-TO-MIX REMOTE CONTROL — one natural-language mix idea, the full loop: 'warm it up and glue the drums' → a PLAN of concrete device steps with the WHY attributed per step (nothing applied) → apply:true lands the whole idea as ONE undo step → verify with kyx_render_summary and let the human judge via kyx_blind_ab. Understands production concepts (warmer, punchier, brighter, deeper, wider, air…) and their targets from the sentence itself (drums, bass, lead, chords, the mix, kick/snare/hats); an explicit target overrides the text. Plan first — the plan is cheap and pure, the apply is a mutation.",
    inputSchema: {
      type: "object",
      properties: {
        idea: {
          type: "string",
          maxLength: 1000,
          description: "The mix idea in plain language, e.g. 'warm it up and glue the drums'",
        },
        target: {
          type: "string",
          maxLength: 128,
          description:
            'Optional target override: "drums | bass | lead | chords | mix | kick | snare | hats" or a track id from kyx_state',
        },
        apply: {
          type: "boolean",
          description: "false (default) = plan only; true = apply as ONE undo step",
        },
        preview: {
          type: "boolean",
          description:
            "true = render the BEFORE/AFTER masters, level-match them and arm the studio MIX PREVIEW card so the human can listen before you apply. Read-only; render-bound transports only",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["idea"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["planned", "applied", "previewed", "rejected"],
        },
        ok: {
          type: "boolean",
        },
        applied: {
          type: "boolean",
        },
        reason: {
          type: "string",
          maxLength: 2000,
        },
        interpreter: {
          type: "string",
          enum: ["production", "assistant"],
        },
        targets: {
          type: "array",
          items: {
            type: "string",
          },
        },
        goals: {
          type: "array",
          items: {
            type: "string",
          },
        },
        label: {
          type: "string",
        },
        steps: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              trackId: {
                type: "string",
              },
              track: {
                type: "string",
              },
              device: {
                type: "string",
              },
              params: {
                type: "string",
              },
              reason: {
                type: "string",
              },
            },
            required: ["trackId", "track", "device", "params", "reason"],
          },
        },
        warnings: {
          type: "array",
          items: {
            type: "string",
          },
        },
        preview: {
          type: "object",
          additionalProperties: false,
          properties: {
            laneId: {
              type: "string",
            },
            label: {
              type: "string",
            },
            targets: {
              type: "array",
              items: {
                type: "string",
              },
            },
            goals: {
              type: "array",
              items: {
                type: "string",
              },
            },
            interpreter: {
              type: "string",
              enum: ["production", "assistant"],
            },
            beforeLufs: {
              type: ["number", "null"],
            },
            afterLufs: {
              type: ["number", "null"],
            },
            matchGainDb: {
              type: "number",
              minimum: -12,
              maximum: 12,
            },
            seconds: {
              type: "number",
              minimum: 0,
            },
            studioBound: {
              type: "boolean",
            },
          },
          required: [
            "laneId",
            "label",
            "targets",
            "goals",
            "interpreter",
            "beforeLufs",
            "afterLufs",
            "matchGainDb",
            "seconds",
            "studioBound",
          ],
        },
      },
      required: ["status", "ok", "applied"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_checkpoint",
    description:
      "Named project checkpoints for agent experiments: save the current state, list checkpoints with how many steps have passed since each, restore one (ONE undo step back to the pre-restore state), or delete. Session-scoped (last 8 kept); destructive ops auto-save auto-before-<tool> checkpoints when allowed.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["save", "list", "diff", "restore", "delete"],
        },
        name: {
          type: "string",
          description: "Checkpoint name (required for diff/restore/delete)",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        status: {
          type: "string",
        },
        stage: {
          type: "string",
          enum: ["read", "runtime", "applied", "persisted", "rendered", "delivered", "dry-run", "replayed", "noop"],
        },
        changed: {
          type: "boolean",
        },
        readback: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 32,
        },
        op: {
          type: "string",
          enum: ["save", "list", "diff", "restore", "delete"],
        },
        name: {
          type: "string",
        },
        checkpoints: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 8,
        },
      },
      required: ["status", "stage"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_mix",
    description:
      "PRODUCER MOVE - apply the measured genre mix profile in ONE undo step: tone tilt, punch, sidechain pump and space decisions derived from the genre/mood, refined by explicit overrides. Returns the decision summary as the read-back.",
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
        mood: {
          type: "string",
          maxLength: 128,
          description: "Optional mood (dark, chill, warm, aggressive...)",
        },
        energy: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        tone: {
          type: "string",
          enum: ["dark", "bright", "warm", "cold"],
        },
        reverb: {
          type: "string",
          enum: ["more", "less", "huge"],
        },
        punch: {
          type: "string",
          enum: ["more", "less"],
        },
        pump: {
          type: "string",
          enum: ["on", "off"],
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["genre"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["applied", "neutral", "already_matched"],
        },
        genre: {
          type: "string",
        },
        decisionCount: {
          type: "integer",
          minimum: 0,
        },
        summary: {
          type: "array",
          items: {
            type: "string",
          },
        },
      },
      required: ["status", "genre", "decisionCount", "summary"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_arrange",
    description:
      "PRODUCER MOVE - lay out the genre song form as scenes + clips + cue markers (intro/build/drop/... with per-section intensity) in ONE undo step; returns created scene/clip/cue IDs and counts. Refused when the arrangement already has clips: use kyx_sections/kyx_clips for surgical edits on an existing arrangement.",
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
        energy: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        length: {
          type: "string",
          enum: ["short", "standard", "radio", "extended", "epic"],
          description: "Scales the form core cycles (default: genre standard)",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["genre"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["arranged", "empty", "partial"],
        },
        genre: {
          type: "string",
        },
        sections: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: {
                type: "string",
              },
              role: {
                type: "string",
                enum: ["intro", "build", "drop", "break", "outro", "fill", "verse", "chorus", "bridge", "custom"],
              },
              startBar: {
                type: "integer",
                minimum: 1,
                description: "Human-facing 1-based bar number.",
              },
              bars: {
                type: "integer",
                minimum: 1,
                description: "Section length in bars.",
              },
              intensity: {
                type: "number",
                minimum: 0,
                maximum: 1,
                description: "Normalized section intensity.",
              },
            },
            required: ["label", "role", "startBar", "bars", "intensity"],
          },
        },
        scenes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
              },
              name: {
                type: "string",
              },
              role: {
                type: "string",
                enum: ["intro", "build", "drop", "break", "outro", "fill", "verse", "chorus", "bridge", "custom"],
              },
              intensity: {
                type: "number",
                minimum: 0,
                maximum: 1,
              },
            },
            required: ["id", "name", "role", "intensity"],
          },
        },
        clips: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
              },
              sceneId: {
                type: "string",
              },
              startBar: {
                type: "integer",
                minimum: 0,
                description: "Project-model 0-based start bar.",
              },
              lengthBars: {
                type: "integer",
                minimum: 1,
                description: "Clip length in bars.",
              },
            },
            required: ["id", "sceneId", "startBar", "lengthBars"],
          },
        },
        markers: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
              },
              name: {
                type: "string",
              },
              type: {
                type: "string",
                enum: ["drop", "buildup", "riser", "impact", "cue", "custom"],
              },
              tick: {
                type: "integer",
                minimum: 0,
                description: "Absolute project tick (PPQ 480).",
              },
            },
            required: ["id", "name", "type", "tick"],
          },
        },
        sceneCount: {
          type: "integer",
          minimum: 0,
        },
        clipCount: {
          type: "integer",
          minimum: 0,
        },
        cueMarkerCount: {
          type: "integer",
          minimum: 0,
        },
        placementMismatchCount: {
          type: "integer",
          minimum: 0,
        },
        totalBars: {
          type: "integer",
          minimum: 0,
        },
        undoSteps: {
          type: "integer",
          minimum: 0,
          maximum: 1,
        },
      },
      required: [
        "status",
        "genre",
        "sections",
        "scenes",
        "clips",
        "markers",
        "sceneCount",
        "clipCount",
        "cueMarkerCount",
        "placementMismatchCount",
        "totalBars",
        "undoSteps",
      ],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_song",
    description:
      "PRODUCER MOVE, MEGA - build the WHOLE track in one call: generate the genre song form (patterns per section), lay out scenes + clips + markers, and apply the measured mix profile - all folded into ONE undo step. Optional loudness target adds a render-backed trim as a second undo step (needs the render context). Slow: full generation, uses the extended 60 s MCP call window.",
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
        mood: {
          type: "string",
          description: "Optional mood (dark, chill, warm, aggressive...)",
        },
        energy: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        length: {
          type: "string",
          enum: ["short", "standard", "radio", "extended", "epic"],
          description: "Scales the form core cycles (default: genre standard)",
        },
        mix: {
          type: "boolean",
          description: "Apply the measured mix profile after the song lands (default true)",
        },
        loudness: {
          type: "number",
          description: "Target integrated LUFS - adds a render-backed loudness trim (second undo step)",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["genre"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        status: {
          type: "string",
        },
        stage: {
          type: "string",
          enum: ["read", "runtime", "applied", "persisted", "rendered", "delivered", "dry-run", "replayed", "noop"],
        },
        changed: {
          type: "boolean",
        },
        readback: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 32,
        },
        genre: {
          type: "string",
        },
        sections: {
          type: "integer",
          minimum: 0,
          maximum: 512,
        },
      },
      required: ["status", "stage"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_routing",
    description:
      "The group routing graph AND send buses: list every track's destination (its group or master) with a structured envelope, create a group bus, route tracks into it (addToGroup) or back to master (removeFromGroup). The model is FLAT — one group per track, no group-into-group — so routing cycles are impossible by construction. Successful writes return committed values and explicit no-op status. setSend/setReturnGain/createReturn cover the send-bus mixer; removeReturn drops a bus and every send reference into it (destructive-gated).",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
            "list",
            "createGroup",
            "addToGroup",
            "removeFromGroup",
            "setSend",
            "setReturnGain",
            "createReturn",
            "removeReturn",
          ],
        },
        trackId: {
          type: "string",
          maxLength: 128,
          description: "Exact track id — overrides family when present",
        },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "Family alternative to trackId (applies to every resolved track)",
        },
        groupId: {
          type: "string",
          maxLength: 128,
          description: "For addToGroup — the group track id (op:list)",
        },
        groupName: {
          type: "string",
          maxLength: 40,
          description: "For addToGroup — group name alternative to groupId",
        },
        name: {
          type: "string",
          maxLength: 40,
          description: "For createGroup/createReturn — optional name (default: Group N / Return N)",
        },
        returnId: {
          type: "string",
          maxLength: 128,
          description: "For setSend/setReturnGain/removeReturn — the return bus id (op:list)",
        },
        returnName: {
          type: "string",
          maxLength: 40,
          description: "Return bus name alternative to returnId",
        },
        level: {
          type: "number",
          minimum: 0,
          maximum: 1.5,
          description: "For setSend — linear send level (1.0 = unity)",
        },
        gain: {
          type: "number",
          minimum: 0,
          maximum: 1.5,
          description: "For setReturnGain — linear return fader",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: [
            "listed",
            "created",
            "routed",
            "already_routed",
            "unrouted",
            "already_unrouted",
            "send_set",
            "send_unchanged",
            "return_gain_set",
            "return_gain_unchanged",
            "return_created",
            "return_removed",
            "partial",
          ],
        },
        routes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              trackId: {
                type: "string",
              },
              track: {
                type: "string",
              },
              destination: {
                type: "string",
              },
              destinationName: {
                type: "string",
              },
            },
            required: ["trackId", "track", "destination", "destinationName"],
          },
        },
        groups: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
              },
              name: {
                type: "string",
              },
              memberCount: {
                type: "integer",
                minimum: 0,
              },
            },
            required: ["id", "name", "memberCount"],
          },
        },
        returns: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
              },
              name: {
                type: "string",
              },
              gain: {
                type: "number",
                minimum: 0,
                maximum: 1.5,
              },
              sends: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    trackId: {
                      type: "string",
                    },
                    track: {
                      type: "string",
                    },
                    level: {
                      type: "number",
                      minimum: 0,
                      maximum: 1.5,
                    },
                  },
                  required: ["trackId", "track", "level"],
                },
              },
            },
            required: ["id", "name", "gain", "sends"],
          },
        },
        groupId: {
          type: "string",
        },
        groupName: {
          type: "string",
        },
        returnId: {
          type: "string",
        },
        returnName: {
          type: "string",
        },
        returnExists: {
          type: "boolean",
        },
        trackIds: {
          type: "array",
          items: {
            type: "string",
          },
        },
        changedTrackIds: {
          type: "array",
          items: {
            type: "string",
          },
        },
        sendLevel: {
          type: "number",
          minimum: 0,
          maximum: 1.5,
        },
        requestedLevel: {
          type: "number",
        },
        returnGain: {
          type: "number",
          minimum: 0,
          maximum: 1.5,
        },
        removedSendCount: {
          type: "integer",
          minimum: 0,
        },
        undoSteps: {
          type: "integer",
          minimum: 0,
          maximum: 1,
        },
      },
      required: ["status"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_unsuno",
    description:
      "UN-SUNO — TRACK TO EDITABLE PROJECT (ADR 0019, the demo pipeline). transcribe: decode a user-library audio id, transcribe it (tempo, key, drums, bass, chords — deterministic DSP lanes) and BUILD a playable project: drum/bass/keys tracks, section patterns, scenes, markers — ONE undo step. Requires a live session able to load user-sample audio (headless servers refuse honestly). restyle: swap the BAND through an artist preset (genre kit + instrument presets + mix profile) while the composition stays byte-equal. regen: REGENERATE section content in the artist's style (genre groove drums + bass rhythm) keeping the source harmony and structure. similarity: numerical composition overlap of the CURRENT project vs the transcribed source (percent + verdict — NOT legal clearance). The source fingerprint is session-scoped: similarity works after a transcribe in the same session.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["transcribe", "restyle", "regen", "similarity"],
        },
        sourceId: {
          type: "string",
          description:
            "User-library audio id (required for transcribe) — e.g. from kyx_import or the user samples list",
        },
        artist: {
          type: "string",
          description: 'Artist label for restyle/regen — exact label (e.g. "travis scott", "fisher")',
        },
        separation: {
          type: "string",
          enum: ["off", "hpss"],
          description:
            'transcribe: "off" (default, full mix) or "hpss" (Tier-1 guide stems slow the pass but lift bass/drums lanes)',
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["action"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        status: {
          type: "string",
        },
        stage: {
          type: "string",
          enum: ["read", "runtime", "applied", "persisted", "rendered", "delivered", "dry-run", "replayed", "noop"],
        },
        changed: {
          type: "boolean",
        },
        readback: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 32,
        },
        action: {
          type: "string",
          enum: ["transcribe", "restyle", "regen", "similarity"],
        },
      },
      required: ["status", "stage"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_master",
    description:
      "Mastering read-back and ZENIT controls. status reports the ordered global KYX MASTER signal path, delivery profile, runtime fallbacks and a live meter snapshot when available; it also lists ZENIT instances. Other ops insert or manage the ZENIT composite mastering device (ADR 0020) on a track/group bus. op:ab saves, compares and restores session-only snapshots of ZENIT/APEX/SPAN/TIDE parameters and output trims. A group-hosted ZENIT shapes that stem before the final global master chain. Use platform/land for profile checks and explicit loudness adjustment; live meter snapshots are not full-song reports.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["add", "preset", "trim", "assist", "iterate", "land", "platform", "stems", "ab", "remove", "status"],
        },
        trackId: {
          type: "string",
          description: "Exact track id — overrides family when present",
        },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "Family alternative to trackId",
        },
        target: {
          type: "string",
          enum: ["streaming", "club", "vinyl"],
          description: "For op:preset — the mastering target shape",
        },
        profile: {
          type: "string",
          enum: ["streaming", "apple", "loud", "vinyl", "custom"],
          description: "For op:land / op:platform / op:assist — the delivery target profile to evaluate",
        },
        targetLufs: {
          type: "number",
          minimum: -24,
          maximum: 0,
          description: "For op:assist / op:land / op:platform — loudness target override",
        },
        targetTruePeakDb: {
          type: "number",
          minimum: -12,
          maximum: 0,
          description: "For op:land / op:platform — maximum true peak in dBTP (overrides the profile)",
        },
        insert: {
          type: "boolean",
          description: "For op:assist — insert any missing mastering devices on the bus before applying the plan",
        },
        action: {
          type: "string",
          enum: ["save", "list", "compare", "restore"],
          description: "For op:ab — snapshot action",
        },
        import: {
          type: "array",
          description:
            "For op:stems — stem buffers to import as project lanes BEFORE mastering: [{role, bufferId, durationSec}] (roles: vocals/drums/bass/other). The lanes land in one STEMS bus, then get their per-role mastering shapes.",
          items: {
            type: "object",
            properties: {
              role: {
                type: "string",
                enum: ["vocals", "drums", "bass", "other"],
              },
              bufferId: {
                type: "string",
              },
              durationSec: {
                type: "number",
                minimum: 0.1,
              },
            },
            required: ["role", "bufferId", "durationSec"],
          },
        },
        reference: {
          type: "object",
          description:
            "For op:assist — measured reference values. Each supplied field is compared only with the same measured field on the live master; missing values are skipped, never estimated.",
          properties: {
            lufs: {
              type: "number",
            },
            crestDb: {
              type: "number",
            },
            correlation: {
              type: "number",
              minimum: -1,
              maximum: 1,
            },
            hfShare: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
            lowEndShare: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
          },
        },
        trimDb: {
          type: "number",
          minimum: -18,
          maximum: 12,
          description: "For op:trim — output-trim delta in dB (e.g. target LUFS minus measured LUFS)",
        },
        instance: {
          type: "integer",
          minimum: 1,
          description: "1-based ZENIT instance index when a track carries more than one",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        status: {
          type: "string",
        },
        stage: {
          type: "string",
          enum: ["read", "runtime", "applied", "persisted", "rendered", "delivered", "dry-run", "replayed", "noop"],
        },
        changed: {
          type: "boolean",
        },
        readback: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 32,
        },
        op: {
          type: "string",
        },
        profileId: {
          type: "string",
        },
        applied: {
          type: "boolean",
        },
      },
      required: ["status", "stage"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_takes",
    description:
      "Take groups (comp workflow): list every group with its track, the ACTIVE take and the alternatives (clips per take), or activate a take — the comp pick that decides which alternative is heard. Reversible (one undo step); returns stable group/take IDs and clip counts. deleteTake (destructive-gated) removes every clip of one take.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "activate", "deleteTake"],
        },
        groupId: {
          type: "string",
          maxLength: 128,
          description: "For activate/deleteTake — the take group id (op:list)",
        },
        takeId: {
          type: "string",
          maxLength: 128,
          description: "The take id to activate or delete",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["empty", "listed", "activated", "already_active", "deleted", "already_absent", "partial"],
        },
        groups: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
              },
              trackId: {
                type: "string",
              },
              track: {
                type: "string",
              },
              activeTakeId: {
                type: "string",
              },
              compTakeId: {
                type: ["string", "null"],
              },
              takes: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    takeId: {
                      type: ["string", "null"],
                    },
                    clipCount: {
                      type: "integer",
                      minimum: 0,
                    },
                  },
                  required: ["takeId", "clipCount"],
                },
              },
            },
            required: ["id", "trackId", "track", "activeTakeId", "compTakeId", "takes"],
          },
        },
        groupId: {
          type: "string",
        },
        takeId: {
          type: "string",
        },
        activeTakeId: {
          type: "string",
        },
        clipCount: {
          type: "integer",
          minimum: 0,
        },
        deletedClipCount: {
          type: "integer",
          minimum: 0,
        },
        remainingTakeClipCount: {
          type: "integer",
          minimum: 0,
        },
        remainingGroupClipCount: {
          type: "integer",
          minimum: 0,
        },
        groupRemaining: {
          type: "boolean",
        },
        undoSteps: {
          type: "integer",
          minimum: 0,
          maximum: 1,
        },
      },
      required: ["status"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  {
    name: "kyx_blind_ab",
    description:
      "Blind A/B listening loop: derive symmetric LUFS level-matching gains for two mix variants (so neither side is privileged), record the human listener's forced-choice trials, and get the two-sided binomial verdict (chance 0.5) over the accumulated evidence. The agent plans and counts; the human listens.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["plan", "record", "verdict", "reset"],
        },
        lufsA: {
          type: "number",
          description: "For plan — measured integrated LUFS of variant A",
        },
        lufsB: {
          type: "number",
          description: "For plan — measured integrated LUFS of variant B",
        },
        lane: {
          type: "string",
          maxLength: 128,
          description: "Trial lane name (record/verdict), e.g. 'tilt-vs-flat' (max 128 characters)",
        },
        xWas: {
          type: "string",
          enum: ["A", "B"],
          description: "For record — which side was X",
        },
        answer: {
          type: "string",
          enum: ["A", "B"],
          description: "For record — what the listener answered",
        },
        reactionMs: {
          type: "integer",
          minimum: 0,
          maximum: 86400000,
          description: "For record — milliseconds from first playback (0–24 hours)",
        },
        confirm: {
          type: "boolean",
          description: "For reset — must be true to clear all session trial lanes and their accumulated evidence",
        },
        requestId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
        },
      },
      required: ["op"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        op: {
          type: "string",
          enum: ["plan", "record", "verdict", "reset"],
        },
        status: {
          type: "string",
          enum: ["planned", "recorded", "summarized", "no_trials", "cleared"],
        },
        lane: {
          type: "string",
          maxLength: 128,
        },
        gains: {
          type: "object",
          additionalProperties: false,
          properties: {
            matched: {
              type: "boolean",
            },
            targetLufs: {
              type: ["number", "null"],
            },
            gainDbA: {
              type: "number",
              minimum: -12,
              maximum: 12,
            },
            gainDbB: {
              type: "number",
              minimum: -12,
              maximum: 12,
            },
            note: {
              type: "string",
            },
          },
          required: ["matched", "targetLufs", "gainDbA", "gainDbB", "note"],
        },
        trial: {
          type: "object",
          additionalProperties: false,
          properties: {
            lane: {
              type: "string",
              maxLength: 128,
            },
            xWas: {
              type: "string",
              enum: ["A", "B"],
            },
            answer: {
              type: "string",
              enum: ["A", "B"],
            },
            correct: {
              type: "boolean",
            },
            reactionMs: {
              type: "integer",
              minimum: 0,
              maximum: 86400000,
            },
            receivedAt: {
              type: "integer",
              minimum: 0,
            },
          },
          required: ["lane", "xWas", "answer", "correct", "receivedAt"],
        },
        summary: {
          type: "object",
          additionalProperties: false,
          properties: {
            lane: {
              type: "string",
              maxLength: 128,
            },
            total: {
              type: "integer",
              minimum: 0,
            },
            correct: {
              type: "integer",
              minimum: 0,
            },
            pValue: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
            hastyExcluded: {
              type: "integer",
              minimum: 0,
            },
            verdict: {
              type: "string",
            },
          },
          required: ["lane", "total", "correct", "pValue", "hastyExcluded", "verdict"],
        },
        total: {
          type: "integer",
          minimum: 0,
        },
        correct: {
          type: "integer",
          minimum: 0,
        },
        pValue: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        hastyExcluded: {
          type: "integer",
          minimum: 0,
        },
        verdict: {
          type: "string",
        },
        clearedLanes: {
          type: "integer",
          minimum: 0,
          maximum: 64,
        },
        clearedTrials: {
          type: "integer",
          minimum: 0,
          maximum: 5000,
        },
      },
      required: ["op", "status"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
];

/**
 * MCP hub — owns the one authenticated KYX relay session and turns tool
 * calls into forwarded requests. `sendToSession(payload)` is injected by
 * the host (collab server ws / desktop IPC).
 */
/** VERBATIM MIRROR of MCP_RESOURCES in src/mcp/tools.ts — pinned by
 * tests/mcp-core.test.ts. Passive reads; content is always live from the
 * KYX window (relayed through the hidden __kyx_resource tool channel). */
export const MCP_RESOURCE_DEFS = [
  {
    uri: "kyx://project/overview",
    name: "Project overview",
    description: "Tempo, key, track list, patterns, scenes and the active pattern.",
    mimeType: "text/plain",
  },
  {
    uri: "kyx://project/pattern",
    name: "Active pattern grid",
    description: "Per-family step map of the ACTIVE pattern with mean velocities.",
    mimeType: "text/plain",
  },
  {
    uri: "kyx://project/mix",
    name: "Mix state",
    description: "FX chain of every track (with bypass flags) and the groove settings.",
    mimeType: "text/plain",
  },
  {
    uri: "kyx://project/arrangement",
    name: "Arrangement map",
    description: "Scenes with roles/bars/intensity and the cue markers.",
    mimeType: "text/plain",
  },
  {
    uri: "kyx://project/history",
    name: "Undo history",
    description: "The most recent document commands (undo targets).",
    mimeType: "text/plain",
  },
  {
    uri: "kyx://session/capabilities",
    name: "Session capabilities",
    description:
      "What THIS transport can actually execute: export, meters, loudness, render/diagnose, gallery, SFZ import, UN-SUNO PCM, save, offline mix render, undo frames, destructive unlock, and the current cancellation contract.",
    mimeType: "application/json",
  },
  {
    uri: "kyx://playbook",
    name: "Producer playbook",
    description:
      "The agent manual: workflows (beat/compose/mix/arrange/live/publish), the tool index, the read-act-verify loop, token economy and how to react to honest refusals.",
    mimeType: "text/plain",
  },
  {
    uri: "kyx://vocab",
    name: "Intent vocabulary",
    description:
      "What free-text kyx_intent understands (EN + SK) per category, with the rule of thumb for structured-vs-free-text choices.",
    mimeType: "text/plain",
  },
];

/** Session id used by a host that connects exactly one executor (desktop, tests). */
const DEFAULT_SESSION_ID = "default";

export function createMcpHub({
  token,
  sendToSession,
  callTimeoutMs = CALL_TIMEOUT_MS,
  longCallTimeoutMs = LONG_CALL_TIMEOUT_MS,
}) {
  let sessionConnected = false;
  /**
   * Id of the window that owns the relay, or null when none is connected.
   * ONE executor session: a result is honoured only from THAT session, so a
   * displaced window cannot resolve the live window's calls. Without the
   * identity, a second window taking over the relay kept answering with its
   * own `mcp-result` frames — the agent's edit landed in a different
   * project's document and the call still resolved successfully.
   */
  let sessionId = null;
  let nextCallId = 1;
  const pendingCalls = new Map();

  return {
    /** Relay session connected (KYX window). The last caller wins ownership. */
    connectSession(id = DEFAULT_SESSION_ID) {
      sessionConnected = true;
      sessionId = id;
      return id;
    },
    disconnectSession(id = DEFAULT_SESSION_ID) {
      // A DISPLACED window closing must not tear down the session that took
      // over from it — that would reject the live window's in-flight calls.
      if (id !== DEFAULT_SESSION_ID && id !== sessionId) return;
      sessionConnected = false;
      sessionId = null;
      for (const [, entry] of pendingCalls) {
        clearTimeout(entry.timer);
        entry.reject(new Error("KYX session disconnected"));
      }
      pendingCalls.clear();
    },
    hasSession() {
      return sessionConnected;
    },
    /** Which window currently owns the relay (null = none). */
    sessionId() {
      return sessionId;
    },
    /** Forward a tool call to the KYX session; resolves the result text. */
    async callTool(name, args) {
      if (!sessionConnected) throw new Error("KYX session not connected — open KYX and enable MCP");
      const id = nextCallId++;
      // Relay frame — the browser bridge expects { type: "mcp-call", id, tool, args }, NOT the raw JSON-RPC envelope (a live E2E caught these halves speaking different dialects).
      const payload = { type: "mcp-call", id, tool: name, args: args ?? {} };
      const timeoutMs = LONG_RUNNING_MCP_TOOLS.has(name) ? longCallTimeoutMs : callTimeoutMs;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingCalls.delete(id);
          reject(new Error("KYX session timed out"));
        }, timeoutMs);
        pendingCalls.set(id, { resolve, reject, timer });
      });
      sendToSession(payload);
      return promise;
    },
    /** Resolve a forwarded call response arriving from the relay. */
    handleSessionMessage(message, id = DEFAULT_SESSION_ID) {
      if (!sessionConnected) return false;
      // A displaced window is still connected for a moment; its answers are
      // about a DIFFERENT document and must never resolve this call.
      if (id !== sessionId) return false;
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
export async function handleMcpRequest(hub, expectedToken, authHeader, body, protocolVersionHeader) {
  if (!isValidToken(authHeader, expectedToken)) {
    return rpcError(null, -32001, "unauthorized (missing or wrong MCP token)");
  }
  if (!hub.hasSession()) {
    return rpcError(null, -32002, "KYX session not connected — open KYX and enable MCP");
  }
  // JSON-RPC batch (legacy revisions only — 2025-06-18 removed batching and
  // modern (2026-07-28) is one-message-per-request): an array body fans out
  // request-by-request; notifications produce no entry, so the response can
  // be empty.
  let parsedBody;
  try {
    parsedBody = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return rpcError(null, RPC_ERRORS.parse, "Parse error");
  }
  if (!Array.isArray(parsedBody) && parsedBody?.method === "initialize") {
    negotiatedProtocolVersionByHub.set(hub, negotiateProtocolVersion(parsedBody.params?.protocolVersion));
  }
  const headerVersion =
    typeof protocolVersionHeader === "string" && protocolVersionHeader.length > 0 ? protocolVersionHeader : null;
  if (headerVersion != null && !SUPPORTED_PROTOCOL_VERSIONS.includes(headerVersion)) {
    return unsupportedProtocolError(Array.isArray(parsedBody) ? null : parsedBody?.id, headerVersion);
  }
  // Missing both the header and a handshake, MCP says assume 2025-03-26 (the
  // last revision that required nothing extra) — never claim the modern era
  // for an unidentified client.
  const negotiatedProtocolVersion = headerVersion ?? negotiatedProtocolVersionByHub.get(hub) ?? "2025-03-26";
  if (Array.isArray(parsedBody)) {
    if (!JSON_RPC_BATCH_PROTOCOL_VERSIONS.has(negotiatedProtocolVersion)) {
      return rpcError(null, RPC_ERRORS.invalidRequest, "JSON-RPC batching is not supported by this protocol version");
    }
    const responses = [];
    for (const item of parsedBody) {
      const response = await handleSingleRequest(hub, item, negotiatedProtocolVersion);
      if (response !== undefined) responses.push(response);
    }
    return responses;
  }
  return handleSingleRequest(hub, parsedBody, negotiatedProtocolVersion);
}

async function handleSingleRequest(hub, rpc, negotiatedProtocolVersion) {
  const parsed = parseRpc(rpc);
  if (!parsed.ok) return parsed.error;

  // Modern (2026-07-28+) requests declare their version in `_meta`; an
  // unsupported version answers UnsupportedProtocolVersionError and the client
  // retries with a mutually supported one. On Streamable HTTP the same version
  // may instead arrive in the `MCP-Protocol-Version` header (2025-06-18+
  // requirement) — either channel selects the modern stateless shape.
  const modernVersion = requestProtocolVersion(parsed.params);
  const headerEra = negotiatedProtocolVersion === PROTOCOL_VERSION;
  const modern = modernVersion != null || headerEra;
  if (modernVersion != null && !SUPPORTED_PROTOCOL_VERSIONS.includes(modernVersion)) {
    return unsupportedProtocolError(parsed.id, modernVersion);
  }
  const requestVersion = modernVersion ?? negotiatedProtocolVersion;

  // `server/discover` (modern only, MUST implement): advertise versions,
  // capabilities and identity up front.
  if (parsed.method === "server/discover") {
    if (!modern) {
      return rpcError(parsed.id, RPC_ERRORS.methodNotFound, `method not found: ${parsed.method}`);
    }
    return rpcResult(parsed.id, discoverResult());
  }

  if (parsed.method === "initialize") {
    // A modern-only server would reject this; a dual-era server answers the
    // handshake for legacy clients (and names its supported versions so a
    // modern client that sent initialize by mistake can recover).
    return rpcResult(
      parsed.id,
      withServerMeta(
        {
          protocolVersion: negotiateProtocolVersion(parsed.params?.protocolVersion),
          capabilities: { tools: {}, resources: {} },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        },
        modern,
      ),
    );
  }
  if (parsed.method === "notifications/initialized") {
    return undefined; // notification — no response
  }
  if (parsed.method === "tools/list") {
    const tools = supportsStructuredOutput(requestVersion)
      ? MCP_TOOL_DEFS
      : MCP_TOOL_DEFS.map(({ outputSchema, ...tool }) => tool);
    return rpcResult(parsed.id, withServerMeta({ ...(modern ? { resultType: "complete" } : {}), tools }, modern));
  }
  if (parsed.method === "resources/list") {
    return rpcResult(
      parsed.id,
      withServerMeta({ ...(modern ? { resultType: "complete" } : {}), resources: MCP_RESOURCE_DEFS }, modern),
    );
  }
  if (parsed.method === "resources/read") {
    const uri = String(parsed.params?.uri ?? "");
    if (!MCP_RESOURCE_DEFS.some((resource) => resource.uri === uri)) {
      return rpcError(parsed.id, RPC_ERRORS.invalidParams, `unknown resource: ${uri}`);
    }
    try {
      const result = await hub.callTool("__kyx_resource", { uri });
      return rpcResult(
        parsed.id,
        withServerMeta(
          {
            ...(modern ? { resultType: "complete" } : {}),
            contents: [{ uri, mimeType: "text/plain", text: result.text ?? "" }],
          },
          modern,
        ),
      );
    } catch (error) {
      return rpcError(parsed.id, RPC_ERRORS.internal, error instanceof Error ? error.message : String(error));
    }
  }
  if (parsed.method === "tools/call") {
    const name = parsed.params?.name;
    if (typeof name !== "string" || !MCP_TOOL_DEFS.some((tool) => tool.name === name)) {
      return rpcError(parsed.id, rpcErrorsInvalidParams(), `unknown tool: ${String(name)}`);
    }
    try {
      const result = await hub.callTool(name, parsed.params?.arguments ?? {});
      const resultText = result.text ?? "";
      const content = [
        {
          type: "text",
          text:
            result.isError === true && typeof result.errorCode === "string"
              ? `${result.errorCode}: ${resultText}`
              : resultText,
        },
      ];
      if (result.audio && typeof result.audio.data === "string" && typeof result.audio.mimeType === "string") {
        content.push({ type: "audio", data: result.audio.data, mimeType: result.audio.mimeType });
      }
      const hasStructuredContent =
        result.data != null && typeof result.data === "object" && !Array.isArray(result.data);
      const meta = {};
      if (typeof result.stage === "string") meta["kyx/stage"] = result.stage;
      if (typeof result.risk === "string") meta["kyx/risk"] = result.risk;
      const payload = {
        content,
        isError:
          result.isError === true || (result.mutated === false && String(result.text ?? "").startsWith("unknown")),
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      };
      const supportsStructuredResults = supportsStructuredOutput(requestVersion);
      if (supportsStructuredResults && hasStructuredContent) payload.structuredContent = result.data;
      const outputSchema = MCP_TOOL_DEFS.find((tool) => tool.name === name)?.outputSchema;
      const missingStructuredContent =
        supportsStructuredResults && outputSchema != null && !payload.isError && !hasStructuredContent;
      if (missingStructuredContent) {
        content[0].text = `tool ${name} did not return structuredContent required by its outputSchema — ${content[0].text}`;
        payload.isError = true;
      }
      return rpcResult(
        parsed.id,
        withServerMeta({ ...(modern ? { resultType: "complete" } : {}), ...payload }, modern),
      );
    } catch (error) {
      return rpcResult(
        parsed.id,
        withServerMeta(
          {
            ...(modern ? { resultType: "complete" } : {}),
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          },
          modern,
        ),
      );
    }
  }
  if (parsed.method === "ping") {
    // `ping` is legacy-only (removed in the modern revision) — keep answering
    // it so older clients stay healthy, but modern clients should not send it.
    return rpcResult(parsed.id, withServerMeta({}, modern));
  }
  return rpcError(parsed.id, RPC_ERRORS.methodNotFound, `method not found: ${parsed.method}`);
}

function rpcErrorsInvalidParams() {
  return -32602;
}
