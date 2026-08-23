# Pulse Forge

A focused, browser-first electronic music production workstation.

This repository implements **Phases 0–6** of the build order defined in `Pulse Forge — Master Build Prompt.md`, through the production milestone (offline render + WAV/stem export).

## Run

```bash
npm install
npm run dev          # development
npm run test         # unit tests (vitest, node)
npm run test:browser # audio verification in real headless Chromium
npm run typecheck    # strict TypeScript
npm run build        # production build
```

## What works (verified)

- **Project browser** — the app always boots into a project browser: a one-click "Continue last project" card, the project list (open / duplicate / inline rename / delete with confirm, sorted by last update), and a template grid for new projects. Everything is persisted in IndexedDB; new projects are saved the moment they are created.
- **Templates (6)** — House (starter groove), Techno (driving kick + rumble bass, two loop variations), Trap (half-time snare, rolling hats, long-decay 808 + sparse lead), Ambient (evolving texture pads + soft analog chords, no drums in your way), Scene Score (arrangement-first: INTRO/BUILD/DROP/BREAK/OUTRO scenes pre-placed on a 24-bar timeline) and Empty. Every template is schema-valid by construction and renders audio (verified in real Chromium).
- **Factory sound bank** — 41 procedurally synthesized factory sounds (kicks, snares, claps, hats, cymbals / crashes, toms, percussion including cowbell / conga / tambourine, FX transitions like Riser / Downlifter / Impact / Sweep / Reverse Rise / Noise, plus tonal samples), each tagged by category and mood (dark / bright / warm / aggressive / clean / deep / atmosphere). The House starter groove ships with a chords track so the first play sounds full, and every template includes four named performance macros (DRUMS / BASS / MUSIC / WIDTH) mapped to mix-bus roles.
- **Preset library** — 77 factory presets across all seven instruments, tagged by genre (House/Techno/Trap/Ambient/Score) and mood, curated by sound-design intent (e.g. "Acid Line", "FM Growl", "Cinematic Strings", "Shimmer"). Browser in the Inspector with genre + mood chips, ALL / FAVORITES / RECENT scope, search, one-click apply (single undo step), hearts, and "save as user preset" (persisted to IndexedDB).
- **Sample browser & favorites** — both drum-pad and sampler sample slots use a curated browser with search, category filter, mood filter, click-to-preview, a RECENT section and a heart toggle, all backed by the persistent IndexedDB `library` store.
- **Autosave & recovery state** — debounced autosave (800 ms) with a live status indicator (`SAVED hh:mm` / `UNSAVED` / `SAVING…` / `SAVE ERROR — RETRY`, click to retry), flush on tab-hide and page close, and "saved X ago" freshness on every project card.
- **Onboarding** — three interactive hints that advance as you actually do things (press SPACE → edit a step → discover the panels), shown once per browser profile. First run highlights the House template so the first sound is under a minute away.
- **Groove engine** — project-level **swing** (0–100 %, odd 16ths toward triplet feel) and **humanize** (seeded timing + velocity variation), per-step **probability** (deterministic seeded rolls), **ratchets** (1–8× retriggers with velocity decay) and **microtiming** (± early/late). Implemented in one shared deterministic module consumed by both the realtime scheduler and the offline renderer — exports groove exactly like playback (verified: grooved render differs from straight render).
- **Groove editing UX** — SWING / HUM·T / HUM·V drag controls in the pattern bar; right-click any step for the inline step editor (PROB slider, RATCHET selector, MICRO drag, RESET); steps show markers (dashed border = probability, badge = ratchet, side ticks = early/late).
- **Variation workflow** — `MUT` mutates the active pattern into a seeded variation (velocity jitter, ghost notes, dropped weak hits, microtiming), `FILL` duplicates it as an explicit fill with a rising snare roll + ratcheted final hit; both are single undo steps.
- **Multi-select steps** — shift+drag a rectangle across the grid, then `Delete` clears the range or a velocity drag scales every selected hit; `Esc` clears the selection.
- **Quantized scene launches** — scene chips (pattern bar strip + ARR panel) switch instantly while stopped and queue to the next bar while playing (pulsing "queued" state); stopping commits a queued launch. In song mode a scene chip jumps the playhead to the scene's first clip.
- **Song-mode seek** — arrangement ruler with live playhead; click or drag to seek anywhere (scheduler re-aligns mid-playback). Transport seeks (`Home` / `,` / `.`) also resync the scheduler.
- **Loop region** — `L` toggles the loop; IN/OUT drag-numbers in the top bar; the scheduler wraps inside the region in both play modes.
- **Project model** — versioned schema (`schemaVersion: 1`), pure serializable data, JSON round-trip tested. Loading auto-normalizes pattern rows (missing pads, wrong lengths).
- **Command system** — all mutations flow through commands with full undo/redo (`Ctrl+Z` / `Ctrl+Y`).
- **Transport** — musical time in ticks (PPQ 480), BPM 20–300, play/pause/stop, BPM change rebases the anchor during playback. Unit-tested.
- **Lookahead scheduler** — 25 ms interval, 120 ms horizon against `AudioContext.currentTime`; loop wrap, multi-track triggering, track/pad mute + solo gating (track solo is global, pad solo is per-track), live project reads. Unit-tested with a controlled clock.
- **Drum Rack** — 16 pads per track, per-pad gain/pan/pitch/mute/solo/choke groups, sample assignment.
- **Multiple drum tracks** — add/remove tracks (`+ TRACK` in the rack header or mixer), each with a full kit; unique pad IDs across tracks; pattern rows cover all tracks automatically.
- **Pattern management** — create (ADD), duplicate (DUP / `Ctrl+D`), rename (double-click chip), delete, copy/paste, clear, 16/32-step length switching with content preservation; pattern chips with inline rename.
- **16/32-step sequencer** — click toggles steps, vertical drag edits velocity (for the whole multi-selection when one), shift+drag rectangular multi-select, right-click per-step performance editor, playhead indication, beat grouping, rows grouped per track with track headers.
- **Mixer** — channel strips per track: rename, volume, pan, mute, solo, delete, **real peak meters** (AnalyserNode per track + return + master, ~30 Hz throttled UI), per-track **send knobs to returns**, return strips, and a master strip. Toggle via `MIX`.
- **Returns (send/return buses)** — two factory returns (Reverb, Delay) with real insert effect chains; each track sends a configurable post-fader level; return outputs sum into the master. Return gain editable in the mixer.
- **Master processing** — gain-staged master chain `IN → soft-clipper → limiter → analyser`. The master strip exposes `IN` (master input trim), `CEIL` (limiter ceiling in dBFS, default −1), `LIMIT` (transparent safety limiter) and `CLIP` (soft-clipper for character) for predictable, professional loudness. Both processors are honest, bypassable, and the signal chain is identical between live playback and offline export. Verified: limiter reduces a hot mix, clipper softens it.
- **Master metering** — stereo L/R peak + RMS bars with peak-hold ticks, a ×CORR correlation block (mono / wide / phase), a HEAD headroom strip showing the limiter ceiling, and a live CLIP warning when the master is over 0 dBFS. Master configuration (IN, CEIL, LIMIT, CLIP) is clamped to safe ranges by the project model (verified in unit tests).
- **Export summary** — every export (master, stems, tracks) returns a measured readout of peak, **true peak** (4× parabolic interpolation), RMS and stereo correlation so the user knows the master loudness, headroom and phase state before sharing the file.
- **Offline rendering** — deterministic, sample-accurate render of the exact same engine, instruments, effects, sends, automation, LFOs and macros used in playback, via `OfflineAudioContext`. Pattern mode renders one pattern pass; song mode renders the full arrangement; a configurable tail (default 2 s) preserves reverb/delay tails.
- **WAV export** — 16-bit PCM, 24-bit PCM, or 32-bit float at 44.1/48 kHz, encoded by a hand-written RIFF/WAVE writer (header + interleaving verified in tests).
- **Stem export** — grouped stems (Drums / Bass / Music) rendered from filtered project copies (solo is disabled in stems for predictable summation), plus a one-stem-per-track export. Master + stems + all-tracks are one-click each in the `EXPORT` panel.
- **Effect rack** — common device shell per track (`FX` panel): add/remove/reorder/bypass, compact parameter controls driven by shared parameter metadata. Inserted between track input and pan in the audio graph.
- **Native effects (7)** — all Web Audio based, verified in real Chromium via offline rendering:
  - **EQ** — 3-band (low shelf / peaking / high shelf), gain+freq+Q.
  - **Compressor** — threshold/ratio/attack/release/knee + makeup + parallel mix.
  - **Saturation** — tanh waveshaper (2× oversampled), drive/tone/mix/output.
  - **Clipper** — hard/soft clip (4× oversampled), drive/ceiling/softness/output; ceiling verified sample-accurate.
  - **Reverb** — convolution reverb with procedurally generated seeded stereo IR, decay/pre-delay/tone/mix.
  - **Delay** — feedback delay with damped feedback path, time/feedback/tone/mix.
  - **Pump** — tempo-synced volume shaping (1/1…1/16), amount/rate/release; beat-aligned on transport start, re-syncs on BPM change (duck-curve oscillator modulating track gain).
