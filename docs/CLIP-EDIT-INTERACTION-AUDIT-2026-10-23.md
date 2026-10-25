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
2. ~~**The MIDI / automation lane AUDIBLE legs** — a trimmed MIDI clip must
   play the notes its phase points at, and a trimmed automation clip must
   draw the curve its phase points at. The matrices pin the ARITHMETIC; the
   audible half is still asserted only by the engine's own suites.~~
   **DONE in wave 5** — `tests/tick-lane-audible-leg.test.ts` (§14.1) measures
   what the SHARED resolvers play, and `tests/ui/midi-note-marks-audible-parity.test.tsx`
   (§14.2) pins the drawn lane against the played one, tick for tick.
3. ~~**A browser drag test for the edge gestures** — a pointer-level test that
   drags a 0.05-bar fragment's edge and asserts the committed length (the
   defect D1 lived in the DOMAIN, but the preview/commit agreement is a UI
   property).~~ **DONE in wave 4** — `tests/e2e/30-audio-clip-pointer-chain.spec.ts`
   (§13.2) drives every audio-lane gesture through the real pointer chain.
4. ~~**A property-based sweep** — the matrices are hand-written tables; a
   generator over random clip geometries × random verbs would find the next
   floor-like leak that a table cannot enumerate.~~ **DONE in wave 5** —
   `tests/clip-edit-property-sweep.test.ts` (§14.4). Two passes: an exhaustive
   verb × argument battery and a seeded random geometry sweep. It found two
   real defects (D5, D6), both repaired.
5. ~~**The scene lane's audible leg** — assert that a split scene clip plays
   the pattern from the continued phase, through the pattern scheduler.~~
   **DONE in wave 5** — `tests/scene-clip-audible-leg.test.ts` (§14.3). It
   also produced the open finding D4: the scene lane's phase names the step
   GRID while the scene's melody repeats at its PHRASE.

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
the PCM pair green in 2.1 min (1.4 min + 41 s) and the pointer trio green in
one run — 3.8 min for the eight gestures, 13.6 s for the cancelled gesture,
26.4 s for the keyboard and menu verbs.

---

## 14. Wave 5 — the three legs §11 asked for

§11 listed five open items. Waves 3 and 4 closed items 1 and 3. This wave
closes items 2, 4 and 5: the MIDI/automation audible leg, the property-based
sweep, and the scene lane's audible leg. Two of the three came back with a
product finding, and the sweep found two defects the hand-written tables
could not see.

### 14.1 The MIDI / automation audible leg

`tests/tick-lane-audible-leg.test.ts` — 21 specs.

**THE ORACLE IS THE SHARED RESOLVER, NOT A PRIVATE COPY.**
`midiClipEventsInWindow` and `automationClipEventsInWindow` in
`src/project-model/events.ts` are what the LIVE scheduler, the OFFLINE
renderer, the AUTOMATION bridge and the MIDI EXPORT all call:

| Call site                              | Resolver                                                 |
| -------------------------------------- | -------------------------------------------------------- |
| `src/scheduler/Scheduler.ts`           | `midiClipEventsInWindow`                                 |
| `src/rendering/renderer.ts`            | `midiClipEventsInWindow`, `automationClipEventsInWindow` |
| `src/audio-engine/automationBridge.ts` | `automationClipEventsInWindow`                           |
| `src/midi/midiProject.ts`              | `midiClipEventsInWindow`, `automationClipEventsInWindow` |

So an assertion about their output is an assertion about WHAT THE USER HEARS
— live and in the export. The file's last spec is an AST guard that reads the
four call sites and proves they still resolve through the shared resolver; a
resolver nobody calls would make every assertion in the file vacuous, and a
vacuous leg is worse than no leg. The guard carries its own "proven able to
fail" self-test.

**WHAT IT PINS.**

- A clip plays the pattern from its phase, and the repeat period is the
  PHRASE, not the step grid (the fixture's last note outlives the 16-step
  grid, so the two periods cannot be confused).
- A head trim advances the phase and CUTS the note that was already sounding
  — the standard DAW trim semantics.
- A split preserves every ATTACK exactly once: no attack lost, no attack
  doubled.
