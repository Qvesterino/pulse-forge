# MIXER — Functionality, Routing & Signal-Flow Verification

**Date:** 2026-09-30
**Scope:** DAW mixer — channel lifecycle, track→mixer routing, buses/groups, sends,
returns, master, gain/pan/mute/solo, metering, automation, live routing changes,
persistence and undo.
**Method:** source trace of the real audio graph in `src/audio-engine/` plus a
Web-Audio-semantics mock context that models directional per-node edges, so
graph topology is asserted rather than assumed. Not a UI inspection.

---

## 1. The signal path as actually built

Per **track** (`AudioEngine.syncProject`, track node construction):

```
instrument / sample / frozen buffer / generative source
  → input → panner → gain → modAutoGain → modAutoPan → modMacroGain → modMacroPan
                                                                  ├→ masterChain.input
                                                                  ├→ analyser   (channel meter)
                                                                  └→ per-send tap → sendGain → sendDelay → return.input
```

Per **group/bus**: `input → panner → gain → modAutoGain → modAutoPan → modMacroGain
→ modMacroPan → { master, analyser, send taps }`.

Per **return**: `input → gain → modAutoGain → modMacroGain → analyser → masterChain.input`.

**Group routing** is a re-parenting of the track's terminal edge, not a separate path
(`routeDestination`): a child track's `modMacroPan` is disconnected from its exact
previous destination and reconnected to its group's `input`, or to the master when the
track has no group / the group was deleted. Groups are never re-parented themselves,
so **nested groups are not supported** (a group feeding another group is not a
reachable routing state — see §5).

**Master** is a fixed chain in `src/audio-engine/masterChain.ts`:
`master gain (+ loudnessTrimDb) → tape → M/S → bass-mono → DC block → match EQ → tilt
→ clipper → limiter → K-weight meter → destination`.

Ordering notes that are correct and worth pinning: returns are created **before**
groups and tracks in `syncProject`, because `syncSends()` only wires sends whose
return node already exists (otherwise a first sync after load silently dropped group
sends); FX sidechains are synced **after** all source nodes exist, so a track appearing
after its compressor target in document order still resolves.

---

## 2. Verified working mixer paths

| Area                  | Evidence                                                                                                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gain → audio          | `nodes.gain.gain.setTargetAtTime(...)`; solo/mute gate applied at the same node (`solo.audible(id) ? gain : 0`) — the fader is the actual DSP node, not a UI-only value                                                                                                                                     |
| Pan → audio           | `panner.pan.setTargetAtTime(track.pan, …)`, clamped to [-1, 1] in schema                                                                                                                                                                                                                                    |
| Mute                  | Zeroes the channel gain node; group mute silences members via `soloAudibility` **without** rewriting member state                                                                                                                                                                                           |
| Solo                  | `soloAudibility()`: any solo mutes unsoloed material; a group is audible when it _or any member_ is soloed; a member is audible when it _or its group_ is soloed                                                                                                                                            |
| Multiple solos        | Union semantics via `soloedGroups` / `groupsWithSoloedChild`, pinned directly: two groups soloed at once, a soloed child in each group, a group plus a loose child, releasing one of two solos, and a group mute under a simultaneous solo elsewhere (`tests/groupTracks.test.ts`, 5 cases added this pass) |
| Channel destroy       | `disposeTrackNodes` disconnects every node it owns, unsubscribes latency observers, disposes FX runtimes, disposes the frozen buffer source, and drops `fxMetersEnabled` entries                                                                                                                            |
| Return destroy        | `disposeReturnNodes` tears the return chain and its FX runtimes                                                                                                                                                                                                                                             |
| Gain clamping         | `[0, 1.5]` at **three** independent layers: command (`setTrackParams`/`setReturnGain`/`setTrackSend`), schema read-normalizer, and engine write. Non-finite values are healed, not passed to `setTargetAtTime`                                                                                              |
| Pan clamping          | `[-1, 1]`, same triple-layer discipline                                                                                                                                                                                                                                                                     |
| Send level            | `[0, 1.5]`; the mixer fader (max 1.5), the "type a value" prompt, `setTrackSend`, and the schema normalizer all agree                                                                                                                                                                                       |
| Metering source       | `MeteringRig.getTrackMeterSnapshot` reads the **channel's own analyser** (post-fader, post-pan) with a group fallback — so a fader move is visible on its own strip. Returns meter from their own return analyser. Correct source, no cross-wiring                                                          |
| Peak / clip           | `peakDb: toDb(peak)`, `clipping: peak >= 0.9995`                                                                                                                                                                                                                                                            |
| dB readouts           | `gainDbLabel` uses `20·log10` with a −60 dB floor reading `-INF`; fader is linear, engine value is linear — UI and engine agree                                                                                                                                                                             |
| Sends while playing   | `syncSends` is called from `syncProject`, which runs on every document sync; per-send gain is ramped with `setTargetAtTime(…, 0.01)` (no zipper clicks)                                                                                                                                                     |
| Routing while playing | Group re-parenting is edge-swap on the terminal node; unchanged routes are skipped, so steady-state sync does not churn the graph                                                                                                                                                                           |
| Automation            | Track gain/pan/sends and master params are addressable targets and land on the same `AudioParam`s the mixer faders write                                                                                                                                                                                    |
| Undo                  | Mixer writes are commands (`setTrackParams`, `setGroupMute`, `setTrackSend`, `clearAllSolos`, …); an identical-value commit is a no-op (no undo entry, doc identity preserved)                                                                                                                              |
| Persistence           | Round-trip verified: extreme faders, mute/solo, group membership, per-track sends, return gains and the full master block survive `ProjectRepository` save/load unchanged                                                                                                                                   |
| PDC                   | Per-track and per-send compensation delays exist; the bare-chain signature (`""`) still builds a pass-through chain, which is what makes an effect-free channel route at all                                                                                                                                |

