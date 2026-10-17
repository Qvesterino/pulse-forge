# AGENT MAP — where things live, what guards them

> Read this right after `AGENTS.md`. That file states the rules; this map routes
> you to the files for a task and registers the field-hardened invariants with
> the test that enforces each one.
>
> **This map cannot rot.** `tests/agent-map.test.ts` parses the tables below and
> fails when any referenced path or npm script stops existing, when an invariant
> loses its guard, or when a table is gutted. If you change a guard's filename,
> change it here in the same commit — the gate will remind you.

---

## 1. Boot in five commands

```bash
npm install
npm run dev            # vite on 127.0.0.1:5173 (predev rebuilds the worklets)
npm run typecheck      # strict tsc --noEmit
npm run test           # vitest (count in docs/CURRENT-STATE.md)
npm run build          # production build + bundle budgets
```

Before you "fix" a red: run `git status --porcelain`. This tree is shared by
several agent sessions; the ratchet gate now labels each new red with the dirty
file that explains it (`[IN-FLIGHT: …]`) and lists the in-flight files.

## 2. Task routing — "I need to change X"

| I need to…                                      | Start with                                                                                              | Run before done                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Change the audio graph, metering taps or PDC    | `src/audio-engine/AudioEngine.ts`, `src/audio-engine/meteringRig.ts`, `src/audio-engine/masterChain.ts` | `npx vitest run tests/engine-graph-census.test.ts tests/engine-graph-reachability.test.ts tests/master-finish.test.ts`                           |
| Add or tune an effect / worklet DSP             | `src/effects/registry.ts`, `src/audio-worklets/`, `docs/NEW-EFFECT-CHECKLIST.md`                        | `npx vitest run tests/effects-eq-curve.test.ts`, `npm run build`                                                                                 |
| Add an instrument or a factory preset           | `src/instruments/registry.ts`, `src/presets/factory.ts`                                                 | `npm run test:browser:factory-presets`                                                                                                           |
| Touch intent routing or the text parser         | `src/intent/text-parser.ts`, `src/intent/route.ts`, `src/intent/conversation.ts`                        | `npx vitest run tests/intent-routing-lexicon.test.ts tests/intent-text-parser.test.ts tests/studio-words.test.ts tests/intent-e2e-audit.test.ts` |
| Change the project model, schema or a migration | `src/project-model/schema.ts`, `src/project-model/types.ts`                                             | `npx vitest run tests/persistence/schema-evolution.test.ts` (bump `SCHEMA_VERSION`)                                                              |
| Persistence, IndexedDB repositories             | `src/persistence/`                                                                                      | `npx vitest run tests/persistence/`                                                                                                              |
| Offline render, bounce, stems or export         | `src/rendering/renderer.ts`, `src/export/`                                                              | `npx vitest run tests/offline-parity.test.ts`                                                                                                    |
| A UI panel, dock surface or gesture             | `src/ui/`, `tests/seam-manifest.json`                                                                   | `node scripts/check-seam-coverage.mjs`                                                                                                           |
| Re-pin a frozen golden artifact                 | `tests/helpers/golden-doctor.ts`                                                                        | `npm run goldens:doctor`, `npx vitest run tests/golden-doctor.test.ts`                                                                           |
| The MCP tool surface                            | `src/mcp/tools.ts`                                                                                      | `npm run gen:mcp-mirrors`, `npx vitest run tests/mcp-mirror-sync.test.ts`                                                                        |
| Collaboration, Yjs docs or the relay            | `src/collab/YDocStore.ts`, `server/collab-server.mjs`                                                   | `npx vitest run tests/collab/`                                                                                                                   |
| The suite ledger, reds and the ratchet          | `suite-expectations.json`                                                                               | `npm run test:expectations`                                                                                                                      |
| Docs, counts and derivable artifacts            | `docs/CURRENT-STATE.md`                                                                                 | `npm run drift:check`                                                                                                                            |

## 3. Invariant register — hard-won truths and their guards

Each row is a truth discovered the hard way (a shipped defect, a silent no-op, a
dead meter). Never "simplify" a row's guard away without re-proving the row.

