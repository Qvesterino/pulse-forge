# INTENT ENGINE + MCP — EXPANSION PLAN

> Status: plan (not started). Builds on 17 shipped waves of the intent
> engine (audit + schema + adapter bridge + SFT groundwork — see
> docs/LOCAL-INTENT-MODEL.md and the session memory for the wave ledger).
> Every phase below is sized for one focused evening and lands behind the
> same discipline as the shipped waves: deterministic command layer,
> one-undo mutations, read-back status, explicit failures, regression tests.

---

## Where we are (inventory, 2026-09-29)

The intent bar understands **20 route kinds** across three state contracts:

| Contract                        | Kinds                                                                                                                                                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document commands (undoable)    | fader (rel/abs), exact (mute/solo/pan/gainDb/transpose/tempo/key/patternLength/track CRUD/pad ops), clips (copy/move/trim/delete), arrange (scene ops), groove (global + section-scoped microtiming bake), automation (gain ramps), markers, presets, effects (more/less/set/remove), sends, bypass |
| Runtime / persistence (no undo) | transport, metronome, loop, save, export (wav/mp3), record (pattern recorder)                                                                                                                                                                                                                       |
| UI state                        | select                                                                                                                                                                                                                                                                                              |
| Proposals / meta                | pattern generation, song builder, revise, compound, clarify, typo, presetUnknown                                                                                                                                                                                                                    |

Infrastructure shipped and locked by tests: `model-schema.ts` (action
schema + GBNF grammar), `model-resolver.ts` (provider bridge,
`tryModelRoute`), `stt-*` (whisper drawer), SFT corpus v2 (454 pairs,
`intent:dataset` / `intent:eval`), golden lock
(`tests/intent-sft-golden.test.ts`).

---

## Phase A — Undo / query / session intents (evening 1)

**Why first:** the most-said producer sentence after an AI action is
"take that back". Today it falls to pattern generation. All APIs exist —
this is pure vocabulary + wiring.

### A1. Undo / redo / history

- Grammar: `undo` / `vráť to` / `späť` / `undo two steps` / `redo` /
  `zopakuj` / `what did you just do?` (last read-back)
- API: `ProjectStore.undo() / redo() / jumpTo(index) / history`
- New kinds: `{ kind: "undo"; steps: number }`, `{ kind: "redo"; steps }`,
  `{ kind: "historyQuery" }` → status lists the last N labels with indices
  (jump-to-index offered as a clarify chip)
- Guard: never undo across an unsaved-recording boundary
  (`isMicRecordingActive` gate, same as the SW-reload guard)
- Files: `src/intent/studio-words.ts` (parse) + `route.ts` (kinds, placed
  with studio words) + panel executors calling `services.store`
- Tests: `tests/studio-words.test.ts` — undo 2 steps restores state,
  history query is read-only, recording-boundary guard

### A2. Query intents (read-only)

- Grammar: `what tempo` / `v akom takte` / `what key` / `what's on the lead`
  / `list tracks` / `co je na基地?` — every answer is a readback built from
  `ProjectStore` state (reuse the wave-8 readback helpers)
- New kind: `{ kind: "query"; subject: "tempo" | "key" | "tracks" | "fxChain" | "markers" }`
- Never mutates: route-level only, panel formats the answer into status
- Tests: query routes never touch the doc; answers read real state

**Gate A:** all new kinds in the SFT corpus (`intent:dataset` regen),
golden picks extended, sweep green, typecheck clean.

---

## Phase B — Step-level + sound-swap vocabulary (evening 2)

### B1. Step-level asks

- Grammar: `remove the kick on beat 3 of bar 2` / `pridaj ghost snare na
poslednú 16tinu` / `mute step 7 of the hats`
- API: existing note/step commands (`deleteNote`, `setStepMeta`,
  `toggleStep`) — resolution: bar → tick window → pattern rows
- Scope: active pattern or a named role's pattern (reuse
  `resolveSceneTarget`)
- New kind: `{ kind: "stepEdit"; ops }` — same snapshot etiquette

### B2. Sound-swap / layering

- Grammar: `swap the snare to something fatter` / `layer a clap on the
snare` / `tune the 808 to the key`
- API: `setPadParams` (assetId swap + layers), `applyInstrumentPreset`
  (tuning via preset params), `resolveHitSampleId` vocabulary for the
  "fatter/thinner/tighter" descriptors → sample-library tag search
- New kind: `{ kind: "soundSwap"; padRef; descriptor | presetName }`
- Explicit failures: descriptor matches no sample → suggestions (same
  pattern as presetUnknown)

**Gate B:** step-edit tests hit real rows/pads (pad-id keyed, not names),
sound-swap round-trips through `applyInstrumentPreset` undo, sweep green.

