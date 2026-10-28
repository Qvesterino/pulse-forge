# THE HIDDEN CREATIVE POWER AUDIT

**KYX / Pulse Forge** — capability archaeology, discoverability engineering and creative activation
**Date:** 2026-10-27 (updated 2026-10-28) · **Baseline:** `main` @ `5dba8e75` → quick wins @ `03d845d0` → P-4 naming @ `6a7d265c` → P-1 curated palette registry
**Repo:** `D:\pulse-forge` · **Status:** Phase 0–8 complete; 7 QUICK WINs shipped; the P-1 curated registry and the P-4 naming shipped; the rest proposed

---

## 1. Executive summary

KYX is not short of creative power. It is short of **paths to that power**.

Five parallel capability-archaeology passes covered 5 domains (clip editing & arrangement, recording & persistence, sound design & mixing, AI/intent/MCP, productivity & discoverability) and produced **176 catalogued capabilities**, **51 findings**, and a set of measurements that answer the question the brief asks. The headline numbers:

| measure                                                  | value                                       | how measured                                       |
| -------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| command factories in the product                         | **297** across **44 modules**               | AST-ish scan of `src/commands/*.ts`                |
| actions the command palette can ever show                | **55** (51 registry-derived + 4 extras)     | **Observed live** in the running studio + computed |
| command factories reachable from the palette             | **22 of 297 = 7.4 %**                       | dispatcher callee scan                             |
| command factories reachable from _any_ keyboard path     | **26 of 297 = 8.8 %**                       | palette + editor bindings                          |
| factories with **neither** a palette nor a keyboard path | **151 = 50.8 %** (30 of 44 modules)         | set difference                                     |
| intent route kinds                                       | **41** (`src/intent/route.ts:383–468`)      | union enumerated                                   |
| intent route kinds with **no MCP command builder**       | **5** — all 5 work in the in-app Intent Bar | enumerated + probed end-to-end                     |
| effect types / flagship suites                           | **57** / **6**                              | registry                                           |
| effect types with **zero** presets                       | **4 — and all 4 are flagship suites**       | measured against the real preset table             |
| instrument kinds / with a mod matrix                     | **31** / **12**                             | registry                                           |
| dock tabs with no keyboard path                          | **4 of 14** (CHO, KOPA, LIVE, REF)          | registry vs dock                                   |
| disabled controls with no tooltip and no aria-label      | **222 of 551 = 40.3 %**                     | `disabled=` scan, ±12-line window                  |

**The answer to "what creative power is already present but underused because of product friction?"** is: the
_editing_ power is well surfaced and the _capture_ power is invisible. A producer who opens KYX sees 55
palette actions and 51 global shortcuts; every one of them moves something that already exists. What they do
**not** see is anything to do with recording: the palette contains **zero** capture actions (verified live,
not inferred), and the Help overlay's entire `CAPTURE` section is **one** binding. Meanwhile the AI intent
layer can route 41 kinds of instruction and the MCP surface silently no-ops on 5 of them while reporting
success.

**The answer to "which hidden capabilities are genuinely working, versus merely present in code?"** is: the
recording and take lane is the single most complete, most guarded subsystem in the product (30 catalogued
capabilities, 4-step smart comp, durable recovery, an honest crash-recovery banner) — and it is the one with
the weakest discoverability. The effect and instrument engines are genuinely sound. By contrast, five intent
route kinds and one legacy UI branch are _present in code_ and _not reachable_ over the MCP transport.

**What was safely improved now (7 patches, one commit, `03d845d0`):** an undocumented but working
range-consolidation shortcut is now documented; the FX search can find a device by the id the code itself
uses; the six flagship suites are marked as such; the MCP vocabulary no longer promises two families the
transport refuses; **a false success on the MCP surface became an honest refusal**; the mod matrix says when
it is absent instead of vanishing; and a send readout that printed "67 %" while its own caption said
"100 % fully wet" now prints the scale its caption describes.

**And then the two approved proposals landed (§9.2).** The palette grew from **55 to 75 actions** and the
number of representative capability queries that matched **nothing fell from 24 of 48 to 9 of 48** — twelve
capabilities that no query could reach (freeze, quantize, macro, marker, crossfade, chord, groove, velocity,
effect, plugin, humanize, swing) are now findable by name, and each one is pinned by a spec to the exact
action that owns it. The mechanism is a **curated command registry** (`src/commands/palette-registry.ts`),
not a dump of all 297 factories: twenty commands, three rules, and an honest disabled-with-reason state for
the ones that cannot run yet. **The recording family is still not in the palette** — that is P-2, and it is
the largest remaining hole.

**What requires approval:** everything still open in §11 — chiefly a first-run flow that teaches one
thing once, the disclosure of a fixed post-fader send rule as a configurable choice, and the capture
actions that P-1's second phase would put in the palette.

---

## 2. Investigation boundaries

### 2.1 What was in scope

`src/` (product), `tests/` (gates), `docs/` (ADRs and prior audits). Five domains, each with an independent
worker and an evidence file under `docs/audits/2026-10-27-hidden-creative-power/`:

| file                                 | domain                                            | catalogued | findings               |
| ------------------------------------ | ------------------------------------------------- | ---------- | ---------------------- |
| `01-clip-arrangement.md`             | clip editing, arrangement, markers, patterns      | 62         | 12                     |
| `02-recording-persistence.md`        | recording, takes, comp, recovery, persistence     | 30         | 12 (+3 DO-NOT-SURFACE) |
| `03-sound-design-mixing.md`          | instruments, effects, modulation, routing, mixing | 34         | 14                     |
| `04-ai-intent-mcp.md`                | intent router, AI surfaces, MCP tool surface      | 20         | 12                     |
| `05-productivity-discoverability.md` | shortcuts, palette, help, dock, onboarding        | 30         | 14                     |
| **total**                            |                                                   | **176**    | **64**                 |

### 2.2 Evidence vocabulary used throughout

| label                      | meaning                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| **Observed**               | seen in the running application, in this session, in the browser                   |
| **Verified in code/tests** | read in the source _and_ confirmed by a second call site, a spec, or a measurement |
| **Inferred**               | read in the source, single call site                                               |
| **Hypothesized**           | plausible from naming only — flagged every time                                    |
| **Not verified**           | named but not established                                                          |

### 2.3 What was NOT verified — stated limits

- **No microphone, no audio device.** Recording, monitoring, take audio quality and loudness were **not**
  exercised. Every recording claim is code-level or runtime-UI-level, never an audio-level one.
- **The dev server was hostile to observation.** Parallel sessions rewrote 15+ source files during the audit;
  Vite HMR full-reloads invalidated browser references mid-session, and one session produced a
  `Failed to fetch dynamically imported module` crash screen. That is a **dev-server artefact of a shared
  worktree**, not a product defect, and it is excluded from the findings.
- **Line numbers drift.** `src/ui/App.tsx`, `src/commands/*.ts`, `src/project-model/*` and `src/ui/Mixer.tsx`
  were edited by other sessions during the audit. Every citation was re-anchored against the working tree at
  authoring time, but a further commit moves them again. Citations are given as `file:line` **plus the symbol**
  so a reader can re-find the code when the line has moved.
- **The parallel-session sweep.** My `src/ui/Mixer.tsx` change (QW-7) was absorbed into another session's
  commit `11d3e6b0` before I could commit it. The content is intact and its regression test lands in my
  commit `03d845d0`; §10.4 records the split honestly. The same thing happened to the **whole P-1 wave**:
  a peer session's `git add .` commit `aa5b6e83` ("ranny commit") swept in `src/commands/palette-registry.ts`,
  the palette wiring and the specs. The content is intact and verified (§10.1); the **authorship** of that
  commit is the other session's. §10.8 records it.
- **One worker finding was refuted by measurement** (§5.0, HCP-03-06). Findings that did not survive a
  measurement are reported as refuted, not quietly dropped.
- No usage telemetry exists. **No adoption, satisfaction, time-saving or conversion claim is made anywhere in
  this document.**

---

## 3. Existing strengths that should remain untouched

These are the parts of KYX a user already understands, and the audit found no reason to change them.

1. **The registry ↔ dispatcher integrity.** All 51 global shortcuts have exactly one `case` in the global
   dispatcher and vice versa — zero orphans in either direction (`src/ui/shortcuts.ts:109–228` ↔ the
   `runShortcut` switch in `src/ui/App.tsx`). This is the property most products get wrong and KYX gets right.
2. **The palette is never empty and its own examples are honest.** The placeholder advertises "solo, export,
   loop" — all three resolve. 55 actions, every one runnable.
3. **The Help overlay is a real product surface.** 21 editor rows, all 21 traced to a live handler; a DAW
   profile translator (FL Studio / Cubase / Pro Tools); per-binding **CHANGE** affordance with conflict
   detection and `localStorage` persistence (`pf-shortcut-bindings-v1`); a statusbar hint system that answers
   to both `pointerover` and `focusin`, so keyboard users get it too.
4. **The SOURCE and ESSENTIAL KIT docks are the best-explained surfaces in the product.** `SourceMacroDock.tsx`
   states its own pre-condition ("LOAD KICK TO ARM THESE MACROS") _and_ its undo contract ("ONE UNDO STEP")
   in plain language. This is the pattern the rest of the product should copy.
5. **The session-state chip solves a real fragmentation.** Arming, punch range, loop takes, metronome and
   count-in are gathered into one always-visible place instead of five separate indicator strips.
6. **Bypass is honest** (ADR 0068): a bypassed effect stays in the chain on a parallel dry path, so toggling
   never silences the track, and it is a command, so it is undoable.
7. **The effect registry is internally consistent.** Every device's registry params and the panel's param grid
   are the same list — no param without a control, no control without a definition.
8. **The MCP refusal taxonomy (ADR 0070, shipped today) is a genuinely well-designed gate.** Every result
   that changed no document must declare `isError` + a code, or a `stage`. The meta-test scans the source
   with the TypeScript compiler API. This audit's QW-5 is built _on_ that contract, not around it.
9. **The recording recovery path works and tells the truth.** A killed session produced a visible banner
   ("The last session did not end through KYX's normal shutdown… No completed save was recorded") **and** an
   actual recovery card with the project's tempo, track count and age — observed live.
10. **Crash-recovery persistence exists where it matters.** The document, the undo stack and the autosave
    checkpoint all survive an unclean exit; the recovery offer is a first-class surface, not a log line.

---

## 4. Capability Visibility Matrix (A–I)

Classification per the brief: **A** available & discoverable · **B** buried · **C** poorly explained ·
**D** difficult to activate · **E** inconsistent across surfaces · **F** implemented but not correctly wired ·
**G** gated / experimental · **H** dead or unreachable · **I** absent.

