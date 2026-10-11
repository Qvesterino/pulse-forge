# Plugin / Effect Naming Inventory

**Purpose:** canonical list of every user-facing plugin, instrument and effect name in
KYX / Pulse Forge, each with one line on what it actually does. This is the reference
for the naming pass — **it describes what ships today, it does not propose new names.**

**Verified:** 2026-10-11 by direct read of `src/effects/registry.ts` (`EFFECT_DEFS`,
54 entries), `src/instruments/registry.ts` (`INSTRUMENT_DEFS`, 24 entries),
`src/effects/blurbs.ts` and the `EffectType` / `InstrumentKind` unions in
`src/project-model/types.ts`.

Counts match `docs/CURRENT-STATE.md`: 54 effects (49 native/core + 5 flagship suites),
24 instruments.

---

## 1. Flagship plugin suites (5)

The branded devices. These already carry a marketing-style name, are the only ones with
dedicated panels, and carry a vendored DSP core or a custom worklet.

| Current name | Kind | What it is |
| --- | --- | --- |
| **PRISM** | flagship FX | 8-band paintable EQ with M/S — tone surgery by drawing curves. |
| **VLYX** | flagship FX | Mix Assist — analyzes the mix and proposes corrective moves. |
| **VØID** | flagship FX | Reverb network where every frequency band has its own decay time. |
| **MORPH** | flagship FX | Dynamics that morph continuously between pressure curves. |
| **RYFT** | flagship FX | Reverse sweeps, freeze and spectral ducking in one space device. |

---

## 2. Effects (54) by category

Categories are the ones used in `EFFECT_DEFS`.

### Character (19)

| Current name | Type key | What it is |
| --- | --- | --- |
| Pitch Shift | `pitchShift` | Moves sound up or down in pitch — 808 depth and glide glue. |
| Pitch Correct | `pitchCorrect` | Snaps off-pitch notes to a scale, from polish to hard autotune. |
| ZENIT | `zenit` | Mastering strip: EQ, glue, drive, width and a safe loudness ceiling. |
| APEKS | `apeks` | Loudness maximizer — pushes level up while keeping the peak tip alive. |
| ŠÍRKA | `sirka` | Per-band stereo width — mono-tight lows, wide airy tops. |
| PRÚD | `prud` | Dynamic EQ — tames a resonance only while it actually rings. |
| KOREŇ | `bassHarmonic` | Bass harmonic processor — tracks incoming pitch and adds missing harmonics. |
| SKRUTKA | `skrutka` | Phase dispersion — warps arrival time around the focus for throw and depth. |
| Tape Sat | `tapeSat` | Warm tape drive — glues the track and softens harsh tops. |
| Vinyl Suite | `vinyl` | Age and dust — crackle, wow/flutter and 1950s tone in one control. |
| Distortion | `distortion` | Hard drive — grit and aggression from edge to full shred. |
| Saturation | `saturation` | Analog-style push — louder, denser, pleasantly rougher. |
| Bitcrusher | `bitcrusher` | Digital decay — quantize and crush into lo-fi artifacts. |
| Clipper | `clipper` | Brick-wall shave — tames peaks and adds forward punch. |
| Drum Buss | `drumBuss` | One strip for the whole drum bus — drive, glue and sub boom. |
| Bass Buss | `bassBuss` | Bass bus glue — drive, sub enhance and controlled low end. |
| Shimmer | `shimmer` | Octave-up glow — turns a sound into a pad behind itself. |
| Vocoder | `vocoder` | Robot voice — imposes one sound's syllables onto another. |
| PRISM | `fxeq` | Flagship EQ, see section 1. |

### Dynamics (7)

| Current name | Type key | What it is |
| --- | --- | --- |
| Compressor | `compressor` | Levels out jumps — denser, steadier, more professional. |
| Limiter | `limiter` | Safety ceiling — louder without clipping on the way out. |
| Gate | `gate` | Silence below threshold — cleans bleed and tightens tails. |
| Transient Shaper | `transient` | Shapes each hit — more snap or more body. |
| Sidechain | `sidechain` | One sound ducks another — the classic kick-vs-bass move. |
| VLYX | `ultina` | Flagship Mix Assist, see section 1. |
| MORPH | `morphdynamics` | Flagship morphing dynamics, see section 1. |

