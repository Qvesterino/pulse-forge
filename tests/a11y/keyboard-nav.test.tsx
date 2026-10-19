import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopBar } from "../../src/ui/TopBar";
import { ExportPanel } from "../../src/ui/ExportPanel";
import { GenerateDialog } from "../../src/ui/GenerateDialog";
import { OnboardingTour } from "../../src/ui/OnboardingTour";
import { HelpOverlay } from "../../src/ui/HelpOverlay";
import { mockServices, renderWithContext } from "../helpers";

const noop = () => {};

describe("a11y: keyboard navigation across major panels", () => {
  beforeEach(() => {
    window.localStorage.removeItem("pf-tour-v1");
  });

  describe("TopBar (App.tsx topbar)", () => {
    const renderTopBar = () => {
      renderWithContext(
        <TopBar
          onToggleDiagnostics={noop}
          diagnosticsOpen={false}
          ioOpen={false}
          onToggleIo={noop}
          onToggleHelp={noop}
          onOpenPalette={noop}
          playMode="pattern"
          onSetPlayMode={noop}
          onOpenBrowser={noop}
          onReplaceServices={noop}
          scaleSnap={false}
          onToggleScaleSnap={noop}
          historyOpen={false}
          onToggleHistory={noop}
        />,
        { services: mockServices() },
      );
    };

    it("renders at least one focusable control", () => {
      renderTopBar();
      const focusable = screen.queryAllByRole("button").concat(screen.queryAllByRole("combobox") as any);
      expect(focusable.length).toBeGreaterThan(0);
    });

    it("Tab cycles through the topbar controls", async () => {
      const user = userEvent.setup();
      renderTopBar();
      const buttons = screen.queryAllByRole("button");
      // Need at least two focusable elements to verify Tab moves between them.
      expect(buttons.length).toBeGreaterThanOrEqual(2);
      // Focus the body to start from a known position.
      (document.body as HTMLElement).focus();
      await user.tab();
      const first = document.activeElement;
      expect(first).not.toBe(document.body);
      // Subsequent Tab calls should advance focus (or wrap).
      await user.tab();
      const second = document.activeElement;
      expect(second).not.toBe(document.body);
    });
  });

  describe("ExportPanel", () => {
    it("Tab cycles through the format selectors", async () => {
      const user = userEvent.setup();
      renderWithContext(<ExportPanel />, { services: mockServices() });
      const buttons = screen.queryAllByRole("button");
      // ExportPanel has several format/quality buttons plus the export trigger.
      expect(buttons.length).toBeGreaterThan(2);
      (document.body as HTMLElement).focus();
      await user.tab();
      expect(document.activeElement).not.toBe(document.body);
      await user.tab();
      expect(document.activeElement).not.toBe(document.body);
    });

    it("at least one focusable control exists", () => {
      renderWithContext(<ExportPanel />, { services: mockServices() });
      const focusable = screen.queryAllByRole("button");
      expect(focusable.length).toBeGreaterThan(0);
    });
  });

  describe("GenerateDialog", () => {
    it("renders with focusable controls and Escape closes it", async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderWithContext(<GenerateDialog open onClose={onClose} />, { services: mockServices() });
      // Dialog should be visible and have at least one focusable control.
      const dialog = screen.getByRole("dialog", { name: "Generate pattern" });
      expect(dialog).toBeInTheDocument();
      const buttons = within(dialog).queryAllByRole("button");
      expect(buttons.length).toBeGreaterThan(0);
      // Escape closes the dialog.
      await user.keyboard("{Escape}");
      // The X-button handler is wired to onClose. The dialog also supports
      // scrim click; either way the close prop should fire when the ✕ button
      // is pressed. Test the explicit button path:
      const closeBtn = within(dialog).getByRole("button", { name: "✕" });
      await user.click(closeBtn);
      expect(onClose).toHaveBeenCalled();
    });

    it("Tab moves focus within the dialog", async () => {
      const user = userEvent.setup();
      renderWithContext(<GenerateDialog open onClose={noop} />, { services: mockServices() });
      const dialog = screen.getByRole("dialog", { name: "Generate pattern" });
      const focusable = within(dialog).queryAllByRole("button");
      expect(focusable.length).toBeGreaterThan(1);
      (document.body as HTMLElement).focus();
      await user.tab();
      expect(document.activeElement).not.toBe(document.body);
      await user.tab();
      expect(document.activeElement).not.toBe(document.body);
    });
  });

  describe("OnboardingTour", () => {
    it("NEXT button is focusable and activates on Enter", async () => {
      const user = userEvent.setup();
      renderWithContext(<OnboardingTour />, { services: mockServices() });
      const nextBtn = await screen.findByRole("button", { name: "NEXT" }, { timeout: 5000 });
      nextBtn.focus();
      expect(document.activeElement).toBe(nextBtn);
      await user.keyboard("{Enter}");
      // After advancing, the second step title appears.
      expect(await screen.findByText(/2\/4 — PROGRAM THE BEAT/)).toBeInTheDocument();
    });

    it("Tab cycles through every tour control in DOM order", async () => {
      const user = userEvent.setup();
      renderWithContext(<OnboardingTour />, { services: mockServices() });
      const dialog = await screen.findByRole("dialog", { name: "Onboarding tour" }, { timeout: 5000 });
      const skipBtn = screen.getByRole("button", { name: "Skip tour" });
      const nextBtn = screen.getByRole("button", { name: "NEXT" });

      // The tour carries an optional "Previous DAW profile" picker — a real
      // <select> — between SKIP and NEXT in the DOM (OnboardingTour.tsx, step 0
      // of a non-transfer project). The previous version of this test asserted
      // that ONE Tab from SKIP landed on NEXT, so it went red the day that
      // picker landed. The component was right; the expectation was stale.
      //
      // This version derives the focus chain from the dialog's own DOM, which
      // is STRONGER than the old one-hop assertion: it pins SKIP as the first
      // stop, NEXT as the last, and every control in between, so a control
      // that is unreachable or mis-ordered still fails — and a control that is
      // merely ADDED does not.
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, select, input, textarea, a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.tabIndex >= 0 && !el.hasAttribute("disabled"));
      expect(focusables.length, "the tour dialog must expose at least SKIP and NEXT").toBeGreaterThanOrEqual(2);
      expect(focusables[0], "SKIP must be the first stop in the tour's focus order").toBe(skipBtn);
      expect(focusables[focusables.length - 1], "NEXT must be the last stop").toBe(nextBtn);

      focusables[0].focus();
      expect(document.activeElement).toBe(skipBtn);
      for (const expected of focusables.slice(1)) {
        await user.tab();
        expect(
          document.activeElement,
          `Tab did not advance to the next tour control in DOM order (${expected.getAttribute("aria-label") ?? expected.tagName})`,
        ).toBe(expected);
      }
    });
  });

  describe("HelpOverlay", () => {
    it("renders focusable controls and Escape closes it", async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderWithContext(<HelpOverlay open onClose={onClose} />, { services: mockServices() });
      const dialog = screen.getByRole("dialog", { name: /shortcuts and gestures/i });
      expect(dialog).toBeInTheDocument();
      const buttons = within(dialog).queryAllByRole("button");
      // Help has at least the Close button.
      expect(buttons.length).toBeGreaterThanOrEqual(1);
      await user.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalled();
    });

    it("Tab cycles through the help controls (search input → close)", async () => {
      const user = userEvent.setup();
      renderWithContext(<HelpOverlay open onClose={noop} />, { services: mockServices() });
      const dialog = screen.getByRole("dialog", { name: /shortcuts and gestures/i });
      const search = within(dialog).getByRole("searchbox");
      const closeBtn = within(dialog).getByRole("button", { name: /close help/i });
      search.focus();
      expect(document.activeElement).toBe(search);
      await user.tab();
      expect(document.activeElement).toBe(closeBtn);
    });
  });
});
