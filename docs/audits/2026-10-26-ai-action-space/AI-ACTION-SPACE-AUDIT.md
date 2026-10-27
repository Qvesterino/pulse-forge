# The AI Action-Space Audit — Human–AI Capability Parity, Execution Contracts & Safe Agency

| Field            | Value                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit date       | 2026-10-26                                                                                                                                     |
| Repository       | `D:\pulse-forge` (KYX / Pulse Forge)                                                                                                           |
| Revision audited | HEAD `c6d9fb21` (39-tool MCP surface; mirrors in sync at `58a2f8fa`)                                                                            |
| Mode             | READ-ONLY audit. No source, config, schema, project or audio data was modified. No tests were run; no live MCP call was made.                   |
| Method           | Five parallel evidence sweeps (human UI inventory, MCP tool trace, command contracts, safety/observation, intent engine) + direct source verification of load-bearing claims |
| Anchors          | Builds on `docs/audits/2026-10-24-ai-control-completeness/` (executed evidence), `2026-10-20-mcp-control/`, `2026-10-13-command-surface/`, `2026-10-18-referential-integrity/`, `2026-10-26-musical-understanding/` |

---

## Status vocabulary (evidence types)

| Status                | Meaning                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Verified in code**  | Read directly in this audit at cited lines (static evidence).                                                                              |
| **Verified executed** | Proven by a committed test or a prior audit that actually executed the path (cited to that evidence; not re-executed here).                 |
| **Documented only**   | Claimed by docs/ADR/AGENTS.md without code-level re-verification in this audit.                                                            |
| **Inferred**          | Derived behavior, not directly cited. Always labeled.                                                                                      |
| **Not verified**      | Runtime behavior (audio, live transport, real device) — out of scope for a read-only pass.                                                 |
| **UNKNOWN**           | Insufficient evidence; listed explicitly with how to close it.                                                                             |

---

## 1. Executive verdict

**Maturity verdict: the exposed AI action space is a verified, safe, undoable document-control core at L4–L5 — but it covers only about one third of what a human can do, and the missing two thirds are concentrated exactly where a producer's day actually goes (recording, arrangement building, performance nuance).**

Concretely, against a canonical denominator of **309 human mutation-class actions** derived from the actual UI (plus 40 view/context actions excluded from the denominator):

- **103 actions (33%)** are fully AI-executable through 39 MCP tools or the shared intent router, each reaching the same command layer the UI uses, with truthful receipts (`mutated` means the document changed — `src/mcp/verified-mutation.ts`), inverse-patch undo, and typed error codes.
- **20 actions (6.5%)** are partially reachable (right command, wrong units or missing primitives, e.g. slice/strip need pre-computed segments; render-bound tools refuse where the hook is absent).
- **186 actions (60%)** have no AI path. Of these, roughly **45 are intentional boundaries** (recording, device/hardware, project open, audio import) and **~141 are accidental coverage gaps** — mostly fine-grained edit depth (step velocity/microtiming/p-locks, note transforms, automation clips, warp pins) and lifecycle/export breadth. Every parity cell was resolved during the audit — no UNKNOWN cells remain (the six candidates were closed by direct enum/grep verification, §7).

**Strengths (all verified in code, most previously executed by cited tests/audits):**

1. **One mutation path.** UI, intent router, and MCP converge on `ProjectStore.execute` → inverse-patch commands (`src/commands/core.ts:34-72`); no divergent mutation path exists. The audio engine is only ever reached through `onDocChanged → engine.setProject` (`src/services.ts:1291-1307`) — no AI path touches the audio thread.
2. **Truthful receipts.** The R-02 gate rewrites false success claims: an unchanged document becomes `mutated:false / status:"unchanged"`, undo-claim inflation is corrected, and every non-read-back success gets a structural document diff appended (`src/mcp/verified-mutation.ts:90-151`, enforced at `src/mcp/tools.ts:4667-4680`). Parameter asks verify against **real offline DSP renders**, not knob echoes (`src/intent/param-readback.ts:153-220`, browser-proven via `npm run verify:param-readback`).
3. **Layered authorization that is actually enforced.** Permission lattice (ADR 0065: `auto / confirm / forbid`, stale-revision forbid before consent), per-op destructive gate (15 verified sites) with auto-checkpoints on 7 of them, envelope scope guard, per-field stale-write refusal (`WRITE_CONFLICT`), foreign-work undo consent, content-free bounded audit log (200 entries, primitives truncated, no payload content).
4. **Composability primitives exist and are tested.** `kyx_batch` (≤10 calls, one undo frame, riskiest-child risk), `dryRun` sandbox (real commands on a throwaway doc chain), idempotency (SHA-256 signature, replay with a second "what holds NOW" channel), session + destructive checkpoints, `kyx_checkpoint` diff/restore.
5. **Honest boundaries.** Cancellation is absent and **declared absent** as machine-readable contract (`cancellation: {supported:false}`, `tools.ts:4056-4061`); recording/open/audio-import are named `unavailableByDesign` rather than faked; five text-first tools are known and listed.

**Limitations:**

1. **No arrangement-building primitive.** `kyx_clips` has no `add` op (verified enum, `tools.ts:2560-2585`) and no MIDI-clip surface — an agent can edit any existing clip but cannot place a new one except through the whole-song builders (`kyx_arrange`, `kyx_song`).
2. **Edit depth cliff.** The sequencer's expressive layer (velocity edit of existing steps, microtiming, probability, p-locks), the piano roll's transforms (9 creative ops, glue/split/duplicate, expressions), warp pins, automation clips and modulators are all human-only. These are the actions that separate a demo from a record.
3. **No cancellation**, so a long render keeps running after a timeout; combined with the web transport's missing rate limiter and shared `web-relay` identity, retry semantics for external effects (publish/export) rest on convention, not enforcement.
4. **Lifecycle incompleteness.** Save/save-as exist; open/new/import/transfer do not (open intentionally). An agent can finish a song but cannot start or move between ones.
5. **Contract drift pockets** (§7): duplicated range constants (gain 0..1.5 re-typed in ≥5 files after a real 0..4 drift incident), 0- vs 1-based `startBar` in one tool surface, PPQ literal at the MCP boundary, two velocity floors.

**No open P0 (state-corruption) defect was found at HEAD.** All P1 findings of the 2026-10-24 audit that we re-verified are fixed (truthful receipts, mirrors in sync, `loadSampleMono` wired, fxId/clipId targeting, stale-write refusal, automation undo fold). The highest-severity open item is a consistency gap: 7 of 15 destructive gate sites skip the per-op `auto-before-<tool>` checkpoint (AS-004).

**Confidence:** high for the static/action-space claims (this audit + four prior executed audits). LOW for anything audible: no listening test, no PCM comparison, no live transport or device behavior was exercised in this pass — those remain covered only by the repo's committed browser/real-DSP gates.

---

## 2. Audit coverage & evidence ledger

What this audit **did**:

| # | Evidence activity | Scope | Limits |
| - | ----------------- | ----- | ------ |
| E1 | Prior-audit synthesis | `2026-10-24-ai-control-completeness` (executed evidence incl. real headless-host probe, focused suites: 439 tests at P1, 447 at P2), `2026-10-20-mcp-control`, `2026-10-13-command-surface`, `2026-10-18-referential-integrity`, `2026-10-26-musical-understanding` | Executed claims are cited, not re-executed here; HEAD has moved since (all P1 fixes re-verified at source) |
| E2 | Human UI action inventory | 20 UI domains from actual handlers/shortcuts/menus → ~350 canonical actions, every row with file:line | Line numbers from a moving tree; interaction *feel* (drag ergonomics) not assessed |
| E3 | MCP surface trace | All 39 tools: schemas, ops, routing, gates, receipts; dispatch pipeline read at `tools.ts:4327-4742` | Static; no live tool call was made |
| E4 | Command-contract audit | `src/commands/*`, `src/store/ProjectStore.ts`, units/addressing/clamping/no-ops/errors/dry-run/idempotency/referential integrity | Dev-mode round-trip verification not exercised at runtime |
| E5 | Safety & observation sweep | lattice, scope/stale guards, transports, audit log, all `kyx_state` subjects, meter/render/diagnosis/verification modules | Meter/DSP values unmeasured; transport numbers read from code, not probed |
| E6 | Intent-engine sweep | 28-stage route chain, compound atomicity, model-fallback gates, generation/mix-idea/song commit paths, learning-vs-action separation | Model-fallback paths traced statically; no local model was invoked |
| E7 | Direct verification (this session) | lattice decision order (`permissionLattice.ts:136-167`), no-op guard (`ProjectStore.ts:331-338`), full `kyx_clips` op enum (no `add`), text-first five, all 15 D4 gate sites, mirror sync via git history, six UNKNOWN-cell resolutions | Read-only greps/sed — no test execution |

What this audit **did not do** (and therefore does not claim): no live MCP round-trip, no UI automation, no audio render or listening, no test execution, no device/recording behavior. Runtime claims rest on the cited committed tests and the executed evidence in the 10-24 audit.

**Evidence limits:** HEAD moved during the audit window (concurrent sessions are normal here). All citations were taken at the observed revision; the load-bearing ones were re-verified directly (E7).

---

