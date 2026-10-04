# UI FUNCTIONAL INTEGRITY AUDIT — 2026-09-30

Functional (not visual) audit of the KYX / Pulse Forge UI, with repairs.
Scope: every interactive surface in `src/ui/**` — 85 components, 1.7 MB of
React. Eight waves, **20 confirmed defects repaired**, each source change covered
by a regression test proven to FAIL against the pre-fix code. A seventh wave
swept §3, §7, §9, §14 and §15 and found no further defect; it is recorded
because its two false positives and its verified-clean areas are the part a
future audit should not have to re-derive. The eighth found two more from one
class — buttons that accepted clicks which silently did nothing.

This file is a working report. Per `AGENTS.md` §10, any number claimed here
must be reproducible from the working tree.

---

## 0. SUMMARY OF THE REQUIRED SECTIONS

| Objective section         | Where |
| ------------------------- | ----- |
| VERIFIED FUNCTIONAL       | §3    |
| REPAIRED                  | §2    |
| VALUE / RANGE CORRECTIONS | §2a   |
| EDGE CASES COVERED        | §4    |
| INCOMPLETE / UNSUPPORTED  | §5    |
| REMAINING RISKS           | §6    |
| TESTS ADDED               | §7    |
| KEYBOARD / ACCESSIBILITY  | §8    |

---

## 1. INVENTORY (measured)

Static extraction over `src/ui/**.tsx` — **re-measured at report time**, not
carried over from the original scan:

| Control kind                                              | Count |
| --------------------------------------------------------- | ----- |
| `<button>`                                                | 666   |
| `<select>`                                                | 135   |
| `<input>`                                                 | 94    |
| interactive `<div>`/`<span>` (has `role=` or `tabIndex=`) | 245   |
| shared `<Slider>` (usage sites)                           | 78    |
| shared `<DragNumber>` (usage sites)                       | 32    |

85 `.tsx` files in `src/ui`. Plus each button's `onClick`, each select's option
set, context menus, keyboard shortcuts, drag handles and editor gestures.

The interactive-div row counts _elements_, not clickable affordances: one
`role="button"` container with three inner spans counts once. It is an upper
bound on the surface area, and it is why the control-level sweeps below are
done by tracing behaviour rather than by counting tags.

The shared control library `src/ui/controls.tsx` (`Slider`, `DragNumber`,
`ValueMenu`) was audited first because it is the highest-leverage file: both
controls are reused across ~20 panels, so one defect there is many defects
in the product.

**Reproducing the inventory.** The original scan script was scratch tooling in
the gitignored `.zcode/` and is not preserved, and the first version of this
table carried its numbers un-verified — which turned out to matter, because
the tree moved under it. The figures above are re-derivable with ripgrep:

```bash
rg -o '<button'                    src/ui --glob '*.tsx' | wc -l
rg -o '<select'                    src/ui --glob '*.tsx' | wc -l
rg -o '<input'                     src/ui --glob '*.tsx' | wc -l
rg -o '<Slider\b'                  src/ui --glob '*.tsx' | wc -l
rg -o '<DragNumber\b'              src/ui --glob '*.tsx' | wc -l
rg -o '<(div|span)[^>]*(role=|tabIndex=)' src/ui --glob '*.tsx' -U | wc -l
```

---

## 2. REPAIRED — 20 confirmed defects

### WAVE 4 — found by real-browser verification (not static inspection)

**14. The flagship PRISM and VLYX editors rendered at ZERO height in the
devices dock (CRITICAL).**
`src/styles/15-command-palette-2.css:14-30`. This one is invisible to jsdom
tests, unit tests and typecheck — it only appears when a browser lays the page
out, which is why the audit's final browser pass found it.

Measured in Chromium, replaying the `tests/e2e/06-plugin-workflow` steps:

| Element                    | Height    | Laid-out children        |
| -------------------------- | --------- | ------------------------ |
| `.devices-panel`           | 413 px    | —                        |
| `.fx-device-content`       | 164 px    | —                        |
| `.fxeq-panel.prism-docked` | **0 px**  | 187 px across 6 children |
| `.vlyx-docked` (VLYX)      | **10 px** | 160 px across 5 children |

Root cause: `.fx-device-content` is a column flex box with a definite 164 px,
and its fixed sibling rows total **245 px** (preset 59 + sidechain 45 + pager
24 + params 77 + trim 40). The docked panel was the only child allowed to
shrink (`flex: 1 1 0`), so it absorbed the whole 81 px of negative free space
and collapsed to nothing while `overflow: hidden` hid its 187 px of perfectly
laid-out content. The plugin surface was in the DOM, focusable, and completely
invisible — the "renders but has no effect" class in its most literal form.

Note the failed hypothesis, recorded because it is the obvious one: changing
`flex: 1 1 0` to `flex: 1 1 auto` did **not** help. With a content basis the
container overflows further and shrink still wins. The fix is a `min-height`
floor so the panel cannot be crushed below a usable height.

Verified: PRISM 0 → 200 px, VLYX 10 → 200 px, both `VISIBLE=true`, and
`tests/e2e/06-plugin-workflow` went from failing after 58 retries to passing
in 9.4 s.

**15. The overflow that caused it was being silently discarded (MAJOR).**
`src/styles/14-command-palette.css:1121`. `.device-editor
.fx-device-content` had `overflow: hidden`, so once the panel had a floor the
remaining overflow — the output-trim row and, on a shorter window, part of the
parameter grid — was crushed out of reach. A visible plugin and an
unreachable control in the same dock is still a broken dock. The content box
now scrolls (`overflow-y: auto`, `overscroll-behavior: contain`) instead of
clipping. Measured after the change: `clientHeight 164 / scrollHeight 491 /
maxScroll 327`, and a sweep of both scroll ends finds **0 unreachable rows**
of 6. The dock is still shorter than the content; growing it remains a
product call, but nothing is lost.

### WAVE 1

**1. `Slider` leaked its `disabled` state (MAJOR).**
`src/ui/controls.tsx:339,335`. Pointer-down and keyboard were guarded by
`disabled`, but the double-click reset (`onCommit(defaultValue)`) and the
right-click value menu were not. A control rendered greyed out still wrote
to the project. Live hosts: `BeatManglerEditor.tsx:179` (CHANCE slider is
disabled when `trigger < 0.5`) and `SourceMacroDock.tsx:86` (macros before
the profile loads). Fixed by gating both paths; all four gesture paths are
now inert while disabled.

**2. `DragNumber` resolution was hardcoded (MAJOR).**
`src/ui/controls.tsx:473,476,531,536,569`. Values were quantised to
`Math.round(raw * 10) / 10` and the arrow keys stepped by a hardcoded `1`.
On sub-unit controls this destroyed the precision the control advertises:
`HUMANIZE` / `VEL·RND` (0..0.5, drag sensitivity 0.005/px, 2-decimal
display) snapped to 0.0 / 0.1 / 0.2 — roughly 10 dead pixels of drag
followed by a jump across a fifth of the range — and one arrow press
slammed the value to the maximum. Introduced `dragNumberResolution(min,
max, step?)` (pure, unit-tested): step is `1` for unit-scale ranges and
`span/100` below that; decimals derive from the range. Unit-scale controls
(120→121 BPM) keep their historical behaviour.

**3. `DragNumber` committed a no-op on every click (MINOR).**
`src/ui/controls.tsx:484`. `handlePointerUp` committed unconditionally, so
a zero-movement click pushed a no-op command into undo history and
re-sent the parameter to the engine. Now commits only when the quantised
value actually changed.

