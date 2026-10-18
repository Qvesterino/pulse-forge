import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MasteringAlbumPanel } from "../../src/ui/MasteringAlbumPanel";
import { MasteringAlbumRepository } from "../../src/mastering/albumStore";

/**
 * Album batch numeric fields (GAIN-ONLY LOUDNESS MATCH group).
 *
 * These three values are not cosmetic: they become `normalizeToLufs`,
 * `truePeakCeilingDbtp` and `maximumGainDb` in the batch-export and audition
 * options, and the album normalization path applies that gain to the RENDERED
 * PCM of every exported track. So an unguarded parse here is an audio defect.
 *
 * MEASURED BEFORE THE FIX (throwaway probe driving the real panel):
 *   empty LUFS-I field  → onBatchExport { normalizeToLufs: 0 }      ← 0 LUFS-I
 *   "99" in LUFS-I      → onAudition   { targetLufs: 99 }          ← unclamped
 *   empty TP field      → onBatchExport { truePeakCeilingDbtp: 0 } ← ceiling off
 *
 * All three were the same root cause: `Number(event.currentTarget.value)`
 * guarded by nothing, and `Number("")` is `0`, which is finite. The declared
 * `min`/`max` attributes do not constrain typed values — they only drive the
 * spinners and form validation.
 *
 * Most of these specs are negative assertions (per §7 of the audit: invalid
 * input must be REJECTED, not normalised into something plausible).
 */
const sessions = [
  { id: "ui-song-a", fileName: "a.wav", durationSeconds: 1 },
  { id: "ui-song-b", fileName: "b.wav", durationSeconds: 1 },
] as never;

const LUFS = "Album batch target integrated loudness in LUFS";
const TP = "Album batch true-peak ceiling in dBTP";
const BOOST = "Album batch maximum gain boost in decibels";

async function buildAlbumWithOneTrack(
  onBatchExport: (album: unknown, options: unknown) => void,
  onAudition: (album: unknown, normalization?: unknown) => void,
) {
  render(
    <MasteringAlbumPanel
      sessions={sessions}
      activeSessionId="ui-song-a"
      onOpenSession={vi.fn()}
      onAudition={onAudition}
      onBatchExport={onBatchExport}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "New album title" }), { target: { value: "ProbeAlbum" } });
  fireEvent.click(screen.getByRole("button", { name: "Create album" }));
  await screen.findByText("Created album sequence “ProbeAlbum”.");
  fireEvent.click(screen.getByRole("button", { name: "Add track" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Export 1 tracks/ })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("checkbox", { name: "Match album track loudness using gain only" }));
}

async function cleanup() {
  const repository = new MasteringAlbumRepository();
  for (const album of await repository.list()) {
    if (album.title === "ProbeAlbum") await repository.delete(album.id);
  }
}

const spin = (label: string) => screen.getByRole("spinbutton", { name: label }) as HTMLInputElement;

