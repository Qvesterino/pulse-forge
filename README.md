# KYX

**A browser-native, fully offline-capable beat, vocal-recording, and scene-score workstation.**

KYX (internally known as **Pulse Forge**, the repository name) is a production-oriented digital audio workstation that runs entirely in the browser. It is built around six product pillars — **Sound, Rhythm, Composition, Processing, Arrangement, and Export** — and is designed to deliver a finished track without ever leaving the tab.

It is intentionally **not** a clone of a traditional DAW: there is no VST/AU hosting, no ASIO driver management, and no simultaneous multi-input studio recording. It does support single-input vocal takes directly on an arrangement track. In exchange, KYX ships a closed, carefully designed production environment containing 15 native instruments, 47 native effects (including 5 flagship DSP suites), a 16/32-step sequencer plus piano roll, an arrangement view, scene-based launching, real-time collaboration, a deterministic offline renderer, and export to WAV, MP3, vertical video and a packaged score.

The web build also ships as a standalone Windows desktop app (ADR 0010/0011) — the same code, served from a thin Electron shell — with auto-update through GitHub Releases.

---

## Table of contents

1. [What KYX is designed for](#1-what-kyx-is-designed-for)
2. [Key features](#2-key-features)
3. [The user workflow](#3-the-user-workflow)
4. [Screens and functional areas](#4-screens-and-functional-areas)
5. [Architecture at a glance](#5-architecture-at-a-glance)
6. [Tech stack](#6-tech-stack)
7. [Repository structure](#7-repository-structure)
8. [Installation](#8-installation)
9. [Development setup](#9-development-setup)
10. [Running the application](#10-running-the-application)
11. [Build, test, lint and release commands](#11-build-test-lint-and-release-commands)
12. [Architectural principles and constraints](#12-architectural-principles-and-constraints)
13. [Current project status](#13-current-project-status)
14. [Known limitations and experimental areas](#14-known-limitations-and-experimental-areas)
15. [Roadmap signal](#15-roadmap-signal)
16. [Contributing and development notes](#16-contributing-and-development-notes)

---

## 1. What KYX is designed for

KYX is built for a single core idea —

> A producer should be able to open the app with nothing, build a complete beat using only the built-in instruments, samples and effects, export it, and feel no immediate need to leave the application.

Practically, that covers:

- **Beat production** — house, techno, trap, ambient, UK garage, Jersey club, phonk, drill, lo-fi house, reggaeton (12 genre starter templates included).
- **Electronic music composition** — instruments, melodic and pad roles, piano-roll editing, scene-based launching, deterministic groove, generative dice/AI assist.
- **Sound design** — wavetable, granular, FM, Karplus-Strong, additive spectral, sampler with time-stretch and reverse.
- **Arrangement** — pattern mode vs. song mode, named scenes, per-scene tempo, scene intensity curve, scene automation, markers.
- **Vocal recording** — record a microphone take onto one armed arrangement track at a time; capture is uncompressed Float32 PCM, staged in IndexedDB, and recoverable after a reload when blocks were committed.
- **Mixing** — multi-track mixer, send/return buses, master chain (input → soft-clipper → look-ahead limiter → analyser), per-track peak meters, LUFS history, mix-check warnings.
- **Export** — WAV (16/24/32-bit float), MP3, vertical MP4/WebM for Reels/Shorts/TikTok, per-track stems, grouped Drums/Bass/Music stems, share codes, embed player, **scorepacks** (`.scorepack` ZIPs with master + stems + cue WAVs + manifest).
- **Visual / interactive scene composition** — scene intensity can drive any effect or instrument parameter through the same mapping lane as macros; the same project file powers both music and a synchronized visual layer.

It explicitly avoids: simultaneous multi-input studio recording, VST/AU plugin hosting, ASIO/device-driver management, advanced external warping, spectral restoration, large-scale mixing workflows, external plugin ecosystems.

---

## 2. Key features

### Sequencer and composition

- **16/32-step drum sequencer** with per-step velocity, probability, ratchets (1–8× retriggers with velocity decay), microtiming and inline right-click editor (`tests/step-grid-editor`).
- **Piano roll** per instrument track — click to add, drag to move, right-edge drag to resize, right-click or `Delete` to remove, audible keyboard column, scale lock helpers.
- **Pattern system** — create, duplicate (`Ctrl+D`), inline rename, 16/32-step length switching with content preservation, copy/paste, clear, scene-launchable.
- **Scenes** — named launches referencing patterns; live switching or quantized-to-next-bar launching.
- **Arrangement + song mode** — linear timeline of clips (scene + start bar + length), click/drag to place and resize, overlap-safe with undo. PATTERN/SONG toggle in the transport.
- **Quantized scene launches** — scene chips switch instantly while stopped, queue to the next bar while playing; in song mode a scene chip jumps the playhead to the scene's first clip.
- **Loop region** — `L` toggles the loop; IN/OUT drag numbers in the top bar; scheduler wraps inside the region in both play modes.

### Groove and feel

- **Project-level swing** (0–100 %) — odd 16ths toward triplet feel.
- **Humanize** — seeded timing and velocity variation.
- **Per-step probability** — deterministic seeded rolls.
- **Ratchets** — 1–8× retriggers with velocity decay.
- **Microtiming** — ± early/late per step.
- **MUT / FILL** — mutate the active pattern into a seeded variation; FILL duplicates it with a rising snare roll + ratcheted final hit. Both are single undo steps.
- **Multi-select steps** — shift+drag rectangle, `Delete` clears, vertical drag scales velocity for the whole selection.
- One shared deterministic groove module feeds both the realtime scheduler and the offline renderer — exports groove exactly like playback.

### 14 melodic instruments (`src/instruments/registry.ts`)

| # | Instrument | Engine highlights |
|---|---|---|
| 1 | **Sampler** | root-note transposition, ADSR, per-voice LP/BP/HP filter, key tracking, velocity layers, round-robin kits, keyzones, pitch / stretch / loop modes, L-XFADE, reverse, spread |
| 2 | **Analog Synth** | 2 oscillators + sub + noise → SVF lowpass with envelope, ADSR amp; cutoff/resonance live on sounding voices |
| 3 | **Bass Synth** | SUB / BODY / PUNCH / GRIT / MOVEMENT / WIDTH macros → saw/square/sub voice with drive, filter envelope, LFO movement, stereo width |
| 4 | **808 Synth** | sine body with pitch-drop envelope, decay, transient click, drive, tone; monophonic with retrigger-clean slides |
| 5 | **Texture Synth** | pad/drone with shared LFOs, filtered noise, tremolo, feedback delay space, tempo-synced delay |
| 6 | **Wavetable Synth** | two crossfaded single-cycle frame loopers per oscillator + detuned unison + sub; 5 factory tables (Sine Grow, PWM, Formant, Digital, FM Drive); drop any sample to extract a table; morph and per-voice scan engine |
| 7 | **Granular Synth** | deterministic grain cloud scheduled upfront per note; POSITION/GRAIN/RATE/JITTER/SPREAD/REVERSE/PITCH/P-RAND; canvas waveform preview |
| 8 | **Keys** | 4-op FM electric piano, two parallel FM pairs, tremolo, scale-aware unison |
| 9 | **FM Synth** | 2-operator DX-style FM with self-feedback, mod and feedback envelopes, M-WAVE (SIN/TRI/SQR), live retuning of in-flight voices |
| 10 | **Pluck Synth** | Karplus-Strong physical model, excite by noise burst |
| 11 | **Log Drum** | 3 inharmonic sine partials (1 / ~2.15 / ~3.8) with partial-specific pitch-drop dispersion; "log drum" amapiano character |
| 12 | **Spectral Pad** | additive pad up to 8 sine partials with per-partial amplitude, decay and stereo placement; profiles (Harmonic, Bright, Odd, Formant, Bell) |
| 13 | **Vocal Chop** | parallel three-band formant bank (A/E/I/O/U Peterson-Barney formants), consonant transient, vibrato, glide, MORPH through vowel table |
| 14 | **Drum Synth** | 13 analytically-modelled drum voices (Kick / Snare / Hat C / Hat O / Clap / Perc / …) played chromatically from the piano roll, with choke on the hats |

Plus a **drum rack** with 16 pads per drum track (gain/pan/pitch/mute/solo/choke groups) and a separate **7-voice synth drum kit** that the rack's pads map onto. All instruments support mod matrix routes (MOD A / B with ENV/LFO/VEL/PRESS → CUTOFF/AMP/MORPH), MPE poly aftertouch and per-note timbre (CC74), and live parameter changes that propagate to sounding voices.

### 47 effects — 42 native/core + 5 flagship (`src/effects/registry.ts`)

**Flagship plugin suites** (AudioWorklet DSP with dedicated regression/golden coverage):

| Type | Brand name | Notes |
|---|---|---|
| `fxeq` | **PRISM** | spectral EQ, 2–6 bands, Linkwitz-Riley 2/4/8 crossover, phase alignment, in-rack limiter |
| `ultina` | **VLYX** | intelligent mixing suite (comp / transient / exciter / unmask stages) |
| `ozvena` | **VØID** | spatial convolution reverb with three engines, blend-pad routing, true-stereo factory IRs, precomputed FFT spectra |
| `kaskada` | **Kaskáda Delay** | tempo-synced multi-tap delay |
| `morphdynamics` | **MORPH** | macro-driven dynamics, character, motion and space processing |

**Native/core mix effects** (native Web Audio / AudioWorklet — 40 of them): EQ, M/S EQ, Multiband, Haas Widener, Compressor, Saturation, Tape Sat, Clipper, Reverb, Delay, Pump, Distortion, Bitcrusher, Chorus, Phaser, Sidechain, Transient Shaper, Gate, Shimmer, Drum Buss, Bass Buss, Utility, Limiter, Step Gate, SV Filter, Flanger, Tremolo, Autowah, Stutter, Comb, Vowel, Duck Delay, Multi-Tap Delay, Ring Mod, Tape Stop, Frequency Shifter, Pitch Shift, Vinyl, Beat Mangler, Vocoder.

Each effect is a shared `EffectDefinition` → `EffectRuntime`; structural chain changes rebuild the runtime, parameter tweaks are diffed and applied smoothly; track deletion disposes nodes and runtimes; BPM changes propagate `syncBpm` to tempo-synced runtimes.

### Mixer and master chain

- **Channel strips per track** — rename, volume, pan, mute, solo, delete, real peak meters (AnalyserNode per track + return + master), per-track send knobs to returns, return strips, master strip.
- **Returns (send/return buses)** — two factory returns (Reverb, Delay) with real insert effect chains.
- **Master chain** — `IN → soft-clipper → look-ahead limiter (worklet) → analyser`. The master strip exposes `IN`, `CEIL`, `LIMIT` and `CLIP`. Both processors are honest, bypassable, and the signal chain is identical between live playback and offline export.
- **Master metering** — stereo L/R peak + RMS bars with peak-hold ticks, correlation block (mono / wide / phase), HEAD headroom strip showing the limiter ceiling, live CLIP warning when over 0 dBFS, plus a 30-second LUFS-M / LUFS-S / LUFS-I history and a "print-ready" verdict against a chosen target (Spotify −14, YouTube −12, club −9, loud −7).
- **Goniometer** and **Spectrum Analyzer** panels.

### Modulation, automation and macros

- **Automation lanes** — project lanes targeting track volume/pan (exact audio-rate ramps), effect params and instrument params (window-resolution). Point editor in the `MOD` panel: click to add, drag to move, right-click to delete; linear interpolation; loops in pattern space.
- **LFOs** — per-track audio-rate modulation of volume or pan: sine/tri/square/saw up/down, free Hz or tempo-synced (1/1–1/16), amount; re-syncs on BPM change.
- **Macros** — four project macros (A–D) with bipolar value (center = neutral) mapping to track volume/pan offsets. **Scene intensity** can also be the source, so a scene's intensity curve drives any parameter.
- **Step modulator** and **envelope follower** modulator sources.
- **Modulation routing** ends with dedicated automation/macro gain+pan stages per track, so mute/solo, manual volume, automation, LFO and macros never fight over the same `AudioParam`.

### Persistence and project management

- **Project browser** on every boot — one-click "Continue last project" card, project list with open / duplicate / inline rename / delete-with-confirm, sorted by last update, freshness readouts (`saved X ago`).
- **12 starter templates** — House (4-on-the-floor + sub bass + chords), Techno (two loop variations), Trap (half-time snare + rolling hats + 808 + sparse lead), Ambient (evolving pads), Scene Score (INTRO/BUILD/DROP/BREAK/OUTRO pre-placed on a 24-bar timeline), UK Garage, Jersey Club, Phonk, Drill, Lo-Fi House, Reggaeton, Empty.
- **Schema-versioned project model** — `schemaVersion: 1`, pure serializable data, JSON round-trip tested, loading auto-normalizes pattern rows.
- **Autosave** — debounced 800 ms with a live status indicator (`SAVED hh:mm` / `UNSAVED` / `SAVING…` / `SAVE ERROR — RETRY`), flush on tab-hide and page close.
- **IndexedDB stores** — projects, user presets, user sample audio, frozen track buffers, kits, library, groove pool, recording-recovery sessions and Float32 PCM chunks. Imported user samples (WAV/MP3/OGG/FLAC/AIFF) keep their encoded bytes in IndexedDB and decode back into the sample bank on boot. Vocal recording uses half-second durable blocks; the selected input device is a browser-local preference, not project data.
- **Command system** — every mutation flows through commands with full undo/redo (`Ctrl+Z` / `Ctrl+Y`). Local undo stack is bounded only by available memory; reload resets it.

### Sounds

- **41 factory assets** (`src/sample-library/manifest.ts`) — kicks, snares, claps, hats, cymbals/crashes, toms, rims, percussion (cowbell/conga/tambourine/shaker/tick/blip), FX transitions (Riser / Downlifter / Impact / Sweep / Reverse Rise / Noise), tonal samples. Each has a procedurally synthesized fallback in `src/sample-library/factory.ts`; the curated layer (`src/sample-library/curated.ts`) overrides them with curated WAVs in `public/samples/` on a best-effort basis (failing or missing curated files leave the synthesized fallback in place). All assets are tagged by category and mood (dark / bright / warm / aggressive / clean / deep / atmosphere).
- **205 factory presets** — 199 instrument presets + 6 drum-synth presets in `src/presets/factory.ts`, tagged by genre (House / Techno / Trap / Ambient / Score / UKG / Jersey / Phonk / Drill / Lo-Fi / Reggaeton) and mood, with curated sound-design intent ("Acid Line", "FM Growl", "Cinematic Strings", "Shimmer").
- **Curated layer** — a higher-quality curated override that renders the same factory ids but with longer, hand-tuned samples; exports wait briefly for the curated sound so "what you hear is what you export", with a synthesized fallback after timeout.
- **Preset browser** with genre + mood chips, ALL / FAVORITES / RECENT scope, search, hearts, "save as user preset".
- **Sample browser** — search, category filter, mood filter, click-to-preview, RECENT section, heart toggle, persisted to IndexedDB.

### Generative and assist

- **Generative tracks (experimental)** — provider-neutral generative accompaniment with KYX note/chord conditioning, a bounded AudioWorklet playback path, capture/freeze into durable AudioClips, and MusicCoCa-style audio resampling. MRT2 Small connects only through an explicitly selected localhost companion in the browser. The Electron IPC/provider adapter and macOS arm64 helper source/build path are implemented; the native executable still needs a real Apple Silicon build/model smoke before release. Native v1 advertises text style, notes and drumless mode; audio-style, seed and product macros are explicitly unsupported. Windows has a separate optional companion with honest capability tiers: capture is supported first when the JAX runtime and model assets are installed, while near-realtime/realtime require the measured benchmark gate. The browser bundle never contains the Windows runtime or model weights.
- **Dice / seed-locked generation** — `MUT`, `FILL`, full/vary rolls, seed chain (cap 100), per-row locks (kick / snare / hats / kit / bass / chords / lead), favorites, kit dice.
- **AI Bandmate** (collab-only) — when a remote jam session is running, an autonomous drum player takes unassigned roles and writes a fresh 16-step groove into its own track through the same command path humans use; the CRDT broadcasts it to every peer.
- **Intent engine** — text → beat (e.g. `"dark rolling techno at 140 with lead"`), with EN keyword parsing, sliders, seed, length, candidate count. Sync path for instant preview, async path with a 54-feature ONNX MLP ranker (`intent-ranker-v1.onnx`, ~25 KB) that ranks candidates against the heuristic. Lazy-loaded in a Web Worker, bounded by timeout + circuit breaker + fallback heuristic (`src/intent/providers/local.ts`).
- **Symbolic drum prior** — a 44-feature ONNX prior MLP (`symbolic-prior-v1.onnx`, ~20 KB, val AUC 0.916) that adds a second candidate source merged into the same shared candidate bank (`src/intent/providers/symbolic.ts`).
- **Melodic prior** — a similar MLP for melodic phrases (`symbolic-melodic-v1.onnx`).
- **Mix assist / reference match** — analyzes the rendered track in a worker (transferable channel buffers) and proposes mix settings; recoverable error and CANCEL when workers are unavailable.
- **Slice Lab** — drop an MP3/WAV, transient detection chops it onto 16 MPC-style pads; retrigger, pitch, program.
- **Freesound** — optional one-click CC0 import from freesound.org.

### Collaboration and sharing

- **Real-time collab** — share a six-character room code; everyone edits the same project in real time over `yjs` + `y-websocket`. Each peer's undo stack stays local (remote edits never enter local undo). `?server=` overrides are restricted to the app's own host; self-hosted relays on other hosts can be entered in the UI.
- **Share codes** — a whole project compressed into a URL-safe token (lz-string). The share link IS the project; no backend required. Decompression-bomb caps protect boot from crafted URLs.
- **Embed player** — `/embed/#p=<share-code>` is a self-contained beat player that decodes the share code, renders it deterministically with the exact offline engine, and offers an "Open in KYX" CTA that drops the same project into the full studio.
- **Beat Gallery** — `/gallery` is a community feed served by the collab server's JSON store; every beat plays through the embed player and opens in the full studio for remix. Publish, fork, play counts, report.
- **AI Bandmate** plays unassigned roles during jam sessions; jam roles are explicit (Drums / Bass / Music / Lead).

### MIDI

- **Web MIDI input** — note on/off, CC, aftertouch; routes into the live scheduler and the piano-roll recorder.
- **Web MIDI output** — sends note on/off and CC to external gear.
- **MIDI clock** — master output and slave sync with a few milliseconds of jitter (the internal audio path is sample-accurate, MIDI clock cannot be).
- **MIDI learn**, **MIDI file import/export**, **pattern recording** (record arm + overdub/replace), **MPE** poly aftertouch and per-note timbre (CC74).
- **Pattern recorder** captures live performance into the piano roll; a passive capture ring offers "Capture last take" (Ableton-style) after pause/stop.

### Performance and recording

- **Note Repeat** — hold a pad (mouse, QWERTY key or MIDI note) and the pad re-fires on a grid division (1/4–1/16T) with per-repeat velocity falloff. While the transport plays, repeats lock to the transport tick grid; while stopped they free-run.
- **Ghost preview** — audition a pattern in isolation without touching the transport.
- **Arrangement vocal recorder** — records the selected microphone as planar Float32 PCM in bounded AudioWorklet blocks. Each block is acknowledged only after its IndexedDB transaction commits; interrupted takes can be restored to the timeline or sample library. Audio not yet committed when the browser/device fails may be incomplete.
- **Live resampler** — records the master post-limiter or a track's post-FX tap through `MediaRecorder`; the resulting take is decoded to an `AudioBuffer` for use as a sample. Microphone capture uses the PCM recorder above, not this encoded resampling path.
- **Latency calibration wizard** — measures audio round-trip and jitter, persists to localStorage; informs downstream scheduling.

### Diagnostics

- **Diagnostics panel** (`DIAG` toggle in the top bar) — context state, sample rate, voice count, scheduled events, scheduler state, track/pattern counts, save status, worklet readiness, missed assets.
- **Command palette** (`⌘K`) — keyboard-driven access to actions.
- **Help overlay** with the full shortcut reference.

---

## 3. The user workflow

The end-to-end workflow recommended by the design (`FEATURES.md §3`):

```text
CREATE PROJECT
    ↓
CHOOSE SOUNDS
    ↓
BUILD RHYTHM
    ↓
ADD BASS / MUSIC
    ↓
SHAPE SOUND
    ↓
CREATE VARIATIONS
    ↓
ARRANGE
    ↓
MIX
    ↓
EXPORT
```

Concretely, a first-time user lands on `/` and sees a landing page with a live beat playing through the embed player. They click **Open the studio**, land in the project browser, pick a genre starter template (or empty), and within a minute have a four-on-the-floor groove playing. From there:

1. The **Inspector / Preset Browser** swaps sounds; hearts and RECENT persist across sessions.
2. The **Step Grid Editor** programs rhythm; velocity, probability, ratchets and microtiming live in the same view.
3. The **Piano Roll** adds bass and music notes; the keyboard column auditions them.
4. The **Effect Rack** (FX panel) inserts EQ, compression, reverb, the flagship plugins; parameter changes are smoothed.
5. The **Mixer** balances levels, sends, returns; meters and the master strip's LUFS history guide loudness.
6. The **Arrangement Panel** (ARR) lays clips on a song-mode timeline; scene chips launch patterns; scene automation and scene-intensity curves shape the long form.
7. The **Modulation Panel** (MOD) draws automation, configures LFOs and macros.
8. The **Export Panel** (EXPORT) renders to WAV, MP3 or vertical video, exports per-track or grouped stems, packages a scorepack, or builds a share code that opens in the embed player or `/gallery`.

Every step is undoable (`Ctrl+Z` / `Ctrl+Y`) and persists automatically.

---

## 4. Screens and functional areas

KYX is a single-page app with a top bar, a dockable bottom panel row, and modal overlays. The bottom panel row is split-dockable; the panels are `mixer`, `fx`, `plugin`, `arr`, `mod`, `exp`, `midi`, `dice`, `intent` (defined in `src/ui/dockLayout.ts`).

| Area | Source | Purpose |
|---|---|---|
| **Project Browser** | `src/ui/ProjectBrowser.tsx` | First screen on boot — recent projects, template grid, continue-last card |
| **Landing Page** (`/landing`) | `src/landing/LandingPage.tsx` | First-visit marketing page with a live beat preview; skipped once onboarded |
| **Embed Player** (`/embed`) | `src/embed/EmbedApp.tsx` | Self-contained beat player for share codes |
| **Beat Gallery** (`/gallery`) | `src/gallery/GalleryPage.tsx` | Community feed with publish, fork, remix |
| **Top Bar** | `src/ui/TopBar.tsx` | Transport, BPM, save status, undo/redo, panel toggles, palette, help, diagnostics, history |
| **Sequencer** | `src/ui/Sequencer.tsx`, `StepGridEditor.tsx` | 16/32-step drum grid, per-track rows, beat grouping, playhead |
| **Piano Roll** | `src/ui/PianoRoll.tsx` | Note editing per instrument track; keyboard column; scale lock |
| **Pattern Bar** | `src/ui/PatternBar.tsx`, `SceneLauncher.tsx` | Pattern chips, scene chips, swing/humanize controls |
| **Mixer** | `src/ui/Mixer.tsx` | Channel strips, returns, sends, master, real meters |
| **Effect Rack** | `src/ui/EffectRack.tsx`, `RackStrip.tsx` | Add/remove/reorder/bypass; shared parameter metadata drives the UI |
| **Flagship Plugin Panels** | `src/ui/FxEqPanel.tsx`, `UltinaPanel.tsx`, `OzvenaPanel.tsx`, `KaskadaPanel.tsx` | Vendor-brand editors for PRISM / VLYX / VØID / Kaskáda Delay |
| **Arrangement Panel** | `src/ui/ArrangementPanel.tsx` | Clips on a song-mode timeline; markers; scene intensity curve; scene automation |
| **Modulation Panel** | `src/ui/ModPanel.tsx`, `ModMatrixRow.tsx` | Automation point editor, LFO editor, macro mapping, scene-intensity source |
| **Export Panel** | `src/ui/ExportPanel.tsx` | WAV / MP3 / video / stems / scorepack / share code; live measured peak / true-peak / RMS / correlation summary |
| **MIDI Panel** | `src/ui/MidiPanel.tsx` | MIDI device list, learn, pattern record arm |
| **Dice Tray** | `src/ui/DiceTray.tsx`, `DiceContext.tsx` | Seed-locked beat generator with locks and favorites |
| **Intent Panel** | `src/ui/IntentPanel.tsx`, `GenerateDialog.tsx` | Text → beat, slider-based generation |
| **Preset / Sample Browser** | `src/ui/PresetBrowser.tsx`, `SampleBrowser.tsx` | Curated browsers with category, mood, search, RECENT, hearts |
| **Master Meter** | `src/ui/MasterMeter.tsx`, `LoudnessHistory.tsx`, `Goniometer.tsx`, `SpectrumAnalyzer.tsx` | LUFS history, correlation, print-ready verdict, goniometer, spectrum |
| **Slice Lab** | `src/ui/SliceLab.tsx` | Drop a sample, transient-detect chop onto 16 pads |
| **Diagnostics** | `src/ui/Diagnostics.tsx` | Engine / scheduler / save status readout |
| **Help Overlay** | `src/ui/HelpOverlay.tsx`, `helpContent.ts`, `shortcuts.ts` | Full shortcut reference |
| **Onboarding** | `src/ui/OnboardingTour.tsx`, `OnboardingHint.tsx` | First-run three-step interactive tour |
| **Command Palette** | `src/ui/PaletteOverlay.tsx`, `commandPalette.ts` | `⌘K` keyboard-driven actions |
| **Themes** | `src/ui/ThemePanel.tsx`, `theme.ts` | Light/dark themes with persisted preference |

---

## 5. Architecture at a glance

```text
React / TypeScript UI
        │
        ▼
   Command system        ← every mutation; undo/redo; yjs bridge
        │
        ▼
   Project Model (truth) ← schemaVersion: 1; pure data; normalized on load
        │
        ▼
   Transport (musical time, PPQ 480, ticks ↔ seconds)
        │
        ▼
   Scheduler (25 ms tick / 120 ms lookahead; event-window in tick space)
        │
        ▼
   AudioEngine → Web Audio + AudioWorklet   [realtime playback]
        ▲
        │
   Renderer (OfflineAudioContext)            [export / embed / gallery preview]
```

The **same `AudioEngine`** drives both realtime playback and offline export. The engine accepts any `BaseAudioContext` via `useContext(ctx)`; the renderer hands it an `OfflineAudioContext` and the identical graph (tracks, inserts, instruments, returns, sends, automation, LFOs, macros, master chain) is built. Only the event driver differs: realtime uses the lookahead scheduler, offline pre-schedules every drum step, note and automation event deterministically before `startRendering()`. This is the single guarantee that an export sounds exactly like the project — there is no separate "render DSP".

The architectural decisions are recorded in `docs/adr/`:

| ADR | Topic |
|---|---|
| 0001 | Browser-first platform |
| 0002 | Audio clock scheduling |
| 0003 | Project model / runtime separation |
| 0004 | AudioWorklet boundary |
| 0005 | Rust/WASM DSP policy |
| 0006 | Effect rack and native effects |
| 0007 | Instruments and notes |
| 0008 | Composition systems (intent / dice / automation) |
| 0009 | Offline render and export |
| 0010 | Desktop packaging (Electron shell) |
| 0011 | Desktop auto-update (electron-updater) |

---

## 6. Tech stack

- **Language**: TypeScript (`strict`, `verbatimModuleSyntax`, `isolatedModules`, target ES2022).
- **UI**: React 18, custom CSS, no UI framework.
- **Audio**: Web Audio API + AudioWorklet for realtime custom DSP.
- **Bundler**: Vite 6, with the PWA plugin (`vite-plugin-pwa`) enabled only in the browser target (`KYX_DESKTOP=1` builds the Electron shell without it).
- **State / persistence**: IndexedDB (multi-store: projects, presets, library, kits, frozen buffers, user samples, ultina presets, groove pool).
- **Real-time collaboration**: `yjs` + `y-websocket`; the collab server lives at `server/collab-server.mjs` and serves both the y-websocket relay and the `/api/gallery` JSON store.
- **ML inference in browser**: `onnxruntime-web` (`1.29.0`), three small ONNX models (`intent-ranker-v1`, `symbolic-prior-v1`, `symbolic-melodic-v1`) loaded lazily in dedicated Web Workers.
- **MP3 encoding**: `@breezystack/lamejs` (LAME via wasm), default 192 kbps.
- **WAV encoding**: hand-rolled RIFF/WAVE writer in `src/rendering/wav.ts` (16/24-bit PCM + 32-bit float).
- **Video export**: `MediaRecorder` + canvas, prefers MP4 (`avc1.42E01E,mp4a.40.2`) and falls back to WebM.
- **Tests**: Vitest 2 (jsdom), Playwright 1.62 for E2E, a custom real-browser verifier (`scripts/verify-browser.mjs`) that drives the production build through headless Chromium / Firefox / Edge.
- **Desktop**: Electron 44, `electron-builder` for NSIS installer + portable exe, `electron-updater` for GitHub-Releases auto-update.
- **Code quality**: Prettier (format), TypeScript (`typecheck`, `typecheck:clean`).

---

## 7. Repository structure

```text
pulse-forge/
├─ src/
│  ├─ audio-engine/        ← AudioEngine.ts (~182 KB), metering, recorder, latency, ghosts, note-repeat, IR generator, time-stretch, phase vocoder
│  ├─ audio-worklets/      ← Worklet processors (reverb, sidechain, limiter, fxeq, ultina, ozvena, kaskada, wtvoice, granular voice, …)
│  ├─ audio-workers/       ← CPU workers for IR generation, onset detection, warp rendering
│  ├─ scheduler/           ← Scheduler.ts (event-window, 25 ms / 120 ms lookahead)
│  ├─ transport/           ← Transport.ts (musical time)
│  ├─ project-model/       ← Schema, types, transforms, groove, automation, modulators, scenes, templates
│  ├─ commands/            ← Command system, undo/redo, yjs bridge
│  ├─ store/               ← ProjectStore, SelectionStore, ToolStore
│  ├─ instruments/         ← Instrument registry (14 kinds), mod matrix, randomize
│  ├─ effects/             ← Effect registry (37 types), fxeq-core, ultina-core, ozvena-core vendored cores
│  ├─ sample-library/      ← Manifest, factory synthesis, curated layer, kit pools, velocity layers
│  ├─ presets/             ← Factory presets (199 + 6), normalization, similarity, audio quality
│  ├─ rendering/           ← renderProject, bounce, stems, WAV encoder
│  ├─ export/              ← Project I/O, share codes, MP3 encoder, video export, scorepack, theme/kit/pack/bind/share code helpers
│  ├─ persistence/         ← IndexedDB repositories, autosave debouncer, save lifecycle
│  ├─ midi/                ← MidiInput, MidiOutput, MidiClock, patternRecorder, midiFile, midiProject
│  ├─ collab/              ← YDocStore, CollaborationProvider, CollabSession, jam roles, transport sync, AI Bandmate
│  ├─ intent/              ← IntentSpec pipeline (normalize, plan, providers, candidate bank, dice, text parser, arrange words)
│  ├─ ai/                  ← Generative engine (markov, melodic, phrase, pad-roles, quality), feature extractors, ONNX ranker + symbolic priors + their workers
│  ├─ analysis/            ← Ultina analysis client + worker
│  ├─ assist/              ← Assist pipeline
│  ├─ arrangement/         ← ArrangementCaptureController ("capture last take")
│  ├─ samples/             ← autoMap, freesound
│  ├─ benchmark/           ← Stress harness
│  ├─ shared/              ← Pure helpers (rng, ids, dice)
│  ├─ ui/                  ← React shell and every panel/dialog/editor (~70 files)
│  ├─ embed/               ← /embed player (share-code driven)
│  ├─ gallery/             ← /gallery feed
│  ├─ landing/             ← /landing marketing page
│  └─ services.ts          ← Long-lived services, PlaybackController, factory wiring
├─ tests/                  ← ~217 vitest specs, ~5 e2e specs, golden vectors, intent suite, plugin hardnings, persistence round-trip
├─ public/                 ← PWA icons, worklet bundles, samples, ONNX model manifests + artifacts
├─ server/                 ← collab-server.mjs (y-websocket + /api/gallery JSON store)
├─ desktop/                ← Electron main.cjs + preload.cjs (the thin shell, ADR 0010)
├─ docs/adr/               ← Architecture decision records
├─ scripts/                ← verify-browser.mjs, desktop packaging, intent ranker training, model sync, vendor sync, release preflights
├─ remotion/               ← Promo video (Remotion)
├─ electron-builder.yml
├─ vite.config.ts
├─ vitest.config.ts
├─ playwright.config.ts
├─ tsconfig.json
└─ package.json
```

---

## 8. Installation

```bash
git clone <repo-url> pulse-forge
cd pulse-forge
npm install
```

The dev server starts on port 5173 by default. **Node 20+** is recommended (the build uses native ESM and `verbatimModuleSyntax`).

---

## 9. Development setup

The default workflow is:

```bash
npm run dev                 # vite dev server (http://127.0.0.1:5173)
npm run test                # vitest in jsdom
npm run typecheck           # strict tsc --noEmit
npm run build               # tsc --noEmit + vite build + bundle-size check
```

The build chain pre-builds the worklet bundles before the dev server (`predev`) and the production build (`prebuild`) because some effects load them lazily on demand.

For end-to-end testing, Playwright is used:

```bash
npm run test:e2e:smoke      # boot the four core scenarios in headless Chromium
npm run test:e2e            # full Playwright suite
```

For desktop development (Windows only — ADR 0010):

```bash
npm run desktop:dev         # vite dev server + Electron window (hot reload)
npm run desktop:smoke       # boots the Electron shell over dist/ and asserts the renderer mounts
```

---

## 10. Running the application

### Browser

After `npm install`:

```bash
npm run dev
```

…opens the app at `http://127.0.0.1:5173`. First-time visitors land on `/landing` with a live beat playing; returning users skip straight to the studio.

Production build:

```bash
npm run build               # output in dist/
npm run preview             # serve dist/ locally
```

### Desktop (Windows)

The same web build ships as a Windows desktop app — a thin Electron shell (`desktop/main.cjs`) that serves `dist/` over a custom `app://` scheme. The audio engine, persistence and worklet loaders are byte-identical with the browser build (ADR 0001 — "packaging must not contaminate the core design"). Projects and user samples persist in `%APPDATA%/KYX` and survive restarts and app updates.

```bash
npm run desktop:build       # vite build without the PWA layer → NSIS installer + portable exe in release/
```

The optional Windows MRT2 companion is never included by the normal package.
After building and verifying its fixed helper/model manifest, use
`npm run desktop:build:windows:mrt2`; this packages only the helper and
manifest, while model assets remain in the user-owned
`Documents/Magenta/magenta-rt-v2-windows` root.

The packaged artifacts are `KYX-Setup-<version>.exe` (NSIS, per-user install) and `KYX-Portable-<version>.exe` (portable). The Electron shell adds exactly four things the browser used to provide:

1. Silent permission grants for microphone and Web MIDI.
2. A native Save-As dialog for anchor-download exports (WAV / MP3 / MIDI / project JSON).
3. No service worker (the PWA layer is browser-only).
4. `window.kyxDesktop.isDesktop` so the app skips the web landing page.

**Auto-update** (ADR 0011): installed builds check GitHub Releases on launch and every 6 hours, download silently and install on the user's restart. Help → "Check for updates…" checks manually. `KYX_UPDATE_URL` overrides the feed for local testing. To ship an update: bump the version in `package.json`, run `npm run desktop:build`, then publish a GitHub release with `KYX-Setup-<version>.exe`, its `.exe.blockmap` and `latest.yml` from `release/`.

**Not yet shipped**: macOS/Linux targets, code signing, bundled collab server (collab stays opt-in via its manual server URL in the desktop build).

### Collab server

```bash
npm run collab              # ws://127.0.0.1:1234 by default (PORT/HOST to change)
```

Speaks the standard `y-websocket` sync + awareness protocol; CRDT state lives in clients, so a restarting server re-syncs from whichever client connects next. Also exposes the `/api/gallery` REST endpoints for the Beat Gallery feed.

---

## 11. Build, test, lint and release commands

```bash
npm run dev                     # vite dev server (HMR)
npm run build                   # tsc --noEmit + vite build + bundle-size budget check
npm run preview                 # serve dist/ locally
npm run typecheck               # strict tsc --noEmit (incremental)
npm run typecheck:clean         # drop tsbuildinfo and re-check
npm run test                    # vitest run (jsdom, ~217 files)
npm run test:browser            # real audio verification in headless Chromium / Firefox / Edge
npm run test:browser:factory-presets   # factory preset audition gate
npm run test:browser:production # production-build smoke
npm run test:e2e                # Playwright (tests/e2e/*)
npm run test:e2e:smoke          # four core E2E scenarios
npm run format                  # prettier --write src tests
npm run format:check            # prettier --check src tests

npm run ai:baseline             # generate intent-ranker baseline
npm run ai:performance          # latency harness for the intent pipeline
npm run ranker:train            # regenerate + train + validate intent ranker (python)
npm run ranker:activate         # flip shadow → active after golden gate passes
npm run prior:train             # regenerate + train + validate symbolic drum prior

npm run release:preflight       # explicit production config + shipped artifacts scan
npm run release:server-smoke    # spawn server/collab-server.mjs and hit /api/health
npm run release:deployed-smoke  # requires KYX_DEPLOY_URL

npm run desktop:dev             # vite dev server + Electron window
npm run desktop:build           # production desktop package
npm run desktop:smoke           # boot Electron over dist/

npm run build:core-worklets     # bundle the shared core-processor (limiter, sidechain, gate, …)
npm run build:fxeq              # bundle PRISM (fxeq) worklet
npm run build:ultina            # bundle VLYX (ultina) worklet
npm run build:ozvena            # bundle VØID (ozvena) worklet
```

The latest measured run of the full Vitest suite (`b8c7a00`) reported in `RELEASE_READINESS_REPORT.md`:

> **239 files passed / 2351 tests passed / 103 skipped / 2454 total** (`424.94s`), including FXEQ performance, all 300 s FXEQ/VLYX/VØID soaks, and the browser-compat contract. The full real-browser verifier passes **226/226 in Chromium, Firefox and Microsoft Edge**.

---

## 12. Architectural principles and constraints

The architecture is governed by `ARCHITECTURE.md` and the ADRs in `docs/adr/`. Key constraints:

- **UI describes intent. Project model stores truth. Transport defines musical time. Scheduler plans audio events. AudioEngine executes them. DSP processes sound.** No layer silently absorbs responsibilities belonging to another.
- **React must never become the source of truth for realtime audio execution.** Mutations go through commands; commands mutate the project model; the engine projects the model onto the audio graph.
- **Browser-first, local-first.** All core creative work (sequencing, synthesis, sampling, mixing, automation, playback, editing, rendering, export) must work offline once required assets are present. Cloud services are optional, never mandatory.
- **One shared engine for live and offline.** The renderer hands the same `AudioEngine` an `OfflineAudioContext`; only the event driver (realtime lookahead vs deterministic pre-scheduling) differs. Exports sound exactly like the project.
- **Determinism.** Same seed + intent + project → same content (content hash). Groove, swing, microtiming, ratchets, AI generation, offline render — all deterministic. AI models live behind timeouts + circuit breaker + heuristic fallback so they can never throw into the UI or audio callback.
- **AudioWorklet for custom realtime DSP, never the main thread.** Worklet modules are loaded per `BaseAudioContext` (live + every offline context); plugins load on demand (`ensureWorkletsForDoc`) so a beat that never touches PRISM doesn't pay for it.
- **Project schema is versioned.** `SCHEMA_VERSION = 1` in `src/project-model/schema.ts`. Loading auto-migrates, normalizes, and rejects unknown future versions with a clear error.
- **The audio context is shared across projects.** `useContext(ctx)` is the only path that creates `AudioNode`s on a context — so a fresh `OfflineAudioContext` for export never leaks nodes into the live context.
- **Plugin editor state is persisted as a validated plain blob** (`deviceState: { kind, data }`), not as opaque React state.
- **Decompression-bomb caps** on share codes and a 10 MB project-JSON import cap and 25 MB per-file audio import cap prevent tab OOM via crafted URLs.
- **Collab security:** `?server=` URL overrides are restricted to the same host as the app origin; self-hosted relays on other hosts must be entered in the UI deliberately.

---

## 13. Current project status

The codebase has been actively developed since mid-2026 and is in a working production-ready state for the browser and Windows desktop targets. Specific milestones verified on the latest candidate (`b8c7a00`) per `RELEASE_READINESS_REPORT.md`:

- `npm run typecheck` — PASS (clean `tsc --noEmit`).
- Full Vitest suite — PASS (239 files / 2351 tests / 103 skipped / 2454 total).
- `npm run build` + bundle budgets — PASS (entry 946 KB / 995 budget; total JS 1863 KB / 2400 budget; core worklets 98 KB / 120 budget; 359 modules; PWA precache 57 entries).
- Real-browser verifier — PASS (226/226 in Chromium, Firefox and Edge), including factory audio, real worklet DSP, PDC, collaboration, embed/share, touch and plugin workflow.
- Factory preset audio QA — PASS (199/199).
- Targeted plugin hardening — PASS for PRISM, VLYX and VØID.
- 300-second FXEQ/VLYX/VØID soaks — PASS (≤ 6 MB heap growth, ≤ 0.003 dB drift, zero tail peak, zero non-finite samples).
- `npm run release:preflight`, `release:server-smoke` — PASS.
- `npm audit --omit=dev` — 0 vulnerabilities.
- `npm run ai:performance` — worst p95 3.35 ms vs 250 ms budget.

Owner gates still open (not blocking local development): manual Firefox / Safari / iOS Safari smoke, deployed-host smoke (requires `KYX_DEPLOY_URL`), and the formatting decision (`prettier --check` reports repo-wide deviations; tracked in `docs/FORMAT-CHECK-DEVIATIONS.md`).

---

## 14. Known limitations and experimental areas

The honest list of caveats lives in `KNOWN_LIMITATIONS.md`. Highlights:

### Export and rendering
- Scene intensity, scene-tempo seams and scene automation are written through the same engine macro path in live and offline renders; near a scene boundary the live scheduler is control-rate driven (25 ms look-ahead), so a seam can differ from the offline sample-exact timeline by up to one scheduler tick.
- Marker cue one-shots are deliberately excluded from the master WAV export (they live in scorepacks instead).
- WAV overflow is intentionally soft-kneed, not transparent; the 16-bit path uses deterministic TPDF dither.
- Offline render of a single stage cannot be interrupted; the CANCEL button stops between master / stem / track stages, between SCOREPACK stages and during MP3 encoding or video recording.

### Sound and mixer
- Chorus / Delay / Drum Buss / Bass Buss were upgraded on 2026-09-18 to worklet DSP — intentionally not bit-exact, same params, new character.
- The look-ahead limiter is true-peak since 2026-09-18; on transient-hot masters the export may sit a fraction of a dB under the ceiling.
- Group tracks cannot be frozen (a group has no generators, so its buffer would be silence — freeze the child tracks instead).

### Ultina / VLYX vendored core
- DSP-inert vendor-reserved parameters (`comp.autoLearnThreshold`, `transient.crossoverLearn`, `clipper.crossoverLearn`) are reserved schema placeholders, not implemented.
- Mix assist / reference match use a dedicated host-side worker; analysis uses a v1 simplified K-weighting approximation (not a full BS.1770 implementation).

### VØID vendored core
- Pre-delay reserves its maximum supported range at `prepare()` to remove runtime ring growth — at 48 kHz one stereo instance costs about 37 MB; at 96 kHz about 74 MB; at 192 kHz about 147 MB. Multiple high-rate VØID instances should be included in device-memory QA.

### Mod matrix
- Granular is intentionally omitted from the mod-matrix rollout — its modulation story is its own `POSITION / SCAN / JITTER / RATE` parameters.
- Destination `DETUNE` (2) is reserved and not implemented on either path (worklet or fallback).

### Collaboration
- Undo is local; remote edits never enter your undo stack (deliberate — CRDT merges cannot be inverted locally).
- Collab session undo history is unbounded; very long jam sessions grow it; reload resets it.
- Custom collab servers are trusted by design; the server URL is used as-is.

### Platform
- AudioWorklet-less environments degrade audibly (the master tape and look-ahead limiter fall back to simpler native nodes). All modern Chromium / Firefox / Safari ship worklets.
- MIDI clock master output uses timer scheduling (a few milliseconds of jitter).
- Import size caps: 25 MB per audio sample, 10 MB per project JSON.

### Deferred by decision
- Vitest 5 + Vite 8 migration.
- `bounceStemsToAudioClip` command exists and is tested but has no UI wiring.

### Environment-sensitive QA
- The `verify-browser` suite is not safe to run in parallel with another active session or build on the same machine — co-tenant load can push CPU metrics across gates; on a quiet machine 218/218 pass.

---

## 15. Roadmap signal

There is no public release roadmap with committed dates; the project tracks work across multiple internal roadmaps (`RELEASE_ROADMAP.md`, `EDIT-ROADMAP.md`, `INSTRUMENT-ROADMAP.md`, `DSP-ROADMAP.md`, `SCENE-MODE-ROADMAP.md`, `INTENT_ENGINE.md`). All are living documents with per-task status, so any future commitment should be sourced from the specific document under that area.

A few clear directions visible in those documents, but **not commitments**:

- **Intent engine expansion** — T3 structure / long form, T4 audio dimension, T5 neural audio synthesis (very long horizon) per `INTENT_ENGINE.md §8`.
- **Scene Mode as a first-class identity** — wall-clock composition, intensity as the primary editable signal, sample-exact tempo seams (largely landed in 2026-09 per `SCENE-MODE-ROADMAP.md`).
- **Vocal chops, spectral pads, log drums, FM** — recent instrument additions already shipped; further sound-design work tracked in `INSTRUMENT-ROADMAP.md`.
- **VST/AU plugin hosting is explicitly out of scope** per `VISION.md §1`.

---

## 16. Contributing and development notes

- **No proprietary plugins, no cloud-side processing, no accounts.** Everything runs in the user's browser; the only network calls are optional (freesound search, collab server, gallery feed, auto-update).
- **Strict TypeScript.** `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`, `verbatimModuleSyntax`, `isolatedModules`. Run `npm run typecheck` before any non-trivial PR.
- **Prettier.** Format with `npm run format`. The formatting deviation baseline is documented in `docs/FORMAT-CHECK-DEVIATIONS.md`.
- **Tests.** Vitest (`npm run test`), Playwright (`npm run test:e2e`), and the real-browser verifier (`npm run test:browser`) cover different layers. Vitest alone cannot hear audio — `verify-browser` is the gate that confirms the audio chain works end-to-end in real engines.
- **Worklet builds.** Plugin worklets are vendored DSP suites that are bundled separately. After any change to `src/effects/fxeq-core/`, `src/effects/ultina-core/`, `src/effects/ozvena-core/` or `src/audio-worklets/`, run the corresponding `npm run build:fxeq` / `build:ultina` / `build:ozvena` (and `build:core-worklets` for the shared processor) before `npm run dev` or `npm run build`. The `predev` and `prebuild` npm hooks already do this automatically.
- **Vendor reconciliation.** `scripts/vendor-ultina.mjs` and `scripts/vendor-ozvena.mjs` re-vendor the upstream cores; both refuse to drop reconciled markers the upstream snapshot lacks, so the vendored core stays in lock-step with the mirrored source.
- **Schema migrations.** The project model lives in `src/project-model/schema.ts`. Any change to the on-disk shape must update `SCHEMA_VERSION` and provide a migration in `migrateProject`; loading code rejects unknown future versions.
- **Architecture decisions** go through an ADR in `docs/adr/` with date and status. Existing ADRs are the canonical reference for "why" questions.
- **Adding a new effect / instrument** follows the contract in `ARCHITECTURE.md` §28 and is verified by the targeted vitest suites for effects, instruments, and plugin worklets. Factory presets for a new instrument must be auditable via `npm run test:browser:factory-presets`.
- **Bundles.** `npm run build` enforces bundle budgets (entry 1070 KB, DAW JS 2500 KB, optional lazy AI runtimes 650
  KB, core worklets 150 KB). The checker reports physical shipped JS separately; if you need to grow a budget, justify
  it in the PR.
- **AI models.** Three ONNX models live under `public/models/` with sibling `*.manifest.json` that pins the feature version, normalization id and SHA-256 hash. Any model update requires regenerating the dataset (`scripts/generate-*-dataset.mts`), retraining (`scripts/train-*.py`), validating (`scripts/validate-*.{py,mjs}`), and updating the manifest hash.

---

## Quick start

```bash
npm install
npm run dev          # http://127.0.0.1:5173
npm run test         # vitest in jsdom
npm run typecheck    # strict TypeScript
npm run build        # production build + bundle budgets
```

The first beat plays in under a minute.
