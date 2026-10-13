# DAW INTENT ENGINE READINESS — KYX

**Audit date:** 2026-10-13 · **Target:** KYX (`pulse-forge`) · **Revision:** `31cc20ad`
**Mode:** read-only. Two disposable probes executed against the real parser, then deleted.

> **2026-10-13 UPDATE:** the recommended first two steps are implemented and
> verified (see `IMPL-2026-10-13-P0-P1.md`). Both 🔴 probes below now route
> correctly: "fade the selected clip over its final bar" → `kind:"clips"` with
> a `fadeClip` op on the selected AUDIO clip (one undoable command, clamped to
> the clip duration); "export the current mix" / "bounce the mix" /
> "export my mix as mp3" / "export the project" → `kind:"export"`. The
> catch-all no longer generates on a model miss — it clarifies. The ⚠️ vocal
> probe still clarifies (P1-A document-derived target resolution remains the
> root fix). Unattended autonomy remains blocked on idempotency (GAP-04).

---

## 0. A framing correction that changes the maturity picture

`src/intent/pipeline.ts` + `src/intent/plan.ts` are **not** the action-execution pipeline — they are the **pattern-generation** pipeline. The user-facing action pipeline is a separate three-layer structure:

| Layer                          | Module                                                                                        | Role                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1. Deterministic parser        | `src/intent/route.ts` → `src/intent/exact.ts` (and `mix.ts`, `compound.ts`, `loudness.ts`, …) | Pure text → `RoutedIntent` (38-variant union) |
| 2. Local model (fallback only) | `src/intent/model-schema.ts`, `model-resolver.ts`                                             | ONNX/GBNF-constrained → same `RoutedIntent`   |
| 3. Generation                  | `src/intent/pipeline.ts`, `plan.ts`, `text-parser.ts`                                         | creative brief → new arrangement              |

Both layer 1 and 2 feed the **same** dispatch chain in `src/ui/IntentPanel.tsx:3806-4468`. Maturity is therefore **high in layers 1–2 and unrelated to layer 3** — but layer 3 is the catch-all, which is precisely where the CRITICAL findings live.

---

## 1. Maturity verdict by criterion

| #   | Criterion                            | Verdict                                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Parsing ↔ execution separation       | **VERIFIED**                                              | `routeIntentText` returns pure data (`route.ts:299-347`). The model layer explicitly _"touches no audio state — the output is a route"_ (`model-resolver.ts:36-37`). Every model value is re-resolved engine-side: `panValue 30 → 0.3` (`model-resolver.ts:107-109`), `toBar 9 → 0-based 8` (`:231`), clip ref → live id (`:225-228`). Unresolvable refs **refuse**: `if (!clipId) return null; // clip gone / ref unresolvable — no guessing` (`:229`).                                                                    |
| 2   | Structured action schema             | **VERIFIED** (intent) / **PARTIAL** (action)              | Intent schema is versioned and validated: `INTENT_SCHEMA_VERSION = 1` (`types.ts:13`), rejected on mismatch (`schema.ts:28`), with `validateIntentSpec`/`parseIntentSpec`/`assertIntentSpec` (`schema.ts:25-113`). Model actions are data-driven (`MODEL_ACTIONS`, `model-schema.ts:252-383`) with typed slots (`:188-200`) but carry **no version field and no migration hook**.                                                                                                                                           |
| 3   | Context grounding                    | **PARTIAL**                                               | Selection resolved at **execution** time, not baked at plan time — correct anti-stale design (`IntentPanel.tsx:3805-3812`, `route.ts:385-389`). But `selectedClipId` requires **exactly one** selected clip (`:3810`); multi-select degrades to no clip context. And the LLM is passed the document but **discards it** (`model-ollama.ts:191`).                                                                                                                                                                            |
| 4   | Ambiguity + confirmation             | **PARTIAL**                                               | Clarify path is real and its chips are **verified-executable** — model-proposed suggestions are re-routed before being offered, filtered to non-pattern/non-clarify (`model-resolver.ts:306-310`). Complaints are audition-first; nothing mutates until a chip is picked (`IntentPanel.tsx:3898-3918`). Gap: destructive ops get an **auto-checkpoint, not a user confirmation** (`route-guard.ts:17-36`); no dry-run exists.                                                                                               |
| 5   | Multi-step / atomicity / idempotency | **PARTIAL** — atomicity VERIFIED, idempotency **MISSING** | Compounds are all-or-nothing with a single snapshot (`compound.ts:120-148`), and parse is all-or-nothing by design (`compound.ts:39-41`). But no idempotency key exists anywhere in `intentRouting.ts`; relative ops read live state and re-apply (`intentRouting.ts:118-120,147-149`).                                                                                                                                                                                                                                     |
| 6   | Determinism + fallback               | **VERIFIED**                                              | Explicit timeouts `MANIFEST_TIMEOUT_MS = 1500`, `COLD_LOAD_TIMEOUT_MS = 120_000`, `GENERATE_TIMEOUT_MS = 8_000` (`model-loader.ts:60-70`); real `AbortController` wiring (`:177,209`); cold-load timeouts deliberately excluded from breaker accounting (`:62-64`). Every failure → `null` (`model-resolver.ts:434-453`), and `tryModelRoute` runs **only after** deterministic parsing has failed (`model-resolver.ts:440-441`). Generation: _"Never depends on successful model initialization"_ (`pipeline.ts:122-123`). |
| 7   | Audio-thread safety                  | **VERIFIED — no violation**                               | All 41 processors in `src/audio-worklets/` swept for `fetch(`, `XMLHttpRequest`, `localStorage`, `indexedDB`, `require(`, dynamic `import(`, `onnx`, `ort.` → **0 matches**; every hit is `port.onmessage`/`postMessage`. `renderer.ts` imports only engine/project-model/sample-library/worklet-loader — no intent, no ONNX.                                                                                                                                                                                               |
| 8   | Unit explicitness                    | **PARTIAL**                                               | Documented contract table (`model-schema.ts:10-16`), but heterogeneous by design: model face is integer percent + bounded scalars (`model-schema.ts:273,285,287`), engine face is dB + linear (`intentRouting.ts:148`), bars are 1-based (`model-schema.ts:356-358` vs `intentRouting.ts:119`), and clip fades convert to **seconds** at scene-pinned tempo (`audioClips.ts:477-482`). Correct, but the conversions are scattered across three modules.                                                                     |