## 3. Human action taxonomy (the denominator)

Derived from real handlers, shortcuts, menus and command dispatch sites — not docs. **Undoable** = dispatches through `ProjectStore.execute` (`src/store/ProjectStore.ts:288`; inverse-patch undo stack, 256 entries). Full ID-level inventory (~350 rows with file:line evidence) was compiled during this audit; the per-domain rollup below carries every action ID so the matrix in §6 is complete.

| Domain | Mutation actions | IDs | Notes |
| ------ | --------------- | --- | ----- |
| Project lifecycle | 17 | H-PRJ-NEW-TEMPLATE, NEW-SONG-STARTER, LOOP-DEMO, OPEN, IMPORT-FILE, TRANSFER-DAW, DUP-LIB, RENAME-LIB, DELETE-LIB, RECOVER, SAVE-NOW, SAVE-COPY, SNAPSHOT-SAVE/RESTORE/DELETE, RENAME-OPEN, KEY-SCALE | Persistence-class ops are not undoable; RENAME-OPEN and KEY-SCALE are |
| Transport | 17 | H-TRN-PLAY, STOP, SEEK-HOME, SEEK-BAR, SEEK-CLICK, TRANSIENT-NAV, MODE, REWIND, LOOP-TOGGLE, LOOP-LOCATORS, COUNT-IN, PREROLL, METRONOME, TEMPO, TAP-TEMPO, UNDO-REDO, HISTORY-JUMP | Realtime; TEMPO/TAP-TEMPO/UNDO-REDO are document/history |
| Recording | 27 | H-REC-MIDI-ARM/MODE/QUANTIZE/QSTRENGTH, CAPTURE-LAST, CAPTURE-SESSION, AUDIO-ARM/START/STOP/CANCEL-START/CHANNELS/TAKE-MODE/LOOP-PASSES/PUNCH/DEVICE/IND-STREAMS/MONITOR/GAIN/CLIP-CLEAR, TAKE-RECOVER, TAKE-DISCARD, RESAMPLE, CHOP, HUM, STEPENTRY | All realtime/device-gated; commit points are undoable |
| Timeline clips | 32 | H-CLP-PLACE, MOVE, RESIZE, TRIM-START, NUDGE, LENGTH-SECS, DUPLICATE, COPY, CUT, PASTE, GROUP, UNGROUP, LOCK, MUTE, DELETE, DELETE-RANGE, DUP-RANGE, CONSOLIDATE, SPLIT, CUT-TOOL, BOUNCE-KEYS, BOUNCE-ZONE, LOCATORS, XFADE, MARKER-ADD, MARKER-DELETE, TRANSITION, VARIANT, LOOP, DEL-GAP, PRODUCER-TEXT | All undoable |
| Audio clips | 25 | H-AUD-MOVE, RESIZE, STRETCH-DRAG, TRIM-START, SLIP, FADES, GAIN-DRAG, FADE-CURVE, CHANNEL, REVERSE, LOOP, WARP-PIN, WARP-EDIT, WARP-CLEAR, NORMALIZE, FIT-BPM, ALIGN, STEAL-GROOVE, FLIP, STRETCH-DLG, SLICE, STRIP-SILENCE, CONSOLIDATE, SPECTRAL, TAKE-AUDITION | All undoable (audition is realtime) |
| MIDI clips | 6 | H-MCL-ADD, MOVE, RESIZE, TRIM, EDIT, MENU-OPS | All undoable |
| Tracks | 17 (+1 view) | H-TRK-CREATE, RENAME, DUPLICATE, DELETE, MOVE, MUTE, SOLO, GAIN, PAN, COLOR, GROUP-ROUTE, GROUP-FOLD, SEND, RETURN-ADD, RETURN-GAIN, CLEAR-STATE, FREEZE | All undoable |
| Mixer batch | 3 | H-MIX-BATCH-ADD/BYPASS/REMOVE | Undoable |
| Drum steps | 17 | H-STP-TOGGLE, PAINT, VELOCITY, MICRO, PROB, AMOUNT, PLOCK-EDIT, LOCK-PASTE, LOCK-CLEAR, VEL-RND, VEL-HUMAN, PAD-MUTE, PAD-SOLO, PAD-SAMPLE, PAD-REPEAT, PAD-RATE, PAD-SYNTH, PAD-SLICE | Undoable except realtime pad repeat/rate |
| Patterns | 19 | H-PAT-SELECT, RENAME, REORDER, ADD, DUP, MUTATE, FILL, GEN, IMPORT-MIDI, PASTE, CLEAR, DELETE, LENGTH, QUANTIZE-GRID, QUANTIZE-SCALE, GROOVE, VARY, FILL-ASSIST, DICE | All undoable |
| MIDI notes | 24 | H-NOTE-DRAW, MOVE, RESIZE, DUP-DRAG, VEL-DRAG, DELETE, NUDGE-KEYS, STEPENTRY, QUANT, QUICK-QUANT, VEL-RND, VEL-HUMAN, DUP, SPLIT, GLUE, DELETE-SEL, TRANSFORM (9 ops), VEL-STEP, PASTE, EXPRESSION, SLIDE, SLIDE-NOTE, LEGATO, CHORD-STAMP | All undoable |
| FX devices | 14 (+1 view) | H-FX-ADD, CHAIN, REORDER, BYPASS, RESET, REMOVE, PARAM, PRESET, MACRO-PARAMS, SIDECHAIN, STEPS, AB, IR, INTENT | All undoable |
| Automation | 23 | H-AUT-LANE-ADD/REMOVE/COPY, POINT-ADD/MOVE/DELETE, LFO-ADD/PARAM/REMOVE, ACLIP-CREATE/MOVE/RESIZE/POINTS, MACRO-RENAME/VALUE/MAP/AMOUNT/UNMAP/CC, SCENE-INTENSITY, SCENE-CURVE, SCENE-BPM, SCENE-AUTO | All undoable |
| Scenes/chords | 14 (+1 view) | H-SCN-CREATE, DUP-PATTERN, VARIATION, RENAME, DELETE, REORDER, ROLE, ROLE-VARIATION, VARY-LIVE, SKELETON, AUTO-ARRANGE, CHORD-GEN, CHD-ADD, CHD-EDIT, LAUNCH | Undoable except LAUNCH (realtime) |
| Performance/live | 9 | H-PRF-LIVESET-CREATE/CONFIG, PAD-ASSIGN, PAD-LAUNCH, MACRO, JAM-KEYS, LINK, MTC-CHASE, PCM | Mixed: set/config/assign undoable; the rest realtime |
| Master bus | 12 | H-MST-GAIN, CEILING, TRIM, TILT, LIMITER-MODE, LIMITER-TIMING, LIMITER-TOGGLE, DELTA-LISTEN, CLIPPER, GLUE, TAPE, MS, BASS-MONO | Undoable via `setMasterConfig`; DELTA-LISTEN realtime |
| Export/delivery | 16 | H-EXP-CONFIG, ANALYZE, MASTER, VIDEO, STEMS, TRACKS, MIDI, SHARE, EMBED, GALLERY, SCOREPACK, ZYVO, PORTABLE, JSON, QVESTER, CANCEL, REPORT | File/network side effects; not undoable |
| Mastering | 7 | H-MAS-ANALYZE, AI-RENDER, AI-APPLY, REFERENCE, AUDITION, MIXFIX, AUTOSTAGE | Apply-class rows undoable |
| Library | 8 | H-LIB-IMPORT, FREESOUND, INSTALL-PACK, ASSIGN, ADD-LOOP, FAVORITE, TAGS, REMOVE, SFZ, PREVIEW | Asset-store class; ASSIGN is undoable |
| MIDI input | 2 | H-MIDI-ENABLE, DEVICE, LATENCY | Config + runtime |
| **Total** | **309** | | plus **40** view/context actions (selection, zoom, snap, panels, dock, theme, palette, devices panel) excluded from the denominator |

Calibration notes: fader-drag ≡ numeric entry (one action); toolbar ≡ context-menu duplicates merged; the 9 MIDI creative transforms are one row; limiter timing params are one row; clipboard steps counted only where the paste mutates. A coarser grouping (~150) collapses creative families — both views are given in §7 metrics.

---

## 4. AI tool/action registry (39 tools at HEAD)

Full catalog: `src/mcp/tools.ts:1609-3231`. 34/39 tools declare `outputSchema` (26 inline + 8 receipt envelopes injected at `tools.ts:3272-3275`); **text-first five: `kyx_generate`, `kyx_pattern`, `kyx_checkpoint`, `kyx_song`, `kyx_unsuno`**. Risk classes (`src/mcp/agentTrust.ts:50-94`): 3 read, 8 runtime, 7 destructive, 21 mutate, refined per-op by `effectiveRisk` (:111-188 — e.g. `kyx_tracks listPresets→read`, `remove→destructive`, `kyx_batch→riskiest child`).

