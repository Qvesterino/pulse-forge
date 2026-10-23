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

## 4. Repaired defects

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

---

## 5. Edge cases covered

| Edge case                         | Where                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| zero-duration result              | a zero-length resize keeps a playable clip; `sanitizeAudioClips` drops non-positive lengths                             |
| negative timeline position        | a move clamps to bar 0                                                                                                  |
| NaN / invalid numerics            | a NaN move leaves the document finite; every command guards non-finite input                                            |
| huge drag distance                | a 1e12 move stays finite and non-negative                                                                               |
| minimum clip length               | a legal 0.05-bar fragment survives every verb unchanged                                                                 |
| operation at the timeline start   | a trim past the file's head is refused with a message, not silently clamped                                             |
| operation at the project end      | `MAX_ARRANGEMENT_CLIP_BARS` ceiling; a drag past it used to DELETE the clip silently (fixed in an earlier wave)         |
| large / very short clips          | the whole matrix runs on 4-bar and 0.05-bar clips                                                                       |
| overlapping clips                 | the audio lane layers; both survive a move onto each other                                                              |
| adjacent clips                    | split fragments tile; a move never displaces a neighbour                                                                |
| clips with fades                  | the fade clamp runs on every length rewrite                                                                             |
| clips with automation             | the automation lane is unaffected by audio-clip edits                                                                   |
| clips with offset / source ranges | `offsetSec` + `trimStart` are the audible start; the matrix pins it                                                     |
| repeated fast edits               | a 36-command burst is fully reversible, one entry per command                                                           |
| editing during playback           | `services.ts` re-syncs the engine and cancels orphaned sources (`cancelOrphanedClipSources`)                            |
| deleting a playing clip           | the orphan cancellation de-clicks the source instead of letting it ring                                                 |
| undo during an active interaction | the drag preview never writes to the document — see §7                                                                  |
| multi-select edits                | one `nudgeClips` = one history entry, all members move together                                                         |
| switching project mid-edit        | `replaceDoc` clears the undo stack; the commands are delta-based, so a stale command cannot revert a different document |

---

## 6. Undo / redo issues found

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

## 7. Persistence issues found

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

## 8. Audio-integrity risks

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
test — see §10.

---

## 9. Remaining incomplete operations / out-of-scope items

- **MIDI lanes and automation lanes**: their commands are covered by the
  existing suites; they were not re-audited here (the objective's focus is
  the audio/stem lane and the scene regions).
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

## 10. Recommended next tests

1. **A render-level assertion on an edited project** — render a clip, trim
   it, render again, and compare the PCM against the expected source window.
   This closes the last gap between "the window is right" and "the audio is
   right".
2. **The MIDI / automation lane matrices** — property isolation for the
   note-level verbs (`moveMidiClip`, `resizeMidiClip`, automation point
   drags), including their undo grouping.
3. **A browser drag test for the edge gestures** — a pointer-level test that
   drags a 0.05-bar fragment's edge and asserts the committed length (the
   defect D1 lived in the DOMAIN, but the preview/commit agreement is a UI
   property).
4. **A property-based sweep** — the matrices are hand-written tables; a
   generator over random clip geometries × random verbs would find the next
   floor-like leak that a table cannot enumerate.
5. **The scene lane's audible leg** — assert that a split scene clip plays
   the pattern from the continued phase, through the pattern scheduler.

---

## 11. Verification record

| Check                                      | Result                                                               |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `tests/clip-edit-matrix.test.ts`           | ✅ new — 54 specs                                                    |
| `tests/clip-edit-audio-integrity.test.ts`  | ✅ new — 12 specs                                                    |
| `tests/clip-edit-gesture-history.test.ts`  | ✅ new — 7 specs                                                     |
| `tests/scene-clip-edit-matrix.test.ts`     | ✅ new — 14 specs                                                    |
| The 8 pre-existing clip/editor/undo suites | ✅ green                                                             |
| The full Vitest suite                      | ✅ green except two failures owned by a parallel session (see below) |
| `tsc --noEmit`                             | ✅ clean for every file in this wave                                 |
| Prettier                                   | ✅ clean                                                             |

**Two pre-existing failures are NOT this wave's** — they belong to a parallel
session's in-flight work and were left alone on purpose:

1. `tests/adr0056-stage2-bar-formula-guard.test.ts` — flags
   `src/ui/IntentPanel.tsx` (`ticksPerBar(doc) * 4`, a bar-length formula
   copy outside the one owner). That file is modified in the working tree by
   another session; the guard was edited in the same commit. Not touched.
2. `tests/adr0057-meter-disclosure.test.ts` — flags
   `src/intent/model-context.ts` (a new metre site from the same parallel
   session). Not touched.
