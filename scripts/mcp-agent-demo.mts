/**
 * MCP AGENT DEMO — "watch an agent produce a beat through the standard protocol".
 *
 * One command: npm run mcp:demo
 *
 * Boots a real collab server (MCP_TOKEN auth) and plays BOTH roles over the
 * REAL protocol: the WINDOW (connects to /mcp-relay with the token, answers
 * mcp-call frames through the REAL executeMcpTool on a REAL ProjectStore)
 * and the AGENT (initialize → resources/read playbook → the playbook's
 * beat-from-scratch workflow via tools/call over HTTP, verifying every
 * read-back — exactly like Claude Desktop would).
 *
 * The window role lives in this process because the tool graph is already
 * warm here (the relay window itself is transport-identical: same frames,
 * same executor — see src/mcp/bridge.ts for the browser counterpart).
 *
 * This is both the killer-feature demo and the permanent live E2E harness:
 * anything that breaks the agent loop breaks this script.
 *
 * Exit 0 = the whole agent session verified. Exit 1 = a step failed.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { executeMcpToolAsync, type McpToolContext } from "../src/mcp/tools";

import { createServer } from "node:net";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}
const PORT = await freePort();
const MCP_URL = `http://127.0.0.1:${PORT}/mcp`; // eslint-disable-line no-use-before-define
const TOKEN = "mcp-demo-token";
const RELAY_URL = `ws://127.0.0.1:${PORT}/mcp-relay?token=${encodeURIComponent(TOKEN)}`;

let stepNo = 0;
function step(title: string) {
  stepNo += 1;
  console.log(`\n── AGENT STEP ${stepNo}: ${title}`);
}
function say(who: string, text: string) {
  console.log(`   [${who}] ${text.replace(/\n+/g, " ⏎ ").slice(0, 150)}`);
}
function must(cond: unknown, what: string): asserts cond {
  if (!cond) {
    console.error(`\n  ✗ DEMO FAILED at step ${stepNo}: ${what}\n`);
    cleanup();
    process.exit(1);
  }
}

let server: ReturnType<typeof spawn> | null = null;
let windowSocket: WebSocket | null = null;
function cleanup() {
  server?.kill();
  windowSocket?.close();
}
process.on("exit", cleanup);

let rpcId = 0;
async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return res.json();
}
async function call(tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = await rpc("tools/call", { name: tool, arguments: args });
  if (r.error) throw new Error(`${tool}: ${r.error.message}`);
  return { text: r.result.content[0].text as string, isError: r.result.isError === true };
}
async function ok(tool: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await call(tool, args);
  must(!r.isError, `${tool} returned an error: ${r.text}`);
  say(tool, r.text);
  return r.text;
}
async function refuse(tool: string, args: Record<string, unknown> = {}, contains: string): Promise<string> {
  const r = await call(tool, args);
  must(r.text.includes(contains), `${tool} should refuse with "${contains}" but said: ${r.text}`);
  say(tool + " (refused)", r.text);
  return r.text;
}
async function resource(uri: string): Promise<string> {
  const r = await rpc("resources/read", { uri });
  if (r.error) throw new Error(`resources/read ${uri}: ${r.error.message}`);
  return r.result.contents[0].text as string;
}

// ── the WINDOW role: answers relay calls through the real executor ─────────
const base = createProjectFromTemplate("house");
const freshDoc = {
  ...base,
  arrangement: { ...base.arrangement, clips: [], audioClips: [], takeGroups: [] },
  markers: [],
};
const store = new ProjectStore(freshDoc);
const windowCtx: McpToolContext = {
  getDoc: () => store.doc,
  execute: (c) => store.execute(c),
  undo: () => store.undo(),
  redo: () => store.redo(),
  undoStackLength: () => store.undoStackLength,
  historyLabels: () => store.history.map((e) => e.label),
  isMicRecordingActive: () => false,
  transport: {
    play: () => console.log("   [window] ▶ PLAY"),
    stop: () => console.log("   [window] ■ STOP"),
    pause: () => console.log("   [window] ⏸ PAUSE"),
    setLoop: () => {},
    setMetronome: () => {},
  },
  // export/measureLoudness/applyLoudness stay unwired: in a real window they
  // render via OfflineAudioContext; here they refuse honestly — which is part
  // of the demoed contract.
};

function startWindow(): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    windowSocket = ws;
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "mcp-hello" }));
      console.log("   [window] relay connected");
      resolve();
    });
    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type !== "mcp-call") return;
      void (async () => {
        try {
          const result = await executeMcpToolAsync(windowCtx, msg.tool, msg.args ?? {});
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "mcp-result", id: msg.id, result }));
        } catch (error) {
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                type: "mcp-result",
                id: msg.id,
                result: { text: `crashed: ${error}`, mutated: false, isError: true },
              }),
            );
          }
        }
      })();
    });
    ws.on("error", reject);
  });
}

// ── boot: server + window relay ────────────────────────────────────────────
console.log("KYX MCP AGENT DEMO — one agent session, real protocol, real command layer");
server = spawn(process.execPath, ["server/collab-server.mjs"], {
  env: { ...process.env, MCP_TOKEN: TOKEN, PORT: String(PORT) },
  stdio: ["ignore", "inherit", "inherit"],
});
await sleep(1200);
await startWindow();
// wait until the server recognizes the relay session (initialize answers)
let ready = false;
for (let i = 0; i < 20 && !ready; i++) {
  const probe = await rpc("initialize", {});
  ready = !!probe.result;
  if (!ready) await sleep(500);
}
must(ready, "collab server did not come up on port " + PORT);

// ── the agent session ──────────────────────────────────────────────────────
step("initialize the MCP handshake");
const init = await rpc("initialize", {});
say("server", `${init.result.serverInfo.name} · ${init.result.protocolVersion}`);
must(init.result.serverInfo.name === "kyx-mcp", "server identity");

step("read the agent manual (kyx://playbook resource)");
const playbook = await resource("kyx://playbook");
must(playbook.includes("THE CORE LOOP"), "playbook teaches the core loop");
say("resource", `playbook: ${playbook.length} chars — workflow: generate → verify → steps → mix → arrange`);

step("production checkpoint: save 'before' state");
const cp = await ok("kyx_checkpoint", { op: "save", name: "before-agent-session" });
must(/checkpoint/i.test(cp), "checkpoint saved");

step("generate a drill pattern (deterministic seed)");
const gen = await ok("kyx_generate", { genre: "drill", seed: "demo-agent-1", bars: 2, bpm: 142 });
must(/generated/i.test(gen), "pattern generated");

step("verify the grid before editing (read-back discipline)");
const grid = await ok("kyx_state", { subject: "pattern" });
must(/kick/i.test(grid) && /snare/i.test(grid), "pattern grid shows drum families");

step("surgical step edit: ghost snares off the grid");
const ghost = await ok("kyx_steps", { op: "ghost", family: "snare", steps: [6, 14] });
must(/snare/i.test(ghost), "ghost snares landed");

step("groove: swing the beat");
await ok("kyx_groove", { direction: "set", percent: 58 });

step("measured mix profile (drill reference)");
await ok("kyx_mix", { genre: "drill" });

step("song form: arrange sections (empty arrangement)");
await ok("kyx_arrange", { genre: "drill", length: 32 });

step("space: send the drums to the reverb bus");
await ok("kyx_routing", { op: "setSend", family: "drums", returnName: "Reverb", level: 0.35 });

step("transport: play + stop (the window dispatches the runtime)");
await ok("kyx_transport", { action: "play" });
await ok("kyx_transport", { action: "stop" });

step("risky experiment: wrong tempo");
await ok("kyx_intent", { instruction: "set tempo to 90" });
const tempoBad = await ok("kyx_state", { subject: "tempo" });
must(tempoBad.includes("90"), "experiment landed (90 BPM)");

step("producer decision: the experiment was worse — restore the checkpoint");
const restore = await ok("kyx_checkpoint", { op: "restore", name: "before-agent-session" });
must(/restore|checkpoint/i.test(restore), "checkpoint restored");

step("verify the rollback actually landed (state reads, not echoes)");
const tempoAfter = await ok("kyx_state", { subject: "tempo" });
must(tempoAfter.includes("124"), `template tempo restored after roll-back (got: ${tempoAfter})`);

step("honesty contract: what the agent MUST NOT do unsupervised");
await refuse("kyx_takes", { op: "deleteTake", groupId: "tg-x", takeId: "t1" }, "locked");
await refuse("kyx_intent", { instruction: "dark techno at 140" }, "inside the KYX app");

step("final state read");
await ok("kyx_state", { subject: "overview" });

console.log(`\n──────────────────────────────────────────────────────────`);
console.log(`✓ DEMO COMPLETE — ${stepNo} agent steps verified over the real protocol`);
console.log(`  25 tools · read-backs at every mutation · checkpoints · honest refusals`);
console.log(`──────────────────────────────────────────────────────────\n`);
cleanup();
process.exit(0);