*(ZENIT and APEKS are registered as `dynamics` in `EFFECT_DEFS` but read as mastering /
character devices in the rack — see the note in section 5.)*

### Movement (16)

| Current name | Type key | What it is |
| --- | --- | --- |
| Beat Mangler | `beatMangler` | Chops the beat live — stutters, reverses, pitch jumps. |
| Tremolo | `tremolo` | Volume wobble — pulsing amplitude at a set rate. |
| Autowah | `autowah` | Opens a filter by how hard you hit — funky talking sweeps. |
| Phaser | `phaser` | Jet-plane swoosh — moving comb filtering through the sound. |
| Flanger | `flanger` | Metallic whoosh — a detuned twin chasing the original. |
| Chorus | `chorus` | Widens and doubles — one sound becomes a small ensemble. |
| Pump | `pump` | Sidechain-style breathing — ducks on every beat, no routing needed. |
| Step Gate | `stepGate` | Chops volume in steps — rhythmic gating locked to the grid. |
| Stutter | `stutter` | Repeats a slice — instant build-up stutters. |
| Tape Stop | `tapeStop` | Tape-stop slowdown — the classic turntable wind-down. |
| Reverse Swell | `reverseSwell` | Reverse riser — a swell that launches into the next hit. |
| Ring Mod | `ringMod` | Metallic robot ring — inharmonic clang, sci-fi edges. |
| Freq Shift | `freqShifter` | Shifts the spectrum sideways — alien, detuned-from-physics character. |
| Comb | `comb` | Hollow resonant buzz — metallic comb-filter tone colouring. |
| Vowel | `vowel` | Talks through formants — wah-like vowels without a filter sweep. |
| ŠÍRKA | `sirka` | Per-band stereo width, see section 2 (Character). |

*(ŠÍRKA is registered under `movement` in `EFFECT_DEFS`.)*

### Space (7)

| Current name | Type key | What it is |
| --- | --- | --- |
| Reverb | `reverb` | Places the sound in a room — tight booth to endless hall. |
| Delay | `delay` | Echoes the phrase — slapback to endless dub tails. |
| Duck Delay | `duckDelay` | Delay that ducks under the hit — echoes only in the gaps. |
| Multi-Tap | `multiTapDelay` | Several echoes at once — rhythmic delay patterns. |
| Granular Freeze | `granularFreeze` | Freezes audio into a pad — infinite sustain from one moment. |
| RYFT | `kaskada` | Flagship reverse/freeze/spectral device, see section 1. |
| VØID | `ozvena` | Flagship per-frequency decay reverb, see section 1. |

### Tone (4)

| Current name | Type key | What it is |
| --- | --- | --- |
| EQ | `eq` | 4-band paint — boost highs, cut mud, shape the whole tone. |
| SV Filter | `svFilter` | Resonant sweep — the filter that makes builds build. |
| M/S EQ | `msEq` | Mid/side EQ — tune the center and the edges separately. |
| Multiband | `multiband` | 3-band split — tone control per low, mid and high. |
| Utility | `utility` | Gain, pan and width — the honest plumbing of a channel. |

---

## 3. Instruments (24)

Names are the user-facing `name` from `INSTRUMENT_DEFS`.