- **Effect engine integration** — structural chain changes rebuild runtimes; parameter tweaks are diffed and applied smoothly; track deletion disposes nodes+runtimes; BPM changes propagate `syncBpm` to runtimes.
- **Instrument tracks** — Sampler / Analog Synth / Bass Synth / 808 Synth / Texture / Wavetable / Granular as a second track kind, created from the `+ TRACK` menu; per-instrument parameter panels in the Inspector; instruments feed the same track chain (inserts, pan, gain, meters) as drums.
- **Native instruments (7)** — Web Audio voices with polyphony management and voice stealing, verified in real Chromium:
  - **Sampler** — plays tonal factory samples (pluck/stab/keys/bell), root-note transposition, attack/release, filter, gain.
  - **Analog Synth** — subtractive: 2 oscillators (waveform select) + sub + noise → lowpass with envelope → ADSR amp; cutoff/resonance update live on sounding voices.
  - **Bass Synth** — semantic macro controls (SUB/BODY/PUNCH/GRIT/MOVEMENT/WIDTH) mapped to a real saw/square/sub voice with drive, filter envelope, LFO movement and stereo width.
  - **808 Synth** — sine body with pitch-drop envelope, decay, transient click, drive, tone; monophonic (retriggers cleanly).
  - **Texture Synth** — polyphonic pad/drone with shared LFOs, filtered noise, tremolo and a feedback delay space.
  - **Wavetable Synth** — morphing wavetable voices: two crossfaded single-cycle frame loopers per oscillator with detuned unison + sub, lowpass, ADSR. Five factory tables (Sine Grow / PWM / Formant / Digital / FM Drive); drop any sample on the track's source browser and the table is extracted from it (autocorrelation period detection → seamless cycle slicing). MORPH sweeps the timbre; canvas preview shows the table + morph position.
  - **Granular Synth** — deterministic granular sampler: every note schedules its full grain cloud upfront (position, grain size, rate, jitter, stereo spread, reverse probability, pitch, tone, envelope shape), so offline renders match playback exactly. Drop any sample (factory or user import) as the grain source; canvas preview shows the waveform with the grain window.
