# PRESTIGE PLAN — publish the proof, open the ecosystem, tell the craft

> **Status: PROPOSAL — awaiting owner approval. Nothing below is started.**
> Written 2026-10-17, after the AI/trust waves (agent trust, job center, render
> provenance, taste loop, session tape, trust report, vocal alignment).
>
> This plan contains **zero new engine/DSP features**. The engineering base is
> shipped and measured; what is missing for a reference-grade reputation is that
> it is _visible from the outside_: proof anyone can check, an ecosystem others
> can build on, and the craft story only this codebase can tell.
>
> The house rule applies to every item below (`docs/LONGEVITY.md` §0): **every
> claim ships with its pin** — a command a reviewer can run. An item without an
> acceptance command does not belong in this plan.

---

## 1. Where we stand (evidence, not adjectives)

| Capability                                     | Proof that exists today                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Deterministic engine + offline parity          | golden vectors, `tests/golden-doctor.test.ts`, render/offline parity suites                             |
| Agent trust (risk classes, session checkpoint) | `src/mcp/agentTrust.ts`, `tests/agent-trust.test.ts`, Activity Center panel                             |
| Reproducible exports + verifier                | `docs/KYX-REPRODUCIBILITY-PROTOCOL.md`, `tools/kyx-verify/`, `npm run verify:wav`, 12 conformance specs |
| Taste loop closed (reactions → rerank fit)     | `src/intent/reaction-rerank-feedback.ts`, `tests/rerank-generation-join.test.ts`, shadow adjudication   |
| Measured taste baseline                        | `npm run taste:benchmark`, committed baseline, drift-locked                                             |
| Durability + honesty artifact                  | Trust Report (`src/services/trustReport.ts`) with `clean`/`partial`/`warnings`/`unknown` levels         |
| Vocal-first recording loop                     | REC + count-in + device latency + loop take stacking + `vocal-alignment.ts` phrase alignment            |
| Discipline that makes it believable            | `drift:check`, seam coverage gate, `suite-expectations.json`, bundle budgets                            |

**What is NOT proven yet, and blocks any outward claim:**

- the owner release gates from `AGENTS.md` §6: manual Firefox/Safari/iOS smoke
  (`docs/KYX-SAFARI-IOS-MANUAL-QA.md`), `release:preflight`,
  `release:server-smoke`, and `release:deployed-smoke` (needs `KYX_DEPLOY_URL`);
- nothing in this plan may be _announced_ before Phase 0 closes.

---

## 2. Phase 0 — Make the release true (owner-dependent, S)

The cheapest prestige item in existence is a claim that survives an independent
check. Publishing a verifier while the app has unclosed release gates would be
the opposite.

- **0.1** Run the manual browser smoke (Firefox / Safari / iOS Safari) per
  `docs/KYX-SAFARI-IOS-MANUAL-QA.md`; record observed issues as tasks, not as prose.
- **0.2** Run `npm run release:preflight` and `npm run release:server-smoke`; if a
  deploy exists, `npm run release:deployed-smoke` with a real `KYX_DEPLOY_URL`.
- **0.3** Record the outcomes as data — they become the first entries of the
  Phase 2.2 status artifact, with the exact commands and dates.

**Acceptance:** a written result for every gate (pass, or a linked task), and no
outward-facing publication before it.
**Effort:** S (owner hands) + S (recording).
**I stop here for approval.**

---

## 3. Phase 1 — Publish the flags already planted (S each)

### 1.1 `kyx-verify` as a real package

- **Exists:** `tools/kyx-verify/` (zero-dep, exit codes), the spec, the
  conformance suite that pins it against the app's own parser.
- **Missing:** it is a repo file, not something a third party can install.
- **Deliverables:** `tools/kyx-verify/` with its own `package.json`
  (name `kyx-verify`, `bin`, MIT, `files` allowlist), a README that documents the
  exit codes and the three verification levels, and the root suite still running
  the same conformance specs against that directory.
- **Acceptance:** `npm pack` inside the directory produces a tarball whose
  installed `bin` verifies a stamped WAV produced by `tests/kyx-verify.test.ts`
  fixtures; the conformance suite stays green.
