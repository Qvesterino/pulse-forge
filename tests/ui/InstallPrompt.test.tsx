import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { InstallPrompt } from "../../src/ui/InstallPrompt";

const DISMISS_KEY = "pulse-forge.install.dismissed.v1";

function fireBeforeInstallPrompt() {
  const event = new Event("beforeinstallprompt") as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  };
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome: "accepted" });
  act(() => {
    window.dispatchEvent(event);
    // React state update from the listener needs a flush
  });
  return event;
}

beforeEach(() => {
  localStorage.clear();
});

describe("InstallPrompt", () => {
  it("renders nothing before the browser fires beforeinstallprompt", () => {
    const { container } = render(<InstallPrompt />);
    expect(container.querySelector(".install-prompt")).not.toBeInTheDocument();
  });

  it("renders nothing in browsers that never fire the event (iOS)", () => {
    render(<InstallPrompt />);
    // no event fired — banner must stay hidden
    expect(screen.queryByText("Install KYX")).not.toBeInTheDocument();
  });

  it("shows the banner after beforeinstallprompt fires", () => {
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    expect(screen.getByText("Install KYX")).toBeInTheDocument();
  });

  it("INSTALL button triggers the native prompt and hides on accept", async () => {
    render(<InstallPrompt />);
    const event = fireBeforeInstallPrompt();
    fireEvent.click(screen.getByRole("button", { name: "INSTALL" }));
    // prompt() is called synchronously by the handler
    expect(event.prompt).toHaveBeenCalled();
    // userChoice resolves as accepted → banner hides
    await act(async () => {
      await event.userChoice;
    });
    expect(screen.queryByText("Install KYX")).not.toBeInTheDocument();
  });

  it("dismissal persists to localStorage and stays hidden on remount", () => {
    const { unmount } = render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    fireEvent.click(screen.getByLabelText("Dismiss install prompt"));
    expect(localStorage.getItem(DISMISS_KEY)).toBeTruthy();
    unmount();

    // Fresh mount after dismissal — event fires but banner stays hidden
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    expect(screen.queryByText("Install KYX")).not.toBeInTheDocument();
  });

  it("hides on appinstalled even without a click", () => {
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    expect(screen.getByText("Install KYX")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    expect(screen.queryByText("Install KYX")).not.toBeInTheDocument();
  });
});
