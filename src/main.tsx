import { StrictMode, Suspense, lazy, useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CoreServices, Services } from "./services";
import type { ProjectDocument } from "./project-model/types";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { ProjectBrowser } from "./ui/ProjectBrowser";
import { decodeShareCode } from "./export/shareCode";
import { initSwUpdate } from "./sw-update";
import "./styles/index.css";
import { initTheme } from "./ui/theme";
import { initPadKeys } from "./ui/padKeys";

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

const PATH = typeof location !== "undefined" ? location.pathname : "/";
const ONBOARDED_KEY = "pf-onboarded";

// Set by the Electron shell's preload (desktop/main.cjs, ADR 0010).
declare global {
  interface Window {
    kyxDesktop?: { isDesktop: true };
  }
}

const ROUTE_FALLBACK = <div className="boot">KYX — loading…</div>;

// /embed — a standalone share player; skip the whole studio boot.
if (/^\/embed(\/|$)/.test(PATH)) {
  root.render(
    <StrictMode>
      <Suspense fallback={ROUTE_FALLBACK}>
        <EmbedApp />
      </Suspense>
    </StrictMode>,
  );
} else if (/^\/gallery(\/|$)/.test(PATH)) {
  // /gallery — the beat feed; no studio boot either.
  root.render(
    <StrictMode>
      <Suspense fallback={ROUTE_FALLBACK}>
        <GalleryPage />
      </Suspense>
    </StrictMode>,
  );
} else if (/^\/download(\/|$)/.test(PATH)) {
  // /download — the desktop app page; no studio boot either.
  root.render(
    <StrictMode>
      <Suspense fallback={ROUTE_FALLBACK}>
        <DownloadPage />
      </Suspense>
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
    <Suspense fallback={ROUTE_FALLBACK}>
      <LandingPage onEnterStudio={enterStudio} />
    </Suspense>
  );
}

type Screen =
  | { kind: "booting" }
  | { kind: "browser"; core: CoreServices; importDoc?: ProjectDocument }
  | { kind: "studio"; services: Services }
  | { kind: "error"; message: string };

function Boot() {
  const [screen, setScreen] = useState<Screen>({ kind: "booting" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // ?import=<share code> — a shared link drops the project straight
        // into the studio, skipping the browser. Reject corrupt links before
        // loading the audio engine; they do not need services to explain the
        // problem to the user.
        const code = new URLSearchParams(location.search).get("import");
        const imported = code ? decodeShareCode(code) : null;
        if (code && !imported) {
          setScreen({ kind: "error", message: "This beat link is invalid or corrupted." });
          return;
        }

        const { createCoreServices, openProject } = await import("./services");
        if (cancelled) return;
        const core = await createCoreServices();
        if (cancelled) return;
        if (imported) {
          const services = await openProject(core, imported);
          if (!cancelled) setScreen({ kind: "studio", services });
        } else {
          setScreen({ kind: "browser", core });
        }
      } catch (error) {
        if (!cancelled) setScreen({ kind: "error", message: String(error) });
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
  if (screen.kind === "error") {
    return <div className="boot boot-error">Failed to start: {screen.message}</div>;
  }
  if (screen.kind === "browser") {
    return (
      <ErrorBoundary>
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