---

## 3. Repaired defect

### D-1 — Send-tap nodes leaked on every send off/on cycle (confirmed, fixed)

**Root cause.** A send is a _two-edge_ tap:

```
modMacroPan ──▶ sendGain ──▶ sendDelay ──▶ return.input
```

The per-send removal path in `syncSends()` disconnected only the send's **own output**
(`sendGain.disconnect()`) and its delay. Web Audio's `disconnect()` severs only edges
**leaving** the node it is called on, so the upstream `modMacroPan → sendGain` edge
survived. The tap node was never collected and stayed in the live graph.

Full-channel teardown was never affected — `disposeTrackNodes` / `disposeGroupNodes`
call `modMacroPan.disconnect()` with no argument, dropping all outgoing edges — which
is exactly why this hid: deleting a track was clean, **switching a send off was not**.

**Measured impact.** Regression harness counts edges on the channel output across five
off/on cycles: **3 edges → 8 edges**, one orphaned `GainNode` + `DelayNode` pair per
cycle. Real-world: every send toggle on every track and every bus left permanent audio
nodes behind and stacked extra send contributions into the return bus. Group sends
leaked identically.

**Fix** (`src/audio-engine/AudioEngine.ts`, `syncSends`) — drop the upstream edge
explicitly before releasing the node:

```ts
try {
  nodes.modMacroPan.disconnect(sendGain);
} catch {
  /* prior edge was already disconnected */
}
sendGain.disconnect();
```

**Regression coverage:** `tests/mixer-send-leak.test.ts` (new, 4 cases) — single
removal, five-cycle accumulation, the group/bus path, and a guard that full channel
teardown still leaves zero edges. Fails on the pre-fix engine (measured 8 ≠ 3), passes
after.

---

## 4. Pre-existing failures (NOT caused by this work)

`tests/master-finish.test.ts` (2) and `tests/reliability-hardening.test.ts` (1) fail on
the current tree. Verified by stashing the mixer fix and re-running: **identical 3
failures**, so they are pre-existing and outside the mixer signal path.

- `master finish chain` — "builds a fixed 12 Hz DC blocker ahead of the glue"; "native
  fallback follows the GLUE toggle (threshold/ratio park when off)".
- `reliability-hardening` — source-grep pin: "`previewAssetSynced` tracks its source as
  a preview voice (cancellable by `stopPreview`/panic)".

These are master-chain and preview-asset concerns, not mixer routing. They are recorded
here rather than fixed, to keep this pass scoped.

---

## 5. Unsupported / incomplete routing

- **Nested groups are not supported.** Groups never carry a `groupId` and are never
  re-parented, so "group → group" is not a reachable state. `addToGroup` only accepts
  non-group members. A group can send to a return, which is the supported way to
  cascade bus processing.
- **Sends are post-fader.** The tap is on `modMacroPan`, after gain and pan, so
  muting a track also silences its sends. This is conventional but it means a send is
  not an independent pre-fader feed.
- **Returns have no mute/solo** — only a gain (and their own FX chain). A return is
  always audible if fed.
- **Channel enable/disable** has no separate representation: a channel is enabled by
  default, and "disabled" is expressed as `mute` (or solo-gated). There is no separate
  bypass flag to persist.
- **Automation lanes interpolate on a 16th-note grid** (documented in the plugin audit);
  continuous device/track lanes are expanded before the engine writes them.

---

## 6. Remaining risks

1. **Graph-topology coverage is mock-based.** The regression harness models Web Audio
   edge semantics, which caught a real leak, but it cannot prove DSP output. The
   audible half of the send path still rests on the `runChecks()` browser gates
   ("mixer preview: send preview drives the real return-bus path").
2. **Return-side meter/edge symmetry** is only pinned for tracks. Return gain clamping
   is triple-layer like the rest, but return _removal while a send is live_ relies on
   `syncSends` re-filtering `live` by `returnNodes.has(...)` — correct in the trace, not
   separately regression-pinned.
3. **Group→master re-parenting on group delete** is covered by
   `tests/send-pdc.test.ts` for the edge swap; the "member audibility after its group
   disappears" path is reasoned from `soloAudibility` but not separately pinned.
4. `docs/CURRENT-STATE.md` counts remain the only source of truth for numbers; the
   spec count moved by exactly +1 (the new regression file).

---

## 7. Recommended next tests

1. A real-browser gate asserting **return deletion while a track send is live** drops
   the send tap edge count (the one mixer path still mock-only).
2. ~~A `soloAudibility` table test over group/target combinations~~ — **done this pass**
   (single-solo cases already existed in `tests/groupTracks.test.ts`; the five
   multiple-solo combinations were added).
3. Offline-render parity for the send leak: a doc rendered before and after a send
   off/on cycle should be sample-identical (the leak adds a silent-but-live tap, so the
   render is unaffected — worth pinning so the invariant is explicit).
4. Extend `mixer-send-leak.test.ts` to the frozen-track and generative-track branches,
   which share `syncSends`.
5. Pin "member audibility after its group is deleted" (risk 3 above) — a `soloAudibility`
   case where a member's `groupId` points at a track that no longer exists.
