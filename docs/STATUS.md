# KYX STATUS — the claims, and the commands that check them

Generated 2026-10-27T06:19:51.118Z · **5 pass · 0 fail · 4 pending · 0 not run**

> This page is a measurement table, not marketing. A row is PASS only from a real exit code.
> `drift-checked` rows are re-run and compared by `npm run drift:check`; `at-generation` rows show
> when they were recorded and are never implied to be fresher than that.

## Claims

| State | Claim | Command | Measured | Freshness |
| ----- | ----- | ------- | -------- | --------- |
| ✓ PASS | Every user-facing seam is declared with an entry-point spec and a negative assertion | `node scripts/check-seam-coverage.mjs` | 1 check(s), 88 seams | drift-checked |
| ✓ PASS | docs/CURRENT-STATE.md's spec-file count equals the committed tree | `git ls-files tests (spec-file count vs docs/CURRENT-STATE.md)` | 1284 claimed, 1284 measured | drift-checked |
| ✓ PASS | The deterministic taste benchmark still matches its committed baseline | `npm run taste:benchmark (harness re-run + committed baseline diff)` | score 1 · deterministic=true · 0 drift row(s) | drift-checked |
| ✓ PASS | A stamped master verifies offline with the published verifier | `npm run verify:wav:fixture -- <tmp>/stamped.wav && node tools/kyx-verify/kyx-verify.mjs <tmp>/stamped.wav` | VERIFIED (exit 0, hash recomputed from the file) | drift-checked |
| ✓ PASS | VLYX sound identity: target correction reduces the mean deviation from the reference curve | `tests/fixtures/vlyx-claim/vlyx-claim-v1.json (golden) + src/analysis/vlyxClaim.ts` | mean deviation from the reference curve 2.7 → 1.6 dB (−1.1 dB, 5/10 bands) | drift-checked |

## Manual gates (the owner's hands — pending is pending)

- … PENDING **Manual Firefox / Safari / iOS Safari smoke** — `docs/KYX-SAFARI-IOS-MANUAL-QA.md`
- … PENDING **Release preflight (explicit production config + shipped artifacts scan)** — `npm run release:preflight`
- … PENDING **Collab server boots and answers /api/health** — `npm run release:server-smoke`
- … PENDING **Deployed-smoke against a real deployment (needs KYX_DEPLOY_URL)** — `npm run release:deployed-smoke`

## Deliberately not run by this command (too slow for a report)

- Strict typecheck — `npm run typecheck`
- Full Vitest suite + expectations ledger — `npm run test:expectations`
- All derivable artifacts (mirrors, goldens, counts) — `npm run drift:check`
- Golden doctor (frozen artifacts match their hashes) — `npm run goldens:doctor`
- Production build + bundle budgets — `npm run build`
- Real-browser audio verifier — `npm run test:browser`

## Regenerate

```bash
npm run status:report     # re-runs the cheap claims and rewrites this page
npm run drift:check       # fails when a drift-checked row is stale
```