- **Risk:** publishing is a maintenance surface — keep it to one file + one spec
  version; no feature requests accepted into v1.

### 1.2 Verifiable gallery

- **Exists:** `/api/gallery` + share codes + the render manifest in every export.
- **Missing:** the gallery cannot tell a verifiable publish from a plain one.
- **Deliverables:** publish payload carries provenance metadata (project id,
  render hash + algorithm, model receipts summary); server-side validation with
  caps and rejection (a malformed or oversized manifest is refused, not stored);
  an item badge plus a filter (**verifiable / AI-assisted / model-free**); and the
  item view offers the download → `npx kyx-verify` instruction.
- **Acceptance:** server spec (a crafted payload is rejected; a valid one stores
  exactly the declared fields), gallery UI spec (badge only when a hash exists;
  filter narrows the feed), and one end-to-end: publish → download → verify.
- **Effort:** S–M. **Risk:** a badge nobody checks is worse than none — the
  badge must link to the command that checks it.

### 1.3 Public compatibility promise

- **Exists:** `docs/LONGEVITY.md` (internal 5-year contract), schema migrations,
  versioned share codes and manifest format.
- **Missing:** a user-facing promise in one page, and a pin that makes it true
  rather than aspirational.
- **Deliverables:** `docs/COMPATIBILITY.md` (what will never break: share codes,
  project files, manifest format, the counts' meaning) + a committed **golden
  share-code fixture** and a test that it still decodes to the expected shape.
  Every future schema bump extends that fixture set instead of replacing it.
- **Acceptance:** `tests/compatibility-golden.test.ts` decodes the committed
  fixture with the current code; the doc names the two commands that prove it.

### 1.4 Agent starter kit

- **Exists:** MCP mirrors (`src/mcp/tools.ts` → `desktop/mcp-tool-defs.cjs`,
  `server/mcp-core.mjs`), the surface audit, `docs/AGENTIC-DAW-PLAN.md`,
  `docs/MCP-AWESOME-PR.md`.
- **Missing:** one entry document + a machine manifest a third-party agent can
  consume, and a pin that the document cannot drift from the tool surface.
- **Deliverables:** `docs/AGENT-KIT.md` (what an agent may do, the risk classes,
  the checkpoint/audit contract, three worked examples), a generated
  `mcp-manifest.json` produced by `npm run gen:mcp-mirrors`, and a test that
  **every `kyx_*` name named in the kit exists in `MCP_TOOLS`**.
- **Acceptance:** the drift section covers the manifest; the doc-name test is
  green; a fresh agent following the kit completes one read-only and one
  checkpointed mutating task against the headless host.

**I stop here for approval before Phase 2.**

---

## 4. Phase 2 — The two artifacts nobody has (M each)

### 2.1 Session Story

- **Exists:** the session tape (steps, outcomes, undo depths), E1 selection
  reasons, reaction verdicts, render provenance, the Trust Report shell.
- **Missing:** a readable account of how a beat came to be — today the data is a
  strip of chips.
- **Deliverables:** the tape's generation step gains `rationale` (the value is
  already in hand at the call site); `src/services/sessionStory.ts` composes a
  markdown journal: each step with its measured reason, what was kept or reverted
  (with the reaction verdict), the AI receipts, and the export hash; a
  **SESSION STORY** download next to the Trust Report.
- **Honesty rule (part of acceptance):** a step without a measured reason prints
  nothing about why — no filler prose.
- **Acceptance:** composition tests over a synthetic tape (including a rewind and
  a rejected take), the download pinned in the ExportPanel spec, and one
  end-to-end: DO IT → USE → REWIND → the story shows the branch and the detachment.
- **Effort:** M.

### 2.2 Status report (`npm run status:report`)

- **Exists:** every gate can already be run; results live in terminals.
- **Missing:** a single page that states each public claim with its command and
  its last measured result.
