/// <reference types="vite-plugin-pwa/client" />

/**
 * Service-worker update banner (release roadmap Fáza 3).
 *
 * The PWA runs `registerType: "prompt"`: a new build installs and WAITS.
 * This module surfaces the "update ready" state as a small fixed banner —
 * RELOAD swaps to the new build (safe point: the user chose it), × dismisses
 * (the waiting worker stays parked; the running session keeps its complete
 * precache, so lazy chunks keep loading).
 *
 * Imported ONLY from main.tsx — `virtual:pwa-register` does not resolve in
 * the vitest graph (no PWA plugin there), and no test needs this UI.
 *
 * Lifecycle: `initSwUpdate` is idempotent — repeated calls (e.g. Vite HMR)
 * must not pile up timers or `visibilitychange` listeners. `disposeSwUpdate`
 * tears down the poll timer and the listener so the module can be reset by
 * tests or hot reloads.
 */
import { registerSW } from "virtual:pwa-register";

let update: (reloadPage?: boolean) => Promise<void> = async () => {};

let initialized = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let visibilityListener: (() => void) | null = null;

export function initSwUpdate(): void {
  // Desktop shell (ADR 0010) and other non-http(s) origins have no service
  // worker — the update banner is a browser-distribution feature only.
  if (!/^https?:$/.test(location.protocol)) return;
  if (initialized) return;
  initialized = true;

  update = registerSW({
    onNeedRefresh() {
      if (document.getElementById("pf-update-banner")) return;
      const el = document.createElement("div");
      el.id = "pf-update-banner";
      el.setAttribute("role", "status");
      el.setAttribute("aria-label", "App update ready");
      const label = document.createElement("span");
      label.textContent = "New version ready";
      const reload = document.createElement("button");
      reload.type = "button";
      reload.className = "btn btn-small";
      reload.textContent = "RELOAD";
      reload.addEventListener("click", () => {
        void update(true).catch(() => undefined);
      });
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "btn btn-small";
      dismiss.setAttribute("aria-label", "Dismiss update banner");
      dismiss.textContent = "×";
      dismiss.addEventListener("click", () => el.remove());
      el.append(label, reload, dismiss);
      document.body.appendChild(el);
    },
  });
  // A long-lived SPA tab performs almost no full navigations, so the
  // browser's natural sw.js update checks (on navigation, + every 24 h)
  // rarely run. Poll on a timer and when the tab becomes visible again.
  pollInterval = setInterval(
    () => {
      void update().catch(() => undefined);
    },
    15 * 60 * 1000,
  );
  visibilityListener = () => {
    if (document.visibilityState === "visible") void update().catch(() => undefined);
  };
  document.addEventListener("visibilitychange", visibilityListener);
}

export function disposeSwUpdate(): void {
  if (!initialized) return;
  initialized = false;
  if (pollInterval != null) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (visibilityListener != null) {
    document.removeEventListener("visibilitychange", visibilityListener);
    visibilityListener = null;
  }
}
