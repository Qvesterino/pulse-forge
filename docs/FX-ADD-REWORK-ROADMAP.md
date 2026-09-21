# FX ADD REWORK ROADMAP

> How effects get ONTO an instrument — a modular, goal-first add system —
> plus the completeness pass that makes every effect land sounding right.
> Written 2026-09-21 from a full registry audit (data below, reproducible
> with the audit one-liners in the session log). Companion to
> `docs/FX-EXPANSION-ROADMAP.md` (which shipped the devices; this ships the
> doors).

---

## 0. Thesis

The engine side of "add an effect to a track" is **right**: effects are
per-track device chains, every add is an undoable command, one engine drives
live and offline. Nothing below touches that.

What's wrong is the **door**: the primary add surface is a `<select>` with
~45 device names. That is a pro-tool interface for people who already know
whether they want an "SV Filter". Our user (beatmaking beginner, local-SUNO
ambition) has a GOAL — "make the 808 deeper" — not a device name. And when a
device lands, it lands on generic defaults: adding Reverb today gives you
**nothing** (it is one of 7 types with zero presets), and adding Vinyl to an
808 sounds identical to Vinyl on hats.

Three moves, in order: **goal-first door** (Wave A), **role-aware landings**
(Wave B), **close the completeness gaps the audit found** (Wave C), then
**one place with all entries** (Wave D).

---

## 1. Audit (2026-09-21, registry as of HEAD)

Reproduce: parse `src/effects/registry.ts` + `src/effects/presets.ts` for
`const X: EffectDefinition` blocks / `preset(...)` helper calls.

| Metric | Value | Verdict |
|---|---|---|
| Effect definitions | 46 | — |
| Real DSP paths | 46/46 (AudioWorklet nodes or native WebAudio graphs) | ✅ no inert effects |
| Bypass-fallback-only | 0 (gate/transient fall back only when the worklet module is missing) | ✅ |
| Flagships with own panels/preset systems | fxeq, ultina, ozvena, kaskada, morphdynamics | ✅ out of scope |
| Non-flagship types with presets | 35/41 (128 presets total) | 🟡 |
| Non-flagship types with ZERO presets | **7**: `reverb`, `distortion`, `phaser`, `bitcrusher`, `saturation`, `shimmer`, `pump` | ❌ reverb is the flagship gap — most-used effect in beatmaking |
| Tempo-synced modulation | **0 of 6** rate-driven effects (`chorus`, `flanger`, `phaser`, `tremolo`, `pump`, `freqShifter` LFO) expose a musical division; rate is Hz-only | ❌ beatmaking wants 1/8, 1/8T, 1/16 |
| Role-aware starting points | none — presets are one global set per type (Vinyl-on-808 == Vinyl-on-hats) | ❌ |
| Thin definitions (≤3 params) | `ringMod`, `stutter`, `vowel`, `pump`, `haasWidener` | 🟡 acceptable for single-purpose devices; presets + blurbs matter more than param count |
| One-line descriptions (`blurb`) | none — the add surface can't say what a device does | ❌ |

**Reading:** the user's hunch "not all effects feel fully-featured" is
correct, but the gap is not DSP — it is the last mile: 7 preset-less types,
no tempo sync, no blurbs, no role awareness. That is a presets/metadata +
small worklet-param wave, not a rewrite.

---

## 2. Wave A — Goal-first FX popover (the modular door)

**Outcome:** `+ FX` on a track opens a popover that speaks goals; the raw
dropdown stays one click away for pros.

