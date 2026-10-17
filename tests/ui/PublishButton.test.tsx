import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { PublishToGalleryButton } from "../../src/gallery/PublishButton";
import { PUBLISH_CODE_KEY } from "../../src/gallery/galleryApi";
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
});
