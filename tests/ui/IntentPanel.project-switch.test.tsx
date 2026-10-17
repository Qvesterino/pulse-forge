import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { IntentPanel } from "../../src/ui/IntentPanel";
import { mockServices, renderWithContext } from "../helpers";
import { ServicesContext } from "../../src/ui/context";
import * as pipeline from "../../src/intent/pipeline";

/**
 * Mission 16 follow-up: a generation aborted by a PROJECT SWITCH settles
 * through runGeneration's `finally { if (!controller.signal.aborted)
 * setBusy(false); }` — skipped precisely because the signal is aborted. The
 * switch effect must reopen the gate, or GENERATE / DO IT (and every later
 * generation, all gated on `busy`) stay dead for the panel's whole life.
 */
describe("IntentPanel project-switch recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a generation aborted by a project switch does not leave the busy gate stuck", async () => {
    let settle: (reason?: unknown) => void = () => undefined;
    vi.spyOn(pipeline, "generateAsyncResult").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          settle = reject;
        }) as never,
    );

    const servicesA = mockServices();
    const servicesB = mockServices();
    const rendered = renderWithContext(<IntentPanel />, { services: servicesA });

    fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: "dark drill" } });
    fireEvent.click(screen.getByRole("button", { name: /^GENERATE$/ }));

    // In flight — the gate is closed and the label says so.
    await waitFor(() => expect(screen.getByRole("button", { name: /GENERATING/ })).toBeDisabled());

    // Project switch while the generation is in flight: the effect aborts it.
    rendered.rerender(createElement(ServicesContext.Provider, { value: servicesB }, createElement(IntentPanel)));

    // The aborted run's finally is skipped (signal aborted) — the recovery
    // reset must reopen the gate anyway.
    await waitFor(() => expect(screen.getByRole("button", { name: /^GENERATE$/ })).toBeEnabled());

    // Settle the hung fake so no promise leaks past the test.
    settle(new Error("settled by test"));
    await waitFor(() => expect(screen.getByRole("button", { name: /^GENERATE$/ })).toBeEnabled());
  });
});
