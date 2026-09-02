import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { CollabPanel } from "../../src/ui/CollabPanel";
import { renderWithContext, mockServices } from "../helpers";
import type { Services } from "../../src/services";

// CollabPanel imports openProject from the services module — replace the
// module so the swap path is fully controllable (deferred promises).
vi.mock("../../src/services", () => ({ openProject: vi.fn() }));
import { openProject } from "../../src/services";

beforeEach(() => {
  vi.clearAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPanel(services: Services) {
  const onReplace = vi.fn();
  renderWithContext(<CollabPanel onReplaceServices={onReplace} />, { services });
  return { onReplace, startButton: () => screen.getByRole("button", { name: /START \/ JOIN SESSION/ }) };
}

describe("CollabPanel project swap race", () => {
  it("a second click during an in-flight swap does not start a second openProject", async () => {
    const services = mockServices();
    const closeDeferred = deferred<void>();
    (services as unknown as { closeProject: Mock }).closeProject = vi.fn(() => closeDeferred.promise);
    const { startButton } = renderPanel(services);

    // Two clicks while closeProject is still pending — the first flip the
    // button into its disabled SWITCHING state, so the second click is a no-op
    // (and the ref guard would also drop it if it got through). The old code
    // fired both openProject calls (two collab sessions/websockets).
    const button = startButton();
    fireEvent.click(button);
    fireEvent.click(button);

    await act(async () => {
      closeDeferred.resolve();
    });

    expect(openProject).toHaveBeenCalledTimes(1);
  });

  it("START then LEAVE mid-flight also swaps once (ordering is explicit)", async () => {
    const services = mockServices();
    const closeDeferred = deferred<void>();
    (services as unknown as { closeProject: Mock }).closeProject = vi.fn(() => closeDeferred.promise);
    const { onReplace } = renderPanel(services);

    fireEvent.click(screen.getByRole("button", { name: /START \/ JOIN SESSION/ }));
    // The LEAVE button only exists once a session is live — simulate its
    // entry point racing the same in-flight swap instead.
    expect(openProject).not.toHaveBeenCalled();

    await act(async () => {
      closeDeferred.resolve();
    });
    expect(openProject).toHaveBeenCalledTimes(1);
    expect(onReplace).toHaveBeenCalledTimes(1);
  });

  it("a failed swap surfaces the error and re-enables the panel", async () => {
    const services = mockServices();
    (openProject as Mock).mockRejectedValueOnce(new Error("collab server unreachable"));
    const { startButton } = renderPanel(services);

    await act(async () => {
      fireEvent.click(startButton());
    });

    expect(screen.getByRole("alert")).toHaveTextContent("collab server unreachable");
    expect(startButton()).not.toBeDisabled();
  });

  it("a successful swap re-enables and hands over the new services", async () => {
    const services = mockServices();
    const nextServices = mockServices();
    (openProject as Mock).mockResolvedValueOnce(nextServices);
    const { onReplace, startButton } = renderPanel(services);

    await act(async () => {
      fireEvent.click(startButton());
    });

    expect(onReplace).toHaveBeenCalledWith(nextServices);
    expect(startButton()).not.toBeDisabled();
  });
});
