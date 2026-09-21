import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render } from "@testing-library/react";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { parseEffectIntent } from "../../src/effect-intent/parser";
import { applyEffectIntentOnTrack } from "../../src/ui/fxAddAssistant";
import { FxAddPopover } from "../../src/ui/FxAddPopover";
import { ADDITIONAL_EFFECT_GROUPS, CORE_EFFECT_ORDER, FLAGSHIP_EFFECT_ORDER } from "../../src/effects/registry";
import type { EffectType, InstrumentTrack, ProjectDocument } from "../../src/project-model/types";

/**
 * WAVE D — one text field, two interpreters: the production concepts fold
 * onto the track (♪ row) and the assistant's effect-intent goals find or
 * add the best device and tune it (◈ row). Both rows can coexist — the
 * user picks the interpreter they meant.
 */

const DEVICES: EffectType[] = [
  ...CORE_EFFECT_ORDER,
  ...FLAGSHIP_EFFECT_ORDER,
  ...ADDITIONAL_EFFECT_GROUPS.flatMap((group) => group.types),
];

const bassTrackOf = (d: ProjectDocument): InstrumentTrack =>
  d.tracks.find((t): t is InstrumentTrack => t.kind === "instrument")!;

describe("applyEffectIntentOnTrack", () => {
  it('"more space" adds a space-capable device and tunes it — ONE undo removes it', () => {
    const doc = createProjectFromTemplate("house");
    const parsed = parseEffectIntent("more space");
    expect(parsed.status).toBe("ready");
    const intent = parsed.status === "ready" ? parsed.intent : null;
    expect(intent).not.toBeNull();

    const trackId = bassTrackOf(doc).id;
    const before = bassTrackOf(doc).effects;
    expect(before.some((f) => f.type === "reverb")).toBe(false);

    const cmd = applyEffectIntentOnTrack(doc, trackId, intent!);
    const next = cmd.execute(doc);
    const after = bassTrackOf(next);
    const fx = after.effects.find((f) => f.type === "reverb")!;
    expect(fx).toBeDefined();
    expect(Object.keys(fx.params).length).toBeGreaterThan(0);

    // ONE undo removes the added device entirely (add + tune + apply = one step).
    const restored = cmd.undo(next);
    expect(bassTrackOf(restored).effects.some((f) => f.type === "reverb")).toBe(false);
  });

  it("an existing capable device is TUNED, not duplicated", () => {
    const doc = createProjectFromTemplate("house");
    const trackId = bassTrackOf(doc).id;
    const parsed = parseEffectIntent("more space")!;
    const intent = parsed.status === "ready" ? parsed.intent : null;
    expect(intent).not.toBeNull();
    // First apply adds the device; second one tunes the SAME instance.
    const once = applyEffectIntentOnTrack(doc, trackId, intent!).execute(doc);
    const countBefore = bassTrackOf(once).effects.filter((f) => f.type === "reverb").length;
    expect(countBefore).toBe(1);
    const twice = applyEffectIntentOnTrack(once, trackId, intent!).execute(once);
    const instances = bassTrackOf(twice).effects.filter((f) => f.type === "reverb");
    expect(instances).toHaveLength(1);
  });

  it("warmth prefers the eq (tighter goal coverage tie-break)", () => {
    const doc = createProjectFromTemplate("house");
    const trackId = bassTrackOf(doc).id;
    const parsed = parseEffectIntent("make it warmer");
    expect(parsed.status).toBe("ready");
    const intent = parsed.status === "ready" ? parsed.intent : null;
    const next = applyEffectIntentOnTrack(doc, trackId, intent!).execute(doc);
    const types = bassTrackOf(next).effects.map((f) => f.type);
    // eq covers warmth with a tighter fit; a space-only device must not win.
    expect(types).toContain("eq");
  });
});

describe("FxAddPopover assistant routing", () => {
  const renderPopover = (overrides?: Partial<Parameters<typeof FxAddPopover>[0]>) => {
    const onPick = vi.fn();
    const onGoal = vi.fn();
    const onAssistant = vi.fn();
    const onClose = vi.fn();
    render(
      <FxAddPopover
        trackLabel="808 Sub"
        devices={DEVICES}
        onPick={onPick}
        onGoal={onGoal}
        onAssistant={onAssistant}
        onClose={onClose}
        {...overrides}
      />,
    );
    return { onPick, onGoal, onAssistant, onClose };
  };

  it('"more space" surfaces the assistant row and hands over the parsed intent', () => {
    const { onAssistant } = renderPopover();
    fireEvent.change(screen.getByLabelText(/Describe what you want/i), { target: { value: "more space" } });
    const row = screen.getByText(/assistant tune on this track/i);
    fireEvent.click(row);
    expect(onAssistant).toHaveBeenCalledTimes(1);
    const intent = onAssistant.mock.calls[0]![0];
    expect(intent.goals.map((g: { goal: string }) => g.goal)).toContain("space");
  });

  it("production concepts and assistant goals COEXIST for one sentence", () => {
    renderPopover();
    fireEvent.change(screen.getByLabelText(/Describe what you want/i), { target: { value: "brighter" } });
    // ♪ production row (svFilter fold) …
    expect(screen.getByText(/apply to this track/i)).toBeDefined();
    // … AND ◈ assistant row (brightness goal) — user picks the interpreter.
    expect(screen.getByText(/assistant tune on this track/i)).toBeDefined();
  });

  it("unsupported text gets neither action row", () => {
    renderPopover();
    fireEvent.change(screen.getByLabelText(/Describe what you want/i), {
      target: { value: "make it professional" },
    });
    expect(screen.queryByText(/apply to this track/i)).toBeNull();
    expect(screen.queryByText(/assistant tune on this track/i)).toBeNull();
  });

  it("no assistant row when the surface does not wire one", () => {
    render(
      <FxAddPopover
        trackLabel="808 Sub"
        devices={DEVICES}
        onPick={() => undefined}
        onGoal={() => undefined}
        onClose={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Describe what you want/i), { target: { value: "more space" } });
    expect(screen.queryByText(/assistant tune on this track/i)).toBeNull();
  });
});
