# DAW Edit Tools & Interaction Audit

Perform a focused **editing tools, clip interaction, timeline manipulation, and regression audit** of this DAW.

The goal is to verify that the core editing workflow behaves predictably, precisely, and safely under normal use, rapid interaction, edge cases, and repeated operations.

This is not only a reporting task.

When you find a **confirmed, well-understood, safely fixable issue**, reproduce it, fix it, add regression coverage where practical, and verify the result.

Do not redesign the editing model or add unrelated features.

---

## 1. Establish Editing Invariants

Before changing code, identify the important rules of the editing system.

Examples:

- clip start must never move after clip end
- duration must never become invalid or negative
- edits must preserve source/media references
- timeline position must remain consistent after edits
- snap must behave consistently
- destructive operations must be undoable where intended
- copy/duplicate must not share mutable state accidentally
- fades must remain inside valid clip boundaries
- deleting one object must not corrupt unrelated selections or references

Use these invariants throughout the audit.

---

# 2. Core Editing Operations

Verify the behavior of all implemented editing tools, especially:

- select
- multi-select
- marquee selection
- move / drag
- trim left
- trim right
- resize
- cut
- split
- copy
- paste
- duplicate
- delete
- insert
- replace
- slip edit, if supported
- ripple edit, if supported
- stretch / time-stretch, if supported
- loop / repeat
- crop
- mute / disable clip
- grouping / ungrouping, if supported
- lock / unlock, if supported

For every operation test both normal usage and repeated/unusual usage.

---

# 3. Move & Drag Audit

Test moving clips:

- left / right
- between tracks
- across large timeline distances
- to timeline start
- near and over other clips
- while zoomed in/out
- with snapping enabled/disabled
- with keyboard modifiers
- with multiple selected clips

Verify:

- no unintended position jumps
- no incorrect offsets
- no accidental duplication
- no clip loss
- no invalid negative positions unless intentionally supported
- selection remains correct
- waveform/content remains synchronized

Rapid drag interactions should not corrupt state.

---

# 4. Trim Audit

Test trimming from both edges.

Verify:

- left trim
- right trim
- minimum duration
- maximum available source range
- trim near zero duration
- repeated and rapid trim
- trim with/without snapping
- trim after split
- trim after copy/duplicate
- trim after undo/redo
- trim during or immediately after playback if supported

Check that source offsets remain correct.

A clip that is trimmed and later expanded again should reveal the correct original source region where nondestructive editing is intended.

---

# 5. Split / Cut Audit

Test splitting:

- at clip start/end
- in the middle
- at snap boundaries
- at playhead
- repeatedly
- multiple selected clips
- clips with fades
- clips with automation or metadata
- very short clips

Verify both resulting clips preserve appropriate:

- media/source references
- timing
- source offsets
- gain
- fades
- effects/state
- metadata
- selection behavior

No gaps or overlaps should appear unless intended.

---

# 6. Copy / Paste / Duplicate Audit

Test:

- copy → paste
- repeated paste
- duplicate once/repeatedly
- multi-clip copy
- copy between tracks
- copy after trim/split
- clips with fades
- clips with automation/state

Verify copied objects:

- receive appropriate unique IDs
- preserve intended properties
- do not unintentionally share mutable state
- maintain correct source references
- appear at predictable positions
- remain independently editable

Editing the copy must not unexpectedly modify the original.

---

# 7. Delete & Removal Audit

Test deleting:

- single clip
- multiple clips
- first/last clip
- selected track content
- recently duplicated clip
- split fragments
- clips with fades
- clips referenced by automation or other systems

Verify:

- selection updates correctly
- playback does not reference removed objects
- audio graph/runtime state is cleaned where necessary
- stale IDs are not retained
- undo can restore the intended state
- deleting one object does not delete unrelated state

---

# 8. Fade Audit

Test:

- fade in/out
- fade length adjustment
- zero-length fade
- maximum fade
- fades on very short clips
- fade after trim
- trim after fade
- fade after split
- split through a faded region
- fade after duplicate
- undo/redo fade changes

Verify:

- fade bounds never exceed valid clip bounds
- handles remain synchronized with state
- gain curves behave as intended
- visual representation matches audio behavior
- resizing the clip updates invalid fade lengths safely

If multiple fade curve types exist, test each one.

---

# 9. Crossfade Audit

If crossfades are supported, test:

- overlapping clips
- creating crossfade
- resizing overlap
- moving either clip
- trimming either clip
- deleting one side
- undo/redo
- very short and very large overlaps

Ensure no invalid crossfade survives after clips stop overlapping.

---

# 10. Snap / Grid Audit

Verify snapping against supported targets such as:

- beat
- bar
- subdivision
- playhead
- clip edge
- marker
- loop boundary

Test snap on/off, different grid resolutions, zoom changes, drag, trim, split, paste, and duplicate.

