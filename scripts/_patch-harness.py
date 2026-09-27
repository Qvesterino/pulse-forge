import io

p = "src/plugin-audit-checks.ts"
s = io.open(p, encoding="utf-8").read()
orig = s

# 1. Richer test signal: add a 110 Hz saw (harmonics into the formant band)
#    so band-limited effects (vowel formants, phaser notches) have spectra
#    to act on.
old1 = """  const kickLen = Math.floor(SR * 0.25);
  for (let i = 0; i < l.length; i++) {
    const t = i / SR;
    let sl = 0.32 * Math.sin(2 * Math.PI * 220 * t);
    let sr = 0.32 * Math.sin(2 * Math.PI * 277 * t);"""
new1 = """  const kickLen = Math.floor(SR * 0.25);
  // 110 Hz saw harmonics give the 300-3000 Hz band real energy - formant
  // filters (vowel), notch sweeps (phaser) and band-focused EQs would
  // otherwise measure against a spectrally sparse signal and look inert.
  const sawPhase = (t: number) => 2 * (t * 110 - Math.floor(t * 110 + 0.5));
  for (let i = 0; i < l.length; i++) {
    const t = i / SR;
    let sl = 0.22 * Math.sin(2 * Math.PI * 220 * t) + 0.14 * sawPhase(t);
    let sr = 0.22 * Math.sin(2 * Math.PI * 277 * t) + 0.14 * sawPhase(t * 1.007);"""
assert old1 in s, "old1"
s = s.replace(old1, new1, 1)

# 2. Per-effect render window constants.
old2 = "const SIGNAL_SECONDS = 0.75;\nconst RESPONSIVE_EPS = 0.02;"
new2 = """const SIGNAL_SECONDS = 0.75;
const RESPONSIVE_EPS = 0.02;
/** Host delta below this still counts as processing (jitter floor ~1e-7). */
const HOST_EPS = 0.01;
"""
assert old2 in s, "old2"
s = s.replace(old2, new2, 1)

# 3. Bar-synced set + signalSecondsFor (place after RUNAWAY_PEAK decl).
old3 = "const RUNAWAY_PEAK = 40;"
new3 = """const RUNAWAY_PEAK = 40;

/**
 * Effects whose DSP is bar- or transport-synced: a 0.75 s window at 124 BPM
 * is shorter than one bar, so mangling/gating/swell cycles never complete
 * and every parameter measures inert. These render a 2-bar window instead.
 */
const BAR_SYNCED_EFFECTS = new Set<EffectType>([
  "beatMangler",
  "stepGate",
  "pump",
  "reverseSwell",
  "tapeStop",
  "granularFreeze",
  "stutter",
]);
const signalSecondsFor = (type: EffectType) => (BAR_SYNCED_EFFECTS.has(type) ? 4.4 : SIGNAL_SECONDS);"""
assert old3 in s, "old3"
s = s.replace(old3, new3, 1)

# 4. sweepEffect: swap in the long signal for bar-synced effects.
old4 = """async function sweepEffect(type: EffectType, signal: AudioBuffer, dry: AudioBuffer): Promise<SweepResult> {
  const paramsDef: ParamDef[] = EFFECT_META[type].params;
  const baseline = await renderEffect(type, defaultParamsOf(type), signal);"""
new4 = """async function sweepEffect(type: EffectType, signal: AudioBuffer, dry: AudioBuffer): Promise<SweepResult> {
  const paramsDef: ParamDef[] = EFFECT_META[type].params;
  if (Math.abs(signalSecondsFor(type) - signal.duration) > 1e-6) {
    const longCtx = new OfflineAudioContext(2, Math.floor(SR * signalSecondsFor(type)), SR);
    signal = buildTestBufferInto(longCtx, signalSecondsFor(type));
    dry = await renderDry(signal);
  }
  const baseline = await renderEffect(type, defaultParamsOf(type), signal);"""
assert old4 in s, "old4"
s = s.replace(old4, new4, 1)

# 5. buildTestBuffer parameterized.
old5 = """function buildTestBuffer(): AudioBuffer {
  const ctx = new OfflineAudioContext(2, Math.floor(SR * SIGNAL_SECONDS), SR);
  const buffer = ctx.createBuffer(2, Math.floor(SR * SIGNAL_SECONDS), SR);"""
new5 = """function buildTestBuffer(): AudioBuffer {
  const ctx = new OfflineAudioContext(2, Math.floor(SR * SIGNAL_SECONDS), SR);
  return buildTestBufferInto(ctx, SIGNAL_SECONDS);
}

function buildTestBufferInto(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(2, Math.floor(SR * seconds), SR);"""
assert old5 in s, "old5"
s = s.replace(old5, new5, 1)