| #   | capability                              | class  | one-line reason                                                                                                  | evidence                      |
| --- | --------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | 297 command factories                   | **B**  | 7.4 % reachable from the palette, 8.8 % from any keyboard path                                                   | `05` §2.1                     |
| 2   | Command palette                         | **B**  | 55 actions, 22 of them mutating; the other 33 are transport/navigation/panel toggles                             | **Observed** live             |
| 3   | Palette search                          | **D**  | 25 of 47 representative queries return zero hits ("record", "freeze", "automation", "macro", "effect")           | `05` §2.2                     |
| 4   | Global shortcuts (51)                   | **A**  | 1:1 with the dispatcher; every one documented in Help                                                            | `05` §2.3                     |
| 5   | Editor shortcut list                    | **E**  | 5 of the 11 "Arrangement keys" rows are global bindings printed under "DEPENDS ON FOCUS"                         | `05` §2.4                     |
| 6   | Custom key rebinding                    | **G**  | only Ctrl/Cmd+Shift+one letter is accepted; 10 of 26 letters reserved                                            | `05` §4 HCP-05-06             |
| 7   | Dock tabs (14)                          | **D**  | CHO, KOPA, LIVE, REF have no shortcut and no palette entry — a keyboard user cannot open them                    | `05` §4 HCP-05-11             |
| 8   | Context menu                            | **D**  | Consolidate, the two "Producer edit…" items and Delete are right-click-only                                      | `05` §4 HCP-05-03             |
| 9   | Recording & takes                       | **B**  | the most complete subsystem in the product, and the least reachable from any index                               | `02`                          |
| 10  | Smart comp                              | **B**  | 4 hidden steps: per-take, per-range, auto-detect, commit                                                         | `02`                          |
| 11  | Recording recovery                      | **C**  | a ~380-JSX-line affordance in a different dock tab from the one you record in                                    | `02`                          |
| 12  | Freeze                                  | **B**  | a real, undoable capability with no palette and no keyboard path                                                 | `05` §5                       |
| 13  | Assist engine (vary/build/replace/fill) | **F**  | implemented and undoable — zero MCP tools, zero intent routes; only the Assist panel and Ctrl+Shift+V/F reach it | `04`                          |
| 14  | MCP intent routing                      | **F**  | 5 of 41 route kinds work in-app but no-op over MCP                                                               | measured §5.0                 |
| 15  | MCP vocabulary                          | **E**  | advertises MIX PROFILE and COMPLAINTS that the transport refuses                                                 | `04`                          |
| 16  | Flag effect suites                      | **C**  | 6 vendored suites with their own editors, presented as visually equal tiles                                      | `03`                          |
| 17  | Effect presets                          | **E**  | the 4 deepest suites ship zero presets while `skrutka` ships 24                                                  | measured §5.0                 |
| 18  | Instrument mod matrix                   | **E**  | a MOD-matrix and a MOD panel are different features with similar names                                           | `03`                          |
| 19  | Sends                                   | **C**  | fixed post-fader tap; the hint never said so, and the number contradicted the hint                               | `03` + measured               |
| 20  | Automation lanes                        | **D**  | creatable only from a MOD-panel dropdown — never from the knob                                                   | `03`                          |
| 21  | A/B compare                             | **E**  | snapshot A/B exists for 5 of 57 devices; nothing at chain or track level                                         | `03`                          |
| 22  | Master MATCH EQ                         | **F**  | a live four-band stage with a boolean readout and no control                                                     | `03`                          |
| 23  | Pad velocity layers                     | **D**  | playable and exportable, but only a randomiser can write them                                                    | `03`                          |
| 24  | Onboarding                              | **E**  | 5 mechanisms; the tour and the hint bar teach the same material on different keys                                | `05`                          |
| 25  | Disabled states                         | **E**  | 40.3 % of disabled controls carry no reason; the product also has the correct pattern elsewhere                  | `05`                          |
| 26  | `src/ai/bridge/`                        | **H**  | 16 files, no importers                                                                                           | `04`                          |
| 27  | Legacy inline EffectRack                | **H**  | a second, divergent ADD-FX surface; every production call site uses `mode="devices"`                             | `03` + measured               |
| 28  | `extra:diagnostics` palette entry       | **H?** | the implementation was not located in `src/ui/` in this pass                                                     | `05` §6 q3 — **Not verified** |

---

## 5. Top 15 Hidden Creative Power Findings

Every finding below is evidence-backed. The nine highest-value ones use the full template; the remaining six
are condensed but still carry their evidence.

### 5.0 The one finding that did not survive measurement — HCP-03-06 (WITHDRAWN)

**Original claim (worker, domain 03):** _"Nine instrument kinds ship with an empty preset browser — TSAR,
KOPA, CHORÁL, LADIČ, HĽAS, ŠTRK, CINK, STRUNA, DYMKA have zero presets, and `PresetBrowser.tsx:487` prints
'No presets match.' — the phrasing of a failed search, not of a bank that does not exist."_

**The measurement that refuted it.** The claim was counted by a regex over `src/presets/factory.ts` — the
**core** file. The shipped bank is assembled by a **loader** (`src/presets/factory-loader.ts`) that also
warms "core + real-instrument packs". Measured against the **warmed loader bank**, all 31 instrument kinds
have presets:

```
sampler 187   analog 42   tsar 48   808 36   bass 35   drumsynth 33   kopa 16
texture 20    wavetable 21  keys 24  vocalchop 22  fm 21  granular 16  spectral 16
pluck 14      logdrum 14   flute 10  organ 10   strings 10  bell 10  clav 10  acid 10  brass 10
reese 8       choral 4    ladic 4   hlas 4   strk 4   cink 4  struna 4  dymka 4
```

**Zero kinds have an empty bank.** The "No presets match." string is only ever reached when a _filter_ excluded
everything — a different situation from the one the finding described.

**What was done about it.** The planned quick win — an instrument-aware empty state — was **reverted** before
commit, its regression test was **removed** (it asserted something false), and the finding is reported here as
**withdrawn** rather than quietly dropped. The audit's own gate caught it: the new test failed, and the
failure was the signal.

**Why it matters for the rest of this document.** A finding is a hypothesis about a _class_ of defect, and a
single measurement of one file is not a measurement of the class. Every number in §1 was re-measured against
the path the product actually uses at runtime — the warmed loader, the real MCP dispatcher, the live palette —
not against the file where the code happens to live.

---

### HCP-05-01 — The palette exposes 7.4 % of the command surface

**Class:** B · **Priority:** 1 · **Confidence:** Verified in code + Observed · **Status:** **PARTLY SHIPPED (§9.2.2)** — the curated registry landed; the _derived_ index is still open

**Creative goal:** a producer who knows "KYX can freeze a track" or "KYX can comp takes" must be able to
reach it in two keystrokes.

**Existing capability and evidence:** 297 command factories exist across 44 modules in `src/commands/`.
`buildPaletteActions` (`src/ui/commandPalette.ts:54`) derives actions from `getActiveShortcuts()` **only** —
the shortcut table — plus 4 hard-coded extras (`:77–106`). Result: **22 of 297 factories = 7.4 %** are
palette-reachable, from 13 of 44 modules; **151 factories in 30 modules** have neither a palette nor a
keyboard path. The 30 blind modules are exactly the expressive ones: `automation` (17 factories),
`quantize` (12), `scenes` (12), `plugins` (11), `effectParams` (10), `clipPlayback` (9), `instrument` (8),
`chordTrack` (8), `liveSets` (7), `markers` (6), `master` (4), `freeze` (2), `smart-comp` (1),
`stemTracks` (1).

**Entry points and prerequisites:** Ctrl+K. No prerequisites — which is the point: the barrier is not
activation, it is _inventory_.

**Current activation journey:** Ctrl+K → type → the fuzzy filter searches title / group / keywords / binding
only, and keywords are `sc.key` unless a DAW profile is set (`commandPalette.ts:62–67`) → 25 of 47
representative queries return **zero matches**: record, freeze, bounce, quantize, automation, macro, marker,
crossfade, silence, consolidate, stem, warp, groove, velocity, effect, plugin, waveform, sample, tempo,
humanize, swing, reference. `record` finds nothing; `take` and `arm` match unrelated titles by fuzzy
accident; `comp` matches "Open command palette".

**Barrier and root cause:** _navigation architecture_, not a missing feature. The palette is a **view of the
keyboard layer**, presented as a view of the _product_. Every capability that has no shortcut is invisible to
it — and the product's shortcut layer is by design a thin global layer.

**Recommended minimal intervention:** derive palette actions from the **command registry** — a `Command →
PaletteAction` adapter with an explicit `label` — and keep the shortcut table as the _binding_ source. No
new panel, no wizard: the palette already exists; it is pointed at the wrong list.

**Before/after expected behavior:** before, "freeze" returns nothing; after, "freeze" returns "Freeze track
to an audio asset" with its current binding if it has one.

