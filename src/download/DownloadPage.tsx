import { useEffect, useState, type ReactNode } from "react";

/** Where the desktop artifacts live — `releases/latest` always resolves to
 *  the newest published release, so the page never pins a version. */
export const RELEASES_URL = "https://github.com/Qvesterino/pulse-forge/releases/latest";

const RELEASE_API = "https://api.github.com/repos/Qvesterino/pulse-forge/releases/latest";

interface ReleaseMeta {
  version: string | null;
  installerMb: number | null;
  publishedLabel: string | null;
}

/**
 * Live release facts for the hero meta line (version · installer size ·
 * release date), straight from the public GitHub API. Purely progressive
 * enhancement — offline or rate-limited visitors see the static fallback
 * and the button keeps pointing at `releases/latest`.
 */
function useLatestRelease(): ReleaseMeta | null {
  const [meta, setMeta] = useState<ReleaseMeta | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(RELEASE_API, { signal: ctrl.signal, headers: { Accept: "application/vnd.github+json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { tag_name?: string; published_at?: string; assets?: { name: string; size: number }[] } | null) => {
        if (!data) return;
        const installer = (data.assets ?? []).find((a) => /^KYX-Setup-.*\.exe$/.test(a.name));
        const date = data.published_at ? new Date(data.published_at) : null;
        setMeta({
          version: (data.tag_name ?? "").replace(/^v/, "") || null,
          installerMb: installer ? Math.round(installer.size / 1_048_576) : null,
          publishedLabel: date
            ? date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
            : null,
        });
      })
      .catch(() => {
        /* offline / rate-limited — the static fallback stays */
      });
    return () => ctrl.abort();
  }, []);
  return meta;
}

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

const IconDownload = () => (
  <Icon>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
    <path d="M12 15V3" />
  </Icon>
);

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

const IconDisk = () => (
  <Icon>
    <path d="M22 12H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    <path d="M6 16h.01" />
    <path d="M10 16h.01" />
  </Icon>
);

const IconMic = () => (
  <Icon>
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <path d="M12 19v3" />
  </Icon>
);

const IconLayers = () => (
  <Icon>
    <path d="m12 2 9 5-9 5-9-5 9-5z" />
    <path d="m3 12 9 5 9-5" />
    <path d="m3 17 9 5 9-5" />
  </Icon>
);

const IconShield = () => (
  <Icon>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </Icon>
);

const IconUsb = () => (
  <Icon>
    <path d="m12 2 4 8-4 2-4-2 4-8z" />
    <path d="M8 12 6 16h12l-2-4" />
    <path d="M12 16v6" />
  </Icon>
);

const IconTerminal = () => (
  <Icon>
    <path d="m4 17 6-6-6-6" />
    <path d="M12 19h8" />
  </Icon>
);

interface Feature {
  icon: ReactNode;
  span: string;
  title: string;
  text: string;
  timeline?: string[];
  chips?: string[];
}

const FEATURES: Feature[] = [
  {
    icon: <IconBox />,
    span: "dl-span-4",
    title: "Same engine, zero compromise",
    text: "The exact production build — every AudioWorklet, the offline renderer, all exports — served over a local protocol. Nothing is stripped, nothing behaves differently from the web studio.",
  },
  {
    icon: <IconRefresh />,
    span: "dl-span-2",
    title: "Updates itself",
    text: "Checks GitHub Releases on launch and every 6 hours, downloads silently, installs on your restart. Help → Check for updates any time.",
    timeline: ["CHECK", "DOWNLOAD", "INSTALL"],
  },
  {
    icon: <IconDisk />,
    span: "dl-span-2",
    title: "100% offline, 100% local",
    text: "No account, no cloud, no telemetry. Projects and samples persist in your profile and survive every update.",
  },
  {
    icon: <IconMic />,
    span: "dl-span-2",
    title: "Hardware just works",
    text: "Microphone input and Web MIDI controllers connect without permission popups — granted silently by the shell.",
  },
  {
    icon: <IconLayers />,
    span: "dl-span-2",
    title: "Two flavors",
    text: "Install it properly, or run the portable exe from a USB stick. The installer self-updates; the portable build re-downloads per release.",
    chips: ["NSIS INSTALLER", "PORTABLE .EXE", "WIN 10/11 · 64-BIT"],
  },
];

const NOTES = [
  { icon: <IconShield />, text: "Unsigned build — SmartScreen may warn on first install (More info → Run anyway)." },
  { icon: <IconUsb />, text: "The portable build doesn't self-update — grab a fresh one each release." },
  { icon: <IconTerminal />, text: "macOS + Linux builds are planned; the web studio works everywhere today." },
];

const STEPS = [
  {
    n: "01",
    title: "Download",
    text: "Grab KYX-Setup.exe from GitHub Releases — no account, no email, no installer bundles.",
  },
  {
    n: "02",
    title: "Run the installer",
    text: "Windows may show SmartScreen once (the build is unsigned): More info → Run anyway.",
  },
  {
    n: "03",
    title: "Make beats",
    text: "Launch KYX from the Start menu. Projects live on your disk; updates arrive silently.",
  },
];