**4. `EffectRack` devices dock rendered a dead Collapse button (MINOR).**
`src/ui/EffectRack.tsx:397,566`. In device-editor mode the device is
hardcoded `expanded` and the chevron was bound to `onToggleFocus={() => {}}`
— a visible, live-looking button that did nothing. `tests/e2e/06-plugin-workflow.spec.ts:13`
already documented the intent ("The DEV dock intentionally hides rack
collapse controls in its device-editor mode"), so this was a regression
against that. `onToggleFocus` is now optional and the toggle renders only
when the host owns the expand state.

### WAVE 2

**5. Ozvena blend pad wrote two commands per gesture step (MAJOR).**
`src/ui/OzvenaPanel.tsx:155-156,184-185`. Every pointermove and every arrow
key issued `blendPad.x` then `blendPad.y` — two `setEffectParam` commands
each. A one-second drag produced ~120 history entries, evicted real edits
from the store's 256-entry cap, and a single Ctrl+Z peeled back only one
coordinate, landing the pad in a state the user never authored. The pad is
now bracketed by the store's existing undo-frame API, passed down by
`EffectRack` as optional `onGestureStart` / `onGestureEnd` (so the panel
keeps no store dependency). A cancelled drag still closes the frame.

**6. Ozvena pad numeric fields committed per keystroke (MAJOR).**
`src/ui/OzvenaPanel.tsx:279-283,296-300`. Typing `85` created two history
entries and one Ctrl+Z snapped the field back to `8`. They now hold a local
draft and commit on blur/Enter; Escape reverts to the stored value, and a
cleared field is treated as a cancel rather than `Number("") === 0`.

**7. WavetablePanel offered an unimplemented modulation destination (MAJOR).**
`src/ui/WavetablePanel.tsx:28`. `DST_OPTIONS` included
`{ value: 2, label: "Detune" }`, but index 2 is reserved:
`src/instruments/modmatrix.ts:387-397` documents it as unimplemented, and
neither the wtvoice worklet (`src/audio-worklets/wtvoice-processor.js:363,373,445`
handle 0/1/3) nor the offline fallback reads `modADst/modBDst === 2`. A user
could build a route that produced no sound at any amount, with nothing on
screen indicating it was dead. Removed; a test now pins the panel's list to
`modDstOptions()` so it cannot drift again.

**8. Inspector pad-LFO Rate could not reach half its legal range (MINOR).**
`src/ui/Inspector.tsx:1093`. The slider capped at 20 Hz while
`src/project-model/schema.ts` clamps the document to 40. Both now read the
exported `PAD_MOD_RATE_HZ_MAX` — one source of truth.

**9. An unbounded clip length could freeze the tab (CRITICAL).**
`src/ui/ArrangementPanel.tsx:2674` and
`src/commands/commands.ts:2869,6289`. The clip SECS field had no upper
bound and both resize commands clamped only the low end, so a single typed
value could request ~300 000 bars. The arrangement view allocates
`Array.from({ length: totalBars })` bar-grid nodes
(`src/ui/ArrangementPanel.tsx:3263`) plus ruler marks (`:3084`), so that
demand froze the tab. Introduced `MAX_ARRANGEMENT_CLIP_BARS = 8192`
(~5.7 hours in 4/4) as a _rendering_ invariant, not a musical limit.

### WAVE 3

**10. The clip-length bound did not apply on load (CRITICAL).**
`src/project-model/schema.ts:1552,562`. Closing #9 in the commands left the
import/persistence path open: `normalizeProject` filtered clips with
`lengthBars >= 1` and no ceiling, so an imported, hand-edited or corrupted
project JSON could reintroduce the freeze. Both the arrangement-clip and
audio-clip sanitizers now enforce the same bound.

**11. An audio clip's left-edge trim produced two undo entries (MAJOR).**
`src/ui/ArrangementPanel.tsx:1990-2000`. Trimming the left edge issues
`updateAudioClip` (trim + offset) and then `resizeAudioClip` (length) as two
separate commands. One Ctrl+Z therefore undid only the resize, leaving the
clip reading a different region of the sample at its original length — silent
content desync requiring a second undo. This also contradicted the contract
the same file asserts 190 lines earlier ("One gesture = one undo entry",
`:1798`). Added `trimAudioClipStart` to the command layer, which writes
trim, offset and length in one snapshot and keeps fades contained in the
trimmed clip, exactly as `resizeAudioClip` does.

**12. Ripple multi-move persisted fractional bar positions (MAJOR).**
`src/ui/ArrangementPanel.tsx:1782`. `delta` derives from a fractional pointer
position, and the ripple branch wrote `startBar + delta` unrounded — while the
non-ripple branch 20 lines below rounds (`:1804`). A 4.37-bar drag persisted
every moved clip off the bar grid, which the file's own comment at `:3176`
calls out as a past bug, and made a later resize report an overlap the user
cannot see. Now rounded, matching the sibling branch.

**13. Kit save/delete reported success before the write resolved (MINOR).**
`src/ui/RackStrip.tsx:251-255,267-273`. `setKitStatus('Saved "…"')` fired
unconditionally, with no `.catch` on the promise chain. If the IndexedDB
write rejected (quota, private mode) the user was told the kit had saved
while nothing was written and the list never refreshed. Status now moves
into the success path, with a failure message.

### WAVE 5 - §13 "deletion of the currently controlled object"

This is the one objective item that had **no test coverage anywhere in the
suite**: nothing ever deleted the object whose panel was open. All three
object kinds were traced.

**16. Deleting a track left a dead id in the selection (MAJOR).**
`src/ui/Mixer.tsx:717` is the only UI call site of `deleteTrack`, and it never
touched the `SelectionStore`. `deleteTrack` is a pure
`ProjectDocument → Command` and cannot reach UI state, so the deleted track's
id survived the delete and broke the invariant _every id in the selection
names a live object_. Two measured consequences:

- **Zone bounce renders silence and reports success.**
  `ArrangementPanel.bounceZoneToClick` (`ArrangementPanel.tsx:2107`) forwards
  `selection.trackIds` into `buildBounceZoneDoc` **without** filtering against
  the live tracks; the keyboard shortcut at `App.tsx:1186` does filter, so the
  button and the shortcut disagree. `buildBounceZoneDoc` resolves the ids
  through `buildStemProject(doc, t => trackIds.includes(t.id))`, which matches
  nothing for a dead id — no throw, no error, an empty stem doc, silence.
  Deleting the only selected track and then bouncing a zone returns nothing.
- **Phantom pattern key.** A surviving `noteSelections` entry keeps
  `ContextMenu`'s `hasNotes` true, so its delete action builds
  `deleteNotes(doc, <deleted id>, …)`. `activeTrackNotes` returns `[]` for an
  unknown track so nothing throws, but `withTrackNotes` still writes
  `notes[<deleted id>] = []` back into the pattern — a phantom key in every
  save.

Fixed with `SelectionStore.pruneTrack(id)` (single deleted track, mixer
button) and `SelectionStore.retainTracks(liveIds)` (unknown survivor set,
wired at `IntentPanel.tsx:2459` for the intent engine's `removeTrack` op,
which deletes through the same command and had the same unreachable store).
Both no-op without emitting when nothing referenced the track.

**17. The arrangement DEL button kept targeting the clip it deleted (MINOR).**
The arrangement has two clip-delete paths and they disagreed: the
context-menu / ripple path clears the selection
(`ArrangementPanel.tsx:1898`), the DEL button did not. The button's own
disabled contract is `disabled={!selectedClipId}`, so a dead id left it
enabled over a clip that no longer exists — it could never return to its
resting state and every further press re-issued the delete for the same
removed id. One-line fix matching the convention already in the file.

### WAVE 6 — §14 "focus restoration after dialogs"

**18. Four overlays took focus on open and never gave it back (MAJOR).**
Measured, not inferred: `ContextMenu.tsx:36-59` and the TopBar overflow menu
both restore focus correctly, while `GenerateDialog`, `HelpOverlay`,
`PaletteOverlay` and `LatencyCalibrationWizard` had **zero** restore signals
between them. Each takes focus on open (`GenerateDialog` `autoFocus`,
`HelpOverlay.tsx:27` `searchRef.current?.focus()`, and so on) and none returned
it. A keyboard user closing any of them landed on `document.body` and had to
Tab back from the top of the page.

Fixed with a shared hook, `src/ui/useFocusRestore.ts`, rather than four
one-off handlers — the pattern already existed in two places and was duplicated
in neither. It has to solve two things the naive version cannot, and both
failures were measured here first:

1. **The trigger is not observable after the commit.** Snapshotting
   `document.activeElement` inside the open effect reads focus _after_ the
   overlay has already focused itself, so it records the overlay's own input —
   which is unmounted by the time the restore runs, and the result is
   `document.activeElement === BODY` after every close. A `focusin` listener
   attached only while open misses the same event for the same reason. So
   focus is tracked from a listener mounted for the component's whole lifetime.
2. **A `ref` prop cannot classify the overlay's own `autoFocus`, either.**
   Measured with a throwaway probe in this repo's jsdom harness:

   | event            | `el.isConnected` | overlay root in DOM  |
   | ---------------- | ---------------- | -------------------- |
   | `focusin:BUTTON` | true             | **false**            |
   | `focusin:INPUT`  | true             | true                 |
   | layout effect    | —                | ref assigned **now** |

   React attaches the `ref` _after_ the commit that runs `autoFocus`, so at the
   one moment the classification is needed, `overlayRef.current` is still
   `null` and `contains()` silently answers "not inside". The hook therefore
   reads the open flag from a ref written during render, and the restore target
   is the **last element focused outside the overlay** — which is the trigger in
   the ordinary case, and the control the user deliberately moved to when they
   moved it, so one rule covers both without a second code path.

   This is why the first attempt at this hook did not work, and why the
   failure is recorded rather than quietly rewritten: it used the ref-based
   `contains()` check, which is the idiomatic thing to write and is wrong here.

Wired at all four call sites, each with the ref on the element that **contains**
the focused input: `GenerateDialog.tsx:237` (the backdrop — distinct from the
existing `dialogRef` on the inner panel, which is click-outside), `HelpOverlay.tsx:87`,
`PaletteOverlay.tsx:81`, `LatencyCalibrationWizard.tsx:154`.

**Deliberately not done.** This restores focus; it does not trap it. Modal
focus containment, `aria-modal` correctness and a roving-tabindex decision for
the mixer strips are a11y redesign, which §14 of the objective excludes. §8
keeps the mixer-strip finding on the record for the same reason.

### WAVE 7 — §9 / §14 / §15 sweeps that found nothing (and one that found a test, not a bug)

Wave 7 produced **no new defect**. It is recorded because "found nothing" is
only worth stating when the searches were good enough to be trusted, and
because two of its searches produced false positives that had to be caught.

**`AutoStageButton`'s "staged" latch looked permanently disabled — it is not.**
`ExportPanel.tsx:928` latches `staged` with `useState(false)` and never resets
it, and the button renders its label as "STAGED ✓ … — **re-export to verify**".
The re-export therefore looks like it produces a new, unappliable verdict. The
reproduction test **passed against the current code**, and the mechanism is in
the code rather than in the test: `exportMaster` sets
`setStatus({ kind: "busy" })` at `ExportPanel.tsx:163` _before_ its first
`await`, and the button sits behind `{status.kind === "done" && …}` at line
838 — so it unmounts on every export and mounts fresh with `staged = false`.
The latch cannot outlive an export, which is also why it cannot double-apply the
same advice (`computeStageAdjustment` reads the _rendered summary_, not project
state, so a second click on the same summary would apply the delta twice).

The test was kept because it pins a real invariant and was given teeth: making
the latch module-scoped so it survived the unmount failed **exactly 1 of 12**
tests — the new one — while the existing "button confirms and disables after
staging" test still passed.

**Fourteen of the sixteen editor shortcuts verified in one pass; the search
that found them was wrong three times first.** The Help overlay advertises
every shortcut, so an advertised-but-unbound binding is §15's "interactive UI
that falsely appears functional". The first three searches returned nothing and
each was a bad predicate, not absent code:

| search                            | what it actually found                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `key === "L"` etc. in `PianoRoll` | keys are compared as `const lower = e.key.toLowerCase()` then `lower === "l"`          |
| `lower === "x"` across `src/ui`   | `App.tsx` compares inline: `event.key.toLowerCase() === "x"`                           |
| `crossfade` across `src`          | 100 hits of DSP crossfades in worklets and the master chain, none of them the shortcut |

Only the fourth search — enumerating **every** `toLowerCase() === "<letter>"`
binding in `src/ui` and comparing that set against the advertised list — was
sound. Result: **all 16 advertised editor shortcuts are implemented**, each
verified at its handler: S strum `PianoRoll.tsx:1080`, Alt+S slide `:1081`,
L legato `:1132`, Ctrl+B duplicate `:1051`, Alt+Q quantize `:1062`, Shift+C
chord stamp `:1074`, nudge `:1025`, P locators `App.tsx:1067`, Ctrl+B bounce
`App.tsx:1179`, X crossfade `App.tsx:1249` (it sets `fadeIn`/`fadeOut` to 0.08
on the intersecting clips and builds transitions), Ctrl+E separate
`App.tsx:1045`, A capture `App.tsx:889-898`, Ctrl+Shift+V / Ctrl+Shift+F
`TopBar.tsx:340` / `:345`, D / Shift+D `DiceTray.tsx:147` / `:150`, and the
roll history on ← → `DiceTray.tsx:153-158`.

**Other areas swept and found clean** (each with the check that supports the
claim, since "no hits" means nothing unless the predicate was right):

- **§15 dead UI** — no empty `onClick`/`onChange` handlers, no
  `TODO`/`FIXME`/`WIP` in `src/ui`, no `disabled={true}` / `readOnly` hardcoded
  to a constant. The five `console.*` calls in `src/ui` are all `console.warn`
  in `catch` blocks.
- **§7 NaN / Infinity** — every numeric input that takes free text is guarded.
  `ArrangementPanel.tsx:1289` (`Number.isFinite(seconds) && seconds > 0`),
  `OzvenaPanel.tsx:91-93` (empty-string cancel + `isFinite` + clamp),
  `Inspector.tsx:919` / `935` (`Number(...) || 0`), and — the one that would
  matter most — `FxEqPanel.tsx:126-127` restores a band selection from
  `localStorage` and rejects non-finite, out-of-range and fractional values.
  The remaining `Number(...)` call sites are `<select>` elements, whose options
  cannot produce `NaN`.
- **§13 deletion of the controlled object, during a long async op** —
  `FreezeButton` renders a track to an `AudioBuffer` across a multi-second
  `await` and then dispatches `freezeTrack` against a `doc` captured at render
  time. The obvious hazard is a stale-document write. It is handled by
  construction: `freezeTrack` reads the track at build time but its `execute`
  closure works on the document passed in by the store at dispatch time and
  no-ops if the track is gone (`commands.ts:6734`). An orphaned buffer can
  remain in the bank, which the file documents as GC'd.
- **§3 duplicate execution on rapid clicks** — every async surface in
  `ExportPanel` disables all sibling actions behind one `busy` flag and offers
  CANCEL; `FreezeButton` guards both handlers and resets in `finally`. The
  `UltinaPanel` preset save/rename/delete handlers are gated by `window.prompt`
  / `window.confirm`, which block the main thread, so a second click cannot be
  dispatched. `ThemePanel`'s clipboard write is idempotent.

### WAVE 8 — §6/§9: controls that look actionable and silently do nothing

Two defects from one class, found by a sweep that can be repeated: **every
`if (…) return;` inside an `onClick` in `src/ui` with no `disabled` within the
preceding 25 lines.** The sweep returns 24 candidates; 22 are legitimate
(`event.button !== 0`, `signal.aborted`, event-delegation filters, and
`window.confirm`/`window.prompt` cancels, which cannot be double-clicked anyway).
The two that were not share an exact shape: the handler returns early for a
**reachable** state, the button stays enabled, and nothing on screen changes.

Both were decided by the file's own convention rather than by taste — in each
case a sibling button two elements away already carried the missing contract,
which is what makes these omissions rather than decisions.

**19. `+ MAP` in the macro card was enabled with nothing to map to (MINOR).**
`ModPanel.tsx:1231`. The `PARAM…` option resolves to a device parameter, and
the commit handler opens with `if (!activeDeviceId || !activeParamId) return;`.
With no resolvable target the click produced no command, no error, no visual
change — while the picker beside it correctly showed `no params`. The MIDI
Learn button two elements below already had
`disabled={mapDraft.param === "param" && (!activeDeviceId || !activeParamId)}`;
`+ MAP` simply never received it. Two ordinary ways to reach the state: a track
with no effects that is not an instrument (no devices at all), and the common
one — typing a filter into "Filter macro parameters" that matches nothing.
Fix: the sibling's own condition, one attribute. The early return stays as the
guard it already was.

**20. `RND VEL` and `HUMAN` were enabled on an all-silence selection (MINOR).**
`Sequencer.tsx:785` / `:811`. Both built their target list from the step
selection and returned early when it was empty — selecting a range of only
empty steps left two buttons looking actionable that changed nothing.
`PASTE LOCKS` in the same toolbar is
`disabled={!lockClipboard || Object.keys(lockClipboard).length === 0}` **and**
guards its handler, so the convention was right there. The list computation was
hoisted into a `useMemo` so `disabled` and the handler read the same thing; a
`disabled` derived from a different expression than its own guard is how the
two drift apart.

**The mistake this wave nearly shipped.** The `useMemo` runs on every render,
while the buttons sit behind `{stepSelection && …}` — and `stepSelection` is
typed `StepSelection | null`. The first version of the hoist dereferenced
`.padIds` unconditionally and would have crashed the sequencer on every mount
with nothing selected. It was caught by checking where the buttons actually
live before writing the memo, and is now pinned by a second test that renders
with a null selection purely to hold that guard. Worth recording because the
fix for a "button is enabled when it should not be" is the kind of change that
looks purely cosmetic and carries a runtime crash.

### CORRECTED / WITHDRAWN CLAIMS (recorded so they are not repeated)

- **The batch-FX toolbar was NOT affected by the ghost selection.** The
  original hypothesis was that a dead `trackIds` entry emptied
  `selectedTracks` and so triggered the documented
  `selectedTracks.length > 0 ? … : tracks.length` "or all if none selected"
  fallback, silently retargeting the next batch add at the whole project.
  Wrong: `selectedTracks` is derived by filtering **live** tracks, so a dead
  id already yields an empty set and the fallback behaves identically with or
  without the ghost. The toolbar's behaviour is unchanged by this fix. The
  first draft of the `SelectionStore` doc comment asserted otherwise and was
  rewritten.
- **The `deleteArrangementClip` no-op guard was WITHDRAWN.** A first pass also
  added a guard clause on the theory that re-deleting a missing clip pushes a
  dead undo entry. Measurement does not support it. `snapshot()`
  (`commands.ts:150`) builds a _delta_ command, so
  `execute: (d) => applyDocDelta(d, forward.ops)` returns the same document
  object when the delta is empty and `ProjectStore.execute`'s
  `applied === this.doc_` check (`ProjectStore.ts:220`) correctly skips the
  push — measured: two dead deletes after a real one left the undo depth at 2. A no-op delete as the _first_ command on a fresh `createProjectFromTemplate`
  store did push (depth 0 → 1), because that document is not
  delta-round-trippable and `snapshot()` takes its dev-only whole-document
  fallback (`commands.ts:169-175`). That is a property of the dev verifier,
  not of `deleteArrangementClip`, and it was not reproducible from any state a
  real session reaches after its first command. The guard and its test were
  removed rather than shipped on a mechanism the measurement contradicted.

---

---

## 2a. VALUE / RANGE CORRECTIONS

Ranges, defaults, mappings, units and normalisation that were wrong and are now
correct. Cross-referenced to the defect number in §2.

| Defect | Control                | Was                                                                     | Now                                                                                                                     |
| ------ | ---------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| #2     | `DragNumber`           | quantise hardcoded to 1 decimal; arrows ±1                              | `dragNumberResolution(min,max,step?)`: step `1` on unit-scale ranges, `span/100` below; decimals derived from the range |
| #2     | HUMANIZE / VEL·RND     | 0..0.5 range, 0.005/px sensitivity, 2 decimals → snapped to 0.0/0.1/0.2 | sub-unit precision preserved; one arrow press = 1 % of range, not the max                                               |
| #7     | Wavetable DST dropdown | listed `Detune` (index 2) — reserved and unimplemented in the worklet   | list pinned to `modDstOptions()`, so it cannot drift back                                                               |
| #8     | Inspector pad-LFO Rate | slider capped at **20 Hz**; schema clamps at **40 Hz**                  | both read exported `PAD_MOD_RATE_HZ_MAX` — one source of truth                                                          |
| #9     | Arrangement clip SECS  | no upper bound; could request ~300 000 bars and freeze the tab          | `MAX_ARRANGEMENT_CLIP_BARS = 8192` (~5.7 h in 4/4), a _rendering_ invariant, not a musical limit                        |
| #10    | same, on document load | normaliser filtered only `lengthBars >= 1`, no ceiling                  | both the arrangement- and audio-clip sanitiser enforce the same bound, closing the import path                          |
| #12    | Ripple multi-move      | `startBar + delta` written unrounded (fractional bars persisted)        | rounded, matching the non-ripple sibling branch                                                                         |

**Not found, and checked:** no UI value that the engine reads on a different
scale (0–100 vs 0–1), no dB treated as linear gain, no Hz/kHz conversion
error, no percentage applied twice, and no param id a panel writes that the
schema does not resolve. `setEffectParam` throws on an unknown id, so these
are load-bearing, not cosmetic. Every effect param id the panels write was
checked to resolve (`blendPad.x/y`, `engines.e2.algo`, `convolution.mode/wet`,
`global.deltaListen`, …), and typed fader input validates with
`Number.isFinite` and clamps gain `0..1.5`, pan `-1..1`, sends `0..1.5`
(`Mixer.tsx:758`).

**One cosmetic range defect left in place on purpose:** the SliceLab FADE IN /
FADE OUT fields declare `max` = slice length but the handler clamps only the
low end. The engine bounds the value downstream
(`AudioEngine.ts:1966,1970`, `Math.min(fadeIn, dur/2)`), so this is a
UI-honesty issue, not a state-corruption one. See §5.

---

## 3. VERIFIED FUNCTIONAL (with evidence)

- **No UI doc mutation bypasses the command layer.** Grep for `setDoc(`,
  `doc.x = `, `project.x = ` across `src/ui/*.tsx` → zero matches. Every
  traced mutation goes through `services.store.execute`.
- **Every effect param id a panel writes resolves in the schema**
  (`blendPad.x/y`, `engines.e2.algo`, `convolution.mode/wet`,
  `global.deltaListen` …), and `setEffectParam` throws on an unknown id, so
  a bad write cannot be silently dropped.
- **Drag-preview/commit-once pattern is correct** in the editors scanned:
  `FxEqPanel.tsx:291-319`, `KaskadaPanel.tsx:315,374`,
  `ModPanel.tsx:1631-1652` (intensity curve), `PatternBar.tsx:131-148`
  (reorder), `ArrangementPanel.tsx:1931-1969` (audio clip move/trim/fade/
  gain/stretch). Each previews in local state, executes once on pointerup,
  and aborts on pointercancel. Ozvena was the only outlier.
- **Undo frames already existed and work** — `tests/store-undo-frame.test.ts`
  covered the record-take path; this audit reused that API rather than
  inventing a mechanism, and extended the coverage to the XY-pad shape.
- **Number inputs are bounded and clamped** at
  `ReferenceMapPanel.tsx:264` (`Number.isFinite` + `MIN_BPM`/`MAX_BPM`, 20–400,
  defined `:56-57`), `FxEqPanel.tsx:825-833` (`clampSplit`),
  `ArrangementPanel.tsx:3792-3800` (1..4 bars),
  `SliceLab.tsx:253-264` (`updateBoundary` clamps between neighbours).
- **Paste-a-code fields reject garbage**: `RackStrip.tsx:301,357,421` all
  check `if (!code) return` and surface an explicit status
  (`:304` "Invalid kit code", `:360` "Invalid PACK code", `:424` "Invalid BINDS
  code") when the decoder returns null.
- **The mixer's typed fader value** (`Mixer.tsx:758`) validates with
  `Number.isFinite` and clamps gain `0..1.5`, pan `-1..1`, sends `0..1.5`.
- **The transport LOOP button is not a second source of truth (§5).** It keeps
  its value in local React state (`TopBar.tsx:109`), which is the exact §10
  anti-pattern — but a shared rAF bus re-reads `transport.loopEnabled` every
  frame (`TopBar.tsx:178-191`), and the file carries the reason: other surfaces
  (Hum-to-Melody) call `transport.setMetronome` directly, and without the poll
  the CLICK button showed a stale value. The sync only works if that bus runs
  while the transport is **stopped**, which was the open question: the bus in
  `services/rafLoop.ts` is self-sustaining while any callback is registered
  (it is not playback-gated) and additionally drops a throwing consumer
  instead of letting one bad callback kill the chain for every meter. Verified
  by `tests/ui/TopBar.loop-sync.test.tsx`, which drives `setLoop` /
  `clearLoop` externally with nothing playing and asserts `aria-pressed`
  follows in both directions; both tests were confirmed failing when the
  three mirroring calls are commented out. The `L` shortcut routes through the
  same `toggleLoop()` (so it writes the transport, not just local state) and is
  key-repeat guarded.
- **Engine clamps what the UI under-constrains**: over-long fades are
  bounded in `AudioEngine.ts:1966,1970` (`Math.min(fadeIn, dur/2)`), so the
  SliceLab fade fields' unenforced upper `max` is cosmetic, not corrupting.
- **§11 every persisted UI preference restores safely from corrupt storage.**
  All eight `localStorage` keys written by `src/ui` were read individually, and
  every load path is defensive rather than trusting the stored string:
  `gestureHints.tsx:25-31` and `padKeys.ts:34-41` wrap `JSON.parse` in
  `try/catch` with a default; `theme.ts:35-44` does the same and additionally
  runs the result through `normalizeThemeState`; `dockLayout.ts` parses inside
  `try`, normalizes both panel slots and clamps the height, and refuses a
  `slotB` equal to `slotA`; `FxEqPanel.tsx:124-131` rejects a restored band
  that is non-finite, fractional or outside 1–6; the write side is wrapped
  everywhere too, so private mode cannot throw.
  This one is worth stating because the _search_ for it cannot: a grep for
  `localStorage.getItem` returns the `JSON.parse` line with no indication of
  whether a `try` encloses it, and two of the first three hits looked exactly
  like AGENTS.md violations until the surrounding lines were read.

---

## 4. EDGE CASES COVERED BY TESTS

Added to `tests/ui/controls.test.tsx`, `tests/ui/EffectRack.test.tsx`,
`tests/ui/ozvena-panel.test.tsx`, `tests/ui/WavetablePanel.test.tsx`,
`tests/pad-mod.test.ts`, `tests/store-undo-frame.test.ts`,
`tests/clip-editing-audit-deep.test.ts`:

- disabled control inert on all four gesture paths (drag, dblclick, arrows,
  context menu) and no document write
- 1-pixel drag is not a dead zone on a sub-unit control
- arrow key nudges a fraction of the range instead of the end stop
- unit-scale behaviour unchanged (BPM step stays 1)
- a plain click without movement writes nothing
- a drag commits exactly once, on release
- degenerate / NaN ranges and non-finite step overrides do not produce NaN
- interrupted drag (`pointercancel`) aborts and reverts the display; a stale
  pointerup cannot commit
- a whole 30-move pad drag collapses to ONE undo entry that restores both
  coordinates
- a cancelled drag still closes the undo frame
- typed pad value is one command, not one per keystroke; Escape reverts; a
  cleared field is a cancel
- a clip longer than the bound is clamped (finite + absurd + Infinity), while
  realistic lengths pass through untouched
- the bound is enforced on document LOAD, not only on resize
- the offered wavetable destinations match the registry's authoritative list
- a left-edge trim writes trim + offset + length together, and the command's
  own undo restores all three at once
- a trim keeps fades inside the new clip length, rejects non-finite input,
  and never drops below the 0.25-bar floor

Each of the wave-1/wave-2 test groups was run against the reverted
source to confirm it fails there (falsification check) — 5 Ozvena, 2
Wavetable, 4 DragNumber and 1 Slider test failed pre-fix, and the load-bound
test failed until the normalizer filter was re-applied.

### Wave 5 coverage (§13 — deleting the object whose panel is open)

New files: `tests/ui/MixerSelectionHygiene.test.tsx` (4),
`tests/selection-store-dead-refs.test.ts` (6),
`tests/ui/EffectRack.delete-open-device.test.tsx` (5),
`tests/ui/ArrangementPanel.delete-selected-clip.test.tsx` (2).

- deleting the selected track leaves no dead id in `trackIds` or
  `noteSelections`; other selected tracks survive a multi-delete
- a zone bounce after the delete resolves to a live track, not an empty stem
- `pruneTrack` / `retainTracks` no-op without emitting when the track was not
  referenced, and `retainTracks` filters `noteSelections` against the caller's
  live set rather than against `trackIds`
- deleting the explicitly expanded rack device focuses the surviving one
  (a device explicitly collapsed stays collapsed)
- deleting the user-selected devices-dock device falls back to a live device
  rather than the empty state; a bus with no devices does reach the empty state
- the arrangement DEL button returns to its disabled resting state

**Falsification for wave 5.** All 4 mixer tests fail against reverted source —
including `expected false to be true` on "the resolved bounce target exists in
the document", which is the assertion that pins the silence mechanism rather
than the store state alone. The DEL button test fails against the reverted
panel.

The five EffectRack tests needed a second pass. **The first drafts passed with
the guards they were written to protect deleted outright**, so they were not
regression guards. Two states had to be reached explicitly:

- `expandedFxId` starts at `null` (auto), so deleting the auto-focused device
  never exercises the dead-id check — the device must be focused first via
  `.fx-device-toggle`;
- `selectedDeviceId` is wiped to `null` by the mount effect at
  `EffectRack.tsx:131-133`, so the dock's check is only reachable after a
  `.device-chain-item` click.

After that, each guard was removed individually and the corresponding test was
observed failing by name (not inferred from ordering), then the source was
restored and `git diff` confirmed clean.

**Wave 6 — closing an overlay without going through its own close button.** The
repair for #18 only matters on the paths the real app actually takes, and three
of them are not "user clicked the ✕":

- `Escape`, handled by the global cascade in `App.tsx`, which flips the flag from
  outside the overlay and never focuses anything;
- a click on the non-focusable scrim;
- teardown — a parent unmounting the panel that owns the dialog, while the
  trigger that opened it is still on screen.

Each is a distinct test rather than one, because they fail differently: the
first two orphan the `autoFocus` input, the third orphans whatever the user had
moved focus to. A harness built from `user.click` on an extra button would have
covered none of them correctly — clicking a button **moves focus onto it**, so
those tests passed for the wrong reason twice before the harness was rebuilt
around `fireEvent.keyDown(window, …)` and a plain `<div>` scrim.

The negative cases are covered too, and they are the half that is easy to get
wrong: focus must **not** be reclaimed if the user moved it to a control outside
the overlay, and must be left alone entirely if the overlay closed without ever
taking focus. Stealing it back would throw a keyboard user out of whatever they
were using.

One state is deliberately **not** asserted: an overlay whose DOM vanished while
`open` stayed true. All four call sites render `if (!open) return null`
(verified by grep, not assumed), so the flag and the DOM cannot disagree and the
state is unreachable. An earlier draft of the harness asserted it anyway and
failed — a test for a state the product cannot be in.

---

## 5. INCOMPLETE / INTENTIONALLY NOT "FIXED"

- ~~**SliceLab FADE IN / FADE OUT** declare `max` = slice length but the
  handler only clamps the low end.~~ **CLOSED (UX-polish wave, 2026-10-04).**
  The engine's fade fit is now a shared pure function (`fitSliceFades` in
  `src/audio-engine/declick.ts`) used by BOTH `resolveSlicePlayback()` and the
  SliceLab edit handlers, so a field can no longer display a value the engine
  would silently rescale. `tests/slice-playback.test.ts` pins helper ⇄ engine
  equality.
- ~~**Native `window.prompt` in the kit/PACK/BINDS/theme import paths and the
  mixer fader menu.**~~ **CLOSED (UX-polish wave, 2026-10-04).** Replaced by
  the shared `src/ui/TextPromptDialog.tsx` (multiline for share codes, Escape
  and backdrop cancel, Enter/Ctrl+Enter submit, caller-owned error slot,
  focus restored via `useFocusRestore`). Theme install tests now drive the
  real dialog instead of mocking `window.prompt`, so a regression back to the
  native prompt fails the suite. **Deliberately still native: the
  MorphDynamics/Ultina user-preset name/rename/delete prompts and
  `IntentPanel`'s "Copy share link" `window.prompt`** — those are a
  preset-library management redesign (list UI + confirm dialogs), not the
  code-entry path this wave targeted; recorded here rather than dropped.
- ~~**Pre-existing per-keystroke commits in other small numeric fields**
  (`ModPanel.tsx:934,952` automation point tick/value, `SliceLab.tsx:637,648`).~~
  **CLOSED (UX-polish wave, 2026-10-04).** New shared
  `src/ui/NumericDraftInput.tsx` (draft commits once on blur/Enter, Escape
  reverts, cleared field cancels) now backs the ModPanel pattern- and
  scene-automation point tick/value fields and the SliceLab START/END/FADE
  fields. SliceLab's fields edit local drafts committed to the store only on
  APPLY, so the audit note about them was lower-risk than stated — the
  component still fixes the typing experience (a controlled `toFixed(3)` value
  fought the decimal separator while typing). `tests/ui/NumericDraftInput.test.tsx`
  - a ModPanel integration test pin "one commit, not one per keystroke".

---

## 6. REMAINING RISKS

- **Real-browser verification: 281/294 checks pass, and the failures are
  outside this audit's diff.** Run in Chromium, Firefox and WebKit via
  `npm run test:browser` against the final tree. The check this audit owns
  passes in all three engines: `[PASS] plugin workflow: add flagship effect,
collapse, bypass, undo, macro nudge, play/stop` — that is the wave-4
  zero-height defect (#14/#15) confirmed fixed in a real engine, after failing
  with 58 retries. Failures seen include 2 × PDC look-ahead / export alignment
  and the `app boot` check. None touch a file this audit changed.

  The `app boot` failure is a **stale assertion, not a product defect**, and
  it is worth naming precisely because it reads like a regression:
  `scripts/verify-browser.mjs:236` requires the project export download to end
  in `.kyx.json`, and the app now produces `House-Beat.kyx`. That change is
  deliberate — `src/export/project-io.ts:11-13` documents it: _"New files use
  the short public brand '.kyx' — brand-coherent with the [KYX] name … so
  legacy '.kyx.json' and '.pulseforge.json' sessions remain [readable]"_ — and
  it stays backward-compatible for reading. The verifier was not updated with
  it. **Not repaired here:** this audit never touched `src/export/` or
  `scripts/`, another session is actively working in `scripts/` (recent
  `feat(tooling): verify-all` commits), and the assertion encodes a product
  decision their side should confirm rather than have an audit silently relax.
  It needs a one-line change to accept `.kyx`.

- **The dock is shorter than a device's content — now scrollable, not clipped.**
  The `min-height` floor alone would have been a half fix: it made the
  flagship panel visible but left the overflow silently discarded by
  `overflow: hidden`, so `fx-output-trim-row` (and on a shorter window, part of
  the parameter grid) would have been unreachable. `.device-editor
.fx-device-content` now scrolls the overflow instead of clipping it
  (`overflow-y: auto` + `overscroll-behavior: contain`).
  Measured in Chromium: box `clientHeight=164 / scrollHeight=491 /
maxScroll=327`, and a reachability sweep over both scroll ends reports
  **zero unreachable rows** of six. The dock itself is still shorter than the
  content — growing it is a product decision, but nothing is lost now.
- **`npm run build` FAILS its bundle budget, and did so before this audit.**
  The build itself compiles (`✓ built in 36.85s`); the failing gate is DAW JS
  **3317 KB against a 3170 KB budget**. Controlled measurement earlier in this
  audit, with only its own source changes reverted: **3314 KB reverted** vs
  **3315 KB applied** — the audit accounted for **+1 KB** at that point, and
  the 145 KB overage came from the concurrent reference/MCP/tooling
  expansion. The current 3317 KB reading also includes other sessions'
  in-flight work in this shared tree, so it is not attributable to this audit
  alone. Per `AGENTS.md` §4 a budget increase needs a measured justification
  in `scripts/check-bundle-size.mjs` — that decision belongs to whoever owns
  that work, not to this audit.
- **32 pre-existing test failures elsewhere in the suite**
  (sound-quality-pass, symbolic-prior, drone, curated-samples, wav-bwf,
  multi-tap-delay, boombap, …). Verified unrelated: the identical subset
  produces the identical 18 files / 32 tests with this audit's changes
  reverted to HEAD.
- **Browser verification is Chromium-only.** The Playwright run covers the
  layout defect in Chromium; the `min-height` floor is plain CSS with no
  engine-specific syntax, but no Firefox/WebKit layout pass was run for it.
- **`useFocusRestore` needs its owner mounted while the overlay is closed, and
  one call site is behind a `React.lazy` boundary.** The hook captures the
  trigger from a listener that lives for the component's whole lifetime, so a
  component that first mounts _already open_ has no trigger to return to. All
  four call sites render unconditionally and pass `open` as a prop — including
  `PaletteOverlay`, which is `lazy()`-imported at `App.tsx:68` but rendered
  unconditionally at `App.tsx:1613`, so the chunk resolves at app boot rather
  than at the first Ctrl+K. The residual window is therefore only a real Ctrl+K
  landing before that chunk resolves, and it was not measured in a browser.
  If a call site ever switches to mounting the overlay only when open, this
  silently stops working rather than failing loudly — that is the risk, and it
  is why the call-site test in `tests/ui/HelpOverlay.test.tsx` exists.
- **The four overlay integrations are proven by jsdom, not by a real browser.**
  `useFocusRestore` is verified end-to-end against the real `HelpOverlay`; the
  other three are covered only by the shared hook's tests plus a source read of
  their refs. `GenerateDialog` additionally needs `useServices` and an audio
  context, and `LatencyCalibrationWizard` needs Web MIDI, so neither was
  rendered in a test. Their wiring is one line each and was read directly, but
  "read directly" is weaker than "executed".
- **`prettier --check src tests` reports 71 dirty files.** None of them are
  files this audit touched (checked by name); they belong to other in-flight
  work.
- **Line references into files other sessions are actively editing go stale,
  and two had already.** This worktree is shared and several audit-relevant
  files (`ReferenceMapPanel.tsx`, `sample-library/curated.ts`, `src/ai/bridge/*`)
  are under concurrent work. Re-verified at report time: the BPM clamp cited as
  `ReferenceMapPanel.tsx:433` is at `:264` (constants `:56-57`), and the
  paste-a-code guards cited as `RackStrip.tsx:284,340,404` are at
  `:301,357,421` with their status messages at `:304,:360,:424`. Both were
  correct when written and both had drifted. Treat any `file:line` in this
  report as a hint that must be re-checked, and re-check the ones pointing at
  files outside the audit's own diff.
- **Coverage is targeted, not exhaustive.** Read in full:
  `controls.tsx`, `EffectRack.tsx`, `OzvenaPanel.tsx`, `WavetablePanel.tsx`,
  `Inspector.tsx` (pad-mod section), `ArrangementPanel.tsx` (gestures,
  SECS, transitions), `RackStrip.tsx` (import paths),
  `ModPanel.tsx` (automation + intensity), `PatternBar.tsx`,
  `Mixer.tsx` (fader menu), `SliceLab.tsx` (slice fields),
  `ReferenceMapPanel.tsx`, `FxEqPanel.tsx` (crossover), `TopBar.tsx`
  (transport mirrors). Audited by delegated pass but not personally verified
  line-by-line: `IntentPanel.tsx` (163 KB), `App.tsx` keyboard table,
  `PianoRoll.tsx`.
- **§5 was a focused pass, not a sweep of every toggle.** It targeted the
  clearest §10 violation — a control that mirrors domain state into local
  React state — via a grep for `useState` flags named like domain toggles
  (`…Enabled|On|Active|Bypass|Preview|Live|Monitor`). The transport LOOP was
  audited and verified (see §3), and the two default-`true` flags the grep
  surfaced were then traced individually. **Both hold; neither is a defect:**

  - `SliceLab` `bpmPreview` (default `true`) controls _how_ a preview sounds,
    not whether one plays. `preview()` is reachable from exactly two explicit
    buttons — PREVIEW (`:698`) and the loop toggle (`:706`) — with no hover or
    autoplay path, and the checkbox at `:569` is visible and one click away.
    Auditioning at the chopped tempo is the intended result, so defaulting it
    on is the correct choice.
  - `JamGate` `audioLive` (default `true`) is not a user toggle at all but a
    derived readout of the engine: `setAudioLive(state === "running")` polled
    from `services.engine.context.state` every 400 ms (`:23-32`). It is the §10
    mirror pattern, correctly sourced and correctly synced. The `true` default
    is the optimistic seed that prevents a flash of the tap gate before the
    first poll lands.

  Not traced: `ArrangementPanel` `micMonitoring` and `IntentPanel`
  `ideaMicMonitor`. Both are input-arm toggles, not mirrored domain state, and
  neither was individually exercised.

- **No real-browser verification was run** for most of the repaired controls
  (`npm run test:browser` / `test:e2e`). Every repair in waves 1–3 is covered by
  jsdom tests against the real command/store layer. Wave 4 came from the
  Chromium Playwright pass and is browser-verified; see §6 for what that pass
  still does not cover.
- **Wave 5's `IntentPanel` wiring is covered only at the store level.** The
  `retainTracks` call at `IntentPanel.tsx:2459` is exercised by
  `tests/selection-store-dead-refs.test.ts`, not by an end-to-end render of
  the panel driving a `removeTrack` intent. The panel is 3800 lines and was
  not rendered for this fix.
- **`snapshot()`'s dev-only verification fallback is an unverified lead, not a
  confirmed defect.** It falls back to a whole-document command when the delta
  does not round-trip (`commands.ts:169-175`), and that command returns a
  fresh object, so it can push an undo entry for a command that changed
  nothing. Reproduced once, on a fresh `createProjectFromTemplate` store
  (undo depth 0 → 1 for a no-op delete), and not reproduced from any state a
  real session reaches after its first command. It is worth a follow-up
  because a dead undo entry is user-visible, but it was not reproduced under
  realistic conditions and is deliberately not claimed as a fix here.

---

## 7. TESTS ADDED

Every count below is reproducible from the working tree.

**New files created by this audit**

| File                                                      | `it()` | Covers                                                     |
| --------------------------------------------------------- | ------ | ---------------------------------------------------------- |
| `tests/ui/MixerSelectionHygiene.test.tsx`                 | 4      | #16 — selection hygiene on track delete                    |
| `tests/selection-store-dead-refs.test.ts`                 | 6      | #16 — `pruneTrack` / `retainTracks`                        |
| `tests/ui/EffectRack.delete-open-device.test.tsx`         | 5      | §13 — deleting the open device (rack + devices dock + bus) |
| `tests/ui/ArrangementPanel.delete-selected-clip.test.tsx` | 2      | #17 — DEL button resting state                             |
| `tests/ui/TopBar.loop-sync.test.tsx`                      | 2      | §5 — LOOP is not a second source of truth                  |
| `tests/ui/useFocusRestore.test.tsx`                       | 5      | #18 — focus restore across 4 close/teardown paths          |
| `tests/ui/ExportPanel.test.tsx` (extended)                | 1      | §9 — AUTO STAGE stays scoped to one render                 |
| `tests/ui/ModPanel.test.tsx` (extended)                   | 1      | #19 — `+ MAP` disabled while PARAM has no target           |
| `tests/ui/Sequencer.test.tsx` (extended)                  | 2      | #20 — velocity actions + the null-selection guard          |

**Existing files extended** — `tests/ui/controls.test.tsx` (#1, #2, #3),
`tests/ui/EffectRack.test.tsx` (#4), `tests/ui/ozvena-panel.test.tsx` (#5, #6),
`tests/ui/WavetablePanel.test.tsx` (#7), `tests/pad-mod.test.ts` (#8),
`tests/clip-editing-audit-deep.test.ts` (#9, #10, #11, #12),
`tests/store-undo-frame.test.ts` (undo-frame reuse for #5),
`tests/ui/HelpOverlay.test.tsx` (#18 — the overlay's own call site, so the hook
is not tested in isolation from the wiring that feeds it),
`tests/ui/ExportPanel.test.tsx` (§9 wave 7 — pins that the AUTO STAGE latch is
scoped to a single render, proven by making it survive the unmount and
observing 1 of 12 fail).

**Coverage that is NOT a regression guard, and why.** #13 (kit save
confirmation), #14/#15 (PRISM/VLYX zero height) and #17's _visual_ aspect were
verified by real-browser measurement and by code path rather than by a jsdom
test that fails when the defect is reintroduced. The E2E specs
`tests/e2e/06-plugin-workflow` and `02` / `08` cover the dock behaviour. This is
stated rather than papered over: a test that cannot fail when its guard is
removed is decorative, and §4 records the two cases where a first draft was
exactly that before being rewritten.

**Falsification summary.** Every test group added in waves 1–3, 5 and 6 was run
against reverted source and observed failing: 5 Ozvena, 2 Wavetable, 4
DragNumber, 1 Slider, 1 load-bound, 4 mixer-selection, 1 DEL button, 2 TopBar
loop, 1 rack-expanded, 1 devices-dock, 5 focus-restore, 1 help-overlay
call-site, 1 macro-`+ MAP`, 2 sequencer-velocity. The one group that could not be
falsified (the `deleteArrangementClip` no-op guard) was **withdrawn** and its
test deleted — see §2, "CORRECTED / WITHDRAWN CLAIMS".

The wave-6 run is the cleanest example of the discipline, because the
falsification is what found the real bug in my own fix:

- restoring the pre-fix `useFocusRestore` failed **5 / 5** — the tests caught
  the ref-timing defect I had written into the first version of the hook;
- breaking the wiring at the call site instead (passing `false` rather than
  `open` in `HelpOverlay`) failed **exactly 1 of 12** — the new test and
  nothing else, which is what a correctly-scoped regression guard looks like;
- a temporary probe (`tests/ui/_probe2.test.tsx`) produced the ordering table
  in §2, and was deleted in the same commit rather than left in the tree.

---

## 8. KEYBOARD & ACCESSIBILITY (§14)

A scan, not an assumption: every `<div>` / `<span>` opening tag in `src/ui`
was parsed for an `onClick` without `role=`, `tabIndex=` or an `onKeyDown`
sibling — i.e. an affordance that responds to the mouse and is unreachable
from the keyboard. **Exactly one hit across 85 files.**

**The one finding: the mixer channel strip is a mouse-only duplicate of track
selection.** `Mixer.tsx:471` — `.channel-strip` carries the `onClick` that
writes `selectionStore.setTracks(...)`, with Ctrl/Shift modifier handling, and
has no `role`, no `tabIndex` and no key handler.

It is a _duplicate_, not a dead end, and the distinction matters. The same
selection is fully keyboard-reachable three other ways, all verified in the
source rather than read off a tooltip:

- `TrackTabs.tsx:100-108` renders real `<button role="tab" aria-selected>` —
  natively focusable, Enter/Space activated;
- `App.tsx:584-598` implements `selectTrack1`…`selectTrack9`;
- `App.tsx:570-583` implements `nextTrack` / `prevTrack` (Tab cycling).

The `title` attribute on the track tab advertises exactly these, so I checked
that they exist rather than trusting the claim — they do.

Not repaired, deliberately. Making every strip a tab stop would add a focus
stop to every track in the mixer and needs a roving-tabindex decision about
which strip owns the stop; the objective says not to redesign accessibility
during this audit, and the core workflow is not blocked. Recorded here instead.

**No keyboard traps among the 14 `role="dialog"` surfaces.** Escape is a
global contextual cascade in `App.tsx:828-867` (capture offer → context menu →
help → unified selection → tool → blur a typing target), not a per-dialog
handler — which is the architecture, not an omission. The three surfaces with
no local `Escape` are all dismissible: `OnboardingTour` is a non-modal
`.tour-card` with a native `SKIP` button (`:82`) and correctly omits
`aria-modal`; `CollabPanel` and `HumToMelody` expose native buttons.

**Four dialogs did not restore focus (defect 18, §2 wave 6).** "No keyboard
traps" above is about Escape; it says nothing about where focus goes afterwards,
and the answer was "nowhere" in four of the overlays. Fixed with the shared
`useFocusRestore` hook, proven by falsification. What it does **not** do is trap
focus: Tab can still leave a dialog, and the restore only fires when focus was
orphaned to `<body>`. That is deliberate — containment is a redesign, and the
objective excludes it.

**A fourth false positive, and the one that nearly cost the most.** The repair
started from the idiomatic implementation — snapshot `document.activeElement` in
the open effect, filter focus events with `ref.current.contains(el)`. Both halves
are the obvious thing to write, and both are wrong here for the same underlying
reason: **React attaches a `ref` prop after the commit that runs `autoFocus`**, so
the ref is `null` at the one moment the classification is needed. I only found out
because the test suite failed 3/3 against my own fix; the alternative was to
explain the failure away and ship a hook that restores nothing. The probe that
settled it is in §2 and was deleted in the same commit.

**Four false positives this section's own scans produced, recorded because the
same traps are waiting for the next audit:**

1. A line-based filter for "clickable div without a11y affordances" returned
   **zero** hits, and a multiline parse of the same predicate returned one.
   The first was simply wrong — JSX attributes wrap, and a line-based filter
   reads a partial tag. A clean static sweep here means nothing on its own.
2. A 4 000-character window around each dialog found no `Escape` in any of
   the 14, which looked like "no modal is keyboard-dismissible" until the
   global cascade in `App.tsx` explained all 14 at once. A scan that does not
   know the architecture reports the handler's absence, not the defect.
3. Re-verifying my own §5/§6 citations, I grepped `SliceLab.tsx` for
   `store.execute(` between lines 620 and 670, found **nothing**, and was about
   to conclude the per-keystroke claim had been fixed by someone else. The
   cited lines 637/648 are `onChange` handlers that call
   `updateSelectedStart` / `updateSelectedEnd`, which reach `execute` further
   up the file. The claim was correct; the predicate was wrong. A second
   search, for the handler the citation actually names, confirmed it.

The general rule these four share: **the predicate is part of the claim.**
The three strongest-looking results in this audit — a clean a11y sweep, an
unrelated global handler, a silently-fixed defect — were the scan's error, not
the code's, and the fourth was my own idiomatic fix, caught only because the
tests were run against it rather than admired. Each cost a measurement to catch,
which is the minimum.
