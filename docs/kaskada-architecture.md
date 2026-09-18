# KYX Kaskáda — Architecture (Pulse Forge)

> **Internal codename:** `kaskada`
> **Concept:** character delay engine + optional adaptive unmask, adapted
> from the VocalForge Kaskáda architecture for the Pulse Forge browser DAW.
> iZotope Cascadia is a trademark of iZotope, Inc. We borrow the workflow
> concept only — all DSP, presets and visuals are original work.

---

## 1. What this is (and isn't)

A **flagship stereo delay** as an AudioWorklet effect in the Pulse Forge
plugin rack — replacing the current bare-bones native-node Delay.

Insert workflow: the dry always passes at unity; `MIX` is the gain of
the internal delay bus (0 % = −∞, 50 % = −6 dB, 100 % = 0 dB). A dedicated
SOLO WET / send-return mode was considered for Phase 1 and descoped —
see §8.

**Not in Phase 1:** unmask solver, reverse mode, dual spectrum display,
delta listen, solo wet. These are Phase 2 items (see §8).

---

## 2. Signal Flow

```
Input (L,R) ─► Input Gain ─► DC-Block HP ─┬──────────────────────────► dry ─┐
                                          │                                  │
                                          ▼                                  │
                               ┌── Delay Line (L,R) ◄─────────────┐         │
                               │  fractional read (hermite)       │         │
                               │  free ms | syncNote × tempo      │         │
                               │  mod LFO (depth/rate → drift)    │         │
                               │  ping-pong: L↔R crossfeed        │         │
                               └──────────────┬───────────────────┘         │
                                              ▼                              │
                                   Character (feedback loop)                 │
                                   digital | tape | analog                   │
                                              ▼                              │
                                   Loop EQ: LowCut + HighCut (24 dB/oct)     │
                                              │                              │
                                    feedback gain ◄────┘                     │
                                              ▼                              │
                                    Width (M/S spread on wet)                │
                                              ▼                              │
                                  Delay Amount (bus gain) ──► Σ ◄───────────┘
                                                                │
                                          soloWet opens the Σ dry arm          │
                                                                ▼
                                                    Output Gain ─► Output
```

---

## 3. Engine Topology

### 3.1 Delay line

- **Stereo, fractional read** with cubic-hermite interpolation —
  continuous under time automation and modulation (no clicks, no buffer
  reallocation).
- **Max delay:** 2000 ms. Sync values that resolve above the max clamp
  to 2000 ms. The ring buffer is sized from the context sample rate:
  `ceil(2000 ms · sr) + 1` frames (≈ 96 k frames at 48 kHz).
- **Ping-Pong:** feedback crosses L↔R (left input feeds the right write
  and vice versa). Width still applies after the crossfeed.

### 3.2 Character (feedback-loop colour)

| Value | Name      | Behaviour                                                                                                             |
| ----- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| 0     | `digital` | Clean loop — only the loop EQ acts.                                                                                   |
| 1     | `tape`    | HF loss per repeat + subtle fixed wow (two slow per-channel LFOs at 0.7 Hz, ±0.5 ms ≈ ±2 cents — independent of MOD). |
| 2     | `analog`  | Dark bucket-brigade; progressively darkening repeats.                                                                 |

### 3.3 Modulation (pitch drift)

Single LFO on delay time: `MOD DEPTH` (0–100 %) scales drift in
milliseconds, `MOD RATE` (0.01–10 Hz) sets speed. Implemented as
modulation of the fractional read position — classic tape/BBD pitch
drift, click-free by construction.

### 3.4 Loop EQ

- **Low Cut:** 20 – 2000 Hz, 24 dB/oct (cascaded biquad HP).
- **High Cut:** 1000 – 20000 Hz, 24 dB/oct (cascaded biquad LP).
- Both act on the **wet signal** (the read feeds the loop and the output
  alike), so the first repeat is already coloured and the tail darkens
  further with each pass. A feedback-path-only variant (bright first slap)
  was considered and deliberately not built — Phase 1 keeps one shared
  chain; revisit in Phase 2 if the vocal-delay shape is wanted.

### 3.5 Tempo sync

