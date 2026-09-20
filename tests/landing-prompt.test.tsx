import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LandingPrompt } from "../src/landing/LandingPrompt";
import { templateForPrompt, generateLandingBeat } from "../src/landing/landingBeat";
import {
  INTENT_PREFILL_KEY,
  clearPendingHandoff,
  peekPendingHandoff,
  savePendingHandoff,
  stashIntentPrefill,
  takeIntentPrefill,
  takePendingHandoff,
} from "../src/landing/handoff";
import { funnelCounts, funnelEvent } from "../src/services/funnel";
import { decodeShareCode } from "../src/export/shareCode";

/* ------------------------------------------------------------------ */
/* handoff — sessionStorage round-trip (A1)                            */
/* ------------------------------------------------------------------ */

describe("landing handoff", () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it("save → take round-trips the code and prompt; take is destructive", () => {
    savePendingHandoff({ code: "CODE123", prompt: "dark trap 140" });
    expect(takePendingHandoff()).toEqual({ code: "CODE123", prompt: "dark trap 140" });
    expect(takePendingHandoff()).toBeNull(); // reload after open must not re-import
  });

  it("peek reads without clearing — StrictMode's cancelled first effect run must not swallow the handoff", () => {
    savePendingHandoff({ code: "CODE123", prompt: "dark trap 140" });
    expect(peekPendingHandoff()).toEqual({ code: "CODE123", prompt: "dark trap 140" });
    expect(peekPendingHandoff()).toEqual({ code: "CODE123", prompt: "dark trap 140" }); // still there
    clearPendingHandoff();
    expect(peekPendingHandoff()).toBeNull();
  });

  it("corrupt handoff payloads degrade to null instead of blocking studio entry", () => {
    sessionStorage.setItem("pf-handoff", "{not json");
    expect(takePendingHandoff()).toBeNull();
    sessionStorage.setItem("pf-handoff", JSON.stringify({ code: 42 }));
    expect(takePendingHandoff()).toBeNull();
  });

  it("intent prefill take is destructive and rejects blank prompts", () => {
    stashIntentPrefill("  ");
    expect(takeIntentPrefill()).toBeNull();
    stashIntentPrefill("lo-fi chill 85");
    expect(takeIntentPrefill()).toBe("lo-fi chill 85");
    expect(takeIntentPrefill()).toBeNull();
    expect(sessionStorage.getItem(INTENT_PREFILL_KEY)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* funnel — local counters (A4-lite)                                   */
/* ------------------------------------------------------------------ */

describe("funnel events", () => {
  it("counts events per name in localStorage", () => {
    funnelEvent("landing_prompt_forged");
    funnelEvent("landing_prompt_forged");
    funnelEvent("landing_forged_to_studio");
    const counts = funnelCounts();
    expect(counts.landing_prompt_forged).toBe(2);
    expect(counts.landing_forged_to_studio).toBe(1);
  });

  it("ignores malformed event names", () => {
    const before = funnelCounts();
    funnelEvent("");
    funnelEvent("x".repeat(100));
    expect(funnelCounts()).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* landingBeat — template mapping + real generation (A1)               */
/* ------------------------------------------------------------------ */

describe("templateForPrompt", () => {
  it("maps genre words to templates and defaults to house", () => {
    expect(templateForPrompt("dark trap 140")).toBe("trap");
    expect(templateForPrompt("hard techno 145")).toBe("techno");
    expect(templateForPrompt("uk garage 133")).toBe("ukg");
    expect(templateForPrompt("lo-fi chill 85")).toBe("ambient");
    expect(templateForPrompt("sunny deep 124")).toBe("house");
    expect(templateForPrompt("")).toBe("house");
  });
});

describe("generateLandingBeat", () => {
  it("forges a real document: named from the prompt, generated content, share-code round-trip", async () => {
    const beat = await generateLandingBeat("dark trap 140");
    expect(beat.template).toBe("trap");
    expect(beat.doc.name).toBe("dark trap 140");
    // The winning proposal was applied — at least one pattern carries
    // generated steps (the engine never returns a rejected empty doc).
    const active = beat.doc.patterns.find((p) => p.id === beat.doc.activePatternId);
    expect(active).toBeDefined();
    const hasContent = Object.values(active!.rows).some((row) => row.some((v) => v > 0));
    expect(hasContent).toBe(true);
    // The doc travels: encode → decode must preserve the forged project.
    const decoded = decodeShareCode(
      // round-trip through the same encode the preview player uses
      (await import("../src/export/shareCode")).encodeShareCode(beat.doc),
    );
    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe("dark trap 140");
  }, 30000);

  it("a blank-ish prompt still forges (house fallback) without throwing", async () => {
    const beat = await generateLandingBeat("beat");
    expect(beat.doc.patterns.length).toBeGreaterThan(0);
  }, 30000);
});

/* ------------------------------------------------------------------ */
/* LandingPrompt component — forge → handoff wiring                    */
/* ------------------------------------------------------------------ */

describe("LandingPrompt", () => {
  it("forge generates, then Open in studio hands the beat off and enters", async () => {
    const onEnterStudio = vi.fn();
    render(<LandingPrompt onEnterStudio={onEnterStudio} />);

    const input = screen.getByLabelText(/describe the beat you want/i);
    fireEvent.change(input, { target: { value: "dark trap 140" } });
    fireEvent.click(screen.getByRole("button", { name: /forge it/i }));

    // Generation is real (fast, deterministic local provider) — wait it out.
    const openBtn = await screen.findByRole("button", { name: /open in studio/i }, { timeout: 20000 });
    // Forged preview is on screen (jsdom shows an EmbedApp phase, not audio).
    expect(document.querySelector(".landing-prompt .landing-hero-player .embed-root")).not.toBeNull();

    fireEvent.click(openBtn);
    expect(onEnterStudio).toHaveBeenCalledTimes(1);
    const handoff = takePendingHandoff();
    expect(handoff).not.toBeNull();
    expect(handoff!.prompt).toBe("dark trap 140");
    expect(handoff!.code.length).toBeGreaterThan(16);
  }, 30000);

  it("a normal prompt resolves with busy-state cleared and no error alert", async () => {
    const onEnterStudio = vi.fn();
    render(<LandingPrompt onEnterStudio={onEnterStudio} />);
    const input = screen.getByLabelText(/describe the beat you want/i);
    fireEvent.change(input, { target: { value: "sunny house 124" } });
    fireEvent.click(screen.getByRole("button", { name: /forge it/i }));
    await waitFor(
      () => {
        expect(screen.queryByText(/composing your beat/i)).toBeNull();
      },
      { timeout: 20000 },
    );
    expect(screen.queryByRole("alert")).toBeNull();
  }, 30000);
});
