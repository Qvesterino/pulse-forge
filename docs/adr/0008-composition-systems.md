# ADR 0008 — Composition: scenes, arrangement, automation, LFO, macros

Date: 2026-08-15
Status: Accepted

**Scenes** reference patterns (never duplicate data). A scene is a named launch slot for one pattern; the **arrangement** is a single timeline of clips (scene + start bar + length). The scheduler gained a song mode: each lookahead window is intersected with the clips it spans, and events are scheduled relative to the clip's pattern (short patterns loop inside longer clips; gaps are silent). Pattern mode remains the loop-based original.

**Automation** is pure data (`AutomationLane` with a target path and linear-interpolated points). The scheduler calls the engine once per window with a tick→pattern-relative mapping; track volume/pan lanes schedule exact `setTargetAtTime` ramps, effect/instrument lanes apply at window resolution. Automation lives in pattern space and resets on stop.

**Modulation node separation**: every track chain ends with `modAuto(Gain,Pan) → modMacro(Gain,Pan)` stages. Automation writes modAuto, macros write modMacro, LFOs connect oscillator outputs into modAuto params, and manual volume/mute/solo keep the earlier manual nodes. No two subsystems write the same AudioParam, which keeps undo/drag/playback interactions predictable.

Consequence: mode switching mid-playback is safe (read live each window), and future scene-level automation or launch quantization can reuse the same window/clip machinery.
