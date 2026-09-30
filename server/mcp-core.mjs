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

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26"];
const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "kyx-mcp", version: "1.0.0" };
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
 * to the KYX window — the server holds no project state).
 *
 * VERBATIM MIRROR of MCP_TOOLS in src/mcp/tools.ts (names + descriptions +
 * input schemas). tests/mcp-core.test.ts pins this list against the TS
 * source — change the tool surface THERE, then copy it here. */
export const MCP_TOOL_DEFS = [
  {
    name: "kyx_intent",
    description:
      "Drive the KYX DAW with a natural-language producer instruction " +
      '(EN/SK): "mute the drums", "zníž basu", "set tempo to 140", ' +
      '"more reverb send on the lead", "more swing in the drop". ' +
      "Executes through the deterministic command layer (one undo step) " +
      "and returns a verification read-back of the resulting state. " +
      "Generation requests are refused (candidates need in-app auditioning).",
    inputSchema: {
      type: "object",
      properties: { instruction: { type: "string", description: "Producer instruction, EN or SK" } },
      required: ["instruction"],
    },
  },
  {
    name: "kyx_state",
    description:
      "Read-only project snapshot: tempo, key, time signature, track list, " +
      "markers, groove, the ACTIVE pattern's step grid, the arrangement " +
      "scenes, the send routing map (returns + per-track send levels), the " +
      "undo history, or the FX chain of one family. Never mutates.",
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
            "sends",
            "pattern",
            "scenes",
            "history",
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
    description: "Undo or redo the last N document commands (default 1). Declined " + "while a mic take is recording.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["undo", "redo"] },
        steps: { type: "integer", minimum: 1, maximum: 20, description: "Default 1" },
      },
      required: ["action"],
    },
  },
  {
    name: "kyx_transport",
    description:
      "Transport control AND reads: play, stop, pause, loop on/off, " +
      "metronome on/off — or seek to a 1-based bar (optional beat), set the " +
      "loop region in bars (loopRegion), or state: a read-only read-back of " +
      "the playhead position (bar/beat/tick), playing state, loop region and " +
      "metronome. Position is 4/4-based (1920 ticks per bar, 480 per beat).",
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
            "state",
          ],
        },
        bar: { type: "integer", minimum: 1, description: "For seek — 1-based destination bar" },
        beat: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "For seek — 1-based beat within the bar (default 1)",
        },
        startBar: { type: "integer", minimum: 1, description: "For loopRegion — first looped bar (1-based)" },
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
      "Bounce the current project: full mix (WAV 16/24/32-bit, MP3 320) or a STEMS zip " +
      "(stems: all | drums | bass | music — stem projects bypass the master chain, same as " +
      "the ExportPanel stem flow). sampleRate selects the render rate. The render runs in " +
      "the KYX window and the tool AWAITS it — the result carries the completion report " +
      "(duration, size). Long renders may exceed the transport timeout (15 s relay / 10 s " +
      "desktop); the download still lands in the app.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["wav", "mp3"] },
        sampleRate: { type: "number", enum: [44100, 48000, 96000], description: "Render sample rate (default 44100)" },
        bitDepth: { type: "number", enum: [16, 24, 32], description: "WAV bit depth (default 16; ignored for mp3)" },
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
    name: "kyx_generate",
    description:
      "Generate a new pattern from an intent spec (deterministic engine, " +
      "one undo step). Returns the pattern name and resolved BPM.",
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
        seed: { type: "string", description: "Deterministic seed (same seed = same pattern)" },
        energy: { type: "number", minimum: 0, maximum: 1 },
        density: { type: "number", minimum: 0, maximum: 1 },
        bpm: { type: "integer", minimum: 40, maximum: 220 },
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
          items: { type: "string", enum: ["drums", "bass", "chords", "lead"] },
          description: "Which roles the pattern plays (default all)",
        },
      },
      required: ["genre"],
    },
  },
  {
    name: "kyx_groove",
    description:
      "Groove/swing control. Global (no section) adjusts project swing; " +
      "section-scoped bakes microtiming into that section's pattern.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["more", "less", "tighter", "set"] },
        section: {
          type: "string",
          enum: ["intro", "build", "chorus", "verse", "bridge", "drop", "break", "outro", "fill"],
          description: "Omit = global groove",
        },
        percent: { type: "integer", minimum: 0, maximum: 100, description: "Only for direction 'set'" },
      },
      required: ["direction"],
    },
  },
  {
    name: "kyx_fx",
    description:
      "Structured effect operation on a track family or ONE exact track: " +
      "more/less turn the effect's PRIMARY knob (percent = relative step " +
      "size), remove deletes instances (destructive-gated), bypass/enable " +
      "flag them, reorder moves ONE instance through the chain (direction " +
      "or position). instance scopes remove/bypass/enable/reorder to the " +
      "Nth same-type instance. Effect types are the knob-mapped subset for " +
      "more/less — eq and other no-knob effects are refused there; use " +
      "kyx_plugin_param for their parameters.",
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
        action: { type: "string", enum: ["more", "less", "remove", "bypass", "enable", "reorder"] },
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
          position: { type: "integer", minimum: 1, description: "For reorder — 1-based final slot in the chain" },
        },
      },
      required: ["effect", "action"],
    },
  },
  {
    name: "kyx_sections",
    description:
      "Arrangement operations: add/remove/duplicate/reorder/resize named " +
      "sections (intro/build/chorus/verse/bridge/drop/break/outro/fill).",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add", "remove", "duplicate", "reorder", "resize"] },
        role: {
          type: "string",
          enum: ["intro", "build", "chorus", "verse", "bridge", "drop", "break", "outro", "fill"],
        },
        bars: { type: "integer", minimum: 1, maximum: 64, description: "For resize" },
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
        op: { type: "string", enum: ["add", "remove", "rename"] },
        bar: { type: "integer", minimum: 1, description: "1-based bar" },
        name: { type: "string", description: "Optional marker name" },
      },
      required: ["op", "bar"],
    },
  },
  {
    name: "kyx_tracks",
    description:
      "Track CRUD + absolute mixer setters: add a drum or instrument " +
      "track, remove/rename by family or exact trackId (group tracks are " +
      "not addressable here — removing the last track is declined), or set " +
      "mixer values with verify-by-read: setGain (absolute gainDb −60..+3.5 " +
      "or linear gain 0..1.5), setPan (−1..1), setMute/setSolo (value " +
      "boolean). set* ops apply to every track the family resolves to.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["addDrum", "addInstrument", "remove", "rename", "setGain", "setPan", "setMute", "setSolo"],
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
        name: { type: "string", description: "New name for rename" },
        gainDb: { type: "number", minimum: -60, maximum: 3.5, description: "For setGain — absolute fader value in dB" },
        gain: { type: "number", minimum: 0, maximum: 1.5, description: "For setGain — linear alternative to gainDb" },
        pan: { type: "number", minimum: -1, maximum: 1, description: "For setPan — −1 left, 0 center, 1 right" },
        value: { type: "boolean", description: "For setMute/setSolo — true = on" },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_pattern",
    description:
      "List the project's patterns or switch the ACTIVE pattern (step edits " +
      "and generation act on the active one). Select by 1-based index or name.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "select"] },
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
      "Structured step-grid edit on the ACTIVE pattern's drum pads (16 steps " +
      "per bar, 1-based indexes across the whole pattern). add sets velocity, " +
      "remove clears, toggle flips, ghost places a soft probabilistic hit, " +
      "clearPad empties the whole family. Returns a verification read-back " +
      "with the family's before → after step counts.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add", "remove", "toggle", "ghost", "clearPad"] },
        family: { type: "string", enum: ["kick", "snare", "clap", "hat", "perc", "tom"] },
        steps: {
          type: "array",
          items: { type: "integer", minimum: 1, maximum: 256 },
          description: "1-based 16th-step indexes within the pattern (16 per bar). Not used by clearPad.",
        },
        velocity: { type: "number", minimum: 0.05, maximum: 1, description: "For add (default 0.8)" },
      },
      required: ["op", "family"],
    },
  },
  {
    name: "kyx_catalog",
    description:
      "Discovery — what the DAW can do, machine-readable: list every effect " +
      "type with its category and primary knob, the FULL parameter table of " +
      "one effect (id, label, min, max, default, unit, kind, taper), or the " +
      "instrument kind catalog. Read-only; use it before kyx_plugin_param " +
      "instead of guessing ranges.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", enum: ["effects", "effect", "instruments"] },
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
      "Precise plugin control on inserted FX instances: set ONE parameter to " +
      "an absolute NATIVE value (clamped to the registry range; see " +
      "kyx_catalog subject:effect for min/max/default/unit) or list the " +
      "current values of every parameter on the targeted tracks' chains. " +
      "Targets a trackId or a family; instance picks 1-based among same-type " +
      "instances (default 1). Missing instances are reported honestly — " +
      "nothing is auto-inserted (use kyx_fx more for that).",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "set"] },
        trackId: { type: "string", description: "Exact track id — overrides family when present" },
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
        param: { type: "string", description: "Parameter id for set (e.g. mix, decay, freq) — see kyx_catalog" },
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
      "Live audio meters — the AI's ears: master true peak, RMS, LUFS " +
      "(momentary/short-term/integrated), stereo correlation, clip flags, " +
      "plus per-track peak/RMS. Read-only snapshot of the RUNNING engine; " +
      "honestly refused when no engine/audio context is live. LUFS-I needs " +
      "a few seconds of playback to stabilize.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["master", "tracks", "all"], description: "Default all" },
      },
      required: [],
    },
  },
  {
    name: "kyx_automation",
    description:
      "Automation lanes on the project timeline: add a point (lane is " +
      "created on demand — one undo step for both), delete the point nearest " +
      "a bar, clear a lane, or remove a lane (clear/remove are " +
      "destructive-gated). Targets: trackId or family + param — 'gain' or " +
      "'pan' for track lanes, or effect+param for FX-parameter lanes (see " +
      "kyx_catalog for ranges). Values are NATIVE (gain 0..1.5, pan -1..1, " +
      "fx params per their registry range); out-of-range values are clamped. " +
      "Read the lanes first via kyx_state subject:automation.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["addPoint", "movePoint", "deletePoint", "clearLane", "removeLane"] },
        trackId: { type: "string", description: "Exact track id — overrides family when present" },
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
        instance: { type: "integer", minimum: 1, description: "1-based same-type instance index (default 1)" },
        bar: {
          type: "integer",
          minimum: 1,
          description: "1-based bar — position for addPoint, anchor for movePoint/deletePoint",
        },
        newBar: { type: "integer", minimum: 1, description: "For movePoint — 1-based destination bar" },
        newBeat: { type: "integer", minimum: 1, maximum: 4, description: "For movePoint — 1-based destination beat" },
        beat: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "Optional 1-based beat within the bar (default 1)",
        },
        value: { type: "number", description: "NATIVE value for addPoint (clamped into the target's range)" },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_clips",
    description:
      "Arrangement AND audio clips: list scene clips (with ids + an audio " +
      "summary), audioList the track-lane waveforms in detail, or edit — " +
      "scene ops move/resize/duplicate/delete target the clip COVERING an " +
      "anchor bar (delete D4-gated); audio ops audioMove/audioSplit/" +
      "audioUpdate (gain, fadeIn, fadeOut, reverse, loop)/audioDelete (D4) " +
      "address a track (trackId or family) + the anchor bar its clip " +
      "covers. Values are native (gain linear, fades in seconds).",
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
        bar: { type: "integer", minimum: 1, description: "1-based anchor bar — the clip covering it is the target" },
        toBar: { type: "integer", minimum: 1, description: "For move/audioMove — 1-based destination start bar" },
        bars: { type: "integer", minimum: 1, maximum: 64, description: "For resize — new length in bars" },
        trackId: { type: "string", description: "For audio ops — exact track id" },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "For audio ops — family alternative to trackId",
        },
        gain: { type: "number", minimum: 0, maximum: 2, description: "For audioUpdate — linear clip gain" },
        fadeIn: { type: "number", minimum: 0, description: "For audioUpdate — fade-in seconds" },
        fadeOut: { type: "number", minimum: 0, description: "For audioUpdate — fade-out seconds" },
        reverse: { type: "boolean", description: "For audioUpdate — play the clip backwards" },
        loop: { type: "boolean", description: "For audioUpdate — loop the trimmed content over the clip length" },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_batch",
    description:
      "Run up to 10 tool calls in ONE submitted batch: calls: [{tool, args}…" +
      "]. When the host supports undo frames, every mutation folds into a " +
      "SINGLE undo entry (the result reports which contract applied); each " +
      "call still returns its own read-back, and per-call failures never " +
      "abort the batch. Async tools (kyx_export, kyx_loudness) and nested " +
      "batches are refused — run those standalone.",
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
              args: { type: "object", description: "The tool's arguments object" },
            },
            required: ["tool"],
          },
        },
      },
      required: ["calls"],
    },
  },
  {
    name: "kyx_loudness",
    description:
      "Loudness loop (render-backed BS.1770): measure reports the CURRENT " +
      "mix's integrated LUFS read-only; match runs measure→trim→verify " +
      "toward an explicit targetDb (e.g. −14 for streaming) or a ±nudge in " +
      "the given direction, landing the trim on the master config in one " +
      "undo step. Runs in the KYX window; honestly refused where no render " +
      "context is bound.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["measure", "match"] },
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
  },
  {
    name: "kyx_routing",
    description:
      "The group routing graph AND send buses: list every track's destination (its " +
      "or master) with a structured envelope, create a group bus, route " +
      "tracks into it (addToGroup) or back to master (removeFromGroup). " +
      "The model is FLAT — one group per track, no group-into-group — so " +
      "routing cycles are impossible by construction. setSend/setReturnGain/ " +
      "createReturn cover the send-bus mixer.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "createGroup", "addToGroup", "removeFromGroup", "setSend", "setReturnGain", "createReturn"],
        },
        trackId: { type: "string", description: "For addToGroup/removeFromGroup — exact track id" },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "Family alternative to trackId (applies to every resolved track)",
        },
        groupId: { type: "string", description: "For addToGroup — the group track id (op:list)" },
        groupName: { type: "string", description: "For addToGroup — group name alternative to groupId" },
        name: {
          type: "string",
          description: "For createGroup/createReturn — optional name (default: Group N / Return N)",
        },
        returnId: { type: "string", description: "For setSend/setReturnGain — the return bus id (op:list)" },
        returnName: { type: "string", description: "Return bus name alternative to returnId" },
        level: {
          type: "number",
          minimum: 0,
          maximum: 1.5,
          description: "For setSend — linear send level (1.0 = unity)",
        },
        gain: { type: "number", minimum: 0, maximum: 1.5, description: "For setReturnGain — linear return fader" },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_takes",
    description:
      "Take groups (comp workflow): list every group with its track, the " +
      "ACTIVE take and the alternatives (clips per take), or activate a " +
      "take — the comp pick that decides which alternative is heard. " +
      "Reversible (one undo step); the domain validates the take has clips. " +
      "deleteTake (destructive-gated) removes every clip of one take.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "activate", "deleteTake"] },
        groupId: { type: "string", description: "For activate — the take group id (op:list)" },
        takeId: { type: "string", description: "For activate — the take id to make active" },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_checkpoint",
    description:
      "Named project checkpoints for agent experiments: save the current " +
      "state, list checkpoints with how many steps have passed since each, " +
      "restore one (ONE undo step back to the pre-restore state), or delete. " +
      "Session-scoped (last 8 kept); destructive ops auto-save " +
      "auto-before-<tool> checkpoints when allowed.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["save", "list", "restore", "delete"] },
        name: { type: "string", description: "Checkpoint name (required for save/restore/delete)" },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_checkpoint",
    description:
      "Named project checkpoints for agent experiments: save the current " +
      "state, list checkpoints with how many steps have passed since each, " +
      "restore one (ONE undo step back to the pre-restore state), or delete. " +
      "Session-scoped (last 8 kept); destructive ops auto-save " +
      "auto-before-<tool> checkpoints when allowed.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["save", "list", "restore", "delete"] },
        name: { type: "string", description: "Checkpoint name (required for save/restore/delete)" },
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
      "The agent manual: workflows (beat/mix/arrangement), the read-act-verify loop, " +
      "token economy and how to react to honest refusals.",
    mimeType: "text/plain",
  },
  {
    uri: "kyx://vocab",
    name: "Intent vocabulary",
    description:
      "What free-text kyx_intent understands (EN + SK) per category, with the " +
      "rule of thumb for structured-vs-free-text choices.",
    mimeType: "text/plain",
  },
];

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
  // JSON-RPC batch (2025-03-26): an array body fans out request-by-request;
  // notifications produce no entry, so the response can be empty.
  let parsedBody;
  try {
    parsedBody = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return rpcError(null, RPC_ERRORS.parse, "Parse error");
  }
  if (Array.isArray(parsedBody)) {
    const responses = [];
    for (const item of parsedBody) {
      const response = await handleSingleRequest(hub, item);
      if (response !== undefined) responses.push(response);
    }
    return responses;
  }
  return handleSingleRequest(hub, parsedBody);
}