- **Deliverables:** a generator writing `docs/STATUS.md` + `docs/status.json`
  from real runs (drift, seam coverage, expectations ledger, `goldens:doctor`,
  bundle budgets, taste benchmark, Phase 0's manual results), a new
  `drift:check` section so a stale status is **drift**, and a test pinning the
  section's shape.
- **Acceptance:** `npm run status:report` then `npm run drift:check` exits 0; a
  deliberately stale status turns the drift gate red.
- **Effort:** M. **Risk:** the page must not become marketing prose — it is a
  measurement table or it does not ship.

---

## 5. Phase 3 — Open the market (M–L)

### 3.1 Accessibility gate

No axe/automated a11y gate exists today. Deliver: axe-core as a dev dependency,
a spec running it over the App shell, mixer, arrangement and intent panel, fixes
for what it flags, and a documented keyboard path for the primary flows.
**Acceptance:** the new spec is green and covers the four surfaces; the keyboard
path is exercised by at least one spec per surface. **Effort:** M.

### 3.2 Mobile: install + share target

No PWA manifest, no share target, no service worker today. Deliver:
`public/manifest.webmanifest`, a share-target route that feeds the existing
intake path (`SEND-TO-KYX`), touch-sized transport/pad targets, and an iOS QA
pass per `docs/KYX-SAFARI-IOS-MANUAL-QA.md`. **Acceptance:** install the app,
share an audio file from the OS, it appears in the intake tray. **Effort:** L.
**I stop here for approval before 3.2.**

### 3.3 i18n skeleton

No i18n layer exists; SK and EN are interleaved. Deliver `src/i18n/` with a
`t(key, vars)` function, an EN default catalog, and **one** panel migrated as the
pattern (not a big-bang). **Acceptance:** the migrated panel's keys are covered
by the catalog in a spec, and the pattern is documented for the next panel.
**Effort:** M, incremental forever.

### 3.4 Sound identity — OWNER DECISION, no code

A one-page brief with three candidate directions (one flagship suite each:
PRISM / VLYX / DRIFT), what each would mean for the demo, the docs and the
listing page, and the constraint that whoever wins ships with a pin (golden
vectors + a demo project). **No implementation until the owner picks.**

---

## 6. Definition of Done (per item — the repo's own gates)

1. `npm run typecheck` · `npm run test:expectations` (failure set unchanged or
   the ledger deliberately updated) · `npm run drift:check` · seam coverage gate
   · `npm run format:check` — all green.
2. `docs/CURRENT-STATE.md` counts updated in the same commit.
3. New user-facing seams declared in `tests/seam-manifest.json` with a negative
   assertion.
4. Bundle budgets measured; any increase carries a measured justification.
5. ADR when an architectural boundary moves (it does not in this plan except
   possibly 3.2).

## 7. Non-goals (explicit)

- No new engine/DSP features, instruments, effects or presets.
- No cloud inference, no telemetry that leaves the machine, no data sales.
- No engine rewrite, no Rust/WASM path, no major dependency upgrades.
- No second source of truth for state; the learning ledgers stay prose-free.
- No announcements, press or listings before Phase 0 closes.

## 8. Risks & sequencing constraints

| Risk                                          | Mitigation                                                          |
| --------------------------------------------- | ------------------------------------------------------------------- |
| Publishing outward while owner gates are open | Phase 0 first; nothing outward before it                            |
| Shared working tree with concurrent sessions  | stage only authored paths; clean verification in a worktree at HEAD |
| `kyx-verify` becomes a maintenance surface    | one file, one spec version, no feature intake for v1                |
| The status page drifts into marketing         | it is a measurement table; the drift gate enforces freshness        |
| Gallery provenance becomes theatre            | the badge always links to the command that checks it                |
| Scope creep after Phase 1                     | each phase has its own GO/NO-GO; Phase 3 is explicitly market-gated |

## 9. Checkpoints — where I stop and ask

1. **After Phase 0** — report the manual smoke results; nothing outward yet.
2. **After 1.1** — review the package + README before any publication step.
3. **After Phase 2** — review the Session Story and the status page before
   Phase 3.
4. **Before 3.2** — mobile changes the release surface; explicit approval needed.
5. **3.4** — owner decision, no code until chosen.

## 10. Effort summary

| Item                                | Size | Blocks                        |
| ----------------------------------- | ---- | ----------------------------- |
| 0. Release truth (owner)            | S    | everything outward            |
| 1.1 `kyx-verify` package            | S    | the protocol's outside half   |
| 1.2 Verifiable gallery              | S–M  | —                             |
| 1.3 Compatibility promise + fixture | S    | —                             |
| 1.4 Agent starter kit               | S    | —                             |
| 2.1 Session Story                   | M    | —                             |
| 2.2 Status report                   | M    | records 0 and everything else |
| 3.1 Accessibility gate              | M    | —                             |
| 3.2 Mobile install + share target   | L    | 3.1 for the QA pass           |
| 3.3 i18n skeleton                   | M    | —                             |
| 3.4 Sound identity                  | —    | owner decision                |

---

## 11. Progress log

- **2026-10-17 — Phase 1 (all four items) implemented; NOT published.**
  - **1.1** `tools/kyx-verify/` is now a real package (own `package.json`, `bin`,
    MIT, README with the exit codes); the root `npm run verify:wav` wrapper and the
    conformance suite point at it. Acceptance was run by hand: `npm pack` → install
    into a temp prefix → the **installed** `kyx-verify` bin verified a stamped
    32-bit float master (`VERIFIED`, exit 0, hash recomputed from the file's own
    samples). `npm run verify:wav:fixture -- <out.wav>` makes that repeatable.
  - **1.2** Verifiable gallery: the publish payload carries `render` (SHA-256 +
    AI receipts) handed over from the studio's export stamp; the server **refuses**
    a malformed claim (400, nothing stored) and caps the receipt list; the card
    badge and the feed filter are derived from the item's own object (no stored
    flag), carry the exact `npx kyx-verify … --expect <hash>` command, and the
    client and server sanitizers are pinned to agree on a table of payloads
    (`tests/gallery-render-provenance.test.ts`), which also carries the
    **end-to-end**: the hash the gallery stores is the hash the PUBLIC verifier
    checks against a real stamped export, run as a real CLI process.
  - **1.3** `docs/COMPATIBILITY.md` (the public half of `LONGEVITY.md §0`) plus a
    committed golden share code (`tests/fixtures/compatibility/share-code-v1.json`)
    with three pins: it decodes, it migrates to the CURRENT schema version, and a
    project from the future is refused.
  - **1.4** `docs/AGENT-KIT.md` + generated `docs/mcp-manifest.json`
    (`npm run gen:agent-kit`): the manifest is deep-pinned to the live MCP surface
    and the kit may not name a tool that does not exist.
  - Phase 1 evidence: 112/112 in the 12 files the phase touches, `tsc` clean,
    seam gate green (49 seams, 4 new), and the package acceptance above.
  - **Still open:** the publication step (npm publish, announcements, listings)
    waits for the Phase 0 owner gates and the owner's GO at checkpoint 2 (§9).

