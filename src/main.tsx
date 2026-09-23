import { StrictMode, Suspense, lazy, useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CoreServices, Services } from "./services";
import type { ProjectDocument } from "./project-model/types";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { ProjectBrowser } from "./ui/ProjectBrowser";
import { decodeShareCode } from "./export/shareCode";
import { clearPendingHandoff, peekPendingHandoff, stashIntentPrefill, stashRegenFlag } from "./landing/handoff";
import { funnelTiming } from "./services/funnel";
import { initSwUpdate } from "./sw-update";
import { detectWebAudioSupport, isWebAudioBootFailure } from "./shared/webAudioSupport";
import { configureAssetBase } from "./shared/assetUrls";
import { stripBasePath } from "./shared/mountBase";
import "./styles/index.css";
import { initTheme } from "./ui/theme";
import { initPadKeys } from "./ui/padKeys";

// Ecosystem mount (Qvester Studio subpath): when built with
// STUDIO_APP_BASE=/pulse-forge/, BASE_URL carries the mount — root-absolute
// asset paths (worklets, models, samples) must be prefixed ONCE before any
// loader runs, and the router must strip the prefix from location.pathname.
configureAssetBase(import.meta.env.BASE_URL);

// Load persisted pad key bindings before the first paint.
initPadKeys();

// Service-worker update banner (PWA "prompt" mode) — registers on every
// route; the banner only appears when a new build is waiting.
initSwUpdate();

// Apply persisted user theme before the first paint.
initTheme();

// Route-level code splitting: /embed and /gallery never pull the studio,
// the landing page never pulls it either. Each chunk loads only for its URL.
const EmbedApp = lazy(() => import("./embed/EmbedApp").then((m) => ({ default: m.EmbedApp })));
const GalleryPage = lazy(() => import("./gallery/GalleryPage").then((m) => ({ default: m.GalleryPage })));
const LandingPage = lazy(() => import("./landing/LandingPage").then((m) => ({ default: m.LandingPage })));
const DownloadPage = lazy(() => import("./download/DownloadPage").then((m) => ({ default: m.DownloadPage })));
// The studio itself is the largest UI route. Keep it out of the initial
// project-browser/landing payload and load it only after a project opens.
const StudioApp = lazy(() => import("./ui/App").then((m) => ({ default: m.App })));

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");
// Vite can re-evaluate this entry during HMR while keeping the same DOM
// container alive. Reuse its root instead of mounting a second React root;
// duplicate roots otherwise corrupt reconciliation on the next provider edit.
type RootContainer = HTMLElement & { __kyxReactRoot?: Root };
const rootContainer = container as RootContainer;
const root = (rootContainer.__kyxReactRoot ??= createRoot(container));

const PATH = typeof location !== "undefined" ? stripBasePath(location.pathname, import.meta.env.BASE_URL) : "/";
const ONBOARDED_KEY = "pf-onboarded";

// Set by the Electron shell's preload (desktop/main.cjs, ADR 0010).
declare global {
  interface Window {
    kyxDesktop?: {
      isDesktop: true;
      mrt2?: {
        getAvailability: () => Promise<{
          nativeInstalled: boolean;
          nativeRealtime: boolean;
          localCompanion: boolean;
          platform: string;
          arch: string;
          status: "available" | "unavailable";
          message: string;
        }>;
        validateEndpoint: (
          value: string,
        ) => Promise<
          | { ok: true; endpoint: { url: string; secure: boolean; host: string; port: number } }
          | { ok: false; error: string }
        >;
        startNativeHost: () => Promise<{ ready: true }>;
        stopNativeHost: () => Promise<void>;
        openTransport: () => Promise<string>;
        sendControl: (transportId: string, message: unknown) => Promise<void>;
        sendBinary: (transportId: string, packet: ArrayBuffer) => Promise<void>;
        closeTransport: (transportId: string) => Promise<void>;
        subscribe: (listener: (event: unknown) => void) => () => void;
      };
    };
  }
}

const ROUTE_FALLBACK = <div className="boot">KYX — loading…</div>;

