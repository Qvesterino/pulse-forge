const fs = require("fs");
let s = fs.readFileSync("src/mcp/tools.ts", "utf8");
const NL = String.fromCharCode(10);
function must(cond, what) { if (!cond) { console.error("ANCHOR FAIL: " + what); process.exit(1); } }

// ── A. imports ──────────────────────────────────────────────────────────────
const impOld = "  addToGroup,";
if (!s.includes(impOld)) {
  const addAnchor = "  addMarker,";
  must(s.includes(addAnchor), "addMarker import");
  s = s.replace(addAnchor, "  addToGroup," + NL + "  createGroupTrack," + NL + "  createReturnTrack," + NL + addAnchor);
}
const meAnchor = "  moveAutomationPoint,";
must(s.includes(meAnchor), "moveAutomationPoint import");
s = s.replace(meAnchor, meAnchor + NL + "  moveEffect," + NL + "  moveEffectToIndex,");
const rmAnchor = "  removeMarker,";
must(s.includes(rmAnchor), "removeMarker import");
s = s.replace(rmAnchor, "  removeEffect," + NL + "  removeFromGroup," + NL + rmAnchor + NL + "  renameMarker,");
const satAnchor = "  setActivePattern,";
must(s.includes(satAnchor), "setActivePattern import");
s = s.replace(satAnchor, "  setActiveAudioTake," + NL + "  setReturnGain," + NL + satAnchor.replace("setActivePattern,", "setActivePattern,") + NL + "  setTrackSend,");
const tbAnchor = "  snapshot,";
must(s.includes(tbAnchor), "snapshot import");
s = s.replace(tbAnchor, tbAnchor + NL + "  toggleEffectBypass,");

// ── B. McpExportRequest interface ───────────────────────────────────────────
if (!s.includes("export interface McpExportRequest")) {
  const anchor = "/** Live metering snapshot the kyx_meter tool reads";
  must(s.includes(anchor), "meter interface anchor");
  s = s.replace(anchor, [
    "/** The kyx_export request: full-mix bounce or a stems zip, with render options. */",
    "export interface McpExportRequest {",
    "  format: \"wav\" | \"mp3\";",
    "  sampleRate?: number;",
    "  bitDepth?: 16 | 24 | 32;",
    "  stems?: \"all\" | \"drums\" | \"bass\" | \"music\";",
    "}",
    "",
    anchor,
  ].join(NL));
}

// ── C. context export widen ────────────────────────────────────────────────
const ctxOld = "  /** Present when the KYX window can render/downloads (browser relay). */" + NL + "  export?: (format: \"wav\" | \"mp3\") => Promise<string>;";
if (s.includes(ctxOld)) {
  s = s.replace(ctxOld, "  /** Present when the KYX window can render/downloads (browser relay). */" + NL + "  export?: (request: McpExportRequest) => Promise<string>;");
}

// ── D. async executor: request building ────────────────────────────────────
const asyncOld = "    const format = exportFormatOf(record);" + NL + "    try {" + NL + "      const report = await ctx.export(format);" + NL + "      return { text: `export ${format.toUpperCase()} complete — ${report}`, mutated: false };";
const asyncNew = [
  "    const format = exportFormatOf(record);",
  "    const request: McpExportRequest = {",
  "      format,",
  "      ...(record.sampleRate === 44100 || record.sampleRate === 48000 || record.sampleRate === 96000 ? { sampleRate: record.sampleRate } : {}),",
  "      ...(record.bitDepth === 16 || record.bitDepth === 24 || record.bitDepth === 32 ? { bitDepth: record.bitDepth } : {}),",
  "      ...(typeof record.stems === \"string\" && [\"all\", \"drums\", \"bass\", \"music\"].includes(record.stems)",
  "        ? { stems: record.stems as McpExportRequest[\"stems\"] }",
  "        : {}),",
  "    };",
  "    try {",
  "      const report = await ctx.export(request);",
  "      return { text: `export ${format.toUpperCase()} complete — ${report}`, mutated: false };",
].join(NL);
must(s.includes(asyncOld), "async export anchor");
s = s.replace(asyncOld, asyncNew);

// ── E. sync export case: request passthrough ───────────────────────────────
const syncOld = "      const format = exportFormatOf(record);" + NL + "      // Sync callers get the fire-and-forget contract; the transports go" + NL + "      // through executeMcpToolAsync, which AWAITS the same hook and returns" + NL + "      // the completion report (duration/size)." + NL + "      void ctx.export(format).catch(() => {});";
const syncNew = [
  "      const format = exportFormatOf(record);",
  "      // Sync callers get the fire-and-forget contract; the transports go",
  "      // through executeMcpToolAsync, which AWAITS the same hook and returns",
  "      // the completion report (duration/size).",
  "      void ctx",
  "        .export({",
  "          format,",
  "          ...(record.sampleRate === 44100 || record.sampleRate === 48000 || record.sampleRate === 96000 ? { sampleRate: record.sampleRate } : {}),",
  "          ...(record.bitDepth === 16 || record.bitDepth === 24 || record.bitDepth === 32 ? { bitDepth: record.bitDepth } : {}),",
  "          ...(typeof record.stems === \"string\" && [\"all\", \"drums\", \"bass\", \"music\"].includes(record.stems)",
  "            ? { stems: record.stems as McpExportRequest[\"stems\"] }",
  "            : {}),",
  "        })",
  "        .catch(() => {});",
].join(NL);
must(s.includes(syncOld), "sync export anchor");
s = s.replace(syncOld, syncNew);