| Tool | Ops → routing | Path class | Undo | Gates |
| ---- | ------------- | ---------- | ---- | ----- |
| `kyx_intent` | NL → `routeIntentText` → `buildIntentCommand` (`src/intent/command-for-route.ts`) | ctx.execute | 1 | destructive routes D4+checkpoint (`tools.ts:12894`); generation/save/export/record refused over MCP |
| `kyx_state` | 15 subjects (overview, tempo, key, tracks, mixer, sends, fxChain, markers, groove, pattern, scenes, model-misses, reference, automation, history, capabilities, projects) | read-only | n/a | none |
| `kyx_save` | save / saveAs(`confirm:true`, collab-refused) → `ctx.saveNow/saveAsProject` (`src/mcp/save-now.ts`) | host | none | no dry-run |
| `kyx_undo` | undo/redo ×1..20 | ctx | pops | mic-recording refusal; foreign-work needs `allowForeign` (`src/mcp/attribution.ts:65-69`) |
| `kyx_transport` | play/stop/pause/loop/metronome/seek/loopRegion/launchScene | host transport | none | no dry-run |
| `kyx_export` | wav/mp3/stems; `autofix` applies one undoable fix | host + ctx | autofix 1 | no dry-run, no batch |
| `kyx_audio_preview` | ≤4 bars rendered WAV attachment from cloned doc | host render | none | bounded |
| `kyx_generate` | pattern gen → `applyGenerationResultCommand` (`src/commands/aiPattern.ts:38-115`) | ctx | 1 | `replaceMode:"replace"` → D4+checkpoint (`tools.ts:5027`) |
| `kyx_groove` | more/less/tighter/set; section bake | ctx | 1 | — |
| `kyx_fx` | more/less/remove/bypass/enable/reorder; fxId preferred (F-06) | ctx | 1 | remove D4 (bare, `tools.ts:5496`) |
| `kyx_sections` | list/add/remove/duplicate/reorder/resize/intensity | ctx | 1 | remove D4+checkpoint |
| `kyx_markers` | list/add/rename/remove | ctx | 1 | remove D4 |
| `kyx_tracks` | addDrum/addInstrument/loadPreset/listPresets/duplicate/remove/rename/setGain/setPan/setMute/setSolo/move | ctx | 1 | remove D4+checkpoint |
| `kyx_pattern` | list/select | ctx | 1 | — |
| `kyx_steps` | add/remove/toggle/ghost/clearPad (velocity only on add/toggle) | ctx | 1 | — |
| `kyx_notes` | list/add/move/delete/setVelocity/quantize/transpose; noteId preferred | ctx | 1 | delete D4+checkpoint |
| `kyx_music` | setTempo/setKey/setPatternLength/transposeAll/setTimeSignature; verify-or-PARTIAL_FAILURE wrapper | ctx | 1 | — |
| `kyx_catalog` | effects/effect/instruments/instrument | read-only | n/a | — |
| `kyx_plugin_param` | list/set; native units; fxId + deep params (F-08) | ctx | 1 | — |
| `kyx_instrument_param` | list/set; exact trackId | ctx | 1 | — |
| `kyx_meter` | master/tracks/fx/all — live engine snapshot | read (live) | n/a | honest UNAVAILABLE without engine |
| `kyx_automation` | listTargets/addPoint/addRamp/movePoint/deletePoint/clearLane/removeLane; lane+point fold = ONE undo (F-29) | ctx | 1 | clear/removeLane D4 (bare) |
| `kyx_clips` | 24 ops: list/move/resize/duplicate/delete/split/×Ripple/copy/cut/paste + audioList/audioMove/Split/Update(gain,fades,reverse,loop,pitch)/Stretch/Slip/Crossfade/Duplicate/Mute/Nudge/Slice/Strip/Consolidate/Delete; clipId preferred, anchor-bar legacy | ctx | 1 | delete/cut/×Ripple/audioDelete D4 (bare) |
| `kyx_batch` | 1..10 calls; one undo frame; `atomic:true`; riskiest-child risk | ctx per call | 1 frame | no nested/no export/preview/loudness; dry-run preflight recurses |
| `kyx_loudness` | measure / match (render→trim→verify; command returned unexecuted) | host render + ctx | 1 | honest refusal without render hook |
| `kyx_import_sfz` | SFZ library import (user library + doc) | host + ctx | 1 | no dry-run (writes library) |
| `kyx_publish_gallery` | publish with `origin:"agent"` | host/network | none | no dry-run; hook availability is the only gate |
| `kyx_render_summary` | offline N+1 render: per-strip LUFS/peak/crest vs −14 LUFS | host render | none | render-bound |
| `kyx_diagnose_mix` | attributed findings → callable fixes | host render | fixes via tools | render-bound |
| `kyx_mix_idea` | plan (pure) / apply (ONE undo) / preview (render A/B + human lane) | ctx (apply) | 1 | preview no dry-run; honest `studioBound:false` on desktop-stdio |
| `kyx_checkpoint` | save/list/diff/restore/delete; LRU 8; durable persist | ctx (restore) | restore = 1 | save/delete no dry-run; restore not D4 (recovery-class) |
| `kyx_mix` | genre mix profile, add-if-missing, ONE undo | ctx | 1 | — |
| `kyx_arrange` | song-form layout (refused when clips exist) | ctx | 1 | — |
| `kyx_song` | full build (genre kit, sections, cues, master tilt) ONE snapshot; optional loudness 2nd step | ctx | 1 (+1) | refused when clips exist |
| `kyx_routing` | list/createGroup/addToGroup/removeFromGroup/setSend/setReturnGain/createReturn/removeReturn | ctx | 1 | removeReturn D4+checkpoint |
| `kyx_unsuno` | transcribe/restyle/regen/similarity; needs `ctx.loadSampleMono` (wired in both shipping hosts per 10-24 P1 follow-up) | ctx | 1 | honest headless refusal |
| `kyx_master` | add/preset/trim/assist/iterate/land/platform/stems/ab/remove/status (ZENIT chain) | ctx (+render) | 1 | remove D4+checkpoint; `iterate` needs renderMix (desktop-only) |
| `kyx_takes` | list/activate/deleteTake | ctx | 1 | deleteTake D4 (bare) |
| `kyx_blind_ab` | plan/record/verdict/reset; binomial p, haste filter | session state | none | reset needs `confirm:true` |

**Dispatch order** (`tools.ts:4327-4742`, verified): requestId validation + in-flight de-dup → `effectiveRisk` → **lattice** (stale-revision forbid → external-agent confirm → auto; `permissionLattice.ts:136-167`) → argument audits → **dry-run sandbox** (real commands on a throwaway doc chain; policy refusals for side-effect tools) → **idempotency replay** (original result + `current` state channel) → **session checkpoint** (first mutation of a 15-min session) → Job Center (90 s) → **stale-write guard + scope guard wrap** (per-field, `src/mcp/write-conflict.ts:53-79`) → dispatch → error mapping (13 typed codes, `tools.ts:3624-3637`) → **verified-mutation gate** → receipt (`stage`, `risk`, doc attribution) → idempotency commit → audit entry.

**Transports:** desktop-stdio (loopback bridge: token constant-time, 1 MB cap, 30/min token bucket, 10/60 s timeouts, all hooks incl. `renderMix`), web relay (token + 1 MB cap + 15/60 s timeouts, undo frames/loudness/SFZ/save/gallery wired, **no rate limiter on `/mcp`**, no `renderMix`), headless (test-only; mutation consent ON by design). Cancellation: **absent everywhere, declared absent** (`tools.ts:4056-4061`). Mirrors (`desktop/mcp-tool-defs.cjs`, `server/mcp-core.mjs`) **in sync** at HEAD (all three last touched by `58a2f8fa`; clean status).

---

## 5. Parity-matrix legend

Per action family: **H#** = human action count (from §3); **Disc** = AI discoverable via schemas/catalog/state; **Exec** = AI executable (YES / PARTIAL / NO / UNKNOWN); **Verif** = result checkable against authoritative state; **Prev** = preview/dry-run available; **Undo**; **L** = capability level (L0 human-only … L5 composable, per the audit brief); **Risk** = R0 read, R1 reversible edit, R2 broad/complex edit, R3 external/irreversible, R4 live-critical.

Levels are assigned conservatively: L4 requires concrete gate/receipt/undo evidence (exists for the ctx.execute surface via the dispatch chain); L5 additionally requires multi-step evidence (`kyx_batch` tests + checkpoints + dry-run, cited). Render-bound tools cap at L3 (their verification is the render receipt, not the audio itself).

---

## 6. Human–AI capability parity matrix (complete, family-level)

