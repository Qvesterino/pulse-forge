# ADR 0031 — Local SVS model (singing voice synthesis) — owner-gated campaign

Date: 2026-10-12 · Status: PROPOSED — waits on the corpus licensing decision (owner gate)

## Context

The vocal campaign shipped W1 (section development), W2 (lyrics→prosody) and
W3 (hum→voice) — plus the SUNO-format compatibility (W4). The one column
where SUNO-class products still lead is a **synthesized singing voice**:
their models turn (lyrics, melody) into a sung performance. KYX today sings
only with the user's OWN hum (W3) — a deliberate wedge, but users will ask
for a voice that isn't theirs.

W2 already produces the two inputs an SVS model consumes: a syllable
timeline and a singable note grid. The missing piece is the neural voice
itself.

## Decision (pending the owner gate)

Train a small local SVS head in the project's existing ONNX pipeline —
the same discipline as the intent model (dataset versioned, manifest
gatePassed pin, lazy worker, browser wasm):

1. **Corpus** (the owner gate): only permissively-licensed sung corpora
   qualify. Candidates for the licensing review: NUS-48E (NUS Sung and
   Spoken Lyrics, research-only — likely disqualified), OpenSinger (Chinese,
   MIT-adjacent — check), M4Singer (multi-language, academic), PJS (Japanese
   perpetual, research), PopBuDDy / PopCS. **An English/SK folk or public-
   domain recording set commissioned/recorded in-house is the clean path.**
   License review per docs/SAMPLE-SOURCES.md conventions; ADR decides.
2. **Model**: a compact acoustic head — (syllable grid + note pitches +
   speaker embedding) → mel frame → neural vocoder — sized for the browser
   wasm budget the intent model already proved (single-digit MB). Training
   runs in scripts/train-svs.py; the artifact ships under public/models/
   with the standard manifest.
3. **Wiring**: `src/vocal/svs-client.ts` + worker mirror the intent-model
   pattern (lazy spawn, timeout, breaker). The W2 grid is the input; W3's
   hum→voice stays the fallback and the personal voice.

## Honest limits

- A 1.2B-class LLM cannot run acceptably in a browser; the SVS head must be
  SMALL (spectral frames, not tokens) or it ships desktop-only like the SFT.
- Quality below SUNO is expected at v1 — the product claim is "yours,
  local, editable", same as W3.
- Training is not bit-deterministic → the manifest regen flow applies.

## Consequences

- W2's prosody grid becomes the model's input contract — no new alignment
  work.
- The panel's SUNO MODE gains a "voice: yours / model" choice; both routes
  share the grid.
- If the owner gate disqualifies every candidate corpus, this ADR stays
  PROPOSED and W3 remains the vocal answer.
