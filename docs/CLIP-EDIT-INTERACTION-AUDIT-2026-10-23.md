# Clip / Stem Editing Interaction Audit — 2026-10-23

**Scope.** Every editing interaction applied to a timeline object: audio clips
(recordings, takes, stems, samples), scene clips, MIDI lanes and automation
lanes. The chain traced is the whole one:

```
pointer / keyboard → interaction handler → edit command → timeline/domain state
→ audio source boundaries → playback / render result → persistence → undo/redo
```

**This is wave 3.** Wave 1 and wave 2 live in
`docs/EDITOR-HARDENING-AUDIT-2026-10-22.md` (F1–F16): the trim gesture, the
waveform window, the zoom bug, the undo window, the MIDI phase, the timeline
reach, the ruler, the history pairing, the slice fragments, the drag preview
bar unit. **This wave does not repeat them.** It audits the operation MATRIX
itself — what each verb changes, whether it can be undone, whether it
survives a save, and whether the result is audible.

---

## 1. Method — the matrix as an executable artifact

The audit's central claim ("do not assume an interaction works because the UI
visually moves") is only testable if the question is asked of the DOMAIN, not
of the screenshot. So the matrix was encoded as three suites that every clip
verb must pass:

| Axis                   | Question                                                                 | Owner of the truth                                                   |
| ---------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| **Property isolation** | Which fields did this verb change?                                       | the command layer (`src/commands/`)                                  |
| **Undo / redo**        | Does one gesture produce one history entry, and does it restore EXACTLY? | `ProjectStore` + the delta engine (`src/commands/core.ts`)           |
| **Persistence**        | Does the edited clip survive a save/load round trip unchanged?           | `normalizeProject` (the loader's normalizer)                         |
| **Audibility**         | Does the edited clip still PLAY what the editor DRAWS?                   | `audioClipPlayWindow` (engine) vs `audioClipWaveformWindow` (editor) |

The suites are:

- `tests/clip-edit-matrix.test.ts` — the operation matrix (verbs, edge cases,
  lock, group, overlap, snapping, multi-select).
- `tests/clip-edit-audio-integrity.test.ts` — the audible leg.
- `tests/clip-edit-gesture-history.test.ts` — the gesture/history leg.
- `tests/scene-clip-edit-matrix.test.ts` — the SCENE lane's own matrix.
- `tests/tick-lane-edit-matrix.test.ts` — the TICK lanes' matrix (MIDI and
  automation).

The property-isolation axis is an ALLOW-list: each verb declares the fields it
owns, and any other field that moves fails the test. That is what turns "the
clip looks right" into "the clip changed exactly what it was asked to change".

**The two lanes have different contracts, so they get different matrices.** The
audio lane LAYERS (overlapping clips are summed) and measures length in
fractional bars; the scene lane is INTEGER-BAR, REFUSES an overlapping
placement, and maps a visible range onto the scene's content through two
offsets — the pattern phase (wraps modulo the pattern, because the pattern
loops) and the scene-automation offset (grows without bound, because the
intensity curve does not). A matrix built on the audio lane's assumptions
would pass while the scene lane was broken; a matrix built on the scene lane's
assumptions would fail the audio lane's layering. Both exist now.

---

## 2. Verified editing operations

Every row below is covered by an executable spec in the three suites above.

