# ADR 0020: ZENIT — composite mastering device (M1)

Date: 2026-10-06 · Status: Accepted · Scope: effects, MCP, docs

## Context

The DAW has no dedicated mastering PLUGIN: the mastering job lives in the
built-in master chain (ADR 0006 lineage: tape → M/S → bass mono → DC → match
EQ → tilt → glue → clipper → look-ahead limiter), which is fixed to the
master bus. That leaves three real gaps: stem mastering (no way to put the
mastering chain on a bus), presettable/versionable mastering moves, and an
insertable device for mixdown buses. Ozone-class suites solve this with a
module-based mastering plugin; the M1 proposal (2026-10-06) is to build ours
by COMPOSITION, not new DSP.

## Decision

**ZENIT** is a new first-party core effect (`EffectType "zenit"`, category
dynamics, primary Add surface) whose factory composes SIX existing audited
runtimes in a fixed chain:

    EQ → tape drive → glue compressor → utility (width/bass-mono) → clipper → look-ahead limiter

A FLAT macro surface (9 knobs: eqLow/eqMid/eqHigh/glue/drive/width/bassMono/
ceiling/limit) maps onto the sub-runtimes' canonical params. Every sub-effect
keeps its own degraded-path and status behavior — ZENIT aggregates `degraded`
honestly when any stage falls back. Target presets land via the normal
core-preset path (Streaming −14 LUFS / Club / Vinyl / Transparent); the
loudness target loop rides the EXISTING output-trim seam (`outputTrimDb`,
clamped −18…+12 dB) measured by the existing LUFS/true-peak meters —
`kyx_master` (MCP) exposes add/preset/trim/status over the same commands.

## Why NOT the flagship (vendored-core) treatment

The flagship pattern exists for vendored UPSTREAM cores (PRISM/VLYX/VØID/
MORPH): own worklet bundle, lazy loading, deep namespaced params, custom
panel. ZENIT v1 composes DSP that ALREADY rides the always-loaded core
bundle — a new worklet would be new DSP by another name, exactly what M1
promises not to do. The flat macro surface needs no deep param schema, and
the generic rack editor + presets + MCP surfaces cover the panel job.
Promotion to a flagship panel (M2: own maximizer algorithm, per-band imager,
dynamic EQ) stays open and would follow ADR 0014-style follow-up.

Stem EQ needs no code: a device on a group bus IS stem mastering — the host
position is the feature (Ozone must hack this through plugin routing; we are
the host).

## Consequences

- No new worklet, no loader/bundle changes, no golden-vector fixtures for a
  vendored core; composition behavior is pinned by `tests/zenit-composite.test.ts`
  (chain order, macro mapping incl. transparent-at-zero stages, degraded
  aggregation, teardown) and the existing fx-catalog/preset/coherence gates
  apply automatically.
- Sub-effect latency sums into the engine PDC via `getLatencySec`.
- Mastering into the fixed master chain stacks (bus ZENIT + master chain) —
  deliberate: the master chain's floor (DC, limiter ceiling) stays as the
  safety net; the panel copy points at the interplay.
- iZotope Ozone is the genre reference, not a spec: own names, own algorithms,
  no UI/asset reuse (trademark + patent hygiene).
