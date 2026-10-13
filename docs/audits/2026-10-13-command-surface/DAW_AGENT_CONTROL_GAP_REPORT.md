# DAW AGENT CONTROL GAP REPORT — KYX

**Audit date:** 2026-10-13
**Target:** KYX (`pulse-forge`), `D:\pulse-forge`
**Revision:** `31cc20ad` (working tree dirty from concurrent sessions)
**Mode:** read-only. No production code changed. Two disposable probes created, run, deleted.

**ZYVO/VocalForge is a separate monorepo (`D:\VocalForge_DAW`) and was not audited.** No finding here transfers to it.

---

## Verdict

**Agent control is real, architecturally sound, and materially incomplete at the natural-language layer.**

KYX is _not_ a fake agent surface. There is a genuine stdio MCP server with token auth, a loopback bridge, 37 dispatched tools, and — decisively — **every UI, Intent and MCP mutation converges on one pure command spine with inverse-patch undo**. That convergence is rare and it is the reason the risk profile is low.

The failures are not in the architecture. They are in **coverage gaps between what the deterministic layer can express and what a user or agent naturally says**, plus **test coverage that stops one layer short of persistence**.

Two findings below (GAP-01, GAP-02) were initially reported as `VERIFIED`/`MISSING` by delegated analysis reading regexes. The auditor **falsified both by executing the real parser**. The executed results are worse than the delegated claims and are the headline of this report.

---

## Confirmed risks

### GAP-01 — Natural export phrasing silently regenerates the user's music 🔴 CRITICAL · CONFIRMED · **FIXED 2026-10-13** (P0-A + P0-B; evidence in `IMPL-2026-10-13-P0-P1.md`)

**Affected workflow:** Intent Engine (UI chat + `kyx_intent` MCP tool).

`parseExportIntent` is fully anchored and only permits the literal noun `project` or nothing (`src/intent/exact.ts:558-564`):

```ts
/^\s*(?:please\s+)?(?:export(?:uj)?|bounce)\s*(?:the\s+)?(?:project\s+)?(?:as\s+|do\s+|to\s+)?(wav|mp3)?\s*[.!]?\s*$/i;
```

Executed probe against a real `house`-template document (probe deleted after audit):

```
"export the current mix"  => kind=pattern | parseExportIntent=null | FATE=GENERATION CATCH-ALL
"export wav"              => kind=export  | parseExportIntent=wav  | FATE=EXPORT PIPELINE
"export the project"      => kind=pattern | parseExportIntent=null | FATE=GENERATION CATCH-ALL
"bounce the mix"          => kind=pattern | parseExportIntent=null | FATE=GENERATION CATCH-ALL
"export my mix as mp3"    => kind=pattern | parseExportIntent=null | FATE=GENERATION CATCH-ALL
```

A non-matching route reaches the terminal `else` of the dispatch chain (`src/ui/IntentPanel.tsx:4468`), which calls `generate(source)` — **the full generative pipeline**. The user asks for an export and the application attempts to _compose a new track_.

- **Root cause:** an over-anchored regex plus a **fail-open catch-all**. The catch-all's default is "generate", which is the single most destructive default an editing app can have for an unrecognized verb.
- **Impact:** data loss (arrangement replaced), unbounded compute, and a user who believes they exported. `bounce the mix` additionally trips `isCreativeBriefRoute = true` (`model-fallback-policy`), so it commits to generation even earlier.
- **Note the asymmetry:** the MCP surface handles this correctly — `kyx_export` (`src/mcp/tools.ts:2845`) is a first-class tool. **The agent can reliably export; the human cannot.** That is an inversion of the intended design.
- **Minimal remedy:** (a) make the export parse accept `mix|bounce|master|stem(s)`; (b) **narrow the catch-all so it refuses rather than generates** unless the request carries genuine creative-brief signal; (c) add a regression test asserting that any phrase matching `/export|bounce/` never reaches `generate()`.
- **Verification:** probe assertion `routeIntentText("export the current mix").kind !== "pattern"`, plus a UI test that the status line reports the render pipeline.

### GAP-02 — "fade the selected clip over its final bar" is silently accepted and misrouted 🔴 CRITICAL · CONFIRMED · **FIXED 2026-10-13** (P0-C deterministic bridge; model vocabulary deferred to the next retrain — see implementation record)

**Affected workflow:** Intent Engine.

Executed probe: `"fade the selected clip over its final bar" => kind=pattern`.