async function handleSingleRequest(hub, rpc) {
  const parsed = parseRpc(rpc);
  if (!parsed.ok) return parsed.error;

  if (parsed.method === "initialize") {
    return rpcResult(parsed.id, {
      protocolVersion: negotiateProtocolVersion(parsed.params?.protocolVersion),
      capabilities: { tools: {}, resources: {} },
      serverInfo: SERVER_INFO,
      instructions: SERVER_INSTRUCTIONS,
    });
  }
  if (parsed.method === "notifications/initialized") {
    return undefined; // notification — no response
  }
  if (parsed.method === "tools/list") {
    return rpcResult(parsed.id, { tools: MCP_TOOL_DEFS });
  }
  if (parsed.method === "resources/list") {
    return rpcResult(parsed.id, { resources: MCP_RESOURCE_DEFS });
  }
  if (parsed.method === "resources/read") {
    const uri = String(parsed.params?.uri ?? "");
    if (!MCP_RESOURCE_DEFS.some((resource) => resource.uri === uri)) {
      return rpcError(parsed.id, RPC_ERRORS.invalidParams, `unknown resource: ${uri}`);
    }
    try {
      const result = await hub.callTool("__kyx_resource", { uri });
      return rpcResult(parsed.id, {
        contents: [{ uri, mimeType: "text/plain", text: result.text ?? "" }],
      });
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
      return rpcResult(parsed.id, {
        content: [{ type: "text", text: result.text ?? "" }],
        isError:
          result.isError === true || (result.mutated === false && String(result.text ?? "").startsWith("unknown")),
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