| Family | H# | AI entry points | Disc | Exec | Verif | Prev | Undo | L | Risk | Evidence |
| ------ | -- | --------------- | ---- | ---- | ----- | ----- | ---- | - | ---- | -------- |
| **Project lifecycle** | 17 | `kyx_save` (save/saveAs), `kyx_music setKey`, `kyx_checkpoint` (analog of snapshots) | PARTIAL | YES 3 / PARTIAL 3 / NO 11 | stage:"persisted" only after flush (10-24 F-12 fix); open/new/import NO | no | saveAs n/a; key yes | L4 (save), L0 (open/new/import/transfer) | R1/R3 | `tools.ts:4841-4913`; `src/mcp/save-now.ts:9-52`; capabilities block `tools.ts:4025-4062` |
| **Transport** | 17 | `kyx_transport` (play/stop/loop/metronome/seek/loopRegion/launchScene), `kyx_music setTempo`, `kyx_undo` | YES | YES 13 / NO 4 (mode, count-in, preroll, transient-nav, history-jump) | state read-back; runtime-only (no doc) | n/a | n/a | L4 (runtime) | R4 (live) | `tools.ts:3725-3872`; launch scene bar-quantized |
| **Recording** | 27 | none — `unavailableByDesign` | NO (declared) | NO 27 | n/a | n/a | n/a | L0 intentional | R4 human-only | `tools.ts:4030-4040`; refusal `tools.ts:12810-12812` |
| **Timeline clips (scene)** | 32 | `kyx_clips` (move/resize/duplicate/delete/split/ripples/copy/cut/paste), `kyx_markers`, `kyx_transport loopRegion`, `kyx_intent` clip/arrange wording | YES | YES 13 / PARTIAL 2 / NO 17 — **no `add` op**; no group/lock/variant/transition/loop/range ops | clipId read-back + structural diff | dryRun | yes | L4 | R1/R2 (delete D4) | op enum verified `tools.ts:2560-2585`; F-07 clipId fix |
| **Audio clips** | 25 | `kyx_clips audio*` (13 ops) | YES | YES 14 / PARTIAL 4 (slice/strip need segments; consolidate needs pre-rendered bufferId; pitch via audioUpdate) / NO 7 (resize, trim-start, warp pins, normalize, fit-BPM, channel, spectral) | clipId read-back | dryRun | yes | L4 | R1/R2 | `tools.ts:2529-2560`; F-06/F-07 fixes |
| **MIDI clips** | 6 | none (no midi ops in `kyx_clips`) | NO | NO 6 | n/a | n/a | n/a | L0 accidental | — | op enum verified — no `midi*` ops |
| **Tracks** | 17 | `kyx_tracks` (11 ops), `kyx_routing` (group/send/returns), `kyx_instrument_param` | YES | YES 12 / PARTIAL 1 (create lacks generative/group kinds — group via routing) / NO 4 (color, fold, clear-state, freeze) | mixer snapshot read-back; move returns slots | dryRun | yes | L5 | R1/R2 (remove D4) | `tools.ts:5794-6023`; `tools.ts:9081+` |
| **Mixer batch FX** | 3 | `kyx_intent`/`kyx_mix` family targeting (indirect) | PARTIAL | PARTIAL 1 / NO 2 | read-back per family | dryRun | yes | L2 | R2 | no direct batch-add/bypass/remove op |
| **Drum steps** | 17 | `kyx_steps` (add/remove/toggle/ghost/clearPad) | YES | YES 5 / NO 12 (velocity edit of existing steps, micro, prob, amount, p-locks ×3, vel-rnd/human, pad mute/solo/sample/synth/slice) | before→after step-count read-back | dryRun | yes | L4 | R1 | `tools.ts:2164-2186` (velocity only on add/toggle — verified) |
| **Patterns** | 19 | `kyx_pattern` (list/select), `kyx_generate`, `kyx_groove`, `kyx_music` (length/transposeAll) | YES | YES 6 / NO 13 (clear — verified unreachable from MCP/intent; vary/assist routes — selection-scoped in-app only; rename/reorder/dup/mutate/fill/import/paste/delete/quantize-grid/quantize-scale, dice) | pattern read-back | dryRun; generation preview refused over MCP (needs in-app audition) | yes | L4 | R1/R2 (replace D4) | `tools.ts:6024-6058`, `5019-5073`; clear/vary/role verified unreachable by grep (§7) |
| **MIDI notes** | 24 | `kyx_notes` (list/add/move/delete/setVelocity/quantize/transpose) | YES | YES 7 / NO 17 (resize, transforms ×9, glue, split, dup, paste, expression, slide, legato, chord-stamp, rnd/human) | committed note read-back; honest clamp PARTIAL_FAILURE | dryRun | yes | L4 | R1 (delete D4) | `tools.ts:6148-6699`; clamp receipt `tools.ts:6369-6433` |
| **FX devices** | 14 | `kyx_fx`, `kyx_plugin_param` (native units, deep params), `kyx_catalog`, `kyx_intent` effect/preset routes, `kyx_fx` add only via intent/mix add-if-missing | YES | YES 6 / PARTIAL 3 (add indirect; macro deep params; preset via intent) / NO 5 (reset, sidechain, step-gate, A/B, IR) | per-param before/requested/committed; DSP-verified for tone/width/level classes | dryRun | yes | L5 | R1/R2 (remove D4) | `tools.ts:1937-1970`; F-06/F-08 fixes |
| **Automation** | 23 | `kyx_automation` (lanes/points/ramps), `kyx_sections intensity` | YES | YES 5 / NO 18 (incl. macro value — `setMacroValue` has zero MCP/intent references, verified; LFO ×3, automation *clips* ×4, macro map/amount/unmap/cc/rename ×5, scene curve/bpm/automation ×3, lane-copy) | lane read-back; single undo fold | dryRun; automationPlan = structured dry-run proposal | yes | L4 | R1/R2 | `tools.ts:8107-8400`; F-29 fold |
| **Scenes/chords** | 14 | `kyx_sections` (list/add/remove/duplicate/reorder/resize/intensity — **no role op**; role only targets add/edits, verified enum `tools.ts:3031`), `kyx_transport launchScene`, `kyx_arrange`, `kyx_song` | YES | YES 7 / NO 7 (role set — verified absent from op enum; chord-gen — `generateChordProgression` unreachable; rename, dup-pattern-copy, role-variation, skeleton, chord add/edit) | scene read-back; arrange refused over clips | dryRun | yes | L4 | R1/R2/R4 (launch) | `tools.ts:10959+` |
| **Performance/live** | 9 | `kyx_transport launchScene` only | PARTIAL | YES 1 (counted in scenes) / NO 9 (live sets ×2, pad assign/launch, macro, jam, Link, MTC, PCM) | scene state read-back | n/a | n/a | L0 accidental (except launch) | R4 | no live-set/pad surface exists |
| **Master bus** | 12 | `kyx_master` (add/preset/trim/assist/…), `kyx_loudness`, `kyx_export autofix` | YES | YES 2 / PARTIAL 4 (device add/preset cover limiter/clipper/glue/tape families; gain/trim; tilt via intent) / NO 6 (ceiling, limiter timing/mode, delta-listen, ms, bass-mono as direct params) | master commands read-back; loudness measured | dryRun (except render) | yes | L3–L4 | R1/R2 | `tools.ts:11416+` |
| **Export/delivery** | 16 | `kyx_export` (wav/mp3/stems), `kyx_publish_gallery`, `kyx_render_summary` (analyze/report) | YES | YES 6 / NO 10 (video, midi, share, embed, scorepack, zyvo, portable, json, qvester, cancel) | duration/size/mix-check receipt; publish id; LUFS verdict | no (dry-run refused for side effects) | n/a | L3 (render-bound), R3 for publish/export | `tools.ts:6708-6966` |
| **Mastering** | 7 | `kyx_master assist/iterate/land/platform`, `kyx_loudness`, `kyx_diagnose_mix`, `kyx_mix_idea`, `kyx_blind_ab` | YES | YES 5 / PARTIAL 2 (reference needs audio import — NO; audition via blind_ab + preview) | measured LUFS before/after; iterate render loop | preview (mix_idea) | yes (apply class) | L3 | R1 | `tools.ts:6803-7203`; `src/mcp/master-iterate.ts` |
| **Library** | 8 | `kyx_import_sfz` | PARTIAL | YES 1 / NO 7 (audio import declared unavailable; assign/add-loop/favorite/tags/remove/preview) | import report | no | partial | L2 | R3 (user library write) | `tools.ts:6863-6920` |
| **MIDI input** | 2 | none | NO | NO 2 | n/a | n/a | n/a | L0 intentional (device) | R3/R4 | — |

**AI-only capabilities with no exact human-row equivalent** (additions, not parity gaps): `kyx_batch` compound execution, `kyx_checkpoint` durable session snapshots, `kyx_state subject:projects` library listing, `kyx_blind_ab` statistical trials, `kyx_audio_preview` render attachments, `kyx_takes` take management, envelope-scoped writes (allow/protect), idempotent replays with `current`-state channel.

---

## 7. Coverage metrics

Denominator: **309 canonical mutation-class actions** (§3). View/context actions (40) excluded — they mutate nothing by design.

| Metric | Count | % of 309 |
| ------ | ----- | -------- |
| Agent-exposed & fully executable (**YES**) | **103** | **33.3%** |
| Partially executable (right command, missing units/primitives/hooks) | 20 | 6.5% |
| UNKNOWN (insufficient evidence) | **0** (all 6 candidate cells resolved by direct enum/grep verification during the audit) | 0% |
| No AI path (**NO**) | 186 | 60.2% |
| — of which **intentionally restricted** (declared in capability block or device-gated: recording 27, project open/new/import/transfer 10, audio import + hardware/perf surfaces ≈ 8) | ≈45 | ≈14.6% |
| — of which **accidental coverage gaps** | ≈141 | ≈45.6% |