// ── F. markers rename (rebuild the case tail) ──────────────────────────────
const markOld = [
  "      const nearest = ctx.getDoc().markers.find((marker) => Math.abs(marker.tick - tick) < TICKS_PER_BAR);",
  "      if (nearest == null) return { text: `no marker near bar ${bar}`, mutated: false };",
  "      ctx.execute(removeMarker(ctx.getDoc(), nearest.id));",
  "      return { text: `marker \"${nearest.name}\" removed`, mutated: true };",
  "    }",
].join(NL);
const markNew = [
  "      const nearest = ctx.getDoc().markers.find((marker) => Math.abs(marker.tick - tick) < TICKS_PER_BAR);",
  "      if (nearest == null) return { text: `no marker near bar ${bar}`, mutated: false };",
  "      if (op === \"rename\") {",
  "        const name = typeof record.name === \"string\" ? record.name.trim().slice(0, 40) : \"\";",
  "        if (name === \"\") return { text: \"rename needs a name (bar anchors the nearest match)\", mutated: false };",
  "        const previous = nearest.name;",
  "        ctx.execute(renameMarker(ctx.getDoc(), nearest.id, name));",
  "        return { text: `renamed marker \"${previous}\" → \"${name}\" — one undo step`, mutated: true };",
  "      }",
  "      ctx.execute(removeMarker(ctx.getDoc(), nearest.id));",
  "      return { text: `marker \"${nearest.name}\" removed`, mutated: true };",
  "    }",
].join(NL);
must(s.includes(markOld), "markers anchor");
s = s.replace(markOld, markNew);

