# COMPATIBILITY — what we will never break

> The user-facing half of `docs/LONGEVITY.md` (§0: _every feature ships with its
> pin_). This page is a promise with tests behind it; each promise names the
> command that proves it. If one of these breaks, that is a bug of the highest
> severity — report it before working around it.

## Never breaks

| Promise                                                                                                                             | Proven by                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **v1 share codes open forever.** A link someone saved in 2026 keeps working.                                                        | `tests/compatibility-golden.test.ts` decodes a committed golden code from 2026-10-17 and requires the recorded shape |
| **Old projects migrate forward.** Loading an older project produces a document at the current schema version.                       | the same suite: `migrateProject` on the decoded golden lands on `SCHEMA_VERSION`                                     |
| **Projects from the future are refused, not guessed.** A file written by a newer build fails loudly instead of loading half-broken. | the same suite's negative: a bumped `schemaVersion` throws _"newer than supported"_                                  |
| **The export manifest format is versioned.** Readers reject a `format` they do not know rather than interpreting it.                | `tests/render-manifest.test.ts` (parser rejects unknown formats) + `docs/KYX-REPRODUCIBILITY-PROTOCOL.md` §7         |
| **A 32-bit float export can be checked by anyone, offline.**                                                                        | `npx kyx-verify <file.wav>` recomputes the hash from the file's own samples                                          |
| **Snapshots and the crash journal stay readable.** Their shapes are additive; old entries keep parsing.                             | persistence round-trip suites + `tests/trust-report.test.ts` (degradation is reported, never guessed)                |
| **Counts in `docs/CURRENT-STATE.md` stay true.** Every number is reproducible from the tree.                                        | `npm run drift:check`                                                                                                |

## May change (and that is fine)

- UI text, layout, colours and panel organisation.
- Internals: module boundaries, file names, function signatures.
- Defaults (tempo, candidate counts, effect defaults) — the project file records
  what it uses, not what the default was.
- Performance characteristics, bundle composition, lazy-loading seams.

## Known limits, stated honestly

- **Renders are only hash-comparable within the same KYX build.** The manifest
  records when a file was rendered but not the engine version, so if the engine
  improves, re-rendering the same project produces a different hash. The stamp
  still proves the FILE is intact (`kyx-verify`); reproducing the render
  bit-exactly requires the build that wrote it. A future manifest revision is
  the place to record the engine version — until then, this limit is the
  honest answer.
- **A new share code does not open in an older build.** Backward compatibility
  (old code → new app) is promised; forward compatibility is not, and cannot be.
- **Third-party plug-in ABI does not exist yet**, so nothing is promised about
  it. When it ships, it gets its own promise and its own pin.
- **Audio hardware paths** (device latency, sample rates) are environment-
  dependent; the app measures and reports them rather than promising numbers.

## How to add a promise

1. Write the claim here and the command that proves it, in the same commit as
   the mechanism.
2. If it needs a fixture, extend the existing golden fixtures — never replace
   them, and never regenerate a fixture to make a failing test pass.
3. If a promise must be broken (rare, and never silently), say so in this file
   with the reason and the migration path, and open an ADR.
