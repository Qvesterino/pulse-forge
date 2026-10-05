# ADR 0019 — Stem separation (two-tier: deterministic HPSS + opt-in htdemucs ONNX)

Date: 2026-10-06
Status: Accepted (architecture + plan; implementation waves pending)

## Context

The UN-SUNO transcription engine (U0–U7, `docs/UN-SUNO-PLAN.md`) transcribes
drums, bass, chords and lead **from the full mix**, and every layer fights the
same battle: the kick's fundamental sits in the bass band, bass harmonics reach
the snare band, and chord pads bleed into the melodic register. Measured
ceilings on the golden set: techno bass recall 0.09 (YIN reads the kick inside
the 16th-bounce bass), snare↔hat cross-talk at ~1:1 magnitude parity. These are
not tuning problems — they are **the absence of source separation**. A standalone
predecessor app (`D:\beat_modifier`) tried the same decomposition; the standalone
shape failed for product reasons, but its recipes were absorbed (U1–U3).

Separation approaches, researched 2026-10-06:

- **HPSS** (harmonic–percussive source separation, Fitzgerald 2010; median
  filtering across time/frequency on the magnitude spectrogram, soft-mask
  resynthesis): deterministic, model-free, cheap (a few FFT passes in the
  reference worker we already run). Quality is baseline-tier — percussion vs
  tonal split with bleed where content overlaps — but it is honest, local and
  needs no download.
- **htdemucs (Demucs v4, Meta)**: hybrid transformer/waveform U-Net, 4 stems
  (vocals/drums/bass/other). **MIT-licensed, ~80 MB** for the standard
  checkpoint. ONNX exports exist and are actively maintained by third parties
  (htdemucs-onnx, StemSplit's htdemucs-ft-onnx — reported ~31 % faster on CPU
  than the PyTorch baseline); Mixxx is integrating exactly this for in-app
  separation. Quality is top-tier among open models (SDX 2023 winning ensembles
  build on it).
- **BS-RoFormer / BSRNN family**: higher vocals SDR than htdemucs, but much
  larger weights and heavier inference — a poor first browser target.
- **Spleeter**: TF-era, awkward weight conversion, superseded — rejected.
- **Cloud APIs**: violate the local-first invariant. Rejected outright.

Repo reality that shapes the decision: `onnxruntime-web` ^1.29 is already a
dependency (ranker, intent model, AST classifier), the manifest + sha256 +
gatePassed download ritual already exists (`pf:*` flags, `npm run audio:fetch`
pattern), the reference worker already runs FFT pipelines, and per AGENTS
ADR 0014 every full-DAW feature needs licensing review + an honest support
matrix.

## Decision

**Two-tier stem separation, both local, both deterministic-per-input.**

### Tier 1 — DSP HPSS (always available, no download)

Median-filtering HPSS implemented in the reference worker's FFT pipeline:
harmonic stem (sustained tonal content), percussive stem (transients), plus a
band split of the harmonic stem into a bass register (≤ ~250 Hz) and a
mid/high remainder. **Not advertised as production stems** — they are
_guide stems_: deterministic pre-filters the transcription lanes read instead
of the full mix, and a user-facing stems-export for any loaded track (the
rendering/stems.ts seam already exports WAVs). Every finding the lanes make
on guide stems must be reproducible and floored by tests (a regression in a
lane's golden KPI while reading guide stems fails the suite).

### Tier 2 — htdemucs ONNX (opt-in download, `pf:stem-model` flag)

One checkpoint (standard htdemucs first, ~80 MB), fetched via a replayable
`npm run stem:fetch` script into `public/models/` with the manifest + sha256 +
`gatePassed` pin (the audio-tag ritual — a model without a PASSED gate is a
candidate, not an actor). Inference in a dedicated worker via onnxruntime-web
(WASM SIMD first; WebGPU backend behind a flag once measured), **chunked with
overlap-add** so memory stays bounded on 3-minute tracks. Output = the 4 stems
as AudioBuffers: they feed the transcription lanes (replacing guide stems when
present), and they are exportable by the user — stems export of any loaded
track is a feature in its own right under ADR 0014.

Licensing review: Demucs code and checkpoints are MIT (Facebook Research) —
commercial use allowed; the fetch-from-origin script (never a git-embedded
binary) matches the existing model-pack pattern and keeps the repo clean.

## Consequences

- Two honest quality tiers with explicit naming in the UI ("guide stems" vs
  "neural stems"); nothing may silently claim Demucs quality from HPSS.
- Memory/latency: HPSS is one extra FFT pass in an existing worker; htdemucs
  inference is chunked, cancellable, worker-bound, and flag-gated — a user who
  never enables it pays zero bytes.
- The transcription KPI floors get a SECOND locked baseline measured on
  separated input (target: techno bass recall from 0.09 to ≥ 0.3 on the
  percussive/bass stems; snare↔hat cross-talk materially down). Improvements
  only ever re-lock upward.
- Follow-ups enabled but not claimed here: stem export UI, per-stem mixer
  lanes, re-style remix input quality, similarity advisory.

## Plan

`docs/STEM-SEPARATION-PLAN.md` — waves S0 (HPSS core + tests), S1 (lane
integration + KPI re-measure), S2 (user stems export), S3 (model fetch + ORT
worker + chunked inference), S4 (lane wiring + panel surface), S5 (WebGPU +
benchmarks).