Look for floating-point drift and off-by-one timeline errors.

Repeated edits should not slowly move clips away from the intended grid.

---

# 11. Multi-Selection Audit

Test transformations involving multiple selected items:

- move
- copy
- duplicate
- delete
- trim where supported
- group
- drag between tracks
- keyboard operations

Preserve relative spacing and ordering.

One invalid item should not silently corrupt the entire selection operation.

---

# 12. Boundary Conditions

Test editing near:

- timeline zero
- project end
- clip start/end
- loop boundaries
- track boundaries
- source-media boundaries

Test very short and very long clips.

Check for:

- negative positions
- zero/negative durations
- invalid source offsets
- NaN
- Infinity
- rounding errors

---

# 13. Overlap Behavior

Determine intended behavior when clips overlap.

Verify whether the DAW should allow overlap, replace, layer, crossfade, or prevent overlap.

Ensure all editing operations respect that contract consistently.

Do not invent new overlap semantics.

---

# 14. Playback + Editing Interaction

If editing during playback is supported, test:

- move during playback
- trim during playback
- split during playback
- delete during playback
- duplicate during playback
- fade adjustment during playback
- seek followed immediately by edit

Verify:

- no stale scheduled events
- no duplicated playback
- no ghost audio from deleted/moved clips
- transport remains stable
- visual state matches audible state

Audio correctness is more important than visual smoothness.

---

# 15. Undo / Redo Integrity

Every important edit should be tested through:

action → undo → redo

Also test:

multiple edits → multiple undo → multiple redo

undo → new edit

Verify exact restoration of:

- clip position
- duration
- source offset
- fades
- selection where intended
- IDs/references
- track assignment
- associated metadata

Undo/redo must never create duplicate clips or orphaned runtime objects.

---

# 16. Keyboard & Modifier Interactions

Verify supported shortcuts and modifiers for operations such as:

- copy
- paste
- duplicate
- delete
- split
- undo
- redo
- multi-select
- snap override
- fine adjustment

Test key repeat, rapid shortcuts, focus inside text fields, and modifier release during drag.

Keyboard shortcuts must not trigger destructive editing while typing into unrelated inputs.

---

# 17. Zoom / Scroll Interaction

Editing should remain correct regardless of viewport state.

Test operations:

- fully zoomed in
- fully zoomed out
- after horizontal scroll
- during auto-scroll
- after track-height changes
- after viewport resize

Screen coordinates must convert to timeline coordinates consistently.

Zooming must never alter actual clip timing.

---

# 18. Interaction Race Conditions

Stress rapid sequences such as:

- move → undo → move
- split → delete → undo
- duplicate → drag → delete
- trim → trim → undo → redo
- copy → paste → immediately move

Look for:

- stale closures
- delayed state commits
- event ordering bugs
- duplicate commands
- selection races
- async results modifying outdated objects

Do not solve race conditions with arbitrary delays.

---

# 19. Visual ↔ State Consistency

After every edit verify visual representation matches authoritative project state.

Check:

- clip position
- width
- trim boundaries
- source offset
- fade handles
- selection
- track assignment
- overlap
- waveform offset
- automation association

The UI must not display a successful edit that the underlying model did not commit.

---

# 20. Regression Tests

Whenever a confirmed editing bug is found:

1. reproduce it
2. identify the root cause
3. add a regression test where practical
4. implement the smallest correct fix
5. verify the regression test
6. run nearby editing/state tests
7. inspect sibling editing operations for the same bug pattern

Prefer behavioral tests over implementation-detail tests.

---

# 21. Safe Auto-Fix Authority

You are authorized to directly fix issues when:

- the problem is confirmed
- intended editing behavior is clear
- the change is bounded
- compatibility is preserved
- relevant verification can be performed

Do not wait for permission for clear low-risk correctness fixes.

Do not autonomously redesign the editing workflow, timeline model, project format, or interaction philosophy.

---

# 22. Final Editing Stress Sweep

After individual fixes, perform combined editing sequences.

Example:

create clips
→ move
→ trim
→ fade
→ split
→ duplicate
→ move duplicate
→ delete fragment
→ undo several times
→ redo
→ playback
→ save/reload if practical

Verify that the final project remains internally valid and behaves as expected.

---

# Completion Report

At the end provide:

## Fixed
Confirmed editing and interaction bugs corrected.

## Tools Verified
List editing tools and operations actually checked.

## Edge Cases
Important boundary or interaction scenarios tested.

## Tests Added
Regression or interaction coverage added.

## Verification
Exact tests/build/typecheck/E2E commands run.

## Remaining Risks
Anything that still requires manual interaction testing, browser/platform-specific verification, or a product decision.

Do not claim all editing tools are perfect unless sufficient evidence exists.

The objective is to make the DAW editing workflow **predictable, reversible, precise, and difficult to break under real editing behavior**.