### A1 — `EffectDefinition.blurb` (registry metadata)
One line per device, written for the add surface ("Kills everything below
the tuned note — classic 808 glide glue" for pitchShift). 46 blurbs live in
the registry next to the params. Gate: a registry test asserts every
non-flagship def has a non-empty blurb.

### A2 — `src/ui/FxAddPopover.tsx`
New component, opened from the rack header (`+ FX`) and the mixer batch bar:

```
┌──────────────────────────────────────────────┐
│ what should this track do?  [___________] ⏎  │  ← text path
│                                              │
│ [DEPTH]  [PUNCH] [WARMTH] [AGE]  [WIDTH]     │  ← goal tiles (5 categories
│ [GRIT]   [MOVE]  [SPACE]  [SHAPE] [TOOLS]    │    mapped to registry category)
│                                              │
│ TONE ──────────────────────────────────────  │
│ ▸ SV Filter   reshapes tone, resonant sweeps │  ← device grid: name + blurb
│ ▸ EQ          4-band paint, M/S capable      │    + preset count badge
│ ▸ Multiband   3-band tone splitting          │
│ …                                            │
│ [ ALL DEVICES (dropdown) ]                   │  ← pro escape hatch
└──────────────────────────────────────────────┘
```

- **Text path** routes through EXISTING parsers, scoped to this track:
  production concepts ("deeper", "wobbly") fold via the production planner
  onto THIS track; effect-name matches jump the grid. No new NLP.
- **Goal tiles** expand to the device grid filtered by category. Tile labels
  are human words; the category enum already exists
  (`EFFECT_DEFS[type].category`).
- Keyboard navigable, ESC closes, respects the click-does-not-focus policy
  (`data-allow-focus` hatch where needed).

### A3 — Integration
EffectRack header and Mixer batch bar swap their `<select>`-first for
popover-first; `ALL DEVICES` keeps the old select for the full list. The
batch path gains the same tiles ("add X to N tracks").

**Tests:** popover render test (tiles → grid → add command fired with right
type), text path routes production concepts to the track, ESC/focus behavior,
batch integration. ~1 session.

---

## 3. Wave B — Role-aware landings (adding = sounding right)

**Outcome:** an added effect lands with starting parameters tuned to WHAT IT
IS ON, not factory defaults.

### B1 — `src/effects/role-presets.ts`
`rolePresetFor(type, role): Record<string, number> | null` where role ∈
`drums | kick | snare | hats | bass | chords | lead` (drum sub-roles via the
existing `classifyPads`). Content: a small hand-tuned table, e.g.

| type | bass | hats | notes |
|---|---|---|---|
| vinyl | amount .45, crackle .3, wow .7 (tape-ish wobble) | amount .7, crackle .8, crackleTone up (sizzly dust) | the canonical example |
| tapeSat | drive low, tone warm | drive higher, tighter tone | glue vs sizzle |
| svFilter | LP low-reso (mud control) | HP (dust removal) | |
| pitchShift | −3…−5 st (depth) | off (don't) | role-presets can also say "don't suggest" |

### B2 — Fold-on-add (UI level, command stays pure)
After `addEffect` fires, the rack folds the role preset over defaults with
ONE `setEffectParam`-batch command (one undo step for add+tune together).
`addEffect` itself is untouched — the fold is presentation-layer sugar, so
Dice/intent/song paths stay byte-identical.

### B3 — Preset `roleHints`
`EffectPreset` gains `roleHints?: Partial<Record<Role, Record<string,
number>>>` — existing presets progressively declare per-role deltas; the
popover shows the role-tuned name when it applies one ("Vinyl · 808").

**Tests:** role-preset fold unit tests (clamped to ParamDef metadata, one
undo restores add+fold together), a golden-ish table test for the canonical
vinyl/sat cases. ~1 session.

---

## 4. Wave C — Completeness pass (the audit gaps)

### C1 — Presets for the 7 bare types
`reverb` (4: Room / Hall / Tight / Dark Plate), `distortion` (3),
`phaser` (3), `bitcrusher` (3), `saturation` (3), `shimmer` (3), `pump` (3)
— ≈22 presets, following the existing `preset()` helper style. Gate: a
registry test asserts **every non-flagship type has ≥2 presets** (no more
naked devices).

### C2 — Tempo-sync for the 6 rate effects
Add an optional `sync` param (options: OFF / 1/4 / 1/8 / 8T / 1/16 / 1/16T)
to `chorus`, `flanger`, `phaser`, `tremolo`, `pump`, `freqShifter` LFO.
Mechanics mirror the existing pattern: worklet keeps Hz as the source of
truth; when sync ≠ OFF the host message path (already used by beatMangler's
bpm messages) pushes bpm and the worklet derives rate = bpm×division.
Defaults stay OFF → zero behavior change for existing projects, **no schema
bump** (param addition is additive).

**Tests:** worklet-level eval (sync=1/8 at 140 bpm yields expected Hz),
golden vectors unaffected when OFF. ~1 session together with C1.

### C3 — Thin-device polish (optional, last)
`ringMod` +`lfoRate/lfoDepth` (ring mod drift), `haasWidener` +`tone`
(crossfeed LP), `vowel` +`shift` (vowel morph). Only if time allows — blurbs
and presets already fix their discoverability.

---

## 5. Wave D — One door, all entries

The popover's text path becomes THE track-level entry: production concepts
fold track-scoped, the effect-intent assistant's clarify flow handles
device-level asks, favorites (localStorage) pin frequent devices to the top
of the grid. The INTENT panel stays whole-song/pattern; per-track language
lives at the track. ~0.5 session after A–C settle.

---

## 6. Test gates (whole roadmap)

| Gate | Expectation |
|---|---|
| `npm run typecheck` | clean |
| registry metadata test | every non-flagship def: blurb non-empty, ≥2 presets |
| role-preset tests | fold clamped to ParamDef, one-undo add+tune |
| sync eval tests | OFF == golden vectors (byte-identical), divisions land on musical rates |
| popover tests | tiles/grid/text routing, batch path |
| `npm run test` full | no regressions in intent-family + effects suites |

## 7. Explicitly out of scope

- Per-pad FX chains (ADR 0006 device model is per-track — not touching it).
- VST-style plugin hosting/browser (VISION §1).
- Drag & drop from a device browser (edge affordance; the popover replaces
  the need).
- Any change to `addEffect` command semantics or `SCHEMA_VERSION`.

## 8. Suggested order

A1+A2+A3 (door) → C1 (reverb presets FIRST — most visible gap) → B (role
landings) → C2 (sync) → D (unify). Each wave ships green and useful on its
own.
