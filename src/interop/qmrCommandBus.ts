/**
 * QMR COMMAND BUS — KYX's HOST side of the Qvester ecosystem command bridge.
 *
 * The QMR HUD (the sibling monorepo's @qvester/qmr-hud) dispatches commands
 * INTO the host app over a DOM-event channel: it fires `qmr:command` on
 * `window` and waits for a `qmr:command-response` ack carrying the same
 * requestId. The sibling's own `command-bus.ts` exposes that channel as a
 * HOST-side API (`listenForCommands`) — but it ships as TS SOURCE from the
 * sibling checkout, so importing it made KYX's BUILD depend on a second
 * repository.
 *
 * Measured 2026-10-28 on GitHub Actions: the runner has no sibling checkout,
 * so `vite build` died on ENOENT ("Failed to resolve import
 * @qvester/qmr-hud/command-bus.ts") and the studio crashed on boot — five
 * red CI jobs from one cross-repo static import.
 *
 * The channel is a CONTRACT and the app is the HOST, so the host owns it.
 * This module IS that host side: fully typed, testable without the sibling,
 * and behaviourally identical to the sibling's implementation — the
 * protocol-drift guard in tests/qmr-command-bus.test.ts compares the two
 * event names whenever the sibling IS present, so a change on the other side
 * turns red here instead of silently disconnecting the ecosystem.
 *
 * Only the HUD's USER INTERFACE stays a sibling dependency, and that one is
 * optional: the chip trigger loads lazily and degrades to "no chip" when the
 * sibling checkout is absent (src/integrations/qmr-hud-stub).
 */

/** Fired by the HUD toward the host app. */
export const QMR_COMMAND_EVENT = "qmr:command";
/** Fired by the host app back to the HUD as an ack. */
export const QMR_COMMAND_RESPONSE_EVENT = "qmr:command-response";

/** A command as the ecosystem sends it. Only `type` is guaranteed. */
export interface QmrHostCommand {
  type: string;
  [key: string]: unknown;
}

/** The outcome the HUD reads back from the ack. */
export interface QmrHostCommandResult {
  ok: boolean;
  /** The app does not implement this command — the HUD keeps its chain going. */
  unsupported?: boolean;
  message?: string;
  data?: unknown;
  url?: string;
}

/** Detail of the `qmr:command` event the HUD dispatches. */
export interface QmrCommandRequestDetail {
  requestId: string;
  appId: string;
  command: QmrHostCommand;
}

/** Detail of the `qmr:command-response` ack the host dispatches back. */
export interface QmrCommandResponseDetail {
  requestId: string;
  result: QmrHostCommandResult;
}

/**
 * Subscribe to QMR commands addressed to this app.
 *
 * The handler may be sync or async. Return a result to report the outcome;
 * returning `undefined` means "handled, ok". Return `{ ok: false,
 * unsupported: true }` for command types the app does not implement, so the
 * HUD can keep falling through its chain.
 *
 * @returns teardown function (removes the listener).
 */
export function listenForCommands(
  appId: string,
  handler: (command: QmrHostCommand) => QmrHostCommandResult | Promise<QmrHostCommandResult> | void | Promise<void>,
): () => void {
  if (typeof window === "undefined") return () => {};

  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<QmrCommandRequestDetail>).detail;
    // A command for another app is not ours to answer.
    if (!detail || detail.appId !== appId) return;
    void Promise.resolve()
      .then(() => handler(detail.command))
      .then((result) => {
        const r: QmrHostCommandResult = typeof result === "object" && result !== null ? result : { ok: true };
        respondToCommand(detail.requestId, r);
      })
      .catch((err: unknown) => {
        respondToCommand(detail.requestId, {
          ok: false,
          message: err instanceof Error ? err.message : "Command failed",
        });
      });
  };

  window.addEventListener(QMR_COMMAND_EVENT, listener);
  return () => window.removeEventListener(QMR_COMMAND_EVENT, listener);
}

/** Ack one command back to the HUD, matched by requestId. */
function respondToCommand(requestId: string, result: QmrHostCommandResult): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent<QmrCommandResponseDetail>(QMR_COMMAND_RESPONSE_EVENT, {
        detail: { requestId, result },
      }),
    );
  } catch {
    // non-DOM environment — nothing to ack
  }
}