- `SYNC` switches `TIME` between free ms and note values from the
  shared house set (1/4, 1/8, 1/8T, 1/16, 1/16T, dotted 1/8).
- **Transport plumbing:** the worklet receives `bpm` as a parameter
  (`setEffectiveBpm` from Wave 1); the registry resolves
  `syncNote × bpm` → delay time ms.

### 3.6 Drive (saturation in the feedback loop)

Tanh-based soft saturation applied inside the feedback path.
`DRIVE` (0–100 %) scales the amount — 0 = clean, 100 = aggressive
harmonic enrichment on each repeat.

Normalised for **unity small-signal gain** (`tanh(x·g)/g`): every element
of the loop chain is contractive, so the loop gain never exceeds FEEDBK at
any amplitude — no self-oscillation at any preset. Loud peaks compress
down; make up with LEVEL.

### 3.7 Unmask solver (32-band adaptive spectral ducking)

Port of the VocalForge Kaskáda M3 solver (Ultina masking pattern,
inverted): **reference = the DRY input, target = the DELAY bus output** —
the delay ducks under the dry wherever the dry dominates, and rings free
wherever the dry is silent (the point of a delay).

- **Analysis:** 32 log-spaced bandpass biquads (40 Hz–16 kHz, Q 3.0) +
  envelope followers (5 ms TC) on the MONO-sumMED dry and delay signals,
  every sample (ms-scale attack needs fresh envelopes)
- **Masking:** `dryDb − wetDb` over the U-SENS threshold → proportional
  gain reduction capped at 12 dB, scaled by U-AMOUNT
- **Application:** per-sample attack (deepening) / release (recovering)
  smoothing; reduction applied through ACTIVE peaking bells only
  (Q 2.5), coefficients refreshed every 64 samples
- **Topology:** the bells act on the OUTPUT branch only (post spread,
  pre mix/level) — the feedback loop is untouched, so echo timing and
  per-repeat decay are exactly as with the solver off. **No added
  latency**, no PDC interaction, live == offline
- **Safety gates:** wet-activity guard (a delay band below ≈ −120 dB is
  never ducked — gains must not linger and damage later echoes);
  psychoacoustic masker floor (a dry band below ≈ −60 dB never masks —
  echoes ring free in pauses); silence guard; power-off decays the
  smoothed gains to zero so re-enabling never jumps (then bypasses 1:1)
- **Meters:** the 32-band reduction profile rides at the tail of the
  meter frame (§5.1.1) and renders as the red UNMASK curve in the panel

---

## 4. Parameter Contract

| ID           | Label     | Range              | Default  | Notes                                        |
| ------------ | --------- | ------------------ | -------- | -------------------------------------------- |
| `time`       | TIME      | 30–2000 ms (log)   | 375      | free mode                                    |
| `sync`       | SYNC      | enum 0–5           | 0 (off)  | off / 1/4 / 1/8 / 1/8T / 1/16 / 1/16T        |
| `pingPong`   | PING-PONG | 0/1                | 0        | L↔R crossfeedback                            |
| `feedback`   | FEEDBK    | 0–95 %             | 35       | hard ceiling, no runaway                     |
| `toneLp`     | TONE LP   | 500–12000 Hz (log) | 4500     | loop path                                    |
| `toneHp`     | TONE HP   | 20–800 Hz (log)    | 150      | loop path                                    |
| `drive`      | DRIVE     | 0–100 %            | 0        | tape saturation in feedback                  |
| `modRate`    | MOD RATE  | 0.1–8 Hz           | 0.6      | pitch drift rate                             |
| `modDepth`   | MOD DEPTH | 0–100 %            | 15       | pitch drift depth                            |
| `spread`     | SPREAD    | 0–100 %            | 80       | M/S width on wet                             |
| `freeze`     | FREEZE    | 0/1                | 0        | infinite repeat lock                         |
| `unmaskOn`   | UNMASK    | 0/1                | 0        | solver power (default off = legacy path)     |
| `unmask`     | U-AMOUNT  | 0–100 %            | 60       | reduction depth                              |
| `unmaskSens` | U-SENS    | 0–100 %            | 50       | masking threshold (0→+6 dB, 50→−15, 100→−36) |
| `unmaskAtk`  | U-ATK     | 0.1–100 ms         | 5        | duck envelope attack                         |
| `unmaskRel`  | U-REL     | 10–2000 ms         | 250      | duck envelope release                        |
| `character`  | CHARACTER | enum 0–2           | 1 (tape) | digital / tape / analog                      |
| `mix`        | MIX       | 0–100 %            | 25       | dry/wet                                      |
| `level`      | LEVEL     | −24 to +6 dB       | −6       | output gain                                  |
| `bpm`        | (hidden)  | 40–240             | 120      | transport tempo (set via setParameter)       |

