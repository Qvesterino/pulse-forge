# 04 — AI-assisted work, the intent pipeline, and the MCP/tool-call surface

**Audit date:** 2026-10-27 · **Domain owner:** worker (branch session) · **Repo:** `D:\pulse-forge`

---

## 1. Scope, method, and limits

**Scope.** Everything a user (or an agent) can reach by _asking_: the text→beat intent pipeline
(`src/intent/`), the intent→command routing (`src/commands/intentRouting.ts`,
`patternAssist.ts`, `assistSelectionCommands.ts`, `producerBriefCommands.ts`), the AI engines
(`src/ai/`, `src/generative/`), the MCP tool surface (`src/mcp/`, `server/mcp-core.mjs`,
`server/collab-server.mjs`), and the intent UI (`src/ui/IntentPanel.tsx`, `AssistPanel.tsx`,
`EffectIntentAssistant.tsx`, `FxIntentBar.tsx`).

**Method.** Static trace only. Read the router end-to-end (`src/intent/route.ts:743-1243`), the
command builder (`src/intent/command-for-route.ts:28-78`), the MCP executor
(`src/mcp/tools.ts:13813-14019`), the permission layer
(`src/mcp/permissionLattice.ts`, `src/mcp/agentTrust.ts`, `src/mcp/flags.ts`) and the UI dispatch
(`src/ui/IntentPanel.tsx:4343-4790`). Reachability was established by grepping every import of a
subsystem from `src/**` (not tests). Tool inventory came from `src/mcp/tools.ts` (39 `kyx_*`
entries, `tools.ts:1660`).

**Could not verify.**

- No runtime observation (per brief: the parent runs the app). Every row below is _Verified in code_
  or _Inferred_; nothing is marked _Observed in running app_.
- The test suite was **not** run (per brief). Where a spec pins a claim I cite the spec's own
  file/comment, not a green run.
- `src/mcp/desktop-host.ts` and `src/mcp/headless-host.ts` were located but not traced end-to-end,
  so claims about the desktop MCP transport are limited to `src/mcp/bridge.ts` + the relay server.
- The peer audit `docs/audits/2026-10-27-intent-to-sound/INTENT_TO_SOUND_AUDIT.md` (same date)
  covers intent→*sound quality*; this document covers intent→*reachability and trust* and
  deliberately does not re-litigate mix semantics.

---

## 2. Capability table

