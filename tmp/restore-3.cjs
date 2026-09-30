const fs = require("fs");
let s = fs.readFileSync("src/mcp/tools.ts", "utf8");
const NL = String.fromCharCode(10);
function must(cond, what) { if (!cond) { console.error("ANCHOR FAIL: " + what); process.exit(1); } }

// ── J. schemas ─────────────────────────────────────────────────────────────
// 1. kyx_fx: reorder in action enum + instance/direction/position + description
const fxEnumOld = "action: { type: \"string\", enum: [\"more\", \"less\", \"remove\", \"bypass\", \"enable\"] },";
must(s.includes(fxEnumOld), "fx enum");
s = s.replace(fxEnumOld, "action: { type: \"string\", enum: [\"more\", \"less\", \"remove\", \"bypass\", \"enable\", \"reorder\"] },");
const pctLine = s.split(NL).find((line) => line.includes("Relative step size for more/less"));
must(!!pctLine, "fx percent line");
const argsBlock = [
  "        instance: {",
  "          type: \"integer\",",
  "          minimum: 1,",
  "          description:",
  "            \"1-based same-type instance — scopes remove/bypass/enable/reorder to ONE instance (default: all instances of the type)\",",
  "        },",
  "        direction: {",
  "          type: \"string\",",
  "          enum: [\"earlier\", \"later\"],",
  "          description: \"For reorder — move the instance one slot toward the input (earlier) or output (later)\",",
  "        },",
  "        position: { type: \"integer\", minimum: 1, description: \"For reorder — 1-based final slot in the chain\" },",
].join(NL);
s = s.replace(pctLine, pctLine + NL + argsBlock);
const fxDescOld = [
  "      \"Structured effect operation on a track family or ONE exact track: \" +",
  "      \"more/less turn the effect's PRIMARY knob (percent = relative step \" +",
  "      \"size), remove deletes instances (destructive-gated), bypass/enable \" +",
  "      \"flag instances without deleting them. Effect types are the \" +",
  "      \"knob-mapped subset — eq and other no-knob effects are refused; use \" +",
  "      \"kyx_plugin_param for their parameters.\",",
].join(NL);
const fxDescNew = [
  "      \"Structured effect operation on a track family or ONE exact track: \" +",
  "      \"more/less turn the effect's PRIMARY knob (percent = relative step \" +",
  "      \"size), remove deletes instances (destructive-gated), bypass/enable \" +",
  "      \"flag them, reorder moves ONE instance through the chain (direction \" +",
  "      \"or position). instance scopes remove/bypass/enable/reorder to the \" +",
  "      \"Nth same-type instance. Effect types are the knob-mapped subset for \" +",
  "      \"more/less — eq and other no-knob effects are refused there; use \" +",
  "      \"kyx_plugin_param for their parameters.\",",
].join(NL);
must(s.includes(fxDescOld), "fx description");
s = s.replace(fxDescOld, fxDescNew);

// 2. markers: rename op
const markerOpsOld = "op: { type: \"string\", enum: [\"add\", \"remove\"] },";
must(s.includes(markerOpsOld), "marker ops");
s = s.replace(markerOpsOld, "op: { type: \"string\", enum: [\"add\", \"remove\", \"rename\"] },");
s = s.replace(
  "      \"Add a cue marker at a bar, or remove the marker nearest a bar.\",",
  "      \"Add a cue marker at a bar, rename or remove the marker nearest a bar.\","
);

// 3. export: request args + description
const expDescStart = s.split(NL).findIndex((line) => line.includes('"Bounce the current project'));
if (expDescStart >= 0) {
  const lines = s.split(NL);
  const dEnd = lines.findIndex((line, i) => i > expDescStart && line.includes('"lands in the app.",'));
  if (dEnd > expDescStart) {
    const newDesc = [
      "      \"Bounce the current project: full mix (WAV 16/24/32-bit, MP3 320) or a STEMS zip \" +",
      "      \"(stems: all | drums | bass | music — stem projects bypass the master chain, same as \" +",
      "      \"the ExportPanel stem flow). sampleRate selects the render rate. The render runs in \" +",
      "      \"the KYX window and the tool AWAITS it — the result carries the completion report \" +",
      "      \"(duration, size). Long renders may exceed the transport timeout (15 s relay / 10 s \" +",
      "      \"desktop); the download still lands in the app.\",",
    ].join(NL);
    lines.splice(expDescStart, dEnd - expDescStart + 1, newDesc);
    s = lines.join(NL);
  }
}
const expPropsOld = "      properties: { format: { type: \"string\", enum: [\"wav\", \"mp3\"] } },";
if (s.includes(expPropsOld)) {
  s = s.replace(expPropsOld, [
    "      properties: {",
    "        format: { type: \"string\", enum: [\"wav\", \"mp3\"] },",
    "        sampleRate: { type: \"number\", enum: [44100, 48000, 96000], description: \"Render sample rate (default 44100)\" },",
    "        bitDepth: { type: \"number\", enum: [16, 24, 32], description: \"WAV bit depth (default 16; ignored for mp3)\" },",
    "        stems: {",
    "          type: \"string\",",
    "          enum: [\"all\", \"drums\", \"bass\", \"music\"],",
    "          description: \"Render stem groups into one zip instead of the full mix\",",
    "        },",
    "      },",
  ].join(NL));
}

