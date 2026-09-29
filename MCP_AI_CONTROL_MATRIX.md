# MCP AI CONTROL MATRIX — KYX / Pulse Forge

> Deep audit of the MCP / AI control layer, 2026-09-29.
> Every row is grounded in code (`src/mcp/*`, `server/mcp-core.mjs`, `desktop/mcp-*.cjs`)
> and verified against a real `ProjectStore` headlessly (`tmp/mcp-verify.mts` harness,
> `tests/mcp-*.test.ts`, 66 specs). Repairs shipped during this audit are marked **[REPAIRED]**.
> Statuses: `FULLY EXPOSED` · `PARTIALLY EXPOSED` · `READ-ONLY` · `WRITE-ONLY` · `NOT EXPOSED` · `UNSAFE / UNRELIABLE`.

---

## 1. Architecture map (AI request → real DAW behavior)

Two transports, one execution core. The MCP layer is a **relay, not an executor** — every
mutation goes through the deterministic command layer (`src/commands/commands.ts`), the same
path the in-app intent bar uses.

```
Web transport                                    Desktop transport
─────────────                                    ─────────────────
external MCP client                              external MCP client (Claude Desktop & co.)
  → POST /mcp (JSON-RPC, Bearer MCP_TOKEN)         → desktop/mcp-server.cjs (stateless stdio)
  → server/collab-server.mjs                       → HTTP → mcp-bridge-server.cjs (127.0.0.1 ONLY,
    └─ server/mcp-core.mjs                            bearer token, 1 MB cap)
       auth (constant-time token) → parse            → IPC kyx:mcp:call (Electron main,
       → tools/list: MCP_TOOL_DEFS (mirror)             mcp-host-manager.cjs, 10 s timeout)
       → tools/call → hub.callTool() ─┐               └─→ renderer src/mcp/desktop-host.ts
                                       │ WS /mcp-relay?token=
                                       ↓                  both converge here:
                          KYX window src/mcp/bridge.ts
                                       ↓
                       executeMcpTool(ctx, tool, args)   ← src/mcp/tools.ts (THE tool surface)
                                       ↓
        ┌──────────────────────────────┴───────────────────────────────┐
        │ McpToolContext: getDoc / execute / undo / redo / transport /  │
        │ export / allowDestructive / isMicRecordingActive             │
        └──────────────────────────────┬───────────────────────────────┘
                        deterministic command layer (clamps, invariants, snapshots)
                                       ↓
        ProjectStore (undoable doc) · Transport · render+download (export)
                                       ↓
                     verification read-back text → MCP result → AI
```

Key properties (verified):

- **Opt-in everywhere**: no `MCP_TOKEN` → the web endpoint refuses with "disabled"; the desktop
  bridge does not exist until the user flips the ⚡ chip; the relay socket cannot authenticate
  without the operator token.
- **Loopback-only desktop bridge**, constant-time bearer compare, 1 MB body cap, per-call timeout
  (15 s web / 10 s desktop) — a hung tool call can never wedge the client permanently.
- **Three copies of the tool definitions** (source `src/mcp/tools.ts`, server mirror
  `server/mcp-core.mjs`, desktop mirror `desktop/mcp-tool-defs.cjs`) — both mirrors are now
  pinned verbatim by tests **[REPAIRED: the server mirror had silently drifted — 3 missing
  `kyx_state` subjects and missing `kyx_generate` bars/replaceMode — because the old pin only
  checked tool NAMES]**.
- No resource/primitives registration (`resources/list` unsupported) — discovery is tools-only.

Places where MCP touches UI/internal details rather than stable domain APIs: **none found** —
tools call command factories and intent appliers, never React state. The closest is
`ctx.export`, which drives a window-local download (inherent: the browser owns the filesystem
sandbox).

---

## 2. AI CONTROL COVERAGE MATRIX

Legend — Read/Write: `full` (structured + verifiable) · `nl` (natural-language via `kyx_intent`
only) · `none`. Validation: does deterministic code (not the LLM) check it? Verification: does
the tool result prove the state change?

