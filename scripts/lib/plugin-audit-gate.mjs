import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Sources whose contents decide what a number in a report MEANS.
 *
 * Only the measurement code. The runner is deliberately EXCLUDED: it schedules
 * evaluates and writes the file, it does not decide what any number is. Hashing
 * it meant every logging tweak, retry tweak or page-recycle tweak invalidated a
 * baseline that costs about an hour to produce — the runner would have been able
 * to invalidate its own evidence without changing a single measurement.
 */
export const HARNESS_SOURCES = [
  path.join("src", "plugin-audit-checks.ts"),
  path.join("src", "plugin-audit-audition.ts"),
];

/**
 * Fingerprint of the measuring code.
 *
 * The audit's value is comparing a run against a previous run, so comparing
 * across a change in the measuring code must be impossible. It was possible and
 * it happened: a full run printed `[resume] keeping 56 effect rows` and skipped
 * nearly all its work, inheriting rows measured while the offline render was
 * returning a truncated buffer. Those rows were not stale-looking — a truncated
 * render is finite, so every health filter accepted them.
 */
export function computeHarnessHash(root) {
  return createHash("sha256")
    .update(
      HARNESS_SOURCES.map((relative) => {
        const file = path.join(root, relative);
        try {
          return fs.readFileSync(file);
        } catch {
          return Buffer.from(`<missing:${relative}>`);
        }
      })
        .map((buf, index) => `::${path.basename(HARNESS_SOURCES[index])}::\n${buf.toString("utf8")}`)
        .join("\n"),
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * Plugin audit gate — decides whether a plugin-audit report is healthy.
 *
 * Split out of `verify-plugin-audit.mjs` for one reason: the runner takes hours
 * to produce a full report, so a gate that can only be exercised by running the
 * whole audit cannot be iterated on. Evaluating an existing report has to be
 * possible on its own.
 *
 * What is and is not a failure, and why:
 *
 * - A FAILED MEASUREMENT or a MEASURED HEALTH VIOLATION fails. A non-finite
 *   render, an effect that never reaches the host graph, a runner step that
 *   threw — those are facts about the plugins.
 * - A DEAD PARAMETER does not fail. There are 143 of them today and no agreed
 *   bar; the column is a work list, not a pass/fail. Gating on it would make
 *   the gate red on arrival and teach everyone to ignore it.
 * - AN EFFECT THAT DOES NOT PROCESS does not fail either, but the two reasons
 *   it might not are NOT the same claim and must never be summed into one
 *   number. An effect carrying an `hostExemptReason` has a documented reason a
 *   zero host delta is the correct output (the minimal host doc has no key or
 *   modulator track to duck against). An effect without one is unaccounted
 *   for. Reporting "6 effects not processing" when 2 of them are explained
 *   overstates the defect count by a third and sends the next audit at the
 *   wrong two plugins.
 * - CONSOLE NOISE does not fail. The first full run logged two WebSocket
 *   errors caused by the runner's own `hmr: false`; that made the gate report
 *   the harness as broken for something the harness did to itself.
 *
 * @param {object} report Parsed plugin-audit report.
 * @returns {{ok: boolean, failures: string[], stats: object}}
 */
export function evaluateAuditGate(report) {
  const failures = [];
  const effects = Array.isArray(report?.effects) ? report.effects : [];
  const instruments = Array.isArray(report?.instruments) ? report.instruments : [];

  for (const effect of effects) {
    if (effect.sweepError) failures.push(`${effect.type}: sweep failed — ${String(effect.sweepError).slice(0, 140)}`);
    if (effect.hostError) failures.push(`${effect.type}: host test failed — ${String(effect.hostError).slice(0, 140)}`);
    if (effect.defaultFinite === false) failures.push(`${effect.type}: default render produced NaN/Infinity`);
    if (effect.rapidSwingFinite === false) failures.push(`${effect.type}: rapid parameter swing produced NaN/Infinity`);
    if (effect.automationFinite === false) failures.push(`${effect.type}: automation pass produced NaN/Infinity`);
  }
  for (const instrument of instruments) {
    for (const note of instrument.unstableParams ?? []) {
      if (String(note).startsWith("runner:")) failures.push(`${instrument.kind}: ${String(note).slice(0, 140)}`);
    }
  }
  for (const note of report?.interactions?.notes ?? []) {
    if (String(note).startsWith("runner:")) failures.push(`interactions: ${String(note).slice(0, 140)}`);
  }

  const deadByEffect = effects
    .map((e) => ({ type: e.type, dead: e.deadParams?.length ?? 0 }))
    .sort((a, b) => b.dead - a.dead);

  // GATED parameters are not dead — they are inert only while a sibling switch
  // is off (reverseSwell.engaged=0 disables its whole parameter set). They
  // were measured and found to respond once the effect is engaged, so they are
  // reported apart from the dead list rather than inside it. A work list that
  // calls a gated parameter dead sends the next agent to wire up something
  // that already works.
  const gatedByEffect = effects
    .map((e) => ({ type: e.type, gated: e.gatedParams?.length ?? 0 }))
    .filter((e) => e.gated > 0)
    .sort((a, b) => b.gated - a.gated);

  // An effect exempts itself from the host test only by carrying a non-empty
  // reason. `hostProcesses:false` alone cannot distinguish "the host fixture
  // cannot excite this" from "this plugin is wired to nothing" — the audit
  // already writes the reason down, so the gate reads it instead of guessing.
  const hostExempt = effects
    .filter((e) => typeof e.hostExemptReason === "string" && e.hostExemptReason.trim().length > 0)
    .map((e) => ({ type: e.type, reason: e.hostExemptReason, hostProcesses: e.hostProcesses === true }));
  const exemptTypes = new Set(hostExempt.map((e) => e.type));
  const notProcessing = effects.filter((e) => !e.hostProcesses && !exemptTypes.has(e.type)).map((e) => e.type);

  return {
    ok: failures.length === 0,
    failures,
    stats: {
      effects: effects.length,
      instruments: instruments.length,
      interactions: Boolean(report?.interactions),
      deadParameters: deadByEffect.reduce((sum, e) => sum + e.dead, 0),
      deadByEffect,
      gatedParameters: gatedByEffect.reduce((sum, e) => sum + e.gated, 0),
      gatedByEffect,
      notProcessing,
      hostExempt,
      silentInstruments: instruments.filter((i) => !i.defaultAudible).map((i) => i.kind),
    },
  };
}
