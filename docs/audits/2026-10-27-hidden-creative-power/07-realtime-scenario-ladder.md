# 07 — The realtime scenario ladder: the boundary, and the instrument that could not measure it

**Audit:** HIDDEN_CREATIVE_POWER_AUDIT (§10.16.11 of `HIDDEN_CREATIVE_POWER_AUDIT_REPORT.md`)
**Measured:** 2026-10-30, on Windows (`D:\pulse-forge`) and on a 2-vCPU GitHub runner (Linux).
**Instrument:** `src/browser-checks.ts` → `auditRtBudget`, the scenario ladder (`7dd4c448`), the adjacent floor and the ratio
(`894e2368`), the raw drop counts (`37ff58c0`).

---

## 1. What this file is

The raw measurements behind §10.16.11: **the scenario ladder that was built to find where the realtime path stops fitting, the
defect that made it measure the run instead of the graph, the fix, and the three runs that followed.** Every line quoted below
is copied verbatim from a run — no line is transcribed by hand.

The ladder measures three scenarios after the gated 12×4 window, on the same context and the same rt-monitor:

| scenario | tracks | effects | chains |
| -------- | ------ | ------- | ------ |
| **12×3** | 12     | 3       | 36     |
| **8×4**  | 8      | 4       | 32     |
| **12×2** | 12     | 2       | 24     |

It is a **DIAGNOSTIC**: it never gates, and the gated 12×4 window keeps its exact position and construction, so nothing about the
gate's own verdict changes because the ladder exists.

---

## 2. Run 1 — the ladder as it was first built: the readings are inverted

**Artifact:** `rt-ladder-run1-no-adjacent-floor.log` (this desktop, `calib=15.3ms`).

```text
FAIL rt budget: 12 tracks × 4 effects realtime — OVER BUDGET — blocks=448 xruns=2 heartbeat avg=391.68ms
max=417.40ms (expected≈170.67ms, 2.30×) quantum=2.667ms · device floor xruns=0 jitter=1.00×
(1 track, no effects; cold 0/1.00× / warm 0/1.00×) · graph build=0 steady=2
· ladder 12×3 xruns=1 jitter=2.61× · 8×4 xruns=1 jitter=3.13× · 12×2 xruns=1 jitter=3.12×
```

Read in the order the readings were taken: the gated **12×4** (48 chains) at **2.30×**, then **12×3** (36 chains) at **2.61×**,
then **8×4** (32 chains) at **3.13×**, then **12×2** (24 chains) at **3.12×**. **A lighter graph read worse, and the readings rose
with measurement order while the graph got lighter all the way down.** That is not a capacity curve.

**The cause.** The device floor was measured **once, at the start** of the block (`src/browser-checks.ts:604-605`). The ladder sat
**four windows further down** the page, so the floor answered for a moment that was no longer the moment the ladder was read in.
**A reference measurement must be taken next to the measurement it references.**

**The secondary reading, which is about the gate rather than the ladder.** The window is 2.5 s (`:501`); at 48 kHz / 128 frames
a full-rate context renders **937** quanta in it. The measured count was **448** — **48 % of real time**. The audio thread was
not "dropping a quantum now and then", it was running at **half speed**, and the gate's headline `xruns=2` says almost nothing
about it: the xrun counter fires only when the device clock jumps a whole quantum past the processor
(`src/audio-worklets/rt-monitor-processor.js:44-47`), and a thread that is uniformly behind never jumps — it just arrives late.
**The heartbeat lateness is the honest number.**

---

## 3. The fix — an adjacent floor, and a ratio

`894e2368`, refined by `37ff58c0`:

- **the floor is taken immediately before every scenario** — the same context, the same probe, one track and no effects — so the
  reference is the device's ability **at that moment**;
- **the scenario is reported as a ratio** (`jitter ÷ adjacent floor jitter`), so a degradation that hits the empty graph and the
  loaded one alike cancels in the ratio and what survives is the graph's own cost in the device's heartbeat budget;
- **both drop counts are raw** (the scenario's and the floor's). A net difference was tried first and read as nonsense
  (`12×2 xruns=-1`: the floor's window can drop a quantum the scenario's does not).

The ladder stays a diagnostic and the gated window is untouched.

---

## 4. The three runs that followed

### 4.1 Desktop, contended box — `rt-ladder-run2-adjacent-floor-contended.log` (`calib=13.8ms`)

```text
FAIL rt budget: 12 tracks × 4 effects realtime — OVER BUDGET — blocks=448 xruns=1 heartbeat avg=394.28ms
max=409.40ms (expected≈170.67ms, 2.31×) quantum=2.667ms · device floor xruns=0 jitter=1.00×
(1 track, no effects; cold 0/1.00× / warm 0/1.00×) · graph build=0 steady=1
· ladder 12×3 xruns=1 (floor 0) jitter=2.67× floor=1.18× ratio=2.26×
· 8×4 xruns=-1 jitter=3.03× floor=1.73× ratio=1.75×
· 12×2 xruns=-1 jitter=3.28× floor=2.19× ratio=1.50×
```

### 4.2 Desktop, quiet box — `rt-ladder-run3-adjacent-floor-quiet.log` (`calib=17.3ms`)