**Risk, dependencies, rollback:** the registry has 297 factories and many are internal or destructive — an
adapter needs an explicit allow-list per command, or a `paletteVisible` flag. Risk: palette clutter (the
brief's own "cognitive-clutter" axis). Mitigation: keep the ranking, group by family, and start with the
30 blind modules. Rollback: the adapter is additive; the current derivation stays behind a flag.

**Acceptance criteria:** every command in the 30 blind modules is either reachable by a palette query or
explicitly marked not-for-palette; the palette action count is pinned by a spec so it cannot silently grow
past a reviewed ceiling.

**Verification performed:** the coverage ratio and the 25-zero-hit query set were computed against a verbatim
copy of the shipped `fuzzyScore`/`filterActions`; the 55-action count and the absence of any capture action
were **observed live**. Not verified: what a real user searches for.

---

### HCP-02-01 — The palette contains zero capture actions

**Class:** B · **Priority:** 2 · **Confidence:** **Observed live** + Verified in code · **Status:** **STILL OPEN** — the curated registry could not reach the capture family; it is blocked on P-2 (§9.2.2)

**Creative goal:** recording is the highest-value act in music production. It must be reachable from the
surface the product itself advertises as "every action, searchable" (the tooltip on the Ctrl+K button,
`src/ui/TopBar.tsx:371–390`).

**Existing capability and evidence:** **Observed** — the running palette, opened by clicking the "Ctrl+K"
button in the TopBar, lists exactly **55 entries**; **not one** of them is Record, Arm, Take, Comp, Freeze,
Monitor or Punch. The `ShortcutKey` union (`src/ui/shortcuts.ts:9–60`) has no member for any of them.
The only capture binding in the whole product is `A` — "Capture last take (after stop/pause)" — and it lives
in `EDITOR_SHORTCUTS` (`shortcuts.ts:394–398`), which the palette does **not** read.

**Entry points and prerequisites:** the REC strip in the ARR dock tab; the session-state chip in the footer;
right-click menus; `A` for a take. Four different surfaces, none of them indexed.

**Current activation journey:** a producer who wants to record must know that the ARR tab exists, that the REC
button is there, and that a track must be armed first.

**Barrier and root cause:** the palette is derived from the _global shortcut_ table (HCP-05-01), and the
recording controls are deliberately not global shortcuts (they are context-dependent on an armed track and
must not shadow the transport). The result is a structural blind spot: **the product's most important act is
the one thing the product's own index cannot name.**

**Recommended minimal intervention:** add palette-only `extra:` actions for the recording verbs, dispatched
through the same `PaletteDeps.runShortcut` channel the existing 4 extras use (`commandPalette.ts:77–106`) —
plus a `ShortcutKey` extension for the ones that are not focus-bound. Disabled-when-not-armed actions should
render disabled **with the reason** (see HCP-05-07), not vanish.

**Before/after expected behavior:** before, Ctrl+K → "rec" → nothing. After: "Record" (with its arm
pre-condition stated), "Capture last take", "Comp takes".

**Risk, dependencies, rollback:** recording is the highest-consequence subsystem; a palette entry that arms a
track or starts a capture without the same guards the REC button has would be a **regression**. The gate:
the palette must call the **same** handlers, with the same preconditions, and must not be able to start a
capture the REC button would refuse.

**Acceptance criteria:** every capture verb is reachable from the palette; invoking one with an unmet
pre-condition produces the same disabled-with-reason state as the button, never a silent no-op; the recording
recovery affordance is reachable from the same palette.

**Verification performed:** the 55-entry palette and its content were observed in the running studio;
`EDITOR_SHORTCUTS` and the `ShortcutKey` union were read. Not verified: recording behaviour (no audio
device — see §2.3).

---

### HCP-04-01 — Five intent route kinds work in the app and no-op over MCP

**Class:** F · **Priority:** 3 · **Confidence:** Verified in code + **measured end-to-end** · **Status:**
**QUICK WIN SHIPPED (honesty half); wiring still proposed**

**Creative goal:** an AI agent that drives KYX over MCP must be able to trust the answer. A capability that
silently does nothing is worse than one that is absent.

**Existing capability and evidence:** the router has **41 route kinds** (`src/intent/route.ts:383–468`).
`buildIntentCommand` (`src/intent/command-for-route.ts`) has **19** branches. `src/mcp/tools.ts` handles 10
kinds directly (transport, query, undo, sectionTransition, automationPlan, pattern/revise, clarify,
presetUnknown, save/export/record) and refuses 6 (loudness, mix, sectionProduction, sectionFlow,
complaintIntent, select). The remaining kinds are the gap:

| route kind             | in-app                        | MCP            |
| ---------------------- | ----------------------------- | -------------- |
| `checkpointIntent`     | `src/ui/IntentPanel.tsx:4514` | **no builder** |
| `sceneIntensity`       | `src/ui/IntentPanel.tsx:4769` | **no builder** |
| `selectedStepAssist`   | `src/ui/IntentPanel.tsx:4580` | **no builder** |
| `selectedClipArrange`  | `src/ui/IntentPanel.tsx:4640` | **no builder** |
| `selectedRangeArrange` | `src/ui/IntentPanel.tsx:4669` | **no builder** |

**Entry points and prerequisites:** the Intent Bar in the INTENT dock tab; over MCP, `kyx_intent`.

**Current activation journey:** `kyx_intent "restore checkpoint"` → the route resolves → `buildIntentCommand`
falls through to `default: return null` → the executor answered with
`"intent understood but nothing changed (already matches or no target)"`, `stage: "noop"`, **no `isError`**.
**Measured**, not inferred: the document had _not_ already matched; the capability simply was not wired. The
agent was told a success.

**Barrier and root cause:** _incomplete wiring_, surfacing as _missing feedback_. Two different "nothing
happened" cases — "the applier found nothing to do" and "there is no applier" — shared one return value, and
the shared value was the _successful_ one.

**Recommended minimal intervention (shipped):** the executor now distinguishes the two cases. A route kind
with no builder is a **refusal** with a code from the closed taxonomy; a route kind with a builder that
legitimately finds nothing stays a no-op. No new mutation is possible — the change can only turn a false
success into a refusal.

**Recommended minimal intervention (still proposed):** give the five kinds real MCP builders, reusing the
exact commands the in-app panel already calls (`applySceneIntensityIntent` in
`src/intent/studio-words.ts:549` is already written and unused by MCP).

**Before/after expected behavior:** before, an agent believed the checkpoint was restored. After, it receives
`isError: true`, `errorCode: "UNAVAILABLE_ON_TRANSPORT"`, and the route kind's name.

**Risk, dependencies, rollback:** the refusal is a **wire behaviour change** (ADR 0070 called the equivalent
change out explicitly). A client that treated "no `isError`" as success will now see a failure — that is the
point. Rollback: one `if`.

**Acceptance criteria:** an unwired route kind returns a refusal with a code; a wired route kind that
legitimately no-ops still returns `stage: "noop"`; the exported kind set and the switch cannot drift.

**Verification performed:** **shipped and verified** — `tests/intent-command-route-kinds.test.ts` parses the
source with the TypeScript compiler API (the set/switch drift gate) and pins both MCP envelopes end-to-end
through `executeMcpTool`. The refusal taxonomy gate (`tests/mcp-refusal-taxonomy.test.ts`) and the typed error
gate (`tests/mcp-error-codes.test.ts`) both remain green.

---

### HCP-02-12 — The REC button is disabled without a reason

**Class:** D · **Priority:** 4 · **Confidence:** Verified in code · **Status:** proposed

**Existing capability and evidence:** the REC button at `src/ui/ArrangementPanel.tsx:4676` carries a
`title` that explains what it _does_. But a **disabled** button does not fire hover events in most browsers,
so the native tooltip never appears — and the pre-condition (a track armed, an input selected) is never
stated. The same file already contains the correct pattern: the LOOP PASSES control states every one of its
four preconditions in its `title` (`ArrangementPanel.tsx:4343–4349`).

**Barrier and root cause:** _missing feedback_. A greyed-out control is indistinguishable from a broken one.

**Recommended minimal intervention:** when the button is disabled, render the unmet pre-condition in the
title (`title={disabled ? "Record — arm a track first" : "Record the selected audio input…"}`). One line at
one site; it is the pattern already used 1 000 lines below.

**Risk:** none. **Verification:** a spec asserting the title differs between the enabled and disabled states.

---

### HCP-05-03 — Four capabilities are reachable only by right-click

**Class:** D · **Priority:** 5 · **Confidence:** Verified in code · **Status:** proposed

**Existing capability and evidence:** Consolidate, "Producer edit selected clip…", "Producer edit selected
range…" and (in the clip branch) Delete have no shortcut and no palette action
(`src/ui/ContextMenu.tsx:647, :653, :683, :699`). `consolidateTimeRange` has no other caller
(`src/commands/timeRange.ts:388`).

**Recommended minimal intervention:** add them as `extra:` palette actions (the mechanism already exists at
`commandPalette.ts:77–106`) and print their binding inside the menu item, as the menu already does for eight
other items (`ContextMenu.tsx:617, :620, :623, :631, :639, :642, :645, :651`).

**Note (a finding about the finding):** Ctrl+Shift+C _is_ the range-consolidation binding and it works
(`src/ui/App.tsx:1531–1548` → `consolidateRangeToAudio`). It was simply documented nowhere — fixed by QW-1.

---

### HCP-01-04 — A working range-consolidation shortcut that no surface named

**Class:** D · **Priority:** 6 · **Confidence:** Verified in code + **Observed live** · **Status:**
**QUICK WIN SHIPPED**

**Existing capability and evidence:** `src/ui/App.tsx:1531–1548` binds Ctrl+Shift+C to
`consolidateRangeToAudio` → `consolidateTimeRangeToAudio` (`src/commands/timeRange.ts:720`). It worked. It
appeared in **no** help surface — not in `SHORTCUTS`, not in `EDITOR_SHORTCUTS`, not in the palette.

**Current activation journey (before):** the only labelled route was the context-menu button "Consolidate"
(`ArrangementPanel.tsx:6978`) — one word, next to "Strip Silence (PT)", which is an acronym that appears
nowhere else in the codebase.

**Recommended minimal intervention (shipped):** a documented `EDITOR_SHORTCUTS` row — "Consolidate the
selected range to one audio clip", Ctrl+Shift+C.

**Before/after expected behavior:** before, a working feature was reachable only by knowing an undocumented
chord. After, it appears in the Help overlay's ARRANGEMENT section with its binding.

**Risk:** none — documentation only, no behaviour change. **Rollback:** remove one array entry.

**Verification performed:** `tests/ui/shortcuts.test.ts` pins the row's existence, area and label. The Help
overlay was **observed live** before the change and did not contain it.

**Note (proposed, not shipped):** the menu label "Consolidate" collides with the neighbouring "Bounce the
selected range to an audio clip" (Ctrl+B) — a different operation that also produces a range audio print.
Renaming both ("Consolidate range to audio" / "Bounce range for review") is a **product naming decision** and
is listed in §11, not shipped. Likewise "Strip Silence (PT)": the acronym appears nowhere else in `src/`, so
what it means is unknown to this audit — it needs the author's word, not a guess.

---

### HCP-03-02 — The FX search cannot find a device by the id the code uses

**Class:** D · **Priority:** 7 · **Confidence:** Verified in code + verified by test · **Status:**
**QUICK WIN SHIPPED**

**Existing capability and evidence:** the ADD-FX popover matched the **display name** and the blurb only
(`src/ui/FxAddPopover.tsx:104–105`). The ids `fxeq`, `ultina`, `ozvena`, `morphdynamics` are what the MCP
tools, the intent parser and the command layer use. A user or an agent who knows the plugin by its id found
nothing.

**Recommended minimal intervention (shipped):** the registry id is now part of the searchable vocabulary.

**Additional correction shipped:** the file's own header comment claimed "The old `<select>` list stays
available as 'ALL DEVICES' in the rack". A search of `src/` for "ALL DEVICES" returns **exactly one hit —
that comment**. The surface it describes does not exist; the popover _is_ the device list. The comment is
now corrected (and every production `EffectRack` call site passes `mode="devices"`, so the legacy inline
rack branch is unreachable in production — measured).

**Verification performed:** `tests/ui/FxAddPopover.test.tsx` — a query of "fxeq" now finds PRISM.

---

### HCP-03-01 — The flagship tier has no UI concept

**Class:** C · **Priority:** 8 · **Confidence:** Verified in code · **Status:** **QUICK WIN SHIPPED**

**Existing capability and evidence:** `FLAGSHIP_EFFECT_ORDER` (`src/effects/definitions.ts:326`) names six
suites — PRISM, VLYX, DRIFT, RIFT, MORPH, REZONANS — each with a vendored DSP core and its own editor. The
ADD-FX grid rendered all **57** devices as visually equal tiles (`FxAddPopover.tsx:193–207`); searching
`src/ui/**` for "flagship" returned only code comments. The tier reached the user inconsistently through
blurb wording (four blurbs say "Flagship", one says "Vendored PRISM EQ", one says nothing).

**Recommended minimal intervention (shipped):** a `SUITE` marker on the six flagship tiles plus a tooltip
that says what a suite is; the tier word is searchable.

**Risk:** a badge is a small visual addition to an existing grid — no new panel, no new surface. **Rollback:**
remove the span.

**Verification performed:** `tests/ui/FxAddPopover.test.tsx` — PRISM carries the marker, "Vinyl Suite" does
not, and "flagship" is a query that returns the six.

---

### HCP-05-07 — 40.3 % of disabled controls explain nothing

**Class:** E · **Priority:** 9 · **Confidence:** Verified in code · **Status:** proposed

**Existing capability and evidence:** a scan of `src/**/*.tsx` found **551** `disabled=` attributes. Within
±12 lines of the same element, **197 (35.8 %)** carry a `title`, **214 (38.8 %)** an `aria-label`, and
**222 (40.3 %)** carry **neither**. Specific cases: `ScenesPanel.tsx:125/133/141` (FILL / DROP / BREAK),
`ArrangementPanel.tsx:4779/4787/4797/5081/5093/5588/5603/5618`, `ContextMenu.tsx:616/619/622/629/653`
("Consolidate" greys out silently with no time range).

**Barrier and root cause:** _missing feedback_, applied inconsistently. The product both explains and hides
the same class of gate — the LOOP PASSES control (`ArrangementPanel.tsx:4343`) states every precondition, and
"Select exactly one arrangement clip" (`ContextMenu.tsx:677–681`) does too.

**Recommended minimal intervention:** make `title` mandatory on a disabled button — a lint rule seeded by the
existing correct examples — plus a statusbar hint for the controls that cannot hold a title.

**Risk:** a lint rule across 551 sites needs an exception list; do it incrementally, not as a sweep.

---

### HCP-04-02 — The MCP vocabulary promises two families the transport refuses

**Class:** E · **Priority:** 10 · **Confidence:** Verified in code + **measured** · **Status:**
**QUICK WIN SHIPPED**

**Existing capability and evidence:** `MCP_VOCAB_TEXT` (`src/mcp/onboarding.ts:158–203`) documents **MIX
PROFILE** (`:165`) and **COMPLAINTS** (`:175`) as capabilities. The executor refuses both kinds with
`UNAVAILABLE_ON_TRANSPORT` (`src/mcp/tools.ts:13925–13937`) because they need in-app auditioning.

**Measured:** "more reverb please" → route kind `mix` → refused. "the lead is harsh" → `complaintIntent` →
refused. "16-bar intro and drop twice" → `pattern` → refused (a _different_ refusal — generation). The
vocabulary already had the right convention for exactly this case — "GENERATION (refused over kyx_intent —
use kyx_generate)" — it was simply not applied to the other two sections.