| Current name | Kind key | What it is |
| --- | --- | --- |
| **KOPA** | `kopa` | Kick designer — pitch curve, click layer, body, drive, tone. |
| **TSAR** | `tsar` | Hybrid sample + synthesis engine: two sources, morph, mod matrix, Forge. |
| Sampler | `sampler` | Plays uploaded audio with root, start, attack and round-robin layers. |
| Analog Synth | `analog` | Dual-oscillator subtractive synth — the general-purpose poly voice. |
| Bass Synth | `bass` | Mono bass voice with sub, filter and glide. |
| 808 Synth | `808` | 808-style bass — pitch drop, long decay, tuned for sub-heavy beats. |
| Texture Synth | `texture` | Noise/abstract color, motion and space voice for beds and textures. |
| Wavetable Synth | `wavetable` | Single-oscillator morphing wavetable voice with morph + filter. |
| Granular Synth | `granular` | Position/grain/rate granular engine for pads and frozen textures. |
| FM | `fm` | Two-operator FM — ratio and index for bells, e-pianos and metals. |
| Keys | `keys` | Electric piano — tine, bell, body blend. |
| Organ | `organ` | Additive drawbar organ with 16' sub, key click and rotary Leslie. |
| Strings | `strings` | Ensemble strings — detune spread and vibrato. |
| Bell | `bell` | Inharmonic FM bell with long decay and shimmer. |
| Reese | `reese` | Detuned bass reese with movement for growls and basslines. |
| Clavinet | `clav` | Clavinet pluck — pick, pickup type, tangent thunk. |
| Acid 303 | `acid` | Acid line — accent, glide, resonant filter. |
| Synth Brass | `brass` | Brass stab with bite and a fast filter sweep. |
| Pluck Synth | `pluck` | Karplus-Strong-style plucked string with pick, damp and body. |
| Flute | `flute` | Breathy flute with breath noise, vibrato and formant shaping. |
| Log Drum | `logdrum` | Wooden log drum — decay and pitch drop, percussive melodic tone. |
| Spectral Pad | `spectral` | Additive spectral pad — profile, partials and spacing. |
| Vocal Chop | `vocalchop` | Sample-rooted vocal chop with vowel selection. |
| Drum Synth | `drumsynth` | 13-type drum voice (kick, snare, hats, toms, clap, zap…). |

---

## 4. Naming observations for the rename pass

These are facts about the current state, not opinions about what it should be.

1. **RYFT vs Kaskáda.** `EFFECT_DEFS` registers `kaskada` as **RYFT**, but
   `src/effects/blurbs.ts` still describes it as "Flagship Kaskáda", and the
   `kaskada` type key plus the worklet files are still named `kaskada`. The
   internal key, the worklet filename and the user-facing name have diverged.
2. **Category drift.** `zenit` and `apeks` are registered under `dynamics`, while
   `sirka` is registered under `movement` although it reads as a width/character
   device. If the rename pass also reorganises the rack, these are the three that
   will move.
3. **Two naming systems are already in place.** Most effects use descriptive
   English ("Transient Shaper", "Reverse Swell"), while ten use short invented
   brand-like names (ZENIT, APEKS, ŠÍRKA, PRÚD, KOREŇ, SKRUTKA, PRISM, VLYX, VØID,
   RYFT) — several of them Czech/Slovak words. The flagships sit in the second
   group by design.
4. **Umbrella names hide bundles.** ZENIT is a whole mastering strip, Vinyl Suite
   covers crackle + wobble + tone, KOREŇ is a full pitch-tracking bass engine. These
   are not one knob each — the name has to carry more than a category word.
5. **KOPA and TSAR are instruments, not effects**, but they are the two most
   product-like names in the codebase and are the natural template for renaming.
6. **Instrument names are mostly descriptive** ("Pluck Synth", "Log Drum"), with
   KOPA and TSAR as the exceptions.

---

## 4b. Naming system proposal — "one product"

The goal: the whole catalog should read as one product, and every name should be
understandable — a user should be able to guess roughly what a device does before
opening it.

### The rule that already works

The codebase already has a good naming rule; it is just never written down, which is
why the catalog feels inconsistent.

> **Single-function devices get a descriptive name.
> Multi-function engines get a short ownable name.**

KOPA is not randomly exotic — it is the kick designer, an instrument with 40+
parameters that does pitch curve, click layer, body, drive and tone in one. It needs a
name, not a description. The same is true of TSAR. PRISM and MORPH are named after
exactly what they do (a prism splits white light into a spectrum = splits a mix into
bands; morph = the thing that morphs). **Those names are not the problem.**

### The actual problem

The exceptions are single-function devices wearing a product name. If a user does not
speak Czech, these names tell them nothing:

