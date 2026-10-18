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
export const HARNESS_SOURCES = [path.join("src", "plugin-audit-checks.ts")];

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

  return {
    ok: failures.length === 0,
    failures,
    stats: {
      effects: effects.length,
      instruments: instruments.length,
      interactions: Boolean(report?.interactions),
      deadParameters: deadByEffect.reduce((sum, e) => sum + e.dead, 0),
      deadByEffect,
      notProcessing: effects.filter((e) => !e.hostProcesses).map((e) => e.type),
      silentInstruments: instruments.filter((i) => !i.defaultAudible).map((i) => i.kind),
    },
  };
}
