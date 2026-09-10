import { useMemo } from "react";
import { EmbedApp } from "../embed/EmbedApp";
import { encodeShareCode } from "../export/shareCode";
import { createProjectFromTemplate } from "../project-model/templates";

const FEATURES = [
  {
    icon: "✂️",
    title: "CHOP BEATS",
    text: "Drop an MP3 — transient detection slices it onto 16 pads, MPC-style. Retrigger, pitch, program.",
  },
  {
    icon: "🤖",
    title: "MIX & PATTERN ASSIST",
    text: "The assistant analyzes your track and proposes mix settings. Iterate on patterns with one click — always undoable.",
  },
  {
    icon: "🎛️",
    title: "3 PRO PLUGIN SUITES",
    text: "PRISM spectral EQ, VLYX intelligent mixing, VØID spatial reverb — bit-exact DSP, zero install.",
  },
  {
    icon: "👥",
    title: "LIVE JAM SESSIONS",
    text: "Share a room link — everyone edits the same project in real time. Undo stays user-scoped.",
  },
  {
    icon: "📤",
    title: "EXPORT ANYWHERE",
    text: "WAV, MP3, video for Reels/TikTok, stems, scorepacks. Or share a link that opens the whole project.",
  },
  {
    icon: "🌍",
    title: "MILLIONS OF SOUNDS",
    text: "Built-in procedural kit + one-click CC0 imports from freesound.org. No licensing traps.",
  },
];

const STEPS = [
  { n: 1, title: "OPEN A TEMPLATE", text: "House, Techno, Trap, Ambient — or start empty. Everything renders instantly in your browser." },
  { n: 2, title: "CHOP & PROGRAM", text: "Drop a loop, auto-chop it to pads, program the sequencer. Groove engine included." },
  { n: 3, title: "EXPORT & SHARE", text: "MP3, WAV, video, or a share link that opens the entire project for a friend." },
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
        <span className="landing-brand">
          <span className="embed-brand-mark">KX</span> KYX
        </span>
        <div className="landing-nav-actions">
          <button type="button" className="btn btn-export landing-cta" onClick={onEnterStudio}>
            OPEN THE STUDIO →
          </button>
          <a className="btn btn-export landing-cta" href="/gallery">
            BEAT GALLERY
          </a>
        </div>
      </nav>

      <header className="landing-hero">
        <div className="landing-hero-copy">
          <h1>
            MAKE BEATS
            <br />
            IN YOUR BROWSER
          </h1>
          <p className="landing-sub">
            No install. No account. Free forever.
            <br />
            A full beat studio — chop samples, program drums, mix with AI assist — running entirely on your machine.
          </p>
          <div className="landing-hero-actions">
            <button type="button" className="btn btn-export landing-cta-big" onClick={onEnterStudio}>
              START FORGING — IT'S FREE
            </button>
            <span className="landing-hint">Runs offline · Your audio never leaves the device</span>
          </div>
        </div>
        <div className="landing-hero-player" aria-label="Live beat preview">
          <EmbedApp code={heroCode} inline />
        </div>
      </header>

      <section className="landing-features" aria-label="Features">
        <h2>EVERYTHING A BEAT NEEDS</h2>
        <div className="landing-grid">
          {FEATURES.map((f) => (
            <div key={f.title} className="landing-card">
              <span className="landing-card-icon">{f.icon}</span>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-steps" aria-label="How it works">
        <h2>60 SECONDS TO YOUR FIRST BEAT</h2>
        <div className="landing-grid landing-grid-3">
          {STEPS.map((s) => (
            <div key={s.n} className="landing-card">
              <span className="landing-step-n">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-export landing-cta-big" onClick={onEnterStudio}>
          OPEN THE STUDIO →
        </button>
      </section>

      <footer className="landing-footer">
        <span>KYX — browser beat studio</span>
        <span className="landing-footer-dim">Built with Web Audio · Works best in Chrome · PWA — install it</span>
      </footer>
    </div>
  );
}