- **2026-10-17 — Phase 2 (both artifacts) implemented.**
  - **2.1 Session Story** — the tape's generation step carries the MEASURED
    rationale (attached where it exists), and `src/services/sessionStory.ts`
    composes a readable journal: steps oldest-first, the reason only where one
    was measured, verdicts joined through the SAME generation identity the rerank
    fit uses, the AI receipts, and the export hash with its verify command.
    Downloadable beside the Trust Report (ExportPanel) and the agent log
    (ActivityCenter). The load-bearing negative is pinned: a step without a
    measured reason prints NOTHING about why.
  - **2.2 Status report** — `npm run status:report` runs the cheap claims live
    (seam coverage, spec counts, the taste baseline, and the protocol
    end-to-end: fixture → `kyx-verify` → VERIFIED) and writes `docs/status.json`
    (stable, timestamp-free — the payload the drift gate can compare) plus
    `docs/STATUS.md` (the human page). The owner's manual gates
    (`docs/status/manual-gates.json`) render as PENDING and never as a pass;
    commands too slow for a report are LISTED, never implied to have run.
    A new `drift:check` section (`status`) regenerates the payload and fails on
    a stale row.
  - Phase 2 evidence: 91/91 in the 10 files the phase touches, `tsc` clean,
    seam gate green (51 seams, 2 new), and a live run of the report itself
    (4 pass · 0 fail · 4 pending).

