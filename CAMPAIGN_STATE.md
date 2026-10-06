# CAMPAIGN STATE

## ACTIVE CAMPAIGN

Name: BUILD & TOOLCHAIN — gate integrity & post-feature verification (playbook campaign 9, goals 04+05 with a regression sweep)
Current goal: CLOSED 2026-10-06 — all non-owned red gates repaired; see NEXT HIGHEST VALUE WORK for continuation
Last updated: 2026-10-06 (session sess_85d94465)

> Historical: the previous campaign in this file (CROSS-PLATFORM READINESS,
> 2026-09-21→09-23, all 13 goals DONE) is preserved in git history and in
> `docs/PORTABILITY_MAP.md`; its open queues live in
> `CROSS_PLATFORM_READINESS_REPORT.md` §3.

## VERIFIED FIXED

### U0.5 tempo rewrite measured a phantom pulse on steady tones
- Area: `src/ai/audio-tempo-key.ts` (UN-SUNO U0.5 flux rewrite 464f512d)
- Root cause: the rewrite dropped the old `onsets < 8 → null` honesty gate; a stationary sine leaves periodic spectral-leakage wobble in the rectified flux envelope which the self-normalizing candidate scorer promotes to "150 BPM @ 0.979".
- Fix: crest gate — baseline envelope peak/mean < 8 → null. Measured: sine ≈ 4.8, click trains 29–38, golden fixtures 20–44.
- Verification: vocal-profile 55-test adjacency all green incl. the honest-null spec; golden-set LIVE floors still green.
- Files changed: src/ai/audio-tempo-key.ts, tests/services/wiring.test.ts (fake engine gained getRtLoad after 020a721d)
- Date/session: 2026-10-06, commit `dfe6bf06`

### format:check was red on 103 files with three different causes
- Area: Prettier gate (`npm run format:check`)
- Root cause: (a) 68 files of real drift accumulated by feature waves that skipped `npm run format`; (b) 35 worktree-only eol artifacts (see VERIFIED OPEN — eol policy); (c) tool-generated artifacts (vendored cores, generated presets, golden JSONs) that no emitter formats.
- Fix: `.prettierignore` now scopes the gate to first-party code (vendored plugin-core trees = script-generated mirrors, same precedent as `public/licenses/`; generated presets + golden JSONs = emitters own the byte shape); 34 first-party files formatted.
- Verification: prettier --list-different on committed content before/after; typecheck 0; targeted suites green.
- Files changed: .prettierignore + 34 files
- Date/session: 2026-10-06, commit `a3823bbb`

### Three suites still tested the deleted inline multitap runtime
- Area: tests/invariants, tests/fx-tempo-sync, tests/multi-tap-delay
- Root cause: multi-tap migrated to an AudioWorklet wrapper (449039ad era); pins and fake-context tests never followed.
- Fix: invariant #7 pin now documents MixPreviewChipLazy (kyx_mix_idea A/B preview, private-context owner, 65e117f8) next to SpectralEditPanel; tempo-sync grep points at multitap-node.ts's scheduled-write path; live-sync tests drive createMultitapNode directly (beatmangler fake-worklet pattern).
- Verification: 44 tests green across the three files.
- Date/session: 2026-10-06, commit `d9304cc3`

### kyx_mix_idea landing missed its own surface bookkeeping
- Area: MCP surface contracts
- Root cause: the 35th tool shipped with mirrors synced but count pins (34), name lists, and the ROT GUARD playbook text untouched; two adjacent tests also raced the Fáza 2b factory-bank warm gate.
- Fix: pins 34→35 with kyx_mix_idea in MCP_TOOLS order; playbook documents it inside the 8000-char compactness budget (diagnose_mix gloss compressed to pay); checkpoint-diff test awaits its mutations (probe-verified product code was correct); web-host crash test polls for the mcp-result with a 5 s bound; mirrors regenerated.
- Verification: mcp family + desktop-mcp + mirror-sync 57 tests green.
- Date/session: 2026-10-06, commit `6ee711a5`

### Contract pins lagged three shipped features
- Area: domain goldens, gallery REST, ux-audit shortcut table
- Root cause: pitchCorrect (47→48 effects — CURRENT-STATE already said 48) without golden re-capture; 091b8cfb subpath-mount share-link change without serialization re-capture; battles flywheel (9d5d3b0b) response shape; ROADMAP-UI-2027 V1 Alt+7/8 shortcuts.
- Fix: goldens:capture re-run — surgical diff (+10 lines pitchCorrect row, 1 line share code; decode-goldens preserved by design); pins updated to current contracts.
- Verification: domain-goldens 12/12, gallery-server 22/22, ux-audit green.
- Date/session: 2026-10-06, commit `9e477015`

