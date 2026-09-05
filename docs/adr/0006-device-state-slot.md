# ADR 0006 — Host-level device state slot (`EffectInstance.deviceState`)

- Status: accepted (2026-09-04)
- Context: IMPLEMENTATION-ROADMAP-PLUGIN-MIXING.md, Fáza 2 + Fáza 6

## Context

Ultina's A/B slots were host-local React state: they died on unmount, reload,
undo/redo and never reached collab peers. The vendored core already models
`ABSnapshot`, so the missing piece was persistence in the host project model.
The same question will come back for FXEQ and Ozvena (A/B compare, editor
state that is not audio).

## Decision

1. **One generic slot, not per-plugin fields.** `EffectInstance.deviceState`
   is `{ kind: string; data: Record<string, unknown> }`. There is no
   `ultinaState` field to migrate later.
2. **Per-plugin validator, fail closed.** `schema.sanitizeDeviceState`
   dispatches on `kind`; unknown kinds drop. Shipping a new device state
   kind means adding a validator branch next to `sanitizeUltinaAbState`
   (`ultina-ab-v1` today).
3. **Meter data never persists.** `capturedLufs` and friends are session
   state. An A/B snapshot restores *parameters*, never a stale LUFS lock —
   gain-match re-arms truthfully (`WAITING FOR SIGNAL`) until real signal
   arrives.
4. **A/B activation is one command.** `loadUltinaAbSlot` restores params
   (defaults + clamped snapshot) and flips the active slot in a single undo
   step. Slot storage/copy/clear go through `setDeviceState`.
5. **FXEQ / Ozvena outcome.** They stay plugin-specific for now, but adopt
   this contract when they need editor-state persistence: add a kind
   (`fxeq-ab-v1`, …) + validator branch + panel wiring. No model or collab
   migration needed — the Y adapter syncs `deviceState` as a plain JSON blob.

## Consequences

- Collab round-trip and undo are covered by generic blob sync (tested).
- Boundaries: kind ≤ 32 chars, ≤ 64 numeric entries per slot, keys ≤ 48
  chars, non-finite values dropped.
- React-only state (collapse, loading, DOM) must never enter the slot.