| Operation             | Command                                | Isolation                                 | Undo/redo    | Persistence | Audible                                    |
| --------------------- | -------------------------------------- | ----------------------------------------- | ------------ | ----------- | ------------------------------------------ |
| move                  | `moveAudioClip`                        | `startBar` only                           | ✅ exact     | ✅          | ✅ window unchanged                        |
| drag (block)          | `nudgeClips`                           | `startBar` only                           | ✅ one entry | ✅          | ✅                                         |
| resize (right edge)   | `resizeAudioClip`                      | `lengthBars` (+fade clamp)                | ✅ exact     | ✅          | ✅ plays less source                       |
| trim start            | `trimAudioClipStart`                   | `startBar`, `lengthBars`, `offsetSec`     | ✅ ONE entry | ✅          | ✅ advances the source by the trimmed time |
| slip                  | `slipAudioClip`                        | `offsetSec` only                          | ✅           | ✅          | ✅ window shifts by the slip               |
| stretch               | `stretchAudioClip`                     | `lengthBars`, `stretchRate` (+fade clamp) | ✅           | ✅          | ✅ source-per-wall factor respected        |
| fade in / out         | `updateAudioClip`                      | `fadeIn` / `fadeOut` only                 | ✅           | ✅          | fade never outlives the clip               |
| gain                  | `updateAudioClip`                      | `gain` only                               | ✅           | ✅          | —                                          |
| reverse               | `updateAudioClip`                      | `reverse` only                            | ✅           | ✅          | ✅ window starts at the high edge          |
| mute clip             | `toggleAudioClipsMute`                 | `muted` only                              | ✅           | ✅          | ✅ leaves the scheduler                    |
| loop / repeat         | `updateAudioClip` (flag)               | `loop` only                               | ✅           | ✅          | ✅ the engine repeats the content region   |
| split                 | `splitAudioClipAtTick`                 | the two fragments                         | ✅           | ✅          | ✅ fragments tile the source               |
| copy / duplicate      | `duplicateAudioClip`, `duplicateClips` | —                                         | ✅           | ✅          | ✅ same source window                      |
| paste                 | `pasteClips`                           | —                                         | ✅ one entry | ✅          | ✅ same source window                      |
| cut                   | `cutClips`                             | —                                         | ✅ one entry | ✅          | ✅                                         |
| delete                | `deleteAudioClip`                      | —                                         | ✅           | ✅          | ✅                                         |
| crossfade             | `crossfadeAudioClips`                  | `fadeIn`/`fadeOut` only                   | ✅           | ✅          | —                                          |
| nudge (keyboard)      | `nudgeClips`                           | `startBar` only                           | ✅           | ✅          | —                                          |
| lock / unlock         | `setClipsLocked`                       | `locked` only                             | ✅           | ✅          | —                                          |
| group / ungroup       | `groupClips` / `ungroupClips`          | no clip field                             | ✅           | ✅          | —                                          |
| layer / overlap       | (audio lane layers)                    | —                                         | ✅           | ✅          | ✅ both clips sound                        |
| snap to grid          | `snapBar` / `snapDelta`                | —                                         | —            | —           | —                                          |
| snap to edge / marker | `snapBarToTargets`                     | —                                         | —            | —           | —                                          |

**The table above is the AUDIO lane.** The other three lanes have their own
contracts and their own matrices: the scene lane (§3), the MIDI and
automation lanes (§4), and the audio lane's audible leg (§9).

**The lock contract is narrower than "locked clips are frozen", and the matrix
pins the real one:** a locked clip refuses every GEOMETRY verb (move, resize,
trim, split, slip, stretch, delete, crossfade, source-position patches) and
stays MIXABLE (gain, fades, mute). That is the §29 contract, and it was
verified as written rather than assumed.

---

## 3. The scene lane (regions)

The scene (arrangement) lane got its own matrix — 14 specs — because its
contract is not the audio lane's contract. What it pins:

