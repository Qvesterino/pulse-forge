# ADR 0037 — SKRUTKA phase dispersion (lazy first-party worklet effect)

Date: 2026-10-11 · Status: Accepted · Scope: effects registry, lazy worklet loading, bundle budgets, device panel

## Context

The registry covers amplitude, spectrum, dynamics and time, but the one
mechanism a world-class effect lineup sells and this one lacked entirely is
**frequency-dependent arrival time**: a static all-pass group-delay shaper
("disperser"). The only all-pass use was the phaser's LFO-modulated cascade;
MORPH's harmony bus has an internal diffusion network, but it is neither
exposed nor focused. Nothing in the roster can produce the modern
kick/808/percussion "throw / gulp" character or a mono-safe transient
decorrelation, because EQ, saturation, transient shapers and compressors all
move amplitude — not phase.

Two infrastructure constraints, inherited from KOREŇ (ADR 0034):

1. The core worklet bundle sits at ~145/150 KB, so a new DSP module cannot
   ride it; it needs its own lazy bundle and budget row.
2. Parameters must be AudioParams (M2 pattern) — port-message parameters are
   not delivered during `OfflineAudioContext` renders.

## Decision

1. **SKRUTKA** (effect type `skrutka`, category `character`) is a first-party
   effect whose DSP lives in its own lazy AudioWorklet module
   `public/skrutka-worklet.js`, built by `scripts/build-skrutka-worklet.mjs`
   (esbuild, plain-JS processor). It carries its own budget row
   (`SKRUTKA_WORKLET_BUDGET_KB = 16`, measured ~3 KB at v1 / ~7 KB at v2,
   with a missing-file failure).
