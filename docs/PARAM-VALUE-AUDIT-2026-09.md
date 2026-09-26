# Parameter Value Audit — FX vs professional VST conventions (2026-09-26)

**Scope.** All 47 effect definitions (42 core + 5 flagship suites) in `src/effects/definitions.ts` — ~280
parameters. Flagship deep parameters (PRISM band table, VØID engine internals, MORPH macro targets) are
edited through their own panels and are out of META scope; the audit covers the serialized parameter surface.

**Method.** Full dump of `EFFECT_META` via vite-node (`min/max/default/unit/taper/kind/options` per param),
cross-checked against the engine: worklet `parameterDescriptors`, runtime clamps, node buffer allocations.
Ranges compared against established pro references: FabFilter Pro-Q 3 / Pro-C 2 / Pro-L 2 / Pro-R,
1176 / LA-2A / dbx conventions, Valhalla Room / VintageVerb / Delay, Soundtoys (Decapitator, EchoBoy),
D16 Decimort 2, Moog MF-102, Eventide H3000 / Little AlterBoy. Reference figures are industry-typical
published ranges, cited conservatively.

**Overall verdict.** The parameter surface is **structurally pro-grade**: every Hz-domain param has a log
taper, dB params are linear (correct), tempo sync exposes all 16 divisions (straight/dotted/triplet) from
one shared musical order, dynamics units match Pro-C 2 conventions (knee 0–40 dB, sidechain HPF, auto
release, parallel mix), and the limiter's 1–20 ms lookahead matches Pro-L 2. The gaps are concentrated in
**upper range ceilings of the space/time family** (reverb decay, delay time, reverb tone/damping), the
**compressor attack floor**, and a handful of defaults/consistency nits. Roughly 80% of ranges need nothing.

---

## S-tier — real range gaps vs professional reverbs/delays/dynamics

| # | Param | Ours | Pro reference | Why it matters | Fix |
|---|-------|------|---------------|----------------|-----|
| S1 | `reverb.decay` | 0.1–**6 s** | Pro-R: to 60 s; Valhalla Room: to 100 s; VintageVerb: ~20 s | Ambient/cinematic tails unreachable at all — the single biggest range gap in the product | 6 → **20 s** (def + `reverb-processor.js` descriptor `maxValue` + runtime clamp `Math.min(6,…)`). Feedback math `g = 10^(−3·ms/(decay·s))` is smooth in decay — valid at any value; keep MOD high on long tails (metallic mode ring is already mitigated per processor comment). Honest note: our comb/allpass FDN at 20 s is VintageVerb-usable, not Room-dense |
| S2 | `delay.time`, `duckDelay.time` | 30–**1000 ms** | EchoBoy/Timeless class: multi-second, H3000: 1.28 s+ | Dub/ambient throws capped at 1 s | Bump to **2 s**: the stock delay engine already allocates `createDelay(2)` (registry.ts:1243) — change def + both delay worklet descriptors (`stock-delay-processor.js`, `ducking-delay-processor.js`) + rebuild. Cheapest high-impact fix in the audit |
| S3 | `reverb.tone`, `reverb.damping` | 500 Hz–**12 kHz** | Full-band damping is pro norm (20 Hz–20 kHz); dark plates need tone floor well under 500 Hz, glassy halls above 12 kHz | No truly dark chamber, no airy hall — both character extremes clipped | Widen to **200 Hz–18 kHz** (def only; in-loop biquads take any audible freq) |
| S4 | `compressor.attack` (also `sidechain`, `bassBuss`) | floor **1 ms** | 1176 class: 0.02–0.8 ms; Pro-C 2: to 0.05 ms | Super-fast click-preserving drum-bus compression unreachable | Floor → **0.2–0.5 ms**. Envelope coefficient `1 − exp(−1/(sr·attack))` (compressor-processor.js:78) is valid at any attack — also change the `Math.max(0.001,…)` clamp. Honest note: one-pole follower stays Pro-C-smooth, not 1176-grabby |

## A-tier — narrower than pro, worth widening