describe("album batch numeric fields", () => {
  it("an emptied LUFS field does NOT export a 0 LUFS target", async () => {
    const onBatchExport = vi.fn();
    try {
      await buildAlbumWithOneTrack(onBatchExport, vi.fn());
      fireEvent.change(spin(LUFS), { target: { value: "" } });
      fireEvent.blur(spin(LUFS));
      fireEvent.click(screen.getByRole("button", { name: "Export 1 tracks" }));
      // The previous default survives — the empty edit is a cancel.
      expect(onBatchExport.mock.calls[0]?.[1]).toMatchObject({ normalizeToLufs: -14 });
    } finally {
      await cleanup();
    }
  });

  it("an emptied true-peak field does NOT disable the ceiling", async () => {
    const onBatchExport = vi.fn();
    try {
      await buildAlbumWithOneTrack(onBatchExport, vi.fn());
      fireEvent.change(spin(TP), { target: { value: "" } });
      fireEvent.blur(spin(TP));
      fireEvent.click(screen.getByRole("button", { name: "Export 1 tracks" }));
      expect(onBatchExport.mock.calls[0]?.[1]).toMatchObject({ truePeakCeilingDbtp: -1.5 });
    } finally {
      await cleanup();
    }
  });

  it("clamps an above-max LUFS target instead of passing 99 through", async () => {
    const onAudition = vi.fn();
    try {
      await buildAlbumWithOneTrack(vi.fn(), onAudition);
      fireEvent.change(spin(LUFS), { target: { value: "99" } });
      fireEvent.blur(spin(LUFS));
      fireEvent.click(screen.getByRole("button", { name: "Audition gain-matched sequence" }));
      // Declared range is [-24, -6].
      expect(onAudition.mock.calls[0]?.[1]).toMatchObject({ targetLufs: -6 });
    } finally {
      await cleanup();
    }
  });

  it("clamps a below-min LUFS target", async () => {
    const onAudition = vi.fn();
    try {
      await buildAlbumWithOneTrack(vi.fn(), onAudition);
      fireEvent.change(spin(LUFS), { target: { value: "-99" } });
      fireEvent.blur(spin(LUFS));
      fireEvent.click(screen.getByRole("button", { name: "Audition gain-matched sequence" }));
      expect(onAudition.mock.calls[0]?.[1]).toMatchObject({ targetLufs: -24 });
    } finally {
      await cleanup();
    }
  });

  it("rejects a partial '-' entry without writing NaN or 0", async () => {
    // A lone minus is the intermediate state of typing any negative LUFS value.
    // It must never become state; `Number("-")` is NaN and a naive clamp of
    // NaN propagates NaN into the export options.
    const onBatchExport = vi.fn();
    try {
      await buildAlbumWithOneTrack(onBatchExport, vi.fn());
      fireEvent.change(spin(LUFS), { target: { value: "-" } });
      fireEvent.blur(spin(LUFS));
      fireEvent.click(screen.getByRole("button", { name: "Export 1 tracks" }));
      const options = onBatchExport.mock.calls[0]?.[1] as { normalizeToLufs: number };
      expect(Number.isFinite(options.normalizeToLufs)).toBe(true);
      expect(options.normalizeToLufs).toBe(-14);
    } finally {
      await cleanup();
    }
  });

  it("still commits a valid in-range value", async () => {
    const onAudition = vi.fn();
    try {
      await buildAlbumWithOneTrack(vi.fn(), onAudition);
      fireEvent.change(spin(LUFS), { target: { value: "-16" } });
      fireEvent.blur(spin(LUFS));
      fireEvent.click(screen.getByRole("button", { name: "Audition gain-matched sequence" }));
      expect(onAudition.mock.calls[0]?.[1]).toMatchObject({ targetLufs: -16 });
    } finally {
      await cleanup();
    }
  });

  it("commits a valid maximum-boost value within its declared range", async () => {
    const onBatchExport = vi.fn();
    try {
      await buildAlbumWithOneTrack(onBatchExport, vi.fn());
      fireEvent.change(spin(BOOST), { target: { value: "20" } });
      fireEvent.blur(spin(BOOST));
      fireEvent.click(screen.getByRole("button", { name: "Export 1 tracks" }));
      expect(onBatchExport.mock.calls[0]?.[1]).toMatchObject({ maximumGainDb: 20 });
    } finally {
      await cleanup();
    }
  });

  it("keeps every field's declared numeric contract", async () => {
    try {
      await buildAlbumWithOneTrack(vi.fn(), vi.fn());
      expect(spin(LUFS)).toHaveAttribute("type", "number");
      expect(Number(spin(LUFS).getAttribute("min"))).toBe(-24);
      expect(Number(spin(LUFS).getAttribute("max"))).toBe(-6);
      expect(Number(spin(TP).getAttribute("min"))).toBe(-6);
      expect(Number(spin(TP).getAttribute("max"))).toBe(0);
      expect(Number(spin(BOOST).getAttribute("min"))).toBe(0);
      expect(Number(spin(BOOST).getAttribute("max"))).toBe(24);
    } finally {
      await cleanup();
    }
  });
});
