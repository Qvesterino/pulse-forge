# Roadmap Index

**Read this first.** `docs/` holds 30+ plan and roadmap documents. This page says
which one is live. Everything else is history — useful for archaeology, not for
"what should we build next".

_Last updated 2026-10-05._

## The two documents that matter

| Order | Document                                 | Answers                                                                                                                              |
| ----- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | **`docs/AI-STRATEGY.md`**                | _Which game are we playing?_ The quality-vs-control decision, the bidirectional note-frame change, the kill list. **Read this one.** |
| 2     | **`docs/intent-killer-feature-plan.md`** | _How is that game being executed?_ Waves W0–W8, priority matrix, KPIs, invariants. Engineering plan.                                 |

## Current wave status

From the killer-feature plan's own priority matrix, as of 2026-10-04.

| Wave                              | Status                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W0.1 audio targets 19/19          | **SHIPPED**                                                                                                                                            |
| W0.2 auto-diagnosis chips         | **SHIPPED**                                                                                                                                            |
| W0.3 STT via Web Speech fallback  | **SHIPPED**                                                                                                                                            |
| W0.4 artist profile genre slots   | **SHIPPED**                                                                                                                                            |
| W1 melodic prior v3               | **CLOSED — gate FAILED** (chord-tone 50.0 % vs random 53.1 %); rerouted to `src/intent/chord-snap.ts`. **Reopened as critical path by AI-STRATEGY §1** |
| W2 MIDI corpus                    | **DEFERRED** (gate FAIL)                                                                                                                               |
| W3 in-app "learn me"              | **SHIPPED** (64/64 tests)                                                                                                                              |
| W4 Producer DNA 2.0 / features.v2 | third quarter                                                                                                                                          |
| W5 the band grows                 | fourth quarter                                                                                                                                         |
| W6 reference 2.0                  | whenever                                                                                                                                               |

## The next thing to build

Per `AI-STRATEGY.md` §3: **make the note-frame contract bidirectional.**

Today `noteFrames` exist only on the input side (`src/generative/conditioning.ts:51,124`
builds them; `types.ts`, `validation.ts`, `protocol.ts` validate them) and the only
output is `GeneratedAudio` with a `Float32Array`. The work is:

1. `GenerativeNoteFrame` in the provider **output**.
2. `supportsNoteOutput` capability, mirroring `supportsNoteConditioning`.
3. `framesToNotes()` — the inverse of the shipped `noteStateAtFrame()`.
4. `captureNotes()` — instrument tracks and patterns, not `addAudioClip` on a WAV.

This unblocks demo moment 1 (_"change the tempo by 4 BPM and the mix rebalances
itself"_), which is the only one of the three killer moments that is currently
impossible.

## Historical — not live plans

Kept for archaeology. Do not add to these; do not treat them as current.

`AI-PRODUCER-CONTRACT.md`, `effect-intent-engine-roadmap.md`,
`effect-plugin-intent-roadmap.md`, `EFFECT-POLISH-ROADMAP.md`,
`embedding-conditioning-roadmap.md`, `FX-ADD-REWORK-ROADMAP.md`,
`FX-EXPANSION-ROADMAP.md`, `IMPLEMENTATION-ROADMAP-AI-FIRST-PRODUCER.md`,
`IMPLEMENTATION-ROADMAP-AUDIOTOOL-NEXUS.md`,
`IMPLEMENTATION-ROADMAP-FXEQ-QUALITY.md`,
`IMPLEMENTATION-ROADMAP-MRT2-GENERATIVE-TRACKS.md`,
`IMPLEMENTATION-ROADMAP-OZVENA-QUALITY.md`,
`IMPLEMENTATION-ROADMAP-PLUGIN-MIXING.md`, `IMPLEMENTATION-ROADMAP-ULTINA-QUALITY.md`,
`intent-artists-and-revise-plan.md`, `intent-engine-ai-ranker-goal.md`,
`intent-engine-roadmap.md`, `INTENT-MCP-EXPANSION-PLAN.md`,
`KYX-PRE-RELEASE-IMPLEMENTATION-ROADMAP.md`, `LOCAL-INTENT-MODEL.md`,
`PLUGIN-AUDIT-FOLLOWUP-ROADMAP.md`, `PRODUCER-DNA-ROADMAP.md`,
`pulse-forge-rack-roadmap.md`, `REFERENCE-MAP-ROADMAP.md`, `ROADMAP-UI-2027.md`,
`ROADMAP-FULL-DAW.md`, `SOLO-ARTIST-ROADMAP.md`

## Authoritative for numbers

`docs/CURRENT-STATE.md` is the single source of truth for any count, per
`AGENTS.md`. If a plan document and CURRENT-STATE disagree, CURRENT-STATE wins
and the plan is stale.

## Rule

- New strategy goes in **`AI-STRATEGY.md`**.
- New execution detail goes in the **killer-feature plan** as a wave.
- New _historical_ document goes in the list above, never in a linked slot.