| # | Param | Ours | Pro reference | Fix |
|---|-------|------|---------------|-----|
| A1 | EQ Q (`eq`/`msEq` ×3 bands) | 0.3–8 | Pro-Q 3: 0.02–40 | Widen to **0.2–16** — surgical notch class (resonance hunting) currently impossible |
| A2 | `msEq` gains/shelf | ±12 dB; shelf to 12 kHz | Core EQ here: ±15 dB / 16 kHz — internal inconsistency | Align to **±15 dB / 16 kHz** |
| A3 | release (comp/sidechain/limiter/bassBuss) | max **1 s** | Pro-C 2 / Pro-L 2: to 2 s (+auto, which comp already has) | Max → **2 s** |
| A4 | `reverb.predelay` | max **120 ms** | Pro convention max ~250 ms | Max → **250 ms** |
| A5 | `chorus` | voices 2–4; rate floor 0.1 Hz; no base delay | Pro chorus: 6–8 voices common, slow-sweep to 0.01 Hz, base delay 0–20 ms exposed | Voices → 2–6; rate floor → 0.05 Hz; optional BASE (0–20 ms) param for sheen-vs-vibrato character |
| A6 | `pitchShift.fine` | ±50 ct | H3000 / AlterBoy: ±100 ct | → ±100 ct (cheap, safe) |
| A7 | `limiter.ceiling` | −12…0 dB | Pro-L 2: −24…0 | → −24 dB floor for heavy insert-trim workflows |
| A8 | `bitcrusher.downsample` | 1–50 step 1 | Decimort: ÷2 ÷4 ÷8 ÷16 ÷32 ÷64 | Snap to musical power set **{1,2,4,8,16,32,64}** via options (display already `Nx`); `bits` 1–16 fine (Decimort 1–24 — note only) |

## B-tier — defaults / consistency / UI taper polish

| # | Item | Finding | Recommendation |
|---|------|---------|----------------|
| B1 | `freqShifter.shift` default **+120 Hz** | Inserting the effect instantly Daleks the signal; pro shifts default 0 Hz | Default → 0 (presets carry creative values) |
| B2 | Time-domain tapers | `delay.time`, `haas.delayMs`, `comb.delayMs`, attack/release in s are linear | Log taper (like the Hz params) — pure UI feel, no DSP change |
| B3 | Sibling defaults | `distortion.character` default 3 vs `saturation.character` default 0 | Align to same default character |
| B4 | 0-sentinel Hz params | `sidechain.splitFreq`, `monoBassFrequency` (bassBuss/utility) encode OFF as 0 Hz inside a range — works, displayed as "OFF" | Accept as-is; long-term a toggle+range pair. Documented |
| B5 | Trim ceilings inconsistent | `level` maxes: +12 (voc/granular/rev-swell) vs +6 (RYFT); `output` ±12/±18/±24 | Harmless; align opportunistically, never break saved presets (normalize handles clamps) |
| B6 | `multiband` crossovers | 80–800 / 800–8000 windows vs Pro-MB arbitrary bands | Design choice — documented, not a defect |
| B7 | `utility.gain` floor −24 dB | No −∞/mute convention | Format-level note only; real −∞ needs engine handling |
| B8 | `vocoder.bands` 8–16 | Pro vocoders reach 20–32 (EMS 27) | Acceptable; note only |

## Engineering note (value-adjacent, biggest *sound* gap in the drive family)

**No oversampling on the drive family** (`clipper`, `distortion`, `saturation`, `tapeSat`, `drumBuss`,
`bassBuss`, `ringMod`, `freqShifter`): WaveShaper tanh and hard clip at base sample rate alias audibly when
pushed. Professional drives oversample 2×–16× with polyphase IIR around the nonlinear stage. MORPH already
ships 2× OS — the pattern exists in-repo. This is the top recommendation *beyond ranges*; it is a DSP wave,
not a numbers wave.

## What is already pro-grade (no action)

- Log tapers on every Hz param; dB params linear — correct conventions throughout.
- Compressor: knee 0–40 dB, detector modes, sidechain HPF 20–500 Hz, auto release, parallel mix = Pro-C 2 feature set.
- Limiter lookahead 1–20 ms, ceiling −1 default — Pro-L 2 conventions.
- Gate: −80 dB threshold, range floor, hold, lookahead toggle — Pro-DS class surface.
- Tempo sync: 16 shared divisions (straight/dotted/triplet) across delay/duck/chorus/phaser/flanger/tremolo/freqShifter/RYFT/stepGate/stutter — more complete than most pro plugins' 6–8.
- Transient shaper ±100% attack/sustain; flanger in true ms with TZF-approx invert; tape stop to 8 s; granular freeze pitch ±24 st; vinyl suite physically anchored (wow 0.2–4 Hz, flutter 4–30 Hz, rumble 30–120 Hz).
- Defaults: compressor −18/3:1/10 ms/200 ms textbook; limiter −6/−1; gate −36; EQ bands flat at ±0 — inserts land neutral where pros land neutral.

## Recommended wave split

1. **Vlna 1 — numbers (low risk, high impact):** S1, S2, S3, S4, A1, A2, A3, A4, A6, A7. Touch points:
   `src/effects/definitions.ts` + `reverb-processor.js` + `stock-delay-processor.js` + `ducking-delay-processor.js`
   + `compressor-processor.js` clamps → rebuild worklets → update value pins in `tests/effects-wave*.test.ts`.
   Golden vectors unaffected except where decay/delay values are baked — re-bless only those.
2. **Vlna 2 — UX polish:** B1 default, B2 tapers, A5 chorus, A8 crush powers, B3.
3. **Vlna 3 — DSP:** oversampling on the drive family (2×/4× polyphase pre/post), pattern per `morphDynamicsNode`.
