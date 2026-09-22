import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ErrorBoundary } from "../src/ui/ErrorBoundary";
import { attachProcessorErrorGuard, processorErrorCount } from "../src/audio-worklets/processor-errors";

/**
 * GOAL 07 — fault-containment behavior pins: a throwing subtree stays
 * inside its boundary (panel retry UI / crash screen), crash-save fires,
 * chunk-staleness gets the reload affordance, and runtime worklet
 * processor errors are counted, never silent.
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
});