| Contract                       | Verified                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Integer bars**               | a fractional move rounds to a whole bar (8.6 → 9), a fractional resize rounds (2.4 → 2)                                                                                                                 |
| **No overlap**                 | a move, resize or add that would overlap a neighbour is REFUSED (`/overlap/`), and the refused verb changes nothing — the audio lane would have LAYERED the same pair                                   |
| **Content continuity (trim)**  | a head trim advances the pattern phase by the elapsed ticks, wrapping modulo the pattern length, and advances the scene-automation offset by the same amount without wrapping; the end edge never moves |
| **Content continuity (split)** | the right fragment continues the pattern phase and the scene offset; the left fragment keeps the original id (so its transitions stay attached)                                                         |
| **Trim/split commute**         | trimming then splitting reaches the same content state as splitting then trimming                                                                                                                       |
| **Duplicate**                  | carries the phase, the scene offset and the loop flag, and lands after its source without overlapping                                                                                                   |
| **Lock**                       | refuses move/resize/delete/split/trim; a duplicate stays allowed                                                                                                                                        |
| **Undo/redo**                  | every scene verb is ONE history entry and restores the document exactly; redo re-applies it exactly                                                                                                     |
| **Persistence**                | an edited scene clip round-trips with its phase, scene offset, loop and geometry unchanged                                                                                                              |
| **Delete**                     | removes the clip and unlinks its markers; nothing survives the round trip                                                                                                                               |
| **NaN / negative**             | a NaN placement lands at bar 0 and never poisons the document                                                                                                                                           |

**No defect found in the scene lane.** Its continuity math is the part most
likely to be wrong in a DAW — a split that does not advance the phase replays
the same pattern material in the second half — and it is correct, and now
pinned.

---

## 4. The tick-addressed lanes (MIDI and automation)

Two more lanes, addressed in TICKS rather than bars, and with their content
living OUTSIDE the clip. They got their own matrix — 25 specs — because their
contracts differ from every other lane's.

**The MIDI lane** points at a PATTERN. Its visible range maps onto the pattern
through `phaseOffsetTicks`, and the pattern repeats until the range ends. The
period is the PHRASE length, not the step grid: a note may outlive the grid,
and both the renderer and the scheduler repeat at the phrase length. A trim or
a split that wrapped the phase against the GRID would play different notes at
different times — a defect an earlier wave repaired in the command layer and
that this matrix now pins against regression.

**The automation lane** carries its POINTS, in SOURCE-relative ticks. The
visible window starts at `phaseOffsetTicks` into that source curve, so a trim
advances the PHASE and leaves the points alone — and a point the user adds at
visible tick 0 lands at source tick = phase.

What the matrix pins:

| Contract                     | Verified                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Property isolation**       | a move changes only `startTick`, a resize only `lengthTicks`; neither touches the pattern, the phase or the curve  |
| **Phase continuity (trim)**  | the phase advances by the trimmed ticks, modulo the PHRASE length                                                  |
| **Phase continuity (split)** | the right fragment continues the phase; the left keeps the original id                                             |
| **Curve continuity (trim)**  | the phase advances and the SOURCE-relative points stay exactly as they were                                        |
| **Curve mapping**            | a point added at visible tick 0 lands at source tick = the phase                                                   |
| **Curve hygiene**            | a moved point keeps the curve sorted and inside the window; a removed point leaves the rest untouched              |
| **Target linking**           | the PRIMARY target cannot be unlinked; a linked one can                                                            |
| **No shared mutable state**  | a duplicate does not share its curve with the source, and a split's two fragments do not share one curve array     |
| **Geometry clamps**          | a negative start clamps to 0, a zero length becomes one tick, a huge length clamps to `MAX_ARRANGEMENT_CLIP_TICKS` |
| **Lock**                     | refuses move/resize/delete/split/trim; mute stays allowed                                                          |
| **Undo/redo**                | every verb in both lanes is ONE history entry with an exact restore and an exact redo                              |
| **Persistence**              | an edited MIDI clip and an edited automation clip round-trip with their phase, curve and geometry unchanged        |
| **Lane isolation**           | a MIDI edit does not touch the automation clips, and vice versa                                                    |
| **No bar-grid leakage**      | a tick-addressed lane keeps an odd tick (bar + 7) — it is not snapped to the bar grid                              |

**One defect repaired here (D3 below): the split's two fragments shared one
curve array.** The command layer is immutable today — every point verb
rebuilds the array — so the aliasing was latent rather than live. But the
DUPLICATE path already deep-copied its points, and a split must not be the
weaker sibling: the first in-place edit of one fragment's curve would have
rewritten the other's.

---

## 5. Repaired defects

### D1 — the quarter-bar CREATION floor leaked into the EDIT verbs