All params are `k-rate` (block-rate updates, no per-sample param cost).
`bpm` is a hidden param (not shown in Inspector UI) used internally by
the worklet to resolve sync note values.

---

## 5. AudioWorklet Implementation

### 5.1 Processor

`src/audio-worklets/kaskada-processor.js` — single file, registerProcessor("kaskada").

Per-sample processing inside `process()`:

```
for each sample i:
  // fractional read (hermite interpolation)
  readPos = writePos - delaySamples + modOffset + tapeWow
  left = hermite(bufferL, readPos)
  right = hermite(bufferR, readPos)
  left/right = dcBlock(left/right)

  // ping-pong crossfeed (if enabled)
  if (pingPong) { feedbackL = right; feedbackR = left; }

  // character + loop EQ (biquads in the wet path)
  feedbackSample = character(feedbackSample)

  // write: input + feedback; freeze loops the wet back at 0.99 instead
  buffer[writePos] = freeze ? feedbackSample * 0.99
                            : input[i] + feedbackSample * fbGain

  // output = dry + wet
  outputL[i] = inputL[i] * (1 - mix) + left * mix
  outputR[i] = inputR[i] * (1 - mix) + right * mix

  writePos = (writePos + 1) % bufferSize
```

- Buffer: 2× Float32Array (L, R), sized from the context sample rate
  (`ceil(2000 ms · sr) + 1` ≈ 96 k frames at 48 kHz)
- Biquad filters: 2× LP + 2× HP cascaded per channel (24 dB/oct each)
  in the wet path
- One-pole DC blocker (~5 Hz) on the wet path — the loop HP already nulls
  DC; the blocker is defence in depth for the freeze write-back loop
- Denormal flush: `if (Math.abs(v) < 1e-20) v = 0` on the feedback path
- Freeze mode: input sealed out; the processed wet loops back at 0.99
  (self-limiting infinite repeat — the whole loop chain is contractive,
  so a frozen tail always decays, never grows)

### 5.1.1 Dual-spectrum metering (Inspector panel)

Gated analysis tap, off by default (the node posts `setMeters` — same
contract as Ultina; a closed panel costs zero analysis CPU):

- Taps: **dry** = mono input, **wet** = delay bus after loop EQ/drive/
  spread, pre-mix/pre-level — the display shows what the echoes contain
  even with MIX closed
- 2048-pt Hann FFT per tap, folded into **72 log bands** (20 Hz–20 kHz,
  the same geometry `KaskadaPanel` uses for the EQ overlay), posted
  ~30×/s as one `Float32Array(144)` (dry 0–71, wet 72–143, dB clamped
  to −90…0)
- The node caches the latest frame for `getMeters()` and enforces the
  gate (`setMetersEnabled(false)` also nulls the cache), so straggler
  port messages after a disable can never surface stale data

### 5.2 Node wrapper

`src/audio-worklets/kaskada-node.ts` — createKaskadaNode(ctx, instance):

- Creates AudioWorkletNode("kaskada")
- input → node → output (mix bus pattern like other effects)
- setParameter / setParameterAt → node.parameters.get(id).setValueAtTime()
- syncBpm(bpm) → node.parameters.get("bpm").setValueAtTime()
- Returns EffectRuntime (input, output, setParameter, dispose, syncBpm)

### 5.3 Loader registration

`src/audio-worklets/loader.ts`: add `"kaskada"` to `loadCoreWorklets` list.
`public/core-worklet.js` build script: append kaskada-processor.js.

---