| #   | Capability                                                                                             | Implementation                                                                                                                                                      | Entry point                                                                                                                         | Prereqs (not inferable by the user)                                                                                            | Feedback / recovery                                                                                                   | Runtime status                                      | Class                                                                                             | Confidence       |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | Free-text intent → command, in app                                                                     | `src/intent/route.ts:743`, `src/ui/IntentPanel.tsx:4345`                                                                                                            | Intent dock tab, `Alt+7` (`src/ui/shortcuts.ts:220`); also `Alt+1`… dock rail                                                       | A loaded project; a genre word in the text forces the generation lane (`IntentPanel.tsx:1051`)                                 | Live plan preview (`IntentPanel.tsx:1046-1056`) + one undo step via `store.execute`                                   | reachable                                           | A                                                                                                 | Verified in code |
| 2   | Free-text intent over MCP (`kyx_intent`)                                                               | `src/mcp/tools.ts:1662`, `tools.ts:13807`                                                                                                                           | MCP tool                                                                                                                            | Relay on + `MCP_TOKEN` set (`server/collab-server.mjs:988-1006`) **and** the mutations consent flag (`src/mcp/flags.ts:55-66`) | Read-back + "one undo step in KYX" (`tools.ts:14004-14013`); refusals carry `isError` + a code (`tools.ts:3845-3847`) | reachable, **partial**                              | E                                                                                                 | Verified in code |
| 3   | Intent route taxonomy                                                                                  | `src/intent/route.ts:382-468` (41 kinds)                                                                                                                            | —                                                                                                                                   | —                                                                                                                              | —                                                                                                                     | reachable                                           | A                                                                                                 | Verified in code |
| 4   | Route → canonical command builder                                                                      | `src/intent/command-for-route.ts:28-78` (19 branches, `default: return null` at `:76`)                                                                              | —                                                                                                                                   | —                                                                                                                              | —                                                                                                                     | reachable, **covers 19/41 kinds**                   | F                                                                                                 | Verified in code |
| 5   | Live "intent plan" preview (what will change)                                                          | `src/ui/IntentPanel.tsx:1046-1056`, `src/intent/semantics/intent-plan.ts:488`                                                                                       | Intent panel, as you type                                                                                                           | —                                                                                                                              | Shows resolved target, current value, destination, clamp                                                              | reachable                                           | **F** — preview routes _without_ selection context (`:1052`), executor routes _with_ it (`:4345`) | Verified in code |
| 6   | MCP dry-run plan                                                                                       | `src/mcp/tools.ts:13780-13786`                                                                                                                                      | `kyx_intent {dry_run:true}`                                                                                                         | —                                                                                                                              | "Plan (dry run): …"                                                                                                   | reachable                                           | B                                                                                                 | Verified in code |
| 7   | MCP refusal taxonomy                                                                                   | `tools.ts:13817-13837` (generation/save/export/record/clarify/presetUnknown), `tools.ts:13925-13937` (loudness/mix/section*/complaint/select)                       | —                                                                                                                                   | —                                                                                                                              | `mcpError` → `isError:true` + `errorCode` (`tools.ts:3845`)                                                           | reachable                                           | A                                                                                                 | Verified in code |
| 8   | Permission lattice (auto / confirm / forbid)                                                           | `src/mcp/permissionLattice.ts:52-55`, `:82-85`, `:92-94`, `:136`; risk table `src/mcp/agentTrust.ts:50-99`                                                          | MCP consent toggle inside the intent panel (`src/ui/IntentPanel.tsx:535-539`)                                                       | `localStorage` flags, read live per call (`src/mcp/flags.ts:32-42`)                                                            | Stable codes `OK / MUTATIONS_NOT_ALLOWED / CONFIRMATION_REQUIRED / STALE_REVISION`                                    | reachable                                           | A                                                                                                 | Verified in code |
| 9   | Agent onboarding manual + vocabulary                                                                   | `src/mcp/onboarding.ts:14` (playbook), `:158` (vocabulary)                                                                                                          | `kyx://` resources (`tools.ts:112`)                                                                                                 | —                                                                                                                              | —                                                                                                                     | reachable                                           | **E** — vocabulary advertises capabilities `kyx_intent` refuses                                   | Verified in code |
| 10  | ONNX intent ranker                                                                                     | `src/ai/ranking/ranker-client.ts:15-33`, `src/intent/providers/local.ts:7-8`                                                                                        | —                                                                                                                                   | `localStorage["pf:intent-ranker"]` ∈ off/shadow/active; default `active` (`ranker-client.ts:24`)                               | Only a status suffix "ONNX active" (`src/ui/IntentPanel.tsx:6776-6779`)                                               | reachable                                           | C                                                                                                 | Verified in code |
| 11  | Local LLM intent model (Ollama)                                                                        | `src/intent/model-ollama.ts:24-28`, `:59-67`                                                                                                                        | 🤖 status in the panel                                                                                                              | Ollama on `127.0.0.1:11434` **and** the model present; kill switch `localStorage["pf:intent-model-ollama"]`                    | Announces itself with 🤖                                                                                              | gated                                               | G                                                                                                 | Verified in code |
| 12  | Model route gate (deterministic has last word)                                                         | `src/intent/model-route-gate.ts:144-165`                                                                                                                            | —                                                                                                                                   | —                                                                                                                              | Model proposal rejected ⇒ deterministic clarify/refusal stands                                                        | reachable                                           | A                                                                                                 | Verified in code |
| 13  | Creative-task Ollama provider                                                                          | `src/intent/creative-task-ollama.ts:71-76`                                                                                                                          | **NONE**                                                                                                                            | Explicit model name required                                                                                                   | —                                                                                                                     | **not registered with the resolver, cannot mutate** | H                                                                                                 | Verified in code |
| 14  | AI bridge recipes (5 musical recipes, provenance-bearing)                                              | `src/ai/bridge/**` (16 files, e.g. `src/ai/bridge/recipes/snaresVsHates.ts:15-20`)                                                                                  | **NONE**                                                                                                                            | —                                                                                                                              | —                                                                                                                     | **zero importers outside `src/ai/bridge/`**         | H                                                                                                 | Verified in code |
| 15  | Assist engine — vary / build / replace / fill                                                          | `src/commands/patternAssist.ts:155-215`                                                                                                                             | Assist panel (`src/ui/TopBar.tsx:1067`); `Ctrl+Shift+V` / `Ctrl+Shift+F` (`src/ui/shortcuts.ts:142-143` → `src/ui/App.tsx:724-735`) | An active drum pattern; a drum track                                                                                           | One undo step; seed re-rolled after apply (`AssistPanel.tsx:43-46`)                                                   | reachable — **no AI path at all**                   | D                                                                                                 | Verified in code |
| 16  | Selection-scoped assist (vary / thin selected steps, humanize selected notes)                          | `src/commands/assistSelectionCommands.ts`, `src/ui/AssistPanel.tsx:249-322`                                                                                         | Assist panel only                                                                                                                   | A step / note selection                                                                                                        | One undo; preview shows cell counts (`AssistPanel.tsx:495-499`)                                                       | reachable — **no AI path at all**                   | D                                                                                                 | Verified in code |
| 17  | Generative (MRT2) track — style prompt, chord/note source, 4 macros, capture 4 bars, resample variants | `src/commands/tracks.ts:82-87`, `src/ui/Inspector.tsx:424-800`, `src/generative/registry.ts:95`                                                                     | Track-kind menu in the track tab (`src/ui/TrackTabs.tsx:284-285`)                                                                   | MRT2 provider (Windows native / Electron / `ws://127.0.0.1:8765`) — `Inspector.tsx:129-136`, `:438-510`                        | Capture/resample buttons with explicit failure text (`Inspector.tsx:768-783`)                                         | reachable — **human-only**                          | D                                                                                                 | Verified in code |
| 18  | Generative track via any AI path                                                                       | `kyx_tracks` = "add a drum or instrument track" only (`src/mcp/tools.ts:2128-2137`); intent route creates drum/instrument only (`src/commands/intentRouting.ts:97`) | —                                                                                                                                   | —                                                                                                                              | —                                                                                                                     | **absent**                                          | I                                                                                                 | Verified in code |
| 19  | MCP tool registry                                                                                      | `src/mcp/tools.ts:1660` (39 `kyx_*` tools)                                                                                                                          | —                                                                                                                                   | —                                                                                                                              | —                                                                                                                     | reachable                                           | B                                                                                                 | Verified in code |
| 20  | MCP relay transport + session ownership                                                                | `src/mcp/bridge.ts:93-110`, `:146-209`; `server/collab-server.mjs:1377-1421`                                                                                        | MCP chip in the intent panel                                                                                                        | `MCP_TOKEN` env, relay URL, token                                                                                              | Displacement closes the socket with reason 4409 (`bridge.ts:119-131`)                                                 | reachable                                           | A                                                                                                 | Verified in code |