**Severity: high. The clip changed a length the user never asked to change.**

The document model accepts any POSITIVE clip length, on purpose:

> "Recorded comp fragments can be shorter than the normal UI clip-size floor."
> — `sanitizeAudioClips`, `src/project-model/schema.ts`

A split of a take produces fragments as short as the split point allows
(`splitAudioClipAtTick` uses a 0.05-bar minimum fragment). But the command
layer carried a hard `Math.max(0.25, …)` floor — a CREATION policy (a clip
drawn from scratch must be grabbable) — and applied it to EDITS.

**What the user got:** a 0.05-bar fragment — 24 ticks, ~100 ms at 124 BPM —
resized to "the same length" became a 0.25-bar clip: five times longer, with
the source offset unchanged. The clip grew past the end of the fragment it was
cut from, and the waveform and the sound disagreed about where the fragment
ended. The same happened to a trim, a stretch, and a paste (which reaches
`addAudioClip`, i.e. the creation path, by construction).

**Root cause:** one number doing two jobs. The floor that says "a NEW clip
must be grabbable" was also saying "an EXISTING clip must be at least this
long", and the second statement is false for the clips the model explicitly
supports.

**Fix** (`src/commands/audioClips.ts`):

```ts
export const MIN_NEW_AUDIO_CLIP_BARS = 0.25; // creation floor

export function minEditableClipBars(clip: AudioClip): number {
  return Math.min(MIN_NEW_AUDIO_CLIP_BARS, clip.lengthBars); // never inflates
}
```

- `resizeAudioClip`, `trimAudioClipStart`, `stretchAudioClip` now floor at
  `minEditableClipBars(clip)` — an edit may never leave a clip LONGER than it
  already was.
- `addAudioClip` takes `options.preserveLength` — a COPY inherits its length,
  so the creation floor does not apply to it. `pasteClips` (and therefore
  `duplicateClips`) passes it.
- `src/ui/ArrangementPanel.tsx` uses the same floor for the DRAG PREVIEW
  (`editFloorBars`), so the geometry the user is shown is the geometry that
  lands — the panel's own "previewed value" contract.

**Regression coverage:** the six specs in "a legal short clip is not silently
lengthened" (no-op resize, no-op trim, duplicate, mixed-selection duplicate,
paste, and the model's own acceptance of a sub-floor fragment).

### D2 — the same floor in the UI preview (fixed with D1)

`ArrangementPanel.tsx` floored the resize/trim/stretch preview at 0.25 bars
independently of the command. Even after D1's command-side fix, the preview
would have disagreed with the commit for a sub-floor clip — the panel's
previewed-value contract broken in the other direction. Both now read the one
policy.

### D3 — a split's two fragments shared one curve array (latent, closed)

`splitAutomationClipAtTick` built both fragments with a shallow spread, so
the LEFT and the RIGHT fragment pointed at the SAME `points` array. The
command layer is immutable today — every point verb rebuilds the array with
`filter` + `insertPointSorted` — so nothing could exploit it yet. But the
DUPLICATE path already deep-copies its points
(`points: source.points.map((p) => ({ ...p }))`), and the objective asks
explicitly for duplicated objects not to "share mutable state accidentally": a
split must not be the weaker sibling. The first in-place edit of one
fragment's curve would have rewritten the other's.

**Fix:** both fragments get their own copy of the curve. Behaviour is
unchanged today; the trap is gone.

**Regression coverage:** "a split's fragments do not share one curve array" —
the fragments carry the same curve VALUES but not the same array.

---

## 6. Edge cases covered