| Current | Type | What it actually does | Problem |
| --- | --- | --- | --- |
| VØID | `ozvena` | Reverb with per-band decay | "ozvena" **is** the Czech word for echo. The original name explained itself; VØID hides it. |
| ŠÍRKA | `sirka` | Stereo width per band | Opaque outside Czech. Same job as Haas Widener. |
| PRÚD | `prud` | Dynamic EQ | Opaque outside Czech. |
| SKRUTKA | `skrutka` | Phase dispersion | Opaque outside Czech. |
| KOREŇ | `bassHarmonic` | Adds missing harmonics to bass | Borderline — the engine is complex enough to deserve a name. |
| RYFT | `kaskada` | Reverse / freeze / spectral ducking | Non-Slavic word in a Slavic set, and the key still says `kaskada`. |
| APEKS | `apeks` | Loudness maximizer | Opaque; sounds like a brand, not a function. |

Seven devices, one problem: **the name says nothing, so the one-liner in the tooltip
becomes the only explanation.** That is the opposite of "understandable without
opening it".

### Two coherent directions

**Direction A — keep the Slavic layer, make it legible.**
KOPA, TSAR, KOREŇ and ŠÍRKA are genuinely distinctive; they are the identity of the
product and they do not sound like Ableton. Keep them, but require every one to carry
a hint of function, and accept that the catalog is Czech/Slovak-flavoured.

**Direction B — descriptive everywhere, one language.**
Every effect named for what it does, in English, in the style of a hardware plugin
list. Maximum clarity, zero distinctiveness. KOPA becomes "Kick Designer", PRISM becomes
"Dynamic EQ". The product becomes competent and forgettable.

**Recommendation: a hybrid with an explicit line.** Direction A for the seven devices
that are genuinely engines, Direction B for everything else — which is already the case
for ~47 of 54 effects. The catalog only *feels* inconsistent because seven devices
break the pattern and nobody wrote the pattern down.

### What a name must pass

For any rename, three tests:

1. **Does it predict the function?** Someone who has not opened it should guess
   roughly what it does. (PRISM passes, APEKS fails.)
2. **Is it pronounceable and typeable for the whole team?** Slovak and international
   users both have to be able to say it.
3. **Does it match the type key?** `kaskada` displaying as RYFT means the codebase
   disagrees with itself.

### Suggested replacements (discussion, not applied)

Czech/Slavak layer, keeping the flavour but making each name self-explanatory:

| Current | Proposal | Why |
| --- | --- | --- |
| VØID | **OZVĚNA** / **KOZUB** | "Ozvěna" = echo, literally describes it. "Kozub" (chimney) fits reverb-as-space. |
| ŠÍRKA | **ŠÍRKA** (keep, add hint) | Correct and real; just needs the tooltip to arrive first. |
| PRÚD | **PRÚD** (keep, add hint) | "Current" fits dynamic EQ taming resonances. |
| SKRUTKA | **SKRUTKA** (keep) | "Screw/twist" genuinely fits phase dispersion. |
| APEKS | **VRCHOL** (peak) or rename to **MASTERS** | "Vrchol" is the Slovak word for apex and is self-explanatory. |
| RYFT | **KASKÁDA** (revert) | Fixes test 3 — the key is already `kaskada`, and cascade describes the falling sweep. |

### One thing to settle before renaming

Which direction the product wants is a brand decision, not a technical one, and it
changes most of the list. Worth deciding explicitly: **is KYX a Czech/Slovak-named
product with English explanations, or an English-named product?** Everything else
follows from that.

---

## 5. Where the names live (for the rename)

| Surface | File |
| --- | --- |
| Effect display names | `src/effects/registry.ts` — `EffectDefinition.name` per entry |
| Effect type keys | `src/project-model/types.ts` — `EffectType` union |
| Effect one-liners | `src/effects/blurbs.ts` — `EFFECT_BLURBS` |
| Instrument display names | `src/instruments/registry.ts` and `src/instruments/definitions.ts` (`INSTRUMENT_META`) |
| Track dropdown labels | `src/ui/TrackTabs.tsx` (hardcoded `<option>` list) |
| Panel titles | `src/ui/DockChrome.tsx`, `src/ui/*Panel.tsx` |
| Counts to keep in sync | `docs/CURRENT-STATE.md` |

Renaming display names is a presentation change. Renaming a **type key** is a schema
change and requires bumping `SCHEMA_VERSION` plus a migration in `migrateProject`,
per AGENTS.md §3.6 and §7.