# PORTING SLICE PLAN

> **Cross-platform readiness campaign — GOAL 13 deliverable** (2026-09-23).
> The safest migration order for a future native implementation, as
> incremental parity-preserving slices. Each slice lists: source modules,
> dependencies, required contracts, reference tests, persistence and
> state-machine dependencies, expected output, and parity criteria.
> **Every reference test already exists in-repo** — that is the campaign's
> core gift: each slice lands against a green gate, not against hope.
>
> Rules: incremental over one-shot; a slice is DONE when its parity criteria
> pass on the new platform; no slice starts before its dependencies'
> parity criteria pass. Runs on the REAL product stay untouched throughout —
> slices live beside the web app until they replace it.

---

## Order (lowest-risk shared logic → highest-risk platform integration)

| #   | Slice                                 | Risk            |
| --- | ------------------------------------- | --------------- |
| S1  | Pure model core                       | L               |
| S2  | Command/editing layer                 | L               |
| S3  | Serialization family                  | L               |
| S4  | Transport + scheduler planning        | L–M             |
| S5  | Persistence backends                  | M               |
| S6  | Platform abstractions (host adapters) | M               |
| S7  | Intent pipeline                       | L–M             |
| S8  | Audio backend + DSP                   | **H**           |
| S9  | Collaboration runtime                 | M–H             |
| S10 | UI shell (native)                     | by design, last |

---

## S1 — Pure model core

- **Source:** `src/project-model/*` (types, schema, transforms, groove,
  automation, modulators, scales, markers, scenes, kit-presets),
  `src/instruments/definitions.ts`, `src/effects/definitions.ts`,
  `src/shared/{rng,ids,dice,velocityFx}.ts`.
- **Dependencies:** none (verified Node-pure; PORTABILITY_MAP §1).
- **Contracts needed:** id source (uuid or seeded) — `shared/ids` is the template.
- **Reference tests:** `tests/instrument-definitions.test.ts`,
  `tests/project-invariants.test.ts`, `tests/persistence/schema-evolution.test.ts`
  (sanitize halves), goldens `param-math.json`, normalize idempotency +
  migrate determinism (round-trip-integrity).
- **Persistence deps:** none (pure).
- **State-machine deps:** none.
- **Expected output:** the same canonical documents and clamp/default tables
  from host-native code.
- **Parity criteria:** `param-math.json` replays exactly; normalize is
  idempotent and deterministic on the golden template docs; schema-evolution
  sanitize behavior matches (missing/unknown/future fields).

## S2 — Command / editing layer

- **Source:** `src/commands/*` (6.3k-line command core, docDelta, layerCommands),
  `src/midi/hum-to-notes.ts`, `src/rendering/stems.ts` (pure transform).
- **Dependencies:** S1.
- **Contracts needed:** none beyond S1.
- **Reference tests:** command-transforms + undo sweeps
  (`undo-roundtrip-sweep`, `commands-edge-cases`, `note-commands`,
  `groove-commands`), `doc-delta` self-verification.
- **Persistence deps:** none.
- **State-machine deps:** none (commands are pure).
- **Expected output:** identical doc results for the same command sequences
  (values are baked into commands — no replay randomness).
- **Parity criteria:** `command-transforms.json` replays; undo restores the
  exact base doc; doc-delta path (no legacy fallbacks) holds.

## S3 — Serialization family

- **Source:** `src/export/{shareCode,packCode,kitCode,bindsCode,themeCode}.ts`,
  `src/export/project-io.ts` (parse/validate half), `src/midi/midiFile.ts`,
  `src/rendering/wav.ts` (encoder), `src/intent/favorites-core.ts`,
  `src/export/zyvo-transfer.ts` (manifest/contract parts).
- **Dependencies:** S1 (docs), S2 (for sequence fixtures).
- **Contracts needed:** byte-accurate UTF-8 + lz-string equivalent.
- **Reference tests:** `import-export-robustness` (hostile corpora, caps),
  goldens `serialization.json` + **`decode-goldens.json`** (backward
  compatibility — the pins never regenerate), WAV round-trips, MIDI matrices.
- **Persistence deps:** none.
- **State-machine deps:** none.
- **Expected output:** byte-identical codes/files for the same canonical docs;
  identical decode of the pinned golden codes.
- **Parity criteria:** every decode pin decodes to the same canonical doc;
  WAV/MP3 dither determinism holds; MIDI hex matches.

## S4 — Transport + scheduler planning

- **Source:** `src/transport/Transport.ts`, `src/scheduler/Scheduler.ts`
  (planning half), `src/shared/webAudioSupport.ts` if gated flows need it.
- **Dependencies:** S1; a host clock implementing `Clock`.
- **Contracts needed:** `Clock` (exists), `SchedulerDeps` (exists — the
  audio-host port; implement trigger/noteOn as recorders first).
- **Reference tests:** goldens `transport-time.json` + `scheduler-plan.json`;
  `tests/transport.test.ts` (NaN/loop/seek), `tests/scheduler.test.ts`
  (windows, tempo seam, loop wrap, context gate).
- **Persistence deps:** none.
- **State-machine deps:** implements the transport/scheduler machines from
  STATE-MACHINES §1–2 (guards: double-start, stop-commits-launch,
  suspension walk + re-anchor).
- **Expected output:** identical tick/event plans for the same doc + clock.
- **Parity criteria:** the two goldens replay; suspension walk + re-anchor
  behave per STATE-MACHINES (no wedge, no burst).