- **The measured price of that.** A split inside a sustained note is not
  audio-neutral the way an AUDIO clip's split is: the tail belongs to the
  left window and the right window starts a fresh cycle of the pattern. The
  note is 960 ticks long and after the split only **240** of them are heard.
  The model is stated in the file so a future change cannot quietly change
  it, and the price is pinned rather than hidden.
- A resize cuts the notes that fall outside the new window; a muted clip
  plays nothing; a duplicate plays the same notes at its own place.
- The automation leg: the lane's first value, the trim's phase (the lane
  starts on the curve BEHIND the window), the split's curve tiling, and the
  source-relative curve whose points do not move.

### 14.2 The picture and the sound agree

`tests/ui/midi-note-marks-audible-parity.test.tsx` — 3 specs. The arrangement
lane DRAWS the note marks (`MidiClipNoteMarks` in
`src/ui/arrangement/MidiClipLanes.tsx`); the scheduler PLAYS the notes. The
suite compares the drawn `.arr-midi-note-mark` elements with the scheduler's
events tick for tick — for the whole clip, after a split, and after a trim.
This is the invariant that makes the §14.1 model safe to state: the window
decides, and the window is what is drawn.

### 14.3 The scene lane's audible leg

`tests/scene-clip-audible-leg.test.ts` — 8 specs. The oracle is the same pair
the live and offline paths use for a scene region: `patternBaseTickForClip` +
`noteEventsInWindow` (the drums ride the same base through
`drumHitsInWindow`), i.e. `Scheduler.schedulePatternWindow` and
`renderer.scheduleNotes`.

**WHAT IT PINS** (the crop contract of §15 — these are the specs as they read
AFTER the wave-6 repair):

- A region plays its scene's pattern from its phase.
- A split continues the position and the fragments' attacks TILE the
  original's — no attack lost at the seam, no attack doubled.
- The scene's INTENSITY curve does not loop: a trim continues it, it does not
  restart it (the offset grows while the phase wraps).
- The lane refuses an overlapping placement, so two regions can never sum
  their notes into a double hit.
- A trim CROPS: the scene's performance offset grows by the elapsed time and
  the phase advances by the same amount — wrapped against the scene's TRUE
  period — so the music under the region does not change: the same absolute
  attacks play. The trim cuts the note that was sustaining across the trim
  point.

**D4 (OPEN AT THE TIME — REPAIRED IN WAVE 6, §15) — THE PHASE NAMES THE GRID, THE MELODY REPEATS AT THE PHRASE.**

A scene pattern carries two contents on two clocks: the DRUMS repeat at the
step grid (`pattern.stepCount * STEP_TICKS`), the MELODY repeats at the
PHRASE (`midiPhraseLengthTicks`), which is longer as soon as one note
outlives the grid. The scene clip's phase was wrapped against the GRID. The
MIDI lane had exactly this defect and was repaired in wave 1 (F4): its phase
wraps against the phrase. The scene lane still wrapped against the grid — and
that is what wave 6 repaired (§15).

Measured, with a 12-step scene pattern in 4/4 (bar 1920 ticks, grid 1440):

- the split's right fragment plays **pitch 64** at the seam where the
  original played **pitch 60** — the fragments do NOT tile the original's
  attacks;
- the phase is confined to `[0, grid)`, so the phrase's second grid can never
  start a region (480 ticks of melodic material are unreachable in that
  fixture);
- with a 16-step pattern (the common case) the bar IS a whole number of grid
  steps and the content rides along — which is why the hand-written matrix
  never saw it.