---

## 3. The five central questions

### Q1 — Can the AI see the user's context?

**Partly — and the gap is exactly where the AI's value is.**

The in-app intent request carries a rich context object into the router: `hasSelectedStepSelection`,
`selectedClipId`, `selectedRange`, `selectedTrackId` (`src/intent/route.ts:746-751`), and the router
uses them to _switch route kind_ (`route.ts:849-852`, `:853-855`, `:881-884`). The executor passes
them (`src/ui/IntentPanel.tsx:4345-4349`).

**The MCP path passes none of them.** `routeIntentText(trimmed, ctx.getDoc())` is called with the
context argument defaulted to `{}` at all three MCP call sites — `src/mcp/tools.ts:5136`,
`tools.ts:13781`, `tools.ts:13807`. There is also no MCP tool that changes the selection, so an
agent cannot create the precondition it lacks.

Consequence: an agent asking "vary the selected steps" cannot produce `selectedStepAssist`
(`route.ts:849` requires `hasSelectedStepSelection`), so the sentence falls through to the
generation lane (`route.ts:1242`) and is refused as a _generation_ request
(`tools.ts:13817-13822`) — a refusal with the wrong reason.

What the AI _does_ get: the whole `ProjectDocument` (the router resolves real track/FX ids against
it — e.g. `src/intent/model-route-gate.ts:66-81` binds a model proposal to installed plugin tracks),
plus a bounded read-only projection when a local model is present
(`src/intent/model-context.ts:313`).