### Project

| Capability | Read | Write | Validation | Undo | Verification | Status | Missing |
|---|---|---|---|---|---|---|---|
| Create/open/save project | none | none (save honestly refused) | n/a | n/a | honest refusal | NOT EXPOSED | project CRUD tools; MCP binds to the open window |
| Tempo (BPM) | full (`kyx_state tempo`) | full (intent, `kyx_generate.bpm`) | clamps 40–220 | ✅ one step | read-back lands exact BPM | FULLY EXPOSED | — |
| Key | full (`kyx_state key`) | nl (exact op) | key enum | ✅ | read-back | PARTIALLY EXPOSED | structured `set_key` |
| Time signature | read-only (in tempo readback) | none | — | — | — | READ-ONLY | write path |
| Markers (cue points) | full (list + bar positions) | full (`kyx_markers` add/remove, intent) | bar ≥ 1, nearest-window match | ✅ | honest (no-marker-near-bar refusal) | FULLY EXPOSED | rename marker |
| Groove/swing | full (`kyx_state groove`) | full (`kyx_groove` global + section-scoped, `set` percent) | 0–100 clamps | ✅ | label + readback | FULLY EXPOSED | humanize structured knob (NL only) |
| Project name/metadata | none | none | — | — | — | NOT EXPOSED | — |
| Pattern list/select | full (`kyx_pattern list`, `kyx_state pattern`) | full (select by index/name) | honest unknown-pattern | ✅ | active-pattern readback | FULLY EXPOSED | pattern create/delete (generate covers create) |

### Tracks

| Capability | Read | Write | Validation | Undo | Verification | Status | Missing |
|---|---|---|---|---|---|---|---|
| Create drum/instrument track | — (`kyx_state tracks` lists) | full (`kyx_tracks addDrum/addInstrument`, 10 instrument kinds) | kind enum | ✅ | label | PARTIALLY EXPOSED | remaining 5 instrument kinds; initial mixer values |
| Delete track(s) | — | full (`kyx_tracks remove`, D4-gated) | family match, last-track guard | ✅ **ONE step for N tracks [REPAIRED: was N undo steps]** | count readback | FULLY EXPOSED (consent-gated) | — |
| Rename | via tracks list | `kyx_tracks rename` (family) | 40-char trim | ✅ | honest no-match refusal | PARTIALLY EXPOSED | renames only the FIRST family match; no track-ID addressing |
| Duplicate / reorder / color | none | nl (duplicateTrack exact op) / none / none | — | ✅ / — / — | label | PARTIALLY / NOT / NOT EXPOSED | structured ops; color not in model |
| Mute / solo | full (in `kyx_state tracks` **[REPAIRED: mixer values now included]**) | nl (exact ops) | target resolution, group semantics | ✅ | label | PARTIALLY EXPOSED | structured `set_mute/set_solo`; per-ID addressing |
| Gain / pan | full (gain linear + dB, pan **[REPAIRED]**) | nl (fader + exact, rel & absolute dB) | clamps in command layer | ✅ | label | PARTIALLY EXPOSED | structured setters; per-ID addressing |
| Routing (sends/returns/buses/groups) | none | nl sends only (`applySendIntent`) | send clamp [0,1.5], return-exists check | ✅ | send readback (in-app path) | PARTIALLY EXPOSED (sends) / NOT (buses, groups, returns) | send structured tool; return/bus/group create+route; routing read |

> **Addressing model — the core structural limitation.** Every MCP write targets a track
> **family** (regex on name + instrument kind: `drums|bass|lead|chords|kick|snare|…`). Two hat
> tracks, the 2nd snare, one pad of many — not individually addressable. Track IDs exist in the
> model and in read-backs are NOT exposed. This caps precision across every write row above.

### Audio clips / stems / recordings