**Recommended minimal intervention (shipped):** both sections are now marked `IN-APP ONLY`, in the
convention the GENERATION section already used.

**Risk:** none — a documentation string. The pinned vocab test (`tests/mcp-onboarding.test.ts`) still holds.

---

### HCP-03-04 — The send readout contradicts its own caption

**Class:** F · **Priority:** 11 · **Confidence:** Verified in code + **measured** · **Status:**
**QUICK WIN SHIPPED (source; see §10.4 for the commit split)**

**Existing capability and evidence:** the send control's hint read _"OFF is dry, 100% fully wet (up to 150 %
for pushes)"_ while its formatter was `(v) => Math.round((v / 1.5) * 100) + "%"`. The model stores a send in
**0…1.5 with 1.0 = unity** and the engine clamps to the same band (`clampSendLevel`,
`src/audio-engine/AudioEngine.ts:82–84`). So **unity printed "67 %"** while the sentence under it said
"100 % fully wet" — and the maximum printed "100 %" instead of "150 %".

**Barrier and root cause:** the number and the caption describe two different scales.

**Recommended minimal intervention (shipped):** an exported `formatSendLevel` prints the documented scale —
0…100 % of the send, and anything above unity as an explicit push (`+50 %`). The hint now also states
**POST-FADER**, because the send is tapped at `nodes.modMacroPan`
(`src/audio-engine/AudioEngine.ts:2636`) — after the fader, the volume lane and the macros
(strip chain `:2169–2175`), and nothing said so.

**Verification performed:** `tests/ui/Mixer.test.tsx` pins the six scale points.

**Note:** the _disclosure_ is shipped; making the rule **configurable** is a model change and is in §11.

---

### HCP-03-11 — "MOD MATRIX" and the "MOD" panel are different features with similar names

**Class:** C/E · **Priority:** 12 · **Confidence:** Verified in code · **Status:**
**QUICK WIN SHIPPED**

**Existing capability and evidence:** the MOD **dock tab** (`src/ui/DockChrome.tsx:82–87`, Alt+4) opens
automation, LFOs and macros (`src/ui/ModPanel.tsx:275`). The instrument **mod matrix** is a different thing
(`src/ui/ModMatrixRow.tsx`), reachable only behind the Inspector's ADVANCED toggle. Only **12 of 31**
instrument kinds define one (`src/instruments/modmatrix.ts:401`); the other **19** rendered `null` — so a
user could not tell "this instrument has no mod matrix" from "this panel is broken".

**Recommended minimal intervention (shipped):** the component now says which instrument has no mod matrix,
and carries a title that separates the instrument matrix from the MOD panel.

---

### HCP-01-03 — MIDI and automation lanes have no Split

**Class:** D · **Priority:** 13 · **Confidence:** Verified in code · **Status:** proposed

**Existing capability and evidence:** the audio-clip context menu offers Split; the **MIDI and automation
lane menus do not** (`src/ui/ArrangementPanel.tsx` lane menus). Yet `splitAudioClipAtTick` and the tick-lane
siblings exist, and the tick-lane specs (`tests/tick-lane-edit-matrix.test.ts`) already exercise a split
that preserves every attack exactly once.

**Barrier and root cause:** menu depth + inconsistent surface. A gesture that exists in one lane is absent
in its siblings, so the capability reads as "not supported here".

**Recommended minimal intervention:** add Split to the MIDI and automation lane menus, with the
attack-preservation read-back the spec already proves.

---

### HCP-05-11 — Four dock tabs are unreachable without the mouse

**Class:** D · **Priority:** 14 · **Confidence:** Verified in code · **Status:** proposed

**Existing capability and evidence:** CHO, KOPA, LIVE and REF have no `shortcut:` field
(`src/ui/DockChrome.tsx:57–61, :63–67, :76–80, :124–128`) while the other ten do; `PANEL_IDS_BY_SHORTCUT`
lists exactly ten ids. The source comment at `shortcuts.ts:77–78` asserts _"every dock tab is now
keyboard-reachable (ROADMAP-UI-2027 V1)"_ — **a false claim in the source**. The reference map (BPM / key /
confidence), the choir designer and the kick designer cannot be opened by a keyboard-only user.

**Recommended minimal intervention:** add four `panel*` shortcuts (the registry already has the ten that
exist, so the extension is mechanical) and correct the comment.

---

### HCP-03-07 — The four deepest flagship suites ship zero presets

**Class:** E · **Priority:** 15 · **Confidence:** **Measured** · **Status:** proposed

**Existing capability and evidence:** `presetsForEffect` measured over all 57 types: **exactly four types
have zero presets — and all four are flagship suites**: `fxeq` (PRISM), `ultina` (VLYX), `ozvena` (DRIFT),
`morphdynamics` (MORPH). Meanwhile `skrutka` ships 24, `svFilter` / `vinyl` / `rezonans` / `kaskada` /
`freqShifter` / `portal` ship 7 each. Because the rack's PRESETS control only renders when the list is
non-empty (`src/ui/EffectRack.tsx:843`), on those four devices the control **does not exist** — and the
ADD-FX tile badge shows no "N starts".

**Barrier and root cause:** _poor defaults, running backwards_. The gradient of help runs opposite to the
gradient of complexity: the devices that demand the most setup knowledge are the ones with no starting
point.

**Recommended minimal intervention:** seed 3–5 starting presets per flagship in `src/effects/presets.ts`, or
reuse the existing role-landing values (`src/effects/role-presets.ts:54`) as the seed of the first preset.

**Risk / why it is not a quick win:** writing a good PRISM preset is _content_, not a patch — it needs DSP
knowledge and taste, and it is exactly "adding new functionality" that the brief subordinates to surfacing
what exists. Proposed, not shipped.

---

## 6. Creative Combination Opportunities

Each of these is a composition of **verified existing primitives**. None claims to exist as a unified feature
today. Each lists the missing glue and compares it against the alternative of a new subsystem.

### 6.1 Clip selection + quantize + groove → fast rhythmic variation

- **Primitives (all verified):** clip/time-range selection · quantize (12 factories in `src/commands/quantize.ts`,
  no palette path) · groove/swing (`src/project-model/groove.ts`, section-scoped groove intents) · DICE
  (locks survive a roll, Apply is one undo step).
- **Missing glue:** a single action that quantises the selection _using the current groove_ rather than a
  fixed grid. The pieces exist; the composition does not.
- **Exposure:** one contextual action on a clip selection, or one palette action, previewing the before/after.
- **Minimal vs new subsystem:** minimal — quantise already takes a grid argument; the composition is a
  pre-filled grid derived from the groove, not a new subsystem.
- **Safety:** one undo step; quantise is a command.

### 6.2 Take + comp + fades → faster vocal assembly

- **Primitives:** take lanes (`ArrangementPanel.tsx:6209`) · smart comp (4 hidden steps, per-take and
  per-range) · `COMPARE` / `AUTO` / range-comp · fades on the clip.
- **Missing glue:** a single "comp this take lane" action that ends with a faded, crossfaded result.
- **Exposure:** the COMP RANGE control already exists inside TAKE LANES and already carries a title and a
  hide-unless-different rule — it is a good host for one more action.
- **Safety:** comp is a command, one undo step; fades are commands.

### 6.3 Automation + effects + macros → expressive evolution

- **Primitives:** automation lanes (`src/commands/automation.ts:34`) · macro→target mappings
  (`src/commands/automation.ts:277–560`) · the "AUTO" badge on a live knob
  (`src/ui/EffectParameterGrid.tsx:116–125`) · the deep macro target catalogs for PRISM/VLYX/DRIFT
  (`src/project-model/targets.ts:177–208`).
- **Missing glue:** creating a lane **from the knob** — today a lane is created only from a MOD-panel
  dropdown (HCP-03-05).
- **Exposure:** one entry in the slider's context menu (`src/ui/controls.tsx:484`) and the fader's
  (`src/ui/Mixer.tsx:740–780`) — both already know the track and the param id.
- **Minimal vs new subsystem:** minimal; it is a menu item that calls `addAutomationLane`, which exists.
- **Risk:** the MOD panel's target list is long; the knob context menu must name the parameter, not the list.

### 6.4 Markers + duplication + batch editing → rapid arrangement exploration

- **Primitives:** markers (6 factories, no palette path) · duplicate selection (Ctrl+D) · group/ungroup
  (Ctrl+G / Ctrl+Shift+G) · scene sections.
- **Missing glue:** a "duplicate this scene with its markers" action.
- **Exposure:** a scene-lane context-menu item.
- **Safety:** one undo step; the scene clip geometry has its own contract (the scene lane refuses an
  overlapping placement).

### 6.5 AI intent + command APIs + preview/undo → safe multi-step assistance

- **Primitives:** the 41-kind router · the plan/dry-run layer (`src/intent/semantics/intent-plan.ts:489`
  already calls `buildIntentCommand`) · the assist engine
  (`src/commands/patternAssist.ts:155–215`, `assistSelectionCommands.ts`) · checkpoint-before-destructive
  (`src/intent/route-guard.ts`).
- **Missing glue:** the Assist engine has **zero MCP tools and zero intent routes** — it is reachable only
  from the Assist panel and Ctrl+Shift+V / Ctrl+Shift+F (HCP-04-03). And the five unwired route kinds are the
  in-app half of the same asymmetry.
