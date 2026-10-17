# KYX Sound Library — Inventory & Gap Map

**Snapshot:** 2026-10-17  
**Purpose:** Record what KYX already has, what is technically working, and which additions would most improve its sound and identity.

## Executive view

KYX already has broad coverage: **155 factory sound slots across 15 categories**, **24 playable instrument types**, **643 factory presets**, **57 registered effects**, **258 groove entries**, and **21 first-class genres**. The curated factory set is technically consistent: the current acoustic audit passed **142/142 WAVs**. The biggest opportunity is therefore not to keep expanding category counts. It is to give the library a recognizable source and performance character.

The factory WAVs are KYX-rendered seeds, not a recorded KYX session library. All 142 are dual-mono: centered and mono-safe, with no genuinely wide source textures. There is no first-party audio-break or phrase-loop collection. The optional Piano and VSCO multisample banks add conventional instrument breadth, but do not provide a shared KYX sonic identity.

## What ships today

### Factory sample bank

There are 155 manifest entries. **142 have curated WAV overrides**; 13 remain procedural voices: `Snare Ghost`, `Ride Ding`, both Brushes, and the nine Field sounds. The lists below are the current manifest names.

| Category | Count | Sounds |
|---|---:|---|
| Kick | 16 | Deep, Punch, Techno, Sub 808, Trap, Soft, 808 Drive, 808 Pure, Drill, Phonk, Jersey, DnB, Lo-Fi, Knock, 909, Pop |
| Snare | 11 | Main, Tight, Punch, Trap, Drill, Phonk, Jersey, DnB, Lo-Fi, Room, Ghost Note |
| Clap | 5 | Main, Soft, DnB, Traditional, Pop |
| Hat | 11 | Closed, Closed Soft, Open, Open Short, Pedal, Drill, Phonk, Jersey, DnB, Open Cup, Wash |
| Cymbal | 5 | Ride Ping, Ride Bell, Splash, Jazz Ride Wash, Ride Ding |
| Crash | 7 | China Cymbal, Crash Roll, Crash, Dark, Short, Trash, Pop |
| Brush | 2 | Tip, Swirl |
| Percussion | 22 | Shaker Fast, Shaker Soft, Tick, Blip, Cowbell, Cowbell Dark, Cowbell Scream, Cowbell Drill, Cowbell Bright, Conga, Tambourine, Conga High, Bongos, Timbale, Tabla, Cajón, Agogô, Woodblock, Clave, Snap Stack, Shaker Long, Shaker Pop |
| Tom | 5 | Low, Mid, High, Perc, Floor |
| Rim | 4 | Chip, Hard, Snap, Pop |
| Bass | 14 | Clean Sub, Reese, FM, Pluck, Wobble, Dist, 808 Soft, 808 Medium, 808 Hard, Sub Sine, Sub Square, Upright Jazz Bass, Acid Fast, Acid Slow |
| Tonal | 28 | Pluck C4, Stab C4, Keys C4, Bell C5, Memphis Guitar, Dark Strings, Rhodes Tine, Mariachi Trumpet, Anime Pluck, Sad Piano, Warm Pad, Harp Tone, Vibraphone, Marimba, Celesta, Wurli Bark, Tonewheel Organ, Acoustic Guitar, Choir Pad, Cello, Violin, Pizzicato, Nylon Guitar, Orchestra Hit, Sitar, Erhu, Kalimba, Music Box |
| Lead | 5 | Saw, Supersaw, Square, Pluck Bright, Pluck Dark |
| FX | 11 | Riser, Downlifter, Impact, Sweep, Reverse Rise, White Noise, Sub Drop, Vinyl Crackle, Cinematic Impact, Short Riser, Noise Down |
| Field | 9 | Room Tone, Fridge Hum, Mains Buzz, Distant Street, Gravel Steps, Paper Turn, Cloth Rustle, Switch Click, Match Strike |

### Instruments, presets, effects, and patterns

- **24 instruments:** Sampler, Analog Synth, Bass Synth, 808 Synth, Texture Synth, Wavetable, Granular, Keys, Organ, Strings, Bell, Reese, Clavinet, Acid 303, Synth Brass, FM, Pluck, Flute, Log Drum, Spectral Pad, Vocal Chop, Drum Synth, TSAR, and KOPA.
- The dedicated **808 Synth already supports glide**; the sample library also has soft/medium/hard 808 velocity zones. A new 808 instrument is not the priority.
- **643 factory presets** provide breadth across those instruments and devices. The productive next move is a smaller, voiced KYX signature set with performance macros and clear sound roles.
- **57 registered effects**, including six flagship suites, cover substantial processing. That gives KYX the tools to transform material; the missing piece is distinctive source material and a coherent way to use it.
- **258 grooves, 21 genres, and 12 genre kits** provide pattern and kit coverage. Groove entries are note patterns, not recorded audio breaks or phrase loops.
- Separate optional packs contain **120 Piano WAVs** and **2,485 VSCO WAVs**. The public sample tree has 2,747 WAV files in total: 142 factory, 120 Piano, and 2,485 VSCO.

