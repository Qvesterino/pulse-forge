/**
 * KYX MCP TOOL DEFS — CommonJS mirror of `MCP_TOOLS` in src/mcp/tools.ts
 * (docs/INTENT-MCP-EXPANSION-PLAN.md Phase D2).
 *
 * The desktop transport (loopback bridge + stdio forwarder) runs in plain
 * Node, outside the TypeScript bundle, so the tool surface is mirrored here.
 * tests/desktop-mcp.test.ts pins the mirror against the TS source — keep
 * both lists in sync (names AND schemas).
 */
const MCP_TOOL_DEFS = [
  {
    name: "kyx_intent",
    description:
      "Drive the KYX DAW with a natural-language producer instruction (EN/SK): " +
      '"mute the drums", "zníž basu", "set tempo to 140", "more reverb send on the lead", ' +
      '"more swing in the drop". Executes through the deterministic command layer ' +
      "(one undo step) and returns a verification read-back of the resulting state. " +
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
      "Read-only project snapshot: tempo, key, time signature, track list, markers, " +
      "groove, the ACTIVE pattern's step grid, the arrangement scenes, the undo " +
      "history, or the FX chain of one family. Never mutates.",
    inputSchema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          enum: ["overview", "tempo", "key", "tracks", "markers", "groove", "fxChain", "pattern", "scenes", "history"],
          description: "Which part of the project state to return",
        },
        family: {
          type: "string",
          enum: ["kick", "snare", "clap", "hat", "perc", "tom", "bass", "lead", "chords", "drums"],
          description: "Optional track family filter for fxChain",
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
        action: { type: "string", enum: ["undo", "redo"] },
        steps: { type: "integer", minimum: 1, maximum: 20, description: "Default 1" },
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
        action: {
          type: "string",
          enum: ["play", "stop", "pause", "loopOn", "loopOff", "metronomeOn", "metronomeOff"],
        },
      },
      required: ["action"],
    },
  },
  {
    name: "kyx_export",
    description:
      "Request a bounce of the current project (WAV/MP3). v1 returns started:true " +
      "and the download happens in the KYX app window.",
    inputSchema: {
      type: "object",
      properties: { format: { type: "string", enum: ["wav", "mp3"] } },
      required: ["format"],
    },
  },
  {
    name: "kyx_generate",
    description:
      "Generate a new pattern from an intent spec (deterministic engine, one undo " +
      "step). Returns the pattern name and resolved BPM.",
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
      "Structured effect operation on a track family: more/less turn the primary " +
      "knob, remove deletes instances, bypass/enable flags them.",
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
    description:
      "Arrangement operations: add/remove/duplicate/reorder/resize named sections " +
      "(intro/build/chorus/verse/bridge/drop/break/outro/fill).",
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
        op: { type: "string", enum: ["add", "remove"] },
        bar: { type: "integer", minimum: 1, description: "1-based bar" },
        name: { type: "string", description: "Optional marker name" },
      },
      required: ["op", "bar"],
    },
  },
  {
    name: "kyx_tracks",
    description:
      "Track CRUD: add a drum or instrument track, remove/rename an existing one " +
      "by family. Removing the last track is declined.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["addDrum", "addInstrument", "remove", "rename"] },
        family: {
          type: "string",
          enum: ["drums", "bass", "lead", "chords", "kick", "snare", "clap", "hat", "perc", "tom"],
          description: "For remove/rename: which family to touch",
        },
        instrument: {
          type: "string",
          enum: ["analog", "bass", "808", "keys", "pluck", "acid", "reese", "brass", "flute", "sampler"],
          description: "For addInstrument",
        },
        name: { type: "string", description: "New name for rename" },
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
];

module.exports = { MCP_TOOL_DEFS };