---

## Phase C — Listening loop (complaints → analysis → action)

**Why:** "the drop feels empty" is the highest-value sentence a producer
says that the engine cannot hear yet. The analysis half exists
(`song-audio-review.ts`, section renders); this phase adds the vocabulary
mapping complaints to measurements and the measured fix to an action.

- Complaints vocabulary v1 (each maps to a measurement + a bounded fix):
  - `empty / thin` (section) → spectral density + per-role note density →
    suggest: add role / raise density slider (revise flow, audition-first)
  - `muddy` → low-mid energy → suggest: `darker/warmer` bake or EQ dip
  - `harsh / piercing` → high-band energy → `svFilter`/EQ dip on the named
    family
  - `no punch` → PLR/transient (FAMILY_REFERENCE) → punch recipe (exists)
- Always **audition-first**: the fix is a proposal (revise flow), never a
  silent bake
- Files: `src/intent/complaints.ts` (parse + measurement mapping),
  `song-audio-review.ts` (extend section metrics), panel: complaint →
  measured diagnosis + proposal chips
- Tests: fake section metrics → complaint maps to the right measurement and
  proposal; proposal execution goes through existing revise/production
  commands

**ABX validation harness (SHIPPED)** — the N=1 answer: `npm run
listening:abx` generates a forced-choice ABX page (listening/abx/): the
listener hears X, then A and B in random order, and must decide which one
X was. Chance = 50 %, so repeated trials give a real binomial p-value —
18/20 correct is p ≈ 0.0002 even with a single listener. Trials append to
`listening/abx/trials.jsonl` (POST /api/abx-trial in serve-listening);
`src/listening/abx-stats.ts` aggregates (two-sided exact binomial, haste
filter < 1.5 s, per-lane breakdown, JSONL tolerant parsing — tested in
tests/abx-stats.test.ts). Every Phase C complaint-fix and every
sound-quality wave can ship its before/after pair as an ABX lane: "the
difference is audible" becomes a measured claim, not a taste opinion.

**Gate C:** complaint → diagnosis → proposal → apply → read-back full loop
green under a fake metrics provider; no new audio worklets.

---

## Phase D — KYX as MCP server (the strategic phase)

> **STATUS: D1–D3 SHIPPED** (web transport live over the collab server,
> token-authed, relay-to-browser execution) AND **D2 desktop stdio SHIPPED**
> (loopback bridge in Electron main + stateless stdio forwarder; the tool
> surface is 13 tools, not the 5 originally scoped).

**Thesis:** KYX as an MCP server turns it from "DAW with AI assist" into a
tool any AI agent can drive. The command layer we hardened across 17 waves
(clamps, strict targets, undo, read-backs, explicit failures) IS the MCP
tool validation — an external LLM gets the same guardrails as the intent
bar. Nothing bypasses the domain layer.

### D1. Tool surface (16 tools after the 2026-09-29 P0 wave, no new domain code)

> **P0 wave shipped 2026-09-29** (`MCP_AI_CONTROL_MATRIX.md` §10): `kyx_catalog`
> (effect/param/instrument discovery from `EFFECT_META`/`INSTRUMENT_DEFS`),
> `kyx_plugin_param` (absolute native-value set + list on any inserted FX instance,
> registry-clamped, one undo), `trackId` addressing on fx/tracks/param writes
> (id-passthrough in `trackIdsForTarget`), `kyx_meter` (live true peak/RMS/LUFS/clip via
> `src/mcp/meters.ts`), and the `eq`-enum defect fix (no primary knob → honest refusal).
> **P1-5 shipped same day**: `kyx_transport` reads (`state`: position bar/beat/tick,
> playing/paused, loop region, metronome), `seek bar` (+beat), `loopRegion` by inclusive
> 1-based bars — every transport read-back ends with the resulting state; verified
> against the REAL Transport class (caught an unbound-method `seek` bug the fakes missed).
> **P1-6 shipped same day**: `kyx_state subject:sends` — the full send routing map
> (return buses with id/gain/fx + per-track send levels, zeros included), closing the
> send write-only gap.
> **P1-7 shipped same day**: `kyx_automation` (17th tool) — automation lanes with
> addPoint (lane-on-demand, one undo), deletePoint, clearLane/removeLane (D4-gated),
> gain/pan/FX-param targeting with native-value clamps; `kyx_state subject:automation`
> read-back; family filters on reads now resolve through the write-side family map
> (bass→808, pad families→drum track — fixed fxChain/sends too).
> **P1-8 shipped same day — the P1 wave is CLOSED**: `kyx_tracks` absolute mixer
> setters (setGain via dB/setPan/setMute/setSolo, verify-by-read), `kyx_clips`
> (18th tool: list/move/resize/duplicate/delete arrangement clips by anchor bar,
> delete D4-gated), and `executeMcpToolAsync` — the transports now await `kyx_export`
> and return the completion report (duration/size) with honest isError on failure.
> **P2 core shipped same day**: `kyx_batch` (19th — up to 10 calls in ONE undo
> frame, per-call failures never abort), `kyx_loudness` (20th — render-backed
> measure/match loop landing the master trim), `McpToolResult.data` envelopes
> (transport/meter/clips/batch/loudness), `isError` markers on honest tool failures,
> automation `movePoint`, and the audio-clip surface (`audioList/audioMove/audioSplit/
audioUpdate/audioDelete`). **Model-level wave shipped same day — the campaign is
> COMPLETE**: `kyx_routing` (21st — group graph list/create/route/unroute; the flat model
> makes cycles impossible by construction), `kyx_takes` (22nd — comp workflow: list +
> activate), and per-instance FX ops + chain reorder on `kyx_fx` (`instance` +
> `reorder` with direction/position). Remaining out of scope by design: recording/import
> (window-local), plugin GUIs.
> **Finishing wave shipped same day**: export render options (sampleRate/bitDepth/
> stems-zip through the awaited request), structured send-bus mixer
> (setSend/setReturnGain/createReturn on kyx_routing — the last NL-only corner),
> take deletion (D4-gated, active-take protected) and marker rename. Every write
> in the domain layer is now addressable over MCP.