- **Piano roll** — per-instrument-track editor in the sequencer: click to add notes, drag to move, drag right edge to resize, right-click or `Delete` to remove; playable keyboard column (click keys to audition); playhead column; pitch range C1–C6.
- **Event-window scheduler** — the scheduler plans a lookahead window in tick space and schedules both drum steps (through the shared groove engine: swing/microtiming/humanize/probability/ratchets) and arbitrary note events. Quantized pattern launches split a window exactly at the launch tick; seeks re-align the window mid-playback.
- **House template ships a bass line** — the House starter project includes an 808 track with a playable bass pattern so the first play is already a beat with sub.
- **Scenes** — named launches referencing patterns (no data duplication). Click a scene chip to launch (sets the active pattern); scenes survive pattern edits by reference. Create/rename/delete from the `ARR` panel.
- **Arrangement + song mode** — linear timeline of clips (scene + start bar + length). `PATTERN/SONG` toggle in the transport: song mode plays the arrangement, switching patterns at clip boundaries, looping short patterns inside longer clips and staying silent in gaps. Timeline UI: click to place, drag to move, drag right edge to resize, right-click to delete; overlap-safe with undo.
- **Automation** — project lanes targeting track volume/pan (exact audio-rate ramps), effect params and instrument params (window-resolution). Point editor in the `MOD` panel: click to add, drag to move, right-click to delete; linear interpolation; loops in pattern space. Resets on stop.
- **LFO** — per-track audio-rate modulation of volume or pan: sine/tri/square/saw up/down, free Hz or tempo-synced (1/1–1/16), amount; re-syncs on BPM change.
- **Macros** — four project macros (A–D) with bipolar value (center = neutral) mapping to track volume/pan offsets. Mapping editor per macro.
- **Modulation routing in engine** — each track chain ends with dedicated automation/macro gain+pan stages, so mute/solo, manual volume, automation, LFO and macros never fight over the same AudioParam.
- **Factory sound bank** — 20 procedurally synthesized sounds (16 drums + 4 tonal: pluck/stab/keys/bell), seeded, deterministic, license-clean, rendered via `OfflineAudioContext` at startup.
- **Audio engine** — per-voice gain/pan/pitch, choke groups, voice cleanup, panic (guaranteed stop), track chains with smoothing.
- **Persistence** — IndexedDB multi-project store (projects + user presets + user sample audio), debounced autosave (800 ms), manual `Ctrl+S`, reload restores the exact project (incl. after refresh); the browser lists every saved project with freshness and one-click resume. Imported user samples (WAV/MP3/OGG/FLAC/AIFF) keep their encoded bytes in IndexedDB and are decoded back into the sample bank on boot, so they survive reloads.
- **Diagnostics panel** — context state, sample rate, voices, scheduled events, scheduler state, track/pattern counts, save status (toggle `DIAG` in the top bar).
- **Starter groove** — the House template opens with a house groove (4-on-the-floor kick, clap on 2/4, offbeat hats) so the first play already sounds musical.