| Capability | Read | Write | Validation | Undo | Verification | Status | Missing |
|---|---|---|---|---|---|---|---|
| Clip copy/move/trim/delete | none | nl (`applyClipArrangeOps`) | clip-at-bar resolution | ✅ | label | PARTIALLY EXPOSED (NL, no reads) | clip listing tool; structured ops |
| Import audio / takes / waveforms | none | none (record honestly refused) | — | — | — | NOT EXPOSED | whole domain (import, takes, comping, fades, stretch, reverse, gain, grouping) |

### Mixer

| Capability | Read | Write | Validation | Undo | Verification | Status | Missing |
|---|---|---|---|---|---|---|---|
| Channel gain/pan/mute/solo | full **[REPAIRED]** | nl | clamps | ✅ | label (+ fader readback in-app) | PARTIALLY EXPOSED | structured setters, per-ID |
| Sends | none | nl | clamp + return-exists | ✅ | in-app readback | PARTIALLY EXPOSED, near WRITE-ONLY | send READ tool **(P0 — see roadmap)** |
| Master (gain, tilt, trim) | none | nl (target "mix"/"master"; loudness NL runs in-app only, refused over MCP) | clamps | ✅ | label | PARTIALLY EXPOSED / WRITE-ONLY | master read; loudness loop over MCP |
| Metering (peak/RMS/LUFS) | none | n/a | — | — | — | NOT EXPOSED | engine has MeterRing + loudness measurement — no MCP surface **(P0)** |

### Plugins / effects

| Capability | Read | Write | Validation | Undo | Verification | Status | Missing |
|---|---|---|---|---|---|---|---|
| List FX chain per track | full (`kyx_state fxChain`, truncation now honest **[REPAIRED]**) | — | — | — | — | READ-ONLY (full for what it shows) | param values not shown |
| Insert/remove/bypass | bypass state in fxChain | full (`kyx_fx` — 12 effect types; **[REPAIRED: bypass now FLAGS instead of deleting; enable un-bypasses instead of turning the knob up; remove is D4-gated]**) | effect enum, family match, knob clamps | ✅ one step | **[REPAIRED: wave-8 `effectReadback` — landed knob value — now appended]** | PARTIALLY EXPOSED | 30+ more effect types; per-instance addressing; chain reorder |
| Set parameters | — | PRIMARY KNOB only (`more/less` ± percent) | `clampEffectParam` per param | ✅ | landed-value readback **[REPAIRED]** | PARTIALLY EXPOSED | **arbitrary `set_plugin_parameter` (P0)** — the knob model can't reach e.g. EQ band freq |
| Param metadata (min/max/default/unit/enum/taper) | NOT EXPOSED | — | — | — | — | NOT EXPOSED | registry (`EFFECT_DEFS`) already carries it — needs a discovery tool **(P0)** |
| Presets | — | nl (preset intent + suggestions on unknown) | preset name check | ✅ | label | PARTIALLY EXPOSED | list-presets tool |
| Plugin automation | none | none (automation is gain-ramp NL only) | — | — | — | NOT EXPOSED | see Automation |

### Instruments / sound sources

| Capability | Read | Write | Validation | Undo | Verification | Status | Missing |
|---|---|---|---|---|---|---|---|
| Select instrument kind | track list shows `inst=` | full at track creation (10 kinds) | enum | ✅ | label | PARTIALLY EXPOSED | change existing track's instrument |
| Presets / sound-swap | — | nl (preset intent; sound-swap descriptors) | suggestions on unknown | ✅ | label | PARTIALLY EXPOSED | listing available presets/samples |
| Edit params / trigger notes | none | none | — | — | — | NOT EXPOSED | audition is window-local by design (v1 non-goal) |

### Transport