| Tool            | Input                              | Behavior                                                                                                       |
| --------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `kyx_intent`    | `{ instruction: string }`          | `routeIntentText` → executor → **read-back string as the tool result** (wave-8 verification is the MCP result) |
| `kyx_state`     | `{ subject }`                      | project snapshot: bpm/key/tracks/fx chains/sections/markers (query intents from Phase A)                       |
| `kyx_undo`      | `{ steps? }` / `{ history: true }` | undo/redo + history listing                                                                                    |
| `kyx_transport` | `{ action }`                       | play/stop/loop/record dispatch                                                                                 |
| `kyx_export`    | `{ format }`                       | render + download path returned                                                                                |

All tools are JSON-Schema-typed (generated from the same vocab as
`model-schema.ts` — one source, two consumers).

### D2. Desktop transport (stdio) — SHIPPED

Chain: external MCP client (Claude Desktop & co.) → `desktop/mcp-server.cjs`
(stateless stdio JSON-RPC forwarder) → HTTP POST → loopback bridge inside
Electron main (`desktop/mcp-bridge-server.cjs`, binds 127.0.0.1 ONLY,
constant-time bearer token, 1 MB body cap) → IPC `kyx:mcp:call` to the
focused window → `src/mcp/desktop-host.ts` executes through
`executeMcpTool` (the SAME deterministic command layer as the web relay)
→ `kyx:mcp:answer` back out. The stdio process holds no project data and
executes nothing.

- `desktop/mcp-host-manager.cjs` — manager pattern (clap-host/pcm): bridge
  lifecycle, token generation, IPC handlers (`kyx:mcp:status/enable/
disable/answer`), pending-call map + 10 s timeout per forwarded call
- `desktop/mcp-tool-defs.cjs` — CJS mirror of `MCP_TOOLS`; pinned to the
  TS source by `tests/desktop-mcp.test.ts` (anti-drift)
- Renderer: `startMcpDesktopHost(services)` bound per-project in App;
  IntentPanel ⚡ chip (desktop-only) enables/disables and reveals the
  client config (command/args/env) to paste into the MCP client
- Opt-in: the bridge does not exist until the user flips the chip

### D3. Web transport (streamable HTTP) — SHIPPED

- `server/collab-server.mjs` hosts `/mcp` (streamable HTTP) beside the
  gallery API — one process, one port (same deployment)
- Session ↔ browser relay over the existing WebSocket channel: the server
  holds a queue of tool calls per session, the connected KYX instance
  answers via the collab socket (document state already syncs there)
- Auth: session token issued by the KYX UI on explicit user enable (same
  opt-in shape as `pf:stt-model` / `pf:intent-model`); no anonymous tool
  calls
- WIRING (shipped): server opts in via `MCP_TOKEN` env; the renderer ⚡ chip
  (browser branch) starts/stops `src/mcp/bridge.ts` against the ACTIVE
  collab server (`src/mcp/web-host.ts` — `?server=` override rides the
  shared `isAllowedServerUrl` gate; token persisted under
  `pf:mcp-relay-token`, opt-in under `pf:mcp-relay-enabled`; App re-arms
  the bridge on services swaps). External client config (streamable-HTTP
  URL + Bearer token) is shown/copyable in the chip

