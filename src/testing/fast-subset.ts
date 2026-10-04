/**
 * Fast commit subset (DAW audit 12 → release-gate hardening).
 *
 * A curated, registry-independent list of spec files that cover the
 * load-bearing invariants of the project in well under a minute on an idle
 * machine (~25-35 s measured on a loaded shared runner). This is the
 * "every commit" gate — the full Vitest suite plus the real-browser audio
 * suite remain the release gates.
 *
 * Selection rules:
 *   - audio engine lifecycle, context swaps, dispose containment, parity
 *     obligations (the areas most likely to be broken by refactors);
 *   - scheduler/transport timing contracts;
 *   - project model + invariants + architecture purity;
 *   - import/export + security fuzzers (hostile input paths);
 *   - MCP mirror sync (generated mirrors drift silently otherwise);
 *   - boot-graph budget (heavy domains must stay lazy).
 *
 * Every entry MUST resolve to a real file — `tests/fast-subset-guard.test.ts`
 * fails the normal suite when one is renamed, so the subset can never
 * silently shrink into a no-op. Keep the list under ~30 files: if the guard
 * trips its size ceiling, delete something instead of raising the ceiling.
 */
export const FAST_SUBSET = [
  // ── Audio engine: lifecycle, swaps, teardown, regressions ──
  "tests/audio-engine-lifecycle.test.ts",
  "tests/audio-engine-audit12.test.ts",
  "tests/audio-engine-audit12-lifecycle-pins.test.ts",
  "tests/audio-engine-setproject-reentrancy.test.ts",
  "tests/fx-pattern-sync.test.ts",
  "tests/fx-node-dispose.test.ts",
  "tests/multitap-worklet.test.ts",
  "tests/send-pdc.test.ts",
  "tests/audio-worklets-safe-param.test.ts",
  "tests/automation-bridge.test.ts",
  "tests/modulators.test.ts",
  // ── Timing: transport + scheduler + RT driver ──
  "tests/transport.test.ts",
  "tests/scheduler.test.ts",
  "tests/scheduler-driver.test.ts",
  // ── Model & invariants ──
  "tests/project-model.test.ts",
  "tests/project-invariants.test.ts",
  "tests/invariants.test.ts",
  "tests/domain-purity.test.ts",
  "tests/architecture-cycles.test.ts",
  // ── I/O + hostile input ──
  "tests/import-export-robustness.test.ts",
  "tests/security/url-bypass-fuzz.test.ts",
  "tests/security/filename-fuzz.test.ts",
  // ── Generated-surface + boot budget ──
  "tests/mcp-mirror-sync.test.ts",
  "tests/boot-graph.test.ts",
  // ── Registry integrity (fast structural checks) ──
  "tests/effects.test.ts",
  "tests/instruments.test.ts",
  "tests/offline-parity.test.ts",
];

/** Hard ceiling: the subset must stay a subset (see the guard test). */
export const FAST_SUBSET_MAX_FILES = 30;
