# Import / Export Robustness Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 01_COMMON/07_IMPORT_EXPORT_ROBUSTNESS.md`

## Audit-specific mission

Audit all import and export surfaces for malformed input, unsupported content, oversized files, strange filenames, cancellation, partial reads/writes, codec failures, missing metadata, extreme durations, and interruption.

Verify imports either succeed completely or fail without partially mutating the active project. Verify exports use safe temporary output/atomic completion where appropriate, clean up abandoned artifacts, preserve intended timing and levels, and surface precise errors.

Add adversarial tests using empty files, truncated files, unsupported files, duplicated names, long paths/names, zero-length media, extreme durations, and cancellation at multiple stages. Fix proven weaknesses.