There is **no fade verb anywhere in the intent layer**. `grep fade` across `src/intent/` returns nothing in `arrangeWords.ts` or `loudness.ts`; the model clip vocabulary is `{ copyClip, moveClip, resizeClip, deleteClip }` (`src/intent/model-schema.ts:177`).

Meanwhile everything needed to execute it already exists:

- `updateAudioClip` accepts `fadeIn` / `fadeOut` (`src/commands/audioClips.ts:58-59`)
- hard clamp invariant at `audioClips.ts:454-457`
- `clampClipFades` (`audioClips.ts:473`)
- selection-grounded routing already passes `selectedClipId` (`src/ui/IntentPanel.tsx:3810`)

Only the **NL → command bridge** is absent. The request routes to `pattern`, hitting the same fail-open catch-all as GAP-01.

- **Root cause:** capability exists in the command layer but was never exposed in the deterministic parser. The command layer and the language layer have drifted.
- **Minimal remedy:** add a `fade` op to the exact-intent parser and the model clip vocabulary, resolving "final bar" against clip duration and the tempo map.
- **Verification:** probe asserting `routeIntentText(phrase).kind` is a clip-arrange kind and that execution sets `fadeOut` on the selected clip.

### GAP-03 — `vocal` is absent from the deterministic gain vocabulary 🟠 HIGH · CONFIRMED

Executed probe: `"lower the vocal by 2 dB" => kind=clarify reason="which fader?"`.

This is **better than a silent failure** — the clarify chip is the correct fail-safe behavior, and it is good that the system refused rather than guessed. But the capability is still missing:

- `ExactTarget` has no `vocal` member (`src/intent/exact.ts:16`): `"drums" | "bass" | "lead" | "chords" | "mix" | "kick" | "snare" | "hats"`.
- The `gainDb` alternation contains no `vocal` (`exact.ts:303-306`).
- `firstTarget` regex-matches only the capture group, so a target outside the alternation can never resolve (`exact.ts:71-81`).
- The LLM fallback cannot rescue it — `exactTarget` vocabulary omits vocal (`model-schema.ts:133`).

**Vocal is the single most common mixing request in music software.** It is already resolvable elsewhere: `MixTarget` includes vocal, resolved from clip bindings (`src/intent/mix.ts:34,483-489`), and `kyx_mix` resolves it by family. Only the deterministic fader vocabulary lacks it.

- **Minimal remedy:** add `vocal` (+ `vox`, `vocal(s)` inflections) to `ExactTarget`, `TARGET_RES`, the `gainDb`/`gainDbAbsolute` alternations, and the model target enum; resolve against real track names from the doc rather than a closed vocabulary.
- **Note:** the more durable fix is target resolution from the **live document** (see BOTTLENECK).

### GAP-04 — No idempotency on the agent-reachable action path 🟠 HIGH · STRONG_EVIDENCE

`src/commands/intentRouting.ts` has no idempotency key, nonce, request id, or dedupe (grep for `idempot|nonce|requestId|already applied` → 0 hits).

Relative ops are re-applied against **current** state each time:

- `gainDb` reads live gain and multiplies (`intentRouting.ts:147-149`)
- `patternLengthDelta` reads the active pattern's current `stepCount` (`intentRouting.ts:118-120`)

A retried or duplicated agent request therefore **double-applies** ("−2 dB" twice = −4 dB). The MCP `kyx_batch` tool is also **partial-commit, not atomic**: per-call failures are recorded and the loop continues (`src/mcp/tools.ts:4711-4712`, _"Per-call failures never abort the batch"_).

The only net is the 256-entry undo stack — which **the codebase itself documents as insufficient**: `src/intent/route-guard.ts:10-11` states the bounded stack _"evicts the pre-delete state in a long session"_.

- **Impact:** the primary blocker to safe unattended agent autonomy. Any retry-on-timeout in an agent harness silently corrupts the mix.
- **Minimal remedy:** an optional caller-supplied `requestId` on mutating tools, with a bounded recent-request ledger mapping id → resulting undo index; a repeat returns the original result instead of re-executing. Relatively small, high leverage.

### GAP-05 — MCP tests stop one layer short of persistence 🟠 HIGH · CONFIRMED · **FIXED 2026-10-13** (`tests/mcp-persistence.test.ts` — real store + real debouncer + real repository over fake-indexeddb)

The suite genuinely tests more than registration — the auditor ran it: **121 tests passed** across `tests/mcp-tools.test.ts` + `tests/mcp-mirror-sync.test.ts`.