## 6. Registry Integration

`src/effects/registry.ts`:

- Add `"kaskada"` to EffectType union (src/project-model/types.ts)
- Create `kaskada: EffectDefinition` with params + factory
  (worklet path: `createKaskadaNode`, fallback: bypass 1:1 + degraded flag)
- Add to `EFFECT_ORDER` + `CORE_EFFECT_ORDER`

`src/presets/factory.ts`:

- 6 factory presets (see §7)

**No EffectType name conflicts** — "kaskada" is a new type, distinct from
the existing `"delay"` and `"duckDelay"` types which remain unchanged for
backwards compatibility.

---

## 7. Factory Presets (6)

| ID                     | Name           | Character   | Key params                                                                  | Use case            |
| ---------------------- | -------------- | ----------- | --------------------------------------------------------------------------- | ------------------- |
| `kaskada.tape.echo`    | Tape Echo      | tape (1)    | time 375 ms, fb 45 %, drive 35 %, modDepth 30 %, modRate 0.8 Hz             | classic vocal delay |
| `kaskada.pp.wide`      | Ping-Pong Wide | digital (0) | pingPong 1, time 500 ms (1/8 @ 150), fb 55 %, spread 90 %                   | stereo image fill   |
| `kaskada.slap.back`    | Slap Back      | digital (0) | time 120 ms, fb 15 %, mix 18 %                                              | tight vocal double  |
| `kaskada.dub.space`    | Dub Space      | analog (2)  | time 650 ms, fb 75 %, drive 60 %, toneLp 2500 Hz, mix 40 %                  | dub/reggae echoes   |
| `kaskada.ambient.wash` | Ambient Wash   | tape (1)    | time 850 ms, fb 80 %, mix 55 %, spread 100 %, modDepth 45 %, modRate 0.3 Hz | ambient wash / pad  |
| `kaskada.tight.double` | Tight Double   | digital (0) | time 80 ms, fb 0 %, mix 30 %                                                | fast double-track   |

---

## 8. Phase 2 (future — not in this delivery)

> **Delivered ahead of schedule: dual spectrum** (§5.1.1 — dry + delay
> traces over one log axis with the live loop-EQ curve) and the
> **unmask solver** (§3.7 — 32-band adaptive spectral ducking with the
> red reduction curve in the panel). Drag-to-adjust EQ handles and the
> reference's delta-listen monitor remain future work.

- **Reverse mode** — backward read with lookahead (needs latency reporting)
- **Freeze tail capture** — sample-and-hold on the delay buffer
- **Solo wet / send-return mode** — descoped from Phase 1 (§1); needs a
  16th param plus Inspector wiring
- **Additional character modes** — magnetic drum, diffusion network

---

## 9. Definition of Done (Phase 1)

- [ ] `kaskada-processor.js` — per-sample processing, denormal flush, freeze mode
- [ ] `kaskada-node.ts` — EffectRuntime wrapper with syncBpm
- [ ] Registered in loader + core-worklet build
- [ ] EffectType `"kaskada"` added to union + registry + presets
- [ ] 6 factory presets, all in-range
- [ ] Inspector renders params generically (no custom UI needed)
- [ ] Browser check: worklet renders signal, ping-pong alternates, freeze holds
- [ ] Fallback: bypass 1:1 with degraded flag (no worklet context)
- [ ] typecheck + unit tests + browser QA pass

---

## 10. Known Risks

1. **Per-sample processing cost** — hermite + 8 biquads + tanh per sample
   in a worklet is ~2–3× heavier than block-based effects. Mitigate:
   k-rate params (no per-sample param reads), single Float32 buffer.
2. **Tempo sync** — BPM arrives via setParameter (hidden `bpm` param);
   sync note resolution happens in the worklet. No transport plumbing
   needed beyond `setEffectiveBpm` from Wave 1.
3. **Freeze mode** — feedback locked at 1.0 can accumulate DC offset.
   Mitigate: per-sample denormal flush + DC-block HP in the loop path.
4. **Ping-pong + freeze together** — crossfeedback at fb = 1.0 can self-
   oscillate. Mitigate: freeze mode hard-caps feedback at 0.99.
