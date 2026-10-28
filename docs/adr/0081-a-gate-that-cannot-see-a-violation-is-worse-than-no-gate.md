# ADR 0081 — A gate that cannot see a violation is worse than no gate

Date: 2026-10-28 · Status: Accepted (shipped) · Scope: test gates, architecture layers

## Context

`tests/architecture-layers.test.ts` is the repo's long-term erosion defence: it walks the source tree and fails when
a forbidden layer imports a protected one.

On the dev machine it had been green for as long as it existed. It was not working.

```ts
function underDir(absPath: string, dirPrefix: string): boolean {
  return absPath.startsWith(resolve(process.cwd(), dirPrefix) + "/");
}
```

The separator was hardcoded. On Windows the paths use `\`, so `startsWith` matched **nothing** — every rule reported
"no violations" without ever looking at a single import. The gate was green in the exact way a broken smoke detector
is green: it reports all-clear because it cannot see the smoke.

Linux (CI) uses `/`, so the same commit was **red** there — three real violations that the dev machine had been
hiding:

| Rule                                         | Violation                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| MCP protocol is UI-agnostic                  | `src/mcp/mix-idea.ts` imports `src/ui/fxAddAssistant.ts`                                                                  |
| audio-engine is self-contained (persistence) | `src/audio-engine/PcmMicRecorder.ts` and `PcmMicRecorderGroup.ts` import `src/persistence/RecordingRecoveryRepository.ts` |

## Decision

1. **Containment is computed with `path.relative`**, which answers the same way on every platform.
2. **The gate tests its own check.** A new spec asserts that a known in-repo path is recognised as inside its layer —
   the blind spot becomes a red test, not a silent green.
3. **The three violations are fixed, not carved out.** The ledger's contract (`suite-expectations.json`) says to keep
   the owned-red list empty: any new red is a regression.

The fixes:

- `applyEffectIntentOnTrack` — a pure command builder that happened to live in a UI module — moved to
  `src/effect-intent/applyOnTrack.ts`; the UI re-exports it, so the component import path is unchanged, and `src/mcp`
  no longer reaches into `src/ui`.
- The capture recorder no longer constructs storage: `recovery` is a **required** dependency, injected by the
  composition root (every call site already passed one). The two values it needed from the persistence module — the
  per-tab owner identity and the storage-quota error — moved to the shared layer (`src/shared/recordingOwner.ts`,
  `src/shared/recordingQuota.ts`) and are re-exported by the persistence module, so every existing importer keeps
  working unchanged.

## Consequences

- The gate is green for the right reason: it looked, and found nothing.
- The audio engine's dependency on the recovery layer is now type-only, plus two shared vocabulary values.
- The same separator trap was hunted across the other gates in the same pass: the VST3 scan-directory spec asserted
  hardcoded `C:\…` literals while the manager joins with the _platform_ separator, so it was red on Linux and green on
  Windows. It now builds its expectations with `path.join`, like its CLAP sibling spec.