| Edge case                         | Where                                                                                                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zero-duration result              | a zero-length resize keeps a playable clip; `sanitizeAudioClips` drops non-positive lengths                                                                                                         |
| negative timeline position        | a move clamps to bar 0                                                                                                                                                                              |
| NaN / invalid numerics            | a NaN move leaves the document finite; every command guards non-finite input                                                                                                                        |
| huge drag distance                | a 1e12 move stays finite and non-negative                                                                                                                                                           |
| minimum clip length               | a legal 0.05-bar fragment survives every verb unchanged                                                                                                                                             |
| operation at the timeline start   | a trim past the file's head is refused with a message, not silently clamped                                                                                                                         |
| operation at the project end      | `MAX_ARRANGEMENT_CLIP_BARS` ceiling; a drag past it used to DELETE the clip silently (fixed in an earlier wave)                                                                                     |
| large / very short clips          | the whole matrix runs on 4-bar and 0.05-bar clips                                                                                                                                                   |
| overlapping clips                 | the audio lane layers; both survive a move onto each other                                                                                                                                          |
| adjacent clips                    | split fragments tile; a move never displaces a neighbour                                                                                                                                            |
| clips with fades                  | the fade clamp runs on every length rewrite                                                                                                                                                         |
| clips with automation             | the automation lane is unaffected by audio-clip edits                                                                                                                                               |
| clips with offset / source ranges | `offsetSec` + `trimStart` are the audible start; the matrix pins it                                                                                                                                 |
| repeated fast edits               | a 36-command burst is fully reversible, one entry per command                                                                                                                                       |
| editing during playback           | `services.ts` re-syncs the engine on every document change and cancels the orphaned sources (`cancelOrphanedClipSources`)                                                                           |
| editing during recording          | the recorder lane is INDEPENDENT of the timeline: a take is committed on stop, and the command layer holds no recording lock, so a timeline edit during a take neither disturbs nor blocks the take |
| deleting a playing clip           | the orphan cancellation de-clicks the source instead of letting it ring                                                                                                                             |
| undo during an active interaction | the drag preview never writes to the document — see §7                                                                                                                                              |
| multi-select edits                | one `nudgeClips` = one history entry, all members move together                                                                                                                                     |
| switching project mid-edit        | `replaceDoc` clears the undo stack; the commands are delta-based, so a stale command cannot revert a different document                                                                             |

---

## 7. Undo / redo issues found

**None outstanding.** What the matrix proved:

- Every verb produces exactly ONE history entry. A trim is one command (the
  source offset and the new length are the same gesture — two commands meant
  one Ctrl+Z undid only half); a multi-select nudge is one command.
- Undo restores the document BYTE-IDENTICALLY (deep JSON equality, not a
  field-by-field spot check); redo re-applies it identically.
- The undo engine is delta-based (`applyDocDelta`), not a whole-document pin —
  a concurrent edit between the commit and the undo survives the undo.
- Undo/redo past the ends are safe no-ops.