// /embed — a standalone share player; skip the whole studio boot.
if (/^\/embed(\/|$)/.test(PATH)) {
  root.render(
    <StrictMode>
      <ErrorBoundary crashNote="This player hit an error. Reload to try again.">
        <Suspense fallback={ROUTE_FALLBACK}>
          <EmbedApp />
        </Suspense>
      </ErrorBoundary>
    </StrictMode>,
  );
} else if (/^\/gallery(\/|$)/.test(PATH)) {
  // /gallery — the beat feed; no studio boot either.
  root.render(
    <StrictMode>
      <ErrorBoundary crashNote="The gallery hit an error. Reload to try again.">
        <Suspense fallback={ROUTE_FALLBACK}>
          <GalleryPage />
        </Suspense>
      </ErrorBoundary>
    </StrictMode>,
  );
} else if (/^\/download(\/|$)/.test(PATH)) {
  // /download — the desktop app page; no studio boot either.
  root.render(
    <StrictMode>
      <ErrorBoundary crashNote="This page hit an error. Reload to try again.">
        <Suspense fallback={ROUTE_FALLBACK}>
          <DownloadPage />
        </Suspense>
      </ErrorBoundary>
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <Entry />
    </StrictMode>,
  );
}

/** `/` shows the landing page for FIRST-TIME visitors; everyone else —
 *  and anyone who clicks the CTA — lands in the studio flow. `/studio`
 *  always skips the landing. `/?landing` or `/landing` shows the landing
 *  even for returning users (KYX logo click). */
function Entry() {
  const [entered, setEntered] = useState(() => {
    // The desktop app boots straight into the studio — the landing page is
    // a browser first-run experience.
    if (window.kyxDesktop?.isDesktop) return true;
    if (/^\/landing(\/|$)/.test(PATH) || new URLSearchParams(location.search).has("landing")) return false;
    if (/^\/studio(\/|$)/.test(PATH)) return true;
    // Gallery/embed share links (?import=…) ARE the onboarding for their
    // clicker: the beat is the demo. Fáza B — "galéria ako vstupný bod" —
    // a REGEN/FORK/OPEN click must land in the studio, not a marketing page.
    if (new URLSearchParams(location.search).has("import")) return true;
    try {
      return localStorage.getItem(ONBOARDED_KEY) === "1";
    } catch {
      return true; // storage blocked — skip the landing, respect the user
    }
  });
  const enterStudio = () => {
    try {
      localStorage.setItem(ONBOARDED_KEY, "1");
    } catch {
      // private mode — entering still works this session
    }
    setEntered(true);
  };
  if (entered) return <Boot />;
  return (
    <ErrorBoundary crashNote="The landing page hit an error. Reload to try again.">
      <Suspense fallback={ROUTE_FALLBACK}>
        <LandingPage onEnterStudio={enterStudio} />
      </Suspense>
    </ErrorBoundary>
  );
}

type Screen =
  | { kind: "booting" }
  | { kind: "browser"; core: CoreServices; importDoc?: ProjectDocument }
  | { kind: "studio"; services: Services }
  | { kind: "unsupported"; missing: string[] }
  | { kind: "error"; message: string };

