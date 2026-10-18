/**
 * Capability-based mobile profile (ADR 0051).
 *
 * A phone is not a small desktop, but it is also not a user-agent string. The
 * profile is derived from pointer capability and viewport width:
 *
 * - coarse primary pointer  -> touch-first mobile profile,
 * - narrow viewport + touch -> mobile profile (touch laptop in a small window),
 * - fine pointer + wide viewport -> desktop profile even if a touchscreen is
 *   present (Windows touch laptops must keep their mouse layout).
 *
 * The profile only drives presentation (touch target sizing, gesture hygiene)
 * and optional quality choices. It never changes project state and never
 * changes the audio path: DSP remains sample-rate and block-size driven.
 */

export interface MobileProfileEnvironment {
  matchMedia?: (query: string) => { matches: boolean } | null | undefined;
  maxTouchPoints?: number;
}

export interface MobileProfile {
  mobile: boolean;
  coarsePointer: boolean;
  anyCoarsePointer: boolean;
  narrowViewport: boolean;
  touchPoints: number;
}

export const MOBILE_PROFILE_ATTR = "data-mobile-profile";
export const INPUT_MODE_ATTR = "data-input-mode";

const MOBILE_MAX_WIDTH_QUERY = "(max-width: 820px)";

function envFromGlobal(): MobileProfileEnvironment {
  const g = globalThis as unknown as {
    matchMedia?: (query: string) => { matches: boolean };
    navigator?: { maxTouchPoints?: number };
  };
  return {
    matchMedia: typeof g.matchMedia === "function" ? g.matchMedia.bind(globalThis) : undefined,
    maxTouchPoints: g.navigator?.maxTouchPoints ?? 0,
  };
}

export function detectMobileProfile(env: MobileProfileEnvironment = envFromGlobal()): MobileProfile {
  const matches = (query: string): boolean => {
    try {
      return env.matchMedia?.(query)?.matches ?? false;
    } catch {
      return false;
    }
  };
  const coarsePointer = matches("(pointer: coarse)");
  const anyCoarsePointer = matches("(any-pointer: coarse)");
  const narrowViewport = matches(MOBILE_MAX_WIDTH_QUERY);
  const touchPoints = Math.max(0, Math.trunc(env.maxTouchPoints ?? 0));
  const mobile = coarsePointer || (narrowViewport && (anyCoarsePointer || touchPoints > 0));
  return { mobile, coarsePointer, anyCoarsePointer, narrowViewport, touchPoints };
}

/** Apply the profile to the document root before React paints. Safe to call
 *  repeatedly; the attributes are idempotent. */
export function applyMobileProfile(
  doc: Document | undefined = typeof document === "undefined" ? undefined : document,
  env: MobileProfileEnvironment = envFromGlobal(),
): MobileProfile {
  const profile = detectMobileProfile(env);
  if (!doc?.documentElement) return profile;
  doc.documentElement.setAttribute(MOBILE_PROFILE_ATTR, profile.mobile ? "mobile" : "desktop");
  doc.documentElement.setAttribute(INPUT_MODE_ATTR, profile.coarsePointer ? "touch" : "pointer");
  return profile;
}

/**
 * Boot-time installation: apply now and keep the attributes correct when a
 * device crosses the coarse-pointer or narrow-width boundary (rotation,
 * external keyboard/mouse, split screen). Returns the initial profile.
 */
export function initMobileProfile(
  win: (Window & typeof globalThis) | undefined = typeof window === "undefined" ? undefined : window,
): MobileProfile {
  if (!win) return detectMobileProfile({ matchMedia: undefined, maxTouchPoints: 0 });
  const profile = applyMobileProfile(win.document, {
    matchMedia: typeof win.matchMedia === "function" ? win.matchMedia.bind(win) : undefined,
    maxTouchPoints: win.navigator?.maxTouchPoints ?? 0,
  });
  if (typeof win.matchMedia !== "function") return profile;

  const queries = ["(pointer: coarse)", MOBILE_MAX_WIDTH_QUERY];
  const guarded = win as Window & typeof globalThis & { __kyxMobileProfileInstalled?: boolean };
  if (guarded.__kyxMobileProfileInstalled) return profile;
  guarded.__kyxMobileProfileInstalled = true;
  for (const query of queries) {
    const media = win.matchMedia(query);
    if (typeof media.addEventListener !== "function") continue;
    media.addEventListener("change", () => {
      applyMobileProfile(win.document, {
        matchMedia: win.matchMedia.bind(win),
        maxTouchPoints: win.navigator?.maxTouchPoints ?? 0,
      });
    });
  }
  return profile;
}