## Technical and musical assessment

### Already strong

- Kicks, snares, claps, hats, basses, tonal one-shots, leads, and FX have useful functional coverage. There are already 16 kick types and 14 bass types, with clean, driven, sub, Reese, FM, wobble, and acid directions.
- The D1 808 velocity-zone set and the 808 Synth glide control cover the basic modern 808 workflow. Current 808s should be judged for distinct timbre and musical range, rather than replaced by more generic 808 names.
- The 142 curated WAVs are consistently **44.1 kHz / 24-bit PCM**, with no clipping or exact duplicate assets. Category loudness drift is at most 1.9 dB in the audit; no category exceeds its current gate.
- The only leading-silence flags are intentional FX ramps (`Reverse Rise`, `Short Riser`, `Riser`, `Sweep`) and the `Choir Pad` swell. Their starts should stay intact.
- The procedural Field and Brush voices give the library useful starting points for atmosphere and tactile rhythm, and can serve as fallbacks.

### Gaps with audible impact

1. **Own source material.** Factory samples are synthesized seeds. There is no small first-party set of close, room, and environmental recordings that could give several categories a shared identity.
2. **Human performance.** The catalogue has instrument labels such as tabla, conga, clap, and brush, but no first-party session of real takes with natural articulation and alternate performances. More names will not add that feel.
3. **Phrase-scale material.** There are no factory audio breaks or short performance loops. This matters for chopped-break, speed-garage, and percussion-led workflows; the existing 258 groove entries remain useful MIDI-style patterns.
4. **Spatial source character.** Every factory WAV is dual-mono. The library is stable in mono, but lacks original room, stereo air, and evolving width baked into a source.
5. **A recognizable family relationship.** Existing sounds work as individual choices, but the library does not yet carry one source fingerprint through kick, bass, synth, texture, and transition FX.
6. **A few close neighbours need an ear review.** The nearest-neighbour audit flagged `kick.knock` / `kick.lofi` (0.066), `hat.closed.soft` / `hat.closed` (0.091), `snare.drill` / `snare.main` (0.110), and `clap.soft` / `clap.trad` (0.141). These may be intentional adjacent colours; audition them in beats before changing or removing anything.

## Modern sound direction

Recent Splice platform data points toward genre blending and more specific, personal sounds. Its 2026 report names strong growth for Afro House, speed garage, and bedroom pop, and highlights global influence and organic textures; its genre guide describes botanica as acoustic timbres transformed with spectral processing and glitches. These are **platform signals**, not a universal ranking of what every producer needs. My product recommendation from them is to build a flexible organic/electronic transformation path, rather than a separate shallow pack for each trend. [Splice Core Trends 2026](https://splice.com/trends) · [Splice: fastest-growing sounds](https://splice.com/blog/fastest-growing-sounds-on-splice/)

## Recommended additions, in order

### 1. KYX Sound Seed — the flagship identity feature

Let a producer record or drop one sound, then derive a small related family: **transient, bass/body, tonal voice, texture, and transition FX**. Keep the original available, make every derived version reproducible from the project seed, and allow each layer to be auditioned or discarded. This makes a user’s own source the beginning of a KYX sound world. The name avoids confusion with the existing **Producer DNA**, which learns production preferences rather than transforming source audio.

### 2. A compact KYX Originals recording session

Record roughly **12–18 carefully chosen sources**, not a large generic pack: a few distinctive kick and hand-clap takes, soft and hard hats/shakers, several wood/metal/foley hits, a close and room capture, and one or two breath/voice textures with appropriate consent. Capture alternate performances for the sounds that need them. Those recordings can seed the feature above and give the existing sample categories more character.

### 3. Signature low-end and kick designs

Build a small, demonstrable set around the existing tools: three or four 808 personalities (pure sub, expressive glide, vowel/formant growl, controlled harmonic drive) and four kick architectures (deep body, short punch, metallic/industrial, extravagant layered hit). Keep sub energy centered and predictable; let upper harmonics and transient layers provide the spectacle. This fills a timbral gap while reusing the existing 808 Synth and drum system.

### 4. Afterimage — atmosphere that follows the beat

Create an optional, deterministic atmosphere layer that responds to note, groove, and arrangement energy: small harmonic echoes, transformed source tails, and texture that blooms at section changes and recedes under dense passages. Make it easy to A/B, automate, render offline identically, and keep out of the way of the kick and bass.

### 5. A few real performance loops

After the source identity is established, add a short, high-quality set rather than a broad loop library: a couple of broken-beat/jungle phrases, a speed-garage two-step, and a percussion-led Afro House / log-drum phrase. Include dry and transformed versions where the transformation teaches a useful KYX workflow.

## Decision

Keep the technically clean core and the existing 808/kick foundations. The highest-value investment is **source identity + human recordings + an arrangement-aware atmosphere layer**. Refine any near-neighbour samples by ear, and add only the few kick, bass, synth, and loop designs that prove a distinct role in a real beat.

