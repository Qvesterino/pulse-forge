import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "./context";
import type { MatrixCheck, MatrixState, StateReading } from "./stateMatrix";

/**
 * STATE MATRIX — the Diagnostics tab that reads the SAME declaration the gate
 * reads (plan section 2: one declaration, two readers).
 *
 * THE GATE ASKS "DO YOU COMPLY?". THE PANEL ASKS "WHAT SHOULD HAPPEN?".
 * The first needs a machine and a headless browser. The second needs a person
 * who cannot read a git diff and needs to see that "a selected channel = an
 * amber bar on the left, a 13px name".
 *
 * FOUR HARD RULES (plan section 5), and how each one is kept:
 *
 *  1. No new chrome. This is a tab inside the existing Diagnostics panel. No
 *     topbar button, no dock slot, no overlay.
 *  2. The panel is closed by default; the existing DIAG button opens it.
 *  3. NO POLLING. The measurement runs when the tab opens and when a signal
 *     the app can actually observe fires - the transport, the document, or an
 *     interaction. There is no interval anywhere in this file.
 *  4. The measuring module is LAZY. `stateMatrix.ts` is imported with
 *     `await import(...)` here, so it is not in the studio's boot graph. The
 *     type-only import above is erased at build time and costs nothing.
 *  5. Zero impact while the tab is closed: the dynamic import has not run and
 *     no listener exists until the tab is opened.
 *
 * WHAT THE APP CANNOT SEE
 * -----------------------
 * The app has no pixels, so a role whose text sits on a gradient cannot be
 * settled here - the surface under the text depends on where in the gradient
 * it lands. Those rows say "unmeasured" and name the reason. They are NOT
 * failures: the gate measures them on the rendered pixels. The panel also
 * cannot see the pointer, so it never claims the `hover` state.
 */

/** The measuring module. The type is erased at build time - no runtime import. */
type MatrixModule = typeof import("./stateMatrix");

interface PanelView {
  /** The state the panel can prove, and how it knows. */
  state: MatrixState;
  /** The live checks, in the order the declaration lists them. */
  checks: MatrixCheck[];
  /** The number of checks that failed. */
  failed: number;
  /** The number that could not be measured in the app. */
  unmeasured: number;
  /** One line per state: the label, the description, the rule count. */
  catalogue: { id: string; label: string; description: string; rules: number; live: boolean }[];
}

