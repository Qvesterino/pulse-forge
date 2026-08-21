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
      <ServicesContext.Provider value={services}><CommandToast /></ServicesContext.Provider>,
    );
    expect(container.querySelector(".command-toast")).not.toBeInTheDocument();
  });

  it("shows label when store notifies", async () => {
    const services = toastServices(null);
    render(
      <ServicesContext.Provider value={services}><CommandToast /></ServicesContext.Provider>,
    );
    // Simulate store notification with a command
    (services.store as any).lastCommandLabel = "Add Track";
    (services.store as any).undoStackLength = 1;
    act(() => { (services.store as any)._emit(); });
    expect(screen.getByText("Add Track")).toBeInTheDocument();
  });

  it("has correct aria attributes when visible", async () => {
    const services = toastServices(null);
    render(
      <ServicesContext.Provider value={services}><CommandToast /></ServicesContext.Provider>,
    );
    (services.store as any).lastCommandLabel = "Bounce";
    (services.store as any).undoStackLength = 1;
    act(() => { (services.store as any)._emit(); });
    const el = screen.getByRole("status");
    expect(el).toHaveAttribute("aria-live", "polite");
    expect(el).toHaveAttribute("aria-atomic", "true");
  });
});