But the assertion ceiling is in-memory state:

- `makeCtx` (`tests/mcp-tools.test.ts:24-68`) is a hand-rolled closure holding `let current = doc`, reimplementing undo/redo in ~20 lines.
- `storeCtx` (`:72-90`) uses the real `ProjectStore` but with **no `onDocChanged` listener and no persistence repo**.
- `datasetDoc()` (`:92-104`) is a plain in-memory object.

Verified: commands, clamping, no-op detection, undo semantics and the D4 destructive gate are all genuinely exercised. **But nothing asserts that a mutation reaches IndexedDB or re-projects the engine.** `services.ts:1065-1097` — the engine-projection + autosave fan-out — is never executed by any MCP test.

Consequence: the exact hop where a silent persistence failure would live has no coverage.

- **Minimal remedy:** one integration test binding a real `ProjectStore` to a stub `onDocChanged` + in-memory repository, asserting (a) engine projection called with the new doc, (b) flush completes and reload yields the mutated state.
- **Also:** `mutated: true` promises a _scheduled_ save (≤5 s), not a completed one. The wording should not be read as "persisted".

### GAP-06 — No per-client session isolation on the desktop MCP bridge 🟠 HIGH · STRONG_EVIDENCE

`desktop/mcp-host-manager.cjs:97` wires a **single** closure into one bridge; `forwardCall` (`:219-237`) sends `kyx:mcp:call` to the single `getWebContents?.()` window; `src/mcp/desktop-host.ts:143` binds ONE context against the live `services` store.

Every authenticated caller — every MCP client, every agent — shares **one window, one document, one undo stack, one transport**. There is no session id and no per-client project.

Positive controls verified: the token is checked **on the bridge itself** with a constant-time compare (`desktop/mcp-bridge-server.cjs:154`), not only at the stdio layer; the listener is hardcoded to `127.0.0.1` (`mcp-host-manager.cjs:102`); a rate limiter caps 30 burst / 30-per-minute (`mcp-bridge-server.cjs:27-42`). Auth is genuinely sound.

- **Impact:** two concurrent agents (or an agent plus a human) interleave on one document with no isolation, and agent attribution (`withAgentAttribution`, `desktop-host.ts:143`) is the only thing distinguishing their edits.
- **UNKNOWN:** whether the **web** relay (`server/mcp-core.mjs`, 75 KB) shares this flaw or has its own session model. Not read. **This should be resolved before remediation is scoped.**

### Lower-severity findings

| ID     | Sev | Conf      | Finding                                                                                                                                                                                                                                                                                                                                                                                       | Evidence                      |
| ------ | --- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| GAP-07 | MED | CONFIRMED | **Headless = zero capability.** No tool succeeds without a live window; every mutation terminates in the renderer (`desktop-host.ts:64`). Fails honestly (`"KYX window not available"`, `mcp-host-manager.cjs:233`; 10 s / 60 s timeouts). Architecturally intentional, not a stub — but it must be documented as a constraint, not marketed as server-side control.                          | mcp-host-manager.cjs:225,233  |
| GAP-08 | MED | CONFIRMED | **Errors are free-text, not typed.** `McpToolResult` has `text/mutated/isError` — no error code (`tools.ts:1675-1688`). An agent must substring-match to branch. Only the JSON-RPC transport layer has numeric codes.                                                                                                                                                                         | tools.ts:1693-1701            |
| GAP-09 | MED | CONFIRMED | **Mirror gate locks definitions, never handlers.** `tests/mcp-mirror-sync.test.ts:30-55` deep-compares name + description + input/output schemas across all three copies — strong — but a tool can be perfectly mirrored while shipping no handler. **Currently clean** (auditor verified all 37 registered names have dispatcher cases), but no gate enforces it. **GATE ADDED 2026-10-13.** | mcp-mirror-sync.test.ts:46-55 |
| GAP-10 | MED | CONFIRMED | **LLM is handed the project document and ignores it.** `IntentModelProvider.generate(instruction, doc)` (`model-resolver.ts:48`) — the Ollama implementation takes `_doc` and sends only the instruction string (`model-ollama.ts:191`). The model cannot ground on track names; the engine must resolve everything from closed enums — which is precisely why GAP-03 happens.                | model-ollama.ts:191           |
| GAP-11 | MED | CONFIRMED | **Destructive = checkpoint, not confirmation.** `routeIsDestructive` (`route-guard.ts:17-36`) auto-saves a durable checkpoint instead of asking. Rationale is documented and reasonable; there is **no dry-run anywhere** in the tool layer.                                                                                                                                                  | route-guard.ts:8-12           |
| GAP-12 | LOW | CONFIRMED | **Time signature not settable** — only the migration writes it (`schema.ts:1029`).                                                                                                                                                                                                                                                                                                            | schema.ts:1029                |
| GAP-13 | LOW | CONFIRMED | **Automation read/write modes absent** — no arm/auto-write concept in `src/`.                                                                                                                                                                                                                                                                                                                 | grep → MCP read only          |
| GAP-14 | LOW | CONFIRMED | **Save-as / Close-project missing** (browser-first model may accept this).                                                                                                                                                                                                                                                                                                                    | grep → 0 hits                 |
| GAP-15 | LOW | CONFIRMED | **Slip has a command but no UI caller** (`audioClips.ts:520`).                                                                                                                                                                                                                                                                                                                                | audioClips.ts:520             |
| GAP-16 | LOW | CONFIRMED | `kyx_export` returns `mutated: false` although it writes a file to disk (`tools.ts:2876-2879`). Semantically defensible (no doc change) but understates the side effect.                                                                                                                                                                                                                      | tools.ts:2845                 |

