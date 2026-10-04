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
      },
      required: ["instruction"],
    },
  },
  {
    name: "kyx_state",
    description:
      "Read-only project snapshot: tempo, key, time signature, track list, markers, groove, the ACTIVE pattern's step grid, the arrangement scenes, the send routing map (returns + per-track send levels), the undo history, or the FX chain of one family. Never mutates.",
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
          ],
          description: "Which part of the project state to return",
        },
        family: {
          type: "string",
          enum: ["kick", "snare", "clap", "hat", "perc", "tom", "bass", "lead", "chords", "drums"],
          description: "Optional track family filter for fxChain and sends",
        },
      },
      required: ["subject"],
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
      },
      required: ["action"],
    },
  },
  {
    name: "kyx_transport",
    description:
      "Transport control AND reads: play, stop, pause, loop on/off, metronome on/off — or seek to a 1-based bar (optional beat), set the loop region in bars (loopRegion), or state: a read-only read-back of the playhead position (bar/beat/tick), playing state, loop region and metronome. Position is 4/4-based (1920 ticks per bar, 480 per beat).",
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
          description: "For seek — 1-based destination bar",
        },
        scene: {
          type: "string",
          description: 'launchScene — scene NAME or ROLE (e.g. "drop", "chorus")',
        },
        index: {
          type: "integer",
          minimum: 1,
          description: "launchScene — 1-based index as kyx_state scenes lists them (alternative to scene)",
        },
        play: {
          type: "boolean",
          description: "launchScene — start playback after the jump (default true)",
        },
        beat: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "For seek — 1-based beat within the bar (default 1)",
        },
        startBar: {
          type: "integer",
          minimum: 1,
          description: "For loopRegion — first looped bar (1-based)",
        },
        endBar: {
          type: "integer",
          minimum: 2,
          description: "For loopRegion — last looped bar (inclusive; must be > startBar)",
        },
      },
      required: ["action"],
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
      },
      required: ["format"],
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
  },
  {
    name: "kyx_generate",
    description:
      "Generate a new pattern from an intent spec (deterministic engine, one undo step). Returns the pattern name and resolved BPM.",
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
          description: "Pattern length in bars (16 steps per bar; default engine choice)",
        },
        replaceMode: {
          type: "string",
          enum: ["new", "replace"],
          description: "replace = overwrite the active pattern in place (default: add a new pattern)",
        },
        roles: {
          type: "array",
          items: {
            type: "string",
            enum: ["drums", "bass", "chords", "lead"],
          },
          description: "Which roles the pattern plays (default all)",
        },
      },
      required: ["genre"],
    },
  },
  {
    name: "kyx_groove",
    description:
      "Groove/swing control. Global (no section) adjusts project swing; section-scoped bakes microtiming into that section's pattern.",
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
          description: "Omit = global groove",
        },
        percent: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description: "Only for direction 'set'",
        },
      },
      required: ["direction"],
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
          ],
        },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "Track family target — required unless trackId is given",
        },
        trackId: {
          type: "string",
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
          instance: {
            type: "integer",
            minimum: 1,
            description:
              "1-based same-type instance — scopes remove/bypass/enable/reorder to ONE instance (default: all instances of the type)",
          },
          direction: {
            type: "string",
            enum: ["earlier", "later"],
            description: "For reorder — move the instance one slot toward the input (earlier) or output (later)",
          },
          position: {
            type: "integer",
            minimum: 1,
            description: "For reorder — 1-based final slot in the chain",
          },
        },
      },
      required: ["effect", "action"],
    },
  },
  {
    name: "kyx_sections",
    description:
      "Arrangement operations: add/remove/duplicate/reorder/resize named sections (intro/build/chorus/verse/bridge/drop/break/outro/fill).",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["add", "remove", "duplicate", "reorder", "resize", "intensity"],
        },
        intensity: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "op=intensity — target scene intensity 0..1",
        },
        scene: {
          type: "string",
          description: "op=intensity — scene name or role (also: index)",
        },
        index: {
          type: "integer",
          minimum: 1,
          description: "op=intensity — 1-based scene index (alternative to scene)",
        },
        value: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "op=intensity — the target intensity 0..1",
        },
        role: {
          type: "string",
          enum: ["intro", "build", "chorus", "verse", "bridge", "drop", "break", "outro", "fill"],
        },
        bars: {
          type: "integer",
          minimum: 1,
          maximum: 64,
          description: "For resize",
        },
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
        op: {
          type: "string",
          enum: ["add", "remove", "rename"],
        },
        bar: {
          type: "integer",
          minimum: 1,
          description: "1-based bar",
        },
        name: {
          type: "string",
          description: "Optional marker name",
        },
      },
      required: ["op", "bar"],
    },
  },
  {
    name: "kyx_tracks",
    description:
      "Track CRUD + absolute mixer setters: add a drum or instrument track, remove/rename by family or exact trackId (group tracks are not addressable here — removing the last track is declined), or set mixer values with verify-by-read: setGain (absolute gainDb −60..+3.5 or linear gain 0..1.5), setPan (−1..1), setMute/setSolo (value boolean). set* ops apply to every track the family resolves to.",
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
            "remove",
            "rename",
            "setGain",
            "setPan",
            "setMute",
            "setSolo",
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
          enum: ["analog", "bass", "808", "keys", "pluck", "acid", "reese", "brass", "flute", "sampler"],
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
      },
      required: ["op"],
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
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_steps",
    description:
      "Structured step-grid edit on the ACTIVE pattern's drum pads (16 steps per bar, 1-based indexes across the whole pattern). add sets velocity, remove clears, toggle flips, ghost places a soft probabilistic hit, clearPad empties the whole family. Returns a verification read-back with the family's before → after step counts.",
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
            maximum: 256,
          },
          description: "1-based 16th-step indexes within the pattern (16 per bar). Not used by clearPad.",
        },
        velocity: {
          type: "number",
          minimum: 0.05,
          maximum: 1,
          description: "For add (default 0.8)",
        },
      },
      required: ["op", "family"],
    },
  },
  {
    name: "kyx_notes",
    description:
      "Melodic COMPOSITION on the active pattern (the melodic half kyx_steps does not cover): list/add/move/delete notes, set velocity, quantize to grid or key, transpose a family's whole line. Notes are addressed by INDEX into the list response — call {op:'list'} first, indices are positions in it. Every op is one undo step through the audited command layer (pitch/velocity clamps, pattern-bounds fit).",
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
          description: "Position in the list response (move/delete/setVelocity)",
        },
        startBeat: {
          type: "number",
          minimum: 0,
          description: "Start in beats from pattern start (add; move absolute)",
        },
        durationBeats: {
          type: "number",
          minimum: 0.05,
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
          description: 'quantize target scale, e.g. "C Major", "A Minor"',
        },
        semitones: {
          type: "integer",
          minimum: -127,
          maximum: 127,
          description: "transpose shift (non-zero)",
        },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_music",
    description:
      "Structured MUSICAL STATE: set tempo, set musical key, change the active pattern's length, or transpose all melodic content. One op = ONE undo step through the exact-intent executor (same clamps as the text layer).",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["setTempo", "setKey", "setPatternLength", "transposeAll"],
        },
        bpm: {
          type: "integer",
          minimum: 20,
          maximum: 300,
          description: "setTempo",
        },
        key: {
          type: "string",
          description: 'setKey — e.g. "C Major", "F# Minor", "Bb Minor"',
        },
        steps: {
          type: "integer",
          minimum: 16,
          maximum: 256,
          description: "setPatternLength (16 per bar)",
        },
        semitones: {
          type: "integer",
          minimum: -127,
          maximum: 127,
          description: "transposeAll shift (non-zero)",
        },
        target: {
          type: "string",
          description: 'transposeAll scope: track family or "all" (default all)',
        },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_catalog",
    description:
      "Discovery — what the DAW can do, machine-readable: list every effect type with its category and primary knob, the FULL parameter table of one effect (id, label, min, max, default, unit, kind, taper), or the instrument kind catalog. Read-only; use it before kyx_plugin_param instead of guessing ranges.",
    inputSchema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          enum: ["effects", "effect", "instruments"],
        },
        effect: {
          type: "string",
          description: "Effect type for subject:effect (e.g. reverb, eq, compressor) — see subject:effects",
        },
      },
      required: ["subject"],
    },
  },
  {
    name: "kyx_plugin_param",
    description:
      "Precise plugin control on inserted FX instances: set ONE parameter to an absolute NATIVE value (clamped to the registry range; see kyx_catalog subject:effect for min/max/default/unit) or list the current values of every parameter on the targeted tracks' chains. Targets a trackId or a family; instance picks 1-based among same-type instances (default 1). Missing instances are reported honestly — nothing is auto-inserted (use kyx_fx more for that).",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "set"],
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
        effect: {
          type: "string",
          description: "Effect type (e.g. reverb, eq) — required for set, filters list when given; see kyx_catalog",
        },
        instance: {
          type: "integer",
          minimum: 1,
          description: "1-based index among same-type instances in chain order (default 1)",
        },
        param: {
          type: "string",
          description: "Parameter id for set (e.g. mix, decay, freq) — see kyx_catalog",
        },
        value: {
          type: "number",
          description: "Absolute NATIVE value for set (NOT normalized 0..1 unless the param's range is 0..1)",
        },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_meter",
    description:
      "Live audio meters — the AI's ears: master true peak, RMS, LUFS (momentary/short-term/integrated), stereo correlation, clip flags, plus per-track peak/RMS. Read-only snapshot of the RUNNING engine; honestly refused when no engine/audio context is live. LUFS-I needs a few seconds of playback to stabilize.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["master", "tracks", "all"],
          description: "Default all",
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
  },
  {
    name: "kyx_automation",
    description:
      "Automation lanes on the project timeline: add a point (lane is created on demand — one undo step for both), delete the point nearest a bar, clear a lane, or remove a lane (clear/remove are destructive-gated). Targets: trackId or family + param — 'gain' or 'pan' for track lanes, or effect+param for FX-parameter lanes (see kyx_catalog for ranges). Values are NATIVE (gain 0..1.5, pan -1..1, fx params per their registry range); out-of-range values are clamped. Read the lanes first via kyx_state subject:automation.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["addPoint", "movePoint", "deletePoint", "clearLane", "removeLane"],
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
        instance: {
          type: "integer",
          minimum: 1,
          description: "1-based same-type instance index (default 1)",
        },
        bar: {
          type: "integer",
          minimum: 1,
          description: "1-based bar — position for addPoint, anchor for movePoint/deletePoint",
        },
        newBar: {
          type: "integer",
          minimum: 1,
          description: "For movePoint — 1-based destination bar",
        },
        newBeat: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "For movePoint — 1-based destination beat",
        },
        beat: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "Optional 1-based beat within the bar (default 1)",
        },
        value: {
          type: "number",
          description: "NATIVE value for addPoint (clamped into the target's range)",
        },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_clips",
    description:
      "Arrangement AND audio clips: list scene clips (with ids + an audio summary), audioList the track-lane waveforms in detail, or edit — scene ops move/resize/duplicate/delete target the clip COVERING an anchor bar (delete D4-gated); audio ops audioMove/audioSplit/audioUpdate (gain, fadeIn, fadeOut, reverse, loop)/audioDelete (D4) address a track (trackId or family) + the anchor bar its clip covers. Values are native (gain linear, fades in seconds).",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
            "list",
            "move",
            "resize",
            "duplicate",
            "delete",
            "audioList",
            "audioMove",
            "audioSplit",
            "audioUpdate",
            "audioDelete",
          ],
        },
        bar: {
          type: "integer",
          minimum: 1,
          description: "1-based anchor bar — the clip covering it is the target",
        },
        toBar: {
          type: "integer",
          minimum: 1,
          description: "For move/audioMove — 1-based destination start bar",
        },
        bars: {
          type: "integer",
          minimum: 1,
          maximum: 64,
          description: "For resize — new length in bars",
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
        fadeOut: {
          type: "number",
          minimum: 0,
          description: "For audioUpdate — fade-out seconds",
        },
        reverse: {
          type: "boolean",
          description: "For audioUpdate — play the clip backwards",
        },
        loop: {
          type: "boolean",
          description: "For audioUpdate — loop the trimmed content over the clip length",
        },
      },
      required: ["op"],
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
      },
      required: ["name", "sfzBase64", "trackId", "samples"],
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
      },
      required: ["scope", "strips", "findings", "suggestedActions"],
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
      },
      required: ["op"],
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
      },
      required: ["genre"],
    },
  },
  {
    name: "kyx_arrange",
    description:
      "PRODUCER MOVE - lay out the genre song form as scenes + clips + cue markers (intro/build/drop/... with per-section intensity) in ONE undo step. Refused when the arrangement already has clips: use kyx_sections/kyx_clips for surgical edits on an existing arrangement.",
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
      },
      required: ["genre"],
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
      },
      required: ["genre"],
    },
  },
  {
    name: "kyx_routing",
    description:
      "The group routing graph AND send buses: list every track's destination (its group or master) with a structured envelope, create a group bus, route tracks into it (addToGroup) or back to master (removeFromGroup). The model is FLAT — one group per track, no group-into-group — so routing cycles are impossible by construction. setSend/setReturnGain/ createReturn cover the send-bus mixer.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "createGroup", "addToGroup", "removeFromGroup", "setSend", "setReturnGain", "createReturn"],
        },
        trackId: {
          type: "string",
          description: "Exact track id — overrides family when present",
        },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "Family alternative to trackId (applies to every resolved track)",
        },
        groupId: {
          type: "string",
          description: "For addToGroup — the group track id (op:list)",
        },
        groupName: {
          type: "string",
          description: "For addToGroup — group name alternative to groupId",
        },
        name: {
          type: "string",
          description: "For createGroup/createReturn — optional name (default: Group N / Return N)",
        },
        returnId: {
          type: "string",
          description: "For setSend/setReturnGain — the return bus id (op:list)",
        },
        returnName: {
          type: "string",
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
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_takes",
    description:
      "Take groups (comp workflow): list every group with its track, the ACTIVE take and the alternatives (clips per take), or activate a take — the comp pick that decides which alternative is heard. Reversible (one undo step); the domain validates the take has clips. deleteTake (destructive-gated) removes every clip of one take.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "activate", "deleteTake"],
        },
        groupId: {
          type: "string",
          description: "For activate/deleteTake — the take group id (op:list)",
        },
        takeId: {
          type: "string",
          description: "The take id to activate or delete",
        },
      },
      required: ["op"],
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
          description: "Trial lane name (record/verdict), e.g. 'tilt-vs-flat'",
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
          description: "For record — milliseconds from first playback",
        },
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

export function createMcpHub({
  token,
  sendToSession,
  callTimeoutMs = CALL_TIMEOUT_MS,
  longCallTimeoutMs = LONG_CALL_TIMEOUT_MS,
}) {
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
      const content = [{ type: "text", text: result.text ?? "" }];
      if (result.audio && typeof result.audio.data === "string" && typeof result.audio.mimeType === "string") {
        content.push({ type: "audio", data: result.audio.data, mimeType: result.audio.mimeType });
      }
      const hasStructuredContent =
        result.data != null && typeof result.data === "object" && !Array.isArray(result.data);
      const payload = {
        content,
        isError:
          result.isError === true || (result.mutated === false && String(result.text ?? "").startsWith("unknown")),
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