// 4. kyx_routing + kyx_takes schemas appended after kyx_checkpoint (array end)
const arrayEnd = s.indexOf("];", s.indexOf("name: \"kyx_checkpoint\""));
must(arrayEnd > 0, "array end after checkpoint");
const newTools = [
  "  {",
  "    name: \"kyx_routing\",",
  "    description:",
  "      \"The group routing graph AND send buses: list every track's destination (its \" +",
  "      \"group or master) with a structured envelope, create a group bus, route \" +",
  "      \"tracks into it (addToGroup) or back to master (removeFromGroup). The \" +",
  "      \"model is FLAT — one group per track, no group-into-group — so routing \" +",
  "      \"cycles are impossible by construction. setSend/setReturnGain/ \" +",
  "      \"createReturn cover the send-bus mixer.\",",
  "    inputSchema: {",
  "      type: \"object\",",
  "      properties: {",
  "        op: { type: \"string\", enum: [\"list\", \"createGroup\", \"addToGroup\", \"removeFromGroup\", \"setSend\", \"setReturnGain\", \"createReturn\"] },",
  "        trackId: { type: \"string\", description: \"Exact track id — overrides family when present\" },",
  "        family: {",
  "          type: \"string\",",
  "          enum: [\"drums\", \"bass\", \"chords\", \"lead\", \"vocal\"],",
  "          description: \"Family alternative to trackId (applies to every resolved track)\",",
  "        },",
  "        groupId: { type: \"string\", description: \"For addToGroup — the group track id (op:list)\" },",
  "        groupName: { type: \"string\", description: \"For addToGroup — group name alternative to groupId\" },",
  "        name: { type: \"string\", description: \"For createGroup/createReturn — optional name (default: Group N / Return N)\" },",
  "        returnId: { type: \"string\", description: \"For setSend/setReturnGain — the return bus id (op:list)\" },",
  "        returnName: { type: \"string\", description: \"Return bus name alternative to returnId\" },",
  "        level: { type: \"number\", minimum: 0, maximum: 1.5, description: \"For setSend — linear send level (1.0 = unity)\" },",
  "        gain: { type: \"number\", minimum: 0, maximum: 1.5, description: \"For setReturnGain — linear return fader\" },",
  "      },",
  "      required: [\"op\"],",
  "    },",
  "  },",
  "  {",
  "    name: \"kyx_takes\",",
  "    description:",
  "      \"Take groups (comp workflow): list every group with its track, the \" +",
  "      \"ACTIVE take and the alternatives (clips per take), or activate a \" +",
  "      \"take — the comp pick that decides which alternative is heard. \" +",
  "      \"Reversible (one undo step); the domain validates the take has clips. \" +",
  "      \"deleteTake (destructive-gated) removes every clip of one take.\",",
  "    inputSchema: {",
  "      type: \"object\",",
  "      properties: {",
  "        op: { type: \"string\", enum: [\"list\", \"activate\", \"deleteTake\"] },",
  "        groupId: { type: \"string\", description: \"For activate/deleteTake — the take group id (op:list)\" },",
  "        takeId: { type: \"string\", description: \"The take id to activate or delete\" },",
  "      },",
  "      required: [\"op\"],",
  "    },",
  "  },",
  "];",
].join(NL);
s = s.slice(0, arrayEnd) + newTools + s.slice(arrayEnd + 2);

fs.writeFileSync("src/mcp/tools.ts", s);
console.log("PART 3 OK — schemas");
