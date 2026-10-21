# ADR 0054 — CHORÁL harmony instrument (grain-sustained timbre stack)

Date: 2026-10-17 · Status: Accepted (v1) · Scope: instruments registry, lazy instrument worklets, harmonyContext consumers

## Context

The instrument family had no instrument whose identity is HARMONY: play one
note, hear a stack of voices that agree with the song. The two flagship
instruments cover other ground (TSAR: sample→patch hybrid; KOPA: kick
design). Meanwhile the pieces for a harmony-following timbre instrument all
exist: the harmonyContext bridge (ADR 0040 lineage — doc.key/chords →
12-bit masks, instrument-side since the TSAR A SNAP wave via
`InstrumentEnv.harmonyContext` / `setHarmonyContext`), the T9 grain engine
architecture (bounded per-voice pools, per-note LCG, Hann windows,
offline-seeded event queues), YIN/Forge root estimation, and the
flagship-worklet pattern (ADR 0023/0035: typed core + thin entry + lazy
load + real audible fallback).

CHORÁL ("Choral") is a harmony instrument: drop a monophonic pitched
source (a hum, a vowel, a cello note), set its root, play — the engine
sustains the source's TIMBRE at the played pitch as a grain stream, and a
harmony stack voices additional tones that agree with the song's scale or
the chord sounding at the note's bar.

## Decision

1. **New instrument kind `choral`** (additive — `InstrumentKind` union,
   `INSTRUMENT_NAMES`, `DEFAULT_GM_PROGRAM_BY_INSTRUMENT` GM 53 "Voice",
   `INSTRUMENT_META`/`INSTRUMENT_ORDER`). No project schema bump:
   `normalizeProject` heals unknown kinds, and the new kind is
   Record-complete surface work only (ADR 0035 §5 precedent).
2. **DSP in a typed core** `src/choral/dsp/choralProcessor.ts` (the
   tsarProcessor split: no AudioWorklet globals, vitest-testable), wrapped
   by `src/choral-worklet.entry.js` (chunked render, payload validation)
   and bridged by `src/instruments/choralNode.ts` (live = port messages;
   offline = `processorOptions.events` + `processorOptions.harmony` seeds —
   Chromium does not pump worklet message queues during an offline render).
3. **Synthesis = grain-sustained replay.** Each keyboard note spawns one
   grain stream per harmony tone: Hann-windowed grains (SIZE/DENSITY/
   JITTER, the T9 architecture) resampling the source at
   `midiToHz(pitch + interval) / sourceRoot`. Streams retire on release.
   No spectral resynthesis in v1: formant/timbre shaping is a follow-up
   wave (R2) — this is the honest scope line.
4. **Harmony stack** (`stackMode` OFF/OCTAVES/FIFTHS/TRIAD +
   `stackLevel`/`stackDetune`): OCTAVES ±12; FIFTHS +7/−5; TRIAD adds a
   third chosen FROM THE CONTEXT — the candidate third (+4, then +3) is
   snapped against the chord mask at the note's bar (scale mask fallback,
   chromatic → major third). The context arrives through the same
   `setHarmonyContext` contract TSAR uses; a project without a key degrades
   to chromatic (TRIAD → major third + fifth), never to silence.
5. **Lazy loading + budget row**: `INSTRUMENT_WORKLET_TYPES` gains
   `"choral"`; `scripts/build-choral-worklet.mjs` emits
   `public/choral-worklet.js`; its own bundle budget row (48 KB ceiling —
   the grain architecture is shared with TSAR's 48 KB engine but CHORÁL has
   no wavetable/unison/arp machinery). A project with no CHORÁL track never
   fetches it.
6. **Fallback without the module is a real audible choir**: a detuned
   saw+triangle stack per harmony tone through a lowpass — the
   `createTsarFallbackRuntime` precedent (never a dead graph). Live↔offline
   parity is unaffected wherever the worklet exists.
7. **No factory presets in v1.** Presets require the browser loudness
   harness (coverage/clamp pins in the preset-loudness audit), and v1's
   value is the default patch + user samples. Preset family + curated bank
   - loudness measurement are the follow-up wave. The Sample Forge import
     path and `setInstrumentSample` are the user-sample route.
8. **No dedicated panel in v1** (descope): every parameter is editable in
   the Inspector's generic instrument-params surface (it renders
   `INSTRUMENT_DEFS[kind].params` for any kind), and the source arrives via
   `setInstrumentSample` (SampleBrowser drag) — the KOPA precedent (no
   panel, preset- and inspector-driven). A dedicated CHORÁL surface
   (drop-a-hum UX, stack visualization) is a follow-up wave.
9. Polyphony: 32 grain streams (8 notes × 4 stack tones), oldest-steal;
   RNG only through the seeded per-stream LCG.

## Consequences

- A project with no CHORÁL track never fetches `choral-worklet.js`.
- The instrument count moves 24 → 25 (CURRENT-STATE).
- `stackLevel` scales only the harmony tones (the played note keeps
  `level`), so the ladder is a mix control, not an on/off.
- Known v1 scope lines (follow-ups, not defects): no formant preservation
  (resampling shifts formants — the R2 timbre wave), no factory preset
  bank, no portamento, no MPE.