Layer distribution of the exposed surface: document mutations (≈75 actions) sit at **L4–L5** (gates, receipts, undo, batch/dry-run/idempotency all evidenced); render-bound analysis/export (≈20) at **L3**; runtime transport at **L4-runtime** (state read-back, no doc claim); the intentional L0 set is ≈45. Workflow-weighted view: the AI covers composition→mix→verify→deliver strongly (the highest-frequency loop: generation, arrangement editing, mixing, mastering, export ≈ 80% of that loop's steps), while record→comp→sound-design depth is 0–40%. Raw counts are not hidden by this weighting — both are reported.

Coarser denominators for comparability: collapsing creative families per §3 notes gives ≈150 actions, of which ≈80 fully exposed (**≈53%**) — the headline is sensitive to family granularity, which is why the ID-level table above is the source of truth.

---

## 8. Action-contract findings

**Strong (verified):**

1. **Uniform command shape with inverse-patch undo** — `Command {execute, undo, base?, ops?}` (`src/commands/types.ts:4-48`); `snapshot()` derives both deltas (`core.ts:34-72`); dev builds verify round-trip; no-op = same document reference = no history entry (`ProjectStore.ts:331-338`, verified).
2. **Closed machine-readable error taxonomy** — 13 typed `McpErrorCode`s with documented recovery actions (`tools.ts:3598-3646`); every error carries `errorCode`; command throws map to `EXECUTION_FAILED`/`WRITE_CONFLICT`/`POLICY_REFUSED` at the boundary.
3. **Per-field stale-write detection** — the command's own `base`+`ops` travel to the write site; each written path is compared against the live document *inside* `command.execute` (`write-conflict.ts:53-79, 138-152`); refusal leaves no history residue; `force:true` is the explicit bypass.
4. **Honest clamping at the MCP boundary** — out-of-range asks that clamp are reported as `PARTIAL_FAILURE` with "committed X" (`tools.ts:6369-6433`); `kyx_clips` pitch rejects instead of clamping.
5. **Idempotency with a second channel** — canonical-JSON SHA-256 signature (`tools.ts:4226-4253`); replays return the original outcome **plus** `current` describing what holds now (`tools.ts:3657-3666`).
6. **Referential integrity is audited and pinned** — delete commands prune markers/sidechain/targets; `normalizeProject` dedupes ids and clears dead links; 40-spec falsification harness (`tests/referential-integrity.test.ts`).

**Weak (verified):**

1. **Duplicated range constants** — track gain 0..1.5 re-typed in ≥5 files (`commands/project.ts:328`, MCP schema ×4 `tools.ts:718,745,2128,3066`, UI `Mixer.tsx:844`, bridge `executor.ts:1009` — whose comment records the earlier 0..4 drift); dB −60..+3.5 three copies in one file; master 0..2 re-derived in `intentRouting.ts:169`; BPM re-declared in `Transport.ts:10` despite exported constants; PPQ literal at `tools.ts:6362`. No exported GAIN_RANGE/BPQ constants.
2. **Mixed conventions in one surface** — `startBar` is "1-based" in `kyx_sections`/`loopRegion` prose but "project-model 0-based" in the arrangement clips schema (`tools.ts:570` vs `tools.ts:538`); `kyx_notes` takes beats with a hardcoded PPQ conversion while commands take ticks; two velocity floors (addNote 0..1, setNoteVelocity 0.05..1).
3. **Guard coverage is by convention, not enforcement** — stale-write/scope/idempotency written-field tracking read `command.ops`; hand-written commands (e.g. raw `setTrackParams`) carry none. The MCP layer wraps its writes in `snapshot()` commands today (`tools.ts:6019`), so the shipped surface is covered — but nothing fails when the next tool forgets to wrap (ADR 0065 itself lists this class of risk).
4. **Text-first five** break the structured-receipt contract for exactly the generative/recovery family (`kyx_generate/pattern/checkpoint/song/unsuno`).
5. **Transport-dependent NL parity** — `kyx_intent` refuses `loudness/mix/sectionProduction/sectionFlow/complaint/select` routes over MCP (`tools.ts:12899-12911`); the same sentence works in the UI. Honest, but it means parity is per-transport and only partially advertised.
6. **7 of 15 D4 sites skip the auto-before checkpoint** — `kyx_fx remove`, `kyx_automation clear/removeLane`, `kyx_clips cut/delete/×Ripple/audioDelete`, `kyx_takes deleteTake` use the bare `ctx.allowDestructive` check (verified sites at `tools.ts:5496, 8369, 8604, 8831, 9017, 9049, 9693`), while removals in tracks/notes/sections/master/routing/intent/generate get `destructiveAllowedWithCheckpoint` (7 sites + helper at `7890-7894`). Session checkpoints still apply; the per-op snapshot asymmetry is real.

---

## 9. Safety & authorization matrix (R0–R4)

| Class | Definition | Exposed set | Current protections (verified) | Recommended policy |
| ----- | ---------- | ----------- | ------------------------------ | ------------------ |
| **R0** read-only | inspect without mutation | `kyx_state`, `kyx_catalog`, `kyx_meter`, read ops via `effectiveRisk` | always `auto`; honest refusal when engine absent | **auto-read** — correct as implemented |
| **R1** reversible local edit | bounded undoable change | fader/pan/mute/solo, notes, steps, params, markers, scenes, automation points | lattice confirm for external agents (default OFF), verified receipts, undo, idempotency, stale-write refusal, dry-run | **preview-first for first call of a session, then auto** — dry-run is already free; consider auto-allow after a clean preview |
| **R2** complex/broad edit | multi-object or content-replacing | `kyx_batch`, `kyx_mix`/`kyx_song`/`kyx_arrange`, `kyx_generate replace`, ripple edits, lane clears | riskiest-child risk, one-undo-frame, `atomic:true`, auto-checkpoints on some (AS-004), destructive gate | **explicit confirmation + auto-checkpoint on every destructive op** (close the bare-gate asymmetry) |
| **R3** external/irreversible | file write, network publish, user-library write | `kyx_export`, `kyx_publish_gallery`, `kyx_import_sfz`, `kyx_save saveAs` | dry-run refused by policy ("a dry-run cannot un-write a file"), hook-gated, `confirm:true` for saveAs; publish has **no confirm flag** — hook availability is the only gate | **explicit confirmation for publish**; keep export/publish out of `kyx_batch` (already refused) |
| **R4** live-critical | transport, scene launch, monitoring, recording | `kyx_transport` (play/stop/seek/launchScene) | bar-quantized scene launch; transport never touches the doc; undo refused during mic recording (`tools.ts:4918-4920`) | **restricted execution** — fine as-is; keep recording human-only |

Cross-cutting protections verified: audio-thread isolation (mutations only via `onDocChanged → engine.setProject`, `services.ts:1291-1307`; meters are main-thread AnalyserNode reads; renders on `OfflineAudioContext`); foreign-work undo consent (`attribution.ts:65-69`); content-free audit log (200 entries, 48-char scalar truncation, no payloads — only project names are stored); scope declaration (allow/protect delta paths, enforced pre-write); stale-revision forbid before consent (`permissionLattice.ts:139-150`).

Gaps: web `/mcp` has no rate limiter (desktop: 30/min); per-call identity is transport-level (`web-relay`/`desktop-stdio`), not per-agent; standing consent is per-window, not per-call; no cancellation (declared); `kyx_checkpoint delete` is not D4-gated (repo hygiene, defensible).

---

## 10. Multi-step workflow feasibility

| Workflow | Supported steps | Missing / risky | Rollback story | Verdict |
| -------- | --------------- | --------------- | -------------- | ------- |
| Create track → generate → mix → save | all steps exposed (`kyx_tracks`, `kyx_generate`, `kyx_mix`, `kyx_save`) | create lacks generative/group kinds; saveAs needs confirm | batch undo frame + session checkpoint + `kyx_undo` | **Feasible L5** (evidenced by `tests/mcp-headless-acceptance.test.ts` class flows) |
| Edit arrangement clip-by-clip | move/resize/split/delete/ripple/copy/paste + audio ops | **cannot add a new clip**; no MIDI-clip ops; no range duplicate/consolidate | per-op undo; ripple folds | **Feasible only on existing material** |
| Add effect → A/B → undo | intent/kx_mix add, `kyx_plugin_param`, `kyx_render_summary` before/after, `kyx_blind_ab`, `kyx_undo` | effect *preset* load only via NL; no per-device A/B slots | one-undo per step; blind_ab is session-state | **Feasible L5 — the strongest loop in the product** |
| Routing chain with sends | `kyx_routing` groups/sends/returns, `kyx_state sends` verification | no cycle check needed (flat group model); no return FX-chain builder beyond master | undo per op | **Feasible L4** |
| Automation curve → preview → apply → revert | `kyx_automation` points/ramps; `automationPlan` route returns structured **dry-run proposal**; lane+point = one undo | no curve editor (segments/shapes); no automation clips | single-snapshot fold (F-29) | **Feasible L4** |
| Record take → stop → recover | **none of record/arm/monitor**; `kyx_takes` manages takes only after the fact | recording intentionally human-only | n/a | **Not feasible by design** |
| Live scene change with approval | `kyx_transport launchScene` (bar-quantized), `kyx_sections intensity` | no live sets/pads/macros | runtime-only (no doc claim) | **Feasible for scenes; L0 for pad performance** |

Race-condition posture: stale-write guard refuses writes computed against an older document field; revision declaration (envelope `projectRevision`) forbids whole plans computed against stale revisions; collab sessions refuse saveAs; undo during recording is refused. Remaining race: human edits between an agent's read and write are caught **only** for snapshot-carrying commands (§8.3).

---

## 11. AI control vs AI understanding

- **Action space** (§6): 103 fully + 20 partially executable mutations across 10 domains; depth-concentrated in mix/FX/tracks, depth-starved in performance/notes/steps nuance.
- **Observation space** (§5-B): 15 `kyx_state` subjects, live meters (master true-peak/LUFS/correlation, per-track, per-FX telemetry), offline render evidence (per-strip LUFS vs −14 LUFS), mix diagnosis with attributed findings, intent read-backs, capability discovery including honest `unavailableByDesign` and `cancellation:false`.
- **Musical intelligence**: the deterministic router + gated local-model fallback choose *plausible* changes (grammar-constrained decoding, abstain-on-uncertainty, executability gate, clamp/role rules a model cannot bypass — `model-route-gate.ts:144-166`); taste adaptation exists but only reorders candidates (`reaction-learning.ts:33-35` — "nothing here learns from audio content"). Whether the choices are *good* is the separate musical-understanding audit (2026-10-26, 15 gaps).
- **Verification space**: three tiers exist and are honestly labeled — document read-back (structural diff, always), measured DSP read-back (param classes: tone/width/level/crest; `param-readback.ts:153-220`, browser-gated), and human-verdict tools (`kyx_blind_ab`, mix-preview lane with `studioBound:false` honesty). The unmeasurable cases degrade to "knob moved, not measured" instead of false confirmation.

---

## 12. Adversarial failure analysis

| Attack/failure | Expected safe behavior | Evidence |
| -------------- | ---------------------- | -------- |
| Hallucinated object id | typed `UNKNOWN_TARGET`, no mutation | error taxonomy `tools.ts:3624-3637`; commands throw at factory (`project.ts:322`, `notes.ts:231`) |
| Ambiguous track names | family regex + explicit-track preference; intent clarifies rather than fans out | `tools.ts:8026-8102`; selected-track single-target rewrite (10-24 P2) |
| Out-of-range values | clamp-with-receipt (`PARTIAL_FAILURE`) or reject (`kyx_clips` pitch) | `tools.ts:6369-6433` |
| Conflicting user edit mid-plan | per-field `WRITE_CONFLICT` + revision-declare forbid | `write-conflict.ts:138-152`; `permissionLattice.ts:139-150` |
| Duplicate/retried call | in-flight 409 `REQUEST_ID_CONFLICT`; replay returns original + `current` | `tools.ts:4327-4369, 4512-4557` |
| Partial batch failure | per-call results, `atomic:true` halts, single undo frame | `tools.ts:9784-9868` |
| Plugin unavailable / reopened project | catalog-driven validation; honest refusals; model gate re-binds to installed instances | `model-route-gate.ts:115-133` |
| Undo after compound edit | one inverse patch reverts the whole compound; foreign-work consent | `compound.ts:120-149`; `attribution.ts:65-69` |
| Project close / device loss mid-op | Job Center 90 s + transport timeouts stop *waiting*; **work continues** (no cancellation) — the declared residual risk | `tools.ts:4056-4061` |
| Large action sequences | batch cap 10; audit log FIFO 200; idempotency ledger 256 | `tools.ts:4110, 4131` |
| MCP disconnect / version mismatch | relay session ownership (close 4409); manifest-gated models (candidate artifacts never activate) | `server/mcp-core.mjs:6034-6106`; `model-loader.ts:29-34` |
| Agent claims success with no change | R-02 rewrites to `mutated:false / status:"unchanged"` + forced read-back | `verified-mutation.ts:126-139` |

---

## 13. Top 15 AI action-space gaps

Format: each finding carries priority, evidence type, and the mandatory fields compactly.

**[AS-001] No arrangement-building primitive: `kyx_clips` cannot add a clip, and MIDI clips have no surface at all** — P1.
Confidence/evidence: Verified in code (op enum read at HEAD).
User workflow: "put a 4-bar variation here", "copy this chorus to bar 33 as MIDI".
Human path: +CLIP button, drag, MIDI-lane + button (`ArrangementPanel.tsx:4753-4760`, `MidiClipLanes.tsx:334-364`).
AI path: none — 24 scene/audio ops only; `kyx_arrange`/`kyx_song` replace whole arrangements and refuse over existing clips.
Observed gap: an agent can edit any clip but can only *create* material via whole-song builders; incremental arrangement is impossible.
Impact: blocks the highest-frequency compositional loop; forces destructive all-or-nothing workflows.
Minimal recommendation: add `kyx_clips add {trackId, sceneId|patternId, startBar, lengthBars}` and a minimal midi-clip family (add/move/resize/delete) reusing `addArrangementClip`/`moveMidiClip` commands.
Alternatives: keep builders-only (safer but caps autonomy); expose via `kyx_intent` clip-add wording only (weaker contract).
Acceptance: MCP add → clip visible in `kyx_clips list` with id; undo removes it; D4 not required (pure add).
Regression checks: engine-graph census; arrangement DOM census; seam-manifest entry for the new seam.

**[AS-002] Piano-roll parity cliff: no resize/glue/split/duplicate/expressions/transforms over MCP** — P1.
Confidence/evidence: Verified (kyx_notes op set vs §3 note rows).
User workflow: "lengthen that pad note to a full bar", "duplicate the hook an octave up".
Human path: PianoRoll handlers (`PianoRoll.tsx:1169-2277`).
AI path: `kyx_notes` add/move/delete/setVelocity/quantize/transpose only (7 of 24).
Observed gap: note *duration* cannot be changed after creation; the 9 creative transforms and expression lanes are unreachable.
Impact: melodic editing — the core of "produce, not just generate" — stops at note placement.
Minimal recommendation: `kyx_notes resize` (stable noteId, ticks), then transforms in priority order (duplicate, glue, split).
Acceptance: read-back shows committed duration; honest clamp receipt on grid edges.
Regression: intent-router corpus; mcp-notes-music tests.

**[AS-003] Sequencer expressive layer unreachable: no velocity edit of existing steps, no microtiming/probability/p-locks** — P1.
Confidence/evidence: Verified (schema: velocity exists only on add/toggle, `tools.ts:2180-2182`).
User workflow: "ghost the hats", "swing the 16ths", "lock a pitch rise across the snare row".
Human path: Sequencer drag gestures (`Sequencer.tsx:488-981, 2090-2146`).
AI path: `kyx_steps` add/remove/toggle/ghost/clearPad (5 of 17).
Observed gap: groove nuance — the thing grooves are made of — is human-only.
Minimal recommendation: `kyx_steps setVelocity` + `setMeta` (probability/amount) reusing `setStepsVelocity`/`setStepMeta`; p-locks later.
Acceptance: read-back shows before→after velocity/probability per cell.
Regression: steps tests; seam manifest.

**[AS-004] Destructive-gate checkpoint asymmetry: 7 of 15 gate sites skip the per-op auto-checkpoint** — P2 (safety consistency).
Confidence/evidence: Verified (all 15 sites read at HEAD; listed in §8.6).
User workflow: agent deletes clips/clears automation lanes repeatedly in one session.
Human path: n/a (agent-only gate).
AI path: `kyx_fx remove`, `kyx_automation clear/removeLane`, `kyx_clips cut/delete/deleteRipple/audioDelete`, `kyx_takes deleteTake` use bare `ctx.allowDestructive` (no `auto-before-<tool>` checkpoint), unlike tracks/notes/sections/master/routing/intent/generate.
Observed gap: recoverability relies on the session checkpoint (≤15 min old) instead of a fresh pre-op snapshot.
Impact: a long session's later destructive ops revert to an older state than necessary.
Minimal recommendation: route the 7 bare sites through `destructiveAllowedWithCheckpoint` (mechanical, one-line each).
Acceptance: audit entry shows `checkpoint` on every destructive call; test asserting the parity of the two site lists.

**[AS-005] Recording, audio import, project open: intentional boundaries without a per-capability policy record** — P2 (policy clarity, not a defect).
Confidence/evidence: Verified declarations (`tools.ts:4030-4040`).
Observed gap: the capability block declares *what* is unavailable but the *why/when-to-revisit* lives in audit prose; future agents can't distinguish "forbidden" from "not yet".
Minimal recommendation: extend `unavailableByDesign` entries with `{reason, revisit}` fields; keep recording/open human-only, schedule audio-import behind a host file-picker handshake.
Acceptance: capability snapshot self-documents each boundary.

**[AS-006] Mixed addressing conventions in one tool surface (0- vs 1-based `startBar`, beats-vs-ticks, PPQ literal)** — P2.
Evidence: `tools.ts:538` vs `tools.ts:570`; `tools.ts:6362`.
Impact: an agent that reads one family and writes another can off-by-one the arrangement.
Minimal recommendation: one `BAR_CONVENTION` doc constant + schema descriptions generated from it; import PPQ.
Acceptance: grep shows single convention per field name; corpus test pins both families.

**[AS-007] Duplicated numeric range constants (gain ×5, master ×2, dB ×3, BPM ×3)** — P2.
Evidence: §8.1; the 0..4 drift is documented in `executor.ts:1004-1008`.
Impact: the next range change will be missed somewhere (it already happened once).
Minimal recommendation: export `GAIN_RANGE/MASTER_GAIN_RANGE/BPM_RANGE` from one module; replace literals; add a drift test.
Acceptance: `npm run drift:check`-style test greps for re-definitions.

**[AS-008] Guard coverage rides a convention (snapshot-wrapping), not an enforcement point** — P2.
Evidence: hand-written commands carry no `base/ops` (`types.ts:19`; `write-conflict.ts:56-57`); MCP currently wraps (`tools.ts:6019`).
Impact: a future tool that mutates via a raw command silently loses stale-write/scope/idempotency tracking.
Minimal recommendation: a dev-mode assertion in the dispatcher: a tool classified `mutatesProjectDocument` must produce a command with `ops` (or be explicitly exempt-listed).
Acceptance: a deliberately raw tool fails the dev assertion.

**[AS-009] No cancellation: timeouts stop waiting, work continues** — P2 (declared, by design today).
Evidence: `tools.ts:4056-4061`; no abort plumbing in any transport.
Impact: retry after timeout can duplicate external effects (publish/export are excluded from batch/idempotency for document mutations but have no cooperative abort).
Minimal recommendation: phase 1 — document retry etiquette per tool in output; phase 2 — cooperative abort for render-class hooks via `AbortSignal` through `renderProject`.
Acceptance: cancel a 60 s render; job shows cancelled; no orphan render promise.

**[AS-010] Web `/mcp` has no rate limiter and identity is transport-level** — P2.
Evidence: `collab-server.mjs:997-1026` (token + 1 MB cap only) vs `mcp-bridge-server.cjs:27-28,130-142`; attribution `bridge.ts:189`.
Impact: a runaway web client can hammer the renderer; audit log cannot distinguish two agents on the same relay.
Minimal recommendation: port the desktop token bucket to `/mcp`; accept an optional `agentId` envelope field (feeds `isExternalAgent` + audit).
Acceptance: 31st request in a minute gets 429 with typed error.

**[AS-011] Five text-first tools break the receipt contract for generative/recovery families** — P2.
Evidence: verified (§4).
Impact: `kyx_generate/song/unsuno/checkpoint/pattern` results can't be machine-validated — exactly the tools agents most need structured receipts from.
Minimal recommendation: apply the existing `RECEIPT_SCHEMAS` injection (8 tools already use it) to the five.
Acceptance: outputSchema present; mirror regen; family tests assert structured fields.

**[AS-012] Observation gaps for sound design: warp pins, take audition, sample PCM analysis, meter history** — P2.
Evidence: no MCP op touches warp markers; `kyx_unsuno transcribe` is the only PCM-in path (needs user-sample); meters are instantaneous.
Impact: the agent cannot *see* why a clip sounds off (it can read levels, not transients/timing).
Minimal recommendation: expose onset-grid + warp-marker read in `kyx_clips audioList`; add transient/beat-phase to `kyx_render_summary`.
Acceptance: `audioList` includes warp pins; render summary includes beat-phase offset.

**[AS-013] Lifecycle incompleteness: open/new/import absent (open intentional), 10 of 16 export formats missing** — P2.
Evidence: §6 project/export rows.
Impact: agent can finish but not start/relocate a song; delivery breadth is human-only.
Minimal recommendation: keep open human-only; add `kyx_save saveAs` companion `kyx_export` formats incrementally (MIDI and JSON are pure-document and safe).
Acceptance: each new format returns a delivery receipt with byte size.

**[AS-014] NL parity is transport-dependent: 6 route kinds refuse over MCP** — P3.
Evidence: `tools.ts:12899-12911`.
Impact: "how loud is the master?" (query/complaint) works in UI, refused to agents; parity matrix rows for those asks are UI-only.
Minimal recommendation: allow the read-only members of those kinds (query, complaint diagnose) over MCP; keep genuinely window-bound ones (select) refused.
Acceptance: capabilities block lists per-kind MCP eligibility.

**[AS-015] Performance surface beyond scene launch is human-only (live sets, pads, macros, jam, Link/MTC/PCM)** — P3.
Evidence: §6 performance row.
Impact: live-performance preparation is a real producer workflow the agent can't touch; macro knobs (R1) would be trivial to expose.
Minimal recommendation: expose macro value + live-set assignment as document commands (R1); keep pad launch/jam human-only (R4).
Acceptance: macro move read-back + undo.

**Alternatives, trade-offs and regression checks per finding (completing the mandatory format):**

| Finding | Alternatives & trade-offs | Regression / safety checks |
| ------- | ------------------------- | -------------------------- |
| AS-001 clip add | Keep builders-only (safer, caps autonomy); NL-only add (weaker contract than schema) | engine-graph census; arrangement DOM census; seam-manifest entry + negative assertion (refuse bad scene/pattern id) |
| AS-002 notes resize | Derive from note transforms family (heavier); leave to NL quantize wording (lossy) | intent-router corpus; `mcp-notes-music` tests; honest-clamp receipt test at grid edges |
| AS-003 steps velocity/meta | Expose full p-lock editor at once (large surface, higher risk); keep ghost-only (status quo) | steps read-back tests; seam test with falsification; MAX_STEP_COUNT boundary suite |
| AS-004 checkpoint parity | Exemption list with recorded rationale (weaker — requires review per change) | new property test: every `effectiveRisk` destructive op site calls `destructiveAllowedWithCheckpoint` or is exempt-listed |
| AS-005 policy records | Keep audit prose only (not machine-readable) | capability snapshot schema test |
| AS-006 bar convention | Keep prose descriptions (current source of the off-by-one risk) | corpus test pinning both families; grep drift test |
| AS-007 range constants | Central module only, no drift test (will re-drift); schema-only update | drift test greps for re-definitions; `verify:mcp-mirrors` after schema descriptions change |
| AS-008 ops enforcement | Wait for a real incident (current posture: covered by convention) | dev-mode dispatcher assertion + one deliberate raw-command fixture expected to fail |
| AS-009 cancellation | Retry etiquette docs only (residual duplicate-render risk); full AbortSignal refactor (phase 2) | soak: cancel mid-render → zero orphaned jobs/promise leaks; job-center state transitions |
| AS-010 web rate limit | Client-side etiquette only (untrustworthy); leave as-is (documented) | 429 typed-error test; token-bucket unit tests ported from desktop |
| AS-011 receipt schemas | Per-tool bespoke schemas (more precise, slower); leave text-first | mirror regen + family tests assert structured fields; outputSchema validation in dispatch tests |
| AS-012 observation | Ship ONNX analysis in MCP (out of scope, model-benchmark territory) | `audioList` warp-pin read-back test; render-summary beat-phase fixture |
| AS-013 lifecycle | Expose open behind confirm (rejected — service teardown is window-critical); all 10 formats at once (budget risk) | per-format delivery receipt tests; import-cap regression (share-token/project caps unchanged) |
| AS-014 NL eligibility | Full NL parity (mix/loudness need render hooks — keep refused until hooks exist) | per-kind eligibility table test; refusal text unchanged for window-bound kinds |
| AS-015 macro/perf | Full live-set surface (needs own ADR — R4 policy review first) | macro move read-back + undo test; live-set ops stay behind ADR gate |

**Scoring rubric (published, per §11 of the brief).** Each gap scored 1–5 on six axes; **Effort** and **Risk** are inverted (5 = least effort / least risk) so that a higher total is uniformly better. Assumptions: impact judged for a working producer using an agent as a daily collaborator; frequency judged on the documented workflow loop (compose→edit→mix→verify→deliver); leverage counts downstream workflows unlocked, not actions; effort counts engineering days assuming existing command primitives; risk counts regression/safety exposure of the change.

| Gap | Impact | Freq | Leverage | Confidence | Effort⁻¹ | Risk⁻¹ | Σ | Priority |
| --- | ------ | ---- | -------- | ---------- | -------- | ------ | - | -------- |
| AS-001 clip add | 5 | 5 | 4 | 5 | 4 | 4 | **27** | P1 |
| AS-003 steps velocity/meta | 4 | 5 | 3 | 5 | 5 | 4 | **26** | P1 |
| AS-002 notes resize/transforms | 4 | 4 | 3 | 5 | 4 | 4 | **24** | P1 |
| AS-004 checkpoint parity | 3 | 4 | 3 | 5 | 5 | 4 | **24** | P2 |
| AS-011 receipt schemas ×5 | 3 | 4 | 3 | 5 | 4 | 4 | **23** | P2 |
| AS-010 web rate limit + agentId | 3 | 4 | 3 | 5 | 4 | 4 | **23** | P2 |
| AS-007 range constants | 3 | 4 | 2 | 5 | 3 | 5 | **22** | P2 |
| AS-008 ops enforcement | 2 | 4 | 3 | 4 | 4 | 5 | **22** | P2 |
| AS-006 bar convention | 3 | 3 | 2 | 5 | 3 | 5 | **21** | P2 |
| AS-009 cancellation | 2 | 3 | 3 | 5 | 2 | 3 | **18** | P2 |
| AS-005 policy records | 2 | 2 | 2 | 5 | 5 | 5 | **21** | P2 |
| AS-013 lifecycle breadth | 2 | 3 | 2 | 5 | 3 | 4 | **19** | P2 |
| AS-014 NL eligibility | 2 | 3 | 2 | 4 | 4 | 4 | **19** | P3 |
| AS-012 observation depth | 2 | 2 | 2 | 4 | 3 | 4 | **17** | P2 |
| AS-015 macro/perf surface | 2 | 2 | 2 | 4 | 4 | 4 | **18** | P3 |

Trade-offs the scores hide: AS-001 ranks first but touches the largest new schema surface (a botched clip-add could encourage agents to build broken arrangements — mitigated by existing normalization backstop); AS-004 scores low on impact only because the session checkpoint already bounds the damage, not because the inconsistency is benign. The P1/P2/P3 labels above (per-finding) use the brief's defect definitions and intentionally diverge from the Σ ordering where a lower-Σ item is a cheap safety consistency win (AS-004).

 `kyx_checkpoint restore` without D4 (recovery-class, diff-first workflow — F-15 assessment stands); `kyx_publish_gallery` robot badge (already honest); audit log storing project names (bounded, content-free otherwise); headless consent default-ON (test harness, not shipped transport).

---

## 14. Top 10 architectural improvements (smallest set of shared primitives)

1. **`destructiveAllowedWithCheckpoint` everywhere** (mechanical; closes AS-004). No new architecture.
2. **One range/unit constants module** (`src/project-model/ranges.ts`): GAIN_RANGE, MASTER_GAIN_RANGE, BPM_RANGE, PPQ re-export, BAR_CONVENTION; schema descriptions and clamps import it (closes AS-006/007 at the root).
3. **`add`-class clip/step/note ops** riding existing commands (`addArrangementClip`, `addMidiClip`, `setStepsVelocity`, `setStepMeta`) — no engine work, pure MCP adapters (closes AS-001/002/003).
4. **Receipt schemas for the last five tools** via the existing `RECEIPT_SCHEMAS` injection (AS-011).
5. **Mutation-class → `ops` enforcement assertion** (dev gate; AS-008) — one dispatcher check, no behavior change.
6. **Per-op `unavailableByDesign` policy records** in `capabilitySnapshot` (AS-005) — data, not code.
7. **Web rate limiter + optional agentId envelope** (AS-010) — port existing desktop bucket; envelope flows through existing `isExternalAgent`.
8. **Cooperative cancellation for render-class hooks** (AS-009 phase 2) — `AbortSignal` threaded through `renderProject`/`ctx.renderSummary`; transports already have timeouts to hang it on.
9. **Per-kind MCP eligibility table** for `kyx_intent` refusals (AS-014) — turns a hardcoded refusal list into advertised capability.
10. **Undo-stack "agent frame" ownership**: extend `beginUndoFrame` labeling so a batch's frame records its checkpoint name + tool list in the audit log, enabling one-keystroke human veto of an entire agent plan (builds on existing frame + checkpoint primitives).

All ten are adapters/additions over existing primitives — none touch the project model, schema, engine, or real-time paths; each is independently rollback-able (feature flags `pf:mcp-*` already gate this surface).

---

## 15. Test strategy (proposal — none of this was implemented)

- **Contract tests**: mirror-sync (exists) + new range-constant drift test (AS-007) + `ops`-coverage dev assertion (AS-008).
- **Seam tests** (per `tests/seam-manifest.json` discipline): every new MCP op needs (a) entry through the real dispatch, (b) a negative assertion (refusal/no-op), (c) a mutation claim falsified by breaking production — the `eq-curve-gesture` standard.
- **Gate-parity property test**: enumerate D4-classified ops from `effectiveRisk` and assert each handler site either calls `destructiveAllowedWithCheckpoint` or is on an explicit exemption list (AS-004 regression lock).
- **Receipt tests**: structured-output validation for the last five tools; replay `current`-channel assertions.
- **Chaos**: kill the bridge mid-`kyx_batch`; close the window mid-render; concurrent human drag + agent write on the same field (expects WRITE_CONFLICT); undo-stack overflow during batch.
- **Real-audio manual checks** (owner gates, unchanged): `verify:param-readback` after any param-surface change; factory-preset audibility after any instrument-path change; a listening A/B for any DSP-affecting recommendation.

---

## 16. 30/60/90-day roadmap (staged, dependency-aware, rollback gates)

**Days 0–30 (safety & contract hardening — low risk, no new capability):**
AS-004 checkpoint parity → AS-007/006 constants module → AS-011 receipt schemas → AS-008 dev assertion → AS-005 policy records. Rollback gate: each lands behind `pf:mcp-*` flags; mirrors regenerated per commit; `npm run verify:mcp-mirrors` + focused MCP suites green before each merge.

**Days 31–60 (parity wave 1 — the edit-depth cliff):**
AS-001 `kyx_clips add` + midi-clip minimal family → AS-003 steps velocity/meta → AS-002 notes resize/duplicate. Rollback gate: new ops ship dark behind `pf:mcp-clips-add` etc.; seam-manifest entries with negative assertions; engine-graph census must stay green.

**Days 61–90 (composability & transport):**
AS-010 web rate limiter + agentId → AS-009 phase-1 retry etiquette (phase 2 cancellation if the AbortSignal refactor lands cleanly) → AS-014 eligibility table → AS-015 macro exposure. Rollback gate: relay changes behind server config; cancellation must show zero orphaned jobs in soak before enabling.

**12–24-month opportunities (explicitly speculative):** full generative-track MCP surface (the runtime exists, bounded and capture-capable, but is deliberately unexposed today — would need its own ADR + authorization review); agent-authored automation *clips* and modulator graphs; an agent "session journal" replay UI built on the audit log + checkpoints; cross-transport per-agent scopes (allow/protect per client, not per envelope). None of these should start before the 90-day contract hardening is green.

---

## 17. What must remain human-controlled

1. **Recording, monitoring, device selection, input gain** (R4/R3 + permission-gesture class) — declared `unavailableByDesign`; keep it.
2. **Project open/switch** — tears down and rebuilds services; owned by ProjectBrowser (already declared).
3. **Audio import from the filesystem** — needs a human file picker; the 1 MB body cap is a deliberate non-channel for audio.
4. **Gallery publish** — outward-facing; requires explicit confirmation even once a confirm flag exists (R3).
5. **Pad/scene *performance*** (jam, live pads, Link/MTC) — R4 real-time expression; scene *launch* is the one sanctioned agent entry and is bar-quantized.
6. **Undo of human (unlabeled) work** — foreign-work consent is the correct boundary; do not relax it.
7. **The audio thread** — no AI path may ever target AudioWorklet processing directly; the document→`setProject` projection is the only bridge (ADR 0004).
8. **Consent itself** — standing consent (per-window flags) must stay visible, revocable, and default-off for external agents; the lattice's confirm class is the product's spine.

---

## 18. Unknowns and open questions

1. **Parity cells — resolved during the audit.** The six candidate UNKNOWNs were closed by direct verification: `kyx_sections` op enum has no `role` op (read at `tools.ts:3031`); `clearPattern`, `generateChordProgression`, `setMacroValue` and `assistVary` have zero references in `src/mcp/tools.ts`, `src/intent/command-for-route.ts` and `src/intent/route.ts` → all six are NO (accidental gaps). No UNKNOWN cells remain in §6.
2. **Audio-result parity** — no claim in this audit extends to whether AI-driven edits *sound* right; the measured-DSP read-back gate covers parameter classes only.
3. **Long-session checkpoint staleness** — the 15-minute session window means a destructive op late in a long session reverts to a checkpoint up to 15 minutes old (mitigated by AS-004 fix); real-world impact unmeasured.
4. **Concurrent human+agent editing under collab (yDoc)** — the stale-write guard compares the local document; Yjs-mediated remote edits were not exercised. Evidence exists for local races only.
5. **Mirror regeneration cadence under concurrent sessions** — in sync at HEAD; the drift incident of 10-24 shows the process depends on discipline (gen:mcp-mirrors per commit), which the dedicated verify step now enforces.
6. **Whether `kyx_intent` preset/effect-add routes execute identically over MCP as in UI** — the shared command builder (`command-for-route.ts:5-8`) is strong evidence; the refusal list was verified, the executing branches were not line-by-line traced in this pass.

---

## 19. Acceptance criteria for the audit itself — self-check

- Every claimed-working AI action traces to a cited path (§4 table; dispatch chain §4 tail; E7 re-verification). ✔
- Every denominator defined (309 mutation / 40 view, §3); no UNKNOWN cells remain — the six candidates were resolved during the audit (§7, §18). ✔
- Exposed-but-stubbed tools not counted functional: `kyx_unsuno transcribe` counted working (loader verified wired per 10-24 P1 follow-up + honest-refusal path); headless-only capabilities never counted for shipping transports. ✔
- Consent-requiring actions not recommended for unrestricted autonomy (§17). ✔
- Repository-specific, not generic DAW advice (every finding cites files/lines). ✔
- Recommendations preserve architecture (all ten are adapters over existing primitives; ADR 0004/0014/0065 boundaries respected). ✔
- No source, config, project, or audio data modified; the only artifact of this audit is this report. ✔