const MARQUEE = ["CHOP", "SEQUENCE", "MIX", "RENDER", "EXPORT", "COLLAB", "SHARE", "JAM"];

/** Deterministic waveform bar heights (px) — a fixed groove, not random. */
const WAVE = [
  16, 30, 48, 66, 44, 26, 56, 78, 60, 36, 22, 42, 68, 82, 58, 34, 20, 38, 62, 74, 52, 30, 46, 70, 84, 64, 40, 24, 50,
  72, 54, 32, 18, 44, 76, 58,
];

function ReleaseMetaLine({ meta }: { meta: ReleaseMeta | null }) {
  if (!meta) return <p className="dl-release-meta">ALWAYS THE LATEST BUILD · GITHUB RELEASES</p>;
  const parts = [
    meta.version ? `v${meta.version}` : null,
    meta.installerMb != null ? `INSTALLER ${meta.installerMb} MB` : null,
    meta.publishedLabel ? `RELEASED ${meta.publishedLabel.toUpperCase()}` : null,
  ].filter(Boolean);
  return <p className="dl-release-meta">{parts.join("  ·  ") || "ALWAYS THE LATEST BUILD · GITHUB RELEASES"}</p>;
}

/**
 * `/download` — the desktop app page. Ships as its own lazy chunk; the
 * studio and landing never pull it. Reuses the landing design tokens with
 * an extra layer of hero motion (all CSS, `prefers-reduced-motion` aware).
 */
export function DownloadPage() {
  const release = useLatestRelease();

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

      <header className="dl-hero">
        <div className="dl-grain" aria-hidden="true" />
        <div className="landing-shell">
          <div className="dl-hero-inner">
            <span className="landing-badge">
              <span className="landing-badge-dot" />
              Windows desktop · Free · Auto-updates
            </span>
            <h1 className="dl-title">
              The whole studio.
              <br />
              <span className="dl-title-accent">Out of the browser.</span>
            </h1>
            <p className="dl-sub">
              KYX Desktop is the complete beat workstation as a native Windows app — instant launch, fully offline,
              silent auto-updates. Your projects live on your disk. Your audio never leaves the device.
            </p>
            <div className="dl-hero-actions">
              <a className="dl-btn-hero" href={RELEASES_URL}>
                <IconDownload />
                Download for Windows
              </a>
              <a className="landing-btn landing-btn-ghost landing-btn-lg" href="/studio">
                Open the web studio
              </a>
            </div>
            <ReleaseMetaLine meta={release} />
            <span className="landing-hint">
              Windows 10 / 11 · 64-bit · installer &amp; portable .exe · no account, nothing to configure
            </span>
            <div className="dl-wave" aria-hidden="true">
              {WAVE.map((h, i) => (
                <span key={i} style={{ height: h, animationDelay: `${(i % 7) * 0.11}s` }} />
              ))}
            </div>
          </div>
        </div>
      </header>

      <div className="dl-marquee" aria-hidden="true">
        <div className="dl-marquee-track">
          {[0, 1].map((copy) => (
            <span key={copy}>
              {MARQUEE.map((word) => (
                <em key={word}>
                  {word} <i />
                </em>
              ))}
            </span>
          ))}
        </div>
      </div>

      <section className="landing-section" aria-label="Desktop app facts">
        <div className="landing-shell">
          <div className="landing-section-head">
            <p className="landing-eyebrow">Why the app</p>
            <h2>Browser-grade audio, desktop manners</h2>
          </div>
          <div className="dl-bento">
            {FEATURES.map((f) => (
              <div key={f.title} className={`dl-bcard ${f.span}`}>
                <span className="landing-card-icon">{f.icon}</span>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
                {f.timeline && (
                  <div className="dl-timeline">
                    {f.timeline.map((t) => (
                      <span key={t} className="dl-tl-step">
                        <i aria-hidden="true" />
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {f.chips && (
                  <div className="dl-chips">
                    {f.chips.map((c) => (
                      <span key={c} className="dl-chip">
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="dl-notes">
            {NOTES.map((n) => (
              <p key={n.text} className="dl-note">
                <span className="dl-note-icon">{n.icon}</span>
                {n.text}
              </p>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section landing-section-tight" aria-label="Install in a minute">
        <div className="landing-shell">
          <div className="landing-section-head">
            <p className="landing-eyebrow">Install</p>
            <h2>Sixty seconds to the studio</h2>
          </div>
          <div className="dl-steps">
            {STEPS.map((s) => (
              <div key={s.n} className="dl-step">
                <span className="dl-step-num">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-cta-band" aria-label="Get the app">
        <div className="landing-shell">
          <div className="landing-cta-panel dl-cta-panel">
            <h2>Ready to forge on desktop?</h2>
            <p>Free, offline, self-updating. Your beats — your machine.</p>
            <a className="dl-btn-hero" href={RELEASES_URL}>
              <IconDownload />
              Download for Windows
            </a>
          </div>
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