- **2026-10-17 — Phase 3.1 (accessibility gate) implemented.**
  - `axe-core` added as a dev dependency; `tests/a11y-panels.test.tsx` gates the
    four primary surfaces (app shell, mixer, arrangement, intent panel) on
    critical+serious+moderate+minor = ZERO, plus an independent check that every
    interactive control carries a non-empty accessible name.
  - Earning it fixed three real defects: orphan `role="row"` with no grid parent
    (Sequencer), `role="meter"` whose `aria-valuenow` only arrived on the first
    rAF tick (Meter — the first paint was invalid), and `aria-label` on a bare
    div (the arrangement chord lane). The sequencer spec was updated to the new,
    VALID role (`group`) — the assertion intent is unchanged.
  - Stated limits, on the spec itself: `color-contrast` cannot run in jsdom and is
    excluded; the `incomplete` bucket is not gated; naming QUALITY is not graded
    (only the empty case). Focus order and keyboard operability are covered by
    the existing keyboard specs and are NOT re-asserted here.

- **2026-10-17 — Phase 3.3 (i18n skeleton) implemented; 3.2 and 3.4 await the owner.**
  - `src/i18n/index.ts`: a TYPED message catalog (TypeScript refuses a missing
    key, so completeness costs no test), `t(key, vars)` with a fallback chain
    (missing translation → EN → the KEY — never an empty label), `setLocale` /
    `getLocale` persisted per window, and `useLocale()` so a panel re-renders on
    a language switch.
  - The PATTERN PANEL is `PublishButton` (the smallest surface, and English by
    default so nothing visible changed): every string it renders now comes from
    the catalog, and `tests/i18n.test.tsx` proves the wiring by switching to
    Slovak and asserting the rendered label and error text follow.
  - Panels migrate one at a time; nothing here rewrites a panel that has not been
    migrated on purpose. `3.2 mobile` still needs the owner's GO (checkpoint 4)
    and `3.4 sound identity` still needs the owner's decision (checkpoint 5).

- **2026-10-18 — Phase 3.4 brief delivered; the decision is the owner's.**
  - `docs/SOUND-IDENTITY.md`: the three candidates (VLYX mix doctor, DRIFT space
    pad, PRISM paint EQ) with what each ALREADY has in the tree, the measurable
    claim it would carry, the 60-second demo, the comparison matrix, and the
    recommendation (**VLYX**, because the product's moat is proof around sound,
    not sound itself).
  - Fixed build order after the pick, so the decision cannot creep: artifact
    (factory template) → pin (golden fixture + a `docs/status.json` claim row) →
    claim card → public face. Non-goals: no new DSP, no rename, no marketing copy
    before steps 1–3 exist.
  - **Still open:** the one-word pick (`VLYX` / `DRIFT` / `PRISM`) and the §3.2
    GO. Nothing in §3.4 is implemented before the pick, by design.

- **2026-10-18 — §3.4 VLYX SELECTED; the identity shipped in the plan's order.**
  - **Artifact:** `vlyx-demo` factory template ("VLYX Demo — Muddy Mix") — the
    House chord voiced an octave DOWN with a 900 Hz filter, muddy by
    construction; its engine golden hash is pinned and the templates count moved
    14 → 15 (drift-checked).
  - **Pin:** `src/analysis/vlyxClaim.ts` + `tests/fixtures/vlyx-claim/vlyx-claim-v1.json`
    - `tests/vlyx-claim.test.ts` — the golden numbers frozen, the REAL
      `analyzeWithTarget` feeding the claim from its own octave profile, and the
      monotonicity invariant over 200 deterministic vectors (the rule can never
      increase the mean deviation). A drift-checked `vlyx-claim` row on the status
      page reads "mean deviation 2.7 → 1.6 dB (−1.1 dB, 5/10 bands)".
  - **Claim:** the REFERENCE MATCH review now prints the CLAIM line with the
    measured octave-profile deviation, right next to the level-matched A/B and
    the integrated LUFS. Taste is never claimed: the A/B is the "does it sound
    better" measurement, the claim is arithmetic.
  - **Face:** one landing section naming VLYX, pointing at the status page and
    at the demo template.
  - Non-goals respected: no new DSP, no rename, no logo, no marketing copy that
    is not backed by a row above.
