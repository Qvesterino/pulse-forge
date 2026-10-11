# KYX input-FX / CAB link — implementation roadmap

**Status:** proposed (waiting on ADR 0015)
**Charter:** [`adr/0014-full-daw-scope.md`](adr/0014-full-daw-scope.md) §3 recording contract
**Baseline:** [`ROADMAP-FULL-DAW.md`](ROADMAP-FULL-DAW.md) Phase 3/4, [`AUDIO-INPUT-HARDWARE-QA.md`](AUDIO-INPUT-HARDWARE-QA.md)
**Measured:** 2026-10-11, code reading against the working tree at that date
**Owner decisions recorded:** input-insert mode is a per-track switch; phase 1 is
CAB only; cabinet IRs are CC0/self-synthesized plus user upload; both Web and
Studio ship, with measured latency disclosed in the UI.

This is a staged plan, not a shipping claim. Every phase below has an exit
condition that can fail. Nothing here is "done" until its project contract, UI,
tests and — where hardware is involved — measured evidence all agree.

---

## 0. What the measurement actually found

The initial framing of this work was "add an amp/cab category for recording".
Four code readings on 2026-10-11 changed that. Each row is a file, not an opinion.

| Claim | Reality | Source |
| --- | --- | --- |
| "Recording is missing" | Recording exists: PCM capture in bounded worklet blocks, device selection, input trim, alignment calibration, dry monitoring | `src/audio-engine/PcmMicRecorder.ts`, `recordingInput.ts`, `latencyProbe.ts`, ADR 0014 lines 16–22 |
| "VØID can host a cab IR" | Understated. VØID already loads user IRs and already has an upload UI | `src/effects/ozvenaNode.ts` `loadUserIr()`, `ozvena-worklet.entry.js` `loadIr`, `src/ui/EffectRack.tsx:777` |
| "We need an input FX category" | **Correct.** `grep "inputFx\|preInsert\|inputChain\|ampTrack\|inputBus\|recordingChain"` over `src/` returns **zero matches** | — |
| "Monitoring is dry today" | **Correct and deliberate.** `attachDryInputMonitor()` connects the source straight to `nodes.panner`, skipping `nodes.input`, documented as "avoids adding their latency" | `src/audio-engine/AudioEngine.ts:551-589` |

**The real gap is one insert point in the audio graph, not a missing effect
category.** `nodes.input` is already a real connection point — the generative
source path uses it (`setGenerativeSourceConnection`, AudioEngine.ts:591-615).

### Also already shipped (do not rebuild)

ADR 0018 records a framed PCM pipe transport with an **ASIO streaming host**
(`native/asio-host/asio-host.cpp`), acceptance-tested against the SDK's own
64-bit fixture driver, plus an SPSC `SharedArrayBuffer` ring and desktop IPC
wiring. The open item there is real-hardware soak, not existence. That matters
for this roadmap: the low-latency Studio input path has a foundation already.

---

## 1. F0 — convolution latency (measured, 2026-10-11)

This was the blocking question: *can the existing core run a cab in realtime?*

`src/effects/ozvena-core/dsp/fftPartitioned.ts:671`

```ts
export function recommendPartitionSize(irLength: number): number {
  const target = Math.max(64, Math.round(2 * Math.sqrt(irLength)));
  return nextPow2(target);
}
```

Latency is `partitionSize / 2` (`convolutionEngine.ts:679`). But `loadIr` takes
`Math.max(partitionSize, recommendPartitionSize(irLengthSamples))`
(`convolutionEngine.ts:445`) — the configured value is a **floor**, never
lowered. And `src/effects/ozvena-core/core/ozvenaProcessor.ts:321` constructs
the engine with **no argument**, so `partitionSize` is the default `2048`.

### Consequence: the partition is pinned at 2048 today

| IR length @48 kHz | samples | `2·√n` | recommended | **actual (max with 2048)** | latency |
| --- | --- | --- | --- | --- | --- |
| 10 ms | 480 | 43.8 | 64 | 2048 | **21.33 ms** |
| 30 ms (typical cab) | 1440 | 75.9 | 128 | 2048 | **21.33 ms** |
| 100 ms | 4800 | 138.6 | 256 | 2048 | **21.33 ms** |
| 1 s (reverb) | 48000 | 438.2 | 512 | 2048 | **21.33 ms** |