### Q2 — Can the AI invoke features safely, and are refusals visible?

**The safety layer is genuinely good. The reporting is not uniformly good.**

Good: every refusal is a shaped `mcpError` with `isError:true` and a stable code
(`src/mcp/tools.ts:3845-3847`); the permission lattice returns `auto | confirm | forbid`
(`src/mcp/permissionLattice.ts:52-52`, `:136`) and treats an external agent as non-human by default
(`permissionLattice.ts:92-94`); the destructive gate runs before any mutation
(`tools.ts:13920`).

Bad — three distinct failure modes:

1. **Silent no-op that reads as success.** `intentCommand(...) == null` returns
   _"intent understood but nothing changed (already matches or no target)"_ with
   `mutated:false`, `stage:"noop"` and **no `errorCode`** (`tools.ts:13943-13949`).
   Two route kinds reach this: `checkpointIntent` (`route.ts:834-837`) and `sceneIntensity`
   (`route.ts:1060-1063`) — both context-free, so both _are_ reachable over MCP. `sceneIntensity`
   is worked in-app (`src/ui/IntentPanel.tsx:4769-4778`) and has a structured MCP tool
   (`kyx_sections`, `tools.ts:2057-2062`), yet the free-text route has no branch in
   `buildIntentCommand` (`command-for-route.ts:30-76`), so `kyx_intent "set verse intensity to 120%"`
   reports a no-op instead of doing the thing.
2. **Refusal with a misleading reason** (Q1 above): selection-scoped asks are refused as
   "generation requests".
3. **A vocabulary that promises more than the executor delivers** (see Q4).

In-app, refusals _are_ visible: `clarify` routes render reason + suggestions
(`src/ui/IntentPanel.tsx:4458`, `:5978-5983`).

### Q3 — Is there a preview/undo path?

**In-app: yes, and it is the strongest part of this surface.** `planIntent` is pure and builds the
_same_ command the executor will build (`src/intent/semantics/intent-plan.ts:11-14`, `:488-491`),
and the panel shows it live while typing (`src/ui/IntentPanel.tsx:1046-1056`). Every in-app intent
branch applies via `services.store.execute(...)` — e.g. `IntentPanel.tsx:4777`, `:4785` — so it is a
normal undoable command. MCP returns "one undo step in KYX"
(`tools.ts:13954-13958`) and offers `kyx_undo`.

**But the preview and the executor do not route identically.** The preview calls
`routeIntentText(prompt, doc)` with no context (`IntentPanel.tsx:1052`); the executor calls it with
the selection context (`IntentPanel.tsx:4345-4349`). For a selection-dependent sentence the
preview can render a plan for a _different_ route than the one that executes. The same
context-free call is used to validate complaint-diagnosis proposals
(`IntentPanel.tsx:4453`), so proposals that would only resolve against the live selection are
silently dropped from the clarify chips.

### Q4 — Is the vocabulary aligned?

**No — there are at least four separate vocabularies, and the agent-facing one is wrong about what
the agent may say.**

- In-app production concepts: `PRODUCTION_CONCEPTS` / `CONCEPTS` (`src/intent/production.ts:124`,
  `:156`) — `deeper, punchier, warmer, darker, brighter, wider, grittier, glue, lofi, wobbly,
robotic, metallic, …`.
- Mix tone is a **closed 4-value set**: `dark | bright | warm | cold` (`src/intent/mix.ts:86`).
- Agent-facing vocabulary: `src/mcp/onboarding.ts:158-203`.
- Route precedence and its own wording: `src/intent/route.ts:726-742`.

