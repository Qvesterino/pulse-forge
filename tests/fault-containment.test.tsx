import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useState } from "react";
import { ErrorBoundary } from "../src/ui/ErrorBoundary";
import { attachProcessorErrorGuard, processorErrorCount } from "../src/audio-worklets/processor-errors";

/**
 * GOAL 07 — fault-containment behavior pins: a throwing subtree stays
 * inside its boundary (panel retry UI / crash screen), crash-save fires,
 * chunk-staleness gets the reload affordance, Retry genuinely recovers a
 * transient failure and remounts fresh state, a crash card never outlives
 * the panel that caused it, and runtime worklet processor errors are
 * counted, never silent.
 *
 * Every "flaky child" here is driven by an EXTERNAL flag, never by a call
 * counter — React 18 DEV replays failed renders (pinned by the replay-contract
 * test), which makes invocation-count probes report recoveries that never
 * reached the boundary.
 */

function Bomb({ message }: { message: string }): never {
  throw new Error(message);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ErrorBoundary containment", () => {
  it("panel mode contains a throwing subtree and offers Retry", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary panel="test-panel">
        <Bomb message="render exploded" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText("test-panel crashed")).toBeDefined();
    expect(screen.getByText("render exploded")).toBeDefined();
    expect(screen.getByText("Retry")).toBeDefined();
    // No crash screen, no retry-into-reload
    expect(screen.queryByText("KYX crashed")).toBeNull();
    expect(screen.queryByText("Reload app")).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("retry re-attempts the children (still contained if they throw again)", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary panel="test-panel">
        <Bomb message="again" />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByText("Retry"));
    // The bomb throws again on re-render — boundary must re-contain, not crash the test tree.
    expect(screen.getByText("test-panel crashed")).toBeDefined();
  });

  it("retry RECOVERS when the underlying failure was transient", () => {
    // The negative retry test above passes whether or not the Retry button
    // actually recovers anything: a permanently-throwing child re-containment is
    // the same outcome as a broken reset. This is the test that separates them.
    // If `handleRetry` cleared state without remounting the children, every
    // other containment test would stay green while the button did nothing.
    //
    // The failure is driven by an EXTERNAL flag, never by a call counter: React 18
    // in DEV replays a failed render (see the replay-contract test below), so a
    // child that throws "only on the first invocation" succeeds on the replay and
    // the crash never reaches the boundary at all.
    let shouldThrow = true;
    function FlakyOnce(): React.ReactElement {
      if (shouldThrow) throw new Error("transient failure");
      return <div>recovered</div>;
    }

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary panel="test-panel">
        <FlakyOnce />
      </ErrorBoundary>,
    );
    expect(screen.getByText("test-panel crashed")).toBeDefined();

    // The failure clears on its own (a plugin finished loading, a device came back).
    // No parent re-render: recovery has to come from the boundary's own state.
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.getByText("recovered")).toBeDefined();
    expect(screen.queryByText("test-panel crashed")).toBeNull();
  });

  it("retry REMOUNTS the subtree — crashed panel state does not survive", () => {
    // Retry is a clean remount, not a resume. Measured: count 2 -> crash -> retry ->
    // count 0. If the boundary ever "recovers" by hiding the fallback instead of
    // unmounting it, a half-initialised panel comes back instead of a fresh one.
    let shouldThrow = false;
    function Stateful(): React.ReactElement {
      const [n, setN] = useState(0);
      if (shouldThrow) throw new Error("boom");
      return (
        <button type="button" onClick={() => setN(n + 1)}>
          count {n}
        </button>
      );
    }

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(
      <ErrorBoundary panel="test-panel">
        <Stateful />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "count 0" }));
    fireEvent.click(screen.getByRole("button", { name: "count 1" }));
    expect(screen.getByRole("button").textContent).toBe("count 2");

    shouldThrow = true;
    view.rerender(
      <ErrorBoundary panel="test-panel">
        <Stateful />
      </ErrorBoundary>,
    );
    expect(screen.getByText("test-panel crashed")).toBeDefined();

    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("button").textContent).toBe("count 0");
  });

  it("a crash card does NOT survive a panel swap in the same dock slot", () => {
    // Dock slots render `renderDockSlot(id)` with no `key`, so React reuses this
    // boundary instance across panel switches. Without a reset the new occupant
    // inherits the old occupant's crash card and error message — the user is told
    // "devices crashed" for an error the mixer threw.
    let crash = true;
    function MaybeBoom({ label }: { label: string }): React.ReactElement {
      if (crash) throw new Error(`${label} blew up`);
      return <div>{label} content</div>;
    }

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(
      <ErrorBoundary panel="mixer">
        <MaybeBoom label="mixer" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("mixer crashed")).toBeDefined();
    expect(screen.getByText("mixer blew up")).toBeDefined();

    crash = false;
    view.rerender(
      <ErrorBoundary panel="devices">
        <MaybeBoom label="devices" />
      </ErrorBoundary>,
    );

    expect(screen.queryByText("mixer crashed")).toBeNull();
    expect(screen.queryByText("mixer blew up")).toBeNull();
    expect(screen.getByText("devices content")).toBeDefined();
  });

  it("an explicit resetKey clears the crash even when the panel label is unchanged", () => {
    let crash = true;
    function MaybeBoom({ label }: { label: string }): React.ReactElement {
      if (crash) throw new Error(`${label} blew up`);
      return <div>{label} content</div>;
    }

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(
      <ErrorBoundary panel="rack" resetKey="track-1">
        <MaybeBoom label="track-1" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("rack crashed")).toBeDefined();

    crash = false;
    view.rerender(
      <ErrorBoundary panel="rack" resetKey="track-2">
        <MaybeBoom label="track-2" />
      </ErrorBoundary>,
    );

    expect(screen.queryByText("rack crashed")).toBeNull();
    expect(screen.getByText("track-2 content")).toBeDefined();
  });

  it("keeps the crash card when the panel identity does NOT change", () => {
    // The reset above must not become a self-healing loop: an unrelated re-render
    // of the same panel keeps showing the card instead of retrying forever.
    // Measured by child invocations, not by console.error count — React 18 DEV
    // replays a failed render, so one logical crash logs several times.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    function CountingBomb(): never {
      calls += 1;
      throw new Error("still broken");
    }

    const view = render(
      <ErrorBoundary panel="mixer">
        <CountingBomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText("mixer crashed")).toBeDefined();
    const callsAfterCrash = calls;

    view.rerender(
      <ErrorBoundary panel="mixer">
        <CountingBomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText("mixer crashed")).toBeDefined();
    expect(screen.getByText("still broken")).toBeDefined();
    // The crashed subtree was not re-attempted behind the card.
    expect(calls).toBe(callsAfterCrash);
  });

  it("REPLAY CONTRACT: a child that fails only on its first invocation never crashes", () => {
    // React 18 in DEV replays a failed render, so the throwing child is invoked
    // several times per `render()` (measured: 5 for an always-throwing child).
    // A "throw once, then succeed" child therefore succeeds on the replay and the
    // boundary never sees an error. This test exists so nobody re-introduces an
    // attempt-counter as a stand-in for a real failure — drive tests with an
    // external flag instead.
    let calls = 0;
    function ThrowOnFirst(): React.ReactElement {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return <div>replayed away</div>;
    }

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary panel="test-panel">
        <ThrowOnFirst />
      </ErrorBoundary>,
    );

    expect(screen.queryByText("test-panel crashed")).toBeNull();
    expect(screen.getByText("replayed away")).toBeDefined();
  });

  it("a recovered panel stays contained when it crashes again later", () => {
    // Recovery must not disarm the boundary: a SECOND crash in the same
    // instance must be re-contained, not escape to the route boundary.
    let shouldThrow = true;
    function Flaky(): React.ReactElement {
      if (shouldThrow) throw new Error("crash");
      return <div>alive</div>;
    }

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(
      <ErrorBoundary panel="test-panel">
        <Flaky />
      </ErrorBoundary>,
    );

    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("alive")).toBeDefined();

    // A fresh throw from the recovered subtree must be contained again.
    shouldThrow = true;
    view.rerender(
      <ErrorBoundary panel="test-panel">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText("test-panel crashed")).toBeDefined();
    expect(screen.queryByText("KYX crashed")).toBeNull();
  });

  it("chunk-load errors get the Reload-app affordance (stale deploy)", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary panel="lazy-panel">
        <Bomb message="Failed to fetch dynamically imported module: /assets/x.js" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Reload app")).toBeDefined();
    expect(screen.getByText(/app was updated since this tab loaded/)).toBeDefined();
  });

  // Every branch of the classifier matters in both directions: a miss means the
  // user is told to press Retry against a cached rejected promise (never works),
  // and a false positive means a plain render crash sends them to a full reload
  // and loses unsaved work for nothing.
  it.each([
    "Failed to fetch dynamically imported module: /assets/x.js",
    "Importing a module script failed",
    "error loading dynamically imported module",
    "Loading chunk 42 failed",
  ])("chunk-load error offers Reload: %s", (message) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary panel="lazy-panel">
        <Bomb message={message} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Reload app")).toBeDefined();
  });

  it.each([
    "TypeError: cannot read properties of undefined (reading 'id')",
    "Loading chunk 42 succeeded", // chunk marker without "failed"
    "the render failed", // "failed" without a chunk marker
    "Something else went wrong",
  ])("non-chunk error must NOT offer Reload: %s", (message) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary panel="lazy-panel">
        <Bomb message={message} />
      </ErrorBoundary>,
    );
    expect(screen.queryByText("Reload app")).toBeNull();
    expect(screen.getByText("Retry")).toBeDefined();
    expect(screen.getByText(message)).toBeDefined();
  });

  it("full-screen mode renders the crash screen and fires onCrashSave", () => {
    const onCrashSave = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary onCrashSave={onCrashSave} crashNote="The studio hit an error.">
        <Bomb message="studio blew up" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("KYX crashed")).toBeDefined();
    expect(screen.getByText("The studio hit an error.")).toBeDefined();
    expect(onCrashSave).toHaveBeenCalledTimes(1);
    // Route mode deliberately offers reload only: a studio-wide crash is not
    // something a re-render of the boundary can clear, so a Retry would be a lie.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reload" })).toBeDefined();
  });
});

