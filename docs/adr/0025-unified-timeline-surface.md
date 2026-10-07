# ADR 0025: Unified timeline surface, dual content types

Date: 2026-10-07 · Status: Accepted · Scope: arrangement model, editor surface, selection

## Context

The arrangement hosts two clip systems that share one timeline:

- **ArrangementClip** (7 fields): a launcher for scene/pattern content — integer
  bars, no-overlap lane, transitions between clips, phase/scene-automation
  offsets, per-clip loop.
- **AudioClip** (22 fields): a full timeline object — source window
  (offset/trim), fades, gain, warp pins, time-stretch, take-lane membership,
  sub-bar tick-precise geometry, free layering.

The editor hardening waves (selection parity, block move, marquee, snap,
reorder) already unified the INTERACTION surface: one selection store, one
keyboard Delete, one marquee, one snap grid. What remains split is (a) a few
user-facing operations (split-at-playhead is audio-only; ripple does not move
audio clips) and (b) code that routes by "which id set contains this id"
(App delete, context menu, the selection invariant hook, marquee, `P`
locators).

## Decision

1. **One timeline surface, two content types** — the FL Studio playlist
   model. Every timeline interaction (select, move, duplicate, delete, split,
   snap, ripple) behaves uniformly regardless of what a clip contains. The
   content types keep their natures: scene clips stay integer-bar/no-overlap
   launchers, audio clips stay tick-precise/layering objects.
2. **A shared read model, `timelineItemsOf(doc)`**, is the single place that
   projects both id sets into one `TimelineItem` view
   (`{ id, kind: "scene" | "audio", startBar, lengthBars }`). View consumers
   (marquee, hit-test ranges, selection routing) read the projection instead
   of unioning id sets by hand.
3. **Storage stays dual.** A physical merge (one `Clip` row with a
   content union) is REJECTED for now: it is a multi-week schema-v11
   migration across ~90 files, the collab adapter, the MCP mirrors and the
   golden locks, for zero user-visible gain — the engine already consumes a
   unified event stream (TriggerEngine has no notion of scene clips; the
   scheduler lowers scene clips to note events before audio ever runs).
4. **Revisit triggers for the storage merge** (any one of these reopens the
   question):
   - collab merge conflicts arising from the two arrays' independent orders;
   - a user-facing feature that needs scene-clip fields audio clips have
     (fades, colors) or audio fields on scene clips (source windows);
   - a measured performance wall from maintaining two sorted indexes in the
     arrangement renderer.
5. **Parity first, adapter second.** The visible gaps close against today's
   commands (scene split at playhead; ripple shifts audio clips at/after the
   edit point), then the read model replaces hand-rolled unions. The adapter
   is also where any future storage merge would land, so building it now
   keeps that door open instead of widening the ditch.

## Consequences

- Split-at-playhead (Ctrl+E) and ripple become timeline-wide operations; the
  audio-shift part of ripple follows the layering contract (clips at/after
  the edit point shift; a clip straddling the boundary stays put).
- Duplicate semantics stay intentionally different — scene duplicates must
  forward-bump (no-overlap), audio duplicates land exactly after the source
  (layering) — and are NOT treated as a gap.
- New timeline features are written once against the projection; the "twice
  tax" stops growing.
- The document schema, persistence and collab payloads do not change.
