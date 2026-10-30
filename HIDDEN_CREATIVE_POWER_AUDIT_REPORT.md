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
**— IN PLACE (2026-10-30):** the sentence about **zero** capture actions was true when it was measured and is now
**one** action, not zero. P-2 was decided (the ARR REC strip stays in ARR; the recording state moves into the
project) and phase 1 landed (`70f3b175`, schema v41): the palette holds **80** actions and the first capture
action in the product's index is `recording.arm`, with its pre-condition stated rather than silently missing.
**The rest of the family is still invisible** — Take, Comp, Freeze, Monitor, Punch and recovery — so the finding's
shape survives; what changed is that the arm now has an address and the remainder of the family is what §11's P-1
phase 2 still has to expose.

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
the largest remaining hole. **— IN PLACE (2026-10-30): the second half of that sentence is now history.** The
owner decided P-2 (the ARR REC strip stays in ARR; the recording state moves into the project) and **phase 1
landed in `70f3b175`, schema v41**: the arm target is now a project fact with a palette route
(`recording.arm`), so the recording family **is** in the palette — the palette grew **79 → 80** actions and
**42 of 48** representative queries still hit. What is still outside the palette is the capture **session**'s
own state (second channel, extra input routes, take mode, punch/loop), which by design stays local because it
describes a running capture rather than a song (§10.16.10).

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
- **The dev server was hostile to observation — so the observation was moved.** Parallel sessions rewrote 15+
  source files during the audit; Vite HMR full-reloads invalidated browser references mid-session, and one
  session produced a `Failed to fetch dynamically imported module` crash screen. That is a **dev-server artefact
  of a shared worktree**, not a product defect, and it is excluded from the findings. The one browser
  observation this audit needed was then re-made on a **detached worktree at a named commit with its own dev
  server on its own port** (§10.7), which is what finally made it possible; the same method later produced the
  audit's sharpest drift finding (§10.11).
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
- **The intake handoff surface was never examined — a gap in this audit, not a finding about the product.**
  The `IntakeTray` — the surface that lets a user send audio from **any web page** into KYX — is a real
  creative affordance, and this audit does not mention it anywhere. The facts that are known, none of them
  from this audit: the surface exists (`src/ui/IntakeTray.tsx`, mounted from `src/ui/SampleBrowser.tsx:827`),
  it polls the optional collab relay every **8 s** while the drop zone is shown, and the drop zone is **off
  by default** (`showDropZone = false`). A parallel session measured its side effect while fixing an
  unrelated e2e gate: with no relay running, the browser logs `ERR_CONNECTION_REFUSED` for
  `http://127.0.0.1:1234/api/intake` **itself** — JavaScript cannot silence a failed fetch — and on a slow
  runner that refusal landed before the e2e console-error assertion, while a fast dev box had already
  finished the test (`357e273c`). **Not verified here:** whether the affordance is discoverable at all, what
  the tray shows a user who has never run the relay, and what it does on a deployed build, where
  `galleryBaseUrl()` returns `""` and the request becomes same-origin.
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

## 5. Top 16 Hidden Creative Power Findings

Every finding below is evidence-backed. The nine highest-value ones use the full template; the remaining seven
are condensed but still carry their evidence.

**HCP-03-16 was found after this ranking was closed** — by the CI triage in §10.12, not by the audit workers — so
it carries no rank in §8 and is appended rather than inserted. On a fresh scoring it belongs in the upper half of
that table: high confidence, high severity, and content-sized effort.

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

**Class:** B · **Priority:** 2 · **Confidence:** **Observed live** + Verified in code · **Status:** **PARTIALLY SHIPPED (2026-10-30) — the curated registry could not reach the capture family; it is blocked on P-2 (§9.2.2)**. **IN PLACE:** P-2 was decided and its phase 1 landed (`70f3b175`, schema v41): the palette now holds **80** actions and **one of them is a capture action** — `recording.arm`, group "Record", with the precondition spelled out ("Select a track to arm for recording") and a command that reaches the document. **What remains open is the rest of the family** — Take, Comp, Freeze, Monitor, Punch and the recovery affordance are still unreachable from the palette, and the capture **session**'s own state (second channel, extra input routes, take mode, punch/loop) is by design still local to the UI, because it describes a running capture rather than a song (§10.16.10).

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

### HCP-03-16 — The preset-audition gate certifies silence

**Class:** E · **Priority:** unranked (appended after the ranking closed — see §8) · **Confidence:** **Measured**
· **Status:** proposed

**Existing capability and evidence:** the product ships **671 factory presets** and an audition gate that renders
each one and reports `presets: auditions finite/unclipped + loudness map in sync`. The generated loudness map
(`src/presets/preset-loudness.generated.ts`, 671 entries, produced by `scripts/measure-preset-loudness.mjs`
through a BS.1770-4 analyser) records **62 of the 671 presets below −45 LUFS**, while the map's own family
targets are −21.7 LUFS (texture), −24.7 (pad), −24.9 (keys), −27.1 (pluck) and −29.6 (vocal). The quiet tail is
not one instrument: below −45 LUFS the map holds **keys 24, pluck 14, granular 13, drumsynth 6, sampler 2, vsco
2, vocalchop 1**, and the quietest preset in the whole library is `factory.granular.ambient.dust` at
**−70.0 LUFS**. The product then applies the map's own gain to close the gap — and the gain map is **clamped at
±18 dB** (`src/presets/normalization.ts`), so for the granular family the applied gain is **+18 dB on 15 of the
16 presets** and the result is still **−52.0 … −20.5 LUFS**: **7 of the 16 stay below −40 LUFS and 10 of the 16
stay below −30 LUFS** after the product has done everything the map tells it to do.

**Why the gate says PASS anyway — the root cause, in two conditions.** `src/browser-checks.ts:258` compares the
render against the map, and only if the preset **is in the map**; `:260` then exempts anything measuring
**below −70 LUFS**. So the criterion is _fidelity to the map_, and the map's expected value for these presets
**is** near-silence. "Finite and unclipped" is satisfied by silence: a parallel session measured four granular
presets at **peak = 0.0001**, and the gate reported them as passed. The gate is not broken — it measures the
wrong thing, and it measures it faithfully.

**A second, independent defect in the same gate.** `src/presets/loudnessPath.ts:26` lists **only `kopa`** as a
worklet-path instrument, so the audition never loads the granular worklet; `src/instruments/registry.ts:2832`
therefore takes the JS fallback (`isWorkletReady("grainVoice")` is false in that context) and the map records
the **fallback's** level. This is the exact failure the KOPA comment at `src/browser-checks.ts:202-206`
describes — "the gate was comparing two different syntheses … describing a sound the product never exports" —
fixed for KOPA, never applied to granular.

**Barrier and root cause:** _the check certifies a measurement instead of a threshold_. The audibility gate
answers "does this preset still sound like the map says?", and the map says "quiet". Nothing in the pipeline
asks "is this preset audible at all?".

**Recommended minimal intervention:** two halves, in this order. (1) **Give the gate an audibility floor** — a
preset whose rendered integrated loudness falls below, say, −45 LUFS should FAIL as "inaudible", not PASS as
"in sync". (2) **Re-balance and re-record** the 62 presets the floor catches: raise the source levels, then
re-run `npm run presets:loudness`. Half (1) alone turns the gate red until (2) lands — which is the point, but
it is a decision about levels, not a patch.

**Risk / why it is not a quick win:** (2) is **content and taste**, in the same class as HCP-03-07. The
measurement itself may also need re-recording per environment: a parallel session found six sampler
loudness-map entries drifting 3–10 LU against the map, consistent with the map having been recorded on a
machine that had the sample packs. Proposed, not shipped.

**Not verified:** that the 62 presets are inaudible to a human ear — the map's numbers are the evidence and the
audibility judgement is an inference from them; and the exact DSP reason the granular fallback is near-silent.

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

| stage                   | what the user must do today                                   | friction                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| intention               | "I want to record a vocal"                                    | —                                                                                                                                                                                      |
| recognition             | the ARR dock tab contains a REC strip                         | the REC control is in the **ARR** tab; the _recording_ affordances are in a different dock tab (**LIVE/TAKE LANES**) and in the footer chip                                            |
| entry point             | ARR tab → REC button                                          | two tabs and a context menu compete for the same job                                                                                                                                   |
| prerequisites           | a track armed, an audio input selected, a mic permission      | **not stated on the disabled button** (HCP-02-12); the preconditions are knowable only from the code                                                                                   |
| action                  | click REC                                                     | —                                                                                                                                                                                      |
| feedback                | armed chip, take lanes, REC counter                           | present and good — the session-state chip is a strength                                                                                                                                |
| audible/visible outcome | the take appears in TAKE LANES                                | —                                                                                                                                                                                      |
| undo/recovery           | a durable checkpoint + a recovery offer after an unclean exit | **the recovery affordance is ~380 JSX lines in another tab** (HCP-02-11)                                                                                                               |
| **index**               | **the palette has no capture action at all**                  | **HCP-02-01** — **IN PLACE (2026-10-30):** the palette now holds **80** actions and the arm has one (`recording.arm`, `70f3b175`); the rest of the capture family is still unreachable |

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
| 26  | HCP-03-16 the audition gate certifies silence            | 4   | 3   | 4   | 5   | 4   | 2   | **WORKFLOW FIX**                                          | 62 of 671 presets measure below −45 LUFS and the gate passes them for "in sync"              |

### 8.1 Classification totals

| class           | count                                                          |
| --------------- | -------------------------------------------------------------- |
| QUICK WIN       | 10 (7 shipped, 3 not started — all gated out by scope or risk) |
| WORKFLOW FIX    | 16                                                             |
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

