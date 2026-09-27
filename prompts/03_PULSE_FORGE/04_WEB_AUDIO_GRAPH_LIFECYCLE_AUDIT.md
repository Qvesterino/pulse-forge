# Pulse Forge Web Audio Graph Lifecycle Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 03_PULSE_FORGE/04_WEB_AUDIO_GRAPH_LIFECYCLE_AUDIT.md`

## Pulse Forge mission

Audit creation, connection, disconnection, reuse, and disposal of every AudioNode and AudioWorkletNode.

Look for duplicated connections, dangling nodes, orphan oscillators, retained buffers, reconnect amplification, effect chains that survive deletion, duplicated master paths, worklet leaks, object URL leaks, and schedulers retaining destroyed tracks.

Exercise repeated track/effect creation and deletion, reorder operations, bypass toggles, project reload, undo/redo, preset switching, and engine reset. Detect monotonic graph/resource growth and fix ownership/cleanup defects.
