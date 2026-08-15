# ADR 0005 — Rust/WASM DSP policy

Date: 2026-08-15
Status: Accepted (deferred)

Rust/WASM is optional, not foundational. Simple DSP starts as TypeScript/native nodes; WASM is introduced only behind a DSP adapter boundary when a processor genuinely needs it (oversampled clipping, advanced reverb, granular). The JS/WASM boundary must stay coarse-grained (block processing, never per-sample calls). No WASM code exists in the initial slice.