export function StateMatrixPanel() {
  const services = useServices();
  const [mod, setMod] = useState<MatrixModule | null>(null);
  const [view, setView] = useState<PanelView | null>(null);
  /**
   * The RESTING reading - what the shell looked like before anything moved.
   *
   * Two rules need it: "the mark moves to another element" and "the text
   * changes" are statements about a DIFFERENCE, and a difference needs a
   * before. The panel takes the first reading it sees while nothing is
   * playing, armed or focused, and keeps it.
   */
  const resting = useRef<Map<string, StateReading> | null>(null);
  /** The pending re-measure, coalesced into one animation frame. */
  const pending = useRef<number | null>(null);

  // Rule 4: the measuring module arrives only when the tab is opened.
  useEffect(() => {
    let cancelled = false;
    void import("./stateMatrix").then((loaded) => {
      if (!cancelled) setMod(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const measure = useCallback(() => {
    if (!mod) return;
    const readings = mod.readStateMatrix(mod.STATE_ROLES);
    const playing = services.transport.playing;
    const armed = document.querySelector(".btn-record.armed") !== null;
    const focused = readings.some((reading) => reading.outlineCount > 0);

    // The resting reading is captured only while the shell is at rest, so a
    // panel opened mid-playback does not take a moving picture as the
    // baseline.
    if (!playing && !armed && !focused && resting.current === null) {
      resting.current = new Map(readings.map((reading) => [reading.roleId, reading]));
    }

    const baseline = resting.current?.get("rowPad")?.accentSample ?? null;
    const state = mod.detectMatrixState(readings, { playing, armed, baseline });
    const checks = mod.buildMatrixChecks(readings, resting.current, state);
    setView({
      state,
      checks,
      failed: checks.filter((check) => check.verdict === "fail").length,
      unmeasured: checks.filter((check) => check.verdict === "unmeasured").length,
      catalogue: mod.STATES.map((definition) => ({
        id: definition.id,
        label: definition.label,
        description: definition.description,
        rules: mod.STATE_EXPECTATIONS.filter((expectation) => expectation.state === definition.id).length,
        live: definition.id === state.id,
      })),
    });
  }, [mod, services]);

  // Rule 3: measure once when the tab opens, then only on a signal.
  useEffect(() => {
    if (!mod) return;
    measure();
    const detachTransport = services.transport.subscribePlaying(() => measure());
    const detachStore = services.store.subscribe(() => measure());
    // An interaction can change the shell in ways no store knows about - a
    // click on a channel row moves the selection mark, and that selection is
    // panel-local state, not a document edit. One capture-phase listener on
    // the document covers every such change, and it exists only while the
    // tab is open.
    const onInteraction = () => {
      if (pending.current !== null) return;
      pending.current = requestAnimationFrame(() => {
        pending.current = null;
        measure();
      });
    };
    document.addEventListener("pointerdown", onInteraction, true);
    document.addEventListener("keydown", onInteraction, true);
    return () => {
      detachTransport();
      detachStore();
      document.removeEventListener("pointerdown", onInteraction, true);
      document.removeEventListener("keydown", onInteraction, true);
      if (pending.current !== null) cancelAnimationFrame(pending.current);
      pending.current = null;
    };
  }, [mod, measure, services]);

  if (!mod) {
    return <div className="panel-loading">Loading the state matrix…</div>;
  }
  if (!view) {
    return <div className="panel-loading">Measuring the shell…</div>;
  }

  const failures = view.checks.filter((check) => check.verdict === "fail");
  const stateChecks = view.checks.filter((check) => check.kind === "state");
  const contrastChecks = view.checks.filter((check) => check.kind === "contrast");
  const stateLabel = mod.STATES.find((s) => s.id === view.state.id)?.label ?? view.state.id;

  return (
    <div className="matrix-panel">
      <div className="matrix-head">
        <span className="matrix-title">STATE MATRIX</span>
        <span className="matrix-subtitle">how the shell is supposed to look in each interaction state</span>
      </div>

      <div className="matrix-now">
        <span className="matrix-now-label">NOW</span>
        <span className="matrix-now-state">{stateLabel}</span>
        <span className="matrix-now-how">— {view.state.how}</span>
        <span className="matrix-tally">
          {view.failed > 0 ? `${view.failed} failing` : "nothing failing"} · {view.unmeasured}{" "}
          {view.unmeasured === 1 ? "row needs" : "rows need"} the pixel gate
        </span>
      </div>

      {failures.length > 0 && (
        <div className="diag-issues matrix-issues">
          <div className="diag-issue-title">THE LIVE SHELL DISAGREES WITH THE DECLARATION</div>
          {failures.map((check) => (
            <div key={`fail-${check.kind}-${check.role}`} className="diag-issue">
              <strong>{mod.roleLabel(check.role)}</strong> ({check.kind === "state" ? "state rule" : "contrast floor"})
              — expected {check.expected}, found {check.now}. {check.failures.join("; ")}. {check.why}
            </div>
          ))}
        </div>
      )}

      {stateChecks.length > 0 && (
        <div className="matrix-section">
          <div className="matrix-section-title">THIS STATE&apos;S RULES — {stateLabel.toUpperCase()}</div>
          <div className="diagnostics-grid matrix-grid">
            {stateChecks.map((check) => (
              <div key={`state-${check.role}`} className={`diagnostics-row matrix-row matrix-${check.verdict}`}>
                <span className="diagnostics-key matrix-role">{mod.roleLabel(check.role)}</span>
                <span className="diagnostics-value matrix-value">
                  <span className="matrix-mark">
                    {check.verdict === "ok" ? "✓" : check.verdict === "fail" ? "✕" : "—"}
                  </span>{" "}
                  {check.expected} → {check.now}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="matrix-section">
        <div className="matrix-section-title">CONTRAST FLOORS — EVERY STATE (WCAG 1.4.3)</div>
        <div className="diagnostics-grid matrix-grid">
          {contrastChecks.map((check) => (
            <div key={`contrast-${check.role}`} className={`diagnostics-row matrix-row matrix-${check.verdict}`}>
              <span className="diagnostics-key matrix-role">{mod.roleLabel(check.role)}</span>
              <span className="diagnostics-value matrix-value">
                <span className="matrix-mark">
                  {check.verdict === "ok" ? "✓" : check.verdict === "fail" ? "✕" : "—"}
                </span>{" "}
                {check.expected} → {check.now}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="matrix-catalogue">
        {view.catalogue.map((entry) => (
          <div key={entry.id} className={`matrix-state${entry.live ? " matrix-state-live" : ""}`}>
            <span className="matrix-state-label">{entry.label}</span>
            <span className="matrix-state-rules">
              {entry.rules} rule{entry.rules === 1 ? "" : "s"}
            </span>
            <span className="matrix-state-desc">{entry.description}</span>
          </div>
        ))}
        {view.state.unobserved.map((entry) => (
          <div key={`unobserved-${entry.id}`} className="matrix-state matrix-state-unobserved">
            <span className="matrix-state-label">{entry.id}</span>
            <span className="matrix-state-rules">unverified here</span>
            <span className="matrix-state-desc">{entry.why}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
