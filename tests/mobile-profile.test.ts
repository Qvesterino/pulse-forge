import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INPUT_MODE_ATTR,
  MOBILE_PROFILE_ATTR,
  applyMobileProfile,
  detectMobileProfile,
} from "../src/shared/mobileProfile";

/** A tiny capability environment: only the queries the profile asks for. */
function env({
  coarse = false,
  anyCoarse = false,
  narrow = false,
  touchPoints = 0,
}: {
  coarse?: boolean;
  anyCoarse?: boolean;
  narrow?: boolean;
  touchPoints?: number;
}) {
  return {
    matchMedia: (query: string) => ({
      matches:
        query === "(pointer: coarse)"
          ? coarse
          : query === "(any-pointer: coarse)"
            ? anyCoarse
            : query === "(max-width: 820px)"
              ? narrow
              : false,
    }),
    maxTouchPoints: touchPoints,
  };
}

describe("mobile profile detection (ADR 0051)", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.mobileProfile;
    delete document.documentElement.dataset.inputMode;
  });

  it("classifies a phone (coarse primary pointer) as mobile", () => {
    const profile = detectMobileProfile(env({ coarse: true, anyCoarse: true, narrow: true, touchPoints: 5 }));
    expect(profile).toMatchObject({ mobile: true, coarsePointer: true, narrowViewport: true, touchPoints: 5 });
  });

  it("keeps a wide touch laptop on the desktop profile when the primary input is a mouse", () => {
    // pointer:fine + any-pointer:coarse + touch points + wide viewport is a
    // convertible laptop, not a phone; the desktop arrangement must survive.
    const profile = detectMobileProfile(env({ coarse: false, anyCoarse: true, narrow: false, touchPoints: 10 }));
    expect(profile.mobile).toBe(false);
    expect(profile.anyCoarsePointer).toBe(true);
  });

  it("treats a narrow touch viewport as mobile even when the primary pointer is fine", () => {
    const profile = detectMobileProfile(env({ coarse: false, anyCoarse: true, narrow: true, touchPoints: 2 }));
    expect(profile.mobile).toBe(true);
  });

  it("does not throw or classify without matchMedia / touch data (SSR / old WebView)", () => {
    expect(detectMobileProfile({}).mobile).toBe(false);
    expect(detectMobileProfile({ matchMedia: undefined, maxTouchPoints: 0 }).mobile).toBe(false);
  });

  it("writes idempotent root attributes for the touch CSS layer", () => {
    const profile = applyMobileProfile(document, env({ coarse: true, anyCoarse: true, narrow: true, touchPoints: 5 }));
    expect(profile.mobile).toBe(true);
    expect(document.documentElement.getAttribute(MOBILE_PROFILE_ATTR)).toBe("mobile");
    expect(document.documentElement.getAttribute(INPUT_MODE_ATTR)).toBe("touch");

    applyMobileProfile(document, env({ coarse: false, anyCoarse: false, narrow: false }));
    expect(document.documentElement.getAttribute(MOBILE_PROFILE_ATTR)).toBe("desktop");
    expect(document.documentElement.getAttribute(INPUT_MODE_ATTR)).toBe("pointer");
  });
});

describe("mobile touch CSS contract", () => {
  const stylesDir = resolve(process.cwd(), "src", "styles");
  const index = readFileSync(resolve(stylesDir, "index.css"), "utf-8");
  const mobile = readFileSync(resolve(stylesDir, "55-mobile-profile.css"), "utf-8");

  it("is imported before the settings glass (which must stay last)", () => {
    const mobileAt = index.indexOf("55-mobile-profile.css");
    const settingsAt = index.indexOf("26-settings-glass.css");
    expect(mobileAt).toBeGreaterThan(-1);
    expect(settingsAt).toBeGreaterThan(mobileAt);
  });

  it("gates touch sizing on a coarse pointer and uses the shared target token", () => {
    expect(mobile).toContain("@media (pointer: coarse)");
    expect(mobile).toContain("--touch-target-large");
    expect(mobile).toContain("touch-action");
    expect(mobile).toContain(":hover");
  });
});