**What it is now (§15):** the phase is named against the pattern's TRUE period
(the least common multiple of the grid and every melodic track's phrase), the
region CROPS, and the phase and the performance offset advance together.

**REPORTED, NOT CHANGED — AT THE TIME.** The principled fix is to wrap the scene
clip's phase against the pattern's full repeat period — the least common
multiple of the grid and the phrase. That is not a "smallest safe fix": it
changes a contract the tick-lane matrix pins ("the phase wraps modulo the
pattern"), it moves the base for the scene's AUTOMATION context as well, and it
touches the persisted `phaseOffsetTicks` semantics. It is a product decision,
so the finding was reported and pinned, and the specs that carried it were
named "open" and said so in their failure messages.

**That decision was taken in wave 6 (§15): the scene lane now CROPS, like every
other lane, and the phase names the scene's TRUE period.**

### 14.4 The property-based sweep

`tests/clip-edit-property-sweep.test.ts` — 8 specs, ~300 generated cases.

The matrices are HAND-WRITTEN TABLES: one row per verb, one geometry per
row. A table cannot enumerate the geometry space, so it cannot find a floor
that only bites at an unusual size — which is exactly where D1 lived. The
sweep GENERATES the cases, in two passes:

- **THE EXHAUSTIVE BATTERY** — every verb × every argument variant, the
  hostile ones included (negative, zero, NaN, absurdly large, off the end).
  A random pass alone hits them only by luck: the first version of this file
  drew a random verb per case and MISSED the huge-length resize for forty
  cases in a row.
- **THE RANDOM PASS** — a seeded PRNG (mulberry32, no dependency, no
  `Math.random`) picks a random geometry, a random verb and a random variant.
  Every assertion carries the seed and the case index, so a failing case is
  reproducible.

Every case is put through four properties:

1. **REFUSAL SAFETY** — a verb that throws leaves the document UNCHANGED and
   pushes no history entry. A command that half-applies and then throws is a
   silent corruption.
2. **PROPERTY ISOLATION** — the verb changes the fields it owns and NOTHING
   ELSE (the allow-list is per verb, not per lane).
3. **UNDO / REDO EXACTNESS** — a verb that CHANGED something is exactly one
   history entry, undo restores the document, redo re-applies it; a verb
   that changed NOTHING must leave no undo step behind (a dead Ctrl+Z step is
   its own defect).
4. **GEOMETRY INVARIANTS** — every clip in the lane is still a legal clip:
   finite numbers, a positive length, the phase inside its period, the fades
   inside the clip, and the audible resolvers still resolve the clip's own
   window.

**D5 (REPAIRED) — A RESIZE COULD MAKE THE CLIP VANISH.**

The MIDI lane's geometry clamp fell on the WRONG FIELD. `safeGeometry` pulls
the START back when the requested length does not fit (`start = MAX -
length`) — right for a MOVE, where the position gives way, wrong for a
RESIZE, where the length should. The lane then wrote only the clamped
LENGTH and kept the old START, so the clip's end reached past
`MAX_ARRANGEMENT_CLIP_TICKS`. The normalizer DROPS such a clip
(`startTick + lengthTicks <= MAX_ARRANGEMENT_CLIP_TICKS`, `schema.ts`) — so a
resize silently DELETED the user's MIDI clip, with an undo step that could
not bring it back.

The hand-written matrix missed it because its fixture sits at tick 0, where
the old clamp happens to land on a legal geometry. The repair: the resize
keeps the START and lets the LENGTH give way (`safeResizeLength`). The
matrix's pinned contract (resize to 1e12 → length = MAX) still holds at
tick 0.

**D6 (REPAIRED) — A RESIZE TELEPORTED THE CLIP.**

The same wrong field in the automation lane, with the other symptom:
`resizeAutomationClip` wrote the clamped START as well, so a resize that
asked for a length past the ceiling MOVED the clip to tick 0 — the verb
touched a field it does not own, which is the sweep's property 2 catching it
in the act. The repair is the same shape: the START stays, the LENGTH gives
way.

### 14.5 What wave 5 found

| Finding | Kind                                                                                                                                                     | Status                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| D4      | The scene lane's phase names the grid, the melody repeats at the phrase                                                                                  | **REPAIRED** in wave 6 (§15) — the scene lane crops, against the true period |
| D5      | A MIDI resize could make the clip vanish (the normalizer drops an over-ceiling clip)                                                                     | **REPAIRED** in wave 5                                                       |
| D6      | An automation resize teleported the clip to tick 0                                                                                                       | **REPAIRED** in wave 5                                                       |
| D7      | The model's normalizer was a SECOND authority on the phase's modulus — it silently folded the wave-1 F4 repair back to the grid, so the repair was INERT | **REPAIRED** in wave 6 (§15.3)                                               |
| D8      | A trim that landed the phase on ZERO kept the OLD phase — the verb's own arithmetic was discarded by the spread                                          | **REPAIRED** in wave 6 (§15.4)                                               |

One behaviour was PINNED rather than changed, because it is the product's model
and it is stated in the files that measure it:

- the MIDI lane's split is attack-neutral but NOT sustain-neutral (a 960-tick
  note leaves 240 ticks audible).

The second behaviour wave 5 pinned — "the scene region's trim slides the
region's content when the metrical bar is not a whole number of the pattern's
grid steps" — was D4's measurable face, and it did not survive wave 6: the
scene lane now crops, and that slide is gone (§15).

One finding was about the SUITE, not the product, and it is worth writing
down because it nearly invalidated the whole sweep: the first version of the
sweep built each case's command from a closure that captured ANOTHER store,
so the command ran against a document that did not contain the clip and
simply threw. Every case then passed as "the verb refused" — a green sweep
that measured nothing. The fix was to resolve the fixture and the argument
variant INSIDE the case. A leg that cannot tell a wrong product from a wrong
test is not a measurement.

### 14.6 The verification record

| Check                                              | Result                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `tests/tick-lane-audible-leg.test.ts`              | ✅ new — 21 specs                                                 |
| `tests/ui/midi-note-marks-audible-parity.test.tsx` | ✅ new — 3 specs                                                  |
| `tests/scene-clip-audible-leg.test.ts`             | ✅ new — 8 specs                                                  |
| `tests/clip-edit-property-sweep.test.ts`           | ✅ new — 8 specs, ~300 generated cases                            |
| `tests/tick-lane-edit-matrix.test.ts`              | ✅ green (25 specs) — the resize repair keeps its pinned contract |
| `tests/scene-clip-edit-matrix.test.ts`             | ✅ green (14 specs)                                               |
| `tests/clip-edit-matrix.test.ts`                   | ✅ green (56 specs)                                               |
| The full Vitest suite                              | ✅ green (see the count in `docs/CURRENT-STATE.md`)               |
| `tsc --noEmit`                                     | ✅ clean for every file in this wave                              |
| Prettier                                           | ✅ clean                                                          |

---

## 15. Wave 6 — D4: the scene lane crops, against the TRUE period

### 15.1 The decision

D4 was reported in wave 5 (§14.3) as a product decision, not a defect to be
patched: the scene lane's phase named the step GRID, while the scene's melody
repeats at its PHRASE. The decision taken now:

**The scene lane CROPS, like every other lane, and the phase names the scene's
TRUE period.**

- **Crop.** A trim of a scene region's start edge no longer re-seats the
  pattern inside the region. The music that plays under the region stays the
  music that was there; the region simply starts later. This is what the
  audio, MIDI and automation lanes already do, and it is what a user means by
  "trim".
- **The true period.** The period the phase wraps against is the scene's TRUE
  period: the least common multiple of the step grid (the drums' repeat) and
  every melodic track's phrase (the notes' repeat). A pattern whose note
  outlives the grid comes back around only after both do, so that — and not
  the grid — is the period a phase can be wrapped against.

A scene clip carries two positions, and the repair keeps that shape:

- `sceneOffsetTicks` — the scene's performance offset: the intensity curve
  does NOT loop, so this grows without bound;
- `phaseOffsetTicks` — the music's position in the scene's loop: it advances
  with the offset and WRAPS, against the true period.

**Both advance by the elapsed time; only the phase wraps.** That is not a
detail — it is the part the repo's own older contracts decided, and the first
implementation of this wave got it wrong. The wave-6 draft derived the phase
from the offset ("one position"), which reads tidier and is what the first
draft of this section said. Two executable contracts that PREDATE this audit
refused it:

- `tests/editor-ultra-hardening.test.ts` — "the seam is content-continuous:
  pattern phase and scene offset continue at the split": the right half of a
  split must play EXACTLY what the original played at the seam;
- `tests/commands.test.ts` — "duplicateArrangementClip places the copy after
  the original": the copy carries its position fields VERBATIM.

Both fixtures carry a clip whose phase does NOT match its offset (240 vs 480,
120 vs 240) — deliberately, because that is the shape a document written before
the repair can have. Deriving one field from the other would re-seat such a
document's music at its next edit: the split's right half would stop sounding
like the original it was cut from, and a copy would stop sounding like the
clip it was copied from.

So the rule is: **the phase and the offset advance together, and the phase is
wrapped against the scene's true period.** The audible crop follows from it —
the region's start moves by exactly the elapsed time and the phase advances by
exactly the same amount, so the music under the region does not move.

### 15.2 What changed

**Command layer** (`src/commands/arrangement.ts`):

- `scenePhaseAfter(pattern, phase, elapsedTicks)` — the music's position in the
  scene's loop after the elapsed time, wrapped against the true period;
- `patternOfScene(doc, clip)` — the pattern of the scene a clip plays;
- `trimArrangementClipStart` — the offset grows by the elapsed time and the
  phase advances by the same amount (wrapped), so the region crops;
- `splitArrangementClipAtTick` — the right half continues BOTH positions by the
  left half's elapsed time; the LEFT half keeps the original's phase and offset
  untouched (it is the original, truncated);
- `duplicateArrangementClip` — a copy is a copy: both position fields travel
  verbatim, so the copy sounds like the clip it came from.

**Model** (`src/project-model/midiTime.ts`): `lcmTicks(a, b)` and
`scenePatternPeriodTicks(pattern)` — one owner for the modulus.

Measured on the same 12-step fixture that produced the finding (grid 1440,
phrase 1920, true period 5760):

|                                          | before       | after                                               |
| ---------------------------------------- | ------------ | --------------------------------------------------- |
| the split's right half at the seam       | pitch **64** | pitch **60** (the original's)                       |
| the fragments' attacks vs the original's | did NOT tile | tile **exactly**                                    |
| the phase's range                        | `[0, 1440)`  | `[0, 5760)` — the phrase's second grid is reachable |