- **Exposure:** route `selectedStepAssist` and the assist verbs through `buildIntentCommand`; give the
  Assist engine MCP tools with the same approval model the other mutations use.
- **Minimal vs new subsystem:** minimal — the engine, the commands and the plan layer all exist.

### 6.6 Presets + A/B + metering → faster sound decisions

- **Primitives:** 206 effect presets · snapshot A/B for 5 devices (`src/ui/EffectAbControls.tsx:40`) ·
  meters, goniometer, spectrum (`src/audio-engine/metering.ts`).
- **Missing glue:** A/B exists **per device**, not per chain or per track, and `EffectInstance.deviceState`
  is per-device by construction — so "compare the whole chain" has no substrate.
- **Exposure:** a chain-level snapshot in the DEV dock.
- **Safety:** the command layer already stores a generic `effect-ab-v1` device state
  (`src/ui/EffectRack.tsx:1282`) — generalising it is a small change.

### 6.7 The composer's own combination — the one this audit recommends first

- **Primitives:** the **intent router** (41 kinds, EN + SK) · the **command registry** (297 factories) ·
  the **palette** (55 actions) · the **plan layer** (dry-run) · the **MCP surface** (~40 of the same
  factories).
- **Missing glue:** the four entry paths are four _separate lists_. The palette is a view of the keyboard;
  MCP is a view of ~40 hand-picked tools; the router is a view of 41 kinds; the registry holds 297.
- **Why this is the composition that matters:** HCP-05-01, HCP-02-01, HCP-04-01 and HCP-04-03 are all the
  _same_ root cause seen from four surfaces — **there is no single index of what the product can do.** A
  command-registry-derived index with typed labels would fix the palette, give MCP a generated tool
  surface, and give the intent router a completeness check.

---

## 7. Discoverability and activation journey maps

### 7.1 Record a take (the highest-value act in the product)

| stage                   | what the user must do today                                   | friction                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| intention               | "I want to record a vocal"                                    | —                                                                                                                                           |
| recognition             | the ARR dock tab contains a REC strip                         | the REC control is in the **ARR** tab; the _recording_ affordances are in a different dock tab (**LIVE/TAKE LANES**) and in the footer chip |
| entry point             | ARR tab → REC button                                          | two tabs and a context menu compete for the same job                                                                                        |
| prerequisites           | a track armed, an audio input selected, a mic permission      | **not stated on the disabled button** (HCP-02-12); the preconditions are knowable only from the code                                        |
| action                  | click REC                                                     | —                                                                                                                                           |
| feedback                | armed chip, take lanes, REC counter                           | present and good — the session-state chip is a strength                                                                                     |
| audible/visible outcome | the take appears in TAKE LANES                                | —                                                                                                                                           |
| undo/recovery           | a durable checkpoint + a recovery offer after an unclean exit | **the recovery affordance is ~380 JSX lines in another tab** (HCP-02-11)                                                                    |
| **index**               | **the palette has no capture action at all**                  | **HCP-02-01**                                                                                                                               |

### 7.2 Consolidate a selected range to one audio clip

| stage         | before                                                                   | after (QW-1)                                                   |
| ------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| intention     | "this passage should become one audio clip"                              | —                                                              |
| recognition   | "Consolidate" in a context menu; a second, different "Bounce" next to it | a Help row: "Consolidate the selected range to one audio clip" |
| entry point   | right-click, or the undocumented Ctrl+Shift+C                            | the Help overlay's ARRANGEMENT section                         |
| prerequisites | a time range over ≥2 audio clips                                         | unchanged                                                      |
| action        | click / chord                                                            | unchanged                                                      |
| feedback      | the range is replaced by one clip, one undo step                         | unchanged                                                      |
| recovery      | Ctrl+Z                                                                   | unchanged                                                      |
| **gap**       | **the feature worked but no surface named it**                           | **closed**                                                     |

### 7.3 Find a flagship plugin (PRISM)

| stage         | before                                          | after (QW-3)                                        |
| ------------- | ----------------------------------------------- | --------------------------------------------------- |
| intention     | "I want the PRISM EQ"                           | —                                                   |
| recognition   | a tile named "PRISM" among 57 equal tiles       | a tile named "PRISM" marked **SUITE**               |
| entry point   | DEV → ✚ ADD FX → scroll/guess                   | DEV → ✚ ADD FX → type "prism", "fxeq" or "flagship" |
| prerequisites | none                                            | none                                                |
| action        | click the tile                                  | same                                                |
| feedback      | the device appears with a bespoke editor        | same                                                |
| **gap**       | the tier was invisible; the id was unsearchable | **closed**                                          |

### 7.4 Ask the AI agent to restore a checkpoint (over MCP)

| stage         | before                                                                                         | after (QW-5)                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| intention     | "restore the checkpoint"                                                                       | —                                                                               |
| recognition   | the MCP vocabulary does not mention checkpoint restore as a text intent                        | same                                                                            |
| entry point   | `kyx_intent "restore checkpoint"`                                                              | same                                                                            |
| prerequisites | —                                                                                              | —                                                                               |
| action        | —                                                                                              | —                                                                               |
| feedback      | _"intent understood but nothing changed (already matches or no target)"_ — a **false success** | `isError: true`, `errorCode: "UNAVAILABLE_ON_TRANSPORT"`, naming the route kind |
| recovery      | the agent assumes success and moves on                                                         | the agent learns the capability is not on this transport                        |

---

## 8. Prioritized backlog

Scores are 1–5 on the brief's axes. **CV** creative value unlocked · **FR** frequency/reach of the workflow ·
**SB** severity of the discovery/activation barrier · **EC** evidence confidence · **IE** implementation effort
(higher = more work) · **RC** regression / cognitive-clutter risk (higher = more risk).

| #   | finding                                                  | CV  | FR  | SB  | EC  | IE  | RC  | class                                                     | rationale                                                                                    |
| --- | -------------------------------------------------------- | --- | --- | --- | --- | --- | --- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | HCP-05-01 palette = 7.4 % of commands                    | 5   | 5   | 5   | 4   | 4   | 3   | **WORKFLOW FIX**                                          | the structural cause of most of this list; needs an explicit visibility flag per command     |
| 2   | HCP-02-01 palette has zero capture actions               | 5   | 4   | 5   | 5   | 3   | 3   | **WORKFLOW FIX**                                          | the most valuable act is the one the index cannot name; highest consequence of getting wrong |
| 3   | HCP-04-01 five route kinds no-op over MCP                | 5   | 3   | 5   | 5   | 2   | 2   | **QUICK WIN (shipped — honesty)** / WORKFLOW FIX (wiring) | a false success is worse than an absence                                                     |
| 4   | HCP-02-12 REC disabled without a reason                  | 4   | 5   | 4   | 4   | 1   | 1   | **QUICK WIN**                                             | one line, and the correct pattern already exists 1 000 lines away                            |
| 5   | HCP-03-04 send % contradicts its caption                 | 4   | 3   | 4   | 5   | 1   | 1   | **QUICK WIN (shipped)**                                   | a number that lies about the state of the mix                                                |
| 6   | HCP-01-04 undocumented Ctrl+Shift+C                      | 3   | 2   | 4   | 5   | 1   | 1   | **QUICK WIN (shipped)**                                   | a working feature, invisible                                                                 |
| 7   | HCP-03-02 FX search misses the code's own ids            | 3   | 3   | 3   | 5   | 1   | 1   | **QUICK WIN (shipped)**                                   | search vocabulary = code vocabulary                                                          |
| 8   | HCP-03-01 flagship tier invisible                        | 3   | 3   | 3   | 4   | 1   | 2   | **QUICK WIN (shipped)**                                   | six suites, one tile style                                                                   |
| 9   | HCP-04-02 MCP vocabulary over-promises                   | 4   | 2   | 4   | 5   | 1   | 1   | **QUICK WIN (shipped)**                                   | agents plan against a promise the transport breaks                                           |
| 10  | HCP-03-11 mod matrix vs MOD panel                        | 3   | 2   | 3   | 4   | 1   | 1   | **QUICK WIN (shipped)**                                   | 19 instruments render nothing                                                                |
| 11  | HCP-05-07 40.3 % unexplained disabled states             | 4   | 4   | 4   | 4   | 3   | 2   | **WORKFLOW FIX**                                          | 222 controls; needs an incremental lint + exception list                                     |
| 12  | HCP-05-11 four dock tabs mouse-only                      | 3   | 3   | 4   | 4   | 2   | 2   | **WORKFLOW FIX**                                          | the source comment claims the opposite                                                       |
| 13  | HCP-03-05 automation only from a dropdown                | 4   | 3   | 4   | 4   | 2   | 2   | **WORKFLOW FIX**                                          | one context-menu item each; the command exists                                               |
| 14  | HCP-01-03 no Split in MIDI/automation lanes              | 3   | 3   | 3   | 4   | 2   | 2   | **WORKFLOW FIX**                                          | the split contract is already proven by a spec                                               |
| 15  | HCP-05-08 palette failures are silent unless ARR is open | 4   | 3   | 4   | 4   | 2   | 2   | **WORKFLOW FIX**                                          | `pf-arrangement-action-error` has exactly one subscriber                                     |
| 16  | HCP-02-11 recovery affordance in another dock tab        | 4   | 2   | 4   | 4   | 3   | 2   | **WORKFLOW FIX**                                          | move/point at it; do not rewrite it                                                          |
| 17  | HCP-03-07 four flagship suites ship zero presets         | 3   | 3   | 3   | 5   | 4   | 2   | **EXPERIMENT**                                            | writing 12–20 good presets is content, not a patch                                           |
| 18  | HCP-03-02b role landings skip every flagship             | 2   | 3   | 3   | 4   | 3   | 2   | **WORKFLOW FIX**                                          | the badge promises a landing that does not come                                              |
| 19  | HCP-03-10 master MATCH EQ has no manual control          | 3   | 2   | 4   | 4   | 3   | 2   | **WORKFLOW FIX**                                          | a live stage the user cannot see                                                             |
| 20  | HCP-05-09 two onboarding mechanisms, two keys            | 3   | 4   | 3   | 4   | 2   | 3   | **WORKFLOW FIX**                                          | share one completion key                                                                     |
| 21  | HCP-02-02 smart comp is four hidden steps                | 4   | 2   | 4   | 3   | 4   | 3   | **EXPERIMENT**                                            | needs user research on the step order                                                        |
| 22  | HCP-02-04 stem tracks are MCP-only, no UI import         | 3   | 2   | 4   | 3   | 4   | 2   | **DESIGN APPROVAL**                                       | decide whether the UI earns a stem workflow                                                  |
| 23  | HCP-05-06 rebinding restricted to Ctrl+Shift+letter      | 2   | 2   | 3   | 4   | 3   | 3   | **EXPERIMENT**                                            | widen carefully; OS-reserved chords still blocked                                            |
| 24  | HCP-03-03 post-fader sends not configurable              | 3   | 2   | 3   | 4   | 4   | 3   | **DESIGN APPROVAL**                                       | a model change; the _disclosure_ shipped                                                     |
| 25  | HCP-03-13 legacy inline EffectRack branch                | 1   | 1   | 2   | 4   | 2   | 3   | **DO NOT SURFACE**                                        | delete after confirming no surface is planned                                                |