---

## What was verified as genuinely strong

These deserve explicit credit — they are why the severity ceiling is HIGH rather than CRITICAL across most of the surface:

1. **Single mutation spine.** Zero direct document writes in the entire UI layer (independently verified by grep, 0 matches). UI, Intent and MCP all reach `store.execute`.
2. **Inverse-patch undo with dev-time self-verification** (`core.ts:34-66`) and `deepFreeze` in dev to make in-place corruption throw loudly.
3. **Fail-closed targeting.** `explicitTrackIds` (`tools.ts`) refuses unknown ids with actionable guidance and refuses group tracks; destructive ops throw when a target cannot be resolved (`intentRouting.ts:82`).
4. **Real auth.** Constant-time token comparison on the bridge, loopback-only bind, rate limiting.
5. **Destructive gate, default OFF**, read live per call (`flags.ts:9-17`), with a test proving intent phrasing cannot bypass it (`tests/mcp-tools.test.ts:511`).
6. **Audio-thread safety holds.** 41 worklet processors swept: zero `fetch`/`XMLHttpRequest`/`localStorage`/`indexedDB`/`require`/dynamic-`import`/`onnx`/`ort`. `renderer.ts` imports no intent or ONNX module. The hard architectural invariant is intact.
7. **Determinism under model failure.** Explicit timeouts (1500 ms manifest / 8 s generate / 120 s cold load), circuit breaker accounting, and every failure degrades to `null` so the already-computed deterministic route wins (`model-resolver.ts:434-453`).
8. **Rendering is hardened** — PCM budget guard, abort handling, and a generative-source guard that refuses to silently export a project missing audio the user heard live (`renderer.ts:115`).
9. **`kyx_batch` is well guarded** — capped at 10, nesting refused, async tools refused, per-call read-back.
10. **Guard clauses that prevent dead undo steps** — identity no-op detection in `ProjectStore.applyCommand` (`ProjectStore.ts:239-245`).

---

## Most important architectural bottleneck

**The deterministic language layer is a closed vocabulary, while the document is open.**

`ExactTarget` is an 8-member union; `parseExportIntent` is an anchored regex over one noun; the model clip vocabulary is 4 ops. Every GAP-01/02/03 finding traces to the same shape: the engine holds the _capability_, the parser holds a _fixed list_, and the two drift apart silently. The fail-open catch-all (`IntentPanel.tsx:4468`) then converts "I did not understand" into "I will generate music" instead of "I will ask".

`model-ollama.ts:191` makes this structural: the LLM receives the document and discards it, so it cannot compensate for a closed vocabulary with real project knowledge.

**The single highest-leverage change is to resolve targets and ranges against the live document at execution time, and to make the catch-all refuse rather than generate.** That addresses GAP-01, GAP-02, GAP-03 and GAP-10 at once.

## Recommended first implementation package

**P0 — Make the unrecognized-verb path safe, then widen the export vocabulary.**

1. Narrow the `IntentPanel.tsx:4468` catch-all so generation requires positive creative-brief signal.
2. Extend `parseExportIntent` to accept `mix|master|stem(s)` and unanchored trailing clauses.
3. Regression test: no phrase matching `/export|bounce/` may reach `generate()`.

Small, surgical, closes both CRITICALs, and does not touch the command spine.
