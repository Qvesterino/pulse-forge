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

**Gate C:** complaint → diagnosis → proposal → apply → read-back full loop
green under a fake metrics provider; no new audio worklets.

---

## Phase D — KYX as MCP server (the strategic phase)

**Thesis:** KYX as an MCP server turns it from "DAW with AI assist" into a
tool any AI agent can drive. The command layer we hardened across 17 waves
(clamps, strict targets, undo, read-backs, explicit failures) IS the MCP
tool validation — an external LLM gets the same guardrails as the intent
bar. Nothing bypasses the domain layer.

### D1. Tool surface (5 tools, no new domain code)

| Tool            | Input                              | Behavior                                                                                                       |
| --------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `kyx_intent`    | `{ instruction: string }`          | `routeIntentText` → executor → **read-back string as the tool result** (wave-8 verification is the MCP result) |
| `kyx_state`     | `{ subject }`                      | project snapshot: bpm/key/tracks/fx chains/sections/markers (query intents from Phase A)                       |
| `kyx_undo`      | `{ steps? }` / `{ history: true }` | undo/redo + history listing                                                                                    |
| `kyx_transport` | `{ action }`                       | play/stop/loop/record dispatch                                                                                 |
| `kyx_export`    | `{ format }`                       | render + download path returned                                                                                |

All tools are JSON-Schema-typed (generated from the same vocab as
`model-schema.ts` — one source, two consumers).

### D2. Desktop transport (stdio)

- `desktop/mcp-host-manager.cjs` — the same manager pattern as
  clap-host/asio-host: spawn `mcp-server.cjs` over stdio, lifecycle tied to
  the app
- The MCP server imports the shared tools module and calls the app's
  services through a narrow bridge (IPC → main → services), reusing the
  manager/handshake conventions already in main.cjs

### D3. Web transport (streamable HTTP)

- `server/collab-server.mjs` hosts `/mcp` (streamable HTTP) beside the
  gallery API — one process, one port (same deployment)
- Session ↔ browser relay over the existing WebSocket channel: the server
  holds a queue of tool calls per session, the connected KYX instance
  answers via the collab socket (document state already syncs there)
- Auth: session token issued by the KYX UI on explicit user enable (same
  opt-in shape as `pf:stt-model` / `pf:intent-model`); no anonymous tool
  calls

### D4. Security guards (non-negotiable)

- Every tool result passes through the existing validation layer — MCP adds
  a transport, never a bypass
- Destructive tools (delete track/clip, export) require an `allow`
  escalation flag the user flips once in settings, persisted like the model
  flags
- `?server=`/remote-origin rules keep using `isAllowedServerUrl`
  (collabShared.ts) — the MCP endpoint inherits the same allowlist

### D5. Files

- `src/mcp/tools.ts` — tool definitions + JSON schemas (generated from
  vocab)
- `src/mcp/bridge.ts` — browser-side relay (collab socket ↔ tool queue)
- `server/mcp-session.ts` — session store + auth token check
- `desktop/mcp-host-manager.cjs` + `desktop/mcp-server.cjs` — stdio host
- `tests/mcp-tools.test.ts` — tool contracts against the real command
  layer (fake relay), incl. wrong-kind hard-fail assertion

**Gate D:** an MCP inspector (or any stdio client) lists the 5 tools,
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
