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

Two workflows, one knob:

- **Insert (default):** dry always passes at unity; `MIX` is the gain of
  the internal delay bus (0 % = −∞, 50 % = −6 dB, 100 % = 0 dB).
- **Solo wet:** `SOLO WET` mutes the dry arm; MIX becomes a send-return
  level (classic send-return workflow).

**Not in Phase 1:** unmask solver, reverse mode, dual spectrum display,
delta listen. These are Phase 2 items (see §8).

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
- **Max delay:** 5000 ms. Sync values that resolve above the max clamp
  to 5000 ms.
- **Ping-Pong:** feedback crosses L↔R (left input feeds the right write
  and vice versa). Width still applies after the crossfeed.

### 3.2 Character (feedback-loop colour)

| Value | Name | Behaviour |
|---|---|---|
| 0 | `digital` | Clean loop — only the loop EQ acts. |
| 1 | `tape` | HF loss per repeat + subtle pitch wobble. |
| 2 | `analog` | Dark bucket-brigade; progressively darkening repeats. |

### 3.3 Modulation (pitch drift)

Single LFO on delay time: `MOD DEPTH` (0–100 %) scales drift in
milliseconds, `MOD RATE` (0.01–10 Hz) sets speed. Implemented as
modulation of the fractional read position — classic tape/BBD pitch
drift, click-free by construction.

### 3.4 Loop EQ

- **Low Cut:** 20 – 2000 Hz, 24 dB/oct (cascaded biquad HP).
- **High Cut:** 1000 – 20000 Hz, 24 dB/oct (cascaded biquad LP).
- Both act on the **feedback path only** — the first repeat keeps full
  bandwidth (bright first slap, darkening tail — the vocal-delay shape).

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

---

## 4. Parameter Contract

| ID | Label | Range | Default | Notes |
|---|---|---|---|---|
| `time` | TIME | 30–2000 ms (log) | 375 | free mode |
| `sync` | SYNC | enum 0–5 | 0 (off) | off / 1/4 / 1/8 / 1/8T / 1/16 / 1/16T |
| `pingPong` | PING-PONG | 0/1 | 0 | L↔R crossfeedback |
| `feedback` | FEEDBK | 0–95 % | 35 | hard ceiling, no runaway |
| `toneLp` | TONE LP | 500–12000 Hz (log) | 4500 | loop path |
| `toneHp` | TONE HP | 20–800 Hz (log) | 150 | loop path |
| `drive` | DRIVE | 0–100 % | 0 | tape saturation in feedback |
| `modRate` | MOD RATE | 0.1–8 Hz | 0.6 | pitch drift rate |
| `modDepth` | MOD DEPTH | 0–100 % | 15 | pitch drift depth |
| `spread` | SPREAD | 0–100 % | 80 | M/S width on wet |
| `freeze` | FREEZE | 0/1 | 0 | infinite repeat lock |
| `character` | CHARACTER | enum 0–2 | 1 (tape) | digital / tape / analog |
| `mix` | MIX | 0–100 % | 25 | dry/wet |
| `level` | LEVEL | −24 to +6 dB | −6 | output gain |
| `bpm` | (hidden) | 40–240 | 120 | transport tempo (set via setParameter) |

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
  readPos = writePos - delaySamples + modOffset
  left = hermite(bufferL, readPos)
  right = hermite(bufferR, readPos)

  // ping-pong crossfeed (if enabled)
  if (pingPong) { feedbackL = right; feedbackR = left; }

  // character + loop EQ (biquads in feedback path)
  feedbackSample = character(feedbackSample)

  // write new sample (input + feedback)
  bufferL[writePos] = inputL[i] + feedbackSample * fbGain
  bufferR[writePos] = inputR[i] + feedbackSample * fbGain

  // output = dry + wet
  outputL[i] = inputL[i] * (1 - mix) + left * mix
  outputR[i] = inputR[i] * (1 - mix) + right * mix

  writePos = (writePos + 1) % bufferSize
```

- Buffer size: 16384 samples (max delay 2000 ms at 8 kHz — plenty of headroom)
- Ring buffer: 2× Float32Array (L, R)
- Biquad filters: cascaded biquad arrays for LP (4×) and HP (4×) in the loop
- Denormal flush: `if (Math.abs(v) < 1e-20) v = 0` on feedback path
- Freeze mode: bypass input write, feedback gain locked to 1.0

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

| ID | Name | Character | Key params | Use case |
|---|---|---|---|---|
| `kaskada.tape.echo` | Tape Echo | tape (1) | time 375 ms, fb 45 %, drive 35 %, modDepth 30 %, modRate 0.8 Hz | classic vocal delay |
| `kaskada.pp.wide` | Ping-Pong Wide | digital (0) | pingPong 1, time 500 ms (1/8 @ 150), fb 55 %, spread 90 % | stereo image fill |
| `kaskada.slap.back` | Slap Back | digital (0) | time 120 ms, fb 15 %, mix 18 % | tight vocal double |
| `kaskada.dub.space` | Dub Space | analog (2) | time 650 ms, fb 75 %, drive 60 %, toneLp 2500 Hz, mix 40 % | dub/reggae echoes |
| `kaskada.ambient.wash` | Ambient Wash | tape (1) | time 850 ms, fb 80 %, mix 55 %, spread 100 %, modDepth 45 %, modRate 0.3 Hz | ambient wash / pad |
| `kaskada.tight.double` | Tight Double | digital (0) | time 80 ms, fb 0 %, mix 30 % | fast double-track |

---

## 8. Phase 2 (future — not in this delivery)

- **Unmask solver** — 32-band spectral ducking (Ultina pattern inverted)
- **Reverse mode** — backward read with lookahead (needs latency reporting)
- **Dual spectrum display** — dry + delay trace in Inspector
- **Freeze tail capture** — sample-and-hold on the delay buffer
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
