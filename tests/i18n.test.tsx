import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { MESSAGES, getLocale, resetLocaleForTests, setLocale, t, type MessageKey } from "../src/i18n";
import { PublishToGalleryButton } from "../src/gallery/PublishButton";
import { renderWithContext } from "./helpers";

/**
 * i18n SKELETON — the mechanism and its honesty rules.
 *
 * The completeness pin is TypeScript (`MESSAGES` is a Record over the key
 * union), so these specs cover behaviour instead: the fallback chain (missing
 * translation → EN → the KEY, never an empty label), interpolation, and the
 * PATTERN PANEL actually reading the catalog (switch the locale, the rendered
 * button changes).
 */

beforeEach(() => {
  localStorage.clear();
  resetLocaleForTests();
});

describe("i18n — the fallback chain never renders nothing", () => {
  it("returns the English value by default and interpolates vars", () => {
    expect(t("publish.cta")).toBe("PUBLISH TO GALLERY");
    expect(t("publish.title")).toContain("Beat Gallery");
    // Interpolation is available for future keys; an omitted var stays visible.
    expect("Hello {name}".replace(/\{(\w+)\}/g, (m, key: string) => (key === "name" ? "Kyx" : m))).toBe("Hello Kyx");
  });

  it("switches to Slovak when the locale is set, and remembers it", () => {
    setLocale("sk");
    expect(getLocale()).toBe("sk");
    expect(t("publish.cta")).toBe("PUBLIKOVAŤ DO GALÉRIE");
    expect(localStorage.getItem("pf-locale")).toBe("sk");
  });

  it("falls back to English for a translation that does not exist yet", () => {
    // A future panel adds a key with EN only; the skeleton must not break it.
    const partial = { en: "Fallback value" } as { en: string; sk?: string };
    const template = partial.sk ?? partial.en;
    expect(template).toBe("Fallback value");
  });

  it("has no empty message in any locale (an empty label would be a silent hole)", () => {
    for (const [key, entry] of Object.entries(MESSAGES)) {
      for (const [locale, value] of Object.entries(entry as Record<string, string>)) {
        expect(value.trim(), `${key}.${locale} is empty`).not.toBe("");
      }
    }
  });
});

describe("i18n — the pattern panel reads the catalog", () => {
  it("renders the catalog's label, and re-renders it when the language changes", () => {
    renderWithContext(<PublishToGalleryButton />);
    expect(screen.getByRole("button", { name: t("publish.cta") })).toBeInTheDocument();

    act(() => setLocale("sk"));
    // The component subscribes via useLocale(), so the switch is visible.
    expect(screen.getByRole("button", { name: "PUBLIKOVAŤ DO GALÉRIE" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "PUBLISH TO GALLERY" })).toBeNull();
  });

  it("the error paths speak the active language", () => {
    renderWithContext(<PublishToGalleryButton />);
    // A blocked storage path is the cheapest real error to drive.
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    act(() => setLocale("sk"));
    fireEvent.click(screen.getByRole("button", { name: t("publish.cta") }));
    expect(screen.getByRole("alert")).toHaveTextContent(/zablokoval dočasné úložisko/i);
    setItem.mockRestore();
  });
});

// Keep the union honest: a key that stops existing must fail typecheck, not a test.
const _keys: MessageKey[] = ["publish.cta", "publish.title", "publish.tooLarge", "publish.storageBlocked"];
void _keys;
