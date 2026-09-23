/**
 * Subpath-mount route helper (Qvester Studio ecosystem mount).
 *
 * When the app is built with `STUDIO_APP_BASE=/pulse-forge/` and served at
 * that subpath, `location.pathname` arrives as `/pulse-forge/studio` while
 * the router's route regexes expect `/studio`. Vite exposes the mount as
 * `import.meta.env.BASE_URL` — this helper strips exactly one leading base
 * prefix (and nothing else), so root deployments ("/") are a no-op.
 */

/** Strip one leading mount-base prefix from a pathname. Pure string math. */
export function stripBasePath(pathname: string, base: string): string {
  const cleanBase = base.endsWith("/") ? base.slice(0, -1) : base;
  if (!cleanBase) return pathname;
  if (pathname === cleanBase) return "/";
  if (pathname.startsWith(`${cleanBase}/`)) return pathname.slice(cleanBase.length);
  return pathname;
}

/**
 * Prefix an app-absolute path ("/studio", "/?import=…") with the mount base
 * for hrefs and share URLs. Root deployment (base "/") → verbatim path.
 */
export function appUrl(path: string): string {
  if (!path.startsWith("/")) return path;
  const base = import.meta.env.BASE_URL ?? "/";
  const cleanBase = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${cleanBase}${path}`;
}
