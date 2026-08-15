# ADR 0004 — AudioWorklet boundary

Date: 2026-08-15
Status: Accepted (infrastructure deferred)

Custom realtime DSP belongs in AudioWorklet, never on the main thread. The initial slice uses only native Web Audio nodes (sources, gains, panners), so no worklet is required yet. When the first custom processor (saturation, clipper, pump) is built, it must go through the worklet lifecycle (registration, message passing, disposal) and the DSP interface defined in ARCHITECTURE.md §28.

Consequence: no worklet code exists yet by design; the engine is structured so processors attach behind a common runtime contract.