### 8.1 Classification totals

| class           | count                                                          |
| --------------- | -------------------------------------------------------------- |
| QUICK WIN       | 10 (7 shipped, 3 not started — all gated out by scope or risk) |
| WORKFLOW FIX    | 15                                                             |
| EXPERIMENT      | 3                                                              |
| DESIGN APPROVAL | 2                                                              |
| DO NOT SURFACE  | 1                                                              |

### 8.2 Explicit DO-NOT-SURFACE list

These capabilities exist and are **deliberately** kept out of the palette, the menus and the onboarding. They
are listed so a later audit does not "discover" them and propose surfacing them.

1. **Destructive intent routes behind an unlock** — `routeIsDestructive` (`src/intent/route-guard.ts`) plus
   the auto-checkpoint. Surfacing them as palette one-liners would remove the checkpoint.
2. **Live audition / loudness measure-trim / mix-profile** — refused over MCP with `UNAVAILABLE_ON_TRANSPORT`
   because they need in-app auditioning. The refusal is the product.
3. **Generation over `kyx_intent`** — refused with a pointer to `kyx_generate`.
4. **Mic-record and comp over MCP** — permission-sensitive; the structured tools carry the guards.
5. **The legacy inline EffectRack branch** — dead in production; it should be deleted, not surfaced.
6. **The 40.3 % of disabled controls without a reason** are a _fix_ target, not a _surface_ target — they stay
   disabled.

---

## 9. Implemented quick wins — change log

All seven patches are in **one commit on `main`: `03d845d0`** — _"feat(audit): the hidden creative power quick
wins — seven gated patches, each traceable to an HCP-XX finding"_.

| id       | finding              | file                                                           | change                                                                                                                            | gate                                                               |
| -------- | -------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **QW-1** | HCP-01-04            | `src/ui/shortcuts.ts`                                          | added the `EDITOR_SHORTCUTS` row "Consolidate the selected range to one audio clip" — Ctrl+Shift+C                                | documentation only; no behaviour change                            |
| **QW-2** | HCP-03-02            | `src/ui/FxAddPopover.tsx`                                      | the registry id is now searchable; the stale "ALL DEVICES" comment corrected                                                      | search predicate + comment                                         |
| **QW-3** | HCP-03-01            | `src/ui/FxAddPopover.tsx`, `src/styles/03-mixer.css`           | a `SUITE` marker on the six flagship tiles + a tooltip; the tier is searchable                                                    | one span + one CSS rule                                            |
| **QW-4** | HCP-04-02            | `src/mcp/onboarding.ts`                                        | MIX PROFILE and COMPLAINTS marked `IN-APP ONLY`                                                                                   | a documentation string                                             |
| **QW-5** | HCP-04-01            | `src/intent/command-for-route.ts`, `src/mcp/tools.ts`          | an unwired route kind is a **refusal with a code**, not a success-shaped no-op; the exported kind set + a compiler-API drift gate | adds no mutation — it can only turn a false success into a refusal |
| **QW-6** | HCP-03-11            | `src/ui/ModMatrixRow.tsx`, `src/styles/14-command-palette.css` | the mod matrix says which instrument has none; a title separates it from the MOD panel                                            | one branch + one CSS rule                                          |
| **QW-7** | HCP-03-03, HCP-03-04 | `src/ui/Mixer.tsx`                                             | `formatSendLevel` prints the documented scale; the hint states POST-FADER                                                         | formatting + a caption (see §10.4)                                 |

### 9.1 Files touched

```
src/intent/command-for-route.ts      +37   the exported kind set + its drift-gate comment
src/mcp/onboarding.ts                 +6/-2 the MCP vocabulary, corrected
src/mcp/tools.ts                      +15/-1 the honest refusal
src/styles/03-mixer.css               +14   the SUITE marker
src/styles/14-command-palette.css    +9    the mod-matrix absent state
src/ui/FxAddPopover.tsx               +31/-4 the searchable id, the tier, the corrected comment
src/ui/ModMatrixRow.tsx               +19/-3 the absent state + the title
src/ui/shortcuts.ts                   +5    the Ctrl+Shift+C row
src/ui/Mixer.tsx                      ≈16   formatSendLevel + the POST-FADER hint  (see §10.4)
tests/intent-command-route-kinds.test.ts  (new, 3 tests) the compiler-API drift gate + the MCP envelopes
tests/mcp-onboarding.test.ts          +11   the vocabulary honesty gate
tests/ui/FxAddPopover.test.tsx        +27   the id search, the tier marker, the tier search
tests/ui/Mixer.test.tsx               +13   the send scale
tests/ui/ModMatrixRow.test.tsx        +9    the absent state
tests/ui/shortcuts.test.ts            +11   the documented consolidation row
```

**Nothing else was touched.** No audio path, no file format, no permission boundary, no edit semantics, no
schema version, no dependency, no bundle budget.

---

## 9.2 The P-1 and P-4 wave — what shipped after the proposals were approved

Two proposals from §11 were approved and implemented in a second wave.

### 9.2.1 P-4 · The naming decisions (`6a7d265c`)

Five files, +20/−8, four suites green. The four decisions and what each one resolved:

| decision                | the problem                                                                        | the resolution                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| "Strip Silence (PT)"    | the acronym has no legend anywhere in `src/`                                       | **"Strip Silence"** plus a tooltip that states pitch and tempo are preserved     |
| Consolidate vs Bounce   | two different operations, two similar names, one word apart                        | **"Consolidate to one clip"**; the Bounce row now says "A/B review, then commit" |
| MOD MATRIX vs MOD panel | the panel and the matrix had similar names and no separator                        | a visible **MOD MATRIX** caption in the component, on both surfaces              |
| four panel labels       | `panelArr` said "Toggle arrangement" while its nine siblings said "Toggle X panel" | all four say **"Toggle X panel"**                                                |

The scope is now distinguished, not the vocabulary: "Consolidate" stays a word in the app because the app's
own vocabulary uses it (`src/ui/ContextMenu.tsx:138`), and the **scope** is what the label now carries.

**The "(PT)" decision was the author's word, so it is now a gate.** The tooltip says the clip keeps its
**pitch and its tempo** — the author's own phrasing, confirmed against the implementation before the
wording was fixed: a stripped fragment inherits the parent clip (`...clip`), keeps the parent's playback
rate (`audioClipSourceSecondsPerWallSecond`) and reads the same source span (`offsetSec: seg.start`,
`trimStart`/`trimEnd` reset to 0), so the pitch is preserved and the clip's tempo is preserved — nothing is
re-tuned. `tests/ui/strip-silence-naming.test.ts` holds the decision: the label carries no acronym suffix,
**no source file** still contains "(PT)", and the tooltip must name pitch **and** tempo — and must not
quietly swap the author's "tempo" for the near synonym "speed". The gate was **falsified twice** before it
was trusted: mutating the tooltip back to "speed" and putting "(PT)" back into the label each failed the
gate **on its own claim** (not on a missing symbol), and the acronym check names the offending file.

### 9.2.2 P-1 · The curated palette command registry

The structural cause of HCP-05-01 was that the palette was a **view of the keyboard layer**:
`buildPaletteActions` read `getActiveShortcuts()`, so it could only ever show what the global shortcut table
already had. 297 command factories existed; the palette reached 22 of them (7.4 %).

**Why a curated list and not all 297.** A registry-driven palette over every factory would leak internal and
destructive commands into the user's search box by default, and the brief's own "cognitive clutter" axis is a
real cost. So the registry is a **whitelist**: a command earns a place by being a one-shot operation, fully
described by the document plus the selection, and reversible through the ordinary undo stack. Three rules hold
it together, and a spec gates each of them:

1. **ONE SHOT** — what needs a dialog, a typed value or a rendered buffer does not belong in the palette. That
   is why tempo, sample and waveform are _not_ here: they need a value only the user can supply.
2. **HONEST** — `precondition` returns the reason the action cannot run right now, and the palette renders the
   row **disabled with that reason visible**. `aria-disabled`, not the `disabled` attribute: a disabled button
   fires no hover, so the reason would never be readable — which is exactly the HCP-05-07 failure mode.
3. **NO NEW POWER** — every spec's `build` returns a command the product already has. The registry adds no
   mutation, no audio path and no edit semantics; it only gives the existing commands a way in.

**20 commands**, drawn from the 30 blind modules (pattern ×6, groove ×2, marker, scenes ×2, live set,
instrument, effects ×2, mix, chords, macros, clips ×2).

**The measurement, before and after:**

| measure                                                  | before   | after       |
| -------------------------------------------------------- | -------- | ----------- |
| palette actions                                          | 55       | **75**      |
| representative capability queries that match **nothing** | 24 of 48 | **9 of 48** |
| capabilities findable by name                            | —        | **12**      |

The twelve are pinned by spec to the exact action that owns each one — freeze, quantize, macro, marker,
crossfade, chord, groove, velocity, effect, plugin, humanize, swing — because a **count would have flattered
the result**: "record", "tempo" and "stem" also stopped being zero, but only by coincidence of the
subsequence matcher ("record" lands on "Conform the selected clips to the chord track"). **The recording
family is still unreachable from the palette**, and that is not a registry entry: `armedTrackId` and the
recorder state are local React state inside the arrangement panel (`src/ui/ArrangementPanel.tsx:755`), so
exposing them is the **P-2** proposal — one address for the recording surface.

The nine that still match nothing — **bounce, automation, midi clip, silence, consolidate, warp, waveform,
sample, reference** — are commands that need a dialog, a value, or a rendered buffer.

**Where the failures go.** A palette command that fails surfaces through `store.notify` → the existing global
`CommandToast`, not through `pf-arrangement-action-error` — that one has a single subscriber and is silent
whenever the ARR panel is not open (HCP-05-08). The precondition is re-checked **at execution time**
(`src/ui/App.tsx:1829`), not only when the palette was built: the user may have changed the selection between
opening the palette and pressing Enter. Both stores (`ProjectStore` and `YDocStore`) expose the same
`notify` member, because the collab path types the store as a union of the two.

---

## 10. Verification

### 10.1 What passed

| check                                        | result                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `npx tsc --noEmit --incremental false`       | **my 6 files: 0 errors.** 6 errors remain, **all in parallel sessions' files** (§10.3) |
| `tests/ui/shortcuts.test.ts`                 | ✅                                                                                     |
| `tests/ui/FxAddPopover.test.tsx`             | ✅ (12 tests)                                                                          |
| `tests/ui/ModMatrixRow.test.tsx`             | ✅ (4 tests)                                                                           |
| `tests/ui/Mixer.test.tsx`                    | ✅ (14 tests)                                                                          |
| `tests/ui/HelpOverlay.test.tsx`              | ✅                                                                                     |
| `tests/ui/PresetBrowser.test.tsx`            | ✅ (4 tests)                                                                           |
| `tests/mcp-onboarding.test.ts`               | ✅ (13 tests)                                                                          |
| `tests/mcp-error-codes.test.ts`              | ✅ (12 tests) — the typed error contract still holds                                   |
| `tests/mcp-refusal-taxonomy.test.ts`         | ✅ (8 tests) — the ADR 0070 source gate still holds                                    |
| `tests/intent-command-route-kinds.test.ts`   | ✅ (3 tests, new)                                                                      |
| **total**                                    | **10 suites · 96 tests green**                                                         |
| `npx prettier --write` on every touched path | ✅ clean                                                                               |

