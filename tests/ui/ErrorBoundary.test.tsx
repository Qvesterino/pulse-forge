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
    render(<ErrorBoundary><GoodComponent /></ErrorBoundary>);
    expect(screen.getByText("alive")).toBeInTheDocument();
  });

  it("catches error and shows crash screen", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ErrorBoundary><BrokenComponent /></ErrorBoundary>);
    expect(screen.getByText("PulseForge crashed")).toBeInTheDocument();
    expect(screen.getByText(/Your work has been saved/)).toBeInTheDocument();
    spy.mockRestore();
  });

  it("shows error message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ErrorBoundary><BrokenComponent /></ErrorBoundary>);
    expect(screen.getByText("test crash")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("calls onCrashSave when error occurs", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onCrashSave = vi.fn();
    render(<ErrorBoundary onCrashSave={onCrashSave}><BrokenComponent /></ErrorBoundary>);
    expect(onCrashSave).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("shows reload button", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ErrorBoundary><BrokenComponent /></ErrorBoundary>);
    expect(screen.getByRole("button", { name: /Reload/ })).toBeInTheDocument();
    spy.mockRestore();
  });
});