// ── G. fx: reorder + per-instance + eq guard ───────────────────────────────
const fxGateOld = "      if (action === \"remove\" && ctx.allowDestructive?.() !== true) return destructiveRefusal();";
must(s.includes(fxGateOld), "fx gate anchor");
const fxInsert = [
  "      if (action === \"reorder\") {",
  "        // Per-instance chain reorder: direction moves ±1, position is the",
  "        // 1-based final slot. Uses the domain's moveEffect/moveEffectToIndex.",
  "        const reorderIndex = Math.max(1, Math.round(Number(record.instance ?? 1)));",
  "        const direction = record.direction === \"earlier\" ? -1 : record.direction === \"later\" ? 1 : 0;",
  "        const position = typeof record.position === \"number\" ? Math.round(record.position) : null;",
  "        if (direction === 0 && position == null) {",
  "          return { text: \"reorder needs direction (earlier | later) or position (1-based final slot)\", mutated: false };",
  "        }",
  "        try {",
  "          const before = ctx.getDoc();",
  "          const targetIds = targets.length === 1 ? tracksInFamily(before, targets[0]) : targets;",
  "          let next = before;",
  "          const parts: string[] = [];",
  "          let moved = 0;",
  "          for (const targetId of targetIds) {",
  "            const track = next.tracks.find((t) => t.id === targetId);",
  "            if (!track) {",
  "              parts.push(`${targetId}: no such track`);",
  "              continue;",
  "            }",
  "            const instances = track.effects.filter((fx) => fx.type === effect);",
  "            if (instances.length === 0) {",
  "              parts.push(`${track.name}: no ${effect} instance`);",
  "              continue;",
  "            }",
  "            if (instances.length < reorderIndex) {",
  "              parts.push(`${track.name}: ${effect} instance #${reorderIndex} does not exist (chain has ${instances.length})`);",
  "              continue;",
  "            }",
  "            const fx = instances[reorderIndex - 1];",
  "            const movedFxId = fx.id;",
  "            if (position != null) {",
  "              next = moveEffectToIndex(next, track.id, movedFxId, position - 1).execute(next);",
  "            } else {",
  "              next = moveEffect(next, track.id, movedFxId, direction as -1 | 1).execute(next);",
  "            }",
  "            moved += 1;",
  "            const chain = next.tracks",
  "              .find((t) => t.id === track.id)!",
  "              .effects.map((f, index) => `${index + 1}.${f.type}${f.id === movedFxId ? \"*\" : \"\"}`)",
  "              .join(\" \");",
  "            parts.push(`${track.name}: ${chain}`);",
  "          }",
  "          if (moved === 0) {",
  "            return { text: `reorder failed — ${parts.join(\"; \")}`, mutated: false, isError: true };",
  "          }",
  "          ctx.execute(snapshot(\"mcpFxReorder\", `MCP: reorder ${effect}#${reorderIndex}`, before, next));",
  "          return { text: `reorder ${effect}#${reorderIndex}: ${parts.join(\"; \")} — one undo step`, mutated: true };",
  "        } catch (error) {",
  "          return { text: `fx op failed: ${error instanceof Error ? error.message : String(error)}`, mutated: false, isError: true };",
  "        }",
  "      }",
  "      const perInstance = record.instance != null && action !== \"more\" && action !== \"less\";",
  "      const instanceWanted = Math.max(1, Math.round(Number(record.instance ?? 1)));",
  "      if (action === \"remove\" && ctx.allowDestructive?.() !== true) return destructiveRefusal();",
].join(NL);
s = s.replace(fxGateOld, fxInsert);
// eq guard restructure + per-instance execution branch
const eqOld = [
  "      // eq (and any knob-less effect) has no single \"primary knob\" — never",
  "      // pretend: point at kyx_plugin_param instead of throwing deep inside",
  "      // the applier (the pre-audit schema advertised eq here although every",
  "      // such call failed).",
  "      if (!(effect in EFFECT_KNOB)) {",
].join(NL);
const eqNew = [
  "      // eq (and any knob-less effect) has no single \"primary knob\" — never",
  "      // pretend: point at kyx_plugin_param instead of throwing deep inside",
  "      // the applier. remove/bypass/reorder do NOT need a knob.",
  "      if (!perInstance && action !== \"remove\" && !(effect in EFFECT_KNOB)) {",
].join(NL);
must(s.includes(eqOld), "eq guard anchor");
s = s.replace(eqOld, eqNew);
// per-instance execution before the type-wide try
const fxTryOld = "      try {" + NL + "        const before = ctx.getDoc();" + NL + "        // bypass/enable flip the BYPASS FLAG (never delete the instance);";
const fxTryNew = [
  "      if (perInstance) {",
  "        // Instance-scoped remove/bypass/enable: the Nth same-type instance",
  "        // per targeted track, folded into ONE undo snapshot.",
  "        try {",
  "          const before = ctx.getDoc();",
  "          const targetIds = targets.length === 1 ? tracksInFamily(before, targets[0]) : targets;",
  "          let next = before;",
  "          const parts: string[] = [];",
  "          let touched = 0;",
  "          for (const targetId of targetIds) {",
  "            const track = before.tracks.find((t) => t.id === targetId);",
  "            if (!track) {",
  "              parts.push(`${targetId}: no such track`);",
  "              continue;",
  "            }",
  "            const instances = track.effects.filter((fx) => fx.type === effect);",
  "            if (instances.length === 0) {",
  "              parts.push(`${track.name}: no ${effect} instance`);",
  "              continue;",
  "            }",
  "            if (instances.length < instanceWanted) {",
  "              parts.push(`${track.name}: ${effect} instance #${instanceWanted} does not exist (chain has ${instances.length})`);",
  "              continue;",
  "            }",
  "            const fx = instances[instanceWanted - 1];",
  "            if (action === \"remove\") {",
  "              next = removeEffect(next, track.id, fx.id).execute(next);",
  "              parts.push(`${track.name}: removed ${effect}#${instanceWanted}`);",
  "              touched += 1;",
  "            } else {",
  "              const bypassed = action === \"bypass\";",
  "              if (fx.bypassed === bypassed) {",
  "                parts.push(`${track.name}: ${effect}#${instanceWanted} already ${action === \"bypass\" ? \"bypassed\" : \"enabled\"}`);",
  "                continue;",
  "              }",
  "              next = toggleEffectBypass(next, track.id, fx.id).execute(next);",
  "              parts.push(`${track.name}: ${effect}#${instanceWanted} ${bypassed ? \"bypassed\" : \"enabled\"}`);",
  "              touched += 1;",
  "            }",
  "          }",
  "          if (touched === 0) {",
  "            return { text: `nothing changed — ${parts.join(\"; \")}`, mutated: false };",
  "          }",
  "          ctx.execute(snapshot(\"mcpFxInstance\", `MCP: ${action} ${effect}#${instanceWanted}`, before, next));",
  "          return { text: `${parts.join(\"; \")} — one undo step`, mutated: true };",
  "        } catch (error) {",
  "          return { text: `fx op failed: ${error instanceof Error ? error.message : String(error)}`, mutated: false, isError: true };",
  "        }",
  "      }",
  "      try {",
  "        const before = ctx.getDoc();",
  "        // bypass/enable flip the BYPASS FLAG (never delete the instance);",
].join(NL);
must(s.includes(fxTryOld), "fx try anchor");
s = s.replace(fxTryOld, fxTryNew);

fs.writeFileSync("src/mcp/tools.ts", s);
console.log("PART 1 OK — imports/interface/export/markers/fx");