#### 10.1.1 The P-1 / P-4 wave — re-verified against the current `main`

The wave landed on a tree that two other sessions kept changing, so the suites were **re-run after the
peer's undo-frame commit (`83ed86d5`) was in HEAD** — the number below is measured against the tree as it
stands, not against the tree the work was written on.

| check                                                                            | result                                                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `tests/ui/palette-command-registry.test.tsx`                                     | ✅ **13 tests** — the registry contract + the rendering gate                                      |
| `tests/ui/palette-search-coverage.test.ts`                                       | ✅ **5 tests** — the action-count cap and the zero-hit ceiling                                    |
| `tests/ui/command-palette.test.tsx`                                              | ✅ **20 tests**                                                                                   |
| `tests/ui/shortcuts.test.ts`                                                     | ✅                                                                                                |
| `tests/ui/ModMatrixRow.test.tsx`                                                 | ✅                                                                                                |
| `tests/ui/HelpOverlay.test.tsx`                                                  | ✅                                                                                                |
| `tests/ui/DockChrome.test.tsx`                                                   | ✅                                                                                                |
| `tests/ui/App.test.tsx`                                                          | ✅                                                                                                |
| `tests/a11y/icon-only-buttons.test.tsx`                                          | ✅                                                                                                |
| `tests/collab-contract-parity.test.ts`                                           | ✅                                                                                                |
| `tests/ui/strip-silence-naming.test.ts`                                          | ✅ **4 tests** — the P-4a naming gate (falsified twice, §9.2.1)                                   |
| **total**                                                                        | **11 suites · 105 tests green**                                                                   |
| `npx tsc --noEmit --incremental false`                                           | **my 9 files: 0 errors.** 4 files with errors remain, **all in parallel sessions' files** (§10.3) |
| `npx playwright test tests/e2e/05-keyboard-shortcuts.spec.ts --project=chromium` | ✅ **1 passed (21.5 s)** — see §10.6                                                              |

### 10.2 What was verified _by measurement_ rather than by reading

- the palette's 55 entries and their content — **observed live**
- the Help overlay's groups, its 21 editor rows, its one-entry CAPTURE section — **observed live**
- the route kinds of 20 phrases — probed through `routeIntentText`
- the MCP envelope of 20 phrases — probed end-to-end through `executeMcpTool`
- the effect preset count per type (57 types) — measured against the real preset table
- the instrument preset count per kind (31 kinds) — measured against the **warmed loader bank**
- the number of disabled controls and how many explain themselves — scanned
- the number of route kinds with no MCP builder (5) — enumerated + probed
- **the palette's 75 actions and the 48-query capability sweep — computed against the real
  `buildPaletteActions` + the real `fuzzyScore`/`filterActions`, and pinned by
  `tests/ui/palette-search-coverage.test.ts` so a regression fails CI**
- **the 20 registry specs' preconditions, their built commands, and that each command executes without
  throwing — verified in `tests/ui/palette-command-registry.test.tsx`**
- **that a row which cannot run renders `aria-disabled="true"`, shows its reason, and refuses to run on both
  click and Enter — verified by rendering the real overlay**

### 10.3 Typecheck failures that are NOT mine

Two runs, both against `npx tsc --noEmit --incremental false`.

**Run 1 — the quick wins (2026-10-27):**

```
src/project-model/schema.ts(1870,17)      TS2345   (parallel session, in flight)
tests/analysis/contract-timeline.test.ts   TS6133, TS2322  (parallel session)
tests/clip-verb-coverage.test.ts(27,24)    TS6133   (parallel session)
tests/param-range-coherence.test.ts        TS4104 ×2, TS6133  (parallel session)
```

**Run 2 — the P-1 / P-4 wave (2026-10-28), re-run after the peer's undo-frame commit:**

```
src/intent/param-intent.ts                     (parallel session)
src/mcp/render-summary.ts                       (parallel session)
tests/mcp-param-automation-disclosure.test.ts    (parallel session, new)
tests/mcp-render-summary-range.test.ts           (parallel session, new)
tests/mcp-stem-separate.test.ts                 (parallel session)
tests/param-range-coherence.test.ts             (parallel session)
tests/ui/ProjectBrowser.test.tsx                (parallel session)
```

**Run 3 — the P-4a naming gate (2026-10-28, later the same day):**

```
src/analysis/musical-context.ts                 (parallel session)
tests/mcp-param-automation-disclosure.test.ts    (parallel session)
tests/mcp-tools.test.ts                         (parallel session)
tests/ui/MixPreviewChip.test.tsx                (parallel session)
```

The list is a **moving target** — it shrank from seven files to four between run 2 and run 3 as other
sessions landed their own fixes. That is the honest shape of a shared worktree: the number belongs to a
moment, not to this document.

**Every one of them is in a file owned by another active session.** None is in a file this audit touched.
The audit's own files — `src/intent/command-for-route.ts`, `src/mcp/onboarding.ts`, `src/mcp/tools.ts`,
`src/ui/FxAddPopover.tsx`, `src/ui/ModMatrixRow.tsx`, `src/ui/shortcuts.ts`, `src/ui/Mixer.tsx`,
`src/ui/ArrangementPanel.tsx`, `src/commands/palette-registry.ts`, `src/ui/commandPalette.ts`,
`src/ui/PaletteOverlay.tsx`, `src/ui/App.tsx`, `src/store/ProjectStore.ts`, `src/collab/YDocStore.ts`,
`src/styles/14-command-palette.css` and the ten test files — typecheck clean.

**Read this the honest way:** a green typecheck on _my_ files in a tree where _other_ files do not compile is
a weaker statement than a green tree. It is stated here rather than hidden, because the alternative — a
"typecheck passes" claim for the repository — would be false.

### 10.4 The commit split — recorded honestly

While this work was in progress, a parallel session ran a `git add .`-style commit and absorbed the
`src/ui/Mixer.tsx` hunk of **QW-7** into its own commit:

```
11d3e6b0  fix(ui): CF-02 — mixer M/S announce the track and their pressed state
          src/ui/Mixer.tsx
          tests/ui/mixer-mute-solo-gesture.test.tsx
```

The **content survived intact** (verified: `formatSendLevel` and the POST-FADER hint are present in HEAD), and
the **regression test for it lands in this audit's commit `03d845d0`** (`tests/ui/Mixer.test.tsx`). The
authorship of the Mixer.tsx hunk is the other session's; the audit trail for it is this commit. The other
six patches are entirely mine in `03d845d0`.

### 10.5 Coverage gaps — what was NOT run

| gap                              | why                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the full vitest suite            | the tree was in continuous flux from parallel sessions; a whole-suite run would report other sessions' in-flight failures and cannot be attributed. The 10 suites that cover every touched file were run instead.                                                                                                                         |
| the full Playwright suite        | same reason; the one e2e spec that covers a touched surface (keyboard shortcuts) was targeted.                                                                                                                                                                                                                                            |
| `npm run build` + bundle budgets | no bundle-relevant file was touched; the budgets measure the shipped closure, not a badge and a string.                                                                                                                                                                                                                                   |
| **any audio-level verification** | **no microphone and no audio device** — recording, monitoring, take audio and loudness were not exercised at all (§2.3).                                                                                                                                                                                                                  |
| `docs/CURRENT-STATE.md`          | **deliberately not updated.** It tracks "how many / what ships today"; none of those numbers changed. Its spec-file count is a whole-tree `git ls-files` measurement that was already 12 stale from parallel sessions before this audit started — updating it from one session would attribute other sessions' spec files to this commit. |
| the MCP server process           | the MCP surface was exercised through `executeMcpTool` (the real dispatcher), not through a live MCP client over stdio.                                                                                                                                                                                                                   |

### 10.6 The e2e run — what happened, and why it matters that it was re-run

The keyboard-shortcuts e2e failed **twice** before it passed. The failures are worth recording, because the
first one looks like a regression and is not.

| attempt                                                | result                                       | cause                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — default port 5199                                  | ❌ `page.goto` timeout at `domcontentloaded` | port **5199** was occupied by another session's dev server; Playwright's `reuseExistingServer` adopted it and connected to a tree that was mid-HMR-reload |
| 2 — `PULSE_FORGE_E2E_PORT=5273`                        | ❌ the same timeout                          | my own dev server on 5273 had just been killed by its 3600 s task limit; the page had nothing to load                                                     |
| 3 — `PULSE_FORGE_E2E_PORT=5273`, fresh detached server | ❌ the same timeout                          | vite's **cold** module transform under continuous peer churn: the browser's module fetch stalled, so `domcontentloaded` never fired inside 60 s           |
| 4 — same server, **warm** module graph                 | ✅ **1 passed (21.5 s)**                     | —                                                                                                                                                         |

Between attempts 3 and 4 the app was verified to boot normally in the browser (the project browser rendered
"CONTINUE LAST PROJECT · House Beat · 124 BPM · 3 tracks"), which established that the tree — **with this
audit's changes in it** — was healthy and the failure was the harness, not the product.

**The lesson the audit keeps:** a failure that cannot be reproduced after the environment is fixed is not a
finding. Attempts 1–3 produced a red that said nothing about the code; attempt 4 produced a green that does.
The same discipline produced the one **refuted** finding in this audit (§5.0, HCP-03-06) — a worker's
regex over `src/presets/factory.ts` said "nine instruments ship with an empty preset browser"; measuring the
**warmed loader bank** showed all 31 kinds have presets (TSAR 48, KOPA 16, CHORÁL 4 …) and the finding was
withdrawn, the patch reverted and the test removed.

### 10.7 The P-1 browser check that did NOT happen — stated, not papered over

**The P-1 wave was verified in the DOM, not in a running browser.** The attempt was made and it failed for
environmental reasons:

- the shared worktree's dev server was in **HMR staleness** — the browser failed with
  `Failed to fetch dynamically imported module /src/services.ts`;
- a **stale tab held the IndexedDB lock**, so the project browser could not open its database and the boot
  never completed;
- the console showed **no application errors** — the failure was the harness, not the product.

**Why that is stated rather than retried until it went green:** the evidence collected is **stronger** than
a screenshot would have been. `tests/ui/palette-command-registry.test.tsx` renders the **real** `PaletteOverlay`
and asserts on the DOM the user would see — `aria-disabled="true"` on a row that cannot run, the reason text
present in the rendered output, a click and an Enter that both do nothing, and the same row becoming
runnable once its precondition is met. A screenshot proves a pixel; this proves the behaviour.

**What remains genuinely unverified by a browser:** the **visual** reading of the disabled row — that the
greyed-out treatment and the reason line are legible at real font sizes and in the real theme, and that the
`.palette-unavailable` rule does not overflow the row. That is a **design check, not a correctness check**,
and it is named here so the next person with a free browser knows to look at it.

