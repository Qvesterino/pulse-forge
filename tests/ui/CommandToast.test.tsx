import { describe, expect, it } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { CommandToast } from "../../src/ui/CommandToast";
import { ServicesContext } from "../../src/ui/context";
import { mockServices } from "../helpers";

function toastServices(label: string | null, undoLen = 1) {
  const s = mockServices();
  (s.store as any).lastCommandLabel = label;
  (s.store as any).undoStackLength = undoLen;
  return s;
}

describe("CommandToast", () => {
  it("renders nothing when no command", () => {
    const services = toastServices(null);
    const { container } = render(
      <ServicesContext.Provider value={services}>
        <CommandToast />
      </ServicesContext.Provider>,
    );
    expect(container.querySelector(".command-toast")).not.toBeInTheDocument();
  });

  it("shows label when store notifies", async () => {
    const services = toastServices(null);
    render(
      <ServicesContext.Provider value={services}>
        <CommandToast />
      </ServicesContext.Provider>,
    );
    // Simulate store notification with a command
    (services.store as any).lastCommandLabel = "Add Track";
    (services.store as any).undoStackLength = 1;
    act(() => {
      (services.store as any)._emit();
    });
    expect(screen.getByText("Add Track")).toBeInTheDocument();
  });

  it("has correct aria attributes when visible", async () => {
    const services = toastServices(null);
    render(
      <ServicesContext.Provider value={services}>
        <CommandToast />
      </ServicesContext.Provider>,
    );
    (services.store as any).lastCommandLabel = "Bounce";
    (services.store as any).undoStackLength = 1;
    act(() => {
      (services.store as any)._emit();
    });
    const el = screen.getByRole("status");
    expect(el).toHaveAttribute("aria-live", "polite");
    expect(el).toHaveAttribute("aria-atomic", "true");
  });
});

describe("CommandToast consequence detail", () => {
  it("shows the detail line when the last command cleaned something up", () => {
    const services = mockServices();
    (services.store as any).lastCommandLabel = "Remove EQ";
    (services.store as any).lastCommandDetail = "2 automation/modulation references cleaned up";
    (services.store as any).undoStackLength = 1;
    render(
      <ServicesContext.Provider value={services}>
        <CommandToast />
      </ServicesContext.Provider>,
    );
    act(() => {
      (services.store as any)._emit();
    });
    expect(screen.getByText("Remove EQ")).toBeInTheDocument();
    expect(screen.getByText("2 automation/modulation references cleaned up")).toBeInTheDocument();
  });

  it("renders single-line when the command had no detail", () => {
    const services = mockServices();
    (services.store as any).lastCommandLabel = "Add Track";
    (services.store as any).lastCommandDetail = null;
    (services.store as any).undoStackLength = 1;
    render(
      <ServicesContext.Provider value={services}>
        <CommandToast />
      </ServicesContext.Provider>,
    );
    const { container } = render(
      <ServicesContext.Provider value={services}>
        <CommandToast />
      </ServicesContext.Provider>,
    );
    act(() => {
      (services.store as any)._emit();
    });
    expect(screen.getByText("Add Track")).toBeInTheDocument();
    expect(container.querySelector(".command-toast-detail")).toBeNull();
  });
});
