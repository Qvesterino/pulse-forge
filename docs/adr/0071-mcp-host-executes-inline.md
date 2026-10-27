# ADR 0071 — An MCP host applies the command inline, and the guard says so

Date: 2026-10-27 · Status: Accepted (shipped) · Scope: MCP host contract, R-02 verification gate

## Context

The R-02 gate (`src/mcp/verified-mutation.ts`) takes the document from **before** the handler ran and
the document from **after** it, and concludes _"nothing changed"_ when the two are identical
(`documentChanged = before !== after`).

That conclusion is only sound if the host **applied the command in between**. The contract is
`execute(command: Command): void` (`McpToolContext`), and TypeScript lets a Promise-returning
function satisfy a `void`-returning signature — so a deferred, queued, collab-merged or
worker-backed host compiles **cleanly** and silently turns every mutation into "nothing changed"
(audit F-26, measured with probe T5):

```
[T5] text                 : nothing changed (the document is identical); no undo step — reported: Drums: gain 0.500 (-6.0 dB)
[T5] mutated              : false
[T5] document changed yet : false
[T5] commands queued      : 1
[T5] gain after the flush : 0.5
```

A whole-surface truth gate failing **open** — reporting "nothing changed" for a change that did
happen — is worse than no gate, because it is trusted.

All three shipped hosts apply inline today (`src/mcp/desktop-host.ts`, `src/mcp/web-host.ts`,
`src/mcp/headless-host.ts` — each delegates to `ProjectStore.execute`, which is synchronous). The
exposure is not today's behaviour; it is that **nothing keeps it that way**.

## Decision

**The precondition is stated where the contract lives, and enforced where the type cannot.**

1. **The type documents it.** `McpToolContext.execute` now carries the precondition in full: apply
   the command **before the call returns**, and the consequence of breaking it (the gate fails
   open). The comment names the guard that stands in for the type.

2. **The type cannot carry it.** TypeScript's `void`-return rule accepts a Promise, so the
   precondition cannot be made compile-time without breaking every context in the repo (each
   `execute` implementation would have to return exactly `undefined`). The guard is the enforcement.

3. **The guard is a test, and it is proven to fail.**
   `tests/mcp-host-inline-execute.test.ts` asserts three things:
   - the store applies the command before its call returns (the applier every host delegates to),
   - the headless host's `execute` applies the command inline,
   - **no registered host's `execute` is async, awaits, or defers** — a static AST scan of
     `src/mcp/*.ts` that rejects `async`, `await`, `Promise`, `.then(`, `setTimeout`,
     `queueMicrotask` and `requestAnimationFrame` inside an `execute` implementation.

   The static rule was validated with a **positive control**: making the headless host's `execute`
   `async` turns the guard red with `src/mcp/headless-host.ts:92 — execute is async`, and the
   change was reverted. A guard that has never been seen to fail is not a guard.

## Consequences

- **The hosts are unchanged.** No host code moved; the contract is now written down and watched.
- **The failure mode is loud at the seam that owns it.** A future deferred host fails CI with the
  file and line, instead of quietly making every mutation read as "nothing changed" in production.
- **The gate itself is unchanged.** It still compares the document from before with the document
  from after; that comparison is correct as long as the precondition holds, and the precondition is
  now enforced rather than assumed.
- **The known limitation stays documented.** A host that violated the precondition would still make
  the gate report "nothing changed" — the guard prevents that host from existing; it does not give
  the gate a way to detect one at runtime. Making the gate correct against deferral would mean
  changing `execute` to return the committed revision (the report's option (a)), which is a
  contract change for every host and every test context — a separate decision, not this one.

## Alternatives rejected

- **Compare revisions instead of object identity.** The revision only moves when the command is
  applied, so a deferred host fails the same way. It does not detect deferral; it only makes the
  comparison cheaper.
- **Make `execute` return `undefined` to forbid a Promise.** Rejected: it breaks every context in
  the repository (each implementation would have to stop returning the applier's value) for a
  precondition that a three-line guard already holds.
- **Let the gate wait for the undo depth to settle.** Rejected: it adds latency to every call and
  still cannot cover a host that defers by a macrotask or a queue.