| Capability | Read | Write | Validation | Undo | Verification | Status | Missing |
|---|---|---|---|---|---|---|---|
| Play/stop/pause/metronome | none (dispatch echo only) | full (tool + NL bare words **[REPAIRED: NL "stop"/"loop on" now dispatch instead of no-op'ing]**) | enum | n/a (runtime state) | echo — no position readback | PARTIALLY EXPOSED | playing-state read **(P1)** |
| Loop on/off | none | full — **[REPAIRED: loopOn PRESERVES the user's loop range (was: silent reset to bars 1–4)]** | — | n/a | echo | PARTIALLY EXPOSED | set loop region by bars; loop-state read |
| Seek / position | none | none | — | — | — | NOT EXPOSED | seek + playhead read **(P1)** |
| Record arm | — | honestly refused (window-local take lifecycle) | — | — | refusal | NOT EXPOSED (intentional v1) | — |

### Automation

| Capability | Read | Write | Validation | Undo | Verification | Status | Missing |
|---|---|---|---|---|---|---|---|
| Gain ramps | none | nl (`applyAutomateIntent`) | tick NaN gates, sorted insert | ✅ | label | PARTIALLY EXPOSED, WRITE-ONLY | automation READ; point edit/delete; FX-param targeting **(P1)** |

### Export / rendering

| Capability | Read | Write | Validation | Undo | Verification | Status | Missing |
|---|---|---|---|---|---|---|---|
| Master bounce WAV/MP3 | — | **[REPAIRED: `kyx_export` was DEAD on both transports — no host ever wired `ctx.export`; now rides the same render+encode+download pipeline as the in-app export intent (`src/export/quick-bounce.ts`, shared)]** | format enum | n/a | "started" only — completion not verifiable v1 | PARTIALLY EXPOSED | awaited result with duration/size; stems; render settings (sample rate, bit depth, normalization); file path |

### Analysis (the largest gap)

| Capability | Status | Notes |
|---|---|---|
| Peak / RMS / LUFS / clipping | NOT EXPOSED | engine meters exist (`MeterRing`, loudness measure) — zero MCP surface |
| Spectrum / frequency balance | NOT EXPOSED | spectrogram + ultina analysis are in-app UI |
| Waveform / silence / dynamics | NOT EXPOSED | — |
| Plugin / routing state read | PARTIALLY EXPOSED | fxChain types + bypass; no param values, no send/route graph |

### Undo / redo / history / safety

| Capability | Status | Notes |
|---|---|---|
| Undo/redo N steps | FULLY EXPOSED | **[REPAIRED: redo no longer reports phantom steps on an empty stack]**; mic-take guard on undo |
| History labels | FULLY EXPOSED | `kyx_state history` (last 12) |
| Action attribution | PARTIALLY EXPOSED | structured ops label with `MCP:` prefix; NL-routed ops carry domain labels only |
| Destructive consent (D4) | FULLY EXPOSED **[REPAIRED: gate now covers `kyx_fx remove`, and NL phrasings ("delete the drums track", "remove the reverb from the lead") can no longer bypass it]** | persisted user flag, read live per call |
| Error propagation | RELIABLE **[REPAIRED: throwing tools (no-target fx, arrange-overlap resize) crashed the web relay into a 15 s timeout; now: honest failure results + bridge-level crash guard + `isError` honored end-to-end]** | — |

---

## 3. Parameter & range intelligence (§4 of the audit)

Machine-readable metadata exists **in the app** (`EFFECT_DEFS` params: min/max/default; clamps in
`clampEffectParam`; log tapers in UI sliders) but the MCP surface exposes almost none of it:

- Tool JSON-Schemas carry ranges for their own args (`steps 1–256`, `velocity 0.05–1`,
  `bpm 40–220`, `percent 0–100`) — good.
- `kyx_fx percent` is documented as "% of the knob's range" — but the AI cannot discover any
  knob's min/max/default/unit **[REPAIRED at the result level: the read-back now reports the
  landed native value, e.g. `mix 0.20→0.36 on Lead`]**.
- No enum listing for presets/samples/instruments beyond the tool schemas' hard-coded 10-kind
  instrument enum and 12-effect enum (the app ships 15 instruments / 47+ effects).
- Mappings: percent→value is linear per-knob (native units); log-taper params are Linear from the
  MCP view — the clamp still protects the ceiling.

**Conclusion**: ranges are enforced (deterministic clamps — the LLM cannot push out-of-range
values into the graph), but they are not *discoverable*. The registry already holds the data;
surfacing it is cheap (roadmap P0).

## 4. Read/write balance (§5)

Write-only or read-poor areas after this audit's repairs:

- Sends: writable via NL, **zero read** (a "more reverb send" loop cannot verify the landing).
- FX params: primary-knob write now verified by read-back, but no state read of other params.
- Transport/loop/metronome: dispatch echo only — no runtime-state read.
- Master: no read at all.
- Automation: write-only ramps.

Read-rich areas: project overview, tracks (+mixer values), patterns/step grid, scenes, markers,
groove, fx chain (types + bypass), history.

## 5. Discovery & self-description (§6)

Can a fresh LLM answer…?

| Question | Answerable? |
|---|---|
| What tracks/patterns/scenes/markers exist? | ✅ `kyx_state` + `kyx_pattern list` |
| What FX are inserted (per family)? | ✅ `kyx_state fxChain` (types + bypass, not params) |
| What plugins/effects/instruments/presets EXIST to add? | ❌ (only the 12+10 enum values inside tool schemas) |
| What parameters does plugin X expose + valid values? | ❌ |
| What buses/sends/routing exist? | ❌ |
| What clips are on this track? | ❌ |
| What is selected / playing / playhead position? | ❌ |
| What can I control right now? | partial (tool schemas; enums drift-corrected **[REPAIRED]** but still static) |

## 6. Sound-control gap scenarios (§7)

| Producer request | Today over MCP | What's missing |
|---|---|---|
| "Make the vocal less harsh" | ❌ (no vocal analysis; EQ param beyond primary knob unreachable) | LUFS/spectral READ; arbitrary EQ param set; per-band EQ tool |
| "Give the drums more punch" | ⚠️ partial — NL production intents exist in-app; over MCP only generic `kyx_fx compressor more` | transient/PLR analysis; production-intent execution over MCP; compressor attack/release |
| "Reduce low-end buildup" | ⚠️ NL EQ intents ("darker/warmer") work; precision dip does not | spectral read; per-band EQ (freq/Q/gain) tool |
| "Make this pad wider without affecting the bass" | ⚠️ per-family FX works; width ≠ a primary knob for most; no verification of stereo width | unison/width param addressing; stereo analysis read |
| "Add subtle reverb only to the snare" | ⚠️ snare-family FX… but FX targets track families, and pads live INSIDE the drum track — per-pad FX does not exist in the model | per-pad send/FX (model-level) or pad-split track op |
| "Balance all tracks around the vocal" | ❌ no level reads to balance against, no mix execution over MCP | metering read; mix-profile executor over MCP (exists in-app) |
| "Fix clipping without changing the character" | ❌ no clipping detection over MCP | peak read + limiter params |

## 7. Atomic vs high-level balance (§8–§9)

- **Good atomicity**: one tool call = one undo step everywhere after repairs (steps snapshot,
  multi-track remove snapshot **[REPAIRED]**, fx/groove/sections/markers single commands).
- **Good high-level coverage**: `kyx_generate` (whole pattern from spec), `kyx_groove`,
  `kyx_sections`, NL fader/FX/sends.
- **Too coarse**: `kyx_fx` (one knob per effect — no param addressability); family addressing
  everywhere; `kyx_transport` (no seek/region).
- **Too low-level / choreography**: none pathological — the NL layer absorbs what would
  otherwise be 5-call chains (e.g. "mute drums + tempo 140" via compound intents is ONE call
  **[REPAIRED: compound now executes over MCP]**).
- **No multi-call transaction API**: each call is its own undo step; a client building a vocal
  chain (add comp → set ratio → add EQ → dip 3 kHz) makes 4 calls / 4 undo steps with no batch.
  Partial failure leaves earlier calls applied — but each is independently undoable and the
  client sees per-call results.

## 8. Safety & validation boundaries (§11) — verified

Deterministic (not LLM) checks confirmed live: family/target resolution with honest no-match,
last-track guard, D4 consent gate (now bypass-proof against NL phrasing **[REPAIRED]**),
mic-recording undo pin, step range 1–stepCount, velocity/percent clamps, param clamps,
arrange overlap invariant (throws → honest failure **[REPAIRED]**), pattern bounds, marker
nearest-window, share/import caps (untouched domains), auth (constant-time, opt-in),
loopback-only desktop bridge. No feedback-loop guard is needed at MCP level because routing
writes aren't exposed (when they become exposed — roadmap — the domain layer's cycle checks must
be verified).

## 9. Observability & verification (§12)

Every mutation returns a read-back-derived text; after repairs: `kyx_fx` reports the landed
native value, steps report before→after counts, tracks-remove reports counts + undo granularity,
undo/redo report true counts. Remaining echoes: transport actions (no state readback — roadmap),
export ("started", no completion — v1 documented). Structured JSON results (previous/new value
fields) do not exist — all results are text. That is workable for LLMs but machine-readable
fields would be sturdier (P2).

---

## 10. MISSING CAPABILITIES ROADMAP

### P0 — BLOCKING (AI cannot do core DAW work without these)

1. **Analysis reads**: `kyx_meter` (peak/RMS per track + master, LUFS, clip flag) — the engine's
   MeterRing/loudness already measure; expose last-N-window stats. Unlocks every
   "listen and adjust" workflow.
2. **`kyx_plugin_param`**: `set` any FX param by (track, instance, paramId, value) +
   `kyx_state fxParams` read of current values, clamped via `clampEffectParam`. The knob-only
   model blocks precise EQ/dynamics/reverb shaping.
3. **Param/effect/instrument discovery**: `kyx_catalog` (effects+params with
   min/max/default/unit, instruments, presets) straight from `EFFECT_DEFS`/`INSTRUMENT_DEFS` —
   makes the surface self-describing instead of enum-frozen.
4. **Track-ID addressing**: accept `trackId` (returned by reads) as an alternative to family on
   every write — precision for multi-track families.

### P1 — HIGH VALUE

5. Transport reads + seek: `kyx_transport seek <bar>`, `position` readback, loop-region set by
   bars; playing-state.
6. Send-level reads (`kyx_state sends`) — close the send write-only gap.
7. Automation surface: read lanes, add/delete points, target FX params (rides P0-2).
8. Structured mixer setters (`set_gain_db/set_pan/set_mute/set_solo` with absolute values +
   read-back) — NL works but is unverifiable-by-construction for absolute asks.
9. Clip tools: list clips per track, structured move/trim/split/delete (D4-gated).
10. Export upgrade: awaited result (duration/size), stems mode, sample-rate/bit-depth options.
11. Loudness/mix loops over MCP (execute the in-app measure→trim→verify path; needs the async
    render context — same shape as `kyx_export` now real).

### P2 — ADVANCED

12. Machine-readable tool results (`{affected, previous, next, warnings}` JSON alongside text).
13. Batch/transaction tool (`kyx_batch [calls]` → one undo frame) using the existing
    `beginUndoFrame/endUndoFrame`.
14. Recording-take management (list takes, comp picks) once record is MCP-safe.
15. Routing graph tools (bus/group create, route, cycle-checked).
16. Per-instance FX addressing + chain reorder.
17. MCP action attribution on ALL labels (`MCP:` prefix in NL-routed commands).

### Sizing note

P0-1..P0-4 are all thin reads/writes over EXISTING domain APIs (registry metadata, clamps,
MeterRing, ids) — no new DSP, no model changes. Each is an evening-scale tool + tests, exactly
like the waves this layer already ships.

---

## 11. Repairs shipped in this audit (2026-09-29)

| # | Defect | Root cause | Fix | Evidence |
|---|---|---|---|---|
| 1 | Web relay hung 15 s on any throwing tool (no-target `kyx_fx`, arrange-overlap `kyx_sections resize`) | `bridge.ts` called `executeMcpTool` without try/catch; desktop host had one, web didn't | bridge crash guard + `isError` honored through `handleMcpRequest` | `tests/mcp-web-host.test.ts` crash test; `tests/mcp-core.test.ts` isError test |
| 2 | `kyx_fx bypass` DELETED the FX instance; `enable` turned the knob up | action→direction mis-mapping (`bypass`→`remove`, `enable`→`more`) | routed to `applyBypassIntent`/`setEffectBypassOnTracks` | `tests/mcp-tools.test.ts` bypass/enable test |
| 3 | `kyx_fx remove` bypassed the documented D4 consent gate | gate only wired into tracks/sections | gate + NL-phrasing gate (`routeIsDestructive`: exact removeTrack, arrange remove, clips deleteClip, effect remove, compound parts) | D4 tests incl. "delete the drums track" via NL |
| 4 | Server advertised a stale tool surface (3 missing `kyx_state` subjects, missing `kyx_generate` bars/replaceMode) | name-only pin; three def copies | verbatim mirror + deep pin test (names+descriptions+schemas) | `tests/mcp-core.test.ts` verbatim-mirror test |
| 5 | `kyx_export` was dead on BOTH transports | no host ever wired `ctx.export` | shared `src/export/quick-bounce.ts` wired into web + desktop hosts; IntentPanel deduplicated onto it | `tests/quick-bounce.test.ts` |
| 6 | `kyx_undo`/NL-undo reported phantom redo steps | redo loop had no empty-stack break; NL undo reported asked-not-done, no mic guard | verified counting both directions + mic pin | honest-count tests |
| 7 | `kyx_transport loopOn` silently reset the user's loop to bars 1–4 | hardcoded range | preserves live loop bounds (fallback 4 bars) — matches in-app behavior | loop-preserve tests |
| 8 | `kyx_tracks remove` = N undo steps for one call | per-track `execute` loop | one `snapshot` | one-undo-step test |
| 9 | `kyx_state tracks` had no mixer values; `fxChain` truncated silently | readback gap | gain (linear+dB)/pan/mute/solo per track; truncation note | state tests |
| 10 | NL intents no-op'd with a misleading message for transport/query/compound/production; loudness/mix/etc. pretended "nothing changed" | `intentCommand` switch missed route kinds | transport dispatch, query read-backs, compound + production execution; honest not-over-MCP refusals | intent-route tests |
| 11 | `kyx_fx` result echoed the label only | no verification | wave-8 `effectReadback`/`bypassReadback` appended (landed native values) | readback in fx tests |

---

## 12. Final answer

**What prevents comprehensive, precise, safe, verifiable AI control today?** Not the
architecture — the relay/command-layer/verification spine is sound, opt-in, and (after this
audit's 11 repairs) consistent and crash-safe. The blockers are four **missing surfaces**, all
thin wrappers over existing domain code:

1. **No analysis reads** — the AI is deaf (no levels, LUFS, spectrum, clipping).
2. **No arbitrary plugin-param addressing** — one knob per effect caps sound-shaping precision.
3. **No catalog/metadata discovery** — the DAW is not self-describing beyond static enums.
4. **Family-level addressing only** — no track/instance IDs, so precision caps out on the first
   ambiguous target.

**Smallest practical path**: ship P0-1..P0-4 (four evening-scale tools over existing APIs), then
P1-5..P1-8 for the transport/send/automation/mixer read-write loops. That converts the MCP from
"a remote control for the intent bar" into a genuine agent-grade control surface — measurable
("the vocal peaks at −2 dBFS"), addressable ("track t3, instance 2, param freq"), and
self-describing ("what can I set on this compressor?").