**The gesture grouping question** ("group continuous drag/trim gestures rather
than generating excessive undo steps") has a structural answer and now a
structural guard: the arrangement panel PREVIEWS during the pointer move and
COMMITS once on release. `tests/clip-edit-gesture-history.test.ts` extracts the
panel's move handlers and asserts they contain no commit — a preview that
wrote to the store would create a history entry per pointer event.

---

## 8. Persistence issues found

**None outstanding.** The matrix round-trips every edited clip through
`JSON.stringify → normalizeProject` (the loader's normalizer — the same path
a real save/load takes) and asserts that position, length, source offset,
trims, gain, fades, stretch rate, reverse, loop, loop phase, mute, lock and
fade curve are all unchanged. Group membership and the lock flag survive too.

One property worth naming: `sanitizeAudioClips` DROPS a clip whose length is
not positive or whose length exceeds `MAX_ARRANGEMENT_CLIP_BARS`. A command
that wrote an out-of-range value would therefore have its clip silently
deleted on the next normalize — which is why the edit commands clamp to the
ceiling themselves (the earlier wave's finding).

---

## 9. Audio-integrity risks

The audible leg is now checked end to end for the verbs, not for the window
functions in isolation. What the matrix proves:

- **A move does not detach the source.** The played window is identical
  before and after; only the timeline position moved.
- **A split leaves no gap and no duplicate.** The two fragments' windows tile
  the original's window exactly: the left ends where the right starts, and the
  pair covers exactly what the original played. A repeated split keeps them
  contiguous.
- **The picture is the sound.** For every verb, the window the editor DRAWS
  (`audioClipWaveformWindow`) starts where playback starts (`audioClipPlayWindow`
  — the engine's own resolver, shared by live playback and the offline render)
  and is exactly as long as the source that plays.
- **A mute reaches the scheduler.** `audioClipsForPlayback` is the single
  choke point, so a muted clip cannot sound in live playback and still sound
  in the export.
- **A copy plays the same source as its original** — a paste does not
  re-derive its window from the timeline.

**Residual risk (not a defect, an unproven area):** these are window-level
assertions, not rendered-PCM assertions. The chain from "the window is
correct" to "the samples in the buffer are correct" is verified by the
existing render suites (`tests/render-manifest.test.ts`,
`tests/audio-clip-played-source-window.test.ts`, the bounce/stem suites), not
by this wave. A browser-level render assertion on an EDITED project (render →
inspect PCM → compare against the pre-edit render) is the strongest remaining
test — see §11.

---

## 10. Remaining incomplete operations / out-of-scope items

- **MIDI lanes and automation lanes**: covered by their own matrix (§4) — but
  only at the DOMAIN level. Their audible leg (a MIDI clip's notes after a
  trim, a curve after a phase advance) was verified through the phase
  arithmetic and the source-relative point model, not through rendered audio.
- **Warp-marker editing** (ADR 0057 stage 2j) was flagged in the earlier wave
  as a design question, not a defect, and is unchanged.
- **Browser-level interaction**: this wave tested the command and domain
  layers. The pointer-level chain (a real drag on a real canvas) is covered
  by the browser suite for some verbs, but not for every verb in this matrix.
- **The scene lane's AUDIBLE leg**: the scene lane was audited on the domain
  axes (isolation, undo/redo, persistence) and its content continuity, but
  unlike the audio lane it has no window-level "the picture is the sound"
  check — the scene lane's content is a pattern reference, so the equivalent
  assertion would live in the pattern scheduler, not in a buffer window.

---

## 11. Recommended next tests

1. ~~**A render-level assertion on an edited project** — render a clip, trim
   it, render again, and compare the PCM against the expected source window.~~
   **DONE in wave 4** — `tests/e2e/29-clip-edit-pcm-render.spec.ts` (§13.1).
2. **The MIDI / automation lane AUDIBLE legs** — a trimmed MIDI clip must
   play the notes its phase points at, and a trimmed automation clip must
   draw the curve its phase points at. The matrices pin the ARITHMETIC; the
   audible half is still asserted only by the engine's own suites.
3. ~~**A browser drag test for the edge gestures** — a pointer-level test that
   drags a 0.05-bar fragment's edge and asserts the committed length (the
   defect D1 lived in the DOMAIN, but the preview/commit agreement is a UI
   property).~~ **DONE in wave 4** — `tests/e2e/30-audio-clip-pointer-chain.spec.ts`
   (§13.2) drives every audio-lane gesture through the real pointer chain.
4. **A property-based sweep** — the matrices are hand-written tables; a
   generator over random clip geometries × random verbs would find the next
   floor-like leak that a table cannot enumerate.
5. **The scene lane's audible leg** — assert that a split scene clip plays
   the pattern from the continued phase, through the pattern scheduler.

---

## 12. Verification record

| Check                                      | Result                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `tests/clip-edit-matrix.test.ts`           | ✅ new — 56 specs                                                                    |
| `tests/clip-edit-audio-integrity.test.ts`  | ✅ new — 16 specs                                                                    |
| `tests/clip-edit-gesture-history.test.ts`  | ✅ new — 7 specs                                                                     |
| `tests/scene-clip-edit-matrix.test.ts`     | ✅ new — 14 specs                                                                    |
| `tests/tick-lane-edit-matrix.test.ts`      | ✅ new — 25 specs                                                                    |
| The 8 pre-existing clip/editor/undo suites | ✅ green                                                                             |
| The 7 pre-existing MIDI/automation suites  | ✅ green                                                                             |
| The 3 playback/loop suites                 | ✅ green (`cancel-orphaned-clip-sources`, `clip-editing-audit2`, `edit-tools-audit`) |
| The full Vitest suite                      | ✅ green except ONE failure owned by a parallel session (see below)                  |
| `tsc --noEmit`                             | ✅ clean for every file in this wave                                                 |
| Prettier                                   | ✅ clean                                                                             |

**The one remaining failure is NOT this wave's.**
`tests/adr0057-meter-disclosure.test.ts` flags `src/intent/model-context.ts`
— a new metre site from the parallel intent-semantics session, committed and
not yet ledgered under ADR 0056's disclosure contract. It is outside the
editing surface this audit owns, and fixing it would mean editing another
session's domain (or the guard's allow-list) without knowing their intent, so
it was left alone on purpose.

Two other failures seen during the full run were LOAD-INDUCED TIMEOUTS, not
defects: `tests/audio-engine-lifecycle-stress.test.ts` (24 dispose/reinit
cycles) and `tests/mcp-idempotency.test.ts` (the ledger's bounded eviction).
Both were re-run in isolation and are GREEN. The bar-formula guard
(`tests/adr0056-stage2-bar-formula-guard.test.ts`), which this wave's changes
could have tripped, is green too.

---

## 13. Wave 4 — the two legs this audit said were missing

Wave 3 closed the DOMAIN axes. Two questions from §10 and §11 were still
open, and both are now answered by executable artifacts rather than by
argument.

### 13.1 The PCM leg — the render follows the edit

`tests/e2e/29-clip-edit-pcm-render.spec.ts` — a real Chromium, a real
`OfflineAudioContext`, the export path's own `renderProject(doc, SampleBank,
{mode:"song", sampleRate, tailSeconds:0})`, and a Goertzel single-frequency
probe on the rendered PCM.

**The source is a staircase, not a tone.** Every 2 s of source is a
different frequency (220 / 440 / 660 / 880 / 1100 / 1320 / 1540 / 1760 Hz),
so a probe can name the SOURCE POSITION that is audible instead of merely
proving that "something is there". That is what separates the verbs:

| Verb       | What the PCM says after the edit                                           | What it would say if the verb were wrong          |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| trim start | the head plays source +2 s (440 Hz), the vacated head is silent            | the head still plays the old material (220 Hz)    |
| resize     | the head survives, the tail is cut; growing pulls NEW material (1320 Hz)   | the tail repeats the head, or the head is re-read |
| move       | the clip lands elsewhere and still plays 220 Hz — the SOURCE did not move  | the move advanced the source (that is a trim)     |
| split      | the right fragment continues at source 4.5 s (660 Hz)                      | the right fragment restarts at the source head    |
| reverse    | the head and the tail frequencies SWAP (880 Hz ↔ 220 Hz)                   | the source plays forwards either way              |
| gain       | the amplitude is exactly ÷4                                                | the source itself changed                         |
| loop       | the 2 s source repeats, and the PHASE repeats with it (440/880/440/880 Hz) | the tail is silent, or the phase drifts           |
| duplicate  | the copy carries the source offset (660 Hz, not a reset 220 Hz)            | the copy re-read the sample from its head         |
| paste      | the pasted clip carries the source offset too                              | the paste drops the source position               |

**Every "absence" assertion has a measured control.** A claim like "the head
region is silent after the move" is only meaningful next to a measured "the
head region was audible before the move" — the controls are rendered from the
SAME document the verb started from, not assumed. A fixture that rendered
nothing would otherwise satisfy every "tone is absent" assertion in the file,
so the controls are asserted FIRST and would fail the run before the verb
assertions are reached.

**Undo is asserted on the AUDIO, not on the document.** A second test drives
the real `ProjectStore` (not raw command factories) and compares the rendered
buffers sample-for-sample: after one `Ctrl+Z`, the undone render must equal
the pristine render to within 1e-6 — and the guard is only meaningful
because the edited render differs from the pristine one by more than the
threshold. The wave-3 matrices pinned the document; this pins the sound.

### 13.2 The pointer leg — the chain from the finger to the committed state

`tests/e2e/30-audio-clip-pointer-chain.spec.ts` — the layer wave 3 never
touched. Real `page.mouse` presses, drags and releases; real `page.keyboard`
verbs; the real context menu. The oracle is the DOM, read as a STATE
FINGERPRINT: the clip's committed title (`… 5.33b · trim 0.00/0.00 fade
0.00/0.00 gain 1.00 …`), its committed `left`/`width` in px, its class list
and the handle titles.

**ONE GESTURE = ONE UNDO ENTRY** is asserted the only way a browser can
assert it: after the gesture, ONE `Ctrl+Z` must restore the pre-gesture
fingerprint EXACTLY and ONE `Ctrl+Y` must re-apply it exactly. A drag that
wrote intermediate states into the store would land the first undo on an
intermediate state — the defect, caught where the user loses the work.

Covered gestures: move, resize, trim start, fade in, fade out, gain, slip,
stretch (Alt+edge), plus the cancelled gesture (Escape mid-drag commits
nothing and consumes no undo slot), and the keyboard/menu verbs: mute (M),
duplicate (Ctrl+D), copy/paste (Ctrl+C / Ctrl+V), group/ungroup (Ctrl+G /
Ctrl+Shift+G), reverse and loop (context menu), lock (Shift+L) and delete
(Delete).

**The fixture is the app's own.** `BOUNCE ZONE` offline-renders the selected
zone and flips it into a real audio clip — a real buffer in the live bank,
waveform included. That matters for the verbs that READ the bank: SLIP
computes its ceiling from the sample's real duration, and a clip with no
buffer would make the slip gesture a no-op that silently "passes". The zone
must start at the ruler's LEFT EDGE: the House template's only arrangement
content is its scene clip at bars 0–4, and a zone that misses it bounces
nothing.

### 13.3 What wave 4 found

No new product defect. The two suites are green against the current `main`,
and the three failures they did produce were faults in the SUITE, each of
which named a real contract:

1. **The fingerprint must exclude panel state.** The clip's `selected` class
   is panel state, not document state: the first pointer-down selects the
   clip and an undo does NOT unselect it. Comparing the raw class list
   reported a selection difference where the audit was looking for an edit
   difference. Fixed by taking the baseline after the selection.
2. **A group is a RELATIONSHIP.** `groupClips` refuses fewer than two
   members ("Select at least two clips to group"), so the group verb needs a
   second clip and a selection that holds both — the suite now duplicates,
   ctrl-clicks the copy, and groups the pair.
3. **The zone must cover content.** The bounce throws "Nothing to bounce —
   the zone has no scene or audio content" for a zone that misses the House
   template's scene clip at bars 0–4.

None of the three is a product defect: each is a contract of the product that
the test had to learn. That is the point of writing the leg down — a leg
that cannot tell a wrong product from a wrong test is not a measurement.

### 13.4 Running these two suites on a shared box

Both specs need the Vite dev server on `127.0.0.1:5199` (the repo's
Playwright config starts it). On a machine where parallel agents edit the
tree, start it with HMR OFF — the switch the repo's own `vite.config.ts`
already provides for the long audio soak:

```bash
KYX_RECORDING_SOAK_SECONDS=1 npx vite --port 5199 --strictPort
```

With HMR on, a parallel session's save triggers a FULL PAGE RELOAD in the
middle of a gesture: the studio is replaced by the project browser, the
clips vanish, and the failure reads like a defect ("the paste destroyed every
clip") when nothing was destroyed. The same saturation also stretches the
first page load past three minutes, so the specs' boot budget is generous by
design.

Measured on the 2026-10-24 run (a box at 100 % CPU from parallel sessions):
all five specs green — the PCM pair in 1.9 min, the pointer trio in 1.5 min
once the module graph was warm.