### Ultina group-bus automation pin predated 16th-grid interpolation
- Area: tests/ultina-core-hardening
- Root cause: AutomationBridge (badfd106) interpolates continuous device params on a 16th-note grid; the pin expected the pre-decomposition endpoint-only writes.
- Fix: pin follows the documented interpolation (5 writes for a 480-tick ramp).
- Verification: 60/60 green.
- Date/session: 2026-10-06, commit `4061bdcb`

### ZENIT/M2 param audit: one dead knob, one broken macro coupling, CI typecheck red
- Area: ZENIT composite + APEKS/ŠÍRKA/PRÚD (docs/ZENIT-M2-PARAM-AUDIT-2026-10-06.md)
- Root cause (×3): APEKS release blended the GR one-pole with the KEEP fraction (≈1) instead of (1−keep) — knob inaudible; ZENIT ceiling moves never re-derived the LIMIT threshold (macro coupling broken + load-order dependent); the M2 wave committed tests/m2-dsp.test.ts importing untyped processor .js without the house .d.ts stubs — tsc red on main since the landing.
- Fix: relBlend form + bundle rebuild; limit value tracked + re-derived on ceiling, order-independent; three .d.ts stubs.
- Verification: 12 new pins (tests/zenit-m2-param-audit.test.ts) — 9 macros both extremes → stage writes, coupling incl. load order, def↔processor descriptor equality, 23-param aliveness with designed excitations; 26/26 across the three families; typecheck EXIT 0; browser audit's 12 DEAD flags: 11 explained as harness artifacts, 1 real.
- Design question (owner, not changed): APEKS preserve audible window structurally narrow (~6e-4 best measured) — guard clamps the region preserve would shape; levers sketched in the audit doc.
- Date/session: 2026-10-06, commits 308c15f9 + a8a84939 (part of the fix absorbed into the sibling's 218fc3d9)

### Honest-gate sweep: two estimators promoted stationary input into confident readings
- Area: `src/reference/analysis/rhythm.ts` (F1 lane) + `src/ai/audio-tempo-key.ts` (estimateTempo gate placement, estimateKey); full audit in `docs/HONEST-GATE-AUDIT-2026-10-06.md`
- Root cause: confidence mixes dominated by SELF-NORMALIZED scores (share of the signal's own max) with no absolute floor. F1 reported "86 BPM @ 0.585, no warning" on a bare sine and "~126 BPM @ 0.640" on pink noise; estimateKey fabricated keys on any noise color (margin cannot gate: real boombap 0.025 vs pink 0.235); the dfe6bf06 tempo crest gate sat on the baseline-REMOVED envelope where removal AMPLIFIES noise wobble (5.9/6.0 raw → 10.5/10.8 removed) so pink leaked.
- Fix: shared `onsetEnvelopeCrest()` + `ONSET_CREST_FLOOR = 8` in spectralFlux.ts; analyzeRhythm gates the RAW envelope (stationary ≤ 5.3, rhythmic ≥ 11.5); estimateTempo gate moved to the raw envelope (stationary ≤ 6, clicks ≥ 36); estimateKey gains two measured absolute floors (chroma concentration ≥ 2, best correlation ≥ 0.6 — bare sine keeps its root by design).
- Verification: `tests/honest-gates.test.ts` (10 specs) green; C-sustained-note reference snapshot honestly regenerated (phantom "65 BPM @ 40%" → null + "No reliable tempo detected", diff reviewed); unsuno golden KPI floors (tempo 5/5, key 5/5, chords 36/36) + full reference family 209 tests green; safe estimators verified (tonal F2, chords 0.55, bass/melody YIN gates, intent abstain margin).
- Date/session: 2026-10-06, commit `426cc1cd`

## VERIFIED OPEN

### Intent/symbolic/grooves/melodic + engine-pin test family (~24 tests) red — NOW MACHINE-READABLE
- Area: **the classification lives in `suite-expectations.json` (repo root) as of 2026-10-06** — this prose entry is the narrative companion, the JSON is the source of truth the gate enforces.
- Families (24 entries, recordedAgainst 445c117d): intent-model artifact pins ×7, symbolic/grooves/melodic wave ×8, ONNX model-pack hashes ×2, sample-license credits render ×1, engine source-grep pins (trigger/warp, waves 4e/4f) ×2, vendor SDK owner gates asio+clap ×3(+collection), SFT corpus ×1.
- Evidence: seeded from a full-suite JSON run in the clean D:/pf-verify worktree at 445c117d (824 files · 8982 passed · 24 failed · 121 skipped); `npm run test:expectations:eval` exits 0 against that report.
- Root cause: mixture — in-flight concurrent waves, artifact re-pins dependent on gitignored local datasets, engine refactor pins not yet updated, credits render stale.
- User/system impact: none new — pre-existing, owned.
- Why unresolved: active ownership by concurrent sessions' waves; re-pinning mid-refactor would break again.
- Recommended next action: **when a wave lands, the ratchet tells you what to do** — cured entries FAIL the gate until removed from the ledger; a wave that fixes its reds deletes its own entries (baseline only shrinks). New reds must be fixed or classified with owner+reason.
- Priority: enforced by `npm run test:expectations` (CI test job) — no longer priority-tracked by hand

### format:check still red on ~35 eol-artifact files + in-flight sibling files
- Area: Prettier gate, whole repo
- Evidence: committed content of those files passes Prettier; worktree copies differ only in CRLF/LF. `core.autocrlf=true`, NO `.gitattributes` exists.
- Root cause: the repository has no eol policy; any git checkout rewrites worktree files to CRLF while Prettier's default endOfLine is LF. Normalizing worktree copies to LF makes them git-phantom-modified instead — there is no state that is both git-clean and Prettier-clean on this machine.
- User/system impact: the documented merge gate cannot go fully green on Windows checkouts; noise in every git status.
- Why unresolved: the fix (`* text=auto eol=lf` + `git add --renormalize .`) rewrites every text file — high-churn, must be done in a quiet window with no concurrent sessions.
- Recommended next action: dedicated session: add .gitattributes, renormalize, verify fresh-clone format:check + build, coordinate via this file.
- Priority: high (structural, keeps re-breaking a merge gate)

### Tool emitters don't format their output
- Area: scripts/capture-domain-goldens.mts (JSON.stringify vs Prettier style), preset-pack generators (measure-preset-loudness.mjs etc.)
- Evidence: golden JSONs + *.generated.ts were the bulk of real format drift; now prettier-ignored, so the gate no longer forces it.
- Root cause: emitters write raw serializations; nothing runs Prettier on their output.
- Why unresolved: cosmetic; ignoring was the safe shared-tree move.
- Recommended next action: make each emitter pipe through prettier.format, then remove the corresponding .prettierignore lines.
- Priority: low

## NEEDS INVESTIGATION

### docs/AGENTS.md effect/instrument counts drifted from CURRENT-STATE
- Area: AGENTS.md §2 ("42 core effects", "15 instrument kinds" vs CURRENT-STATE 48 effects / memory's 22 instruments)
- Suspicion/evidence: AGENTS.md repository-map one-liners were never bump-tracked; CURRENT-STATE is the canonical count file.
- What remains unknown: exact instrument count from a fresh grep; whether other AGENTS.md numbers drifted.
- Recommended investigation: one docs session, counts reproduced by grep only.

## BLOCKED

### Deployed smoke + LICENSE (carried from earlier campaigns)
- Blocker: user-owned deploy URL + LICENSE decision.
- Required dependency / information / environment: `KYX_DEPLOY_URL`, LICENSE file.
- Safe next action once unblocked: `npm run release:deployed-smoke`.

## DO NOT TOUCH

### Stem separation (UN-SUNO S-wave) + loudness/mixer refactor zone
- Reason: a concurrent session is actively working here (S0 HPSS core f493d5ef + 8f0de079 loudness harness; worktree edits in AudioEngine.ts, meteringRig.ts, Meter.tsx, Mixer.tsx, intentRouting.ts, measure-preset-loudness.mjs, preset-loudness*, 03-mixer.css during this session).
- Known constraint: shared working tree — stage explicit paths only, commit early.
- Conditions under which modification would become safe: their wave commits and this file records it.

## DEFERRED / OUT OF SCOPE

### `.gitattributes` eol policy + renormalization
- Reason: high-churn mechanical rewrite of every text file; unsafe on a shared tree with live concurrent sessions.
- Relevant future campaign: Build & Toolchain, quiet-window session.

### AGENTS.md count refresh
- Reason: docs-only, needs a grep-verified sweep; not blocking.
- Relevant future campaign: Documentation ↔ Code Reconciliation.

## IMPORTANT INVARIANTS

- The ten AGENTS.md §3 invariants (UI intent / model truth / transport time / scheduler events / engine execution; no React realtime truth; one engine live+offline; determinism; AudioWorklet boundary; schema versioning; useContext sole AudioNode path; ADR 0014 scope honesty; no WASM DSP path shipped; no innerHTML/eval).
- **Pins follow features in the same commit.** This session's whole second half was feature waves that shipped without their contract pins (count lists, ROT GUARD docs, goldens, shortcut tables). When adding a tool/effect/shortcut: update mcp pins + playbook + CURRENT-STATE + goldens in the SAME commit.
- **goldens:capture blesses drift by design** — always review the capture diff before committing; decode-goldens.json is never regenerated.
- **Never pipe gate runs through `tail`** (exit codes and full failure lists are lost — relearned 2026-10-06 at the cost of a re-run).

## HIGH-RISK AREAS

- Shared working tree with live concurrent sessions:
  - Why risky: absorbed commits, in-flight edits mid-typecheck, new unformatted files appearing between scans.
  - Relevant files/modules: docs/MULTI-AGENT-GUARDRAILS.md (protocol), git status before every batch.
- MCP surface:
  - Why risky: four coupled artifacts (src/mcp/tools.ts, generated mirrors, playbook/vocab text, count pins in 3 test files) — the mirror-sync test only covers the mirrors.
  - Relevant files/modules: src/mcp/tools.ts, src/mcp/onboarding.ts, tests/mcp-*.test.ts, desktop/mcp-tool-defs.cjs, server/mcp-core.mjs.

## RECENT VALIDATION

- Command/check: `npm run typecheck` — EXIT 0 (final HEAD a70f5a49; the build's tsc also caught one dead helper the earlier typecheck predated — re-run typecheck after EVERY edit batch).
- Command/check: full vitest at 5ab7bbc7 in the clean D:/pf-verify worktree — **822 files: 804 passed / 18 failed; 9109 tests: ~23 failed / 140 skipped**. All 18 failing files are the owned family above (verified: the 5 non-10-03-classified ones also fail solo at the pre-session commit 8f0de079). Every failure this campaign touched is green: vocal-profile, wiring, multitap ×3, fx-tempo-sync, invariants, ultina, goldens ×2, gallery, ux-audit ×2, mcp-core ×2, mcp-onboarding, mcp-web-host, mcp-checkpoint-diff, desktop-mcp.
- Command/check: `npm run build` — EXIT 0 at a70f5a49, all budgets respected (entry 255/1070, DAW 3839/5000, worklets 137/150, on-demand 640/650, boot path 2129/2400).
- Command/check: `npm run format:check` — **zero real first-party drift at HEAD**; remaining red = 34 eol artifacts (committed content clean; VERIFIED OPEN) + the concurrent wave's in-flight files.
- Relevant notes: sibling session's worktree edits typechecked clean by session end (their getTrackPreMeterSnapshot gap closed mid-flight).

## NEXT HIGHEST VALUE WORK

1. Quiet-window `.gitattributes` eol policy + renormalize (unblocks a permanently green format gate).
2. After the intent/symbolic/grooves wave commits: solo re-run of the ~14-test owned-red family; re-classify stragglers.
3. AGENTS.md count sweep (grep-verified) + the deferred emitter-formatting work.
4. Re-establish the fresh-clone bootstrap check (`npm install && npm run dev` on a clean machine) — last verified 10-03.

## SESSION LOG

### 2026-10-06 (follow-up 3) / ZENIT + M2 param audit (user-picked proposal 1)
- Inspected: all five new mastering surfaces against NEW-EFFECT-CHECKLIST (5 death modes, 5 registration surfaces, per-param min/max rule); ran the worklet-loaded browser audit on the four effects (report in docs/); probe-measured APEKS release/preserve across six excitation families.
- Fixed: APEKS release dead knob; ZENIT ceiling↔limit coupling; .d.ts trio (CI typecheck red since M2 landing).
- Verified: 26/26 across zenit-m2-param-audit + m2-dsp + zenit-composite; param-range-coherence + honest-gates green; typecheck EXIT 0; shipped bundle contains the fix.
- Design question recorded: APEKS preserve narrow window (owner decision).
- Commits: 308c15f9, a8a84939 (+ sibling absorb 218fc3d9).
- Recommended continuation: wave 2 honest-gate sweep (src/vocal + src/analysis) or drift:check — both still open.


### 2026-10-06 (follow-up 2) / Honest-gate sweep — confidence metrics audit (user-picked idea C)
- Inspected: every confidence producer in src/reference/ + src/ai/ (11 entries classified, verdict table in docs/HONEST-GATE-AUDIT-2026-10-06.md); adversarial probe (sine, white/pink/lowpassed noise, silence, clicks, 5 golden fixtures) with measured thresholds.
- Fixed: F1 analyzeRhythm crest gate (phantom "86 BPM @ 0.585 no warning" on sine, "~126 @ 0.640" on pink → honest null); estimateTempo gate moved to the RAW envelope (baseline removal amplifies noise wobble — pink leaked the removed-envelope gate); estimateKey dual absolute floor (concentration ≥ 2 + correlation ≥ 0.6).
- Verified: honest-gates.test.ts 10/10; reference family + estimators + unsuno golden KPIs 209/209; snapshot diff reviewed then regenerated; typecheck clean on my files (2 remaining tsc errors = sibling's untracked studio-io.test.ts + asio-host-manager.cjs mid-landing).
- Unresolved (documented, not bugs): analyzeTonality returns low-confidence tonic on noise with warning (wording vs. null gap, left as-is); src/vocal + presets/audioQuality out of scope.
- Commits: 426cc1cd (sweep), this commit (docs/count).
- Recommended continuation: let the ratchet drive; next window = eol policy session (item 1) or the vocal/presets confidence follow-up sweep.

### 2026-10-06 (follow-up) / Suite expectations ledger — the Chromium ratchet (user-picked top idea)
- Built: `scripts/suite-expectations.mjs` (+ `.d.mts` types, 17 unit pins) — parses vitest `--reporter=json`, diffs against `suite-expectations.json`: new reds FAIL, cured reds FAIL (baseline only shrinks), TODO owners FAIL, `flaky:true` exempts both ways, collection errors surface as pseudo-ids. `npm run test:expectations` (--run + eval), `:eval` re-evaluates the last report; CI's test job runs it instead of plain `npm test`.
- Seeded: full-suite JSON run in the clean worktree at 445c117d (824 files · 8982 passed · 24 failed · 121 skipped) → ledger with 24 classified entries across 7 owned families; eval exits 0.
- Found on the way (fixed): **shebang + CRLF breaks vite's transform** — `#!/usr/bin/env node` on a test-imported `.mjs` + a Windows checkout (autocrlf, no .gitattributes) = "Invalid or unexpected token" while plain node parses the same bytes; shebang dropped (445c117d), precedent `validate-intent-ranker-golden.mjs` is shebang-free too. Cross-tree report normalization anchored at `/tests/` (38e8620d).
- Commits: 10b3a770 (machinery + wiring), 445c117d (shebang fix), 38e8620d (cross-tree ids), this commit (seeded ledger + docs).
- Caveats: ledger's `recordedAgainst` is 445c117d — the sibling landed 97e48846+ during seeding, so the NEXT full eval will legitimately flag diffs (their cured/new reds); that is the ratchet working, follow its instructions. CI (ubuntu) vs local (windows) may diverge on soak-boundary flakes → use `flaky:true` with owner+reason if that materializes.
- Recommended continuation: NEXT HIGHEST VALUE WORK item 1 (eol policy — would also retire the shebang/CRLF hazard class entirely), then let the ratchet drive ledger shrinkage.

### 2026-10-06 / Build & Toolchain — gate integrity & post-feature verification
- Inspected: CAMPAIGN_STATE (closed predecessor), git history (UN-SUNO U0–U7 + concurrent stem-separation S0 + loudness waves), 103 Prettier-flagged files (classified against committed content), full-suite failure set (34 → 32 → 23 fails across runs) against the 10-03 baseline classification, D:/pf-verify worktree at HEAD for falsification (5 suspect failures proven pre-existing at 8f0de079).
- Fixed: 10 commits — dfe6bf06 (tempo honesty gate + wiring fixture), a3823bbb (format gate scoping + 34 files), d9304cc3 (multitap/invariants re-pins), 6ee711a5 (MCP surface bookkeeping ×5 files), 9e477015 (goldens/gallery/ux-audit re-baselines), 4061bdcb (ultina pin), 5ab7bbc7 (format follow-up), a70f5a49 (dead helper).
- Verified: every fix green solo at HEAD; typecheck EXIT 0; full suite 804/822 files green with all 18 remaining failures owned/classified; production build EXIT 0 with budgets respected.
- Unresolved: eol policy (VERIFIED OPEN, high), owned intent/grooves/engine-pin family (VERIFIED OPEN, medium), emitter formatting (low), AGENTS.md counts (NEEDS INVESTIGATION).
- Tests/checks: see RECENT VALIDATION.
- Recommended continuation: NEXT HIGHEST VALUE WORK items 1–2.