function Boot() {
  const [screen, setScreen] = useState<Screen>({ kind: "booting" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Web Audio is the studio's one hard dependency — a browser without
        // it (or with it OS-blocked) gets actionable guidance instead of a
        // raw engine exception half-way through boot.
        const support = detectWebAudioSupport();
        if (!support.ok) {
          setScreen({ kind: "unsupported", missing: support.missing });
          return;
        }
        // ?import=<share code> — a shared link drops the project straight
        // into the studio, skipping the browser. Reject corrupt links before
        // loading the audio engine; they do not need services to explain the
        // problem to the user.
        // Landing handoff (viral growth plan A1): a beat forged on the
        // landing page travels through sessionStorage and opens through the
        // SAME openProject path — an explicit ?import= link wins when both
        // exist. A corrupt LINK is a user-visible error; a corrupt HANDOFF
        // just falls back to normal studio entry.
        const params = new URLSearchParams(location.search);
        const linkCode = params.get("import");
        // Fáza B (Regenerate with intent): a gallery/embed link with ?regen=1
        // opens the studio with the beat AND auto-runs one fresh-seed
        // generation from the beat's own intent provenance.
        if (params.get("regen") === "1") stashRegenFlag();
        // PEEK, not take: StrictMode mounts this effect twice in dev — a
        // take-and-clear on the first (cancelled) run would swallow the
        // handoff. The winning run clears it once the studio is up, so a
        // reload never re-imports an already-opened handoff.
        const pending = linkCode ? null : peekPendingHandoff();
        const code = linkCode ?? pending?.code ?? null;
        const imported = code ? decodeShareCode(code) : null;
        if (linkCode && !imported) {
          setScreen({ kind: "error", message: "This beat link is invalid or corrupted." });
          clearPendingHandoff();
          return;
        }
        if (pending?.prompt) stashIntentPrefill(pending.prompt);

        const { createCoreServices, openProject } = await import("./services");
        if (cancelled) return;
        const core = await createCoreServices();
        if (cancelled) return;
        if (imported) {
          const services = await openProject(core, imported);
          if (cancelled) return;
          clearPendingHandoff();
          // Fáza C budget: studio TTI after arriving with a beat (gallery
          // REGEN/FORK/OPEN, landing handoff). createCoreServices +
          // openProject must not block the first render path for long.
          funnelTiming("studio_ready_after_import_ms", performance.now());
          setScreen({ kind: "studio", services });
        } else {
          setScreen({ kind: "browser", core });
        }
      } catch (error) {
        if (!cancelled) {
          // Audio blocked at construction time (iOS Low Power Mode, hardened
          // browser builds) reads like a crash but is a capability problem —
          // same guidance screen, minus the stack-trace tone.
          setScreen(
            isWebAudioBootFailure(error)
              ? { kind: "unsupported", missing: [] }
              : { kind: "error", message: String(error) },
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openDoc = useCallback((core: CoreServices, doc: ProjectDocument) => {
    // Surface open failures (e.g. the lazy collab chunk cannot load) — a
    // silent rejection would leave the browser looking unresponsive.
    void import("./services")
      .then(({ openProject }) => openProject(core, doc))
      .then(
        (services) => setScreen({ kind: "studio", services }),
        (error) => setScreen({ kind: "error", message: String(error) }),
      );
  }, []);

  /** Swap the studio's services in place (collab session start/leave). */
  const replaceServices = useCallback((services: Services) => {
    setScreen({ kind: "studio", services });
  }, []);

  const backToBrowser = useCallback((services: Services) => {
    // closeProject awaits the final save internally; a rejection here must
    // still return the user to the browser instead of wedging the studio.
    void services.closeProject().then(
      () => setScreen({ kind: "browser", core: services.core }),
      (error) => {
        console.error("[boot] closeProject failed:", error);
        setScreen({ kind: "browser", core: services.core });
      },
    );
  }, []);

  if (screen.kind === "booting") {
    return <div className="boot">KYX — forging audio engine…</div>;
  }
  if (screen.kind === "unsupported") {
    return <NoWebAudioScreen missing={screen.missing} />;
  }
  if (screen.kind === "error") {
    return <div className="boot boot-error">Failed to start: {screen.message}</div>;
  }
  if (screen.kind === "browser") {
    return (
      <ErrorBoundary crashNote="The project browser hit an error. Reload to try again.">
        <ProjectBrowser core={screen.core} onOpen={(doc) => openDoc(screen.core, doc)} />
      </ErrorBoundary>
    );
  }
  return (
    <ErrorBoundary onCrashSave={() => screen.kind === "studio" && void screen.services.flushSave()}>
      <Suspense fallback={<div className="boot">KYX — opening studio…</div>}>
        <StudioApp
          services={screen.services}
          onOpenBrowser={() => backToBrowser(screen.services)}
          onReplaceServices={replaceServices}
        />
      </Suspense>
    </ErrorBoundary>
  );
}

/** Full-screen guidance when the browser cannot provide Web Audio — old
 *  browsers, hardened builds, or iOS/iPadOS Low Power Mode (the OS blocks
 *  the API entirely there). The studio cannot run without it, but the
 *  visitor deserves an actionable explanation, not a ReferenceError. */
function NoWebAudioScreen({ missing }: { missing: string[] }) {
  return (
    <div className="crash-screen" role="alert">
      <h1>KYX needs Web Audio</h1>
      <p className="crash-detail">
        {missing.length > 0
          ? `This browser does not provide ${missing.join(" and ")} — the standard APIs every DAW-in-the-browser is built on.`
          : "Audio was blocked while KYX was starting — this browser or system is preventing Web Audio from running."}{" "}
        Nothing you saved is lost; your projects live in this browser's storage.
      </p>
      <ul className="crash-list">
        <li>Open KYX in a current Chrome, Edge, Firefox or Safari (Safari 14.1 or newer).</li>
        <li>
          iPhone / iPad: <strong>Low Power Mode disables Web Audio</strong> — turn it off, then reload this page.
        </li>
        <li>Check the browser's site settings — audio or "Web Audio" may be switched off for this site.</li>
        <li>
          Prefer an installed app? The <strong>KYX desktop build for Windows</strong> ships its own audio stack — see
          the Download page.
        </li>
      </ul>
      <button type="button" className="crash-reload" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}
