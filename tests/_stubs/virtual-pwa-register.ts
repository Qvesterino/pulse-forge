/**
 * Test stub for the Vite-only `virtual:pwa-register` module.
 *
 * `src/sw-update.ts` imports `virtual:pwa-register`, which is provided by
 * `vite-plugin-pwa` in dev/build but has no on-disk implementation. The
 * vitest graph does not include the PWA plugin, so the import would fail
 * without an alias pointing at this stub.
 *
 * `registerSW` returns a no-op updater. Tests that need to observe
 * `onNeedRefresh` / `onOfflineReady` callbacks can swap this module with
 * `vi.mock` and assert against their own mock.
 */
export const registerSW: (options?: {
  immediate?: boolean;
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
  onRegisterError?: (error: unknown) => void;
}) => (reloadPage?: boolean) => Promise<void> = () => async (_reloadPage?: boolean) => {};