describe("worklet processor-error reporter", () => {
  it("counts runtime processor errors and reports the label", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = processorErrorCount();
    const fakeNode = { onprocessorerror: null } as unknown as AudioWorkletNode;
    attachProcessorErrorGuard(fakeNode, "gate-processor");
    expect(typeof fakeNode.onprocessorerror).toBe("function");
    (fakeNode.onprocessorerror as () => void)();
    (fakeNode.onprocessorerror as () => void)();
    expect(processorErrorCount()).toBe(before + 2);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("gate-processor"));
  });

  it("re-attaching the guard to the same node does not double-count", () => {
    // The module documents the guard as idempotent per node. That only holds
    // because the handler is a property assignment. If someone "improves" this
    // into a listener list, every re-attach would inflate the diagnostic count
    // and it would quietly become a lie.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = processorErrorCount();
    const fakeNode = { onprocessorerror: null } as unknown as AudioWorkletNode;
    attachProcessorErrorGuard(fakeNode, "reverb-processor");
    attachProcessorErrorGuard(fakeNode, "reverb-processor");
    (fakeNode.onprocessorerror as () => void)();
    expect(processorErrorCount()).toBe(before + 1);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it("counts accumulate across separate nodes and labels", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = processorErrorCount();
    const nodeA = { onprocessorerror: null } as unknown as AudioWorkletNode;
    const nodeB = { onprocessorerror: null } as unknown as AudioWorkletNode;
    attachProcessorErrorGuard(nodeA, "ultina-processor");
    attachProcessorErrorGuard(nodeB, "ozvena-processor");
    (nodeA.onprocessorerror as () => void)();
    (nodeB.onprocessorerror as () => void)();
    expect(processorErrorCount()).toBe(before + 2);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("ultina-processor"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("ozvena-processor"));
  });
});