```text
FAIL rt budget: 12 tracks × 4 effects realtime — OVER BUDGET — blocks=384 xruns=2 heartbeat avg=398.76ms
max=425.10ms (expected≈170.67ms, 2.34×) quantum=2.667ms · device floor xruns=0 jitter=1.00×
(1 track, no effects; cold 0/1.00× / warm 0/1.00×) · graph build=1 steady=1
· ladder 12×3 xruns=1 (floor 0) jitter=2.82× floor=1.18× ratio=2.38×
· 8×4 xruns=1 (floor 0) jitter=3.14× floor=1.74× ratio=1.81×
· 12×2 xruns=3 (floor 0) jitter=3.38× floor=2.24× ratio=1.51×
```

### 4.3 CI runner, 2-vCPU Linux — from the job's **error annotation** (one API request)

The runner's browser job failed, so the failing check's message reached the annotation (job logs sit behind a login; the
annotation does not):

```text
FAIL rt budget: 12 tracks × 4 effects realtime — OVER BUDGET — blocks=896 xruns=1 heartbeat avg=204.10ms
max=255.50ms (expected≈185.76ms, 1.10×) quantum=2.902ms · device floor xruns=0 jitter=1.00×
(1 track, no effects; cold 0/1.00× / warm 0/1.00×) · graph build=0 steady=1
· ladder 12×3 xruns=0 (floor 0) jitter=1.03× floor=0.93× ratio=1.11×
· 8×4 xruns=1 (floor 0) jitter=1.28× floor=1.00× ratio=1.27×
· 12×2 xruns=3 (floor 0) jitter=1.49× floor=0.85× ratio=1.75×
```

---

## 5. The readings side by side

| scenario            | chains | runner ratio | desktop run A ratio | desktop run B ratio |
| ------------------- | ------ | ------------ | ------------------- | ------------------- |
| **12×4** (the gate) | 48     | **1.10×**    | **2.31×**           | **2.34×**           |
| 12×3                | 36     | 1.11×        | 2.26×               | 2.38×               |
| 8×4                 | 32     | 1.27×        | 1.75×               | 1.81×               |
| 12×2                | 24     | 1.75×        | 1.50×               | 1.51×               |

**The two devices order the ladder in OPPOSITE ways.** On the runner the lightest scenario reads the worst (1.75× for 24 chains
against 1.11× for 36 chains); on the desktop it reads the best. Two devices, the same instrument, opposite orderings — so **the
ladder's ordering is not a property of the product.** The runner's floors stayed flat (0.93× / 1.00× / 0.85×: the device did not
degrade), so this is **not** a device-degradation effect and the ratio cannot cancel it; the desktop's floors degraded hard
(1.18× → 1.74× → 2.24×) and the ratio cancelled most of that, which is what left a monotonic-looking result there. **The
mechanism is Not verified.** What would settle it is a ladder that measures the same scenario first and last (so the order effect
is measured instead of hidden) or one that gives every scenario a fresh context. **That is the next instrument step, and it is not
in these commits** — the ladder gates nothing.

---

## 6. What the gate's own scenario does say — the part that answers the owner

On the runner — a **weaker** machine than this desktop, and the controlled environment — the 12×4 graph ran at **896 of 896
possible quanta**: **100 % of real time**, heartbeat at **1.10×** its expected cadence against a limit of 1.5×, and **exactly one
dropped quantum in the window**. **The promise the product makes — twelve tracks with four effects each, 48 effect chains — fits
in realtime on modest hardware.** The only thing the gate objects to is that single quantum.

On this desktop the same scenario rendered **384–448** quanta in the same 2.5 s window (**41–48 % of real time**) with a 2.3×
heartbeat. But this desktop's own calibration moved across the day from **12.0 ms** (the parallel session's run) to **17.3 ms**
in the "quiet" run — a **44 %** swing with no heavy job of this session's running — and ~35 `node.exe` processes (eight Playwright
MCP servers, several Vite dev servers, other sessions) were resident throughout. **A desktop whose calibration moves 44 % is not a
measuring environment for absolute realtime numbers.** Its number says more about the box than about the product.

**Consequence for the gate.** §10.16.9's recommendation stands and is now sharper: the 12×4 scenario is a promise modest hardware
can hold, so **the gate must stop being a capacity test against zero** — it needs the same relative form its offline sibling got
(`4bc8a224`: a ratio, not an absolute), which for a realtime gate means judging the graph against the **adjacent floor** this
file's instrument built. **Loosening the 1.5× limit is still not recommended** — the limit did its job; the criterion's FORM is
what is wrong.

---

## 7. Provenance

- The three desktop logs are complete browser-gate runs, captured with `Tee-Object` and stored **verbatim** (the coloured npm
  output is in them). Their `rt budget` lines are quoted above without editing.
- The runner's line is quoted from the job's **error annotation** on commit `37ff58c0` — one API request; the job log itself
  requires repository admin rights and returned **403**.
- The desktop runs were taken in an **isolated detached worktree** at `37ff58c0` (`D:\pf-ladder-894e2368`, `node_modules` a
  junction to the main tree) because the parallel session's in-flight audio-hardening refactor edits the playback path
  (`src/services.ts`, `src/scheduler/Scheduler.ts`, `src/transport/Transport.ts`) and the two DSP processors the ladder's effect
  stack uses (`src/audio-worklets/gate-processor.js`, `sidechain-processor.js`). **Measuring on a tree that another session is
  editing would have measured their work-in-progress.**
- Runs 2 and 3 differ in load (`calib=13.8ms` contended, `calib=17.3ms` "quiet"); the ratios agree within **0.06×** at 12×3 and
  8×4 and within **0.01×** at 12×2 — the ladder is **reproducible**; it is its **ordering** that is not a property of the graph.