### D4. Security guards (non-negotiable)

- Every tool result passes through the existing validation layer — MCP adds
  a transport, never a bypass
- Destructive tools (delete track/clip, export) require an `allow`
  escalation flag the user flips once in settings, persisted like the model
  flags
- `?server=`/remote-origin rules keep using `isAllowedServerUrl`
  (collabShared.ts) — the MCP endpoint inherits the same allowlist
- **AUDIT 2026-09-29 (`MCP_AI_CONTROL_MATRIX.md`)**: the gate now covers
  EVERY removal path — structured (`kyx_tracks`/`kyx_sections`/`kyx_fx`
  remove) AND natural-language phrasings through `kyx_intent`
  (`routeIsDestructive`: exact removeTrack, arrange remove, clips
  deleteClip, effect remove, compound clauses carrying them). Throwing
  appliers (fx no-target, arrange-overlap) surface as honest failure
  results end-to-end (`isError` honored), the web relay has a crash guard,
  `kyx_fx bypass/enable` flag instances (never delete), `kyx_export` rides
  the real quick-bounce pipeline, and the three tool-def copies are pinned
  verbatim (server + desktop mirrors)

### D5. Files

- `src/mcp/tools.ts` — tool definitions + JSON schemas (generated from
  vocab)
- `src/mcp/bridge.ts` — browser-side relay (collab socket ↔ tool queue)
- `server/mcp-session.ts` — session store + auth token check
- `desktop/mcp-host-manager.cjs` + `desktop/mcp-server.cjs` — stdio host
- `tests/mcp-tools.test.ts` — tool contracts against the real command
  layer (fake relay), incl. wrong-kind hard-fail assertion
- `tests/desktop-mcp.test.ts` — the real CJS transport artifacts over real
  HTTP/stdio: bridge auth + guards, stdio subprocess round-trip (13 tools),
  host-manager pending-call lifecycle, tool-defs mirror pin

### D6. Protocol completeness (2025-03-26) — SHIPPED (888aae9c + 2f27837)

- initialize version negotiation (echo a supported client version, else the
  latest we serve) + `instructions` field describing the read→act→verify
  contract
- `resources` capability: resources/list + resources/read over the five
  `kyx://project/*` URIs (overview / pattern grid / mix / arrangement /
  history) — live content relayed through the hidden `__kyx_resource`
  channel shared by all transports
- JSON-RPC batch bodies fan out per-request; notifications yield no entry
- unknown `tools/call` names are protocol errors (-32602), and tool-layer
  failures surface as `isError` results

**Gate D:** an MCP inspector (or any stdio client) lists the 13 tools,
`kyx_intent("mute the drums")` returns the wave-8 read-back and the doc
state matches; two-failure breaker and auth-token rejection tested.

---

## Phase E — Model bridge completion (after weights exist)

Already built: schema + GBNF (`model-schema.ts`), corpus v2 (`intent:dataset`),
golden lock, eval (`intent:eval`), adapter bridge (`model-resolver.ts`),
loader ([C] `model-loader.ts`). Remaining:

1. Train LFM-2.5 1.2B on `train.jsonl` (LoRA, 2–3 epochs, chat template)
2. Gate: `intent:eval` exact ≥ 95 % AND kindOK = 100 % on val (wrong-kind =
   hard fail) → only then ship weights to `public/models/intent-model/`
3. STT weights (whisper tiny/base Q4) → `public/models/stt/` + vendored
   runtime module per the STT manifest
4. Voice → model chain test: mic → transcript → model route → command
   (round-trip under the fake-free stack)

---

## Ordering and effort

| Phase                  | Effort              | Depends on                         |
| ---------------------- | ------------------- | ---------------------------------- |
| A undo/query           | 1 evening           | nothing                            |
| B step + sound-swap    | 1 evening           | nothing                            |
| C listening loop       | 1–2 evenings        | B (proposals reuse B's failure UX) |
| D1–D2 MCP core + stdio | 1–2 evenings        | A (query tool)                     |
| D3 web bridge          | 1 evening           | D1–D2                              |
| E weights + gate       | external (training) | dataset v2 (done)                  |

Recommended run order: **A → B → D1–D2 → C → D3 → E**. A and B are
independent quick wins; D is the strategic unlock; C is the deepening.

## Non-goals / guards

- No cloud inference, no telemetry, no always-on MCP — every remote surface
  is user-enabled and token-bound
- No new domain logic in the MCP layer — tools map to existing commands;
  the deterministic layer stays the only mutation path
- No prompt-hopes: model-facing safety lives in the schema/grammar/eval
  gate, not in instructions
