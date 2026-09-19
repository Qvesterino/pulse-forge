import { type ReactNode } from "react";

/** Where the desktop artifacts live — `releases/latest` always resolves to
 *  the newest published release, so the page never pins a version. */
export const RELEASES_URL = "https://github.com/Qvesterino/pulse-forge/releases/latest";

/* Inline stroke icons — same visual language as the landing page. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const IconBox = () => (
  <Icon>
    <path d="M21 8 12 3 3 8v8l9 5 9-5V8z" />
    <path d="m3 8 9 5 9-5" />
    <path d="M12 13v8" />
  </Icon>
);

const IconRefresh = () => (
  <Icon>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </Icon>
);

const IconFolder = () => (
  <Icon>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </Icon>
);

const FACTS = [
  {
    icon: <IconBox />,
    title: "Same engine, no browser",
    text: "The exact production build served over a local protocol — every worklet, the offline renderer and all exports behave identically to the web app.",
  },
  {
    icon: <IconRefresh />,
    title: "Updates itself",
    text: "KYX checks GitHub Releases on launch and every 6 hours, downloads silently and installs on your restart. Check manually any time under Help.",
  },
  {
    icon: <IconFolder />,
    title: "Projects stay on your disk",
    text: "Projects and imported samples persist across restarts and updates — no account, nothing uploaded. Microphone and Web MIDI just work.",
  },
];

/**
 * `/download` — the desktop app page. Ships as its own lazy chunk; the
 * studio and landing never pull it. Reuses the landing design system.
 */
export function DownloadPage() {
  return (
    <div className="landing" role="document" aria-label="KYX download">
      <nav className="landing-nav">
        <div className="landing-shell landing-nav-inner">
          <span className="landing-brand">
            <span className="embed-brand-mark">KX</span> KYX
          </span>
          <div className="landing-nav-actions">
            <a className="landing-btn landing-btn-ghost landing-btn-sm" href="/gallery">
              Beat gallery
            </a>
            <a className="landing-btn landing-btn-primary landing-btn-sm" href="/studio">
              Open the studio
            </a>
          </div>
        </div>
      </nav>

      <header className="landing-hero">
        <div className="landing-shell landing-hero-inner dl-solo">
          <span className="landing-badge">
            <span className="landing-badge-dot" />
            For Windows · Free · Auto-updates
          </span>
          <h1>
            KYX on your desktop.
            <br />
            Same beats, own window.
          </h1>
          <p className="landing-sub">
            The full studio as a standalone Windows app — launched from the taskbar, working fully offline, updating
            itself in the background. Your projects and samples live on your disk and survive every update.
          </p>
          <div className="landing-hero-actions">
            <a className="landing-btn landing-btn-primary landing-btn-lg" href={RELEASES_URL}>
              Download for Windows — free
            </a>
            <a className="landing-btn landing-btn-ghost landing-btn-lg" href="/studio">
              Open the web studio instead
            </a>
          </div>
          <span className="landing-hint">
            Windows 10 / 11 · 64-bit · installer &amp; portable .exe · no account, nothing to configure
          </span>
        </div>
      </header>

      <section className="landing-section" aria-label="Desktop app facts">
        <div className="landing-shell">
          <div className="landing-section-head">
            <p className="landing-eyebrow">Why the app</p>
            <h2>Browser-grade audio, desktop manners</h2>
          </div>
          <div className="landing-grid landing-grid-3">
            {FACTS.map((f) => (
              <div key={f.title} className="landing-card">
                <span className="landing-card-icon">{f.icon}</span>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </div>
            ))}
          </div>
          <span className="landing-hint dl-note">
            Good to know: the build is unsigned, so SmartScreen may ask on first install ("More info → Run anyway"). The
            portable .exe doesn&apos;t self-update — reinstall it for new versions. macOS and Linux are planned.
          </span>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-shell landing-footer-inner">
          <span>KYX — desktop beat studio for Windows</span>
          <span>
            Updates via <a href={RELEASES_URL}>GitHub Releases</a> · auto-installs on restart
          </span>
        </div>
      </footer>
    </div>
  );
}