## S5 — Persistence backends

- **Source:** semantics of `src/persistence/*` (record shapes, caps, prune
  policies, sanitize rules — PERSISTENCE-SCHEMAS §1) reimplemented on
  SQLite/room storage.
- **Dependencies:** S1; `PersistenceContracts` (GOAL 03).
- **Contracts needed:** the 11 `I*Repository` + `PersistenceContracts` bundle
  (already the injection seam; generalize `openDatabase` injection first —
  queued GOAL 03 follow-up).
- **Reference tests:** `tests/persistence/*` (schema-evolution matrix,
  round-trip integrity, per-repo suites, adversarial poisoned-row matrices) —
  run them against the new backend.
- **Persistence deps:** IS the persistence layer.
- **State-machine deps:** recording session machine (begin→chunks→finalize/
  recover) must match byte/sequence semantics (risk H — PERSISTENCE-SCHEMAS §6).
- **Expected output:** the same observable repo behavior including failure
  modes (quarantine, skip, typed quota errors).
- **Parity criteria:** the full persistence suite green on the new backend;
  a project saved by the web build loads identically on the port (and vice
  versa) — cross-write fixtures.

## S6 — Platform abstractions (host adapters)

- **Source:** the GOAL 03 seams — `shared/assetUrls`,
  `services/audio-decode`, `export/download`, plus new host adapters for
  clock, share-sheet, permissions→error-name mapping (PLATFORM-CONTRACTS §4/§9).
- **Dependencies:** S3 (producers), host platform.
- **Contracts needed:** ARE the contracts (documented responsibilities/
  errors/lifecycle per seam).
- **Reference tests:** `tests/platform-contracts.test.ts` + FAULT-CONTAINMENT
  behavior pins.
- **Expected output:** artifacts reach host storage; bytes decode via the
  host decoder; asset URLs resolve against packaged resources.
- **Parity criteria:** download/decode/asset behaviors match the contract
  docs; every error surfaces with the documented semantics.

## S7 — Intent pipeline

- **Source:** `src/intent/*` pure core (parse → normalize → plan → providers'
  logic → favorites-core), `src/ai/{generator,melodic,grooves}` logic,
  definitions-adjacent feature builders.
- **Dependencies:** S1, S2.
- **Contracts needed:** none beyond S1 (worker/ONNX is behind degradation —
  the heuristic path is the port's first milestone).
- **Reference tests:** the 229+ intent suite + deterministic pipeline tests
  (seeded → `contentHash`-stable) + favorites-core pins.
- **Expected output:** same plans/patterns for the same (seed, intent).
- **Parity criteria:** seeded generation replayable byte-for-byte at the doc
  level; rank/parse behavior matches the intent suites.

## S8 — Audio backend + DSP (highest risk — enters last)

- **Source:** `src/audio-engine` runtime, `src/audio-worklets/*` processors,
  `src/effects` runtime halves, `src/instruments` runtime halves,
  `src/rendering/renderer.ts` (offline), encoders' host glue.
- **Dependencies:** S1–S6.
- **Contracts needed:** context lifecycle + `SchedulerDeps` + offline-context
  equivalent + `attachProcessorErrorGuard` semantics (GOAL 07).
- **Reference tests:** the four bit-exact plugin golden-vector suites
  (ultina/fxeq/ozvena/morph), golden-render, render-event-parity,
  render-quality, worklet-hardening pins.
- **Persistence deps:** S5 (frozen buffers, samples).
- **State-machine deps:** context lifecycle + suspension/re-anchor machines
  (STATE-MACHINES §1–3, verified mobile-safe in MOBILE-READINESS §1).
- **Expected output:** audio that passes the vectors; renders that satisfy
  render parity within documented tolerances.
- **Parity criteria:** EVERY DSP golden suite green on the native backend
  before any user-facing sound; render-event parity vs the planner.

## S9 — Collaboration runtime

- **Source:** `src/collab/*` codec + policies (`YDocAdapter`, buffering,
  degrade, role gates, `isAllowedServerUrl`), over a host CRDT/WebSocket
  runtime.
- **Dependencies:** S1–S5; networking host.
- **Contracts needed:** endpoint CONFIG injection (replacing `location`
  derivation — documented, deferred), transport host.
- **Reference tests:** `collab-ydoc-drift` (codec), `collab-contract-parity`,
  `collab-transport` (follow semantics), `collab-validation`.
- **State-machine deps:** collab session machine (STATE-MACHINES §6).
- **Expected output:** peers converge to the same document; the codec never
  drops fields (the drift pin is the gate).
- **Parity criteria:** drift pin + contract-parity suites green against the
  host runtime; server cap agreement documented.

## S10 — UI shell (native)

**PLATFORM-SPECIFIC BY DESIGN — out of this campaign's scope.** A native
shell consumes S1–S9 through the contracts; the touch-adaptation queue
(MOBILE-READINESS §3) is its requirements list, and the route-app boundary
pattern (GOAL 07) is its containment template.

---

## Sequencing rationale

S1–S3 are pure and byte-gated today — they can start on any target with zero
host work and prove the toolchain. S4–S5 need only injected clocks/storage.
S6 is the first slice that touches the host for real. S7 rides the pure core.
S8/S9 are last because they carry the H risks and the biggest native
decisions (DSP strategy, CRDT runtime) — and because their parity gates are
the strictest, they benefit from every earlier slice's toolchain maturity.