Concrete misalignment: `MCP_VOCAB_TEXT` advertises **"MIX PROFILE (measured, whole-mix): more/less
reverb, delay, punch, pump (sidechain), wider, mono-ish"** (`onboarding.ts:165-168`) and
**"COMPLAINTS (measured diagnosis + executable proposals): empty / thin / muddy / harsh / no punch"**
(`onboarding.ts:175-177`). Both route kinds are **explicitly refused** over MCP
(`tools.ts:13925-13937`, `UNAVAILABLE_ON_TRANSPORT`). An agent that trusts the shipped vocabulary
will send "more reverb" or "the lead is harsh" and be refused.

The UI-label question ("make it heavier") fails the other way: _"heavier"_ is in neither the
production concept list nor the 4-value mix tone set — the only occurrences in `src/` are prose
comments (`src/mcp/master-assistant.ts:355`, `src/ai/bridge/recipes/snaresVsHates.ts:17`). A sentence
that names no genre and no known concept therefore reaches the default at `route.ts:1242` and
becomes a **generation request**, not a mix move.

### Q5 — What can the AI NOT do that a human can?

From the command registry (`src/commands/commands.ts:101-107`, 51 command modules) minus every
route and tool that can reach it:

| Human-only capability                                                                                      | Implementation                                                 | Why the AI cannot reach it                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assist: vary / build / replace / fill a pattern                                                            | `src/commands/patternAssist.ts:155-215`                        | No `kyx_assist` tool; no free-text route; `buildIntentCommand` has no branch                                                                        |
| Assist on a _selection_ (vary/thin steps, humanize notes)                                                  | `src/commands/assistSelectionCommands.ts`                      | No tool, no route; the routes that exist need a selection the agent cannot set (Q1)                                                                 |
| Create a **generative (MRT2)** track                                                                       | `src/commands/tracks.ts:82-87`, `src/ui/TrackTabs.tsx:284-285` | `kyx_tracks` covers drum/instrument only (`tools.ts:2128-2137`); the intent route creates drum/instrument only (`src/commands/intentRouting.ts:97`) |
| Configure generative macros / style prompt / chord+note source, capture 4 bars, commit resample variations | `src/ui/Inspector.tsx:424-800`                                 | No tool, no route                                                                                                                                   |
| Change the **selection** at all                                                                            | `src/ui/IntentPanel.tsx:4767` (`select` route)                 | `select` is refused over MCP (`tools.ts:13931`); no tool sets selection                                                                             |
| Set a **section intensity** by free text                                                                   | `route.ts:1060`, `IntentPanel.tsx:4769`                        | Route exists but `buildIntentCommand` has no branch → silent no-op                                                                                  |
| Read the AI bridge's recipe reasoning                                                                      | `src/ai/bridge/**` (16 files)                                  | Not imported anywhere in `src/`                                                                                                                     |

---

## 4. Candidate findings

**HCP-04-01 — `kyx_intent` silently no-ops on two live route kinds.**
Class **F**. Evidence: `tools.ts:13943-13949` returns a success-shaped no-op with no `errorCode`;
`command-for-route.ts:30-76` has no `case "sceneIntensity"` / `"checkpointIntent"`; both routes are
context-free and reachable (`route.ts:834-837`, `:1060-1063`); both work in-app
(`IntentPanel.tsx:4769-4778`). User problem: the agent is told "understood, nothing changed" and
stops; the user sees a no-op with no reason. Minimal intervention: add the two missing
`buildIntentCommand` branches, and make the `command == null` path return `mcpError("NO_TARGET", …)`
instead of a bare no-op.

