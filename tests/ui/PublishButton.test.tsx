import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { PublishToGalleryButton } from "../../src/gallery/PublishButton";
import { PUBLISH_CODE_KEY } from "../../src/gallery/galleryApi";
import { GALLERY_RENDER_KEY } from "../../src/gallery/galleryProvenance";
import { buildRenderManifest, clearRenderStampForTests, rememberRenderStamp } from "../../src/export/renderManifest";
import { createDefaultProject } from "../../src/project-model/schema";
import { renderWithContext } from "../helpers";

/**
 * Publish hand-off recovery. The button passes the project to /gallery via
 * sessionStorage. When storage is blocked, the old code silently opened an
 * EMPTY publish form (its comment promised a "URL hand-off below" that did not
 * exist) — the beat was dropped with no feedback.
 */

describe("PublishToGalleryButton", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("does not open an empty gallery when the browser blocks sessionStorage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderWithContext(<PublishToGalleryButton />);

    fireEvent.click(screen.getByRole("button", { name: /PUBLISH TO GALLERY/i }));

    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/blocked temporary storage/i);
  });

  it("opens the gallery and stores the hand-off when storage works", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderWithContext(<PublishToGalleryButton />);

    fireEvent.click(screen.getByRole("button", { name: /PUBLISH TO GALLERY/i }));

    expect(open).toHaveBeenCalledWith("/gallery", "_blank", "noopener");
    expect(sessionStorage.getItem(PUBLISH_CODE_KEY)).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("hands over the render provenance when an export stamp exists", async () => {
    // The verifiable-publish path: the studio passes the render hash and the
    // AI receipts to the gallery beside the project code.
    const doc = createDefaultProject();
    const manifest = buildRenderManifest({
      doc,
      scope: "master",
      mode: "song",
      sampleRate: 48_000,
      bitDepth: 32,
      durationSec: 1,
      renderHash: "cd".repeat(32),
      date: new Date("2026-10-17T00:00:00.000Z"),
    });
    rememberRenderStamp({ manifest, fileName: "beat-master.wav" });
    vi.spyOn(window, "open").mockImplementation(() => null);
    renderWithContext(<PublishToGalleryButton />);

    fireEvent.click(screen.getByRole("button", { name: /PUBLISH TO GALLERY/i }));

    const raw = sessionStorage.getItem(GALLERY_RENDER_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({ hash: "cd".repeat(32), algorithm: "SHA-256" });
    clearRenderStampForTests();
  });

  it("never hands over a STALE provenance (no stamp → the claim is cleared)", () => {
    sessionStorage.setItem(
      GALLERY_RENDER_KEY,
      JSON.stringify({
        hash: "ef".repeat(32),
        algorithm: "SHA-256",
        manifestFormat: "kyx-render-manifest/1",
        models: [],
      }),
    );
    clearRenderStampForTests();
    vi.spyOn(window, "open").mockImplementation(() => null);
    renderWithContext(<PublishToGalleryButton />);

    fireEvent.click(screen.getByRole("button", { name: /PUBLISH TO GALLERY/i }));

    expect(sessionStorage.getItem(GALLERY_RENDER_KEY)).toBeNull();
  });
});
