import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rulerStepFromX } from "../src/ui/sequencerRuler";
import { Transport } from "../src/transport/Transport";
import { PlaybackController } from "../src/services";

/**
 * AUDIT 02 — Transport regression invariants
 * (prompts/daw_qa_reliability_vault/02-transport-audit.md).
 *
 * The Transport/Scheduler cores were hardened in the earlier reliability
 * pass; this suite pins the Audit-02 SURFACE fixes: the ruler scroll math,
 * the remote-pulse UI notification, and the key-repeat transport guards.
 */

/* ── D1: ruler scroll double-count ──────────────────────────────────── */

describe("rulerStepFromX — scrolled ruler mapping (audit 02)", () => {
  // Geometry: label 172px + gap 4; stride 30px + gap 4 (zoom ×1); 64 steps.
  const STRIDE = 30 + 4;
  const LABEL = 172 + 4;
  const STEPS = 64;

  it("maps a click to the same step regardless of horizontal scroll", () => {
    // The ruler rect moves WITH the content — rect.left already encodes the
    // scroll. The same viewport click must resolve identically at scroll 0
    // and scroll 1200 (pre-fix: +scrollLeft double-counted → step ~80→63).
    const scrolledLeft = -1200; // rect.left shifts left as the user scrolls right
    const atRest = rulerStepFromX(250, 0, STRIDE, LABEL, STEPS);
    const scrolled = rulerStepFromX(250, scrolledLeft, STRIDE, LABEL, STEPS);
    expect(atRest).toBe(Math.floor((250 - LABEL) / STRIDE));
    expect(scrolled).toBe(Math.floor((250 + 1200 - LABEL) / STRIDE));
    expect(scrolled).not.toBe(STEPS - 1); // must NOT clamp to the last step
  });

  it("clamps to [0, stepCount-1] and rejects junk geometry", () => {
    expect(rulerStepFromX(-9999, 0, STRIDE, LABEL, STEPS)).toBe(0);
    expect(rulerStepFromX(999999, 0, STRIDE, LABEL, STEPS)).toBe(STEPS - 1);
    expect(rulerStepFromX(Number.NaN, 0, STRIDE, LABEL, STEPS)).toBeNull();
    expect(rulerStepFromX(100, 0, 0, LABEL, STEPS)).toBeNull();
    expect(rulerStepFromX(100, 0, STRIDE, LABEL, 0)).toBeNull();
  });

  it("the live handler no longer adds scroller.scrollLeft (source pin)", () => {
    const source = readFileSync(resolve(process.cwd(), "src/ui/Sequencer.tsx"), "utf8");
    const start = source.indexOf("const rulerStepFromEvent");
    const end = source.indexOf("const onRulerPointerDown", start);
    const body = source.slice(start, end);
    expect(body).toContain("rulerStepFromX(");
    // Pin the CODE, not the explanatory comment that mentions the history.
    expect(body, "scrollLeft must not re-enter the ruler mapping").not.toMatch(/\+\s*scroller\.scrollLeft/);
  });
});

/* ── D3: remote transport pulse notifies UI subscribers ─────────────── */

describe("PlaybackController.notifyForRemoteTransportChange (audit 02)", () => {
  it("re-broadcasts to subscribers after an outside transport mutation", () => {
    const transport = new Transport({ now: () => 0 }, 120);
    const controller = new PlaybackController(
      {} as never,
      transport,
      {} as never,
      { mode: "pattern" },
      () => ({}) as never,
      () => {},
    );
    const listener = vi.fn();
    controller.subscribe(listener);
    // A collab pulse flipped the transport outside the controller:
    transport.play();
    expect(listener).not.toHaveBeenCalled(); // nothing notified it yet
    controller.notifyForRemoteTransportChange();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

/* ── D4: key-repeat transport guards (source pins) ──────────────────── */

describe("key-repeat transport guards (audit 02)", () => {
  it("App dispatch skips repeat for transport shortcuts", () => {
    const source = readFileSync(resolve(process.cwd(), "src/ui/App.tsx"), "utf8");
    const start = source.indexOf("const matched = matchShortcut(event);");
    const guard = source.slice(start, start + 900);
    expect(guard).toContain("event.repeat");
    for (const key of ["playPause", "stop", "seekHome", "seekBack", "seekForward"]) {
      expect(guard).toContain(`"${key}"`);
    }
  });

  it("TopBar loop toggle + assist shortcuts are repeat-guarded", () => {
    const source = readFileSync(resolve(process.cwd(), "src/ui/TopBar.tsx"), "utf8");
    const loopStart = source.indexOf('matchShortcut(event) === "toggleLoop"');
    expect(source.slice(loopStart, loopStart + 200)).toContain("event.repeat");
  });
});

/* ── D2: ruler label-cell buttons must not phantom-seek (source pin) ── */

describe("ruler label-cell guard (audit 02)", () => {
  it("onRulerPointerDown ignores clicks on embedded buttons (FOCUS / ?)", () => {
    const source = readFileSync(resolve(process.cwd(), "src/ui/Sequencer.tsx"), "utf8");
    const start = source.indexOf("const onRulerPointerDown");
    const body = source.slice(start, start + 700);
    expect(body).toContain('closest("button")');
  });
});

/* ── D5: ruler seek goes through the controller (source pin) ────────── */

describe("ruler seek path (audit 02)", () => {
  it("onRulerPointerDown uses services.playback.seek, not raw transport.seek", () => {
    const source = readFileSync(resolve(process.cwd(), "src/ui/Sequencer.tsx"), "utf8");
    const start = source.indexOf("const onRulerPointerDown");
    const body = source.slice(start, start + 1200);
    expect(body).toContain("services.playback.seek(");
    expect(body).not.toContain("services.transport.seek(");
  });
});