**HCP-04-02 — The shipped MCP vocabulary advertises capabilities `kyx_intent` refuses.**
Class **E**. Evidence: `onboarding.ts:165-177` vs `tools.ts:13925-13937`. User problem: the agent
forms a valid plan from the manual and is then refused with "not available over MCP v1" — the
surface looks broken. Minimal intervention: annotate the vocabulary with the refusal (e.g. "MIX
PROFILE … over MCP use `kyx_mix`"), or route `mix`/`complaintIntent` to the structured tools.

**HCP-04-03 — The MCP intent surface carries no selection context.**
Class **F**. Evidence: `tools.ts:5136`, `:13781`, `:13807` call `routeIntentText(text, doc)` with the
context defaulted (`route.ts:746-751`); the in-app executor supplies it (`IntentPanel.tsx:4345-4349`);
no MCP tool changes selection. User problem: selection-scoped asks silently degrade to generation
and are refused with the wrong reason. Minimal intervention: pass the current selection into the MCP
route call, and/or add a tool that sets it.

**HCP-04-04 — The live intent-plan preview and the executor can disagree.**
Class **F**. Evidence: `IntentPanel.tsx:1052` (no context) vs `:4345-4349` (context). User problem:
the user reads a plan, presses apply, and gets a different operation. Minimal intervention: route
the preview with the same context object the executor uses.

**HCP-04-05 — Unknown mixer words become generation requests.**
Class **F**. Evidence: `route.ts:1242` is the default; the production vocabulary is closed
(`production.ts:124`, `:156`) and mix tone is 4 values (`mix.ts:86`); "heavier" appears in `src/`
only in comments. User problem: "make it heavier" silently starts a new beat instead of moving a
knob. Minimal intervention: extend the concept list (and the pinned vocab spec) with the common
adjectives, or add a "did you mean" clarification for a comparator that matches no concept.

**HCP-04-06 — The whole Assist engine is human-only.**
Class **D**. Evidence: `patternAssist.ts:155-215` and `assistSelectionCommands.ts` are reachable only
from `AssistPanel` + `Ctrl+Shift+V/F` (`shortcuts.ts:142-143`, `App.tsx:724-735`); no `kyx_assist`
tool (grep of `src/mcp/` for `assistVary|assistBuild|assistReplace|assistFill|kyx_assist` → no
matches). User problem: the highest-value "iterate on my idea" loop is invisible to both the
chat-like panel and any agent. Minimal intervention: add a `kyx_assist` tool wrapping the four
existing commands, and route `selectedStepAssist` through `buildIntentCommand`.

**HCP-04-07 — Generative (MRT2) track creation and control are human-only.**
Class **D**. Evidence: `tracks.ts:82-87`, `TrackTabs.tsx:284-285`, `Inspector.tsx:424-800`;
`kyx_tracks` is "drum or instrument" only (`tools.ts:2128-2137`); `intentRouting.ts:97` likewise.
User problem: the app's newest creative engine (style prompt, chord/note conditioning, capture,
resample) cannot be driven by an agent or by the intent bar. Minimal intervention: add
`kind:"generative"` to the `kyx_tracks` add op and a `kyx_generative` config tool.

**HCP-04-08 — `src/ai/bridge/` (16 files) is dead in the product.**
Class **H**. Evidence: grep for `["'].*bridge/(executor|recipes|types|context)` across `src/**`
→ no matches; the only self-references are `src/ai/bridge/recipes/index.ts`,
`recipes/registry.ts`, `mockProvider.ts`. The recipes carry real musical reasoning
(`src/ai/bridge/recipes/snaresVsHates.ts:15-20`). User problem: a designed "AI producer bridge"
with 5 recipes is unobservable and untrustable. Minimal intervention: either wire one recipe into
the intent panel, or mark the subtree experimental and exclude it from the capability claims.

**HCP-04-09 — The ONNX ranker's mode is a hidden localStorage switch.**
Class **C**. Evidence: `ranker-client.ts:15-33` (`DEFAULT_RANKER_MODE = "active"`, flag
`pf:intent-ranker`); the only surface is a status suffix `rankerModeLabel()`
(`IntentPanel.tsx:6776-6779`, used at `:1333`). User problem: a user cannot tell whether the ONNX
ranker or the heuristic chose their candidate, and cannot turn the model off without devtools.
Minimal intervention: show the mode in the candidate row and expose the toggle in the panel.

**HCP-04-10 — Turning MCP on requires four independent switches, with no diagnostic.**
Class **B**. Evidence: `MCP_TOKEN` env (`server/collab-server.mjs:988-1006`), the relay enable
(`src/mcp/relayConfig.ts`, imported at `IntentPanel.tsx:30`), the mutations consent
(`src/mcp/flags.ts:55-66`) and the destructive consent (`flags.ts:32-42`). The consent toggles live
inside the intent panel (`IntentPanel.tsx:535-539`, `:849`). User problem: "my agent does nothing"
has four candidate causes and one status line. Minimal intervention: one "why is my agent not
working" line that names the specific unmet precondition.

