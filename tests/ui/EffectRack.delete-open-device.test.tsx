import { useSyncExternalStore } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EffectRack } from "../../src/ui/EffectRack";
import { ServicesContext } from "../../src/ui/context";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { mockServices } from "../helpers";
import type { Services } from "../../src/services";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * §13 "deletion of the currently controlled object" — for effects.
 *
 * The rack defends itself here in production code (`EffectRack.tsx:112-120`
 * `effectiveExpandedFxId` and `:138-143` `activeDeviceId` both re-validate
 * their id against `track.effects` and fall back to the newest device), but
 * nothing tested it. The existing EffectRack specs cannot: they hand the
 * component a static `track` prop over a MOCK store, so the document never
 * changes under the component and the DOM never re-renders — the delete is
 * asserted via `expect(store.execute).toHaveBeenCalled()`, which stays green
 * whether or not the UI survives.
 *
 * These tests drive a real `ProjectStore` and re-render from it the way `App`
 * does, so "the panel still works after its device is deleted" is actually
 * observed rather than assumed.
 */
function docWithEffects(count: number) {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((t) => t.kind === "instrument")!;
  track.effects = Array.from({ length: count }, (_, i) => ({
    id: `fx${i}`,
    type: "delay" as const,
    bypassed: false,
    params: {},
  }));
  return { doc, trackId: track.id };
}

/** Mirrors how App feeds EffectRack: the LIVE track, re-read on every doc change. */
function LiveRack({ project, trackId, mode }: { project: ProjectStore; trackId: string; mode?: "rack" | "devices" }) {
  const doc = useSyncExternalStore(project.subscribe, project.getDoc, project.getDoc);
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) return <section>rack unmounted: track gone</section>;
  return <EffectRack track={track} mode={mode} />;
}

function renderLive(doc: ProjectDocument, trackId: string, mode?: "rack" | "devices") {
  const project = new ProjectStore(doc);
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  const utils = render(
    <ServicesContext.Provider value={services}>
      <LiveRack project={project} trackId={trackId} mode={mode} />
    </ServicesContext.Provider>,
  );
  return { ...utils, project };
}