## Not implemented yet (planned)

- User-defined buses (returns cover send/return routing today)
- Arrangement loop regions, song-mode seek UI
- Automation recording, per-scene automation
- AudioWorklet + Rust/WASM DSP path

## Architecture

```
React UI  →  Commands  →  Project Model (truth)
                              ↓
                    Transport (musical time)
                              ↓
                    Scheduler (lookahead)          [realtime]
                              ↓
                    Audio Engine → Web Audio
                              ↑
                    Renderer (OfflineAudioContext)  [export]
```

The **same** `AudioEngine` drives both realtime playback and offline export — only the surrounding context (`AudioContext` vs `OfflineAudioContext`) and the event driver (lookahead scheduler vs pre-scheduled deterministic events) differ. This is what guarantees that exports sound exactly like the project.

Source layout mirrors the responsibilities from `ARCHITECTURE.md`:

```
src/
├─ project-model/   # schema, types, pure transforms
├─ commands/        # command system (undo/redo)
├─ store/           # ProjectStore (doc + history + subscribers)
├─ transport/       # musical time
├─ scheduler/       # lookahead event-window scheduling
├─ audio-engine/    # graph ownership, voices, routing, fx chains, instruments, returns, master
├─ effects/         # effect definitions + runtime registry
├─ instruments/     # instrument definitions + runtime registry
├─ sample-library/  # manifest + procedural factory bank
├─ rendering/       # offline renderer, WAV encoder, stem builder
├─ persistence/     # IndexedDB repository
└─ ui/              # React shell and editors
scripts/
└─ verify-browser.mjs  # real-Chromium audio verification (playwright + vite)
```

See `docs/adr/` for architectural decision records.
