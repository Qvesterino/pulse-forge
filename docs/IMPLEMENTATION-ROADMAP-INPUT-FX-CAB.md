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

| Claim                          | Reality                                                                                                                                                                   | Source                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| "Recording is missing"         | Recording exists: PCM capture in bounded worklet blocks, device selection, input trim, alignment calibration, dry monitoring                                              | `src/audio-engine/PcmMicRecorder.ts`, `recordingInput.ts`, `latencyProbe.ts`, ADR 0014 lines 16–22          |
| "VØID can host a cab IR"       | Understated. VØID already loads user IRs and already has an upload UI                                                                                                     | `src/effects/ozvenaNode.ts` `loadUserIr()`, `ozvena-worklet.entry.js` `loadIr`, `src/ui/EffectRack.tsx:777` |
| "We need an input FX category" | **Correct.** `grep "inputFx\|preInsert\|inputChain\|ampTrack\|inputBus\|recordingChain"` over `src/` returns **zero matches**                                             | —                                                                                                           |
| "Monitoring is dry today"      | **Correct and deliberate.** `attachDryInputMonitor()` connects the source straight to `nodes.panner`, skipping `nodes.input`, documented as "avoids adding their latency" | `src/audio-engine/AudioEngine.ts:551-589`                                                                   |

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

This was the blocking question: _can the existing core run a cab in realtime?_

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

| IR length @48 kHz   | samples | `2·√n` | recommended | **actual (max with 2048)** | latency      |
| ------------------- | ------- | ------ | ----------- | -------------------------- | ------------ |
| 10 ms               | 480     | 43.8   | 64          | 2048                       | **21.33 ms** |
| 30 ms (typical cab) | 1440    | 75.9   | 128         | 2048                       | **21.33 ms** |
| 100 ms              | 4800    | 138.6  | 256         | 2048                       | **21.33 ms** |
| 1 s (reverb)        | 48000   | 438.2  | 512         | 2048                       | **21.33 ms** |

The heuristic itself is healthy — it would pick 128 for a 30 ms cab IR
(1.33 ms). The value is simply overridden before it is ever used.

### Reading

- The problem is real and the default is the cause. **The fix is a constructor
  argument, not new DSP.**
- Latency is **independent of IR length today**, which is why this has never
  surfaced as a "cab problem" — VØID is a reverb and 21 ms of convolution
  latency is unremarkable for a reverb tail.
- Lowering the floor helps **reverb too** (1 s IR → 5.33 ms instead of 21.33 ms),
  so the change is not a guitar-only trade.

### Spike result — measured 2026-10-11

`tests/ozvena-cab-latency-spike.test.ts` — 8/8 green.

| Question                                        | Answer                                                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What does the floor do today?                   | Pinned at 2048 → 1024 samples → **21.33 ms**, identical for a 10 ms and a 1 s IR                                                                                                                                         |
| What does a low floor give a 30 ms cab IR?      | 128 → 64 samples → **1.33 ms**                                                                                                                                                                                           |
| Does the low floor still escalate for long IRs? | Yes — a 1 s IR escalates to 256 samples (5.33 ms) instead of silently degrading                                                                                                                                          |
| **Does partition size change the sound?**       | **No.** Best-aligning lag = **960 samples = exactly 20.000 ms**, which is precisely `1024 − 64`. Mean residual `1.937e-10` against a peak of `5.873e-2` — a relative error of **3.3e-9**, i.e. double-precision roundoff |
| What does it cost?                              | Realtime factor **0.013x at 2048, 0.015x at 128, 0.021x at 64** — the 128 floor costs **1.19x**, i.e. +19 % on a base that is already 1.5 % of one core                                                                  |

Two findings matter here.

**The first attempt failed and that is why this is trustworthy.** The naive
assertion "outputs match sample-for-sample" failed with a residual of 0.0866 —
because two partition sizes carry different latency, so a naive comparison
measures the _offset_, not the fidelity. The spike only proved what it proves
because it went looking for the offset instead of relaxing the threshold. A
green test here would have meant nothing.

**The CPU risk in the first draft of this document was overstated.** More
partitions for the same IR is real, but +19 % on 1.5 % of a core is not a risk
worth gating a phase on. The genuine risks are elsewhere (§5).

---

## 1a. Reference hardware — identified, not assumed

`docs/WINDOWS-AUDIO-SPIKE-2026-09.md` already records the declared endpoint, so
this does not need to be guessed:

| Property                 | Value                                                                  |
| ------------------------ | ---------------------------------------------------------------------- |
| Device                   | **Universal Audio Volt 276** (`INPUT 1/2`, `MONITOR L/R`)              |
| ASIO                     | `Universal Audio Volt` registered in `HKLM\SOFTWARE\ASIO`              |
| Format                   | 48 kHz, 2-channel, 32-bit float                                        |
| WASAPI shared period     | 480 frames / **10 ms** (min = default = max)                           |
| WASAPI exclusive minimum | 144 frames / **3 ms**                                                  |
| Exclusive stream status  | probe loaded metadata only; duplex, channel map and stability untested |

### Projected latency (NOT measured — read this before quoting it)

