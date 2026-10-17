import { describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { createElement } from "react";
import { App } from "../src/ui/App";
import { Mixer } from "../src/ui/Mixer";
import { ArrangementPanel } from "../src/ui/ArrangementPanel";
import { IntentPanel } from "../src/ui/IntentPanel";
import { mockServices, renderWithContext } from "./helpers";
import type { Services } from "../src/services";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";

/**
 * ACCESSIBILITY GATE (Prestige plan §3.1) — the four primary surfaces.
 *
 * What this gates, and its honest limits:
 *  - CRITICAL + SERIOUS axe violations must be ZERO on the app shell, the mixer,
 *    the arrangement and the intent panel. Three real defects were fixed to earn
 *    this: an orphan `role="row"` with no grid parent (Sequencer), a `role="meter"`
 *    whose `aria-valuenow` only arrived on the first rAF tick (Meter), and an
 *    `aria-label` on a bare div (the arrangement's chord lane).
 *  - Every interactive control must carry a NON-EMPTY accessible name — the
 *    icon-button class of defect, checked independently of axe.
 *  - MODERATE + MINOR are pinned at zero as well; a new one fails the gate.
 *  - NOT gated: `color-contrast` (jsdom has no layout, so the rule cannot run)
 *    and axe's `incomplete` bucket ("could not evaluate"). Neither is claimed as
 *    checked anywhere. Focus order and keyboard operability per surface are
 *    covered by the existing keyboard specs (App shortcuts in tests/ui/App.test.tsx,
 *    the sequencer/piano-roll key paths, the arrangement gesture suites); this
 *    gate does not re-assert them.
 */

const SERIOUS_IMPACTS = new Set(["critical", "serious", "moderate", "minor"]);

async function audit(container: HTMLElement): Promise<{ blocking: string[]; all: number }> {
  const results = await axe.run(container, {
    // jsdom cannot compute contrast (no layout) — excluded, and never implied.
    rules: { "color-contrast": { enabled: false }, "color-contrast-enhanced": { enabled: false } },
  });
  const blocking = results.violations
    .filter((violation) => SERIOUS_IMPACTS.has(violation.impact ?? ""))
    .map((violation) => `${violation.impact}:${violation.id}×${violation.nodes.length}`);
  return { blocking, all: results.violations.length };
}

function unnamedControls(container: HTMLElement): string[] {
  const controls = container.querySelectorAll<HTMLElement>("button, [role=button], input, select, textarea, [role=slider]");
  const unnamed: string[] = [];
  for (const control of controls) {
    const name =
      control.getAttribute("aria-label") ??
      control.getAttribute("title") ??
      control.textContent ??
      "";
    if (name.trim() === "") unnamed.push(control.outerHTML.slice(0, 90));
  }
  return unnamed;
}

function shell() {
  const services = mockServices();
  return renderWithContext(createElement(App, { services, onOpenBrowser: () => {}, onReplaceServices: () => {} }), {
    services,
  });
}

function mixer() {
  const doc = createProjectFromTemplate("house");
  const services = { ...mockServices(doc), store: new ProjectStore(doc) } as unknown as Services;
  (services.engine as unknown as { previewTrackGain: unknown }).previewTrackGain = vi.fn();
  return renderWithContext(createElement(Mixer), { services });
}

function arrangement() {
  return renderWithContext(createElement(ArrangementPanel));
}

function intent() {
  return renderWithContext(createElement(IntentPanel));
}

describe("accessibility gate — four primary surfaces", () => {
  it("app shell: no critical/serious/moderate/minor violations, and every control is named", async () => {
    const { container } = shell();
    const { blocking, all } = await audit(container);
    expect(blocking, `axe blocking violations: ${blocking.join(", ")}`).toEqual([]);
    expect(all).toBe(0);
    expect(unnamedControls(container)).toEqual([]);
  }, 60000);

  it("mixer: no blocking violations, and every control is named", async () => {
    const { container } = mixer();
    const { blocking, all } = await audit(container);
    expect(blocking, `axe blocking violations: ${blocking.join(", ")}`).toEqual([]);
    expect(all).toBe(0);
    expect(unnamedControls(container)).toEqual([]);
  }, 60000);

  it("arrangement: no blocking violations, and every control is named", async () => {
    const { container } = arrangement();
    const { blocking, all } = await audit(container);
    expect(blocking, `axe blocking violations: ${blocking.join(", ")}`).toEqual([]);
    expect(all).toBe(0);
    expect(unnamedControls(container)).toEqual([]);
  }, 60000);

  it("intent panel: no blocking violations, and every control is named", async () => {
    const { container } = intent();
    const { blocking, all } = await audit(container);
    expect(blocking, `axe blocking violations: ${blocking.join(", ")}`).toEqual([]);
    expect(all).toBe(0);
    expect(unnamedControls(container)).toEqual([]);
  }, 60000);
});