---

## 2. Workflow test — executed, not inferred

The brief asks for three conceptual workflows tested against **actual** capabilities. Both probes ran the real `routeIntentText` against a real `house`-template document.

| Request                                         | Result                                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **"lower the vocal by 2 dB"**                   | ⚠️ **PARTIAL** → `clarify` ("which fader?")  | The clarify is the _correct fail-safe_ — it refused rather than guessed. But the capability is absent: `ExactTarget` has no `vocal` (`exact.ts:16`), the `gainDb` alternation has no `vocal` (`exact.ts:303-306`), and `firstTarget` regex-matches only the capture group (`exact.ts:71-81`). The LLM fallback cannot rescue it (`model-schema.ts:133`). `kyx_mix` **does** resolve vocal by family (`mix.ts:34,483-489`) — the deterministic fader vocabulary is the outlier. |
| **"fade the selected clip over its final bar"** | 🔴 **MISSING → misrouted to `kind=pattern`** | No fade verb in the intent layer at all. Model clip vocabulary is `{copyClip, moveClip, resizeClip, deleteClip}` (`model-schema.ts:177`). Everything else exists: `updateAudioClip` accepts `fadeIn/fadeOut` (`audioClips.ts:58-59`), clamps (`audioClips.ts:454-457`), `clampClipFades` (`audioClips.ts:473`), and selection grounding already passes `selectedClipId` (`IntentPanel.tsx:3810`). **Only the NL→command bridge is absent.**                                    |
| **"export the current mix"**                    | 🔴 **MISSING → misrouted to `kind=pattern`** | `parseExportIntent` is anchored and permits only `project`/nothing (`exact.ts:558-564`). Executed: `parseExportIntent("export the current mix") === null`. The route falls to the terminal catch-all (`IntentPanel.tsx:4468`) → `generate(source)`. **Only bare `export wav` works.** By contrast `kyx_export` is a first-class MCP tool (`tools.ts:2845`) — the agent can export reliably; the human cannot.                                                                  |

```
PROBE  | "lower the vocal by 2 dB"                 => kind=clarify (reason=which fader?)
PROBE  | "lower the drums by 2 dB"                 => kind=exact          ✅
PROBE  | "fade the selected clip over its final bar" => kind=pattern       🔴
PROBE  | "export the current mix"                   => kind=pattern       🔴
PROBE2 | "export wav"                               => kind=export         ✅
PROBE2 | "export the project"                       => kind=pattern       🔴
PROBE2 | "bounce the mix"                           => kind=pattern       🔴 (isCreativeBriefRoute=true)
PROBE2 | "export my mix as mp3"                     => kind=pattern       🔴
```

---

## 3. Missing contracts

1. **No version field on model actions.** `MODEL_ACTIONS` is an open record; adding or reshaping a kind has no migration hook. A deployed model emitting a removed action kind has no defined failure mode beyond `null`.
2. **No idempotency contract.** The action path has no `requestId`, nonce, or dedupe ledger. Combined with `kyx_batch` partial-commit semantics (`tools.ts:4711-4712`), retries double-apply relative ops.
3. **No confirmation contract.** Destructive ops checkpoint instead of asking; there is no `dryRun` capability in the tool layer.
4. **No grounded-target contract.** The LLM receives `doc` and ignores it (`model-ollama.ts:191`); targets are closed enums rather than document-derived.
5. **No typed error contract.** `RoutedIntent` carries no stable failure discriminator for agents; MCP errors are free-text (`tools.ts:1675-1688`).

---

## 4. Maturity summary

The Intent Engine is **well-architected and correctly layered**, with genuinely strong determinism, audio-thread safety, and execution-time context resolution. Its weakness is not design — it is **coverage and the failure default**:

- The deterministic vocabulary is closed and has drifted from the command layer (GAP-02, GAP-03).
- The catch-all's default is `generate`, so every unrecognized verb risks a generative rewrite rather than a question (GAP-01).

**Readiness for supervised use: high. Readiness for unattended agent autonomy: blocked** — primarily by the absence of idempotency (GAP-04), which makes any retry-until-success harness unsafe.

**Recommended sequence:** narrow the catch-all → widen export vocabulary → document-derived target resolution → idempotency keys. See `DAW_AGENT_CONTROL_ROADMAP.md`.
