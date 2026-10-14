# ADR 0046: Headless MCP evaluation

- **Status:** Accepted (test-only scope) — **implemented 2026-10-14**:
  `src/mcp/headless-host.ts` + `tests/mcp-headless-acceptance.test.ts` pin
  the acceptance contract. NO shipping surface imports the host. Remaining
  owner-gated: productizing the harness (a shipped library or an
  evaluation CLI) and extending coverage beyond the representative
  families.
- **Date:** 2026-10-14
- **Context source:** control-surface audit 2026-10-13, GAP-07 + roadmap P3-H

## Context

KYX's MCP surface executes in the renderer: every tool call terminates in
`src/mcp/desktop-host.ts` or the web relay's connected browser window, because
the authoritative state (`ProjectStore`) and the audio engine live there. A
headless process (CI, a server, an agent harness without a window) has
**zero tool capability by design** — `desktop/mcp-host-manager.cjs` answers
`"KYX window not available"`. The control-surface audit recorded this as an
honest constraint (GAP-07), not a stub.

There is now a real demand signal: agent-driven evaluation (an LLM driving
the DAW through MCP against fixtures, asserting on state) is the natural CI
harness for the control surface, and it cannot run headlessly today.

## Decision drivers

1. **One mutation spine** (AGENTS.md invariant #2): any headless path MUST
   go through the same `ProjectStore.execute` the UI, Intent and MCP paths
   use — no second implementation.
2. **The tool layer is transport-agnostic** (`executeMcpTool(ctx, …)` takes
   a context interface) — a headless host is a new context PROVIDER, not a
   new tool set.
3. **What headless genuinely cannot do:** live audio (no engine, no meters),
   export-to-download, gallery publish, recording. The tools already refuse
   these honestly (`UNAVAILABLE_ON_TRANSPORT`) when their capability hooks
   are absent — the contract exists.
4. **Determinism** (invariant #4): fixtures + fixed seeds make agent
   evaluation reproducible in CI.

## Considered options

- **A — CI drives a real browser** (Playwright MCP client against a dev
  server). Reuses everything; slow (~seconds per call), flaky under load,
  and already partially exists as `tests/e2e/`. Good for smoke, wrong as the
  evaluation workhorse.
- **B — A headless host over an in-memory `ProjectStore`** (RECOMMENDED): a
  `createHeadlessMcpHost(template)` that builds the REAL `services`-shaped
  context against an in-memory store + fixture document, wired through the
  same `executeMcpTool`. No engine hooks are provided; capability-refusing
  tools refuse exactly as they do for a suspended browser. The full
  mutation/contract surface — ~30 of the 37 tools' behaviors including every
  document mutation, error codes, idempotency, dry-run, attribution — becomes
  CI-drivable in milliseconds per call.
- **C — Full Electron headless mode** (`--headless` main-process host).
  Maximum fidelity, maximum cost: the renderer boundary exists for audio
  reasons; dissolving it for tests inverts a load-bearing architecture
  decision. Rejected for now.

## Decision (proposed)

Build **option B** as a test-only host (`tests/mcp-headless-host.ts` or
`src/mcp/headless-host.ts` behind a test export), gated by an ADR acceptance
suite that pins: every mutating tool reaches the store; every capability
refusal matches the live contract; error codes, idempotency and dry-run
behave identically to the bound surfaces. NO product surface changes — the
shipping app is untouched.

## Consequences

- **Positive:** CI agent-evaluation harness (P3-A's missing executor),
  parity sweeps become executable rather than read-only, regression cost per
  control-surface change drops to milliseconds.
- **Negative / costs:** a second host binding to maintain when
  `McpToolContext` grows (the interface is stable; the risk is small);
  the temptation to "fix" capability refusals in the headless host instead
  of honoring them — the acceptance suite must pin the refusals too.
- **Owner gate:** this ADR is PROPOSED. Implementation needs an owner to
  decide scope (test-only vs shipped library) and to budget the fixture
  documents. Until then, headless remains zero-capability by design, and
  agent evaluation runs against a real browser (option A) or not at all.

## Related

- Control-surface audit: `docs/audits/2026-10-13-command-surface/` (GAP-07,
  P3-H, P3-A readiness)
- ADR 0004 (AudioWorklet boundary — why the renderer is authoritative),
  ADR 0010 (desktop packaging)