2. **DSP is all-pass only** — |H| = 1, so a steady tone keeps its level while
   its phase is warped:
   - **DISPERSION** — 8 identical 2nd-order all-pass sections with pole
     radius `r = 0.15 + 0.83·dispersion` (≤ 0.98) centered at FOCUS. The
     group-delay hump grows with dispersion (~0.2 ms → ~8-11 ms at typical
     focuses): a broadband transient smears, a steady tone does not.
   - **PUNCH** — 3 identical 2nd-order all-pass sections on radius
     `0.93·|punch|`, whose CENTER the sign selects: positive delays the body
     band (FOCUS / 3.5) so the click leads ("forward attack"); negative
     delays the click band (FOCUS × 3.5) so the transient sinks ("sucked
     attack"). At zero the radius is zero, so gliding through zero is
     silent; `punch = 0` skips the stage bit-exactly.
   - **SPREAD** — per-channel focus offset `×(1 ∓ 0.12·spread)`. `spread = 0`
     renders L and R bit-identically (mono-safe by construction).
3. Parameters are **AudioParam descriptors** with the same ranges as
   `EFFECT_META` (FULL SWEEP in `tests/param-range-coherence.test.ts` pins
   the bounds). Parameter changes glide over a 30 ms one-pole applied at
   block rate with the block-length correction (NEW-EFFECT-CHECKLIST §4);
   the FIRST block adopts the written values exactly, so a saved `mix = 0`
   project renders bit-exact dry from sample 0.
4. Fallback is honest: `WORKLET_EFFECTS.skrutka = "degraded"` — a 1:1 bypass
   with `degradedReason` until the module lands; the engine's hot-swap
   replaces the chain when it becomes ready.
5. **No telemetry.** Phase-only DSP has no level signature and the honest
   visual (the group-delay curve) is a pure function of the params:
   `src/effects/skrutka-curve.ts` is the closed-form model of the processor,
   used by BOTH the device panel (`SkrutkaPanel`) and the tests, so the
   panel can never draw a curve the DSP does not run.
6. **No project schema bump**: the `EffectType` union is additive, effect
   instances normalize against `EFFECT_META`, unknown/absent params clamp to
   the declared defaults.

## Consequences

- Projects that never use SKRUTKA never fetch its module
  (`lazyWorkletTypesInDoc` drives `ensureWorkletsForDoc` in live and offline
  paths); `loadAllWorklets` (browser check suite) now loads 10 modules — the
  count is pinned in `tests/audio-worklets.test.ts`.
- No RNG: identical input yields sample-identical output; the DSP is
  deterministic across instances from cold.
- Registry counts move **53 → 54 effects / 48 → 49 native-core / 31 → 32
  primary Add Effect choices** (re-measured in the same commit).
- Role landings (`src/effects/role-presets.ts`) and 8 factory presets ship;
  `npm run presets:fx-loudness` regenerates `FACTORY_FX_PRESET_GAIN_DB` with
  the `skrutka-*` entries.

## Validation contract

- Processor (`tests/skrutka.test.ts`): `mix = 0` bit-exact dry from a cold
  instance; level preserved within ±5 % while the phase shifts (all-pass);
  **measured group delay matches the analytic curve module** at 200/320/640 Hz
  (model↔processor lockstep); FOCUS moves the hump; PUNCH sign picks the
  delayed band (body vs click, both against the punch-off baseline); SPREAD 0
  is bit-exact mono and SPREAD 1 decorrelates; every param finite and bounded
  at both extremes.
- Determinism + transient claim (`tests/skrutka-golden.test.ts`): three
  consecutive renders sample-identical; an impulse keeps its total energy
  (phase-only) but dispersion 1 pushes energy past sample 100 while the
  near-neutral chain keeps it concentrated.
- Registration: `EFFECT_PROC_PAIRS` + `WORKLET_CASES` entries; menu order
  surfaces (`EFFECT_ORDER`, `CORE_EFFECT_ORDER`) include the type; a
  real-browser check renders through the shipped bundle and asserts the
  loaded worklet shifts a 200 Hz sine's phase while preserving its RMS.
- `npm run presets:fx-loudness` regenerated the gain map with the 8
  `skrutka-*` presets.

## Addendum (2026-10-11) — v2: DYNAMIC + KEY + MOTION + SHAPE

v1 was a static disperser. v2 makes the phase react to the signal, to a
sidechain key and to the grid — the "dynamic phase" generation. Every
addition keeps the v1 contract: all-pass only, AudioParam-only parameters,
no RNG in the signal path, `mix = 0` bit-exact dry, and **the v1 parameter
set renders bit-identically to v1** (frozen FNV hash `e6cb495b83b6556c`
over a 1.2 s tonal + kick probe, pinned in `tests/skrutka-golden.test.ts`).

1. **DYNAMIC (`dyn`, signed −1..1, default 0).** A fast follower (1 ms atk /
   15 ms rel) versus its 60 ms lag yields a transient score with a 0.4 margin
   (a rectified sine's own ripple never reads as an attack); a 10/150 ms
   follower yields the body score, attack-suppressed. `dyn > 0` (ATTACK)
   deepens the pole radius toward 0.995 on transients; `dyn < 0` (BODY)
   deepens it on sustain, leaving the click clean. The radius DELTA glides
   with a 15 ms one-pole: an envelope-following pole radius on a
   near-unit-circle all-pass is a parametric amplifier if it tracks audio-rate
   envelope ripple — measured 10× gain before the glide, ≤ 1.1× after
   (bounded by the parameter-extreme test). `dyn = 0` does not even update
   the followers.
2. **KEY (`keyMode`: 0 OFF / 1 PUMP / 2 DUCK, default 0).** A second worklet
   input carries a sidechain key through the engine's generic
   `setSidechainInput` contract (KOREŇ wave-4 precedent; zero engine
   changes). The Effect Rack exposes the shared SOURCE selector and KICK
   shortcut for TWIST, so a key-mode preset can receive an actual track instead
   of running without a key. A 2 ms/180 ms key envelope drives the radius: PUMP deepens it
   toward the ceiling on every kick, DUCK thins it (×0.3..1) so the kick
   clears its own phase smear. No key connected is bit-exact to OFF.
3. **MOTION (`lfoRate` Hz + `lfoSync` division + `lfoShape` SINE/TRI/RAND +
   `lfoDepth`, default 0).** The rate is converted host-side and written as
   `lfoHz` (the flanger/tremolo `createLfoSyncController` contract, so BPM
   pushes work and offline automation is native). FOCUS sweeps ±
   `lfoDepth` octaves; the random shape steps once per cycle from a xorshift
   seeded by the persisted factory seed. `onTransportStarted` writes
   `lfoPhase` (position beats × cycles-per-beat, fraction) so the sweep is
   grid-anchored when the transport starts and free-runs deterministically
   from 0 otherwise. With `lfoDepth = 0` the LFO is exactly 1.0× (no-op).
4. **SHAPE (`shape` 0..3, default 0).** GULP = 8 sections at FOCUS (v1);
   CHIRP = angles log-spread 0.5×…2× FOCUS; DOUBLE = 4 at FOCUS/3.5 + 4 at
   FOCUS×3.5; RESO = the hot radius mapping (0.45 + 0.53·dispersion) for a
   tall narrow hump. Plus `punchHz` (0 = AUTO ratio, explicit center
   otherwise) and `punchMix` (parallel blend of the punch stage against the
   long output; 0 removes the stage exactly).
5. **Panel v2** — the analytic curve is now SHAPE-aware and **editable**
   (horizontal drag = FOCUS, vertical = DISPERSION by bisection over the
   peak-delay mapping, one undo frame per gesture); DYNAMIC/KEY draw the
   driven-radius band, the LFO shades its sweep range, and a live dot follows
   the processor telemetry (throttled `type:"skrutka"` frame: lfo phase,
   envelope, key gain, current radius). **BAND SOLO** auditions the focus
   band through a new monitor-only lowpass: `MasterChain.setMonitorBand` /
   `AudioEngine.setMonitorBand` add the mirror half of PHONE CHECK's
   highpass on the same LIVE-only branch (glide 20 ms; offline renders
   connect straight to their destination; released on unmount).
6. **Coupled controls, stated honestly.** `punchHz`/`punchMix` are only
   audible with PUNCH ≠ 0 and `lfoRate`/`lfoSync` only with LFO DEPTH > 0
   (the parameter audit reports them as context-coupled, same class as
   KOREŇ's `keyMode`); the defaults keep every coupled section off so the
   v1 render is untouched.

Validation additions (`tests/skrutka.test.ts` v2 block, `tests/skrutka-soak.test.ts`,
`tests/ui/SkrutkaPanel.test.tsx`, `tests/master-chain.test.ts`):

- SHAPE: CHIRP/DOUBLE/RESO each move the render; CHIRP and RESO still match
  the analytic curve (model↔processor lockstep survives the distributions).
- DYNAMIC: BODY moves the steady-state phase while ATTACK does not; on a
  note onset ATTACK's difference energy is concentrated early and decays,
  while BODY is suppressed at the onset and grows once settled.
- KEY: PUMP and DUCK move the wet-vs-dry phase in OPPOSITE directions during
  a key burst (against the pre-key reference); keyless renders are bit-exact
  to OFF; node-level key wiring repoints without double-connecting.
- PUNCH: explicit `punchHz` relocates the hump (≥ 1.5× at the new center);
  `punchMix = 0` equals `punch = 0` bit-exactly.
- MOTION: an 8 Hz LFO at full depth moves the phase deterministically across
  runs; the node wrapper converts `lfoRate`/`lfoSync` to Hz (free 2 Hz →
  4 Hz at 1/8 → 3 Hz at 90 BPM) and anchors `lfoPhase = 0.5` for position
  2.25 beats at 1/8.
- Legacy: the frozen v1 hash + abs-sum pins bit-exact backward compatibility;
  v2-only params at their defaults do not change a render.
- Soak (120 s worst case: CHIRP + spread + dyn + key + 8 Hz random LFO):
  zero non-finite samples, zero subnormals, flat CPU through silence
  (late median ≤ early median), heap growth ≤ 6 MB (measured 0.5 MB).
- Browser: the shipped bundle loads the module, shifts a 200 Hz sine's phase
  while preserving RMS, and KEY PUMP moves a real keyed render while the
  keyless render stays bit-identical to OFF.
- 8 new factory presets (Kick Duck Phase / Attack Smear / Tail Liquid /
  LFO Throw / Chirp Rise / Double Gulp / Reso Vowel / Punch Band) — the FX
  loudness map regenerated with all 18 `skrutka-*` entries.

## Addendum 2 (2026-10-11) — v2.1: FIELD (M/S dispersion field) + 300 s hardening

The display name moved to **TWIST** (the effect id stays `skrutka`; see
`docs/PLUGIN-NAMING-INVENTORY.md`) — identifiers, schema and saved projects
are untouched. Two additions:

1. **FIELD (`field`, −1..+1, default 0).** The two all-pass chains rotate
   continuously from the legacy L/R basis toward an orthogonal M/S basis as
   `|field|` rises; the existing 30 ms parameter glide also glides that basis.
   At `field = +1` the mid remains bit-exactly dry (sides-only
   dispersion is **bit-transparent for mono content** — a mono render comes
   out sample-identical), `field = −1` leaves the side dry (center-phase
   smear only), and everything between blends each component between dry and
   dispersed. In FIELD mode SPREAD moves the first chain's focus continuously
   from the legacy left offset toward center while the second chain keeps the
   side offset. The 1e-4 deadband retains bit-exact v1/v2 at the default.
   `|field| ≤ 1e-4` is the legacy stereo path — bit-exact v1/v2, so the
   frozen hash and every existing project are untouched. Rotating the filter
   basis avoids the state discontinuity caused by switching from L/R filter
   history to M/S history at the deadband edge.
2. **300 s flagship hardening** (`tests/skrutka-soak.test.ts`, AGENTS parity
   with PRISM/VLYX/VØID): a MOTION soak (full cascade + dyn + key + 8 Hz
   random LFO + FIELD, 300 s) proves zero non-finite, zero subnormals, flat
   CPU and heap ≤ 6 MB (measured 1.0 MB); a STATIC soak on a strictly
   periodic musical pattern proves amplitude drift between the 10 s and
   290 s windows ≤ 0.003 dB (measured 0.00091 dB). The drift gate uses the
   static patch by design — the motion soak's random LFO is deliberately
   aperiodic, and its determinism is pinned by the golden tests.
3. **4 FIELD presets** (Side Shimmer / Center Gulp / Field Wide /
   Mono-Safe Throw) and FIELD added to the lead/chords role landings —
   20 `skrutka-*` entries in the regenerated loudness map.

Validation additions: mono transparency at `field = +1` (sample-identical
output), mid/side isolation at ±1 (the untouched component matches the dry
render to ≤ 1e-6 while the other moves), the threshold bit-exactness at
`field = 5e-5`, the model's `skrutkaFieldAmounts` contract and the M/S
focus split, panel chips for FIELD STEREO/SIDE/MID, and the two 300 s soaks.
The transition regression measures the first output step and first-block
deviation when automating FIELD out of zero (baseline 0.1099 / 0.7101; rotated
basis 0.0067 / 0.0335 on the pinned stereo probe).

## Addendum 3 (2026-10-11) — v2.2: DYNAMIC PUNCH

The DYNAMIC layer gains a second destination: the PUNCH radius.

1. **`dynPunch` (−1..+1, default 0).** The same envelope scores that drive
   the long hump drive the punch radius: `> 0` deepens it on transients
   (every accent gets an extra phase-throw, ghosts stay put), `< 0` deepens
   it on sustain (the click stays razor-sharp, the tail develops a gulp
   that follows the note's envelope). The radius ceiling is
   `PUNCH_R_HARD_MAX = 0.97` (slightly above the static 0.93), and the drive
   rides its own 15 ms glide (`punchDelta`) — the same parametric-pump guard
   as the hump.
2. **The stage may open from zero.** With `punch = 0` the drive alone can
   raise the punch radius, so "only accents get the tilt" is a real patch
   rather than a punch preset tweak. To avoid per-block toggling of a
   resonant chain while an accent rises, the stage RUNS whenever the drive
   is armed; it is skipped bit-exactly only when both the static punch and
   the drive are off, so the v2.1 render is untouched.
3. **Panel** — the DYNAMIC PUNCH driven band draws in a cooler hue between
   the base curve and the punch-radius ceiling curve, and a
   `PUNCH-DYN OFF/ATTACK/BODY` chip joins the state row. The telemetry frame
   gains the current punch radius (`punch`).
4. **The curve model unwraps its phase.** The high-Q punch blend can cross
   an `atan2` branch between the ±δ neighbours; `skrutkaGroupDelaySamples`
   now unwraps both against the center value before the central difference
   (this also hardens the v2.1 model at extreme punch radii).
5. **4 presets** (Hard Knock / Ghost Tamer / Live Drummer / Tail Breath) —
   24 `skrutka-*` entries in the regenerated loudness map.

Validation additions: the onset-vs-settle differential at `dynPunch = ±1`
(the stage opens from `punch = 0`, ATTACK decays after the onset, BODY grows
on sustain and the two directions are complementary), bit-exactness at
`dynPunch = 0`, the model's punch-ceiling contract, the panel chip, and the
motion soak now includes the drive in its worst-case surface (the static
drift soak keeps it off).

## Addendum 4 (2026-10-11) — v2.3: CURVE SNAPSHOTS (A/B + MORPH)

Two stored curves and a morph position that an automation lane or an
intensity-sourced macro can ride: intro = curve A (center gulp) → drop =
curve B (sides shimmer).

1. **Snapshots** live on the effect's `deviceState` (kind
   `twist-curves-v1`, A/B maps, sanitized in `project-model/schema.ts` like
   the other device-state kinds). STORE A/B commits the current rack params
   as ONE undoable `setDeviceState` command (the MORPH-scenes pattern).
2. **`morph` is a real rack parameter** (0..1, default 0) — deliberately not
   a deviceState value, so the existing automation lanes and the
   `MacroMapping { source: "intensity", target }` path drive it without any
   engine change.
3. **The blend is host-side in the node** (`morphTwistParams`, shared with
   the panel so the drawn curve is always the effective one):
   - no slot stored → morph is a strict no-op (the rack params are the sound);
   - only one slot → morph blends that snapshot ↔ the live/base params
     (store A, dial the drop, morph — no second capture needed);
   - both stored → morph blends A → B;
   - a missing id on one side falls back to the base value (partial snapshots
     and imported projects stay musical).
     `morph` rides `setParameterAt` like any other param, so offline automation
     is native and live == offline holds; a chain rebuild re-reads
     `deviceState` and lands on the same sound (STORE/CLEAR additionally
     re-seed the live runtime via `setCurves`, the MORPH `morphToParams`
     precedent, so the change is audible without a rebuild). Log-tapered FOCUS
     and LFO RATE interpolate geometrically; continuous controls interpolate
     linearly; enums and the `punchHz = 0` AUTO sentinel switch at the midpoint.
4. **Panel** — STORE A / STORE B / CLEAR buttons, a MORPH slider (disabled
   until a slot exists), dotted ghost curves for the stored sides, a
   `MORPH x% A→B / A→LIVE / LIVE→B` chip, and the state chips report the
   EFFECTIVE (morphed) values. With no snapshots the panel degrades exactly
   to the v2.2 behaviour and the DSP render is untouched (bit-exact).

Validation (`tests/skrutka-curves.test.ts`, panel suite): the capture surface
is exactly `skrutkaParams − morph` (drift guard), the sanitizer drops hostile
blobs, the pure blend semantics (no-slot identity, one-slot live blend,
A→B, fallbacks, clamps), node-level construction at morph > 0, live morph
moves and `setParameterAt` scheduling, `setCurves` re-seeding and CLEAR
restoring the live knobs, undo/redo re-seeding from the document, perceptual
frequency interpolation, enum/AUTO midpoint behavior, and the curve-less node
treating morph as a strict no-op. The `morph` param is context-coupled (audible
only with a stored curve), the same class as `lfoRate`/`keyMode`.

## Addendum 5 (2026-10-11) — v2.4: PORTAL × TWIST tandem chains + semantic moves

1. **Four tandem chains** (`BEATMAKING_EFFECT_CHAINS`) pair arrival time with
   spectral time — TWIST shapes WHEN frequencies arrive, PORTAL shapes WHAT
   rings in the spectrum:
   - `phase-spectral-throw` — `skrutka-field-wide` → `portal-air-drift`;
   - `808-space-ladder` — `bassharmonic-808-phone` → `skrutka-kick-duck-phase`
     → `portal-echo-dive`;
   - `ghost-pad` — `skrutka-side-shimmer` → `portal-time-cap`;
   - `hyper-glitch` — `pitchshift-down` → `skrutka-chirp-rise` →
     `portal-sync-stutter`.
     Chain trims are measured by the FX loudness harness (13 chains now).
2. **Semantic MOVES** in the targeted-effect parser (`src/intent/mix.ts`):
   "make the 808 throw", "wider hats, mono safe", "smear the attack on the
   lead" resolve to TWIST without naming a parameter or the device. A move is
   an ABSOLUTE re-voicing (its own clamped param map) that replaces the knob
   path, and it lands FOCUS per TRACK ROLE through `roleOfTrack` (kick 250,
   808 90, chords 700, lead 1200 for THROW; 3200/900/1600/2400 for WIDER /
   MONO-SAFE). MONO-SAFE wins over WIDER when both appear ("wider hats, mono
   safe" = sides-only dispersion with a spread split). Moves imply TWIST only
   when no other effect is named — "wider reverb" keeps its own path — and a
   move without a resolvable target stays declined, never guessed. `hats` /
   `hi-hat` now resolve to the drums target.
3. **Validation** — `tests/twist-moves.test.ts` (move parsing EN/SK, no
   hijack of named effects, decline without a target, role-landed FOCUS on
   the 808 and drum tracks, mono-safe precedence, one-command replay and
   read-back) and `tests/fx-chains.test.ts` (the four chains exist with their
   documented effect order, reference real presets, ids unique).

## Addendum 6 (2026-10-11) — v2.5: SCENE PACK (A/B pairs bound to scene intensity)

Nine curated A/B curve pairs (`src/effects/skrutka-scene-pack.ts`) carry the
scene-intensity arc per genre — Trap Center → Shimmer, Drill Clean → Gulp,
House Tight → Liquid, Techno Flat → Chirp, DnB Static → Reso, Amapiano
Soft → Breath, Jersey Tick → Wide, Hyperpop Dry → Glitch, Ambient
Static → Double. Curve A is the intro-safe voicing, curve B the drop.

`applyTwistScenePair` (commands/twistScene.ts) is ONE undoable command that
stores both snapshots, sets the MORPH base to the neutral midpoint and
ensures the scene-intensity binding: a `TWIST` macro whose
`source: "intensity"` mapping targets this effect's `morph` (amount 1). The
engine resolves an intensity fxParam mapping as an offset of
`(max − min)/2 · bipolar · amount` around the persisted base, so with
`morph = 0.5` the intensity curve lands morph 0 at intensity 0 and morph 1 at
intensity 1 — playing an intro scene leans A, the drop lands B, and the user
draws nothing. The binding is idempotent (switching pairs never duplicates
it; `twistMorphIntensityBound` is the panel/rack probe) and the panel's
scene-pack select shows CUSTOM when the stored slots come from manual STOREs.

Validation: `tests/twist-scene-pack.test.ts` pins the pack inside the rack
ranges (clamp identity), the A/B contrast (≥ 2 differing ids), the exact-match
`findTwistScenePair` probe, the command's one-step apply/undo, the
single-binding idempotence across pair switches, and the non-TWIST refusal;
the panel suite covers the select → `onApplyScenePair` + live `setCurves`
seeding, the SCENE-INTENSITY chip and the CUSTOM fallback.

## Addendum 7 (2026-10-11) — shared SCENE STRIP (Mixer + Arrangement)

`src/ui/SceneStrip.tsx` mounts once under the mixer toolbar and once in the
arrangement scenes sidebar and plays both scene packs from one place: one
row edits the resolved scene's static intensity (`setSceneIntensity` — the
active scene from `activePatternId` in the mixer, the selected scene in the
arrangement; a STATIC/CURVE chip reports whether the arrangement INTENSITY
lane's curve or the static value drives playback), and one row per TWIST or
GROW device carries its active A/B pair with the same pack pickers the
device panels use. The picker executes `applyTwistScenePair` /
`applyKorenScenePair` unchanged — the strip is a second surface over the
same one-undo commands, never a parallel write path; the track name selects
the strip's track so a row is one click from the device. Collapse state
persists (`pf-scene-strip-collapsed`), and the CUSTOM fallback marks slots
stored by manual STOREs. Locked by `tests/ui/SceneStrip.test.tsx` (4 specs:
intensity commit through the command, per-device pair apply writing the
slots, SCENE chip on bound rows, CUSTOM fallback; plus the empty state).

## Addendum 8 (2026-10-11) — per-scene packs (v2.6)

A scene can now PIN which pack pair an effect plays: `Scene.packs`
(fxId → pair id, SCHEMA_VERSION 23, shape-sanitized in normalizeProject —
unknown pair ids are inert, pair data is matched at use time). The picker
lives on the scene strip's FX rows (accent-bordered, `setScenePack` — ONE
undoable command; null clears and drops the empty record).

The override is PERFORMANCE state, never a document write — the doc keeps
the effect's own applied pair as the stopped-state baseline:

- the scheduler resolves the active clip's scene per window and attaches its
  `packs` to the scene-intensity points (`sceneIntensityPointsForWindow`, and
  `buildSceneIntensityPoints` for exports — seam rule: the later point wins,
  so a pair swaps exactly on the boundary tick);
- the bridge (`scheduleSceneIntensity` / `setSceneIntensity(value, packs)`)
  resolves the pair from the shipped packs and writes it at each point:
  GROW gets `mid + (b − a)/2 · bipolar` on every pair param (the exact
  endpoint law of the pack apply), TWIST gets `setCurves(a, b, when)` — the
  node's reseed now takes an optional `when` so the slot swap lands on the
  boundary — plus `morph = intensity`;
- while an fx is overridden, its intensity/macro mappings on pair params are
  skipped (one writer per param); leaving the override (scene without packs,
  gap, or stop via `automationReset`) re-seeds the doc slots/values, so
  exports and the stopped mix match the project.

Live and offline use the same point pipeline, so an intro/build/drop
arrangement switches pairs identically in playback and render. Validation:
`tests/scene-packs.test.ts` (command + undo + validation, sanitizer, seam
points carrying the scene's packs, GROW endpoint law at points, armed-mapping
guard, TWIST slot swap + morph = intensity, exit restore, stop takeover) and
the scene-strip suite (per-scene picker writes `setScenePack`, stored
selection renders).

## Addendum 9 (2026-10-11) — scene macro pins (v2.7)

The same per-scene override now covers the OTHER modulation source: a scene
can PIN macro values (`Scene.macros`: macroId → 0..1, SCHEMA_VERSION 24,
shape-sanitized and clamped; unknown macro ids are inert), set by ONE
undoable `setSceneMacro` command (null clears). While the scene is active
the pinned value SUBSTITUTES the live macro in every `source: "macro"`
mapping — effect params, instrument params and the track gain/pan macro
offsets alike — through the exact same bipolar law, live and in exports:
the scheduler attaches the active clip's `macros` to the scene-intensity
points next to `packs` (`sceneIntensityPointsForWindow` +
`buildSceneIntensityPoints`, seam rule: the later point wins), the bridge
substitutes `macro.value` per point (and in `syncMacros` from the live
`setSceneIntensity(value, packs, sceneMacros)` call), and a stop
(`automationReset`) drops the pins so the doc macro values resume — the
MacroPerformanceBar keeps owning the live values.

UI: the scene strip gains a MACROS block — one compact fader per macro
showing the EFFECTIVE value (pinned macros render accent-bordered with a ×
that clears the pin); moving a fader pins that value to the scene. The
mixer's performance bar is untouched (and the Mixer test now scopes its
macro-name queries to the bar, since the strip legitimately renders the
same names).

Validation: extended `tests/scene-packs.test.ts` (command set/clamp/clear +
undo, sanitizer, seam points carrying `sceneMacros`, pinned substitution in
an armed macro-sourced mapping, scheduled pin points + stop restore) and the
scene-strip suite (fader pins the scene value, stored pin renders the clear
control, clearing restores the live macro).

## Addendum 10 (2026-10-11) — scene CC remap arming (v2.8)

The third per-scene performance override covers hardware input: a scene can
arm which `source:"midiCC"` mappings listen while it plays. `Scene.ccRemaps`
(SCHEMA_VERSION 25, sanitized; an EMPTY array is meaningful — "none armed" —
and survives, a non-array is dropped, an array with only invalid entries
falls back to absent so a corrupt blob can never silently disarm every
mapping): absent = all armed (the pre-scene behavior), a list = allow-list.
`setSceneCcRemap` (ONE undoable command) canonicalizes — a list covering
every CC mapping collapses back to absent, removing the last armed id leaves
the explicit empty list.

Runtime: the scheduler already attaches the active clip's scene context to
the scene-intensity points; `ccRemaps` rides along (builder + seam rule in
`sceneIntensityPointsForWindow` and `buildSceneIntensityPoints`) and the
bridge keeps it as `currentSceneCcPins` (live `setSceneIntensity(value,
packs, macros, ccPins)` in pattern mode, first-point heuristic in song mode,
cleared on stop). `MidiInput.handleCC` asks the engine
(`sceneAllowsMidiMapping(mappingId)`) before letting a mapping sweep its
macro — a missing method (mocks, pre-wire engines) keeps the old behavior.
The gate is LIVE-ONLY by nature: hardware CC never reaches an export, so no
timeline scheduling is involved; the direct workspace `config.ccMappings`
path is untouched (workspace config, not project data).

UI: the scene strip gains a CC row (only when the project has CC mappings):
one checkbox per mapping ("DRUMS ← CC74"), armed = bright, disarmed = dim;
toggling executes the command. Validation: `tests/scene-packs.test.ts`
(command allow-list semantics + canonicalization + undo + refusal, sanitizer
including the empty-list survival, seam points carrying `ccRemaps`, bridge
gate + stop lift + scheduling heuristic), `tests/midi/MidiInput.test.ts`
(disarmed mapping dropped, armed one lands, unrelated CC untouched) and the
scene-strip suite (toggle writes the command, stored disarmed state renders
unchecked).

## Addendum 11 (2026-10-12) — continuous mode transitions (v2.9)

The discrete SHAPE, KEY MODE and LFO SHAPE choices now glide through their
intermediate DSP states instead of snapping when an automation point or
curve morph changes the selected mode. The project still stores the same
integer enum values and the panel still presents the same choices; this uses
the processor's existing block-length-corrected 30 ms parameter glide.

- **SHAPE** interpolates each section's focus multiplier between neighboring
  GULP / CHIRP / DOUBLE / RESO layouts. The long-stage radius also blends
  between the regular and RESO ranges from DOUBLE toward RESO.
- **KEY MODE** crossfades OFF → PUMP → DUCK. In the PUMP-to-DUCK interval,
  both signed radius drives blend continuously; the matching key gain follows
  the same weights.
- **LFO SHAPE** blends SINE → TRI → seeded RAND. Random values still advance
  once per LFO cycle, so a repeated render with the same seed and automation
  remains deterministic.

Exact enum endpoints select their original coefficients directly. The frozen
v1 render hash remains pinned, the analytic curve model follows fractional
SHAPE states, and the 300 s motion and static soaks now include the fractional
SHAPE / KEY / LFO states. Validation: `tests/skrutka.test.ts`,
`tests/skrutka-golden.test.ts`, `tests/skrutka-soak.test.ts`,
`tests/ui/SkrutkaPanel.test.tsx`, and `npm run build:skrutka`.

## Addendum 12 (2026-10-12) — actual LFO focus telemetry (v2.10)

The worklet telemetry now carries `focusHz`: the current smoothed FOCUS after
the active LFO waveform and depth have been applied. The node wrapper rejects
non-finite or out-of-range values, and the panel plots this processor value
directly. It no longer reconstructs the live focus from phase and the target
LFO shape, which previously drew RAND as a SINE wave and missed the processor's
short parameter glide. Telemetry cadence and audio-path behavior are unchanged.

Validation: a processor pin checks the deterministic RAND focus value, the
node-wrapper test rejects malformed focus telemetry, and the panel canvas test
checks the live point's frequency coordinate against the processor value.
`tests/skrutka.test.ts`, `tests/ui/SkrutkaPanel.test.tsx`, the frozen golden
suite, `npm run typecheck`, and `npm run build:skrutka` pass.

## Addendum 13 (2026-10-12) — full live response curve (v2.11)

The panel previously combined a live LFO-focus point with the project's saved
parameter values for the rest of its curve. That meant AudioParam automation,
scene-intensity MORPH, and the worklet's own smoothing could change the sound
without moving the plotted response. The processor's existing observer frame
now includes the smoothed dispersion, signed punch settings, SHAPE, SPREAD,
FIELD, dynamic controls, KEY mode, LFO depth, and the actual long/punch radii.
The wrapper bounds-checks the full frame before caching it; the panel uses the
validated state for the L/R or M/S curve and peak readout. Stored A/B ghosts
remain references to the saved curves.

The dynamic radius envelope now uses explicit minimum/base/maximum bounds.
PUMP and DYNAMIC expand the radius, KEY DUCK reduces it, and transitional KEY
states can show a range on both sides. Telemetry remains observer-only at the
existing cadence; no DSP coefficients, audio routing, or persisted project
state changed.

Validation: the processor/node tests pin the full frame and reject malformed
fields; the panel test checks an automated fractional SHAPE/FIELD/PUNCH curve
against its live peak; the browser harness checks the built lazy worklet over a
real `AudioContext`. The 300 s soaks and frozen audio golden remain applicable
because the audio path is unchanged.

## Addendum 14 (2026-10-12) — output-aware response view (v2.12)

The device panel now separates the fully wet disperser curve from the
effective output. **WET DELAY** retains the editable design curve;
**OUT DELAY** measures the phase derivative after PUNCH, rack MIX and OUTPUT;
**OUT LEVEL** shows the resulting magnitude in dB, including cancellation
caused by the parallel PUNCH blend.

The analytic output model evaluates the complex transfer, rather than
interpolating group-delay values. It includes the rotated FIELD matrix and
the M/S dry/dispersed blends, so intermediate FIELD settings are represented
by their actual component transfer. A response below −100 dB has no useful
phase derivative and is drawn as a gap; the level view shows the associated
null. The existing ~20 Hz observer frame now includes smoothed MIX and OUTPUT
so automation and worklet smoothing remain visible.

Validation compares magnitude and group delay against rendered worklet audio
for partial MIX/PUNCH and fractional FIELD, verifies the dry output is flat
and delay-free at MIX 0, and checks the panel's three views. The audio
processor path itself is unchanged.

## Addendum 15 (2026-10-12) — phase-independent stereo dynamics detector

The DYNAMIC and DYNAMIC PUNCH followers now use linked stereo energy,
`sqrt((L² + R²) / 2)`, rather than the absolute mid sum. The previous
`abs((L + R) / 2)` detector could cancel on anti-phase or SIDE-only material,
leaving the dynamic controls inactive even while FIELD processed that SIDE
content. Dual-mono input keeps the same nominal detector level.

Validation: the processor suite renders an anti-phase SIDE-only transient
through FIELD +1 and proves DYNAMIC changes the live output; existing mono
attack/body tests keep their envelope behavior. This is an intentional DSP
change for stereo dynamic material; static renders and the frozen v1 default
remain unchanged because DYNAMIC defaults to off.

## Addendum 16 (2026-10-12) — recursive-state input hardening

The worklet now replaces non-finite program and KEY samples with silence
before they reach the envelope followers or all-pass delay cells. It also
bounds finite input peaks at ±8 (+18 dBFS), preserving generous float
headroom while containing corrupted samples before they enter recursive state.
An output-only finite check was insufficient:
once a NaN entered a recursive delay cell, later valid audio could be muted
indefinitely.

Validation compares processor renders containing NaN/Infinity and extreme
finite samples with equivalent silence and ±8 clamped samples. The shipped
browser harness includes an extreme SIDE-only sample and checks finite output
with peak below the input ceiling.

## Addendum 17 (2026-10-12) — phase-independent stereo KEY detector

The sidechain KEY envelope now uses linked stereo energy,
`sqrt((L² + R²) / 2)`, matching the DYNAMIC detector. The previous
`abs((L + R) / 2)` mono sum could cancel an anti-phase or SIDE-only key,
leaving PUMP/DUCK inactive even though the key input carried signal. A
dual-mono key retains its nominal detector level; mono key feeds retain the
same behavior.

Validation compares a stereo dual-mono key with an equal-level anti-phase
key and proves both drive the same PUMP response. The browser harness repeats
that comparison through the shipped lazy worklet and confirms that the
sidechain changes the program output.

## Addendum 18 (2026-10-12) — detector activity and context-aware controls

The panel now exposes the existing DYNAMIC envelope score and effective KEY
response as live, accessible meters. KEY reports whether PUMP or DUCK is
moving the phase and its current gain factor; a selected KEY mode without a
sidechain source is called out as `NO SOURCE`. The observer-frame validator
now bounds that gain to the processor's actual 0.3–2.0 range.

The parameter editor also explains when conditional controls cannot affect
the sound: PUNCH settings with the stage blended out or unarmed, LFO settings
with zero depth, KEY MODE without a key source, and MORPH without a stored
curve. These are UI-only clarifications; the audio coefficients and saved
project shape are unchanged.

Validation: `tests/ui/SkrutkaPanel.test.tsx` pins live meter values and the
missing-source state, `tests/ui/ui-small-logic.test.ts` pins every conditional
hint, and `tests/skrutka.test.ts` rejects an out-of-range KEY gain telemetry
frame without replacing the last valid frame.

## Addendum 19 (2026-10-12) — scene CC re-points + scene-performance consolidation

The CC dimension now covers WHERE a mapping listens, not just WHETHER it is
armed. `Scene.ccOverrides` (mappingId → { ccNumber (0..127), channel
(1..16) }; SCHEMA_VERSION 29, sanitized — invalid entries drop, the record
collapses to absent) re-points a `source:"midiCC"` mapping while the scene
plays: the same mapping can sit on CC74 ch1 in the intro and listen on CC20
ch5 in the drop, so one hardware knob hands over to another — or a free knob
takes over a mapping whose usual CC is occupied.

`setSceneCcOverride` (ONE undoable command) merges a patch and
CANONICALIZES: a field equal to the mapping's own value is dropped, the last
field clears the entry, the last entry clears the record — typing the base
value back IS the clear gesture (no separate clear button). `MidiInput
.handleCC` resolves `engine.sceneCcOverride(id)` before matching, then the
arming gate, then sweeps the macro.

The same wave CONSOLIDATED the per-scene plumbing: the scheduler, the
offline renderer and the live bridge now share one shape —
`src/project-model/scene-performance.ts` (`ScenePerformance` +
`scenePerformanceOf(scene)`) — `SceneIntensityPoint extends ScenePerformance`
and the live call is `setSceneIntensity(value, scene)` instead of a growing
positional tail (packs, macros, ccRemaps, ccOverrides). One definition of
"what a scene carries into performance"; every consumer (pattern call,
window points, export points) sees the same arc.

UI: each scene-strip CC row gains compact `CC` / `CH` number fields
(NumericDraftInput — one command per blurred edit, Escape reverts, 0 in CH =
Any) showing the effective listen values. Validation: `tests/scene-packs
.test.ts` (merge/canonicalize/validate/undo, sanitizer, seam points carrying
`ccOverrides`, bridge getter + stop clear + scheduling heuristic),
`tests/midi/MidiInput.test.ts` (own CC silent while re-pointed, re-pointed
CC lands, channel re-point filters) and the strip suite (fields write the
command, stored overrides render).

## Addendum 20 (2026-10-12) — per-scene modulator patterns

The performance layer gains its fourth dimension: a scene pins the
MODULATION PATTERN. `Scene.modulators` (lfoId → { steps?, seed? };
SCHEMA_VERSION 31, sanitized — steps ≤ 64 bipolar values, seed ≤ 64 chars,
empty entries and the empty record collapse away): while the scene is
active the step modulator plays the pinned `steps` and the random S&H
modulator draws from the pinned `seed`; absent fields keep the modulator's
own pattern.

The modulator math was already pure (`modulatorEventsInRange` /
`modulatorPointValue` take an `Lfo`), so the implementation patches the
EFFECTIVE Lfo before every call — one resolution point, no new DSP. The
scene context rides two existing wires:

- live: `scheduleWindow` now tracks the window's scene across BOTH mode
  branches and passes `scenePerformanceOf(windowScene)` to the tail
  `applyModulators(from, to, whenFor, scene)` — the same performance context
  every other dimension uses;
- offline: `scheduleModulatorsOffline` windows carry `scene?` and the
  renderer attaches each window's scene performance (`window.sceneId` /
  pattern fallback), so an export hears the same scene arc as playback.

`setSceneModulatorPattern` (ONE undoable command) sets/clears one field at a
time with bipolar clamping and NO canonicalization — pinning the CURRENT
pattern is the point, so the pin must survive later doc edits; the strip's
× clears (the macro-pin pattern).

UI: the scene strip gains a modulator row per schedulable LFO (STEP n /
S&H n with the target in the title): PIN captures the current pattern (a
step modulator pins `stepsOf(lfo)`; a random one pins its seed, or a
deterministic scene-scoped seed `${lfoId}:scene:${sceneId}` when the
modulator had none — stable across peers and reloads), the pinned row shows
`STEPS ×n` / `SEED xxxxxx…` plus the clear ×. Validation:
`tests/scene-packs.test.ts` (command set/clear/clamp/validate/undo,
sanitizer, scheduler handing the window scene to the modulator sweep, bridge
substituting pinned steps live + through the offline window hook) and the
scene-strip suite (PIN writes the command with the captured pattern, the
pinned row renders the detail + clear).

## Addendum 21 (2026-10-12) — in-strip step editor

Drawing the pinned modulation pattern no longer detours through MOD. The
scene strip's pinned STEP row now renders a compact `StepGridEditor`
(shared component, `height` prop added for the dense strip row — MOD keeps
64 px): drag paints the scene-pinned steps, a single commit fires on
pointer-up, and the 8/16/32 tools resize through the same one-undo command
(`setSceneModulatorPattern`). PIN still captures the current doc pattern;
from there everything is drawn in place, row by row, scene by scene.

The same wave hardened the shared editor with the ref-authority pattern the
Slider already documents (audit 16): pointerdown/move are CONTINUOUS events,
so their setState can flush after a fast pointerup — a quick click used to
commit the pre-stroke array. `paint` now computes the next array EAGERLY,
stores it in `liveRef`, and `commit` reads the ref (state stays the render
source). Pinned by the strip suite's fast-flick case (down + up in ONE
flush still commits the painted value) plus the existing StepGridEditor
contract tests (single commit per stroke, pointer-cancel commits).

Validation: `tests/ui/SceneStrip.test.tsx` (pinned row renders the grid,
paint commits the drawn value through the command, the flick regression,
8/16/32 resize) and `tests/ui/StepGridEditor.test.tsx` / `EffectRack` (the
shared component's contract unchanged for both hosts).