# 6. Fingerprint overrides.
old6 = """/** Fingerprint: the two strongest non-dry-class extremes from the sweep. */
function fingerprintOf(sweep: SweepResult): { id: string; value: number }[] {
  const paramsDef = EFFECT_META[sweep.type].params;"""
new6 = """/**
 * Per-effect fingerprint overrides where the strongest sweep extreme is not
 * the most host-audible one (out-of-window delay times, mono-invisible
 * ping-pong).
 */
const FINGERPRINT_OVERRIDES: Partial<Record<EffectType, { id: string; value: number }[]>> = {
  delay: [
    { id: "feedback", value: 0.85 },
    { id: "tone", value: 500 },
  ],
  duckDelay: [
    { id: "feedback", value: 0.85 },
    { id: "duckAmount", value: 1 },
  ],
};

/** Fingerprint: the two strongest non-dry-class extremes from the sweep. */
function fingerprintOf(sweep: SweepResult): { id: string; value: number }[] {
  const override = FINGERPRINT_OVERRIDES[sweep.type];
  if (override) return override;
  const paramsDef = EFFECT_META[sweep.type].params;"""
assert old6 in s, "old6"
s = s.replace(old6, new6, 1)

# 7. Host delta threshold.
old7 = "    hostProcesses: hostDelta.delta > RESPONSIVE_EPS,"
new7 = "    hostProcesses: hostDelta.delta > HOST_EPS,"
assert old7 in s, "old7"
s = s.replace(old7, new7, 1)

# 8. Restore rms metric - interface.
old8 = """  automationDelta: number;
  automationFinite: boolean;
  restoreMaxDiff: number;
}"""
new8 = """  automationDelta: number;
  /** Set when the minimal host doc cannot exercise automation by design. */
  automationExempt?: string;
  automationFinite: boolean;
  restoreMaxDiff: number;
  restoreRmsDiff: number;
}"""
assert old8 in s, "old8"
s = s.replace(old8, new8, 1)

# 9. Restore computation with rms diff.
old9 = """  const restored = normalizeProject(JSON.parse(JSON.stringify(doc)));
  const restoreRender = await renderDoc(restored, bank);
  const restoreMaxDiff = maxDiff(on, restoreRender);"""
new9 = """  const restored = normalizeProject(JSON.parse(JSON.stringify(doc)));
  const restoreRender = await renderDoc(restored, bank);
  const restoreMaxDiff = maxDiff(on, restoreRender);
  const onRms = metricsOf(on).rms;
  const restoreRmsDiff = Math.abs(onRms - metricsOf(restoreRender).rms) / Math.max(onRms, 1e-6);"""
assert old9 in s, "old9"
s = s.replace(old9, new9, 1)

# 10. Automation exempt + return shape.
old10 = """  const autoRender = await renderDoc(autoDoc, bank);
  const plainRender = await renderDoc(autoStore.getDoc(), bank);
  const automationDelta = deltaVs(metricsOf(plainRender), metricsOf(autoRender)).delta;

  return {
    hostError: undefined,
    hostExemptReason,
    hostProcesses: hostDelta.delta > HOST_EPS,"""
new10 = """  const autoRender = await renderDoc(autoDoc, bank);
  const plainRender = await renderDoc(autoStore.getDoc(), bank);
  const automationDelta = deltaVs(metricsOf(plainRender), metricsOf(autoRender)).delta;

  return {
    hostError: undefined,
    hostExemptReason,
    hostProcesses: hostDelta.delta > HOST_EPS,"""
assert old10 in s, "old10"
s = s.replace(old10, new10, 1)

old11 = """    automationDelta,
    automationFinite: finiteEverywhere(autoRender),
    restoreMaxDiff,
  };"""
new11 = """    automationDelta,
    automationExempt: hostExemptReason,
    automationFinite: finiteEverywhere(autoRender),
    restoreMaxDiff,
    restoreRmsDiff,
  };"""
assert old11 in s, "old11"
s = s.replace(old11, new11, 1)

# 12. Catch-path HostResult gains restoreRmsDiff.
old12 = """    host = {
      hostError: String(error),
      hostProcesses: false,
      hostDelta: 0,
      hostBypassEqualsRemoved: false,
      hostFinite: false,
      automationDelta: 0,
      automationFinite: false,
      restoreMaxDiff: Number.POSITIVE_INFINITY,
    };"""
new12 = """    host = {
      hostError: String(error),
      hostProcesses: false,
      hostDelta: 0,
      hostBypassEqualsRemoved: false,
      hostFinite: false,
      automationDelta: 0,
      automationFinite: false,
      restoreMaxDiff: Number.POSITIVE_INFINITY,
      restoreRmsDiff: Number.POSITIVE_INFINITY,
    };"""
assert old12 in s, "old12"
s = s.replace(old12, new12, 1)

assert s != orig
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("harness v3 patched OK")