### 10.8 The P-1 commit attribution — recorded honestly

The P-1 wave's **content** was verified, measured and pinned by specs. Its **authorship** in the history is
a parallel session's:

```
aa5b6e83  ranny commit
          src/commands/palette-registry.ts          (new)
          src/ui/commandPalette.ts
          src/ui/PaletteOverlay.tsx
          src/ui/App.tsx
          src/store/ProjectStore.ts
          src/collab/YDocStore.ts
          src/styles/14-command-palette.css
          tests/ui/palette-search-coverage.test.ts
          tests/ui/palette-command-registry.test.ts  (new)
          tests/ui/palette-command-registry.test.tsx (new)
          — plus that session's own MCP / undo-frame work
```

A peer's `git add .` swept the whole wave into its commit before this session could stage it. The content
survived intact and was re-verified against the tree afterwards (§10.1.1). Two consequences are recorded
rather than hidden:

1. the P-1 code is in `main` under a commit message that does not describe it — **the audit trail for it is
   this report and the specs**, not the commit subject;
2. that commit contains **both** `palette-command-registry.test.ts` and `palette-command-registry.test.tsx` —
   a **duplicate spec**, the exact anti-pattern the repo's own vitest config warns about. This session's
   commit removes the `.ts` file, which the `.tsx` file supersedes (it contains every one of the `.ts`
   tests plus the five rendering tests).

---

## 11. Strategic proposals requiring explicit approval

None of these is implemented. Each needs a product decision, not a patch.

**P-1 · A command-registry-derived index (the root fix).** — **PHASE 1 SHIPPED (§9.2.2).**
The curated registry landed: 20 commands, three rules, 55 → 75 palette actions, 24 → 9 zero-hit queries, and
twelve capabilities findable by name. **Still open:** the registry is a **curated whitelist**, not a derived
index. Making the command registry the single source of _what the product can do_ — so the palette, the MCP
tool surface and the intent router all read the same table — remains the structural fix for HCP-05-01,
HCP-04-01 and HCP-04-03. **Needs:** a decision on what "visible in the palette" means per command (an
explicit flag, not a heuristic), and the action-count ceiling (currently pinned at 100 by the coverage spec).
**Rejected alternative:** adding palette entries by hand — it reproduces the same list-of-lists problem one
entry at a time.

**P-2 · The recording surface gets one address.**
Capture, arm, punch, comp, freeze and take review are six verbs spread over three dock tabs, a context menu
and a footer chip. The proposal is **one address**, not one panel: the session-state chip already exists and
already aggregates the state — it is the natural home for the verbs. **Needs:** a decision on whether the
ARR REC strip stays where it is. **Note:** this is now the single largest hole the palette still has — the
recording family is the one family the curated registry could not reach, because `armedTrackId` and the
recorder state are local React state rather than project state (§9.2.2).

**P-3 · One first-run, one key.**
Five onboarding mechanisms with five storage keys; the tour and the hint bar teach the same material
simultaneously on a fresh profile. **Needs:** agreement on which of the two survives.

**P-4 · Naming decisions that need the author, not the audit.** — **SHIPPED (`6a7d265c`, §9.2.1).**
The author answered; all four decisions landed. "Strip Silence (PT)" → "Strip Silence" plus a tooltip that
pitch and tempo are preserved; "Consolidate" → "Consolidate to one clip"; "MOD MATRIX" now carries a visible
caption that separates it from the MOD panel; the four panel labels all say "Toggle X panel".

**P-5 · Post-fader sends become a choice.**
The disclosure shipped (QW-7). Making the rule configurable is a **model change** — `sends: Record<ID, number>`
has no place to express pre/post — and therefore a schema change with a migration.

**P-6 · A/B at chain level.**
`EffectInstance.deviceState` is per-device by construction. A chain-level snapshot needs a new storage slot
and a new undo boundary.

**P-7 · Delete the legacy inline EffectRack branch.**
Every production call site passes `mode="devices"`; the legacy branch survives only because ~20 specs render
the default. Deleting it is a real simplification — but it is a deletion, and the brief forbids removing
features without approval.

---

## 12. The 30 / 60 / 90-day plan

### 30 days — make what exists nameable (no new capability)

Backlog numbers refer to §8; the shipped `QW-n` ids refer to §9.

1. **Backlog #4 (HCP-02-12): the REC button states its pre-condition.** One line; the correct pattern
   already exists in the same file.
2. **Backlog #15 (HCP-05-08): `pf-arrangement-action-error` reaches a global toast.** Today a palette-driven
   failure is silent unless the ARR panel happens to be open — the single most confusing failure mode in the
   product.
3. **Backlog #12 (HCP-05-11): four dock-tab shortcuts + correct the false source comment.**
4. **Backlog #13 (HCP-03-05): "Add automation lane" in the knob and fader context menus.** The command exists;
   the menu entry does not.
5. **Backlog #14 (HCP-01-03): Split in the MIDI and automation lane menus.**
6. **Backlog #20 (HCP-05-09): one onboarding completion key.**
7. **Backlog #18 (HCP-03-08): the "♪ tuned for …" badge promises a landing that no flagship has** — either
   extend the role landings to the six suites or stop showing the promise.
8. **Measure:** instrument the palette's own empty state (how many queries return zero) — the only honest
   way to size P-1. **— DONE.** The 48-query capability sweep is pinned by
   `tests/ui/palette-search-coverage.test.ts`, which holds the zero-hit count at **9** and the action count at
   **75** (ceiling 100).

### 60 days — build the index

1. **P-1, phase 1:** a command→palette adapter with an explicit `label` and a `paletteVisible` flag, applied
   to the **30 blind modules** first (automation, quantize, scenes, plugins, effect params, clip playback,
   instruments, chord tracks, live sets, markers, master, freeze, smart comp, stem tracks).
   **— PARTLY DONE (§9.2.2).** The curated registry covers **20 commands** across those modules; the
   `paletteVisible` flag is still missing, and the registry is still hand-curated rather than derived.
2. **P-1, phase 2:** give the palette **capture actions** (HCP-02-01), dispatched through the same handlers
   and the same preconditions as the REC button — with the disabled-with-reason state. **— NOT DONE, and
   blocked on P-2**: the recorder's state has to leave local React state before a registry entry can exist
   for it.
3. **Give the five unwired intent kinds real MCP builders** (HCP-04-01, the wiring half) — reusing the
   commands the in-app panel already calls.
4. **Expose the Assist engine** over MCP and the intent router (HCP-04-03).
5. **Backlog #13 lands in the palette too**, so the MOD dropdown stops being the only door to automation.

### 90 days — depth and honesty

1. **A/B at chain level** (P-6) — the "compare two sounds" workflow stops answering differently per device.
2. **The master MATCH EQ becomes visible and manual** (HCP-03-10): render the band gains, then expose them.
3. **Seeded flagship presets** (HCP-03-07) — as an **EXPERIMENT** with an explicit "does a starting point
   change whether a user adopts the suite?" question, not as a content push.
4. **The disabled-state lint** reaches a durable gate: a disabled button without a `title` fails CI, seeded
   by an exception list built from the 222 sites.
5. **Revisit the Visibility Matrix.** The whole point of a ledger is that it can be re-measured: this
   document's numbers (7.4 %, 40.3 %, 5 unwired kinds, **75** palette actions) should be pinned by specs so the
   next audit measures movement rather than re-deriving the baseline. **— partly done:** the palette side is
   pinned (`tests/ui/palette-search-coverage.test.ts` + `tests/ui/palette-command-registry.test.tsx`); the
   40.3 % disabled-control figure and the 5 unwired intent kinds are still un-pinned.

---

## 13. Open questions

1. **What does "PT" mean in "Strip Silence (PT)"?** — **answered by the author on 2026-10-28: pitch and tempo
   are preserved.** The suffix had no legend anywhere in `src/`, so it is gone; the tooltip now says so in words.
   The acronym's origin stays unrecorded — nothing depends on it any more.
2. **Which window listener wins a shared chord?** The piano roll and the app both register `window`
   `keydown` listeners; neither calls `stopImmediatePropagation`. `Alt+S` is both "Solo selected track"
   (global) and "Slide (portamento)" (piano roll). **Not verified.**
3. **Does `extra:diagnostics` render anything?** The overlay's implementation was not located in `src/ui/`.
   **Not verified** — and if it toggles nothing, it is a dead palette entry.
4. **Is the flagship tier meant to be user-visible?** It is used for menu order, for a test exclusion and for
   the vendored-core test matrix — never for presentation. QW-3 assumes yes; if it was always internal, the
   marker should come off.
5. **How many of the 222 unexplained disabled controls sit on the primary path to a first take?** The ±12-line
   heuristic is textual, not DOM-accurate.
6. **Should MCP be counted as a user-facing entry path?** `src/mcp/tools.ts` exposes ~40 of the same
   factories — a fourth path this audit deliberately excluded from the §1 ratios.
7. **Is the DAW profile auto-assigned on a fresh install?** `dawProfile.ts:41` carries a default, but
   `commandPalette.ts:44` gates the profile hint on a profile being set. **Not verified.**

---

## 14. Reproduction

```bash
# the quick wins
git show 03d845d0
npx vitest run tests/intent-command-route-kinds.test.ts tests/ui/shortcuts.test.ts \
  tests/ui/FxAddPopover.test.tsx tests/ui/ModMatrixRow.test.tsx tests/ui/Mixer.test.tsx \
  tests/mcp-onboarding.test.ts tests/mcp-error-codes.test.ts tests/mcp-refusal-taxonomy.test.ts
npx tsc --noEmit --incremental false

# the P-1 / P-4 wave
git show 6a7d265c              # the naming decisions
git show aa5b6e83 -- src/commands/palette-registry.ts src/ui/commandPalette.ts \
  src/ui/PaletteOverlay.tsx src/ui/App.tsx src/store/ProjectStore.ts src/collab/YDocStore.ts \
  src/styles/14-command-palette.css tests/ui/palette-search-coverage.test.ts \
  tests/ui/palette-command-registry.test.tsx   # the curated registry (§10.8: peer-authored commit)
npx vitest run tests/ui/palette-command-registry.test.tsx tests/ui/palette-search-coverage.test.ts \
  tests/ui/command-palette.test.tsx tests/ui/shortcuts.test.ts tests/ui/ModMatrixRow.test.tsx \
  tests/ui/HelpOverlay.test.tsx tests/ui/DockChrome.test.tsx tests/ui/App.test.tsx \
  tests/a11y/icon-only-buttons.test.tsx tests/collab-contract-parity.test.ts \
  tests/ui/strip-silence-naming.test.ts

# the domain evidence
docs/audits/2026-10-27-hidden-creative-power/
  01-clip-arrangement.md  02-recording-persistence.md  03-sound-design-mixing.md
  04-ai-intent-mcp.md     05-productivity-discoverability.md
```

_Prepared 2026-10-27 against `main`, updated 2026-10-28 after the P-1 / P-4 wave. Every claim is labelled
Observed / Verified / Inferred / Hypothesized / Not verified, and every measurement in §10.2 was reproduced from
the repository at the cited commit._