**HCP-04-11 — `kyx_intent`'s description overstates its coverage.**
Class **C**. Evidence: `tools.ts:1663-1668` promises "Executes through the deterministic command
layer (one undo step) and returns a verification read-back of the resulting state", while 13 of 41
route kinds are refused and 2 more no-op. User problem: the agent commits to a plan the tool cannot
execute. Minimal intervention: state the refusals in the tool description.

**HCP-04-12 — Complaint-diagnosis proposals are validated without selection context.**
Class **F**. Evidence: `IntentPanel.tsx:4453` routes each proposal with no context, so a proposal
that resolves only against the live selection is dropped from the clarify chips
(`IntentPanel.tsx:4458`). User problem: the measured diagnosis offers fewer executable remedies
than it found, with no explanation. Minimal intervention: reuse the executor's context object.

---

## 5. Verified working

- **Permission lattice + risk table**: full 4-value risk taxonomy per tool, `auto/confirm/forbid`
  decisions, external-agent distinction, live flag reads — `src/mcp/agentTrust.ts:30`,
  `:50-99`, `:111`; `src/mcp/permissionLattice.ts:52-55`, `:82-85`, `:92-94`, `:136`.
- **Shaped error contract**: every error goes through `mcpError` → `isError:true` + `errorCode`
  (`src/mcp/tools.ts:3840-3847`).
- **Destructive gate**: destructive intents refuse unless the checkpoint gate allows
  (`tools.ts:13920`, `:5408-5410`).
- **Deterministic-beats-model gate**: a model proposal is rejected unless it produces an
  executable, mutating plan; a specific deterministic route always wins
  (`src/intent/model-route-gate.ts:144-165`).
- **Pure plan builder shared by preview and executor** (`src/intent/semantics/intent-plan.ts:11-14`,
  `:488-491`; `src/ui/IntentPanel.tsx:1046-1056`).
- **Undo**: in-app intent applies through `store.execute` (one undo step); MCP reports
  "one undo step in KYX" (`tools.ts:13954-13958`); `kyx_undo` exists.
- **Verification read-back**: `summarizeDocumentChange` diffs before/after and returns the changed
  lines, not a dispatch echo (`tools.ts:14004-14013`).
- **Relay session ownership**: a second window is displaced with close code 4409 and a reason, and
  the bridge refuses to reconnect (`src/mcp/bridge.ts:119-131`;
  `server/collab-server.mjs:1384-1421`).
- **Agent vocabulary is pinned by a test** against the live parsers
  (`src/mcp/onboarding.ts:9-11`).
- **Assist provenance**: every assist run stamps engine id/version, seed and before/after content
  hashes (`src/commands/patternAssist.ts:123-135`).
- **Model self-announcement**: a model-routed action shows 🤖 in the panel
  (`src/intent/model-ollama.ts:27-28`).

---

## 6. Open questions

1. Is `kyx_intent` _intended_ to cover the mix/complaint lane over MCP, or is `MCP_VOCAB_TEXT`
   simply stale? The two code paths disagree (HCP-04-02).
2. Was the 41-vs-19 route coverage deliberate ("MCP v1 scope") or an oversight? The `sceneIntensity`
   route was explicitly added as a "P2-D remainder" (`route.ts:1059`) but never reached
   `buildIntentCommand`.
3. Does the desktop MCP host (`src/mcp/desktop-host.ts`) carry a selection into the route call? Not
   traced here.
4. Does `kyx_generate` (MCP, `tools.ts:5440`) produce the same candidate set the in-app GENERATE
   shows for audition, or a single applied result? The in-app path shows N candidates
   (`IntentPanel.tsx:1332`); the MCP path applies one (`tools.ts:5444`).
5. Is there a UI surface that enumerates the 39 MCP tools for a human, or is the registry
   (`tools.ts:1660`) the only place they exist?
6. Was `src/ai/bridge/` intended to back an "AI producer bridge" surface that was never wired, or is
   it superseded by `src/intent/`?

---

_No file outside this document was created, edited, or deleted by this session._