The heuristic itself is healthy — it would pick 128 for a 30 ms cab IR
(1.33 ms). The value is simply overridden before it is ever used.

### Reading

- The problem is real and the default is the cause. **The fix is a constructor
  argument, not new DSP.**
- Latency is **independent of IR length today**, which is why this has never
  surfaced as a "cab problem" — VØID is a reverb and 21 ms of convolution
  latency is unremarkable for a reverb tail.
- Playability threshold for an unboxed guitar is roughly 15–20 ms round trip.
  21.33 ms of DSP alone puts a browser path out of reach before device latency
  is even counted.
- Lowering the floor helps **reverb too** (1 s IR → 5.33 ms instead of 21.33 ms),
  so the change is not a guitar-only trade. It must still be measured for CPU
  and for the existing golden-vector IR spectra tests.

---

## 2. Scope

**In scope for phase 1:** cabinet simulation only.

- Input insert point in the track audio graph.
- CAB processing built on the VØID convolution core with an enforced low-latency
  partition configuration.
- Factory cabinet IRs that are CC0 or self-synthesized, plus the existing user
  upload path.
- Measured latency surfaced in the UI for both Web and Studio.

**Explicitly out of scope (phase 2, needs its own ADR):** amp modelling.

Licensing was checked on 2026-10-11 and it is favourable: NAM A2 is fully
MIT-licensed including commercial use (github.com/sdatkinson/neural-amp-modeler,
confirmed by TONE3000). The competing open-source amp/cab plugins — OrbitCab,
Nave, AmpForge, Soundshed Guitar — are AGPL-3.0/GPL-3.0, so their code cannot be
vendored into KYX. **Any NAM capture file carries its own license** and must be
treated as a separate question from the engine's license. The AGPL finding also
means "just vendor an existing cab plugin" is not available.

---

## 3. Architecture

```
audio input device
      │
      ├──► [ PcmMicRecorder ] ──────────────────────► raw PCM take (always)
      │
      ▼
  TrackInputInsert (NEW)
      │   mode: "raw"   → monitoring only; the stored take stays raw
      │   mode: "baked" → the post-insert signal is what gets committed
      ▼
  nodes.input ─────────────────────────► track FX ──► panner ──► master
```

`attachDryInputMonitor` currently jumps from source to `nodes.panner`. Phase 2
routes source → insert chain → `nodes.input` instead. `setGenerativeSourceConnection`
already treats `nodes.input` as the legitimate entry point, so this follows an
existing pattern rather than inventing one.

### The invariant this costs us

ADR 0014 line 69: *"Recording remains raw, recoverable audio until the user
chooses processing or commit."*

The `baked` mode relaxes this. That is a deliberate, owner-approved departure and
it is why phase 1 below is the ADR, not the code. `baked` must retain the raw
take alongside the processed one — otherwise the `raw`/`baked` switch destroys
the double-tracking that is the entire reason to keep a raw take.

---

## 4. Phases

### Phase 1 — ADR 0015 (architecture, no code)

- [ ] Record the `TrackInputInsert` model and where it sits in the graph.
- [ ] State precisely how `baked` relaxes ADR 0014 §3 and what `raw` keeps.
- [ ] Define PDC/latency compensation obligations for the insert chain.
- [ ] Define what "committed" means for each mode (undo, recovery, crash).
- [ ] Decide whether insert-chain state is project state or device state — this
      interacts with ADR 0006 device-state-slot.

**Exit:** the model, both modes and their recovery contracts are written down
and the owner has signed it. If this phase produces disagreement, phases 2–7 do
not start.

### Phase 2 — F0 verification in the test harness

- [ ] Golden test: `getLatencySamples()` for a 30 ms IR at 48 kHz, asserting the
      value actually used, not the recommended one.
- [ ] CPU soak: low-partition convolution under load, heap growth and drift
      bounded by the existing plugin soak criteria (≤6 MB, ≤0.003 dB).
- [ ] Re-run `tests/ozvena-ir-spectra.test.ts` against any floor change.

**Exit:** the latency number in §1 is pinned by a test that fails today.