### 15.3 D7 — the normalizer was a SECOND authority

The repair did not take the first time it was written, and the reason is
worth more than the repair.

The command wrote the phase; the model's NORMALIZER
(`src/project-model/schema.ts`) folded it back:

- the MIDI phase was folded against the step GRID — the very defect the wave-1
  F4 repair had just removed from the command layer;
- the scene phase was folded against the grid as well.

Measured on the MIDI lane: a head trim of one grid in a long-note pattern
wrote phase **1920**; the normalizer kept **0**. The wave-1 F4 repair was
INERT for exactly the case it was made for.

And the wave-1 spec did not catch it — NOT because it measured the wrong
thing. The store DOES normalize every command's result
(`ProjectStore.applyCommand` → `normalizeProject(applied)`), so the spec saw
the normalized document all along. It missed the defect because its FIXTURE
could not show the difference: the house template's pattern has a phrase of
**1920** ticks and a grid of **1920** ticks — the same number — so "wrap
against the phrase" and "wrap against the grid" are the SAME OPERATION there.
Measured on both fixtures:

| fixture                                                    | grid | phrase | phase | old (mod grid) | new (mod phrase)                             |
| ---------------------------------------------------------- | ---- | ------ | ----- | -------------- | -------------------------------------------- |
| the wave-1 spec's (house template, trim 240 ticks)         | 1920 | 1920   | 240   | 240            | 240 — identical, the fold CANNOT show itself |
| the new regression's (a note past the grid, trim one grid) | 1920 | 3840   | 1920  | **0**          | **1920** — the fold bites                    |