| Invariant                                                                                                         | Guarded by                                 | Why it exists                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| A group track lives ONLY in `groupNodes`; a group id in `trackNodes` is a silent duplicate strip                  | `tests/engine-graph-census.test.ts`        | The duplicate strip's analysers read silence — every group meter read 0 (ADR 0048)                                 |
| PRE-fader taps and PDC delays are allocated lazily; a chain without effects owns no delay                         | `tests/engine-graph-census.test.ts`        | 100 dry tracks paid 209 analysers and 103 delays for meters nobody showed                                          |
| Every strip output reaches `ctx.destination`; only `MasterChain.build` may pre-build nodes                        | `tests/engine-graph-reachability.test.ts`  | Catches the "exists but never wired" class, including a future mixer-worklet migration                             |
| A failed sample persistence rolls the in-memory bank back (no ghost samples)                                      | `tests/sample-import-rollback.test.ts`     | A quota failure left samples playable now, gone after reload, unlisted in the library                              |
| No phrase table shadows a token with a second target; cross-lane overlaps are exactly the documented dual effects | `tests/intent-routing-lexicon.test.ts`     | Order resolves the tables; a shadowed entry is dead text one careless edit from flipping a lane                    |
| Bare "swing" is a groove modifier, bare "garage" stays house, "big beat" routes to `house.bigbeat`                | `tests/intent-text-parser.test.ts`         | Three real routing collisions fixed in one session; the lexicon gate pins the class                                |
| Reactions REORDER gated candidates, never create, drop or edit one; the kill switch wins at the surface           | `tests/reaction-choice-bias.test.ts`       | The F2 bias guard's contract — enforced at the chips a human actually clicks                                       |
| A proposal is registered only for a REAL state change through a REAL store                                        | `tests/ui/reaction-ledger-wiring.test.tsx` | The ledger's before/after postcondition; a mock store silently registers nothing                                   |
| The arrangement grid follows the viewport, not the project length                                                 | `tests/ui/arrangement-dom-census.test.tsx` | One div per bar was O(project length); `MAX_ARRANGEMENT_CLIP_BARS` exists for the unmeasured fallback              |
| Frozen goldens carry semantic summaries; a re-pin must show the diff                                              | `tests/golden-doctor.test.ts`              | Hash swaps were opaque; five artifacts were re-pinned with hand-written debug specs                                |
| Live and offline render share the same engine (invariant 3 of AGENTS.md)                                          | `tests/offline-parity.test.ts`             | Exports must sound exactly like the project                                                                        |
| MCP mirrors are GENERATED — never hand-edit them                                                                  | `tests/mcp-mirror-sync.test.ts`            | The tool/resource surface lives in `src/mcp/tools.ts`; mirrors are locked by this test                             |
| The suite ledger may only shrink; an unclassified red is a process bug                                            | `tests/suite-expectations.test.ts`         | New reds AND cured reds both fail; `flaky: true` is the only exemption                                             |
| A user-facing seam enters the REAL entry point and proves the no-op                                               | `tests/eq-curve-gesture.test.tsx`          | The reference: 8 of 12 specs are negative assertions; a happy-path-only seam test cannot see the shipped bug class |

## 4. Working in a shared tree

- **Claim a lane before you edit.** Multiple sessions share this checkout;
  prefer areas nobody is touching, and stage only files you authored.
- **A commit sweeping your work is normal.** Do not amend, rebase or relabel it
  — verify the content landed and move on (`docs/MULTI-AGENT-GUARDRAILS.md`).
- **Reds that are not yours:** the expectations gate labels them `[IN-FLIGHT]`
  with the dirty file. Do not "fix" an in-flight file; re-run once the wave
  settles (`npm run test:expectations`).
- **Before you finish:** `node-gc` for abandoned test runtimes (never
  `taskkill /F /IM node.exe`), and `git status` to confirm what you touched.

## 5. Re-pinning a frozen golden (the reviewable loop)

1. `npm run goldens:doctor` — read the semantic diff per case (`STRUCTURAL` vs
   `values-only drift` vs `clean`), not just the hash.
2. If the change is intended: `npm run goldens:doctor -- --bless` (npm may eat
   the flag — `GOLDEN_DOCTOR_BLESS=1 npm run goldens:doctor` always works),
   then update the artifact's own fixture in the same commit.
3. State the reason in the fixture comment (what moved and why) — the doctor's
   diff is the evidence for that sentence.
4. `npx vitest run tests/golden-doctor.test.ts` and commit the hash, the
   summaries and the comment together.