**— IN PLACE (2026-10-30): the "after" column has moved on twice since it was measured.** The palette holds **80**
actions (75 → 77 with CF-12's two clip routes → 79 with CF-15's two tool routes → **80** with P-2's recording arm), and the
zero-hit count is **6 of 48**, not 9 — the spec pins a **ceiling** of 9 (`tests/ui/palette-search-coverage.test.ts:139`), so
the extra recoveries below it do not break the gate. Measured live from that spec's own output: `80 actions · 42/48 queries
hit · 6 zero-hit: bounce, automation, consolidate, waveform, sample, reference`. **A ceiling and a measurement are different
numbers**, and quoting the ceiling as if it were the measurement is the same hand-maintained-copy failure this section is
about.

The twelve are pinned by spec to the exact action that owns each one — freeze, quantize, macro, marker,
crossfade, chord, groove, velocity, effect, plugin, humanize, swing — because a **count would have flattered
the result**: "record", "tempo" and "stem" also stopped being zero, but only by coincidence of the
subsequence matcher ("record" lands on "Conform the selected clips to the chord track"). **The recording
family is still unreachable from the palette**, and that is not a registry entry: `armedTrackId` and the
recorder state are local React state inside the arrangement panel (`src/ui/ArrangementPanel.tsx:755`), so
exposing them is the **P-2** proposal — one address for the recording surface.
**— IN PLACE (2026-10-30):** the last sentence described the state before P-2 was decided. The owner decided
P-2 (the ARR REC strip stays in ARR; the recording state moves into the project) and phase 1 landed
(`70f3b175`, schema v41): `armedTrackId` is **no longer local React state** — it is `recording.armedTrackId`
in the document, reached by the command `setRecordingArm` and by the palette action `recording.arm`. The
**recorder state** (the capture session's own state) is still local, deliberately: it describes a running
capture, not a song. The palette is now **80** actions with **42 of 48** queries hitting (§10.16.10).

The nine that still match nothing — **bounce, automation, midi clip, silence, consolidate, warp, waveform,
sample, reference** — are commands that need a dialog, a value, or a rendered buffer.
**— IN PLACE (2026-10-30):** six, not nine — **bounce, automation, consolidate, waveform, sample, reference**.
CF-12's two clip routes and CF-15's two tool routes recovered **midi clip**, **silence**, **warp** and **stem** since this
list was written; the six that remain are commands that need a dialog, a value, or a rendered buffer.

**Where the failures go.** A palette command that fails surfaces through `store.notify` → the existing global
`CommandToast`, not through `pf-arrangement-action-error` — that one has a single subscriber and is silent
whenever the ARR panel is not open (HCP-05-08). The precondition is re-checked **at execution time**
(`src/ui/App.tsx:1829`), not only when the palette was built: the user may have changed the selection between
opening the palette and pressing Enter. Both stores (`ProjectStore` and `YDocStore`) expose the same
`notify` member, because the collab path types the store as a union of the two.

**What this cost later — the ratchet that was itself broken by the wave that shipped it.** The count above (75) was
pinned by `tests/ui/palette-search-coverage.test.ts` precisely so that the palette could not grow quietly. A later wave
(CF-12, `f9dbb25a`) added two palette routes — `extra:timepitch` and `extra:spectral` — and moved the count to **77**
**without moving the pin**, so the committed tree's unit-test job has been red ever since: _"expected 77 to be 75"_. The
gate whose whole job is to catch a silent palette growth was itself broken by the growth, and the only thing that noticed
was someone else's CI. Re-pinned to **77** in `66d48a41` — the committed tree's measured count, not a guess — and then to **79** in
`a1328a50` when CF-15 landed its two tool routes. **The number in this section was the number that went stale, and the audit
that wrote it did not notice.**

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

**The table was then re-measured a third time**, on a **clean detached worktree at `cc81ffe3`**, for the same
reason §10.11 gives: a shared worktree cannot tell you what a commit contains, only what a directory contains.
Every row below is from that clean tree. The test count moved from **121** to **124** because the owner
session's CF-05 Tab-traversal fix added three assertions — the count is a measurement, and it is reported as
measured.

| check                                                                            | result                                                                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `tests/ui/palette-command-registry.test.tsx`                                     | ✅ **13 tests** — the registry contract + the rendering gate                                                                       |
| `tests/ui/palette-search-coverage.test.ts`                                       | ✅ **5 tests** — the action-count cap and the zero-hit ceiling                                                                     |
| `tests/ui/command-palette.test.tsx`                                              | ✅ **20 tests**                                                                                                                    |
| `tests/ui/shortcuts.test.ts`                                                     | ✅                                                                                                                                 |
| `tests/ui/ModMatrixRow.test.tsx`                                                 | ✅                                                                                                                                 |
| `tests/ui/HelpOverlay.test.tsx`                                                  | ✅                                                                                                                                 |
| `tests/ui/DockChrome.test.tsx`                                                   | ✅                                                                                                                                 |
| `tests/ui/App.test.tsx`                                                          | ✅                                                                                                                                 |
| `tests/a11y/icon-only-buttons.test.tsx`                                          | ✅                                                                                                                                 |
| `tests/collab-contract-parity.test.ts`                                           | ✅                                                                                                                                 |
| `tests/ui/strip-silence-naming.test.ts`                                          | ✅ **4 tests** — the P-4a naming gate (falsified twice, §9.2.1)                                                                    |
| `tests/drift-check.test.ts`                                                      | ✅ **12 tests** — the derivable-artifact gate                                                                                      |
| `tests/mcp-mirror-sync.test.ts`                                                  | ✅ **4 tests** — the MCP tool-surface mirror guard                                                                                 |
| **total**                                                                        | **13 suites · 124 tests green** — re-measured on `cc81ffe3` (§10.1.1)                                                              |
| `npx tsc --noEmit --incremental false`                                           | ✅ **exit 0** — the whole tree typechecks, on the tree as it now stands (§10.3)                                                    |
| `npm run drift:check`                                                            | ✅ **green** — `✓ no drift` (§10.9); red once in between, green again (§10.11); **red on `origin/main` twice more** (§10.11.2)     |
| the P-1 palette in a real browser                                                | ✅ **done on a clean tree** — the disabled row, its reason, its `aria-disabled` (§10.7)                                            |
| `node scripts/check-seam-coverage.mjs`                                           | ✅ **green** — 1 check, **106** seams (committed payload `docs/status.json`; §10.11 measured 95; the 106th is CF-18's, `362a82be`) |
| the committed payload's `spec-counts` claim                                      | ✅ **1345 claimed, 1345 measured** — `state: pass`, drift-checked (`docs/status.json`); re-pinned in `4c58e9d4` (§10.11.2)         |
| `npx playwright test tests/e2e/05-keyboard-shortcuts.spec.ts --project=chromium` | ✅ **1 passed (21.5 s)** — see §10.6                                                                                               |

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

### 10.3 Typecheck — what was failing, and what it is now

**The tree typechecks clean today (exit 0).** The runs below are kept because the middle of them is the
evidence for one decision (§10.5): that this audit's wave moves the spec-file count by **zero**.

Four runs, all against `npx tsc --noEmit --incremental false`.

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

**Run 4 — the drift wave (2026-10-28, later still):** `npx tsc --noEmit --incremental false` → **exit 0**.
The parallel sessions' files were repaired and landed in the meantime; the whole tree typechecks.

The list is a **moving target** — it shrank from seven files to four between run 2 and run 3 as other
sessions landed their own fixes, and to zero by run 4. That is the honest shape of a shared worktree: the
number belongs to a moment, not to this document.

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

| gap                              | why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the full vitest suite            | the tree was in continuous flux from parallel sessions; a whole-suite run would report other sessions' in-flight failures and cannot be attributed. The 10 suites that cover every touched file were run instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| the full Playwright suite        | same reason; the one e2e spec that covers a touched surface (keyboard shortcuts) was targeted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `npm run build` + bundle budgets | no bundle-relevant file was touched; the budgets measure the shipped closure, not a badge and a string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **any audio-level verification** | **no microphone and no audio device** — recording, monitoring, take audio and loudness were not exercised at all (§2.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `docs/CURRENT-STATE.md`          | **deliberately not updated — and the net effect on its numbers is zero.** The row is rewritten by whichever session lands the specs; the number it holds has moved on twice since this audit's wave (1319 → 1321), and each move belongs to another session's wave, not to this one. What is measured rather than assumed: this audit's wave **removed one spec** (the duplicate `tests/ui/palette-command-registry.test.ts`, §10.8) and **added one** (`tests/ui/strip-silence-naming.test.ts`), so it moves the count by **zero**. A session that had edited that row would have been editing a file another session had just rewritten — and, as CI #431 showed, would have had to re-pin the generated snapshot in `docs/status.json` as well (§10.10). |
| the MCP server process           | the MCP surface was exercised through `executeMcpTool` (the real dispatcher), not through a live MCP client over stdio.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

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

### 10.7 The P-1 browser check — done, on a clean tree

**The P-1 palette's disabled row has now been looked at in a running browser.** The first attempt failed for
environmental reasons: the shared worktree's dev server was in **HMR staleness** (the browser failed with
`Failed to fetch dynamically imported module /src/services.ts`) and a **stale tab held the IndexedDB lock**, so
the project browser could not open its database and the boot never completed. The console showed **no
application errors** — the failure was the harness, not the product.

The check was then redone the way §10.10 says to measure anything here: a **detached worktree at a named
commit**, **its own dev server on its own port**, and **its own browser tab** — so no shared state, no HMR, no
second session's tab.

The method, in full, because the method is the point:

1. `git worktree add --detach D:/pf-drift-a448 HEAD` — a clean tree at `a448853b`, with `node_modules`
   junctioned from the main tree (the worklet bundles are tracked, so the tree serves the app as it stands);
2. `npx.cmd vite --port 5274 --host 127.0.0.1` — a dev server owned by this check, not inherited;
3. landing page → "Open the studio" → the project browser → the **HOUSE 124 BPM** factory template → the DAW;
4. `Ctrl+K` → the palette → the query `clip`.

What the browser showed, for the row that cannot run:

```
Split the selected audio clip at the playhead
Select an audio clip first
```

and, in the DOM of that same row:

```html
<button
  type="button"
  role="option"
  aria-selected="false"
  aria-disabled="true"
  class="palette-item unavailable"
  title="Select an audio clip first"
>
  <span class="palette-copy">
    <span class="palette-title">Split the selected audio clip at the playhead</span>
    <span class="palette-unavailable">Select an audio clip first</span>
  </span>
  <span class="palette-group">CLIPS</span>
</button>
```

Three properties — the ones §9.2.2 promised:

- **`aria-disabled`, not `disabled`** — the row is announced as unavailable but stays focusable, so a keyboard
  user can reach it and read _why_;
- **the reason is visible, not hover-only** — `<span class="palette-unavailable">` renders "Select an audio clip
  first" under the title, and the same sentence is the `title` tooltip;
- **the row is visibly greyed** — the `unavailable` class, in the shipped theme, at the real font size, with the
  reason line fitting inside the row.

**What this closes, and what it does not.** It closes the _design_ question this section previously named: the
greyed treatment and the reason line are legible in the real theme and do not overflow the row. It does not
claim more than the DOM spec claims — the behavioural proof (a click and an Enter that both do nothing, and the
row becoming runnable once its precondition is met) still comes from `tests/ui/palette-command-registry.test.tsx`,
which is the stronger evidence for that property. The browser adds the one thing a DOM spec cannot: **what it
looks like**.

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

### 10.9 The drift gate — run to the end, and the trace it used to leave

**The gate was green on `main` when this section was measured:** `npm run drift:check` → `✓ no drift — derivable
artifacts match their generators`, across all four sections (mcp-mirrors, domain-goldens, status, counts).

**That measurement stopped holding a few commits later, and the correction belongs here rather than being left
for a reader to discover.** A parallel session landed a coverage claim without its source, the `[status]` section
went red on `main`, and the published status page was claiming a PASS that was false. The full measurement is in
**§10.11** — and so is its ending: the owner landed the source with the claim, and the gate is green again.

**A correction to my own earlier claim.** I first reported that the drift gate "exceeds 600 s on this
machine". That was **my harness budget, not a property of the gate** — a parallel session ran the same
command to completion and measured it. A timeout I impose is not a measurement of the tool; it is a
measurement of me. (Recorded in my agent memory, because the lesson already existed there and I still got
it wrong: **the number in a report belongs to the reporter**.)

**And running the gate to the end exposed a defect in it.** `npm run status:report` writes two files:
`docs/status.json` (the stable payload the gate compares with HEAD) and `docs/STATUS.md` (the same claims
as a page, whose header carries a generation timestamp). The gate owned only the first — correctly, since a
timestamp cannot be compared with anything — but the restore loop restores only **owned** paths, so the
volatile file was left **dirty after every single gate run**. In a shared worktree that is a hazard: the
next session's `git add .` sweeps it into an unrelated commit. It is not hypothetical — it produced this
session's commit `8f63a22e`, whose entire content is a clock reading.

**The first fix was right about the trace and wrong about the file.** It split the one list into
`ownedPaths` (compared with HEAD) and `volatilePaths` (never compared, but restored) — which stopped the
trace. But excluding the page from the comparison **entirely** was the wrong answer, and §10.10 is how the
hole showed: the page carries the **live claim rows** as well as the timestamp, and a row that sat at
**1319** while the tree said **1323** is a stale number on a published page that **no gate could see**.

The final mechanism ignores **exactly one thing** and compares the rest:

- **`ownedPaths`** — compared with HEAD, and the source of a drift finding;
- **`ignoreCompareLines`** — the volatile lines stripped from BOTH sides before the comparison. The
  timestamp never decides the verdict; the live rows always do.

So `docs/STATUS.md` is now **owned** and compared **minus its timestamp line**: a stale row is a drift
finding, and a new timestamp is not. And because owned paths are restored after a clean run, the gate still
leaves **no trace** — verified end to end: after a full gate run the worktree holds **only** the files I was
deliberately editing. Four pins in `tests/drift-check.test.ts` hold the distinction, because the one change
that would put the gate back in the red is either owning a file with a timestamp and no ignore rule (the
gate flaps forever) or ignoring a file's live rows (the gate goes blind).

### 10.10 The drift that reached CI — and the fast half of the slow gate

The failure mode §10.9 describes was not theoretical. It happened, in the other direction, on 2026-10-28:

- a parallel session moved the **hand-maintained** number in `docs/CURRENT-STATE.md` to **1321**;
- the **generated** snapshot in `docs/status.json` still said **1319** — because the two live in different
  places and only one of them was updated;
- the `[status]` section went red, and the red arrived as a **red CI Hygiene job (#431)**, hours after the
  commit that caused it, on a machine with no way to explain itself.

The drift gate caught it. But that gate takes minutes and runs in CI, which means the mistake is found by
someone else's pipeline rather than by the session that made it. The same question — _does the committed
payload still describe the tree we are standing in?_ — can be asked in **milliseconds**.

So it is now asked there, in the unit suite (`tests/drift-check.test.ts`):

> the committed status snapshot's `spec-counts` claim must equal the live count, RIGHT NOW.

**Falsified before it was trusted.** Reverting the payload to the exact stale value that caused CI #431
("1319 claimed, 1319 measured", against a live 1321) turns the new check **red in 139 ms** — not on a
missing symbol, but on the claim itself. Restored, all twelve checks in that file are green.

This is the difference between a gate that fires **hours later, on someone else's machine** and one that
fires **while the mistake is still in the author's hands**. It does not replace the drift gate; it is the
fast half of it.

**It then fired for real, on the next wave.** Two more spec files landed (`tests/proposal-constraints.test.ts`
and `tests/musical-proposal.test.ts`), the count moved to **1323**, and the row stayed at **1321**. The new
check went **red in 139 ms** — locally, while the session that caused it was still working — and the slow
gate confirmed it minutes later:

```
✗ DRIFT [status] docs/status.json: committed artifact is stale
✗ DRIFT [counts] docs/CURRENT-STATE.md:Vitest spec files: CURRENT-STATE says 1321, live code measures 1323
```

**And the third instance was the one nobody could see.** The published status page `docs/STATUS.md` had
been sitting at **1319** since `8dadef42` — the same day, the same count, the same wave — because the page
was excluded from the comparison entirely, and the timestamp was the excuse. A stale number on a published
page is a documentation defect that no gate could reach. With the page now owned and compared **minus its
timestamp line**, it is a drift finding like any other.

The count is a **whole-tree measurement**: it belongs to nobody's wave. This audit's wave still moves it by
**zero** — one spec removed, one added — and every wave that adds or removes a spec has to re-pin it. That
is the ritual the artifact rule in `AGENTS.md` now names, and the fast check enforces it in the unit suite
rather than in someone else's CI.

### 10.11 The fourth instance — a coverage claim landed without its source

The three drift instances above are the same shape: a **number** moved and the artifact that carries it did
not. The fourth is the same shape one level deeper, and it is the sharpest of the four, because **the
published status page claimed a PASS that was false**.

Measured on a clean detached worktree at `a448853b`:

```
$ npm run drift:check
✗ DRIFT [status] docs/status.json: committed artifact is stale
✗ DRIFT [status] docs/STATUS.md: committed artifact is stale

$ node scripts/check-seam-coverage.mjs
FAIL false coverage claim: tab-traversal: declared COVERED but tests/ui/App.test.tsx never contains
"Tab traversal vs next-track scope" — the spec does not enter this seam, so its passing proves nothing about it.
SEAM COVERAGE GATE FAILED — 1 false coverage claim(s).
```

The chain, in order:

1. `5dda14f6` added a seam to `tests/seam-manifest.json`: `tab-traversal`, status `COVERED`, `spec:
tests/ui/App.test.tsx`, `seamEvent: "Tab traversal vs next-track scope"`. **The claim landed; its source did
   not** — the `describe("App — Tab traversal vs next-track scope (CF-05)")` block that the claim names was
   still uncommitted in a parallel session's working tree.
2. `a448853b` regenerated the status payload **in that shared working tree**, so the payload described a tree the
   commit did not carry: `docs/status.json` published `seam-coverage: pass — 1 check(s), 95 seams`.
3. On `main`, the seam gate reads the **committed** manifest against the **committed** spec, and finds a claim
   with no proof behind it. `95 seams` was true; `1 check(s), 95 seams, pass` was not.

**A coverage claim is a derivable artifact.** It says "this seam is entered by this spec", and that is a
statement about files — so it is true only of the tree that carries both of them. This is the same rule as the
count row and the payload, one level up: **land the claim with its source, or land neither.**

**The fix was measured, not guessed.** Applying the parallel session's uncommitted files (`src/ui/App.tsx`,
`src/ui/shortcuts.ts`, `tests/ui/App.test.tsx`) to the clean worktree and re-measuring:

| Measurement                            | `main` alone           | with the uncommitted files              |
| -------------------------------------- | ---------------------- | --------------------------------------- |
| `node scripts/check-seam-coverage.mjs` | FAILED — 1 false claim | **PASSED — 1 checks, 95 seams**         |
| `vitest run tests/ui/App.test.tsx`     | 2 failed, 14 passed    | **16 passed**                           |
| `npm run status:report`                | 4 pass, 1 fail         | **5 pass, 0 fail**                      |
| regenerated payload vs `HEAD`          | `status.json` differs  | **identical except the timestamp line** |

Three things that table says, and one that it does not:

- the **spec alone is not enough** — with only `tests/ui/App.test.tsx` applied, the two NEGATIVE assertions
  fail (the CF-05 Tab guard lives in `src/ui/App.tsx`), so a spec and its source must land **together**;
- the **payload needs no regeneration** once they land — the committed `docs/status.json` already carries the
  right numbers, because it was generated from the tree that will carry them. The fix is therefore a commit of
  **source** files, not of artifacts;
- what the table does **not** say is that this session should make that commit. Those files are another
  session's in-flight work; landing them would put their half-finished wave on `main` under this session's
  name, which is precisely the attribution failure §10.8 records. The finding was handed over with the exact
  measurement instead — see §10.11.1.

### 10.11.1 The handover, and how it ended

The rule in `AGENTS.md` that predicted this failure was written by this session, one commit earlier
(`60539d6d`): **"Regenerate from a CLEAN tree at the commit that will carry the artifact."** The payload in
`a448853b` was regenerated from a tree that included uncommitted work — so it described a commit that did not
exist yet. The rule was not violated by ignorance; it was violated by the ordinary pressure of a shared
worktree, where the artifact and the source live in different states of the same directory.

What this session did **not** do, deliberately:

- it did **not** regenerate the payload in the shared tree either — that would have produced a payload
  describing the shared tree's uncommitted state, the same error one commit later;
- it did **not** commit the parallel session's half-finished wave to make `main` green — the green would have
  been a lie about who wrote it, and the spec would have landed without the source that makes it pass;
- it did **not** wait for the slow gate to tell it what the fast gate already said in milliseconds.

What it did do: reproduce the failure on a clean tree, identify the exact missing file, verify the fix on that
clean tree **before** proposing it, and hand the measurement to the session that owns the files.

**How it ended.** The owner session landed the source with the claim — `892dcc61` (the CF-05 Tab-traversal fix
in `src/ui/App.tsx` and `src/ui/shortcuts.ts`) and the spec that backs it — and `main` is green again,
re-measured on a clean detached worktree at `cc81ffe3`:

```
$ npm run drift:check
[drift] section mcp-mirrors (npm run gen:mcp-mirrors)
[drift] section domain-goldens (npm run goldens:capture)
[drift] section status (npm run status:report)
[drift] section counts (live code vs docs/CURRENT-STATE.md)
✓ no drift — derivable artifacts match their generators
```

**And the payload was not regenerated.** `docs/status.json` was already correct — because it had been generated
from the tree that eventually carried the source. The whole repair cost **zero artifact churn**: one commit of
source files, and the published page that had been lying turned true without being rewritten.

That is the whole lesson of the four instances in one sentence: **a derivable artifact is not a document, it is a
measurement — and a measurement is only right on the tree that produced it.**

### 10.11.2 The fifth instance — the drift gate was red on `origin/main`, and this report said green

**The parallel session's hand-off corrected an assumption this report had been carrying.** §10.1 records
`npm run drift:check` as ✅ green. On `origin/main` it was **not**: `docs/CURRENT-STATE.md` claimed **1335** Vitest spec
files while the committed tree held **1336**. The parallel session fixed it in `61a31bc0` — re-pinning the claim and
regenerating `docs/status.json` and `docs/STATUS.md` — and from that commit the committed payload read **"1336 claimed,
1336 measured"**, `state: pass`.

Two things are worth separating here. The **count** was stale in the ordinary way (§10.11's shape, for the fifth time), and
the **claim in this report** was stale in a worse way: it said green because a measurement had been green **on a tree that
had since moved**. "The drift gate was green when this section was measured" is not the same sentence as "the drift gate is
green now", and a report that keeps the first shape while the tree moves is a report that will lie quietly.

**Re-measured here, on the committed tree, rather than taken on relay.** The counting rule is `git ls-files tests`, counting
`.test.ts`/`.test.tsx` and excluding `tests/e2e/` (`scripts/status-report.mts:83-85`): **1336** measured against **1336**
claimed _at that commit_. The seam claim moved too — from that commit the committed payload read **1 check, 104 seams**
(§10.11 measured 95).

**And then it went red again, the same day, for the same reason.** CF-15 (`31411056`) added two seams to
`tests/seam-manifest.json` and regenerated nothing, so the payload's seam claim went stale **again** — and this time it was
measured rather than inferred: `npm run drift:check` on the committed tree exits **1** with

```
✗ DRIFT [status] docs/status.json: committed artifact is stale
✗ DRIFT [status] docs/STATUS.md: committed artifact is stale
```

while `mcp-mirrors`, `domain-goldens` and the counts section are **green** — so the drift was in exactly one claim, the seam
count, and nowhere else. Regenerated with `npm run status:report` and committed in `d696851f`; the diff is **only** the seam
count (102 → 104) plus the generation timestamp, every other row byte-identical — so no parallel session's uncommitted work
leaked into the artifact, which is the failure mode §10.11.1 is about. **Re-verified by running the gate itself on the fixed
tree: `npm run drift:check` → `✓ no drift — derivable artifacts match their generators`, exit 0.**

**So the drift gate has now been red on `origin/main` twice in two days, both times for a count that moved in the working tree
and not in the artifact.** The gate is doing its job — it caught both. What is still missing is the moment between "the count
moved" and "the artifact moved", which belongs to whoever moved the count.

**And the same shape ran again one wave later — against this report's own numbers.** The parallel session's next wave
landed a new spec file (`tests/mix-proposal-constraints.test.ts`) and one more seam (CF-22, `108242d9`), so the counts moved
again — **1336 → 1337** specs, **104 → 105** seams — and were re-pinned in `3328668c` **in the same wave that moved them**,
with the status artifacts refreshed in the same commit. That is the practice §10.11.1 asks for, and the tree is clean.

**The report was the laggard.** §10.1 still quoted **1336** and **104** while the committed payload already read **"1337
claimed, 1337 measured"** and **1 check, 105 seams**. Both are corrected in place above. This is the **seventh** instance of
the shape, and it is the first one where the drift was not in the tree at all — the tree and the artifact agreed, and only
the prose was old.

**So the number has FOUR homes, not three.** §10.16.8 said: _"a number that appears in a spec, in a report and in a payload
is one number, and it has three homes — change it in all three or in none."_ The instance here names the missing one: the
ratchet spec, the payload artifact, `docs/CURRENT-STATE.md`, **and this report**. Two of those four are derived and are
covered by the drift gate; the other two are maintained by hand. **The gate catches the tree↔artifact mismatch; nothing
catches the hand-maintained copies**, because a report is not derived from anything — so its numbers go stale silently and
read as current until somebody re-reads them. A report that quotes live counts must either re-measure them on every
commit or quote them with the commit they were measured on; this one now quotes both.

### 10.11.3 The eighth instance — this time the ARTIFACT was stale too, and `main` was red

**The seventh instance (§10.11.2) was a report-only drift: the tree and the artifact agreed, and only the prose was old.
The eighth instance is the harder shape — the artifact itself was stale, so the drift gate was red on `origin/main`
itself.** Measured here, not inherited: `npm run drift:check` on the committed tree exits **1** with

```
✗ DRIFT [domain-goldens] tests/domain-goldens/serialization.json: committed artifact is stale
✗ DRIFT [status] docs/status.json: committed artifact is stale
✗ DRIFT [status] docs/STATUS.md: committed artifact is stale
```

while `mcp-mirrors` and the counts section are **green**. Three stale artifacts, and they have **three different owners**,
which is what made this instance worth a section of its own:

| artifact                                  | stale because                                                          | whose count                          | re-pinned in |
| ----------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------ | ------------ |
| `tests/domain-goldens/serialization.json` | the document's schema version is part of the serialized form (40 → 41) | **this session's** P-2 (`70f3b175`)  | `df3b0e87`   |
| `docs/status.json`, `docs/STATUS.md`      | the seam count moved 105 → 106                                         | CF-18 (`362a82be`), not this session | `4c58e9d4`   |

**The provenance matters more than the fix.** The seam's `+1` is CF-18's — the parallel session added the
`effect-ab-empty-slot-guidance` seam to `tests/seam-manifest.json` and regenerated nothing — and it made the
**"Hygiene (format + drift)"** job red on `80940176` and on every commit after it, which is visible in CI as the error
annotation `drift check failed (exit 1)` with both stale paths named. **This session's own wave owed no count re-pin at
all**: it added no spec FILE (the new P-2 specs live in an existing file, so the spec-file count stayed **1345**) and it
touched `tests/seam-manifest.json` not at all. **A wave that moves no count can still land on a red tree**, because the
red belongs to whoever moved the count one wave earlier — so the re-pin is a shared debt, not a private one, and the
honest commit says whose count it was (`4c58e9d4`: "the +1 seam is CF-18's, not this wave's").

**And the report was the laggard for the third time, on the same tree.** §10.1 quoted **1337 / 105** while the committed
payload already read **"1345 claimed, 1345 measured"** and **"1 check, 106 seams"** — eight specs and one seam of drift
in the prose alone. The four homes moved as follows in this instance: the **ratchet spec** (`palette-search-coverage`)
was re-pinned deliberately at **80** actions by this session's wave; `docs/CURRENT-STATE.md` was re-pinned by the parallel
session to **1345**; the **payload artifact** was regenerated here (`4c58e9d4`); and **this report** is corrected in place
above. **The rule this adds: a report that quotes a live count must name the commit the count was measured on — the
moment the tree moves, the quote is history, and the only difference between "history" and "a lie" is whether the reader
can tell.**

### 10.12 The sixteenth finding — the loudness map, read as a measurement

The CI triage in the parallel session fixed three gates and, in fixing them, exposed a **product-level** finding
that no audit worker had reached: the preset-audition gate reports **PASS for presets that render as
near-silence**. It is written up as **HCP-03-16**; this is the measurement behind it.

Measured from the generated map alone (`src/presets/preset-loudness.generated.ts`, 671 entries) on a clean
detached worktree at `b50af438`:

| measurement                                    | value                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| the audition gate, granular family only        | `passed=16/16` — **PASS**                                                   |
| presets in the map below −45 LUFS              | **62 of 671** (9.3 %)                                                       |
| the map's own family targets                   | −21.7 (texture) … −29.6 (vocal) LUFS                                        |
| the quietest preset in the whole library       | `factory.granular.ambient.dust` at **−70.0 LUFS**                           |
| the quiet tail's composition                   | keys 24, pluck 14, granular 13, drumsynth 6, sampler 2, vsco 2, vocalchop 1 |
| the granular family after the product's +18 dB | −52.0 … −20.5 LUFS — 7 of 16 still below −40, 10 of 16 below −30            |

The two conditions that let it pass are in the gate itself: `src/browser-checks.ts:258` requires the preset to be
**in the map**, and `:260` exempts anything measuring **below −70 LUFS**. The map's expected value for these
presets is near-silence, so "in sync" is satisfied — and "finite and unclipped" is satisfied by silence.

**What this session measured, and what it took from the parallel session.** The `passed=16/16` verdict, the map
contents and the arithmetic are measured here. The **peak = 0.0001** figure for four granular presets and the
**3–10 LU sampler drift** are the parallel session's measurements, reproduced in their message and not
re-measured here; they are labelled as such in HCP-03-16.

**One correction this session made to itself.** The first hypothesis was that the granular presets were _absent_
from the loudness map, which would have made the check vacuous by omission. A `Select-String` appeared to
confirm it and was wrong; a parser that separates the file's two maps shows all 16 present, with the map's
minimum belonging to the granular family. The corrected finding is stronger, not weaker: the map **records** the
near-silence as the expected value and the gate then faithfully certifies it.

That is the same shape as §10.9 and §10.11 — a check that reports ✓ without asking the question it appears to
ask — except that this one is about **sound**, not about a number on a page.

**A second, smaller finding, from the same triage.** The stutter effect reads from **one loop behind** — a
circular delay buffer of one loop cycle — so during its first cycle that buffer is empty and a fully wet stutter
is **silent by design**. The gate that checks it rendered exactly one loop (the house pattern is one bar) and
measured that bar, so it measured the effect's **pre-roll**, not its gate; the parallel session fixed the check
to render two bars and measure the second. The remaining wart is a **product** decision, not a gate bug: a fully
wet stutter **mutes its track for the first loop**. Recorded here, not fixed — changing it is an audible
product decision, and it belongs to the owner.

### 10.13 The live↔offline class — a question, a measurement, two refutations, and a handoff

A parallel session asked a direct question: had this audit found anything new about the `live↔offline null test`
class? The honest answer is **no**, and it is worth recording why rather than leaving it implied.

**What the audit did and did not cover.** The remit was the capability surface and its discoverability — what
the product can do, and where a working capability cannot be reached from. Engine determinism is a different
order of work. The report contains **no** mention of `live↔offline`, `null test`, `parity` or `determinism`,
verified by search rather than by memory.

#### What this session measured

`scripts/verify-parity-probe.mjs` — the probe the parallel session had built for exactly this purpose — run on
this machine with `KYX_PARITY_CASES=bitcrusher,ozvena,instrument:texture`:

| case                   | liveNull     | corr   | liveRepeat | control   | rt-nondet | segHead  | segTail      |
| ---------------------- | ------------ | ------ | ---------- | --------- | --------- | -------- | ------------ |
| `bitcrusher` (control) | −51.0 dB     | 1.0000 | −325.2 dB  | −325.2 dB | false     | −50.3 dB | −75.5 dB     |
| `ozvena`               | **−40.0 dB** | 1.0000 | −323.3 dB  | −323.3 dB | false     | −62.1 dB | **−34.4 dB** |
| `instrument:texture`   | −81.5 dB     | 1.0000 | −83.1 dB   | −86.1 dB  | false     | −63.5 dB | −81.5 dB     |

#### Two of this session's three readings were wrong

The parallel session measured the corpus itself and refuted both of the conclusions this session drew from the
table above. The corrections are recorded here because the report's own standard is that a refuted reading is
reported, not quietly dropped.

**Refutation 1 — "corr = 1.0000 means the live and offline render are the same signal" is mathematically
invalid.** `correlationAt` (`src/testing/live-offline-parity.ts:699-714`) **is not a true Pearson coefficient** — the
implementation does not subtract the means, so it is an uncentred cosine similarity, and its own docstring is wrong
about its own metric (§10.16.6). For a small error `corr ≈ 1 − e²/2` where `e = 10^(null/20)`: the correlation is
**quadratic** in the error, not linear. Independently recomputed here against the parallel session's five corpus
cases:

| corpus case         | null     | corr predicted | corr measured |
| ------------------- | -------- | -------------- | ------------- |
| `fx:ozvena`         | −39.2 dB | 0.999940       | 0.9999        |
| `fx:morphdynamics`  | −29.7 dB | 0.999464       | 0.9997        |
| `fx:bassHarmonic`   | −27.2 dB | 0.999047       | 0.9991        |
| `fx:portal`         | −7.1 dB  | 0.902508       | 0.9019        |
| `instrument:analog` | −13.7 dB | 0.978671       | 0.9789        |

`corr = 1.0000` to four decimals therefore bounds the error at **below ≈ −40 dB** and cannot separate −40 dB
from −45 dB. **The criterion this session proposed on top of it — accept the case when the correlation is high
and the magnitude spectrum and RMS agree — would have waved through exactly the cases it was meant to catch.**
A saturated metric cannot gate a threshold it cannot resolve.

**Refutation 2 — "the failures sit on the acceptance floor, so the difference between 6 of 67 and 22 of 67 is
environment rounding" was unfounded.** The probe does **not** measure the corpus: `__runParityCaseForProbe`
(`:1140-1157`) renders a plain `noteOn` on `effectDoc(createProjectFromTemplate("house"), type)`, while the
corpus builds its own per-family documents and scripts — a filter expression for `direct-filter`, a modulation
expression for `modulation`, a held slide for the rest (`:1349-1379`). **Probe numbers and corpus numbers are
not comparable**, so the −40.0 dB measured above says nothing about the corpus's −39.2 dB. And the corpus's own
values are **identical on Windows and on the Linux runner** — `ozvena` −39.2/−332.9, `morphdynamics`
−29.7/−331.0, `bassHarmonic` −27.2/−332.2, `portal` −7.1/−331.6, `analog` −13.7/corr 0.9789. Those are not at
a knife edge, and they are **stable across platforms** — which inverts this session's conclusion: a
reproducible live↔offline difference is a **divergence in the engine**, not rounding in the environment.

**That generalisation was itself falsified — and it is the most transferable thing in this report.** The
differences were indeed reproducible; what that proved was **not** that they came from the engine. They came from
the **capture lead** — the live branch is half a second warm when the offline branch is cold — and a fixed
0.5 s of lead is _perfectly reproducible on every platform_, which is exactly why the numbers looked so stable
(§10.16.5). **Reproducibility is a property of the measurement, not of the product.** A harness artifact that is
deterministic will look identical on Windows and on a Linux runner, and it will look identical on every commit,
forever. The lesson generalises past audio: before asking _what does a reproducible difference mean_, ask _what was
compared_ — two things can be deterministic and still not be the same thing.

**What the corpus actually shows, per the parallel session's two CI runs.** The run-to-run difference is in the
**instrument** cases — 22 of 67, then 21 of 67, the latter mostly instruments (`808`, `texture`, `keys`,
`organ`, `strings`, `bell`, `reese`, `clav`, `acid`, `brass`, `fm`, `pluck`, `flute`, `logdrum`, `drumsynth`,
`ladic`, `analog`) that pass on a desktop and fail in CI, with the count moving between runs. The **stable**
set is five cases: four effects (the documented class) plus `analog`, whose correlation of 0.9789 sits just
under the 0.99 threshold. A corpus whose verdict moves run-to-run on the same commit cannot serve as a CI gate.

#### The structural observation that does survive

The harness derives its exemption from a **property**, not a name list (`live-offline-parity.ts:1333-1338`) —
the offline control must be clean and the live branch must be nondeterministic against itself. That is the right
shape. But it names only two classes, and the corpus's own error message says what is missing: _"the
phase-insensitive numbers above are DIAGNOSTIC in this corpus, NOT an acceptance criterion"_ (`:786`). The
harness computes three phase-insensitive comparisons and the note-expression corpus accepts on them
(`phaseInsensitiveParityAgrees`, `:645`), while the effect and instrument corpus refuses. A case whose only
defect is phase therefore has **no derived class** and falls through to red.

#### The discriminator the corpus already prints

The open decision — whether the five stable cases are a phase difference to be fixed in the engine or a
different processing path to be fixed in the product — is answerable **from numbers the corpus already prints
in its failure message** (`:780-788`) and the parallel session has just made those names visible in the CI
annotation:

- `spectrum=` (live↔offline magnitude), `offlineSpectrum=`, `liveRepeatSpectrum=`, `RMS=` — if the magnitude
  spectrum agrees (cosine ≥ 0.98) and the RMS ratio sits in 0.9–1.1 while only the waveform null is bad, the
  two branches compute the **same spectrum** and differ in phase or alignment; if the spectrum itself differs,
  the export is **not** the live branch and invariant 3 is violated.
- `liveRepeat=` — if the second realtime capture is also bad on CI, the realtime branch was starved by the
  runner rather than diverged by the engine; if it is clean, the divergence is the engine's.

#### What was handed over, and what was not done here

The probe measurement, the reading, the re-pin rule — the spec count is correct at **1325 claimed / 1325
measured**, and re-pinning to 1326 _before_ the untracked spec file is tracked would turn the gate red — were
handed to the parallel session that owns the corpus, together with the two corrections above. This session did
not change the harness: the acceptance policy is a product decision, and the corpus is not this audit's to
close.

**The hole that was handed over is now closed, and the closing argument is worth recording.** The escape in
`nullTestCase` demanded `realtimeNondeterministic && correlation ≥ 0.99`, but the noise that makes the realtime
branch nondeterministic is exactly what destroys the correlation (measured: `pluck` `liveRepeat` −4.6 dB at
correlation **0.8063**) — so the escape was **unreachable for the class it was built for**, and every case it was
written for was reported as a red engine divergence. The correlation was only ever a **proxy** for "same
processing path"; the `live↔live` comparison answers that question directly. The fix removes the correlation term
(`ee899de7`). Its discriminating property was measured on the four cases both sessions called stable — reverb
corr 0.8558, morphdynamics 0.9998, bassHarmonic 0.9998, portal 0.7802, **all with `rt-nondet = false`** and
`live↔live` at −322…−324 dB — so a genuinely different processing path (which is _deterministic_, and therefore
has a clean `live↔live`) is still not excused: **the fix keeps every one of them red and removes only the coin
flips.** The verdict is now a property of the measurement, not of the run's luck.

### 10.14 The CI runner is not a measurement environment for this corpus

> **STATUS 2026-10-29 — this section's central claim was withdrawn the next day.** §10.14 concluded that the four effect
> divergences were "an **invariant-3 product finding**" and named a suspect in `src/effects/registry.ts`. **Both are
> withdrawn** (§10.16.5): the divergence was the harness's **capture lead** — a warm live branch compared against a cold
> offline one — so invariant 3 was never violated and the suspect was wrong. This section is kept as the record of what
> was believed, and every instance of the withdrawn claim is now **marked in place**, so no reader can meet it in the
> present tense.
>
> **A second supersession, added 2026-10-29 — the section's TITLE is wrong too.** "The CI runner is not a measurement
> environment for this corpus" no longer holds: the runner's verdict reads `environment=measurable`, its calibration is
> **−334.4 dB on both axes**, and the runner's corpus number is exactly reproducible on a **second, unrelated Linux
> machine** (§10.16.6). What survives of this section is not "the runner cannot measure" but "**Linux and Windows
> disagree**" — which is a **product** question, and the smallest invariant-3 candidate this audit has ever held.

The paragraph above measures the corpus on a desktop. The parallel session then measured it on the CI runner —
and that measurement is the more consequential one, because it shows the **runner** is the problem, not the
corpus.

**Three CI runs, the same code** (the harness has not changed since `6dd5b76e`):

| run  | red | membership change                                                                                 |
| ---- | --- | ------------------------------------------------------------------------------------------------- |
| #452 | 22  | —                                                                                                 |
| #453 | 21  | `instrument:bell` fell out                                                                        |
| #455 | 20  | `fx:bassHarmonic` fell out (it had measured −27.2 dB twice in a row) — `instrument:struna` joined |

**The branch consistency is not consistent either.** The corpus's own controls must be deterministic — `control`
is the same offline render twice, and `liveRepeat` is the same realtime case twice. On the CI runner:

- `fx:morphdynamics`: `liveRepeat` −331.0 → **−75.9 dB** between runs;
- `instrument:analog`: `liveRepeat` −77.6 → **−323.6 dB**, and `control` −78.5 → **−75.8 dB**.

**This section's first conclusion was tested, and it did not hold as stated.** The claim this section opened with
was that the runner's offline branch is not reproducible, so its red list measures the machine's load rather than the
engine. The calibration case **disproves that generalisation**: the offline branch **is** exact on the runner — the
calibration control measures **−334.4 dB in CI, bit-identical, and identical to the desktop's −334.4 dB** — and the
environment line therefore reads `environment=measurable (calibration fx:bitcrusher control=-334.4 dB, needs
≤ -200 dB)`. The failure was mine, and it was a specific one: I generalised **one instrument case**
(`instrument:analog control −78.5 → −75.8 dB`) to the whole environment. A calibration case that is deterministic
**by construction** says nothing about whether an oscillator's offline render repeats bit-identically on another
platform.

**What the 17 CI-only instrument failures actually are.** The corpus reports **failed = 21/67** on the runner _(that
annotation; the corpus has since moved — 18/67 after the capture-lead fix `ae372bf4`, and **17/77** at `b2a02569` —
§10.16.6)_: the
same four effect findings as on the desktop (`fx:ozvena`, `fx:morphdynamics`, `fx:bassHarmonic`, `fx:portal`, all
with `realtimeNondeterministic = false` and `live↔live` at about −332 dB) **plus 17 instrument cases that PASS on
the desktop**. For those 17 the offline control is **exact** and the realtime branch **reproduces itself** — yet it
still differs from the offline render. That is **platform realtime behaviour on that runner, not the product's
verdict**. The `instrument:analog` control that moves 3 dB between runs is a second, independent symptom of the
same platform difference. **Scoping note (added 2026-10-29):** that 3 dB movement is one case in one earlier
annotation, and the later CI annotation does **not** confirm it — its controls are exact for the 14 systematic
cases (−336.4, −323.6, −321.8 …). The noise is on the **noisier axis of one case**, not on the corpus as a whole,
which is what the calibration case already showed (§10.16.6).

**So the section's conclusion survives — with a different mechanism than the one it was written with.** The runner
still is not a measurement environment for this corpus. But not because its arithmetic is inexact: it is because the
runner's **realtime path diverges from its own offline path** in a way the desktop does not, for a class of cases
that is green on every desktop. A calibration case proves the environment can render bit-identically twice; it does
not prove the realtime and offline paths agree with each other.

**[SUPERSEDED 2026-10-29 — §10.16.6.]** The paragraph above has the right shape with the wrong subject. The runner
**does** measure this corpus: `environment=measurable`, calibration **−334.4 dB on both axes**, and the same numbers
reproduced on a **second, unrelated Linux machine**. What diverges is not the runner but **Linux itself** — so "the
runner is not a measurement environment" becomes "**Linux and Windows render the same instrument differently**", and
that is a product question, not an environment question.

**The desktop, by contrast, is reproducible.** Windows and Linux produced **bit-identical** values for the four
effects. So the two statements point in opposite directions:

- on a valid environment, the live↔offline divergence for those cases is **real** — an engine divergence, and an
  invariant-3 question; **[WITHDRAWN 2026-10-29 — §10.16.5: the divergence was the harness's capture lead, not the
  engine. "Real" and "invariant-3 question" are both withdrawn; invariant 3 was never violated.]**
- on the CI runner, the corpus's verdict mixes **two different things**: the four real findings, and a
  platform-specific realtime divergence that is green on every desktop. The membership of the red set moves between
  runs for the second reason, not the first. **[The "four real findings" half of this split is withdrawn too — there
  were no findings (§10.16.5). What remains is the platform-specific divergence, now characterised as a systematic,
  deterministic, whole-window difference (§10.16.6).]**

**A narrowing that was itself withdrawn — and the statement that replaces both.** The bullet above originally read
"noise, **including** the five cases this report had called stable". The parallel session then reported that
**ozvena, morphdynamics, bassHarmonic and portal reproduce bit-identically in two local runs _and_ in CI**, and
this report narrowed the claim accordingly (`319027fe`). That narrowing was this report's error, made on the strength
of a statement the parallel session has since **withdrawn in writing**: the "in CI" half was wrong, `bassHarmonic`
did drop out, and the four are stable **locally** — proven by their own `live↔live` and `control` values, not by the
CI runs. The corrected form is the one that survives: the four are bit-identical **locally** (`live↔live` ≈ −332 dB,
`control` ≈ −332 dB, two machines) and they reproduce in CI as the same four with the same numbers — but "stable in
CI" was never a claim the CI runs could support, because the corpus as a whole is not reproducible there.

> **WITHDRAWN 2026-10-29 — see §10.16.5.** The paragraph below is what this section concluded on 2026-10-28. It is kept
> verbatim because it is the reasoning that was falsified, and it is the reasoning a reader meets first. **None of it
> survives:** the four divergences were the harness's **capture lead**, the "invariant-3 product finding" is withdrawn
> (invariant 3 was never violated), and the named suspect — the offline parameter regime in
> `src/effects/registry.ts` — was wrong. The measurement that withdrew it, and the correction of the "phase anchor"
> proposal that followed it, are both in §10.16.5.

**The four divergences, on a valid environment, are a product finding.** ← **withdrawn, as marked above**
ozvena **−39.2 dB**, morphdynamics
**−29.7 dB**, bassHarmonic **−27.2 dB**, portal **−7.1 dB**, with `live↔live` at −322…−324 dB (the same processing
path on both sides) and the offline `control` at −321.9…−323.9 dB (the same document rendered twice is
bit-identical). That is an **invariant-3 product finding**: the export does not sound like the live branch, and it
does so for a reason rather than by accident. The parallel session located the suspect — the **offline parameter
regime in `src/effects/registry.ts`** — and deliberately left the four red.

**And this section's central claim was falsified the next day — by the capture lead.** The four divergences were
**not** a product finding. The corpus compared the live branch against an offline branch that started **cold**,
while the live branch's capture starts `CAPTURE_START_LEAD_SEC` (**0.5 s**) into the live context
(`src/testing/live-offline-parity.ts:54`): by the time the first event lands, every realtime worklet has already
processed half a second of history — a free-running modulation phase, a filter's memory, a comb's drift, a pitch
tracker's buffer. The two branches were therefore compared at the same **nominal** time while their internal state
differed by a whole capture lead. The divergence the corpus measured was **the lead, not the engine**: with the
offline render given the same lead (`ae372bf4` — `renderOffline` at `:321` and `:328`), three of the four become
**bit-identical** and the fourth falls to −72.7 dB, below the corpus's own acceptance floor. **Invariant 3 was never
violated**, the suspect named above was **not** the cause, and the reading of this section's numbers as "four real
findings" is **withdrawn**. §10.16.5 has the measurement, the mechanism, and what this does to the rest of this
section.

**A gate whose verdict moves between runs on the same commit is not a gate.** The agreed direction was to make
the null corpus a **non-blocking report** in CI — visible, but not deciding — until the "phase anchor" was fixed:
the offline branch has to receive the same phase anchoring as the live one (`motionPhase`, `hallEngine lfoPhase`,
the per-partial PLL). **That anchor was the desktop's four findings, and it was believed to be a product fix. It was
not** — the cause was neither a phase anchor nor the engine, it was the **capture lead** (§10.16.5), and the fix
belongs to the **harness**, not to the product. The non-blocking direction still stands on its own merits: the CI
runner's own flapping has a **different** cause — the platform realtime divergence of the 17 instrument cases above
— and no anchor will fix it; the environment verdict and the second calibration axis are what make that difference
visible instead of hiding it behind a red count. But the premise the direction was built on is gone: with the lead
fixed, the corpus has no effect cases to report on a measurable environment, and what remains on the runner is the
platform divergence — which the environment line is there to expose.

**One addition this session proposes, from the corpus's own material — now implemented and measured, on two axes.**
The corpus already contains a calibration case — `bitcrusher`, a deterministic effect whose controls are
bit-identical. That case can serve as a **health check on the measurement environment itself**: if the calibration
case's own `control` or `liveRepeat` is not clean, the environment cannot measure this corpus, and the corpus's
verdict should be reported as **invalid environment** rather than as a number of red cases. The proposal is in the
harness (`ee899de7`, `0b41bd0a`): the corpus measures its own calibration case and reports
**`environment=measurable` / `environment=NOT measurable`** with the measured values in the verdict.

**Both axes are certified, and the threshold was measured rather than guessed.** The first implementation checked
only the offline `control`; the second axis — the calibration case's own `live↔live` — was added because it is
exactly the probe for the 17 CI-only instrument failures. The floors are **≤ −200 dB on both axes**. Measured on
two desktops: `control` **−334.4 dB**, `live↔live` **−231.3 dB** on one machine and **−325.2 dB** on the other, so
even the tightest measurement keeps **more than 30 dB** of margin. (An earlier measurement of this session read
**−325.2 dB** for the calibration _control_; the harness changed between the two measurements, which is why the
figures differ.)

**A verdict must never hide findings.** The failing-case list stays in the message **regardless** of the
environment verdict, so `NOT measurable` can never conceal the four real findings. **[The "four real findings" are
withdrawn — there were none (§10.16.5); the principle stands, and it is now the reason the failing list is kept even
when the environment could not judge every case.]** A verdict that hides findings is
worse than a noisy one. The blocking policy was deliberately left unchanged (`ok` is still
`failures.length === 0`), because "does the corpus block CI" is the owner's decision — but the verdict now makes
that decision possible **from evidence instead of from a guess**. The same question was asked of the product's own
auditions in **HCP-03-16**, where a check reported a verdict without asking whether it had anything to judge.

**A second, smaller story from the same CI run — and a second self-correction.** The eight red tests in
`tests/integrations/audiotool-nexus.test.ts` were not a timeout, as the parallel session first measured and
then refuted: they were **`TypeError: Promise.withResolvers is not a function`** — the Audiotool NEXUS SDK uses
an API that exists only on **Node ≥ 22**, while CI ran on **Node 20**. Every test that called
`createOfflineDocument()` therefore died before doing anything, and the 26 tests in the same file that did not
call it passed. Fixed by moving all eleven jobs to Node 24 and by declaring `"engines": { "node": ">=22" }` so
the dev machine learns it at install time rather than in a test (`4bb8e193`). **KYX's own code uses no Node 22+
API — only the dependency does.**

Two things are worth keeping from that episode. First, **the shape of the red set located the cause**: all
failures in one file, and only the tests that called one function, is a signature that points at a missing API
rather than at a slow build. Second, the parallel session **corrected its own hypothesis** — it had measured a
776 ms WASM compile and a 5-second budget, concluded the two were in conflict, and then found that the timeout
was not the cause; it kept the timeout with a comment saying plainly that it is **not** the cause of those eight
reds. That is the same discipline this report applies to its own findings, and it is recorded here because a
corrected hypothesis is part of the evidence, not a footnote.

### 10.15 The type was the defect — and two kinds of red are not the same kind of red

The CI run on `14b83d42` reported **Typecheck (clean) = failure**, with three jobs red downstream of it
(Production build, Production browser smoke, Browser audio checks). The first attribution — mine, made from the
working tree — was that the errors belonged to somebody's uncommitted work. **That attribution was wrong, and the
measurement is what said so.** The errors live in `tests/mcp-evidence-cache.test.ts`, a file committed in
`f5832eec` — an earlier wave, not a working tree. They were therefore a property of `main`.

**What the compiler was actually saying.** The local typecheck reported **twelve** errors, all of them one
assignment complaint (CI reported the same family: 10 annotations):

```text
tests/mcp-evidence-cache.test.ts(58,40): error TS2345: Argument of type
'{ getRevision?: (() => number) | undefined; getDoc: () => ProjectDocument; }'
is not assignable to parameter of type 'ProjectStore | YDocStore'.
```

The module behind those call sites is `src/mcp/evidence-cache.ts`. It reads exactly two things from its store:
the document (`getDoc().id`, for the cache key) and the optional revision (`getRevision()`, for the
invalidation contract). Its parameter was typed `Services["store"]` — the whole `ProjectStore | YDocStore`
union, 70+ members it never touches. The unit test passed a minimal structural double, which is the correct
way to test a per-store `WeakMap` cache, and the compiler rejected it.

**The honest reading: the test was right and the type was wrong.** There are exactly two ways to silence that
error, and both are lies. Fake 70+ unrelated members in the test, or write `as unknown as ProjectStore` and
throw the mismatch away. The first pretends the module needs a whole store; the second pretends the mismatch
does not exist. A cast is how a structural fact stops reaching the compiler, and this report's whole argument is
that a gate must not certify something it did not measure.

**The count in a CI annotation is not the count of the errors.** The typecheck job carried no error annotation of
its own, so GitHub's default `tsc` matcher rendered only the **first ten** errors, without `file:line` — which is
why CI showed 10 where the local run showed 12. The parallel session measured the same truncation and put an
explicit annotation into the typecheck job (its lane, CI observability). The rule that follows: **an annotation is
a pointer, not a census.** Count the errors locally; never conclude "CI saw fewer errors" from the annotation,
and never read a missing `file:line` as a missing error.

**And the annotation paid for itself within one cycle.** The explicit annotation names the error count, the
per-file counts and every `file:line`. One cycle after it landed, it located a red on `main` that nothing had
seen: the `kyx_analyze` wave shipped four unused parameters in a new spec (`channel` in the fake buffer,
`doc`/`id`/`opts` in the render stub) — four TS6133 errors under `noUnusedLocals`/`noUnusedParameters` — which
broke Typecheck and, with it, the Production build and the UI gates. Before the annotation, the same failure read
**"Process completed with exit code 2"**: no file, no line, nothing to act on and no reason to suspect a spec
file at all. The fix is the repository's own convention — the parameters stay in the signature (the fake still
reads like the contract it stands in for) and their names carry the underscore prefix (`18f1d517`).

**The fix, and the rule the fix obeyed.** The contract is now what is actually read — `src/mcp/revision.ts:23`:

```ts
export interface RevisionSource {
  getDoc: () => ProjectDocument;
  getRevision?: () => number;
}
```

`getDoc` is **required on purpose**, and the first attempt at this fix failed because of it. An interface whose
members are all optional is a _weak type_, and TypeScript then rejects any argument that shares no property
with it. The first version declared only `getRevision?`, and **fifteen** call sites came back with

```text
Type 'YDocStore' has no properties in common with type 'RevisionSource'.
```

That is not noise. `YDocStore` has no revision counter **by design** (ADR 0065 — a store without a revision is a
legal state, not a bug), and a contract whose only member is optional makes that legal state unspellable. So the
contract requires the document every store has (`src/store/ProjectStore.ts:292`,
`src/collab/YDocStore.ts:375` — both `getDoc = (): ProjectDocument => …`) and treats the revision as the optional
half it is. The recorded error is part of the evidence: it is why the contract has this shape.

**A second species of red, in the same CI run.** Two unit specs were red for a completely different reason:
`tests/ui/shortcuts.test.ts` asserted `matchShortcut(Escape) === "stop"`, and `tests/ui/command-palette.test.tsx`
asserted the palette row read `Stop (clears help/selection first)`. Both described the world **before CF-06**,
which deliberately moved stop off Escape onto Shift+Space and renamed the label (`src/ui/shortcuts.ts:127`,
`f55bd1ff`). Those specs were not wrong when they were written; they were **superseded by a shipped decision**.
They were updated to the shipped contract, and the updated spec now asserts the contract _positively_ — Escape
matches nothing, Shift+Space is stop, plain Space still pauses in place (`tests/ui/shortcuts.test.ts:51`) —
instead of matching a label string.

**The difference between the two species, stated plainly.** A type error and a stale expectation are not the same
defect. The type error means the **contract disagrees with the code**; the fix belongs to the contract. The stale
expectation means an **expectation disagrees with a decision already shipped**; the fix belongs to the
expectation. Silencing the first with a cast hides a structural fact; silencing the second by rewriting the
string hides only a timestamp. They do not belong under one "tests are red" label, and they were not filed
there.

**Falsification, because a green test that was already green proves nothing.** With the two spec files reverted
to their pristine `HEAD` versions and nothing else changed, exactly those two tests fail, with exactly the
reported errors:

```text
expected null to be 'stop'
expected 'Stop — return to startShift + SpaceTR…' to contain 'Stop (clears help/selection first)'
```

With the fix in place, measured on a **clean detached worktree** at `2c89e12a` carrying only this patch:
`tsc --noEmit --incremental false` → **exit 0**; **234 tests across 6 suites green** (`mcp-evidence-cache` 9,
`mcp-core` 32, `mcp-tools` 156, `mcp-headless-acceptance` 8, `shortcuts` 9, `command-palette` 20); Prettier
clean; live spec count unchanged at **1330**, so no payload re-pin was owed.

**Provenance of this fix — recorded because the shared worktree decided it, not me.** The change above did not land in
a commit of its own. The parallel session committed from the shared tree while these paths were modified in it, and
its `git add .` carried all six files into its commit `51bd0251` ("ranny commit"), together with that session's own
changes. The **content** is exactly the content measured here — the diff of `51bd0251` for these paths is the patch
described above, and nothing of the parallel session's work was rewritten to make room for it. The **commit message**
is the parallel session's, and it says nothing about this fix.

**And a second thing that makes attribution impossible here, which is worth recording once.** Both agent sessions
commit under the **same git author identity** (`Qvesterino`), so the commit that carries this fix is not merely
attributed to the wrong session — it is attributed to an author that does not distinguish sessions at all. The
repository's own guardrails ask each session to "say what is yours in the commit message", which presumes the message
and the author together identify the author. Here only the message can, and in this case even that was lost. The
consequence is concrete: **a commit in this repository is not evidence of who wrote it.** Only the working-tree state
and the diff can tell. That is why the whole account of this fix — the reasoning, the failed first attempt, the
falsification, and the corrected attribution — lives in this section rather than in a commit message.

**What this section does NOT claim.** The three downstream CI jobs that failed with the typecheck — Production
build, Production browser smoke, Browser audio checks — were **not** re-measured here; only the typecheck was.
They failed as consequences of a broken build, but "would now be green" is not a measurement and is not
claimed. §10.14's question — whether the CI runner can measure the null corpus at all — was **not** settled by
this fix, and the harness hole the parallel session identified (`:777` in the tree at the time — the rule now lives at `:1525`, where the realtime-nondeterministic escape
and the correlation floor cancel each other) was still open **when this section was written**. Both have moved on
since, in the parallel session's lane: the hole is closed and the corpus now measures its own calibration case,
so the verdict says whether the environment can measure at all (`ee899de7`, `0b41bd0a`, and §10.14 above).

**The transferable lesson.** A gate that is red on `main` is a claim about `main`, and the cheapest way to learn
whose claim it is, is to measure it on a clean checkout of the commit rather than on the working tree the
complaint was made from. Twice in this audit the working tree and the commit disagreed — here, and at the
payload re-pin in §10.9 — and both times the commit was the truth.

### 10.16 Three readings of the CI numbers that the verdicts did not give

Findings from the CI runs of 2026-10-29 and 2026-10-30, all measured from the Actions API (one request per question), and
all of them about what a red run **means** rather than about the product.

#### 10.16.1 The queue is the cost, not the runner minutes

`.github/workflows/ci.yml:23-25` puts every push to `main` into **one** concurrency group:

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: false
```

`cancel-in-progress: false` means a **running** job is never killed — but GitHub keeps only the **latest pending**
run in the group, so a push arriving while an older run is still queued **replaces** it (the file's own comment,
`:19-22`, says exactly this). The group is a queue of depth one that keeps only the newest entry.

**Measured, 2026-10-29 (Actions API, `per_page=15`):**

| quantity         | measured                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| arrivals         | **13.2 runs/hour** (15 runs between 04:48:37Z and 05:57:01Z = 68.4 min)                             |
| service          | **3.2 runs/hour** — wall clock of the three runs that reached a verdict: **24.4 / 15.9 / 16.3 min** |
| oversubscription | **≈ 4.1×** (13.2 ÷ 3.2)                                                                             |
| cancelled        | **10 of 15 (67%)**                                                                                  |
| verdicts         | 3 — all `failure`                                                                                   |

`cancelled` means **not measured** — never "failed", never "passed". Ten of the last fifteen pushes to `main`
have **no verdict at all**.

**The live proof of where the missing verdict lands.** At 07:06:39Z, run **#486 (`de355323`, HEAD)** had been
`pending` for **69.6 minutes**, while the only run the group would let proceed, **#483 (`08fbbb2e`)**, had been
`in_progress` since 05:49:21Z — **77 minutes**. Run **#485 (`975ab227`) was cancelled at 05:57:02Z, the exact
second #486 was created**: it was still queued, and the newer push took its slot. The verdict that is missing is
therefore not the verdict of some old commit — it is the verdict of **HEAD**, and of the commit immediately
before it.

**Why "give every commit its own group" is the wrong fix here.** The obvious next thought is a per-SHA group, so
that nothing is ever replaced. The capacity numbers say that thought is wrong, and they say it in two steps:

- GitHub's documented limit for standard hosted runners on the **Free** plan is **20 concurrent jobs** per
  repository ([docs.github.com/en/actions/reference/limits](https://docs.github.com/en/actions/reference/limits.md));
  usage is free for public repositories, and this one is public (`"private": false` in the run payload). That is
  **1200 job-minutes/hour** of capacity.
- Measured consumption is **43.8 job-minutes per run** (#475) and **33.5** (#479) → at 13.2 runs/hour that is
  **≈ 440–580 job-minutes/hour**, about **half** the capacity. The runner minutes are not the bottleneck.

But a run is not a job. One run holds **11 job slots** at its peak, and two runs' full job sets would need **22
slots > 20** — so only about one run can be resident at a time, whatever the group policy is. A per-SHA group
would therefore remove the _cancellations_ and leave the _backlog_: 13.2 arrivals/hour against ≈ 3 runs/hour of
service, with nothing ever cancelled — an unbounded queue in which HEAD's verdict arrives after an unbounded
wait. **That is worse than a cancelled run**, because a cancelled run at least says "not measured".

**The move that the measurement supports is to split the workflow by cost, and to give each half the policy its
role needs** (job durations measured in run #475):

| half                   | jobs (min)                                                                                               | wall     | job-min/run | policy                                          | why                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | -------- | ----------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **fast** (attribution) | typecheck 1.6 · hygiene 2.8 · build 2.4 · prod browser smoke 2.0 · e2e 2.5 · ui-gate 2.9 · dep audit 0.7 | 2.9 min  | **14.9**    | own workflow, **per-SHA group**                 | 13.2/h × 14.9 = **197 job-min/h** vs 1200 → the queue **drains**; every commit gets a verdict in minutes                                                  |
| **slow** (release)     | unit tests 19.4 · browser audio 9.4                                                                      | 19.4 min | **28.8**    | own workflow, **shared `ci-${{ github.ref }}`** | 13.2/h × 28.8 = **380 job-min/h** vs 1200 → it fits; and here "replace the superseded run" is _correct_, because only HEAD's slow verdict gates a release |

The two MRT2 boundary jobs belong to neither column: they carry `needs:` on the other eight (`ci.yml:513-521`),
so they run only when the whole chain is green — and in the measured window they ran **zero times**, because every
run that reached a verdict had a red upstream job. A release-boundary gate that sits downstream of a frequently
red gate is a gate that never reports.

**This section proposed the split; it landed as `bac24d7f` (see below).** Splitting a workflow and choosing
concurrency groups is a
resource decision as much as a structural one, and it belongs to the owner. What is recorded here is the
measurement and one correction: the per-SHA instinct is right for the cheap half and wrong for the expensive one,
because the split has to be by **cost**.

**The split has landed — and one group key in it does not survive the measurement.** `bac24d7f` ("ci: split the
fast gates out, so a push never queues behind a browser run") adds `.github/workflows/ci-fast.yml` with three jobs
(typecheck, hygiene, audit-prod) and its own group
`ci-fast-${{ github.ref }}`; `ci.yml` keeps the six heavy jobs, and the `needs:` references to the two moved jobs
were removed with a comment — correct, because a `needs:` on a job in another workflow is a hard error, not a
warning. The implementation's own comment rejects a per-SHA group outright: _"A per-SHA group would give every push
a verdict but unboundedly INCREASE the latency of the HEAD - the HEAD would sit behind every older push."_

**That is right for the heavy half and wrong for the fast one, and the difference is measurable.** Simulating
GitHub's documented group semantics — one running run per group, the oldest **pending** run replaced by a newer
arrival — on the **measured** arrival sequence above (the 15 push timestamps; service time **2.8 min**, the fast
half's longest job, measured in run #475):

| group policy (fast half)                           | fast verdicts delivered | dropped | added wait |
| -------------------------------------------------- | ----------------------- | ------- | ---------- |
| per-ref, drop-oldest (`ci-fast-${{ github.ref }}`) | **9 of 15**             | **6**   | 0          |
| per-SHA (`ci-fast-${{ github.sha }}`)              | **15 of 15**            | 0       | **0**      |

The model earns its keep on the half that _was_ measured: run with the measured **18.9 min** service time it drops
**11 of 15**, against the **10 of 15** the run list actually recorded — within one run of reality, which is why it
can be trusted for the half nobody has measured yet. (The simulation is of GitHub's documented group semantics on a
measured arrival sequence.)

**The split is live, and its first measurement is in** (Actions API, 2026-10-29 ~08:00Z, the 40 most recent runs):

| workflow          | runs | verdicts            | cancelled    | mean wall clock               |
| ----------------- | ---- | ------------------- | ------------ | ----------------------------- |
| `CI (fast gates)` | 3    | **3 (all success)** | **0**        | **2.4 min** (1.9 / 2.6 / 2.5) |
| `CI` (heavy)      | 37   | 14                  | **22 (59%)** | 12.7 min                      |

So the split does what it was built to do: the fast gates answer **"is the tree broken?" in about two and a half
minutes**, on their own runner pool, while the heavy workflow is still running for 12–30 minutes. A push no longer
queues behind a browser run for a typecheck verdict, and that is now a measurement rather than an intention.

**And the per-SHA question is not answered by the run list yet.** Three fast runs, no drop — but the three pushes
that produced them were **2.1 and 4.0 minutes apart**, so no burst ever reached the group. The simulation says the
drops appear when three to five pushes land inside the fast workflow's wall clock; the measured wall clock of the
live workflow (**2.4 min**) is slightly _below_ the 2.8 min the simulation assumed, which makes the simulated drop
count a slight **over**-estimate, not an under-estimate. The next burst of pushes settles it. Until then the honest
label is **Not verified**: the split works, and whether its fast group still loses verdicts in a burst is a question
the run list has not answered yet.

**Why the fast half behaves differently: the pushes arrive in clusters.** The inter-arrival gaps of the measured
sequence are 0.3, 0.4, 1.0, 1.2, 2.1, 2.9, 3.9, 4.3, 4.5, 4.8, 6.5, 10.0, 24.4 min — mean 4.9, but the pushes come
in **bursts of three to five within two to five minutes**, against a fast workflow whose wall clock is 2.8 min. A
drop-oldest group punishes exactly that pattern: every push inside a burst replaces the one queued before it. With
per-SHA groups the same sequence delivers every verdict with **no added wait at all**, because the runner pool
absorbs the bursts — even on a conservative model of three concurrent fast runs against an arrival every 4.9 min.

**And the cost of the difference is not symmetric.** A heavy verdict that never arrives costs a superseded commit
nothing — only HEAD's slow verdict gates a release. A **fast** verdict that never arrives is a tree that nobody
knows is broken until the heavy workflow reports, minutes later. That asymmetry is the whole reason the split
exists, and it is the reason the fast group's key is the one detail worth getting right.

#### 10.16.2 The perf gate's machine test — the environment must explain the gate, never fail it

The browser gate's perf and realtime budgets decided "machine loaded" from a **single snapshot**: the **max of
three CPU spins against a hardcoded 18 ms floor**. A floor in milliseconds is a property of the **machine**, not of
the code — a fast runner never trips it, a slow one always does — so the same tree flipped between "machine
loaded, informational run" and real FAILs on one busy dev machine. A verdict that flips with the weather is not a
measurement.

The fix (`d1a93517`, `src/browser-checks.ts:4728-4745`) keeps the floor and adds the signal that is
**machine-independent**:

```ts
const spins: number[] = [];
for (let i = 0; i < 5; i++) spins.push(spinMs());
const calibMs = Math.max(...spins);
const calibSpread = calibMs / Math.max(0.001, Math.min(...spins));
const machineLoaded = calibMs > 18 || calibSpread > 2;
```

`calibSpread` is a **ratio**, so it is dimensionless. A machine whose timings disagree with each other cannot
time anything reliably, and that is what a co-tenant which idles for a moment and then competes for the rest of
the window looks like; a 2× spread between the slowest and the fastest of five identical spins is a signal no
processor speed can produce on its own.

**And the number is reported.** A new check — `"perf environment: this machine's timing is measurable"`
(`:4737-4745`) — **always passes** and states `environment=measurable` / `environment=NOT measurable` plus the
measured values; the same `calibNote` is threaded into every budget message that degrades to informational
(`auditRtBudget` `:458`, `auditDenseRender` `:555`, and the render-budget messages). This is the same `environment=`
line the audio-parity corpus now prints (§10.14), and the reason for it is the same: **a verdict that cannot say
whether the machine can measure is a verdict nobody can act on.**

**Two properties make this safe, and they are the rules worth keeping.** First, **the environment check never
fails the gate — it explains it.** A gate that fails on its environment is a gate about the machine; the product
is not what it measured. Second, **both detection changes can only move a run towards informational** (the
spread adds a "loaded" case; the max is now over five samples instead of three), so neither can turn a green gate
red on a loaded machine. And because a degraded run must not hide a real regression behind a machine-load
excuse, the numbers have to travel with the verdict — a silent "informational run" is a verdict nobody can act on.

**What was NOT verified when this section was written — and what has since been observed.** At the time of writing
the change was **verified in code** and, per the commit message, by `tsc --noEmit --incremental false` (exit 0) and
Prettier — but **not observed at runtime**: the browser gate had not been run end-to-end since the change, and **no
spec covers the calibration** (nothing in `tests/` matches `calibSpread`, `perf environment` or `machine loaded`).
The parallel session then ran the full browser gate locally on this machine, and the line is now **observed**:

```text
PASS perf environment: this machine's timing is measurable — calib=15.0ms (floor 18ms) spread=1.1× (max 2×) —
environment=measurable, the budget checks below are gated
```

A second, independent run of the gate (after `ae372bf4`) reports the same shape with a different number —
`calib=12.3ms (floor 18ms) spread=1.1× (max 2×)` — so the line is stable in form and machine-specific in value.

That closes the last open cell, and it confirms both halves of the design at once: the check **passed** (it explains
the gate, it never fails it) and it **reported** the numbers it used — 15.0 ms against an 18 ms floor, a 1.1×
spread against a 2× limit — so a reader can tell "the machine was busy" from "the code is slow" without opening a
log. Provenance: the run is the parallel session's local browser gate (log `tmp-browser-gate2.log`, 2026-10-29
~07:05Z), and the calibration lives in `src/browser-checks.ts`, which that session did not touch — so these numbers
are a runtime observation of the **committed** gate.

**What the observation does NOT establish.** The numbers are **this machine's**: `calib=15.0 ms` describes this
desktop's CPU under this load, and it is not a threshold. What the observation establishes is the **shape** of the
verdict and the property that the environment check cannot turn a green gate red. On a loaded runner the same code
prints `environment=NOT measurable` and the budget checks below it become informational — which is the intended
behaviour, and the reason the numbers have to travel with the message.

#### 10.16.3 A red job whose product code never ran — and three reds that were three different things

Run **#470** (`ee899de7`, "fix(parity): a verdict must say what it could not measure") reported **four** red jobs.
They were four different things, and one of them was not a defect at all.

| job                             | failing step                   | what it actually was                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E2E smoke (Playwright)**      | **#4 `Run npm ci`**            | **the install step failed**; #5 (`playwright install`) and #6 (`npm run test:e2e:smoke`) were **skipped** — the product code never ran                                                                                                                                                                                                                   |
| Hygiene (format + drift)        | #5 `npm run format:check`      | Prettier dirt: `scripts/verify-audible-loop-browser.mjs` is **dirty at that commit** (blob hash `2d2ba4b2ab` vs. hash of its Prettier output `49e8954312`), fixed in `9499c79a`                                                                                                                                                                          |
| Unit tests (vitest)             | #5 `npm run test:expectations` | the **suite-expectations ledger** gate (`scripts/suite-expectations.mjs:20-29`): a test that fails without being listed in `suite-expectations.json` is a "new red", and a listed test that now passes is a "cured" red — both are FAIL. The ledger did **not** change between `ee899de7` and HEAD, so this was drift between reality and a fixed ledger |
| Browser audio checks (Chromium) | #6 `npm run test:browser`      | the live↔offline null corpus (§10.14) — still open, and the owner's decision                                                                                                                                                                                                                                                                             |

**The E2E red is the sharpest instance in this audit: a red job whose code never executed.** The failing step was
the **install**, and the scenario step was skipped — so the run says nothing about the product. Two further
measurements agree: the same `npm ci` on the same tree **succeeded** in the five jobs of that run that reached
their own steps (Typecheck, Production build, Production dependency audit, Production browser smoke, UI gates —
all `success`), and the E2E job was **green in the next three runs that reached a verdict** (#475 2.5 min, #476,
#479 2.5 min). A transient install failure, not a regression.

**And the CF-10 hypothesis is falsified twice.** The natural suspicion was CF-10 — the single-take playhead
change (`197f89c8`), the only product change in that window. It cannot be the cause: (i) **CF-10 is not an
ancestor of that commit** — `git merge-base --is-ancestor 197f89c8 ee899de7` exits **1**, while
`ee899de7 → 197f89c8` exits **0**: CF-10 landed **two commits later**, so its code was not in the tree at all; and
(ii) the scenario step was skipped, so the scenario could not have failed. The hypothesis was recorded, checked,
and dropped.

**The other three reds of that run each got fixed by a different commit in the next three runs — the rule stated
a third way.** In #475 and #476 the Hygiene red had moved from `format:check` to `drift:check` (step #6): the
format half was `9499c79a`, the drift half (four stale artifacts) `02f1888d` + `a6167368`. In #479 Typecheck and
Production build went red as well — the four unused parameters of §10.15, fixed by `18f1d517`. One run, four
reds, four causes, four different fixes; filed under one label ("CI is red") they would have looked like one
defect with four symptoms.

**The rule this section adds to the ones above.** A red run is not one thing — the classification lives in the
**job's step list**, and a step that **never ran measures nothing**. A cancelled run is "not measured" (§10.13);
a run whose product step was skipped is "not measured" in a sharper way, because the machine never reached the
product. The only red that is a verdict about the product is one whose **failing step is the product's own step**.

**Verification performed for this section.** Actions API: the run list for the last 15 runs, the job lists with
step conclusions for runs #470, #475, #476 and #479, and the per-job durations (#475 = 43.8 job-minutes, #479 =
33.5); git plumbing for the ancestry check and for the changed-path list of `ee899de7`; a blob-hash comparison
against Prettier's own output to decide the formatting state of two files at that commit; and the source of
`src/browser-checks.ts:4728-4745` for the perf gate. The 20-concurrent-jobs figure is GitHub's **documented**
limit, not a measurement on this machine.

#### 10.16.4 The verdict the CI runner cannot give — and the desktop that can

The same local browser-gate run produced the second environment line this audit has been asking for, and the gate
around it:

| what               | measured                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the whole gate     | **438 of 439 checks passed**                                                                                                                                          |
| the one red        | the live↔offline null corpus — **failed=4/67**, `environment=measurable`, calibration control **−334.4 dB**, calibration live↔live **−334.4 dB**, `not measurable=0`  |
| the four red cases | `fx:ozvena`, `fx:morphdynamics`, `fx:bassHarmonic`, `fx:portal` — the same four §10.14 named, and **historical**: they were the capture lead, not findings (§10.16.5) |

**The same gate, run again after the lead fix (`ae372bf4`), reports 439 of 439 checks passed and the corpus
`passed=67/67`** — the red list is empty at that corpus size, and the difference is that no product changed
(§10.16.5). **The red list is NOT empty at the corpus's later size of 77** — the idle-machine re-measurement reports
`failed=1/77` plus eight cases the machine could not judge (§10.16.5); the one case that is red is read in full in §10.16.6,
because its numbers do not resemble the runner's. **Update (2026-10-29):** the desktop's reds move with the machine's state —
the parallel session's later local run reports the corpus **green at 77/77** — while the runner sits at **17/77 red** with one
case unjudgeable. **The split that matters is therefore not desktop-vs-runner but Windows-vs-Linux** (§10.16.6).

**Update (2026-10-30): the 77/77 claim has an artifact in the repository — and this session's search for it was wrong twice.**
The artifact is `docs/audits/2026-10-29-browser-audit/browser-audit-head-82f59555.log`, committed at `64d3a798` on
**2026-10-29 10:46** — a full day before this session's own search — and its lines 13 and 445 read
`PASS live↔offline null test: same engine + events on both contexts — passed=77/77 — environment=measurable … not measurable=0`.
**This session's earlier note that the claim had "no artifact in the repository" was false**, and the peer session corrected it:
the search that produced "not found" ran against a **stale snapshot** of the tree, not against the repository. **The report
never carried that false claim** — the original §10.16.4 text recorded the 77/77 figure as the parallel session's _report_,
which it was — but the working notes behind it did, and a note that says "it is not in the repository" is a **measurement**,
and it was wrong in exactly the way a measurement can be wrong: by looking at the wrong copy of the thing.

**The rule this earns: "I searched and found nothing" is a claim that needs the same care as "I found it".** The first is
about the **absence** of a thing, and absence is not observable by a failed lookup — it is observable only by a lookup that
was pointed at the right place. This session's lookup was pointed at a stale copy, produced a confident "0 hits", and that
confidence is what carried into the notes. The repair is the same as for any other measurement: **name the place you looked,
and let the other side say whether it was the right place.**

**One caveat about a second artifact, recorded where the instrument is described (§10.16.9):** the parallel session's
`74a1d8dd` log (`browser-audit-3328668c-plus-rt-floor-loaded.log`) also reads `passed=77/77`, but it was produced against a working tree
that also contained this session's uncommitted `src/browser-checks.ts`, so its name says one commit and its bytes came from
another. The `64d3a798` artifact has no such caveat — it was taken at its own HEAD.

**This is the number §10.14 was waiting for — and the number did not survive the reading §10.14 gave it.** On the CI
runner the same corpus reported **21/67** _(that annotation; the corpus has since moved to **18/67** at `ae372bf4` and
**17/77** at `b2a02569` — §10.16.6)_; on a measurable desktop it reported **4/67**, with the calibration clean on
**both** axes. The environment line is the durable part of this measurement: it says **in the verdict itself**
(`environment=measurable` plus the two calibration numbers) whether the machine could measure, instead of leaving a
reader to infer it from a red count. That is the difference between a corpus whose red list a reader must interpret
and a corpus whose red list states what it could measure.

**But the four red cases in that run are not what §10.14 said they were, and this report's first reading of them was
wrong.** They were the **capture lead**, not product findings: the corpus was comparing a warm live branch against a
cold offline one (§10.16.5). So the split this section originally drew — "_four real findings_ and _seventeen
platform artefacts_" — was wrong in the part that mattered. The four were an **artefact of the measurement**; the
seventeen were real platform divergences. The `4/67` in the table above is a **historical** number: it was produced
by the harness before `ae372bf4`, and the corpus's own count has moved since.

**Provenance, stated precisely.** This run was made by the parallel session on its working tree, which carried
uncommitted changes to the parity harness. Those changes were **diagnostic** — message text, segment-null ranges,
`profileText()` in the failure lines — and they leave the corpus's **membership and acceptance rule** alone; the
failing list in the log is the same four cases. The perf calibration comes from `src/browser-checks.ts`
(`d1a93517`), which that session did not touch, so the perf numbers measure the **committed** code, while the corpus
number measures a tree that is **not** HEAD. And the corpus number is in any case **historical**: the harness moved
under it at `ae372bf4`, which is the subject of §10.16.5.

#### 10.16.5 The four findings were the measurement — and §10.14 is corrected by it

The parallel session's commit `ae372bf4` ("the corpus measured the capture lead, not the engine") falsifies the
central claim of §10.14, and this report's first reading of §10.16.4 with it. The account follows, because **a
corrected hypothesis is part of the evidence, not a footnote**.

**The mechanism, verified in the source at `ae372bf4`.** The live branch's capture starts `CAPTURE_START_LEAD_SEC`
(**0.5 s**) into the live context (`src/testing/live-offline-parity.ts:54`) — deliberately, so that note events can be
queued before the capture starts. By the time the first event lands, every realtime worklet has therefore already
processed half a second of history: a free-running modulation phase, a filter's memory, a comb's drift, a pitch
tracker's buffer. The offline branch started **cold** (`leadSec = 0`). Both branches were compared at the same
**nominal** time while their internal state differed by a whole capture lead. The fix gives the offline render the
same lead and compares from where the capture starts:

```ts
// src/testing/live-offline-parity.ts:321 and :328 (the ae372bf4 fix; current HEAD)
script(engine, (offset) => CAPTURE_LEAD_FRAMES / sampleRate + leadSec + eventPrerollSec + offset);
// …
return buffer.getChannelData(0).subarray(CAPTURE_LEAD_FRAMES); // the lead is history, not signal
```

**The measurement — the parallel session's local run; measured, not estimated.**

| case          | before the fix | after the fix                                           |
| ------------- | -------------- | ------------------------------------------------------- |
| ozvena        | −40.0 dB       | **−72.7 dB**                                            |
| morphdynamics | −26.5 dB       | **−324.2 dB** (bit-identical)                           |
| bassHarmonic  | −33.2 dB       | **−322.8 dB** (bit-identical)                           |
| portal        | −3.5 dB        | **−322.0 dB** (bit-identical)                           |
| reverb        | −5.3 dB        | **−323.4 dB** (bit-identical; excluded from the corpus) |
| eq (control)  | −64.1 dB       | **−325.1 dB** (control, still green)                    |

With the corpus's acceptance floor at `PARITY_NULL_FLOOR_DB = −40` (`:99`), every one of the **after** values is
**below** the floor — so the corpus has no reason to report any of them. §10.14's "four product findings" were four
measurements of the harness's own artifact.

**I did not re-measure these numbers, and the reason is part of the record.** The parallel session had a full browser
gate in flight on the same machine, and a second browser run would have contaminated the measurement the numbers
depend on. They are recorded here as **measured by the parallel session, verified in the source at `ae372bf4`**.

**The gate with the fix has since landed, and the corpus is green.** The parallel session's own run of the full
browser gate after `ae372bf4` reports **439 of 439 checks passed**, and the corpus line reads:

```text
PASS live↔offline null test: same engine + events on both contexts — passed=67/67 — environment=measurable
(calibration fx:bitcrusher control=-334.4 dB needs ≤ -200 dB, live↔live=-334.4 dB needs ≤ -200 dB) — not measurable=0
```

**The red list is empty.** The four cases this report called a product finding are green; the 17 instrument cases
that failed on the CI runner are green on a measurable environment; and the verdict states in one line both what it
measured (67 cases) and whether it could measure at all (`environment=measurable`, both calibration axes at
−334.4 dB, `not measurable=0`). The corpus went from **4/67 red** to **67/67 passed** without a single product
change — because the thing that was wrong was the harness.

**What this does to §10.14, stated plainly.** §10.14 concluded that the four divergences were "an **invariant-3
product finding**", that "the export does not sound like the live branch", and that the suspect was the offline
parameter regime in `src/effects/registry.ts`. **All three are withdrawn.** Invariant 3 was never violated; the
divergence was the harness comparing two branches that were not in the same state; and the suspect was wrong. §10.14
stays as the record of what was believed on 2026-10-29, with this section as its correction — the same treatment
§10.14 gave its own earlier narrowing. Every instance of the withdrawn claim inside §10.14 is **marked in place** as
well, so the section cannot be read out of context as a live finding.

**The corpus knew.** This is the part worth keeping. The exclusions list in the very same file already said, in
words: _"Free-running LFO / phase state: the live instance is mid-modulation when the capture starts; the offline
instance starts from phase zero"_ (`:187-188`); svFilter's reason is _"the realtime instance is mid-glide at
capture"_; vinyl's is _"the vinyl instance is mid-modulation at capture"_. The harness **documented its own bias and
then charged that bias to the product** — it excluded the cases it could not explain and measured the ones it could,
wrongly. A corpus that names the artifact it cannot control is halfway to measuring it; the step it did not take was
to **make the two branches comparable** instead of **excluding the incomparable ones**.

**The exclusion list is wider than the count that was reported — and the count is now fixed.** The code's own
comment (`:66` in the tree at the time — the map has since been rewritten) and the parallel session's message both said "the nine `PARITY_FX_EXCLUSIONS`". The effect map at
`:173-214` holds **19** entries, and **twelve** of them state the lead's reason in their own words: phaser,
flanger, chorus, tremolo, autowah, ringMod, pitchShift, vinyl, reverb, svFilter, kaskada, wowFlutter. The rest are
a different class: seven "bar-scale transport state" cases. The instrument map (`:221-227`) adds `wavetable`
("free-running table scan phase") — a scan position that has advanced by the lead, i.e. a candidate **thirteenth**,
but that is **Hypothesized, not measured**; `granular`'s per-voice RNG ordering is a different class again. So the
blind spot the fix opens is at least **twelve** cases wide, not nine — and each of them has to be re-measured before
its exclusion can be lifted. **The parallel session took the correction and fixed the comment in `38ac7638`** ("the
exclusions comment said nine; the map holds nineteen"), with the same twelve named and the same split into
lead-class and transport-class. The one item that correction did not take is `wavetable`: the instrument map was not
re-counted, so the candidate thirteenth is still open.

**The twelve are being re-measured — and the projection was wrong by two, in the direction that matters.** This
section wrote that a green re-measurement would take the corpus from **67 to 79** cases (67 + 12). The measured
result is **77** (67 + 10): ten of the twelve phase exclusions are lifted and the corpus measures them now, but
**`phaser` and `vinyl` stay excluded** — and for a measured reason, not an excuse. Their realtime branch **does not
reproduce itself** (live↔live **−77.0 dB** and **−80.4 dB**), so a per-sample null has nothing reliable to compare
against: the two channels disagree with themselves before the engine is involved at all. Their reasons were
reformulated from the measurement. That is the correct outcome — a corpus that cannot measure a case must not
measure it — and it is also the reason the projection was wrong: "twelve phase exclusions" was a count of
_reasons_, not of _liftable exclusions_.

**And the corpus at 77 is NOT green — it is 1/77 red, and eight cases the machine could not judge.** The parallel
session's re-measurement on an **idle** machine
(`docs/audits/2026-10-29-browser-audit/browser-audit-remeasure.log`) reports `failed=1/77` — one instrument case
(`instrument:ladic`, the LADIČ worklet) — and, more interesting, **`not measurable=8`**: eight cases whose realtime
branch did not reproduce itself _on that machine_. The calibration agrees with the reading: `control = −334.4 dB`
(the offline branch is exact) while `live↔live = −207.8 dB` — the realtime branch reproducible only to −207.8 dB
there, against −334.4 dB in the earlier run.

**So the corpus's "not measurable" count is a property of the MACHINE, not of the product** — eight on the idle
desktop, four on the CI runner — and the verdict says so in the verdict itself. That is the §10.16.2 environment line
doing exactly its job: how many cases the machine could not judge moved with the machine's state, and the line named
that instead of letting the red count absorb it.

**The two that stay, and the one that was never in scope.** The remaining exclusions are the seven "bar-scale
transport state" cases (`beatMangler`, `stepGate`, `stutter`, `pump`, `reverseSwell`, `tapeStop`, `granularFreeze`)
and, in the instrument map, `granular` ("per-voice seeded grain RNG across live/offline start order") and
`wavetable` ("free-running table scan phase"). The last one is the candidate thirteenth this section named: a scan
position that has advanced by the lead is the lead's shape, so it may be measurable too — but it was not re-measured
and stays **Hypothesized, not measured**.

**The corpus now measures 77 cases, and the ten lifted ones measure at the offline determinism level.** The
parallel session's `e1cfe92b` re-measured every phase exclusion with the aligned branches (2026-10-29, floor
−40 dB): flanger −323.6 dB · chorus −324.6 · tremolo −319.9 · autowah −310.6 · ringMod −322.1 · pitchShift
−323.0 · reverb −323.4 · svFilter −325.1 · kaskada −316.7 · wowFlutter −325.1 — every one far below the floor, and
**live↔offline EQUALS live↔live**, so the realtime branch reproduces itself exactly. The ten exclusions are withdrawn
because their reasons described the harness's bias.

**And the two that stay now rest on a measured reason rather than a theory.** `phaser` and `vinyl` are excluded
because their realtime branch **does not reproduce itself**: live↔live **−77.0 dB** and **−80.4 dB**, the same order
as their live↔offline nulls (−168.6 dB and −87.3 dB), so the residual is the branch's own jitter — and a per-sample
null cannot judge a branch that does not reproduce itself. Their reasons were rewritten to say that, instead of
blaming a modulation phase that is no longer the cause. One detail is worth a second look when they are re-measured:
`phaser`'s live↔offline is **deeper** than its live↔live, which is what a **device-clock-following read position**
would produce — two live captures drift apart by the clock, while the offline render's clock is deterministic.
**Hypothesized, not measured.**

**And the corpus's membership is guarded — by a different gate than the one that does not.** The drift gate does not
pin the corpus's case count, and it should not: the count is free to grow. But the membership cannot move silently.
`tests/parity-obligation.test.ts` asserts **corpus ∪ exclusions === the full registry** (no drift by construction),
that every exclusion carries a specific non-empty reason, and that the corpus is registry-derived and non-empty. A
case cannot leave the corpus without either being measured or carrying a stated reason — a **stronger** contract than
a pinned number would be, because a pinned number would also forbid the corpus from growing.

**The reverb exclusion is demonstrably inaccurate now.** It was excluded with the reason "free-running 0.5 Hz
read-position modulator; device-clock jitter accumulates over the tail" — yet with the lead fixed, reverb measures
**−323.4 dB, bit-identical**, and its live↔live was −323 dB in one run: the jitter the exclusion predicted did not
materialise.

**Two instruments that came out of the correction.** First, the corpus now prints a **time-resolved divergence
profile** — 12 slices plus the onset (`divergenceProfile`, `:1050`; `profileText`, `:1177`) — because a single null
number cannot tell a startup transient from an accumulating state divergence from a discrete jump; it says **when**
the branches part. Second, the browser-gate annotation now **deduplicates** the FAIL lines the log prints twice,
reports the **count**, and drops the verbose per-case tail (`ci.yml`, `ae372bf4`): the corpus line alone was ~3.8 kB
of a 4096-byte budget, so the other failing checks were invisible — measured on a synthetic 14-check log, **0 of 13
named before, 14 of 14 after** (4023 → 1537 bytes). That is the rule §10.15 established for annotations, applied to
the corpus: **an annotation that names one thing hides the other twelve.**

**The transferable lesson.** A single number cannot tell you _what you measured_. The corpus compared two branches
that looked like the same thing — "the live render" and "the offline render" — and were not: one was half a second
warm, the other was cold. Every verdict it produced inherited that, including the four this report called a product
finding and pointed at a product file. The second lesson is about the report itself: this report stated an invariant-3
finding, named a suspect, and was wrong — and the only reason that is recoverable is that the claim carried its
evidence (a null in dB, a `live↔live` value, a control), so the next measurement could **falsify** it instead of
merely disagreeing with it.

#### 10.16.6 The corpus at 77 on the runner: 17 reds — not one defect, and not the engine's

**The current verdict, read from the CI run itself** (`b2a02569`, the browser-audio job's failure annotation — fetched
directly, not relayed):

> live↔offline null test: same engine + events on both contexts — **failed=17/77** —
> `environment=measurable` (calibration `fx:bitcrusher` control=−334.4 dB, live↔live=−334.4 dB, both ≤ −200 dB) —
> failing cases: `instrument:analog`, `808`, `texture`, `keys`, `organ`, `strings`, `bell`, `clav`, `acid`, `brass`,
> `fm`, `pluck`, `flute`, `logdrum`, `drumsynth`, `ladic`, `struna` —
> `not measurable=1` (the realtime branch did not reproduce itself): `instrument:reese`

Every one of the 17 is an `instrument:*` — **not a single FX**. The four "product findings" of §10.14 are gone from the
runner as well as from the desktop (§10.16.5), and the FX corpus is green on both platforms.

**What all 17 share is a rule, not a label.** The annotation's per-case rows carry a column the corpus only started
printing recently: `live2`, the **second** live capture measured against the same offline reference. In every row the
annotation details it **equals the first** (`live2=−32.9` beside `null=−32.9` for `808`; `live2=−31.7` beside
`null=−31.7` for `organ`), and in every row `liveRepeat` (live↔live) is **below the −40 dB floor** while `control` (the
same document rendered twice offline) is **clean**. So both live captures are dirty against the offline reference and they
agree with each other: the realtime branch reproduces itself and still renders differently. That is the one shape the new
rule keeps red, and it is attributable to the processing path — and since all 17 are red under that rule, all 17 must have
that shape.

**But they are not one defect — and the `frac=` column is what says so.** The corpus now prints a fractional-shift
scan: the null is re-measured with the capture moved by a fraction of a sample. A null that **collapses** under that move
is the same signal at a different **position**; a null that does not move is a difference in the **waveform**. Of the
eight cases the annotation details:

| case                 | null     | corr   | live↔live | live2    | control   | rms        | peak       | spec   | frac (shift → null)   | reading                       |
| -------------------- | -------- | ------ | --------- | -------- | --------- | ---------- | ---------- | ------ | --------------------- | ----------------------------- |
| `instrument:808`     | −32.9 dB | 0.9997 | −92.8 dB  | −32.9 dB | −89.5 dB  | **1.000×** | **1.000×** | 1.0000 | 0.2500 → −34.5 dB     | not a position                |
| `instrument:texture` | −28.9 dB | 0.9994 | −86.1 dB  | −28.9 dB | −304.9 dB | **1.000×** | 1.004×     | 1.0000 | 0.2500 → −30.3 dB     | not a position                |
| `instrument:analog`  | −13.7 dB | 0.9789 | −76.4 dB  | −13.7 dB | −80.0 dB  | **1.000×** | 0.965×     | 0.9999 | 0.2500 → −15.0 dB     | not a position, level moved   |
| `instrument:organ`   | −31.7 dB | 0.9997 | −323.5 dB | −31.7 dB | −323.6 dB | 0.999×     | 0.999×     | 1.0000 | **0.3125 → −38.3 dB** | partly a position             |
| `instrument:strings` | −26.9 dB | 0.9990 | −324.5 dB | −26.9 dB | −324.5 dB | **1.000×** | 1.013×     | 1.0000 | **0.3125 → −59.1 dB** | **a position**                |
| `instrument:clav`    | −22.5 dB | 0.9972 | −78.4 dB  | −22.5 dB | −77.8 dB  | **1.000×** | 1.006×     | 1.0000 | **0.3125 → −42.5 dB** | largely a position            |
| `instrument:bell`    | −24.5 dB | 0.9982 | −321.8 dB | −24.5 dB | −321.8 dB | **1.000×** | 0.992×     | 1.0000 | 0.0625 → −24.6 dB     | not a position                |
| `instrument:keys`    | −16.6 dB | 0.9909 | −277.8 dB | −16.6 dB | −278.5 dB | **0.929×** | **1.045×** | 1.0000 | **0.0000 → −16.6 dB** | **neither** — and level moved |

**Three signatures, not one:**

- **a position** — `strings` (the null collapses from −26.9 to **−59.1 dB** under a 0.3125-sample shift), `clav`
  (−42.5 dB), partly `organ` (−38.3 dB). The residual is the same signal at a different sub-sample position.
- **a waveform difference at identical level** — `808`, `texture`, `bell`: `rms` is **1.000×**, `spec` is **1.0000**,
  and a fractional shift moves the null by 1.3…1.6 dB. Not a level change, not a moved signal.
- **something else entirely** — `keys`: `rms` **0.929×**, `peak` **1.045×**, and a profile that is not flat at all
  (`[0.0, −17.9, −14.2, −16.4, −25.4, −26.7, −13.4, −7.7, −19.7, **+7.6**, −26.7, −18.2]` — one window is **positive**,
  i.e. the two branches differ by more than the reference's own energy there). That is the shape of an **event in the
  wrong window**, not of a filter state.

**A measurement lesson the corpus paid for in a CI run, not in the product.** Two FX cases (`fx:pitchShift`,
`fx:bassHarmonic`) were red on one run because the fractional-shift diagnostic cost ~21 million `Math.sin()` calls per
case and loaded the runner's realtime budget (heartbeat 215 ms against an expected 186 ms). The fix is in the source
(`:1111-1124`): the interpolator weights depend on the fraction only, so they are computed **once per parameter**
instead of once per tap per sample, and the scan runs **only for the cases that failed**. **A diagnostic that runs on
every case can kill the measurement it is attached to.**

**And the flat profile does not say what kind — but the correlation excludes one reading, and it cannot choose between
two others.** The parallel session read the flat ≈ −31.8 dB profile as "a constant gain of ~2.8 % (20·log10(1/0.028))".
**Their own correlation number excludes that reading**, once the metric's definition is read rather than its name:

- `compare()` (`src/testing/live-offline-parity.ts:697-711`) computes a **subtraction null** —
  `10·log10(Σ(reference − capture)² / Σreference²)`. So −31.8 dB means the residual energy is **6.6·10⁻⁴** of the
  reference energy.
- `correlationAt()` (`:714-729`) is **not** the Pearson coefficient its docstring claims: it computes
  `dot / √(Σa²·Σb²)` **without subtracting the means** — an uncentred cosine similarity.
- For a **pure gain** `b = g·a`, that expression is **exactly 1.0000** for any `g` (a scalar multiple does not change
  the angle). The measured **0.9997 excludes a pure gain**.
- For an **additive constant** `b = a + d`, it is `1/√(1 + 10^(null/10))` — and for null = −31.8 dB that is
  **0.99967**, the measured **0.9997** to four digits.

**This report's earlier text read that last bullet as a verdict, and that reading is withdrawn.** A small **timing**
difference predicts the same number to the same precision: for a perturbation of relative energy `k = 10^(null/10)` the
uncentred cosine is `1 − k/2` to second order, and `1/√(1+k)` is that same expansion. At k = 6.6·10⁻⁴ both are
**0.999670** — identical to four digits, and identical to the measured **0.9997**. **The correlation cannot tell an
additive constant from a moved signal.** Only the level can, and the two sizes of the corpus diverge there: at this null
size an additive constant leaves the **rms** ratio at ≈ 1.000× (√(1+6.6·10⁻⁴)), so the rms ratio is blind — but it shifts
the **peak** by `d = rms·√k` — 0.5–1.5 % for any ordinary rms/peak — while a moved signal leaves the peak where it is.
**The reading the correlation could not give is now in the annotation itself — and it splits the set.** The corpus prints
`rms=` (the raw level ratio), `peak=`, `spec=` (the magnitude-spectrum cosine) and `frac=` (the fractional-shift scan) per
case, and the `b2a02569` annotation carries all four for eight of the seventeen:

- **The additive reading is excluded for the cases that are not a position.** For `808`, `texture` and `bell`, `rms` is
  **1.000×** and `spec` is **1.0000** — level and magnitude spectrum identical — and a fractional shift moves the null by
  1.3…1.6 dB. An additive constant big enough for a −32.9 dB null leaves the rms ratio at √(1+6.6·10⁻⁴) = **1.000×**, so
  the rms reading cannot see it; but it moves the **peak** by `d = rms·√k`, and the measured peaks are **1.000×, 1.004×,
  0.992×**. The parallel session measured the **mean difference as zero** on their WSL Linux, so there is no DC component
  either. What is left for these three is a **waveform difference at identical level and identical spectrum** — and its
  shape is not named yet.
- **For `strings` and `clav` the residual IS a position**: the fractional scan drops the null from −26.9 to **−59.1 dB**
  and from −22.5 to **−42.5 dB**.
- **For `keys` neither holds**: the level itself moved (`rms` **0.929×**, `peak` **1.045×**) and one profile window is
  **positive**.

**And the parallel session's own generalisation is too broad.** Their measurement — `frac=0.25` improved `808` only from
−32.9 to −34.5 dB — is right for `808` and **wrong as a statement about the set**: the same column collapses the null by
32 dB for `strings`. A single case cannot characterise seventeen, and the annotation's own rows say so.

**Two corrections this section makes to the report's own earlier text.** First, §10.14's Refutation 1 says
"`correlationAt` is a true Pearson coefficient" — it is **not**: the implementation does not center, and the source's
own docstring is wrong about its own metric. The arithmetic in that refutation (corr ≈ 1 − e²/2) is the **same second-order
expansion** the additive prediction uses, so it fits the measured table without naming a mechanism either — it was fitted
against a metric whose name was wrong, and it would have been equally blind had the metric's name been right. Second, the
consequence matters for readers: a **true** Pearson is invariant to an additive offset, and
this metric is not. So `corr = 0.9997` must not be read as "the same signal" — it says "the same signal plus a small
**perturbation**", and this section's own earlier wording ("plus a small constant") named one of the two candidates it
cannot separate from the other. That is exactly the distinction the runner's 17 cases turn on, and it is invisible unless
the metric's definition is read instead of its name.

**What stays open, and it is not a small thing.** The mechanism behind the seventeen was the harness's, and it is fixed and
measured. **What is now open is the decision itself — and it may be moot.** Whether the corpus is green on the Linux runner after
`c0400b33` is the next CI run's answer, and it is the only question left in this section. If it is green, §10.14's proposal to make
the null corpus non-blocking in CI is **moot**; if anything stays red, it will be a real live↔offline difference — which is
exactly what the corpus should be doing. **And a decision must not be taken on the strength of a label: neither the old one, nor
this one.**

**And the desktop's reds move with the machine's state — while the runner's do not.** The tracked idle re-measurement
(`docs/audits/2026-10-29-browser-audit/browser-audit-remeasure.log:445`, commit `5bb0af20`) reports **`failed=1/77`**
plus eight cases the machine could not judge; the parallel session's later local run reports the corpus **green at
77/77**. On the runner the same corpus is **17/77 red** with one case unjudgeable. So the desktop's reds are a property
of that machine at that moment, and the runner's are not — and the one case whose row was readable in full on the desktop,
`instrument:ladic`, is **also on the runner's red list**, which makes it the most interesting one of the seventeen.

**LADIČ is a whole-sample position difference, and that is a third signature again.** LADIČ is the 6-operator FM flagship
(`src/instruments/registry.ts:6925`, ADR 0055). Its desktop row says:

| reading                  | value               | what it settles                                                                           |
| ------------------------ | ------------------- | ----------------------------------------------------------------------------------------- |
| `rms`                    | **1.000×**          | the **level** is identical                                                                |
| `livePeak` / `refPeak`   | **0.1185 / 0.1185** | the peak is identical, to the last digit                                                  |
| `spectrum`               | **0.9999**          | the magnitude spectrum is identical (offline control: 1.0000)                             |
| `null`                   | −9.8 dB             | …but the **waveform** is not — against a floor of −40 dB (`:99`)                          |
| `offset`                 | **−336 samples**    | the best alignment needs 336 samples — **7.62 ms** at 44 100 Hz (`:65`)                   |
| `repeatOffset`           | **0 samples**       | the live branch reproduces **itself** at zero offset                                      |
| `segHead` / `segTail`    | −4.4 / −15.3 dB     | the difference is concentrated at the **head** of the window                              |
| `profile`                | 0.0 → −18.1 dB      | nothing shared in the first window, saturating afterwards                                 |
| `corr`                   | 0.9471              | high but not unity — the corpus's own marker for "the same path, a moved sample" (`:106`) |
| `control` / `liveRepeat` | −319.2 / −319.2 dB  | the offline render is deterministic and the live branch reproduces itself                 |

The level readings are **position-independent** — `stats()` (`:1385-1394`) measures the raw buffers, before any alignment. And at
this null size the level reading is **decisive**: an additive constant big enough to produce a −9.8 dB null would raise the rms
ratio to √(1 + 10^(−0.98)) = **1.051×**. The measured ratio is **1.000×**. So the additive explanation is excluded by arithmetic
rather than by interpretation — a different situation from the runner's cases, where the same measurement at −31.8 dB would read
√(1 + 6.6·10⁻⁴) = **1.000×**, _indistinguishable from LADIČ's_ at three decimals. **The rms ratio is blind at the runner's null
size and decisive at LADIČ's; the peak ratio is decisive at both.** An additive constant shifts the peak by `d = rms·√k` —
0.5–1.5 % at the runner's null size, where a moved signal leaves the peak where it is. The runner's `rms=` and `peak=` have now
arrived (§10.16.6 above): the rms reads "1.000×" and means nothing there, and the peak is what decides the question the
correlation could not.

**Inferred:** LADIČ is the same sound, at the same level, with the same spectrum, **not at the same sample position** — and the
difference sits at the head of the window. The corpus's own docstrings name exactly these two shapes: `divergenceProfile`
(`:1044-1048`) calls a profile "already dirty in the FIRST window" a **startup transient**; `segmentNulls` (`:952-957`) draws the
line this case falls on: "a difference confined to the head is a startup transient" against "a difference spread over the whole
window" — a processing-path divergence. LADIČ's difference **is confined to the head** (−4.4 dB head against −15.3 dB tail); most
of the runner's cases are spread across the whole window (flat profiles ≈ −22…−36 dB; `keys` is the exception). The profile says
the same thing from the other side: LADIČ's branches **converge** after the first window (0.0 → −18.1 dB, saturating), the
runner's **stay apart**.

**Not verified:** what produces the 7.6 ms. The corpus carries a fractional-shift scan — a diagnostic that separates a
sub-sample position from a different processing path, and prints `frac=` in the corpus summary (`:1087-1092`, `:1632`;
committed in `8b3b47cd`) — but the idle log **predates it**, and LADIČ is not among the eight cases the `b2a02569` annotation
details, so that reading still does not exist for this case. The
alignment of −336 samples is **inside** the 512-sample tolerance (`:113-118`), so the quantum-retry path (`:739-758`) never fired
for this case — and 336 samples is **2.625 render quanta** of 128 frames, not a whole one. One more reading the verdict depends on
is **not in the log**: the escape hatch `phaseInsensitiveParityAgrees` (`:647`) reads the **windowed** rms ratio, which the
failing branch of the detail line does not print — it prints the raw one as `rms=` and the windowed one as `RMS=`, and this row
carries only `rms=1.000×`. A reader cannot tell the two apart from the annotation.

**And the scoping that matters most: it looked like Linux, but it was a RACE.** §10.14 called these failures "platform realtime
behaviour on that runner"; this report's earlier text called them "present on the runner and absent on the desktop", and then, on
the strength of the parallel session's WSL reproduction of identical numbers (−32.9 / −89.5 / −13.7 on both Linux machines),
called it "a deterministic **Linux** divergence". **That reading was wrong, and this paragraph is withdrawn.** Identical numbers
at one moment do not prove determinism when the mechanism turns out to be a race — and the same case on identical code has been
measured at **−323 dB on one run and −33 dB on the next**. The platform did not decide the outcome; it changed the **timing** of
a race, and a race that resolves one way on an idle desktop resolves the other way on a loaded runner. **What was platform-shaped
was the symptom, not the cause.**

**That made it the smallest invariant-3 candidate this audit had ever held** — invariant 3 holds on Windows and does not hold on
Linux, for 17 instruments, reproducibly, with the offline branch proven exact on both platforms and the realtime branch proven to
reproduce itself. **It was not a candidate. It was the harness again, and the paragraph above is withdrawn** — see below.

**And the third harness candidate: a law, measured on Windows, that would make the seventeen a harness artefact again.** The
parallel session found a **law** on Windows: the live and offline branches are **bit-identical only** when the offline history
`H` equals `requestedStartFrame − settleFrames − 128`, where `settleFrames` is `ctx.currentFrame` **at the moment the realtime
engine's final processors are constructed**. Measured on Windows: `H = 22144` → **−300.00 dB** (bit-identical), `corr = 1.0000`.

That is the shape of the capture-lead defect **one level deeper**: the harness **hardcodes** `H = 22144` (0.5 s at 44.1 kHz), while
the live branch's real history depends on **when its engine was built**. If the law holds on Linux as well, then the seventeen
Linux reds are the **same harness bias for the third time** — not a product divergence, and not an invariant-3 finding — and the fix
is already named: `captureLive` must **return its history** and `renderOffline` must **take it as a parameter**, instead of the
harness assuming a constant.

**And it was confirmed, on both platforms, and fixed — twice, because the first fix moved the symptom, not the race.**
`c0400b33` ("the offline branch renders the realtime branch's MEASURED history") landed the first half: `captureLive` measures the
realtime branch's history and returns it, `renderOffline` takes it as a parameter for the render length, the event offset and the
trim, and the second realtime capture gets **its own** offline reference when its history differs.

**Then the cause itself.** `db28fffa` ("the realtime branch builds its engine on a frozen clock") — the realtime branch was
building its engine on a **running** context, so its processors entered the audio thread at a frame that was a **race** between
the main thread and the audio thread: whichever finished first decided whether the processors processed from quantum `N` or
`N+1`. **A race cannot be matched by a number** — no history value can reproduce "whichever thread won". The fix is to remove the
race: the context is **suspended before anything is built on it** (measured: a fresh context reports `currentTime` 0 and keeps
reporting 0 across a suspend), the whole graph is built at that frozen clock, and the clock starts only once the graph is
complete. The engine's processors then enter at frame 0, so the realtime branch's history **is** the capture's start frame and the
offline branch renders exactly that much. **Both branches are now built at clock 0 — which is what the harness's own comment
claimed from the beginning.** The comment was aspirational; it is now true.

Measured on the **Linux runner** (the CI environment):

| case                | before   | after                         |
| ------------------- | -------- | ----------------------------- |
| `instrument:808`    | −32.9 dB | **−336.4 dB** (bit-identical) |
| `instrument:organ`  | −31.7 dB | **−323.6 dB** (bit-identical) |
| `instrument:analog` | −13.7 dB | **−78.2 dB**                  |
| `instrument:bell`   | −24.5 dB | **−321.8 dB** (bit-identical) |

and on the desktop: 808 −94.5 dB, organ −323.6 dB, analog −78.6 dB, bell −321.8 dB — **all green**. What remains is each
instrument's own offline determinism (`808`: control −89 dB, live↔live −89 dB).

**Verified, not hypothesized** — and the seventeen Linux reds were the harness's, for the third time, exactly as §10.16.5's four
FX divergences had been. **The invariant-3 candidate is withdrawn: it never existed.** The rule that produced it was this audit's own
recurring one, now for the fourth time: **a harness that compares two branches must never assume that their histories match — it has
to be told.** And the deeper form of the same rule, which the race taught: **a measurement whose outcome depends on a race is not
a measurement — and "identical on two machines" does not prove otherwise.**

**Where the engine should hop — the precedent, and the anchor.** `docs/CURRENT-STATE.md` records the fix for the FX side: the
**offline** chain is built at the **render origin**, so its ramps are still in flight when the first event lands, and the fix was to
make the offline write happen immediately ("smooth"). The instrument registry has no equivalent: the state is still built at
**construction** — `src/instruments/registry.ts:2015`, `const now = ctx.currentTime` in the texture factory. The capture-lead fix
(`ae372bf4`) aligned the **history the worklets had processed**; it did not align the **age of the Web Audio node construction**,
which differs between a live context that has been running and an offline context that starts at zero — and differs again by
platform in how the capture start is quantised. **Hypothesized, not measured** — but it is the one place where the evidence and the
precedent point at the same line of code.

**And that hypothesis was not the cause either.** The cause was the **race** above: the realtime branch's processors entered the
audio thread at a frame that a main-thread/audio-thread race decided, and the offline branch could not reproduce a race with a
number. `src/instruments/registry.ts:2015` may still be worth a look for other reasons, but it is **not** what made seventeen
instruments red on Linux, and this paragraph is corrected accordingly: **the anchor was right about the kind of thing (a
construction-time state) and wrong about the line.**

**And the gate itself changed, because the verdict was depending on which capture was taken.** `b2a02569` replaced the old
exception with `realtimeBranchOwnsTheNull` (`:1525`). There are two ways a realtime branch fails to reproduce itself, and the
old rule only saw one: (a) its two captures disagree with each other, and (b) **one capture matches the offline reference and the
other does not**. Case (b) made the verdict depend on which capture happened to be taken: measured on one machine, the same
instrument case read live↔offline **−323.6 dB** on one run and **−31.7 dB** on the next, on the same code, and the rule reported the
run where the odd capture came first as an engine divergence — although the engine had produced two different answers itself. Now a
branch that does not repeat is **"don't measure"**, and it is **named**; red remains only for what is reproducible — both captures
dirty against offline and consistent with each other. The seventeen stay red under the new rule, and now they are red **on
purpose** rather than by an accident of ordering.

**And the seventeen had no defect at all — and the corpus is green on the runner.** Measured on the Linux runners after `db28fffa`:
`instrument:808` **−336.4 dB**, `instrument:organ` **−323.6 dB**, `instrument:bell` **−321.8 dB** — all bit-identical — and
`instrument:analog` **−78.2 dB**, which is the instrument's own offline determinism, not a divergence. On the desktop: −94.5,
−323.6, −321.8, −78.6 dB, all green.

The decision §10.14 proposed — make the null corpus non-blocking in CI — was built on the reading that these failures were
"platform noise", and the reading was wrong in the direction that matters: they were neither noise nor product, they were the
harness's own bias — measured, fixed, and measured again. **With the corpus green on the runner, that proposal is moot: there is
nothing left to excuse.** The blocking policy and the "not measurable" rule are unchanged, no corpus member was added or removed,
and no threshold moved — the fix was entirely inside `src/testing/live-offline-parity.ts`.

**What is left open in this section is a question about the corpus, not about the product:** whether the corpus should still be
blocking now that it measures the thing it claims to measure.

#### 10.16.7 Five red specs, five different defects — and one gate that measured the wrong thing

The parallel session measured the full vitest run on HEAD and handed over five red specs. All five are fixed
(`54b4143f`), and each had a **different** cause — the §10.16.3 rule one level deeper: **a red spec is a question,
not a verdict.**

| spec                         | cause                                                                                                                                                                                                            | fix                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `mcp-refusal-taxonomy`       | `kyx_analyze` returned `{ text, mutated: false, data }` with **no disposition** — a result that changed no document and says nothing is an untyped refusal (audit F-05): the agent cannot tell it from a success | it declares `stage: "runtime"`, the disposition its sibling `kyx_render_summary` declares                                 |
| `mcp-receipt-census`         | a new tool must be **classified before it can be trusted**; `kyx_analyze` and `kyx_verify_edit` had no census entry                                                                                              | `kyx_analyze` is a READ member, `kyx_verify_edit` an EXTERNAL one (it renders the same window twice and compares the PCM) |
| `mcp-onboarding`             | `kyx_analyze` was in **no agent-facing text** — the ROT GUARD working as designed                                                                                                                                | the playbook had 13 characters of headroom (7987 of 8000), so the manual was tightened instead of the limit raised        |
| `audit-observation-contract` | **a measurement defect, not a gap** — see below                                                                                                                                                                  | the instrument now counts the receipt attachment                                                                          |
| `arrangement-dom-census`     | the per-clip DOM budget was **one element** stale — CF-10's record-bar toggle: ONE button, rendered once, so the per-clip cost did not move at all                                                               | the budget is re-pinned to the measured 53 260 with the reason in the header                                              |

**The fourth one is the one worth keeping.** The observation instrument scans the **source** for a literal
`outputSchema`. But `src/mcp/tools.ts` attaches the receipt envelope to a set of tools in a loop over
`RECEIPT_SCHEMAS` — AFTER the literal catalog, the same way it augments every input schema with
`requestId`/`agentId`/`dryRun`. So fourteen tools looked schema-less to a scanner while the **shipped** surface
declares them. Measured on that tree:

| where                                                                        | tools with an outputSchema |
| ---------------------------------------------------------------------------- | -------------------------- |
| the source literal (what the instrument read)                                | **29 of 44**               |
| the runtime catalog (`MCP_TOOLS` after the attachment loop)                  | **43 of 44**               |
| the generated mirror (`desktop/mcp-tool-defs.cjs`, which imports the module) | **43 of 44**               |

The instrument already knew about the OTHER runtime augmentation — it has an `AUGMENTED` list for
`requestId`/`agentId`/`dryRun` — so this was the same class of fact, simply unrecorded. The gate's own docstring
says it measures _"the tools that ship WITHOUT an outputSchema"_, and an agent's shipped surface is the catalog, not
the literal. Fixed: the instrument now counts the receipt attachment, the ratchet's baseline collapses from fourteen
entries to the **one real gap** (`kyx_separate`), and the baseline gets **safer** — a receipt tool that LOSES its
schema now shows up as a grown gap, where the old list would have named it as known and stayed silent.

**The family is the same one this section has been about.** The capture lead (§10.16.5) was a harness that compared
two things that looked alike and were not; this is a gate that measured the **source** while claiming to measure the
**surface**. Both produced a number, and both numbers were wrong in the same direction — they made the project look
worse than it is, and they hid a real regression in the place it mattered. The transferable rule: **before trusting a
gate's count, ask what it read** — and then read the same thing the gate read, from the other end.

#### 10.16.8 The sixth red — the ratchet that the wave which shipped it broke

**The palette's own count pin was the casualty of the wave that grew the palette.** CF-12 (`f9dbb25a`) added two palette
routes — `extra:timepitch` and `extra:spectral` — moving the count from **75** to **77**, and the pin in
`tests/ui/palette-search-coverage.test.ts` stayed at 75. The committed tree has therefore been red on the unit-test job
since that commit: _"expected 77 to be 75"_. Re-pinned to **77** in `66d48a41`, which is the committed tree's measured
count — confirmed by the CI failure text and by running the spec, not by counting in one's head.

**Why this one belongs in an audit about CI.** §9.2.2 shipped the palette **with a ratchet**: a spec that pins the action
count precisely so the palette cannot grow quietly. Then a later wave grew it quietly, and the ratchet — which is a
**number** — did not fail loudly; it failed as `"expected 77 to be 75"`, one line inside a job that a reader skims. The
gate worked. **What did not work was the moment between shipping the count and re-pinning it**, and that moment was this
audit's own §9.2.2 number going stale while the audit kept quoting it.

And the shape is §10.16.7's fourth one again: a gate that measures the **committed** count, and a change that moves the
count **in the working tree** first. The rule that would have caught it before CI: **a number that appears in a spec, in a
report and in a payload is one number, and it has three homes — change it in all three or in none.**

**Provenance of the re-pin, recorded because the shared worktree decided it.** The commit that re-pinned the palette from 75 to
77 (`66d48a41`) carried **more than the one line this session meant to commit**: the parallel session's staged edit of the same
file — its pin change and the comment above it — was in the tree and went into that commit under this session's authorship.
**The content was theirs; the authorship is mine**, and the audit trail cannot tell the difference, because every session in this
repo commits under the same git identity. It is recorded here, in a file this session owns, because the commit message is not a
durable place for it. The mirror case happened in the same week in the other direction: the parallel session's commits carried
this session's paths, and both directions were reported rather than rewritten (§10.16.7's `mcp-onboarding` fix is the same
story from the other side). The rule holds: **stage only your own paths, look at what your commit actually contains before you
push it, and never let the other session's work be silently renamed.**

#### 10.16.9 The realtime budget asked the device a question the device could not answer

**The red.** The parallel session's browser job was green on the parity corpus and **red** on the realtime budget:

```text
FAIL rt budget: 12 tracks × 4 effects realtime — OVER BUDGET — blocks=960 xruns=7
heartbeat avg=184.39ms max=188.30ms (expected≈185.76ms, 0.99×) quantum=2.902ms
```

**What the verdict could not say.** The heartbeat arrived on its expected cadence — **0.99×** against a 1.5× limit — so the gate
did **not** trip on the heartbeat. It tripped on `xruns === 0`: seven quanta the device dropped. The parallel session read that
as "the 2-vCPU runner cannot draw 48 effects into a 2.902 ms quantum". **This session's reading was "the guard that was supposed
to demote this gate cannot see the signal this gate trips on."** Both readings are compatible with the same line of output,
which is exactly why the line was not yet a finding.

**Defect 1 — the guard and the gate measure different subsystems.** §10.16.2 fixed the machine test that decides
`machineLoaded`: it spins the **main thread** and asks whether the harness thread can time anything
(`src/browser-checks.ts:4830-4834`). The signal that trips this gate lives on the **audio thread** — the device clock advancing
by more than one render quantum (`src/audio-worklets/rt-monitor-processor.js:44-47`: `advanced > 128` → `droppedQuanta`).
Two different subsystems, so the guard cannot see what it is guarding. **The CI run says both things at once**:
`environment=measurable` (a main-thread measurement) and `xruns=7` (an audio-thread measurement), in the same run. §10.16.2's
rule — _the environment must explain the gate, never fail it_ — was therefore **not in force for this check**: the check had
a guard, and the guard was blind.

**Defect 2 — the probe's reset is half-effective.** `resetRtLoad()` (`src/audio-engine/meteringRig.ts:384-386` →
`src/audio-worklets/rt-monitor-node.ts:111-123`) zeroes the **host-side mirror** of the snapshot, but the **processor's** own
counters (`src/audio-worklets/rt-monitor-processor.js:32-33`) are never reset: `this.blocks` and `this.droppedQuanta` count from
the moment the processor was constructed, and every report carries the cumulative value. So the heartbeat jitter **was** scoped
to the measurement window and `blocks`/`xruns` **were not**: `blocks=960` was the count since the context was created — the
graph's construction included — not the count inside the window. **A number that does not name its window cannot be compared
with another number**, and this one was being compared with a desktop run.

**The fix — the check measures its own device floor, with the same probe, on the same device.** `auditRtBudget`
(`src/browser-checks.ts:498-642`) now measures a **floor** before the graph: the same context, the same rt-monitor, the same
window — **one track and no effects** (`:525-529`). The floor is read **twice** (cold, then warm on the same graph, `:564-565`),
because the first window can carry the context's cold start; the device's ability is the **better** of the two readings. The
verdict then follows the device:

- **floor clean** → the device can hold a graph → the graph's xrun count is the graph's cost → the gate stays **strict**,
  `xruns === 0 && jitterRatio < RT_JITTER_LIMIT` (`:611`), exactly as before;
- **floor dirty** → this device cannot hold **any** graph, so the absolute criterion cannot discriminate between "the machine"
  and "the graph" → the verdict is **informational**, with the numbers attached (`:616-628`).

That is §10.16.2's rule applied to the subsystem it was missing, and it is the same shape the **offline** budget already uses
(`auditDenseRender`, `:654-734`: "the budget is RELATIVE to the same-machine baseline"). The realtime budget was the sibling
gate that never got the relative form. The jitter criterion got the same treatment: a device that cannot deliver a heartbeat on
time even on an empty graph cannot be judged by heartbeat jitter (`:623-628`).

**Every count is now a delta, and the window is named.** The processor's counters are cumulative, so each number is the
difference between two reads (`:570-578`), and `blocks` is the count **inside the window** rather than since the context was
created. The message also splits the graph phase into **build** and **steady**, because "48 effects do not run in realtime" and
"constructing 48 effects stalls the audio thread" are different findings with different fixes.

**Observed on this machine, on the instrumented check** — the same tree, two independent runs:

```text
PASS rt budget: 12 tracks × 4 effects realtime — blocks=832 xruns=0 heartbeat avg=216.15ms
max=269.70ms (expected≈170.67ms, 1.27×) quantum=2.667ms · device floor xruns=0 jitter=1.00×
(1 track, no effects; cold 0/1.00× / warm 0/1.00×) · graph build=0 steady=0

PASS rt budget: 12 tracks × 4 effects realtime — blocks=704 xruns=0 heartbeat avg=252.68ms
max=367.40ms (expected≈170.67ms, 1.48×) quantum=2.667ms · device floor xruns=0 jitter=1.00×
(1 track, no effects; cold 0/1.00× / warm 0/1.00×) · graph build=0 steady=0
```

(The first is the parallel session's own desktop run, committed at `74a1d8dd`; the second is this session's, on a quieter box —
`calib=12.0ms` against `14.1ms`.)

**What the floor changes about the number.** The floor's heartbeat arrives at **exactly 1.00×** its expected cadence — cold and
warm, on the same context, moments before the graph plays. The device is therefore **not** late: it delivers a heartbeat on time
when there is nothing to play, so the graph's **1.27× / 1.48×** is **the graph's** cost, measured against the same device. That
is the discrimination the parallel session asked for, and it does not need a theory of the runner: the two numbers come from the
same context, the same probe, the same minute.

**And the graph is at the edge of the budget.** The jitter limit is **1.5×** and the graph measured **1.48×** on an idle desktop
— **one hundredth of headroom**. The realtime path for 12 tracks × 4 effects is not comfortably inside its budget; it is at the
boundary, which is why a 2-vCPU runner trips it and a desktop does not. **The xrun count was never the interesting number**: the
device did not drop a single quantum in any desktop run, because at 48 kHz on a healthy device the graph _almost_ holds.

**The same criterion is not reproducible run to run.** Three runs of the same tree on this machine gave **1.05×**, **1.27×** and
**1.48×**. A criterion whose verdict flips with the machine's momentary state is not a measurement — that is §10.16.2's own
sentence, and it applies to the jitter limit with the same force it applied to the millisecond floor. The floor now supplies the
reference that the absolute limit lacks.

**A second finding fell out of the same runs, and it is not this session's to own: three offline budgets are red on the current
tree, on an idle desktop, with the render path unchanged.** The parallel session's committed run and this session's two runs all
report the same three failures —

| check                   | 2026-10-29 idle run (`82f59555`, 77/77 corpus, 439/439) | current tree (loaded)                               | verdict now       |
| ----------------------- | ------------------------------------------------------- | --------------------------------------------------- | ----------------- |
| `perf: techno — 8-bar`  | ✅ 9015 ms                                              | ❌ 13839 / 13641 / 21964 ms                         | ❌ (budget 13271) |
| `perf: 8-bar average`   | ✅ avg 4708 ms (aggregate 0.29×)                        | ❌ avg 8624 / 8346 / 9118 ms                        | ❌ (limit 7000)   |
| `perf: 8×4 vs baseline` | ✅ 10697 ms vs 2284 ms baseline (**4.68× baseline**)    | ❌ 17944 / 16624 / 17996 ms (6.11× / 6.49× / 6.02×) | ❌ (limit ≈ 5.0×) |

**— IN PLACE (2026-10-30, evening): the first column of this table was untraceable and is replaced with a traceable one.** The
previous column read _"2026-10-29 tree: techno 10509 ms, avg 5197 ms, 8×4 13915 ms (5.45×)"_ — and **those three numbers exist in
no tracked artifact**: a search of every `*.log` under `docs/audits/` finds `10509`, `5197` and `13915` **nowhere**. They entered
this report from a session message whose run was never committed to a log, and they are **withdrawn**. The replacement column is
the **same 77-case corpus** on the **same parity-obligation line** (`fx=48+9 instruments=29+2`), read from the tracked idle log
`browser-audit-head-82f59555.log` (commit `82f59555`, 2026-10-29 10:31, **439/439 green**), and it is a **stronger** anchor than the
one it replaces: it shows the tree **green with the corpus at 77**, which is precisely the fact that makes the corpus size
unusable as an explanation (§ below). The "current tree" column was already traceable — `17944 / 6.11×` to
`browser-audit-3328668c-plus-rt-floor-loaded.log`, `16624 / 6.49×` to `rt-floor-runB-quiet.log`, `17996 / 6.02×` to
`rt-floor-runA-contended.log`. **The rule this adds: a number in a report is a claim about an artifact; if no artifact carries
it, the number is a rumour — and "I searched and found nothing" is a measurement, so the search is recorded here rather than
quietly replaced.**

**IN PLACE (2026-10-30, later the same day): the absolute form is still red, and the RELATIVE form in the same run is green.**
The parallel session re-calibrated the absolute budget to **9000 ms** from a measured band of **4579–6379 ms** (`4bc8a224`), and
this session's three later runs on the same desktop read the absolute average at **16544 / 19032 / 19049 ms** — **2.1× over the
budget, three times out of three** — while the **relative** sibling (`auditDenseRender`, "budget is RELATIVE to the same-machine
baseline") read **4.11× / 4.78× / 4.78×** against its **7.5×** limit and was **green in all three runs, on the same tree, in the
same minute**:

| run (this session, same tree) | `calib` | absolute 8-bar average | verdict | single-track baseline | 8×4 render | **ratio** | verdict |
| ----------------------------- | ------- | ---------------------- | ------- | --------------------- | ---------- | --------- | ------- |
| run A (corpus in front)       | 15.3 ms | 16544 ms               | ❌      | 8568 ms               | 35175 ms   | **4.11×** | ✅      |
| run B (contended box)         | 13.8 ms | 19032 ms               | ❌      | 9133 ms               | 43651 ms   | **4.78×** | ✅      |
| run C ("quiet" box)           | 17.3 ms | 19049 ms               | ❌      | 8267 ms               | 39556 ms   | **4.78×** | ✅      |

**This is the argument for the relative form, measured on one tree rather than argued.** The absolute threshold of **9000 ms**
sits **INSIDE** the day's observed spread (the parallel session's idle run read **4708 ms**; these three read **16544–19049 ms**
— a **4.05×** spread), so it is a **coin flip** by construction, exactly as the gate's own comment says of a budget inside the band.
The relative threshold of **7.5×** sits **ABOVE** the whole observed band of the ratio (**4.11–4.78×**), so it follows the code
instead of the weather. **And the guard cannot close the gap, because the guard's own proxy does not move with the thing it
guards**: `calib` moved only **12.0 → 17.3 ms** (1.44×) while the average moved **4.05×** — and within these three runs the two
are not even correlated (the **lowest** `calib` of the three, 13.8 ms, produced the **highest** average). **A stricter guard
would not have demoted these three runs; a looser budget would only have moved the coin flip.** The fix is the **form**: the
per-template perf gate should judge a heavy render against a **light baseline measured in the same process, adjacent in time** —
the shape `auditDenseRender` already has and the shape the realtime gate now has after §10.16.11's adjacent floor.
**The aggregate wall-clock-to-audio ratio that the check already prints is NOT that shape**: it is proportional to the millisecond
average, so it moved with it — **0.29× / 0.53× / 1.02× / 1.18× / 1.18×** across the same five runs — and a criterion that moves
4× with the machine is not machine-independent either.

**— IN PLACE (2026-10-30, evening, second correction): THIS SESSION'S OWN RECOMMENDATION IS WITHDRAWN, AND THE EXPERIMENT
THAT REFUTES IT IS IN THE REPO.** This session recommended moving the perf section to its own page/process, so that its verdict
could not be derived from whatever ran before it. **The parallel session ran exactly that experiment** — the perf block pulled
out into its own clean page, called separately, in the **same run on the same machine** — and the result refutes the
recommendation rather than confirming it (`docs/audits/2026-10-29-browser-audit/perf-isolation-experiment.log`, with the
experiment itself as `perf-isolation-experiment.patch`, commit `9f0f6c1c`):

| perf measurement, same run, same machine | avg         | worst    | aggregate      |
| ---------------------------------------- | ----------- | -------- | -------------- |
| **in-page**, after the corpus            | **5137 ms** | 11115 ms | 0.32× realtime |
| **isolated**, on a clean page            | **6379 ms** | 14769 ms | 0.39× realtime |

**The isolated page was SLOWER.** So the mechanism this report described — _"the verdict moved because the run got heavier"_, in
the form _"the perf section inherits the weight of what ran before it"_ — **does not hold in that form**, and moving the section
would not stabilise the gate: it would spend the cold JIT of a fresh page and **narrow** the margin, not widen it.

**And the same artifact refutes the other candidate mechanism too, which is the one this report adopted from the parallel
session.** The in-page measurement above is **avg 5137 ms — green against the 7000 ms limit — on the current tree, with the
third offline render per case still in place.** If the extra render had been what made the run heavier, the in-page perf
section would be red; it is not. **What actually varies is run-to-run noise on one tree**: the parallel session's four runs read
**5137 / 6025 / 6321 / 6379 ms** against the limit of 7000, and this session's three runs read **16544 / 19032 / 19049 ms** on the
same tree — the same measure, spread over roughly **3.7×** on one machine.

**So the conclusion that survives is the one this report already reached, for a sharper reason.** The absolute perf budget is a
**machine-state** measurement, not a code measurement: the tree can be green or red at the same commit, and the tree's own
relative form (`auditDenseRender`) stayed green in every one of this session's runs (**4.11× / 4.78× / 4.78×** against a **7.5×**
limit — verified in the committed logs, the measured ratio, not the budget) while the absolute one sat **2.1× over** its budget in
all three. **The repo already contains the working example of the fix, in the same file family.** The FXEQ morph gate
(`tests/fxeq-performance-gates.test.ts`, `eb2c3d50`) is a **ratio** measured across **three machines and three load shapes** —
Windows idle **1.59×**, Linux 16 vCPU **1.58×**, Linux pinned to 1 CPU with three spinners **1.61×**, and Linux pinned to 1 CPU
with spinners that start **between** the idle and the morph phase **1.66×** — and it holds. Its old **2.4×** budget sat **inside**
that healthy band, so a healthy run could fail it; the peer moved it to **3.0×**, which still catches the pathology the gate
exists for (the old per-block `applyAllParams` path measured ~2.4× at half today's schema size and exceeds 4× today). **The FXEQ
core also changed after the band was calibrated** (`7371bb3f`), so the old band was measured against a different core. **One
gate in this repo measures a ratio across machines and is stable; the other measures milliseconds on one machine and swings
3.7×.** That is not a threshold problem — it is the difference between the two forms.

**What this leaves for the owner, stated as a number and as a decision.** The perf budget's own comment still carries the
2026-09 baseline _"idle M1-class laptop: avg ~2 s"_, which is roughly **3×** below what today's tree measures even on the
fastest of the six runs recorded above. **That is a number change, and a number change is the owner's call — not this report's
and not the parallel session's.** The form is settled by the measurements; the value is not.

**— UPDATE (2026-10-30, 19:10): the FORM LANDED, and it landed as this report argued for it.** The parallel session committed
`d4df9e8d` _"perf(gates): the perf budgets measure ratios, not milliseconds"_ — and the change is **not** a bigger millisecond
number:

- **the per-template cost is now REPORTED, not gated** (the same template varies **2.6×** between adjacent runs on one machine, so
  no per-template threshold — absolute or relative — is meaningful);
- **the average and worst budgets are ratios against a baseline rendered in the same process** (`BUDGET_AVERAGE_RATIO = 3`,
  `BUDGET_WORST_RATIO = 3`) instead of millisecond counts;
- **the dense-matrix gate keeps its relative form and gains the BRACKET** this report asked for: the single-track baseline is
  measured **before and after** the heavy render and averaged (`baselineBefore`, `baselineAfter`), which removes the order bias
  documented below — a baseline taken _after_ the graph deflates the ratio, so the gate passed while the product got heavier.

**This is the audit's recommendation implemented by the session that owns that line, and the code comment cites the same
reasoning.** **The one thing that did NOT happen — and should not have — is a larger absolute budget.** The owner's remaining
choice is only the _value_ of the new ratio, not its form: the measured band on this tree is **1.92–2.30×** for the dense matrix
and the per-template ratio swings ~2.6× run to run, so a limit of **3×** sits above the observed band — the property the
millisecond budget never had.

**And the parallel session's own numbers complete the picture this section kept missing:** the **device floor is clean
everywhere** (0 xruns, 1.00×) while the graph drops **exactly one quantum**, with the jitter reading **1.05× / 1.16× / 1.27× /
1.48×** against a limit of 1.5× in three runs of one tree. **The floor says "the device can measure", so the absolute limit is
the only thing holding the gate up** — and a baseline would replace it with a measured difference. **The dense gate's absolute
reserve is consumed under load for the same reason** (16045 ms against a 14679 ms budget): the matrix amplifies contention more
than the serial baseline it is divided by.

**And the relative sibling has a defect of its own, in the same class — found by the parallel session and corrected here against
the code.** `auditDenseRender` (`src/browser-checks.ts:748-834`) does budget the 8×4 matrix **relatively** (`:815-817`), and that
is the right form — but the two numbers it divides are **not adjacent**, and the order biases the result in the dangerous
direction. The code measures the **heavy 8×4 render FIRST** (`:788-790`) and the **single-track baseline AFTER it** (`:803-805`):

```text
const t0 = performance.now();                                     // :788
const rendered = await renderProject(doc, bank, { … });            // :789  ← the 8×4 graph, measured FIRST
const ms = performance.now() - t0;                                 // :790
…
const b0 = performance.now();                                      // :803
await renderProject(baselineDoc, bank, { … });                     // :804  ← the baseline, measured AFTER
const baselineMs = performance.now() - b0;                         // :805
const budgetMs = Math.max(12000, baselineMs * BUDGET_BASELINE_RATIO);  // :816
const ok = ms < budgetMs;                                          // :817
```

**Two distinct defects, and the second is worse than the first.**

1. **The order makes the gate blind in the direction that hides a regression.** The baseline is measured **after** the heavy
   render, so **any load that arrives during or after the heavy render inflates the baseline and deflates the ratio** — the
   denominator grows while the numerator does not, and **the gate passes while the graph is heavier than the machine it was
   measured on.** A missed regression is the worse of the two failure directions, because a flaky red announces itself and a
   silent pass does not. Moving the baseline to the other side would only **invert** the bias (load arriving during the heavy
   render would then inflate the ratio and manufacture a false failure); the fix is to **bracket** the heavy render with a
   baseline on **both** sides and judge against the machine state at the moment the heavy render actually ran.
2. **The ratio is load-sensitive in itself, even when both measurements saw the same load.** The parallel session's two readings
   show the mechanism: under load the **baseline grew 1.58×** (2284 → 3604 ms) while the **8×4 render grew 1.94×**
   (10697 → 20701 ms), so the parallel workload is penalised about **1.23×** more than the serial one — and the ratio read
   **4.68× → 5.74×** purely because of that. **A ratio between a parallel workload and a serial one does not cancel the
   machine's speed**; it only cancels it if both sides contend equally, which they do not.

**And the guard cannot be the fix for the second defect, because it measures the wrong KIND of work.** The render is CPU-bound
and **parallel** — eight tracks with four effects each — while the guard is a **single-threaded busy-loop on the main thread**
(`src/browser-checks.ts:4830-4834`). A spin on one core does not see contention on the others, and a parallel workload suffers
from contention **more** than a serial one does — which is exactly the 1.94×-vs-1.58× asymmetry above. **A guard that probes the
machine the way the gate's workload actually runs** — a parallel CPU probe, N workers in parallel — would measure the quantity
the render depends on. That is the same lesson as §10.16.9's Defect 1 and §10.16.11's adjacency rule, now stated for the third
time in three functions: **a guard must measure the same subsystem, in the same shape, as the workload it arbitrates.**

— while the machine's own calibration is unchanged (`calib=12.0–15.5ms` against `12.3ms`) and **nothing in the render path moved**:
`git log --since=2026-10-29 07:00 -- src/rendering src/audio-engine src/project-model src/effects src/audio-worklets` returns
**no commits**, and the two parity fixes touched only `src/testing/live-offline-parity.ts` and test files. What _did_ change is
the **weight of the run before the budgets**: the parity corpus grew from **67 to 77 items**, each one an offline render plus a
realtime capture, all executed in the same browser page before the perf section opens. **So the budgets' verdict moved because
the run got heavier, not because the product got heavier** — the same shape as the realtime gate, one level down: a gate whose
number depends on the accumulated state of the run instead of on the code it claims to measure. **The exact mechanism is _Not
verified_** — heap growth and GC pressure is the obvious candidate, but `calib` is a pure CPU spin and cannot see the allocator
or the collector, so it cannot confirm it. The parallel session recorded the same three failures and wrote them up as "the perf
gates are load-sensitive" (`74a1d8dd`); the measurement above says **load is not the whole story**, because the box measured
itself as idle (`calib=12.0ms`) in the run that still failed all three. **And the gate's own comment claims the opposite**
("Offline rendering is CPU-bound and load-independent, so unlike the realtime budget it is always gated",
`src/browser-checks.ts:650`) — so the repo currently holds two statements about the same gate that contradict each other, and
**the measurement sides with neither**: the rendering is CPU-bound, it is not load-independent, and the ratio did not separate
structure from noise by a wide margin when the box was merely warm.

**— IN PLACE (2026-10-30, evening): the mechanism named in the paragraph above is WITHDRAWN; the parallel session checked it
against the tracked logs and it does not hold.** The sentence "the parity corpus grew from **67 to 77 items**" is a true fact
about the tree and a **false cause**, and the difference is worth recording rather than quietly rewriting:

- **The 77-case corpus was already there when the tree was green.** The idle log `browser-audit-head-82f59555.log` (commit
  `82f59555`, **2026-10-29 10:31**) reads `passed=77/77` and the same `parity obligation … fx=48+9 instruments=29+2` line as
  every later log, and it was **439/439 green** with `perf avg=4708 ms` and `dense 10697 ms`. **Only the oldest log
  (`browser-audit.log`) has 67** (`failed=4/67`, `fx=38+19`). **The corpus count was therefore already 77 in the run that
  passed, and it cannot explain a verdict that flipped.** (For the record, and since it was asked: the corpus is **derived from the
  tool and effect registries**, so the 67 → 77 growth came with **new instruments added to the registry** (`9419e8e1`,
  `c7035193`) — not from anything this session did. The origin was never the point; the point is that the growth was already
  present in the green run.)
- **What actually changed between the green run and the red ones is the parallel session's own commit `c0400b33`
  (2026-10-30 01:51)** — "the offline branch renders the realtime branch's MEASURED history". Before it, the second live take's
  history usually **differed** from the first (it was derived from the arming clock), so it got **its own** offline reference:
  **a third offline render per case**, 77 cases × ~1.15 s of audio plus the whole graph, all before the perf section opens.
  **The heavier run was caused by that change, and the parallel session owns it.**
- **It is fixed, in the tree, by the parallel session.** The capture now starts on a **constant** frame
  (`src/testing/live-offline-parity.ts:88-122`: `CAPTURE_START_LEAD_SEC = 0.5` → `CAPTURE_LEAD_FRAMES`, which is **22144 frames
  at 44.1 kHz**, with a clock-derived fallback when the arming took longer), so both live takes share **one** history → **one**
  offline reference → **two** renders per case → the corpus is back to its original cost — and the history no longer depends on the
  arming hour, so it is the same on the Linux runners too.
- **What survives unchanged is the SHAPE of the finding, and the parallel session confirms it explicitly:** the verdict moved
  because the **run got heavier, not because the product got heavier**. Only the attribution inside that sentence was wrong. And
  the sentence just above it — the box measured itself as **idle** (`calib=12.0ms`) in a run that failed all three — now has a
  second, sharper reading: **the run was heavy because it did more work, and the calibration is a CPU spin that cannot see
  either.** A guard that cannot see the thing that moved is not a gate.

**The generalisable part of this correction, which is the part worth keeping:** _"the run got heavier" is a conclusion, and
"the corpus grew" is a candidate mechanism — and the two are not the same claim._ A candidate mechanism has to be checked against
an artifact that shows the mechanism **absent** while the conclusion held. Here that artifact existed (`82f59555`, green, same
corpus), and checking it took one grep. **The conclusion was right and the mechanism was wrong, which is the worst combination:
the right conclusion survives for the wrong reason, and nobody re-checks it.**

**Provenance of the committed artifact, recorded here because this session owns the instrument.** The log the parallel session
committed at `74a1d8dd` (`docs/audits/2026-10-29-browser-audit/browser-audit-3328668c-plus-rt-floor-loaded.log`) contains **this
session's instrumented output** — the `device floor … graph build=… steady=…` line exists only in the working tree at the time —
because the two sessions share one worktree and the parallel session ran the browser gate against it. **The artifact is
therefore labelled `head-3328668c` but was produced from a tree that also contained this session's uncommitted
`src/browser-checks.ts`.** The log's own content is honest about it (the instrumented line is visibly not in `3328668c`), and
the parallel session has been told; but a log whose name says one commit and whose bytes came from another is exactly the kind
of artifact this report keeps flagging, and it is recorded here rather than left implicit.

**The runner answered, and the answer is not "the machine".** The next CI run on the runner printed the floor, the window and the
split in one line (read directly from the job's error annotation — one API request, no logs):

```text
FAIL rt budget: 12 tracks × 4 effects realtime — OVER BUDGET — blocks=960 xruns=1
heartbeat avg=186.16ms max=212.70ms (expected≈185.76ms, 1.00×) quantum=2.902ms
· device floor xruns=0 jitter=1.00× (1 track, no effects; cold 0/1.00× / warm 0/1.00×)
· graph build=0 steady=1
```

**The runner's device floor is perfect.** Zero dropped quanta on an empty graph, and the heartbeat delivered at **exactly 1.00×**
its expected cadence — cold and warm. **The runner is not slow; it is a measuring device.** By §10.16.2's own rule — _the
environment must explain the gate, never fail it_ — a machine that can measure **deserves a gated verdict**, so the red is
**legitimate by the repository's own philosophy**, and "the runner is too weak to judge this" is **falsified**.

**And the seven became one, for a reason the instrument names.** The old `xruns=7` was counted from the moment the processor was
created, so it swept in the graph's **construction** — the phase where 48 effect chains are built on a fresh context. The new
split says where the remaining drop is: **`build=0`, `steady=1`**. The single dropped quantum happened **while the graph was
playing**, not while it was being built. So the realtime path on a 2-vCPU runner costs **one dropped quantum in 960** — and the
other six were never in the measurement window at all.

**What that leaves, stated plainly.** The 12×4 realtime graph **does not fit in realtime on a 2-vCPU runner** — by one quantum in
960 — and on an idle desktop it sits at **1.27×–1.48×** of the heartbeat jitter limit, i.e. **one hundredth from the edge**. The
red is not a machine artifact and not a measurement artifact. **It is a capacity finding: the realtime path has essentially no
headroom for a 12-track, 4-effects-per-track project on modest hardware.**

**And the two environments fail each other's checks — which is the sharpest form of the whole finding.** The runner's job
reported **`failing checks: 1`**, and that one check is the realtime budget: the three **offline** budgets **passed** there. On
this desktop, the realtime budget **passes** (0 xruns) and the three **offline** budgets **fail**. **The same tree, the same
checks: each environment fails exactly what the other passes.** A budget that flips with the environment is a report about the
environment. Neither machine is a measuring environment for these gates, and the reason is now measured rather than guessed:
**the run's accumulated weight moves the numbers** (the corpus grew 67 → 77 items), and **the realtime scenario is at the edge
on every device measured**.

**And then the third environment said the last word: the desktop flips too.** The parallel session committed a fresh run at HEAD
`3328668c` (`d5480075`, `docs/audits/2026-10-29-browser-audit/browser-audit-3328668c-plus-rt-floor.log`), on this same machine:

```text
FAIL rt budget: 12 tracks × 4 effects realtime — OVER BUDGET — blocks=896 xruns=1 heartbeat avg=197.32ms
max=221.70ms (expected≈170.67ms, 1.16×) quantum=2.667ms · device floor xruns=0 jitter=1.00×
(1 track, no effects; cold 0/1.00× / warm 0/1.00×) · graph build=0 steady=1
FAIL perf: 8 tracks × 4 effects render stays within baseline + headroom — 20701ms vs 3604ms single-track
baseline for 16500ms audio (budget 15604ms, 5.74× baseline)
```

**Three environments, one shape:**

| environment                                | device floor   | realtime verdict | offline verdict |
| ------------------------------------------ | -------------- | ---------------- | --------------- |
| desktop, this session (`calib=12.0ms`)     | 0 xruns, 1.00× | ✅ **0** xruns   | ❌ 3 red        |
| desktop, parallel session (`calib=13.3ms`) | 0 xruns, 1.00× | ❌ **1** xruns   | ❌ 1 red        |
| CI runner, 2-vCPU Linux                    | 0 xruns, 1.00× | ❌ **1** xruns   | ✅ 3 green      |

**The floor is clean in every single one.** The device is never the excuse — not on the runner, not on the desktop. And the
number the graph drops is **exactly one quantum** in two of the three runs, on two different operating systems and two different
CPU budgets. **The 12×4 realtime graph sits precisely on the boundary: it either makes it or misses by one quantum.** The run
that passed did so by a single quantum of luck, not by margin.

**That is the finding, stated as a property of the product rather than of a machine: the realtime path for a 12-track,
4-effects-per-track project has no headroom.** The jitter tells the same story from the continuous side — **1.16×, 1.27× and
1.48×** against a 1.5× limit across three runs of one tree, i.e. the criterion's own number varies threefold while the product
does not change at all.

**So the gate is right and the scenario is wrong — or the DSP is.** The check's own claim is that it catches "a regression that
makes the graph too heavy". It cannot do that: it compares the graph against **zero**, which is a **capacity test**, not a
**regression test** — it cannot tell "this is one quantum worse than it was" from "this has always been one quantum over". The
offline sibling has a baseline; the realtime one never got one. **That is the missing piece, and it is the same missing piece as
the offline budgets' missing clean process.**

**The recommendation that follows from the measurement, not from taste.** Three changes, in this order:

1. **Give the realtime budget a baseline**, like its offline sibling has: measure a reference graph on the same device and judge
   the 12×4 against it, instead of against an absolute zero that a given box may or may not reach. Then the gate reports "the
   graph is N× heavier than the reference **on this device**", which is a regression statement.
2. **Measure the perf section in a clean process** — it is a set of wall-clock measurements taken in the shadow of every check
   that ran before them (the corpus grew 67 → 77 items, and the three offline budgets turned red with it). Measured first, or in
   its own page.
3. **Judge the realtime jitter against the floor** rather than against an absolute multiple, which is what the floor was built
   for, and which would have turned "1.48×" into "the graph costs 48 % of the heartbeat cadence on a device that delivers 0 %".

**What is _not_ recommended is loosening the limits.** The 1.5× limit did its job — it caught a graph that is one hundredth from
the edge, and the floor proved the catch was the graph's and not the machine's. **And the capacity finding itself is a product
question the owner has to answer, not a gate question**: a browser DAW that drops a quantum on a two-core machine when a project
carries 48 effect chains is telling the owner something real about the realtime path — and the audit's job here was to make that
sentence legible instead of hiding it behind a machine excuse.

#### 10.16.10 P-2 — the owner's answer, and the first phase that landed with it

**The owner answered P-2 on 2026-10-30: the ARR REC strip STAYS in ARR, and the recording state moves into the PROJECT.**
That is a scope decision, and it landed as one — but the audit's own §11 entry for P-2 had already named the specific hole
underneath it, so the decision had a smaller, sharper reading than "the recording surface gets one address":

> **P-2 · The recording surface gets one address.** … **Note:** this is now the single largest hole the palette still has — the
> recording family is the one family the curated registry could not reach, because `armedTrackId` and the recorder state are local
> React state rather than project state (§9.2.2).

**"One address" was not the hole; the hole was that the target of a recording was not a fact about the song.** `armedTrackId`
was a `useState` string inside `ArrangementPanel`, so: the palette could not reach it, **no command could arm a track**, a
scripted or MCP route could not arm a track, and **nothing could undo an arm**. §11's phrasing — "the recording family is the
one family the curated registry could not reach" — is literally true, and the reason is a single line of component state.

**What landed (`70f3b175`, schema 41).** The arm target became a **project fact**, on the ordinary command path:

| change                 | file                               | what it does                                                                               |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `RecordingArm`         | `src/project-model/types.ts`       | `ProjectDocument.recording.armedTrackId` — absent = nothing is armed                       |
| `SCHEMA_VERSION` 40→41 | `src/project-model/schema.ts`      | additive; absent = the unchanged default for every existing project                        |
| `setRecordingArm`      | `src/commands/recording.ts`        | an undoable command; an unchanged arm does not push a no-op undo frame                     |
| palette route          | `src/commands/palette-registry.ts` | `recording.arm`, group "Record", precondition "Select a track to arm for recording"        |
| the ARR strip          | `src/ui/ArrangementPanel.tsx`      | the ARM select now executes the command; the arm is READ from the document, not from state |
| collab                 | `src/collab/YDocAdapter.ts`        | the arm is synced, so a peer sees the same armed track                                     |

**What deliberately did NOT land, and why — the distinction the owner's answer turns on.** The capture **session**'s own
state (second channel, extra input routes, take mode, punch/loop flags, live recorder status) **stays local to the UI**. The
reason is a category, not a preference: **the arm target describes a song, and the capture session describes a running
capture.** A session's state must not be persisted into the document and must not be undoable — undoing "I had a second
input routed" is not a musical act, and a project that saved it would carry a fact about a recording session that has not
happened yet. The arm is the opposite: _where the next take lands_ is part of the arrangement, exactly like the selected
Live Set.

**Verified, and the interesting part is what the counts did.** `tsc --noEmit --incremental false` exit 0; the 4 P-2-related
spec files **43/43**; a 13-file sweep **276/276**; a 7-file sweep **179/179**. And the four homes moved as follows: the
**spec-file count stayed 1345** (the new specs live in an existing file, so the count does not move and no count re-pin is
owed by this wave), the **seam count did not move** (the manifest was not touched — the 106th seam is CF-18's, `362a82be`),
the **payload was re-pinned** (`4c58e9d4`, because `main`'s Hygiene was red from a count this wave did not move), and the
**serialization golden was re-pinned** (`df3b0e87`, because the document's schema version is part of the serialized form).
**A schema bump is a wave that touches the other three homes even when it moves no count.**

**What is deliberately still open: the MCP route.** The command surface now reaches the arm, but the **MCP tool surface** does
not — there is no `mcp__record__arm` route, because `src/mcp/tools.ts` was being edited by the parallel session at the time
and a concurrent edit to one 14 000-line file from two sessions is how a conflict becomes a lost wave. **This is recorded
as open rather than done**: the palette route ships, the MCP route does not, and §11's P-1 (one registry that the palette,
the MCP surface and the intent router all read) is the structural reason the MCP route will need to exist as a
_derivation_ rather than as another hand-written tool.

#### 10.16.11 The scenario ladder — measuring the boundary, and finding that the instrument was measuring the run

**The owner asked for the boundary** (§10.16.9's open question: is 12×4 the promise the product makes, or a worst case that
only a bigger machine can hold?), and the instrument for it was committed in `7dd4c448`: a ladder of scenarios
(**12×3**, **8×4**, **12×2**) measured after the gated 12×4 window, on the same context and the same probe. It never
gates — it is a diagnostic — and this section is what it took to make it answer its own question.

**The first measurement, on this desktop (`calib=15.3ms`), read like this:**

```text
FAIL rt budget: 12 tracks × 4 effects realtime — OVER BUDGET — blocks=448 xruns=2 heartbeat avg=391.68ms
max=417.40ms (expected≈170.67ms, 2.30×) quantum=2.667ms · device floor xruns=0 jitter=1.00×
(1 track, no effects; cold 0/1.00× / warm 0/1.00×) · graph build=0 steady=2
· ladder 12×3 xruns=1 jitter=2.61× · 8×4 xruns=1 jitter=3.13× · 12×2 xruns=1 jitter=3.12×
```

**Reading 1 — the xrun count understates the failure by two orders of magnitude, and the heartbeat is the honest number.**
The window is **2.5 s** (`src/browser-checks.ts:501`), and at 48 kHz / 128 frames a full-rate context renders **937** quanta in
it. The measured count is **448** — **48 % of real time**. The audio thread was not "dropping a quantum now and then"; it was
**running at half speed** on the 12×4 graph while the empty graph held **exactly** 1.00×. Yet the gate's own headline says
`xruns=2`, because the xrun counter fires only when the device clock jumps a whole quantum past the processor
(`src/audio-worklets/rt-monitor-processor.js:44-47`), and a thread that is uniformly behind never jumps — it just arrives
late. **§10.16.9 said "the xrun count was never the interesting number"; the measurement now says the xrun count is not even
the right order of magnitude** — the heartbeat lateness (**2.30×** of the expected cadence) is what a musician would actually
hear, and it is 2.30 against a limit of 1.5.

**Reading 2 — the ladder's own readings were inverted, and that is a defect in the ladder, not in the product.** In the order
they were taken: the gated **12×4** (48 effects) read **2.30×**; the ladder's **12×3** (36 effects) read **2.61×**; **8×4**
(32 effects) read **3.13×**; **12×2** (24 effects) read **3.12×**. **A lighter graph read worse, and the readings rose with
measurement order while the graph got lighter all the way down.** That is not a capacity curve — it is the shape of a page
that is getting slower, the same accumulated-weight effect that moved the three offline budgets in §10.16.9. The device
floor could not tell the two apart, because it was measured **once, at the start** of the block: it answered for a moment that
was no longer the moment the ladder was read in. **The instrument was measuring the run.**

**The fix (`894e2368`, `37ff58c0`): a floor taken ADJACENT to every scenario, and the scenario read as a RATIO against it.**
Same context, same probe, one track and no effects, immediately before each scenario — so the reference is the device's ability
**at that moment**, not at the start of the block. And the scenario is reported as `jitter ÷ adjacent floor jitter`: a
degradation that hits the empty graph and the loaded one alike **cancels in the ratio**, so what survives is the graph's own cost
expressed in the device's heartbeat budget. Both drop counts are reported **raw** (the scenario's and the floor's) — a net
difference was tried first and read as nonsense (`xruns=-1`: the floor's window can drop a quantum the scenario's does not).
The ladder stays a diagnostic and the gated 12×4 window keeps its exact position and construction, so **the gate's own verdict
is unchanged by the fix** — the fix changes what the ladder can say, not what the gate says.

**The fixed instrument on the CI runner — the controlled environment.** The runner's browser job failed, so its error annotation
carries the line (one API request; job logs are behind a login, annotations are not):

```text
FAIL rt budget: 12 tracks × 4 effects realtime — OVER BUDGET — blocks=896 xruns=1 heartbeat avg=204.10ms
max=255.50ms (expected≈185.76ms, 1.10×) quantum=2.902ms · device floor xruns=0 jitter=1.00×
(1 track, no effects; cold 0/1.00× / warm 0/1.00×) · graph build=0 steady=1
· ladder 12×3 xruns=0 (floor 0) jitter=1.03× floor=0.93× ratio=1.11×
· 8×4 xruns=1 (floor 0) jitter=1.28× floor=1.00× ratio=1.27×
· 12×2 xruns=3 (floor 0) jitter=1.49× floor=0.85× ratio=1.75×
```

**The fixed instrument on this desktop, twice** (run A on a busy box, `calib=13.8ms`; run B on a quiet box, `calib=17.3ms`):

| scenario            | chains | runner ratio | desktop run A ratio | desktop run B ratio |
| ------------------- | ------ | ------------ | ------------------- | ------------------- |
| **12×4** (the gate) | 48     | **1.10×**    | **2.31×**           | **2.34×**           |
| 12×3                | 36     | 1.11×        | 2.26×               | 2.38×               |
| 8×4                 | 32     | 1.27×        | 1.75×               | 1.81×               |
| 12×2                | 24     | 1.75×        | 1.50×               | 1.51×               |

**Reading 3 — the ladder measures POSITION, not weight, and that survives the fix.** Three runs, two devices, the same shape: the
readings rise with the order the scenarios were measured in. On the runner the floors stayed flat (0.93× / 1.00× / 0.85× — the
device did **not** degrade), so the order effect is **not** a device-degradation effect and the ratio cannot cancel it: the
lightest scenario (12×2, 24 chains) read the **worst** (1.75×), and the heaviest ladder scenario (12×3, 36 chains) read the
**best** (1.11×). On the desktop the floors degraded hard (1.18× → 1.74× → 2.24× across the three scenarios), the ratio cancelled
most of that, and what survived happened to come out monotonic in weight — **the opposite ordering to the runner's**. Two devices,
the same instrument, opposite orderings: **the ladder's ordering is not a property of the product.** The mechanism is not
identified — **Not verified** — and the honest statement is that a single-pass ladder shares one context and one engine across its
scenarios, each of which rebuilds the whole graph (`engine.setProject`), and whatever that rebuild leaves behind accumulates in
reading order. **What would settle it** is a ladder that measures the same scenario twice, first and last, so the order effect is
measured instead of hidden, or one that gives every scenario a fresh context. **That is the next instrument step, and it is not
in this commit** — the ladder is a diagnostic, and its remaining defect does not gate anything.

**Reading 4 — what DOES settle the owner's question, and it is the gate's own scenario.** On the runner — the controlled
environment, and a **weaker** machine than this desktop — the 12×4 graph ran at **896 of 896 possible quanta**: **100 % of real
time**, heartbeat at **1.10×** its expected cadence against a limit of 1.5×, and **exactly one dropped quantum in the window**. So
the promise the product makes — twelve tracks with four effects each, 48 effect chains — **fits in realtime on modest hardware**,
and the only thing the gate objects to is that single quantum. On this desktop the same scenario rendered **384–448** quanta in
the same 2.5 s window — **41–48 % of real time** — with a 2.3× heartbeat; but this desktop's own calibration drifted across the
day from **12.0 ms** (the parallel session's run) to **17.3 ms** in the "quiet" run, a **44 %** swing with no heavy job of this
session's running, and ~35 `node.exe` processes (eight Playwright MCP servers, several Vite dev servers, other sessions) were
resident throughout. **A desktop whose own calibration moves 44 % is not a measuring environment for absolute realtime numbers** —
and its number says more about the box than about the product.

**— IN PLACE (2026-10-30, evening): the parallel session's clean desktop run CONFIRMS this reading, and the two environments now
agree.** In the isolation-experiment run (`perf-isolation-experiment.log`, commit `9f0f6c1c`) the desktop's own realtime line
reads:

```text
FAIL rt budget: 12 tracks × 4 effects realtime — OVER BUDGET — blocks=896 xruns=2 heartbeat avg=198.97ms
max=244.30ms (expected≈170.67ms, 1.17×) quantum=2.667ms · device floor xruns=0 jitter=1.00×
(1 track, no effects; cold 0/1.00× / warm 0/1.00×) · graph build=0 steady=2
```

**`blocks=896` is 100 % of real time on this desktop** — the same figure as the runner — with the heartbeat at **1.17×** against
the runner's **1.10×**, and a **clean floor (1.00×) in both**. **So the desktop and the runner measure the same thing**: the
graph costs about **1.1–1.2×** the empty graph's heartbeat budget on both, and the gate is red on **one or two dropped quanta out
of 896** in both. The **41–48 % of real time** readings in this session's three runs were **the contaminated ones** — a loaded box,
not a different product. That is the third time this audit has had to separate _the box_ from _the graph_, and the third time the
floor is what does it.

**And the owner-facing consequence is now measured on both machines, not one:** the promise fits, at full real time, with roughly
**1.1–1.2×** of the heartbeat budget used against a **1.5×** limit — and the gate's red is **a handful of dropped quanta**, which
is the signature of a criterion with no baseline rather than of a graph that does not fit.

**So the boundary, as far as it is measured, is: on a 2-vCPU Linux runner the realtime path holds 48 effect chains at full real
time, with one dropped quantum of margin; on a loaded desktop the same scenario does not fit, and the desktop's own floor says
the box was the reason.** §10.16.9's recommendation stands and is now sharper: **the 12×4 scenario is a promise modest hardware
can hold, so the gate must stop being a capacity test against zero** — it needs the same relative form its offline sibling got
(`4bc8a224`: a ratio, not an absolute), which for a realtime gate means judging the graph against the **adjacent floor** this
section built, rather than against an absolute zero that a device may or may not reach. **Loosening the 1.5× limit is still not
recommended** — the limit did its job; the criterion's FORM is what is wrong.

**Why this is the general lesson, not just a ladder bug.** The floor was introduced (in `80cb40ee`) to answer "is this the
machine or the graph?" — and it answered that question correctly, because the gated window sits **right next to** its floor.
The ladder sat **four windows further down the page**, and a floor that is not adjacent is not a floor: **it is a reading
from another moment.** The rule this adds: **a reference measurement must be taken next to the measurement it references.**
A floor three windows earlier is as blind as a guard that measures a different subsystem (§10.16.9's Defect 1) — it is simply
blind in time rather than in subsystem. **And the second rule this adds is the one the ladder itself failed: a set of
scenarios measured one after another in a shared context measures the ORDER unless the design proves otherwise** — so a
capacity curve has to be demonstrated to be monotone in weight before it is read as one. **Three runs on two devices, with two
different orderings, is exactly the evidence that it was not.**

**The raw artifacts behind this section** are committed next to it, in
`docs/audits/2026-10-27-hidden-creative-power/`: `07-realtime-scenario-ladder.md` (the write-up with all three runs quoted
verbatim), `rt-ladder-run1-no-adjacent-floor.log` (the inverted reading — the defect's evidence),
`rt-ladder-run2-adjacent-floor-contended.log` and `rt-ladder-run3-adjacent-floor-quiet.log` (the fixed instrument, twice, on a
contended and on a "quiet" desktop). The runner's line is quoted from the job's **error annotation** on `37ff58c0` — one API
request; the job log itself requires repository admin rights and answers **403**. The two desktop runs were taken in an **isolated
detached worktree** at `37ff58c0`, because the parallel session's in-flight audio-hardening refactor edits the playback path and
the two DSP processors the ladder's effect stack uses: **measuring on a tree another session is editing would have measured their
work-in-progress.**

---

## 11. Strategic proposals requiring explicit approval

None of these is implemented. Each needs a product decision, not a patch.

**P-1 · A command-registry-derived index (the root fix).** — **PHASE 1 SHIPPED (§9.2.2).**
The curated registry landed: 20 commands, three rules, 55 → 75 palette actions, 24 → 9 zero-hit queries, and
twelve capabilities findable by name. **IN PLACE (2026-10-30):** the palette is now **80** actions and the zero-hit
count is **6** (the spec's ceiling stays 9) — §10.16.10, §10.11.3.
**Still open:** the registry is a **curated whitelist**, not a derived
index. Making the command registry the single source of _what the product can do_ — so the palette, the MCP
tool surface and the intent router all read the same table — remains the structural fix for HCP-05-01,
HCP-04-01 and HCP-04-03. **Needs:** a decision on what "visible in the palette" means per command (an
explicit flag, not a heuristic), and the action-count ceiling (currently pinned at 100 by the coverage spec).
**Rejected alternative:** adding palette entries by hand — it reproduces the same list-of-lists problem one
entry at a time.

**P-2 · The recording surface gets one address.** — **DECIDED (2026-10-30): the ARR REC strip STAYS in ARR; the recording
state moves into the PROJECT. PHASE 1 SHIPPED (`70f3b175`, schema v41).**
Capture, arm, punch, comp, freeze and take review are six verbs spread over three dock tabs, a context menu
and a footer chip. The proposal was **one address**, not one panel: the session-state chip already exists and
already aggregates the state — it is the natural home for the verbs. **The owner answered the open question
("whether the ARR REC strip stays where it is"): it stays.** The hole underneath the proposal was narrower and
sharper than "one address" — the recording family's target was not a fact about the song at all: `armedTrackId` was
component state, so the palette could not reach it, no command could arm a track and nothing could undo an arm.
**Phase 1** moved the arm target into the document as `recording.armedTrackId` (schema 41), as an undoable command
with a palette route and a collab mirror (§10.16.10). **Still open:** the capture **session**'s own state (second
channel, extra input routes, take mode, punch/loop) stays local by design — it describes a running capture, not a
song — and the **MCP route** for the arm is not shipped, because `src/mcp/tools.ts` was under another session's edit
at the time; the structural fix for it is P-1's single derived registry, not another hand-written tool.

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
   `tests/ui/palette-search-coverage.test.ts`, which holds the zero-hit count at a **ceiling of 9** (measured:
   **6**) and the action count at **80** (ceiling 100). **IN PLACE (2026-10-30):** the action count moved 75 → 80
   with CF-12, CF-15 and P-2, each of which re-pinned it deliberately.

### 60 days — build the index

1. **P-1, phase 1:** a command→palette adapter with an explicit `label` and a `paletteVisible` flag, applied
   to the **30 blind modules** first (automation, quantize, scenes, plugins, effect params, clip playback,
   instruments, chord tracks, live sets, markers, master, freeze, smart comp, stem tracks).
   **— PARTLY DONE (§9.2.2).** The curated registry covers **20 commands** across those modules; the
   `paletteVisible` flag is still missing, and the registry is still hand-curated rather than derived.
2. **P-1, phase 2:** give the palette **capture actions** (HCP-02-01), dispatched through the same handlers
   and the same preconditions as the REC button — with the disabled-with-reason state. **— PARTLY DONE (2026-10-30).**
   It was blocked on P-2: the recorder's state has to leave local React state before a registry entry can exist for it.
   P-2 is now decided and phase 1 landed (`70f3b175`, schema v41), so the **arm** has a registry entry
   (`recording.arm`) and the palette is **80** actions. **What is still missing** is the rest of the family — Take,
   Comp, Freeze, Monitor, Punch, recovery — whose preconditions are properties of the **capture session** (second
   channel, input routes, take mode, punch/loop), and that state is still local by design (§10.16.10).
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

_Prepared 2026-10-27 against `main`, updated 2026-10-28 after the P-1 / P-4 wave and after the browser check
(§10.7), the four-instance drift story (§10.10–§10.11), the live↔offline handoff and its refutations
(§10.12–§10.14), and again on 2026-10-29 with the CI-hygiene readings (§10.16) — including the correction of this
report's own "four product findings" claim (§10.14 → §10.16.5) — and again on 2026-10-30 with the CI run's own verdict at
77 cases (§10.16.6: the seventeen were not one defect, and the invariant-3 candidate dissolved), the fifth drift instance
(§10.11.2) and the palette ratchet that the wave which shipped it broke (§10.16.8), and once more on 2026-10-30 when the
cause of the seventeen turned out to be a **race** in the harness's construction order and the corpus went green on the Linux
runner. Every claim is labelled Observed / Verified / Inferred / Hypothesized / Not verified, and every measurement in §10.2 was
reproduced from the repository at the cited commit._

_Line numbers into `src/testing/live-offline-parity.ts` are anchored to the committed tree at **`a33f7ede`** ("the
annotation's rule must describe the rule the gate applies"). That file is being rewritten by the parallel session
several times a day, so those citations are only exact at that commit; where a claim points at code that has since
changed, the text says so ("in the tree at the time")._