> **The normalizer is a second authority. A repair that only touches the
> command layer is a repair the model can undo. And a regression that only
> reaches the easy case is a green light for a broken product.**

Both normalizers now read the same period the command layer writes against:
the MIDI phase against `midiPhraseLengthTicks`, the scene phase against
`scenePatternPeriodTicks`.

New regression: `tests/tick-lane-audible-leg.test.ts` — "the phase SURVIVES
the model's normalizer": the phase the command wrote must be the phase that
is still there after the document has been normalized, measured on a fixture
whose phrase really does outlive its grid. That suite now has 22 specs.

### 15.4 D8 — a trim that landed on zero KEPT the old phase

Found while writing this wave, and it is the same shape as D7: a second
authority, this time inside the verb itself.

The trim computes the new phase and OMITS it when it is zero (the house
style: a zero phase is the pattern's own start). But the clip was rebuilt as
`{ ...clip, ...(phaseOffsetTicks > 0 ? { phaseOffsetTicks } : {}) }` — so when
the computed phase was ZERO, the spread kept the OLD phase, and the verb's own
arithmetic was silently discarded. The region's music stayed at the old place
in the scene's loop, and the trim that was supposed to crop it did not.

Measured: a clip whose phase is one grid, trimmed by one bar against a scene
whose true period is 3840 ticks — the trim computes phase **0**, the document
keeps **1920**. The fix removes the field when the new value is zero (the
omission is a serialization choice, not a licence to keep a stale value).

The regression that catches it: `tests/scene-clip-audible-leg.test.ts` — "a
trim that lands the phase on ZERO clears it". Verified by measurement: with
the `delete` removed, that spec goes red with "expected 1920 to be 0". A green
spec that does not guard the fix is decoration, and this one was checked.

### 15.5 The honest cost

- **A legacy document's phase is not rewritten — and cannot be.** The repair
  makes the phase advance content-preservingly (no more sliding) and keeps it
  inside the true period. It does NOT retroactively fix a phase that was
  folded against the grid when the document was written: the stored phase is
  the only record of where the region sat, and re-deriving it from the offset
  would re-seat that document's music on the next edit — and would break the
  split's audible seam (§15.1). So a document whose scene's melody outlives
  its grid keeps whatever phase it was born with. In the common case
  (phrase == grid) the two periods are the same number and nothing is
  affected at all.
- **`SCHEMA_VERSION` did not move.** No field was added or removed; only the
  modulus the normalizer applies changed. A document written before the repair
  still loads — the normalizer simply wraps the phase against the wider
  period.
- **The scene lane still draws no content.** The region is still a blank box
  in the arrangement view: the pattern it plays is audible but not visible.
  That is a separate, larger product step (draw the pattern), not part of
  this repair.

### 15.6 What did NOT change

- The MIDI lane's split stays attack-neutral but NOT sustain-neutral (a
  960-tick note leaves 240 ticks audible).
