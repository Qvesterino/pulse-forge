import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "pulse-forge.install.dismissed.v1";

/**
 * Native install prompt bridge. Captures `beforeinstallprompt`, shows a
 * decent inline banner (not a modal), and remembers dismissal per profile.
 * Hidden entirely on browsers that never fire the event (e.g. iOS Safari,
 * where users install via the Share menu).
 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      if (localStorage.getItem(DISMISS_KEY)) return;
    } catch {
      return; // private mode — skip the banner entirely
    }
    setDismissed(false);

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferred(null);

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!deferred || dismissed) return null;

  const install = async () => {
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") setDeferred(null);
  };

  const dismiss = () => {
    setDeferred(null);
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, new Date().toISOString());
    } catch {
      /* private mode — just hide for this session */
    }
  };

  return (
    <div className="install-prompt" role="contentinfo">
      <span className="install-prompt-icon">◈</span>
      <span className="install-prompt-text">
        Install KYX
        <small>Offline-ready · your projects stay on this device — installing protects them from cleanup</small>
      </span>
      <button type="button" className="btn btn-small" onClick={() => void install()}>
        INSTALL
      </button>
      <button type="button" className="install-prompt-close" aria-label="Dismiss install prompt" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