### Phase 3 — `TrackInputInsert` in the project model

- [ ] `SCHEMA_VERSION` 6 → 7 with a migration in `migrateProject`.
- [ ] Command-based mutation with full undo, per ADR 0014 §6.
- [ ] Loading code rejects unknown future versions.

**Exit:** a project round-trips through IndexedDB with the insert intact, and
unknown versions are refused.

### Phase 4 — CAB processor

- [ ] New effect over the VØID core with an enforced partition cap.
- [ ] Bypass, input trim, output trim, mix, A/B cab slots.
- [ ] Latency reported by the node, not inferred by the UI.
- [ ] Live/offline render parity verified through `src/rendering/renderer.ts`.

**Exit:** the same engine drives both paths and an export sounds like playback.

### Phase 5 — Factory cabinet IRs

- [ ] CC0 or synthesized cabinets; record the license per file.
- [ ] Do not ship any IR whose redistribution terms are unclear.
- [ ] User upload path stays available and stays the escape hatch.

**Exit:** a first-run user gets a usable cab without hunting for a file.

### Phase 6 — UI and latency disclosure

- [ ] Insert slot in the track inspector / effect rack.
- [ ] `raw` / `baked` switch with the consequence stated in the UI, not implied.
- [ ] Measured input-to-output latency shown for the current device — ADR 0014 §2
      requires the UI to disclose actual settings and not overpromise.
- [ ] Extend `AUDIO-INPUT-HARDWARE-QA.md` with an input-insert pass.

**Exit:** the support matrix carries real measured numbers, not estimates.

### Phase 7 — Hardware gate (owner)

- [ ] Physical interface, guitar through Hi-Z or DI, on both declared hosts.
- [ ] Latency recorded in the `AUDIO-INPUT-HARDWARE-QA.md` test record.
- [ ] Playability judgment recorded with the number next to it.

**Exit:** an owner-signed record exists. Until then the feature is not claimed
as low-latency anywhere — not in README, not in the store listing.

---

## 5. Risks

| Risk | Why it is real | Mitigation |
| --- | --- | --- |
| Lowering the partition floor raises CPU | More partitions for the same IR | Phase 2 soak gates it; reverb benefit may pay for it |
| `baked` silently destroys double-tracking | ADR 0014 §3 exists precisely to prevent this | Raw take is retained regardless of mode; Phase 1 ADR decides |
| Browser latency makes it unplayable unboxed | Already ~10–20 ms before any FX | Measure and disclose; Studio + ASIO is the low-latency target |
| An input chain that only exists live | Would break render parity | Phase 4 exit condition is an export that matches playback |
| Licenses | AGPL competition cannot be vendored | Phase 1 ships only self-made or CC0 assets |
| A second recording semantics leaks into the model | Raw/baked is genuinely two contracts | One model, explicit commit points — not two recorders |

---

## 6. Invariants this work must not break

1. **UI describes intent, project model stores truth** (AGENTS.md §3.1). The
   `raw`/`baked` switch is a command, not React state.
2. **One engine for live and offline** (§3.3). The insert chain is built by the
   same code path in both, or it does not ship.
3. **`useContext(ctx)` is the only path that creates AudioNodes** (§7). The
   insert chain builds nodes through the engine, never raw `ctx.createGain()`.
4. **Realtime DSP stays in an AudioWorklet** (§3.5). No convolution on the main
   thread; lazy load so a beat that never touches CAB doesn't pay for it.
5. **Schema changes bump `SCHEMA_VERSION`** (§7) and add a migration.
6. **No roadmap capability is described as shipped** (ADR 0014 §1).
7. **Counts in `docs/CURRENT-STATE.md` are updated in the same commit** when
   the effect and flagship counts change.

---

## 7. Open questions for the owner

1. **Phase ordering.** ADR before code (slow, safe) or a spike first to prove the
   partition change in isolation, then ADR with evidence in hand?
2. **Reference hardware.** `ROADMAP-FULL-DAW.md` Phase 0 still has an unchecked
   "owner-approved Studio support matrix" item. Phase 7 cannot pass without it.
   Which interface is the declared reference?
3. **Factory cab count.** Three generic cabinets is a smaller surface than eight
   genre-specific ones. Which does the first release need?