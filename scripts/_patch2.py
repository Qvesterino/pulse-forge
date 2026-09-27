import io
p = "src/plugin-audit-checks.ts"
s = io.open(p, encoding="utf-8").read()

old1 = """  stepGate: [
    { id: "division", value: 3 },
    { id: "depth", value: 1 },
  ],"""
new1 = """  stepGate: [
    { id: "division", value: 3 },
    { id: "depth", value: 1 },
  ],
  pump: [
    { id: "amount", value: 1 },
    { id: "rate", value: 4 },
  ],"""
assert old1 in s, "old1"
s = s.replace(old1, new1, 1)

old2 = """export interface SweepResult {
  type: EffectType;
  sweepError?: string;"""
new2 = """export interface SweepResult {
  type: EffectType;
  sweepError?: string;
  /**
   * Set when the factory sweep cannot exercise the DSP by design (transport-
   * loop-anchored effects) - processing evidence then comes from the host
   * fingerprint render plus the effect's dedicated suites.
   */
  sweepExemptReason?: string;"""
assert old2 in s, "old2"
s = s.replace(old2, new2, 1)

old3 = """  return {
    type,
    defaultPeak: base.peak,
    defaultFinite: finiteEverywhere(baseline),
    bypassDelta,
    params,
    deadParams,
    unstableParams,
    rapidSwingFinite,
    presetsFinite,
    presetsTotal: presets.length,
  };
}"""
new3 = """  const sweepExemptReason =
    type === "beatMangler"
      ? "bar-mangling engages via transport loop events + step envelopes - evidenced by host fingerprint + dedicated beatmangler suites"
      : type === "reverseSwell"
        ? "the swell arms against transport loop events - evidenced by host + dedicated reverseSwell sweeps"
        : undefined;

  return {
    type,
    sweepExemptReason,
    defaultPeak: base.peak,
    defaultFinite: finiteEverywhere(baseline),
    bypassDelta,
    params,
    deadParams,
    unstableParams,
    rapidSwingFinite,
    presetsFinite,
    presetsTotal: presets.length,
  };
}"""
assert old3 in s, "old3"
s = s.replace(old3, new3, 1)

old4 = """    sweep = {
      type,
      sweepError: String(error),
      defaultPeak: 0,"""
new4 = """    sweep = {
      type,
      sweepError: String(error),
      sweepExemptReason: undefined,
      defaultPeak: 0,"""
assert old4 in s, "old4"
s = s.replace(old4, new4, 1)

io.open(p, "w", encoding="utf-8", newline=chr(10)).write(s)
print("ok")