- The scene's INTENSITY curve still does not loop — it keeps elapsed time.
- The scene lane still refuses an overlapping placement, so two regions can
  never sum their notes into a double hit.
- The phase remains a stored field (not recomputed on read), so the document
  stays serializable and the phase stays inspectable in the model.
- The audio, MIDI and automation lanes are untouched by this wave.

### 15.7 The verification record

| Check                                                             | Result                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/scene-clip-audible-leg.test.ts`                            | ✅ green (9 specs) — the three D4 specs rewritten to the new contract, + the D8 regression                                                                                                                                                                                 |
| `tests/tick-lane-audible-leg.test.ts`                             | ✅ green (22 specs) — +1 "the phase SURVIVES the model's normalizer"                                                                                                                                                                                                       |
| `tests/scene-clip-edit-matrix.test.ts`                            | ✅ green (14 specs) — the fixture's period computed INDEPENDENTLY of the product's helper                                                                                                                                                                                  |
| `tests/commands.test.ts` + `tests/editor-ultra-hardening.test.ts` | ✅ green (110 specs) — the two OLDER contracts that corrected this wave's first draft (see §15.1)                                                                                                                                                                          |
| the thirteen-suite batch                                          | ✅ 324/324                                                                                                                                                                                                                                                                 |
| `tests/drift-check.test.ts`                                       | ✅ green (7 specs) — the spec-count row resynced to the live index count                                                                                                                                                                                                   |
| the full Vitest suite                                             | ⚠️ 21 failed files / 23 failed tests — **2 of them were MINE** (`commands.test.ts`, `editor-ultra-hardening.test.ts`, both fixed in this wave); the other 19 files / 21 tests are foreign (KOPA editor, MCP verified mutation, intent model, shortcuts, SamplerMapping, …) |
| `tsc --noEmit`                                                    | ✅ clean for every file in this wave — the 6 errors on `main` are in a parallel session's `src/presets/struna-factory.ts` and `tests/struna/engine.test.ts`                                                                                                                |
| Prettier                                                          | ✅ clean for every file in this wave — the committed `docs/CURRENT-STATE.md` still carries a pre-existing table-padding debt from a parallel session (measured: my changes add none)                                                                                       |
