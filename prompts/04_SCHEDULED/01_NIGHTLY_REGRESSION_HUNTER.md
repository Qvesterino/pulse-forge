# Nightly Regression Hunter

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 04_SCHEDULED/01_NIGHTLY_REGRESSION_HUNTER.md`

## Scheduled mission

Perform an autonomous reliability pass focused on finding real defects rather than generating a large report.

Rules for this run:
- prioritize recently changed or weakly tested code, then critical paths;
- find one high-confidence reliability issue at a time;
- reproduce/prove it;
- fix it with the smallest safe patch;
- add regression coverage;
- run targeted validation;
- continue while safe, useful defects remain.

Do not perform speculative refactors, formatting sweeps, mass dependency upgrades, or architecture rewrites. If no defensible defect remains, stop and report that outcome instead of inventing work.
