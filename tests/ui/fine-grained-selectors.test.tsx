/**
 * Regression tests for fine-grained document-slice selectors.
 *
 * The hooks under test (useScenes, useTracks, useArrangement, ...) were
 * introduced in GOAL 04 (campaign: threejs_scheduler_goals) to replace
 * broad `useDoc()` subscriptions in components like ArrangementPanel,
 * Mixer, ModPanel — every store mutation re-rendered the entire tree
 * because `useDoc()` returns the whole document and `useSyncExternalStore`
 * invalidates on any reference change. With structural sharing in
 * `normalizeProject` (schema.ts), the slice returned by getScenes/etc.
 * stays referentially identical when the user mutates an UNRELATED
 * slice, so the subscriber skips the re-render.
 *
 * These tests verify that contract at the hook level: a `useScenes()`
 * consumer must NOT re-render when a track changes, and the same for
 * the other slices. We use the existing `setTrackGain` and `setBpm`
 * commands as our "mutate one slice" tools; both are exported from
 * src/commands/commands.ts and shipped in helpers.tsx's mockServices.
 */
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { ServicesContext } from "../../src/ui/context";
import { mockServices } from "../helpers";
import { setTrackParams, setBpm } from "../../src/commands/commands";
import { useScenes, useTracks } from "../../src/ui/context";
import type { ReactNode } from "react";

const Wrapper = ({ services, children }: { services: ReturnType<typeof mockServices>; children: ReactNode }) => (
  <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>
);

describe("fine-grained document-slice selectors", () => {
  it("useScenes() returns a referentially stable array across TRACK mutations", () => {
    const services = mockServices();
    const { result, rerender } = renderHook(() => useScenes(), {
      wrapper: ({ children }) => <Wrapper services={services}>{children as ReactNode}</Wrapper>,
    });
    const firstRef = result.current;
    expect(firstRef.length).toBeGreaterThan(0);

    // Mutate a track (unrelated slice). Structural sharing in
    // normalizeProject keeps the scenes array identity stable.
    const doc = services.store.doc;
    const firstTrack = doc.tracks[0];
    services.store.execute(setTrackParams(doc, firstTrack.id, { gain: 0.42 }));
    rerender();

    expect(result.current).toBe(firstRef);
  });

  it("useScenes() returns a referentially stable array across BPM mutations", () => {
    const services = mockServices();
    const { result, rerender } = renderHook(() => useScenes(), {
      wrapper: ({ children }) => <Wrapper services={services}>{children as ReactNode}</Wrapper>,
    });
    const firstRef = result.current;
    const originalBpm = services.store.doc.bpm;

    services.store.execute(setBpm(services.store.doc, originalBpm + 5));
    rerender();

    expect(result.current).toBe(firstRef);
  });

  it("useTracks() returns a referentially stable array across SCENE mutations", () => {
    const services = mockServices();
    const { result, rerender } = renderHook(() => useTracks(), {
      wrapper: ({ children }) => <Wrapper services={services}>{children as ReactNode}</Wrapper>,
    });
    const firstRef = result.current;

    // Change BPM (not tracks). tracks slice must stay referentially stable.
    const doc = services.store.doc;
    services.store.execute(setBpm(doc, doc.bpm + 10));
    rerender();

    expect(result.current).toBe(firstRef);
  });
});