describe("§13 deleting the effect whose editor is open", () => {
  /** The devices dock's empty state, scoped by class — its copy also appears elsewhere. */
  const devicesEmpty = () => document.querySelector(".devices-panel .empty-state");

  it("rack: deleting the explicitly expanded device focuses the remaining one", async () => {
    const user = userEvent.setup();
    const { doc, trackId } = docWithEffects(2);
    const { project } = renderLive(doc, trackId);

    expect(document.querySelectorAll(".fx-device").length).toBe(2);
    // The newest device is auto-focused. Explicitly focus the OTHER one
    // (fx0) instead — with `expandedFxId` left at its `null` auto value there
    // is no dead id to fall back from, and the test would pass against a rack
    // with no dead-id handling at all. The toggle is per-device, so target the
    // wrapper that is currently collapsed.
    const collapsed = [...document.querySelectorAll(".fx-device")].find((d) => d.classList.contains("collapsed"))!;
    await user.click(collapsed.querySelector<HTMLButtonElement>(".fx-device-toggle")!);
    expect(collapsed.classList.contains("collapsed")).toBe(false);
    expect(collapsed.querySelector(".fx-device-content")).not.toBeNull();

    // Now delete the device whose editor is open.
    await user.click(collapsed.querySelector<HTMLButtonElement>(".btn-danger")!);

    // The device is really gone…
    expect(
      project
        .getDoc()
        .tracks.find((t) => t.id === trackId)!
        .effects.map((e) => e.id),
    ).toEqual(["fx1"]);
    // …and the surviving device takes the editor. A dead `expandedFxId` that
    // stuck would leave the rack with every device collapsed.
    expect(document.querySelectorAll(".fx-device").length).toBe(1);
    expect(document.querySelector(".fx-device-content")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Collapse Delay" })).toBeInTheDocument();
  });

  it("rack: a device explicitly collapsed stays collapsed after an unrelated device is deleted", async () => {
    const user = userEvent.setup();
    const { doc, trackId } = docWithEffects(2);
    renderLive(doc, trackId);

    // "" is the sticky all-collapsed state. Deleting a device must not flip
    // it open — that would be the opposite failure of the same bug class.
    await user.click(screen.getByRole("button", { name: /^Collapse / }));
    expect(document.querySelector(".fx-device-content")).toBeNull();

    const device = document.querySelectorAll(".fx-device")[0]!;
    await user.click(device.querySelector<HTMLButtonElement>(".btn-danger")!);

    expect(document.querySelectorAll(".fx-device").length).toBe(1);
    expect(document.querySelector(".fx-device-content")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand Delay" })).toBeInTheDocument();
  });

  it("devices dock: deleting the device the user selected falls back to a live one, not the empty state", async () => {
    const user = userEvent.setup();
    const { doc, trackId } = docWithEffects(2);
    const { project } = renderLive(doc, trackId, "devices");

    // The dock renders exactly one always-expanded editor.
    expect(document.querySelectorAll(".fx-device").length).toBe(1);
    expect(devicesEmpty()).toBeNull();

    // Select the FIRST device from the chain explicitly. The mount effect
    // `setSelectedDeviceId(null)` (EffectRack.tsx:131-133) clears the initial
    // choice, so without this click `selectedDeviceId` stays null, the
    // newest-device fallback always wins, and the test passes even with the
    // dead-id check in `activeDeviceId` deleted outright — measured.
    const chain = [...document.querySelectorAll(".device-chain-item")];
    expect(chain.length).toBe(3); // instrument + two delays
    await user.click(chain[1]!);
    expect(chain[1]!.classList.contains("active")).toBe(true);

    // Now delete the device that is on screen.
    await user.click(document.querySelector(".fx-device .btn-danger")!);

    expect(
      project
        .getDoc()
        .tracks.find((t) => t.id === trackId)!
        .effects.map((e) => e.id),
    ).toEqual(["fx1"]);
    // A device still exists, so the "Add a device to this track" empty state
    // must NOT be what the user is left looking at — a dead `selectedDeviceId`
    // would resolve `selectedFx` to undefined and land exactly there.
    expect(devicesEmpty()).toBeNull();
    expect(document.querySelectorAll(".fx-device").length).toBe(1);
    expect(document.querySelector(".fx-device-content")).not.toBeNull();
  });

  it("devices dock: deleting the last device falls back to the instrument editor, not a dead surface", async () => {
    const user = userEvent.setup();
    const { doc, trackId } = docWithEffects(1);
    const { project } = renderLive(doc, trackId, "devices");

    await user.click(document.querySelector(".fx-device .btn-danger")!);

    expect(project.getDoc().tracks.find((t) => t.id === trackId)!.effects).toHaveLength(0);
    // An instrument track still HAS a device after the delete — itself.
    // `activeDeviceId` falls back to the "instrument" sentinel and the dock
    // renders the instrument editor. The "Add a device" copy is a bus-only
    // state, so seeing it here would mean the dock lost its subject.
    expect(devicesEmpty()).toBeNull();
    expect(document.querySelector(".device-surface")?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it("devices dock: a bus with no devices reaches the empty state once its last device goes", async () => {
    const user = userEvent.setup();
    const doc = createProjectFromTemplate("house");
    // A group track has no instrument of its own, so the dock's empty state
    // is reachable — and the dead-id fallback has nothing to fall back to.
    const trackId = "grp-audit";
    doc.tracks.push({
      id: trackId,
      kind: "group",
      name: "Audit Bus",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      effects: [{ id: "fx0", type: "delay", bypassed: false, params: {} }],
      sends: {},
    });

    const { project } = renderLive(doc, trackId, "devices");
    expect(devicesEmpty()).toBeNull();

    await user.click(document.querySelector(".fx-device .btn-danger")!);

    expect(project.getDoc().tracks.find((t) => t.id === trackId)!.effects).toHaveLength(0);
    expect(devicesEmpty()).not.toBeNull();
  });
});