The spike document is explicit that these are _endpoint stream latencies_, not
measured round trips. The table below is arithmetic on those numbers, and every
row needs an owner-measured `measureAudioRoundTrip()` run before it is claimed
anywhere.

| Path                               | Device round trip | Convolution | Total      | Playable unboxed? |
| ---------------------------------- | ----------------- | ----------- | ---------- | ----------------- |
| Web / WASAPI shared, today         | ~20 ms            | 21.33 ms    | **~41 ms** | No                |
| Web / WASAPI shared, 128 floor     | ~20 ms            | 1.33 ms     | **~21 ms** | Marginal          |
| Studio / ASIO exclusive, 128 floor | ~6 ms             | 1.33 ms     | **~7 ms**  | Yes               |

The reference device already does the hard part: its exclusive mode offers 3 ms
periods. **Low-latency guitar play is a Studio+ASIO story.** Web stays a
first-class recording and editing path with measured latency disclosed, which is
what ADR 0014 §2 requires — not a promise of playable monitoring.

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

ADR 0014 line 69: _"Recording remains raw, recoverable audio until the user
chooses processing or commit."_

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

### Phase 2 — F0 verification in the test harness — **DONE 2026-10-11**

- [x] Golden test: `getLatencySamples()` for a 30 ms IR at 48 kHz, asserting the
      value actually used, not the recommended one.
- [x] Prove the low floor lowers latency without changing the signal
      (`tests/ozvena-cab-latency-spike.test.ts`, 8 specs).
- [x] Measure the CPU ratio: 128 floor costs 1.19x over 2048.
- [ ] Re-run `tests/ozvena-ir-spectra.test.ts` when a floor value is actually
      changed — deliberately not done during the spike, since the spike changed
      no product code.

**Exit:** the latency number in §1 is pinned by a test that fails today. **Met.**
The next person to lower the floor starts from evidence, not from this document.

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

- [ ] **Eight genre cabinets** (owner decision, 2026-10-11): eight specific
      characters rather than three generic ones.
- [ ] CC0 or synthesized cabinets; record the license per file.
- [ ] Do not ship any IR whose redistribution terms are unclear.
- [ ] Genre set must be an explicit named list in the ADR, so "eight" is a
      decidable acceptance condition rather than a number.
- [ ] User upload path stays available and stays the escape hatch.

**Exit:** a first-run user gets a usable cab without hunting for a file, and
every shipped IR has a recorded license.

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

| Risk                                                                      | Why it is real                                                                                                       | Mitigation                                                                                                                                    |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rebuilding VØID's live latency is a shared change, not a CAB-only one** | Lowering the floor changes reverb latency for every existing project. It is a behavioural change to a shipped effect | Spike shows output is bit-equivalent after alignment; Phase 2 pins the value and Phase 4 confirms render parity before any floor change lands |
| `baked` silently destroys double-tracking                                 | ADR 0014 §3 exists precisely to prevent this                                                                         | Raw take is retained regardless of mode; Phase 1 ADR decides                                                                                  |
| Browser latency makes it unplayable unboxed                               | ~20 ms device round trip on WASAPI shared, before any DSP                                                            | Measured and disclosed; Studio + ASIO exclusive (~3 ms) is the low-latency target                                                             |
| An input chain that only exists live                                      | Would break render parity                                                                                            | Phase 4 exit condition is an export that matches playback                                                                                     |
| Licenses                                                                  | AGPL competition cannot be vendored                                                                                  | Phase 1 ships only self-made or CC0 assets                                                                                                    |
| A second recording semantics leaks into the model                         | Raw/baked is genuinely two contracts                                                                                 | One model, explicit commit points — not two recorders                                                                                         |
| Latency claims outrun the evidence                                        | The §1a table is arithmetic, not measurement                                                                         | Owner gate in Phase 7; nothing is quoted as a number until `measureAudioRoundTrip()` runs on the Volt 276                                     |

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

## 7. Decisions taken, and what is still open

**Decided by the owner, 2026-10-11:**

1. **Spike before ADR.** Done — §1. The ADR now has measured evidence in hand
   rather than an argument.
2. **Reference hardware: Universal Audio Volt 276.** Already recorded in
   `WINDOWS-AUDIO-SPIKE-2026-09.md`; the device needs connecting when the
   hardware gate runs, not a new selection.
3. **Eight genre cabinets**, not three generic ones (Phase 5).

**Still open — needed before Phase 4 can start:**

1. **The named eight.** "Eight genre cabinets" is only a decidable acceptance
   condition once the eight are listed. Proposed starting set for discussion:
   clean-ish combo, bright combo, vintage British, tweed, modern high-gain,
   metal tight, bass 4x10, bass 8x10. The bassist half matters more than the
   guitarist half — a bass DI through a guitar cab is one of the most common
   first-run mistakes, and this is the insert chain's chance to prevent it.
2. **ADR number.** `0015` is taken by `0015-live-take-lane-audition.md`, which
   is adjacent to this work and must be read before a new ADR is drafted — it
   may already own part of the live-monitoring contract. Separately, `0035` and
   `0036` are each used twice in `docs/adr/`, so the numbering already has
   collisions that should not be repeated.
3. **When the Volt 276 gets connected.** Phases 6–7 cannot be evidence-backed
   until it does. Everything above is software-only evidence.
