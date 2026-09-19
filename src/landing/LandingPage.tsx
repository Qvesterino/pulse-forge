import { useMemo, type ReactNode } from "react";
import { EmbedApp } from "../embed/EmbedApp";
import { encodeShareCode } from "../export/shareCode";
import { createProjectFromTemplate } from "../project-model/templates";

/* Inline stroke icons — one visual language instead of mixed emoji. */
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

const IconScissors = () => (
  <Icon>
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M20 4 8.12 15.88" />
    <path d="M14.47 14.48 20 20" />
    <path d="M8.12 8.12 12 12" />
  </Icon>
);

const IconSliders = () => (
  <Icon>
    <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3" />
    <path d="M14 2v4M8 10v4M16 18v4" />
  </Icon>
);

const IconLayers = () => (
  <Icon>
    <path d="m12 2 9 5-9 5-9-5 9-5z" />
    <path d="m3 12 9 5 9-5" />
    <path d="m3 17 9 5 9-5" />
  </Icon>
);

const IconUsers = () => (
  <Icon>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Icon>
);

const IconExport = () => (
  <Icon>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m17 8-5-5-5 5" />
    <path d="M12 3v12" />
  </Icon>
);

const IconGlobe = () => (
  <Icon>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </Icon>
);

const FEATURES = [
  {
    icon: <IconScissors />,
    title: "Chop beats",
    text: "Drop an MP3 — transient detection slices it onto 16 MPC-style pads. Retrigger, pitch, program.",
  },
  {
    icon: <IconSliders />,
    title: "Mix & pattern assist",
    text: "The assistant analyzes your track, proposes mix settings and iterates on patterns with you. Every step stays undoable.",
  },
  {
    icon: <IconLayers />,
    title: "Pro plugin suites",
    text: "PRISM spectral EQ, VLYX intelligent mixing, VØID spatial reverb and RYFT spectral delay. Bit-exact DSP, zero install.",
  },
  {
    icon: <IconUsers />,
    title: "Live jam sessions",
    text: "Share a room link — everyone edits the same project in real time. Undo stays user-scoped.",
  },
  {
    icon: <IconExport />,
    title: "Export anywhere",
    text: "WAV, MP3, video for Reels and TikTok, stems, scorepacks — or a share link that opens the whole project.",
  },
  {
    icon: <IconGlobe />,
    title: "Millions of sounds",
    text: "A built-in procedural kit plus one-click CC0 imports from freesound.org. No licensing traps.",
  },
];

const STEPS = [
  {
    n: 1,
    title: "Open a template",
    text: "House, techno, trap or ambient — or start from empty. Everything renders instantly in your browser.",
  },
  {
    n: 2,
    title: "Chop & program",
    text: "Drop a loop, auto-chop it to pads, program the sequencer. Groove engine included.",
  },
  {
    n: 3,
    title: "Export & share",
    text: "MP3, WAV, video — or a share link that opens the whole project for a friend.",
  },
];

/**
 * Landing page for first-time visitors (`/` without the onboarded flag).
 * Returning users skip straight to the studio via main.tsx routing.
 */
export function LandingPage({ onEnterStudio }: { onEnterStudio: () => void }) {
  // Hero player: a real house template through the real embed renderer.
  const heroCode = useMemo(() => encodeShareCode(createProjectFromTemplate("house")), []);

  return (
    <div className="landing" role="document" aria-label="KYX landing">
      <nav className="landing-nav">
        <div className="landing-shell landing-nav-inner">
          <span className="landing-brand">
            <span className="embed-brand-mark">KX</span> KYX
          </span>
          <div className="landing-nav-actions">
            <a className="landing-btn landing-btn-ghost landing-btn-sm" href="/download">
              Download
            </a>
            <a className="landing-btn landing-btn-ghost landing-btn-sm" href="/gallery">
              Beat gallery
            </a>
            <button type="button" className="landing-btn landing-btn-primary landing-btn-sm" onClick={onEnterStudio}>
              Open the studio
            </button>
          </div>
        </div>
      </nav>

      <header className="landing-hero">
        <div className="landing-shell landing-hero-inner">
          <div className="landing-hero-copy">
            <span className="landing-badge">
              <span className="landing-badge-dot" />
              Free · No account · Runs offline
            </span>
            <h1>
              Make beats
              <br />
              in your browser.
            </h1>
            <p className="landing-sub">
              A full beat studio — chop samples, program drums, mix with AI assist. Everything renders locally in this
              tab; your audio never leaves the device.
            </p>
            <div className="landing-hero-actions">
              <button type="button" className="landing-btn landing-btn-primary landing-btn-lg" onClick={onEnterStudio}>
                Start forging — it&apos;s free
              </button>
              <a className="landing-btn landing-btn-ghost landing-btn-lg" href="/gallery">
                Explore the gallery
              </a>
            </div>
            <span className="landing-hint">
              No install · Works offline · <a href="/download">Prefer a desktop app? Download for Windows</a>
            </span>
          </div>
          <div className="landing-hero-player" aria-label="Live beat preview">
            <EmbedApp code={heroCode} inline hideBrand />
          </div>
        </div>
      </header>

      <section className="landing-section" aria-label="Features">
        <div className="landing-shell">
          <div className="landing-section-head">
            <p className="landing-eyebrow">Why KYX</p>
            <h2>Everything a beat needs</h2>
          </div>
          <div className="landing-grid">
            {FEATURES.map((f) => (
              <div key={f.title} className="landing-card">
                <span className="landing-card-icon">{f.icon}</span>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section landing-section-tight" aria-label="How it works">
        <div className="landing-shell">
          <div className="landing-section-head">
            <p className="landing-eyebrow">How it works</p>
            <h2>60 seconds to your first beat</h2>
          </div>
          <div className="landing-grid landing-grid-3">
            {STEPS.map((s) => (
              <div key={s.n} className="landing-card">
                <span className="landing-step-n">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-cta-band" aria-label="Get started">
        <div className="landing-shell">
          <div className="landing-cta-panel">
            <h2>Ready to forge your first beat?</h2>
            <p>Open the studio with the demo project loaded — no signup, nothing to install.</p>
            <button type="button" className="landing-btn landing-btn-primary landing-btn-lg" onClick={onEnterStudio}>
              Open the studio →
            </button>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-shell landing-footer-inner">
          <span>KYX — browser beat studio</span>
          <span>Built on Web Audio · Works best in Chrome · Installable as a PWA</span>
        </div>
      </footer>
    </div>
  );
}
