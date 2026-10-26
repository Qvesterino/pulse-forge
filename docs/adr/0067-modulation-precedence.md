# ADR 0067 — One effect parameter, four modulation sources: an explicit precedence

Date: 2026-10-27 · Status: Accepted (shipped) · Scope: modulation write path, effect/instrument parameters

## Context

An effect (or instrument) parameter has **ONE** `AudioParam`
(`src/audio-engine/deviceLookup.ts:59-93`). Four modulation sources point at it and each of them
writes that same parameter:

| source                                  | what it writes                    | when                           |
| --------------------------------------- | --------------------------------- | ------------------------------ |
| automation lane                         | the lane's **absolute** value     | every scheduler window (25 ms) |
| scheduled modulator (random / step LFO) | `base + halfRange·value`          | every scheduler window (25 ms) |
| macro                                   | `base + halfRange·bipolar·amount` | on every document change       |
| MIDI CC                                 | the clamped CC value              | when a CC arrives              |

Track gain and pan never had this problem: they have **dedicated modulation buses**
(`modAutoGain` for the lane, `modMacroGain` for the macro) and compose multiplicatively.

The audit (F-11, `STATE_DIVERGENCE_HUNTER_REPORT.md`) measured what the four writers produce:

- **The macro's contribution was dropped silently.** The macro wrote on a document change; the
  scheduler rewrote the parameter on the next tick. The user moved the macro and heard nothing.
- **A macro move was audible for up to one scheduler window (25 ms)** before the lane overwrote
  it — a short but real glitch.
- **The lane-versus-modulator contest was decided by write order, not by a rule.** The scheduler
  calls `applyAutomation` and then `applyModulators` in the same window, and the modulator's
  write is scheduled 5 ms later (`Scheduler.ts:1200` / `:1250`, the modulator adds
  `scheduleOffsetSec() + 0.005` where the lane adds `scheduleOffsetSec()`). The modulator
  therefore won — by 5 ms of scheduling, not by any decision.

> **Correction to the audit text.** The F-11 finding proposed the order
> "automation > macro > modulator" and described it as today's audible result. Measured, that is
> wrong on the lane/modulator pair: today the **modulator** wins it (it writes 5 ms later), and
> the macro is beaten by both. The order decided here puts the **lane** first, which is a
> deliberate, deterministic change — not a description of the old behaviour.

## Decision

**Automation > modulator > macro > MIDI CC.** A source may write a parameter only when it is not
outranked by the source that owns it.

1. **One gate.** `AutomationBridge.writeModulated(target, source, value, when?)`
   (`src/audio-engine/automationBridge.ts`) is the only path a modulation source uses to write a
   device parameter. The four writers route through it; `DeviceLookup.writeDeviceTargetAt` stays
   the clamped last mile.
2. **The ownership is document-derived.** `src/project-model/modulation-precedence.ts` computes
   which source owns which parameter from the project: the lanes (project, scene, arrangement
   clips), the scheduled modulators and the macro mappings. It is the same read model the UI
   discloses, so the badge can never disagree with the engine.
3. **The live bit is "the automation is driving".** Automation owns a parameter only while it has
   actually written since the last takeover (`automationLive`). The stop / seek takeover
   (`automationReset()`) restores the document base and clears the flag — the macro takes the
   parameter back, exactly as the existing comment in that method promises.
4. **Removing a lane releases the parameter at once.** The ownership is recomputed on every
   document change (`syncLfos` + `syncMacros` run on every change), so a deleted lane hands the
   parameter to the macro without waiting for a stop.
5. **What stays outside the gate, and why.**
   - **Track gain/pan** compose through their own buses — they never shared a parameter.
   - **Audio-rate oscillators** (`kind: "osc"`) are CONNECTED into the parameter
     (`automationBridge.ts:533`) — they add to it instead of replacing it, so they compose with
     the macro instead of fighting it. Only the writers of an ABSOLUTE value conflict: the
     scheduled modulators and an env follower that could not be wired audio-rate (the follower is
     POLLED then, and the bridge classifies it from its own runtime state).
   - **Scene packs** pin a PAIR of parameters and re-assert the pair on every sync; splitting the
     pair by a per-parameter precedence would break that atomicity, so the pair write stays
     outside the gate. The scheduler still rewrites the lane on top of it.

## Consequences

- **A parameter driven by both a lane and a modulator now follows the lane.** Before, the
  modulator won it by 5 ms of scheduling. The result is deterministic now, and it matches the
  industry norm (Ableton / Logic: recorded automation overrides a live modulation source).
- **A MIDI CC no longer overrides a macro on the same parameter.** The CC is the lowest source;
  it still works on every parameter nothing else owns.
- **The macro is no longer silently dropped.** It is either applied, or the UI says who holds the
  parameter.
- **The 25 ms glitch is gone.** While a lane drives a parameter, the macro does not write to it
  at all, so a macro move cannot be heard between two scheduler windows.
- **Live and offline agree.** The offline renderer schedules the automation before the modulators
  (`src/rendering/renderer.ts:619` → `:628`), so the same precedence resolves the same way in the
  export as in playback.

## Verification

- `tests/modulation-precedence.test.ts` — the gate at the bridge level (lane beats macro and
  modulator, modulator beats macro, macro beats CC, the stop takeover hands the parameter back, a
  deleted lane releases it, the track bus is not gated) plus the read model (the owner per
  source, empty lanes, muted clips, deprecated param aliases).
- `tests/ui/macro-owner-badge.test.tsx` — the disclosure: the badge names the owner, and it
  FOLLOWS the lane slice (the F-09/F-10 staleness class).
