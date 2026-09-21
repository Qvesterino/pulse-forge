import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../../src/ui/ErrorBoundary";

function BrokenComponent(): React.ReactElement {
  throw new Error("test crash");
}

function GoodComponent(): React.ReactElement {
  return <div>alive</div>;
}

describe("ErrorBoundary", () => {
  it("renders children when no error", () => {
    render(
      <ErrorBoundary>
        <GoodComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText("alive")).toBeInTheDocument();
  });

  it("catches error and shows crash screen", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText("KYX crashed")).toBeInTheDocument();
    expect(screen.getByText(/Your work has been saved/)).toBeInTheDocument();
    spy.mockRestore();
  });

  it("shows error message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText("test crash")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("calls onCrashSave when error occurs", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onCrashSave = vi.fn();
    render(
      <ErrorBoundary onCrashSave={onCrashSave}>
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(onCrashSave).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("shows reload button", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: /Reload/ })).toBeInTheDocument();
    spy.mockRestore();
  });

  it("panel mode: a plain crash offers only Retry", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary panel="mixer">
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload app" })).toBeNull();
    spy.mockRestore();
  });

  it("panel mode: a stale-deploy chunk failure offers Reload app (retry alone cannot recover)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function StaleChunk(): React.ReactElement {
      throw new Error("Failed to fetch dynamically imported module: /assets/Mixer-abc123.js");
    }
    render(
      <ErrorBoundary panel="mixer">
        <StaleChunk />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/app was updated since this tab loaded/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload app" })).toBeInTheDocument();
    // Retry stays available for transient network failures.
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    spy.mockRestore();
  });

  it("route mode: crashNote replaces the studio's saved-work line (embed/gallery hold no local work)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary crashNote="The gallery hit an error. Reload to try again.">
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText("The gallery hit an error. Reload to try again.")).toBeInTheDocument();
    expect(screen.queryByText(/Your work has been saved/)).toBeNull();
    spy.mockRestore();
  });
});
