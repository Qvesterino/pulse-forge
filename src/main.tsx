import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createCoreServices, openProject } from "./services";
import type { CoreServices, Services } from "./services";
import type { ProjectDocument } from "./project-model/types";
import { App } from "./ui/App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { ProjectBrowser } from "./ui/ProjectBrowser";
import { EmbedApp } from "./embed/EmbedApp";
import { LandingPage } from "./landing/LandingPage";
import { decodeShareCode } from "./export/shareCode";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");

const PATH = typeof location !== "undefined" ? location.pathname : "/";
const ONBOARDED_KEY = "pf-onboarded";

// /embed — a standalone share player; skip the whole studio boot.
if (/^\/embed(\/|$)/.test(PATH)) {
  createRoot(container).render(
    <StrictMode>
      <EmbedApp />
    </StrictMode>,
  );
} else {
  createRoot(container).render(
    <StrictMode>
      <Entry />
    </StrictMode>,
  );
}

/** `/` shows the landing page for FIRST-TIME visitors; everyone else —
 *  and anyone who clicks the CTA — lands in the studio flow. `/studio`
 *  always skips the landing. */
function Entry() {
  const [entered, setEntered] = useState(() => {
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
  return <LandingPage onEnterStudio={enterStudio} />;
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
    createCoreServices().then(
      (core) => {
        if (cancelled) return;
        // ?import=<share code> — a shared link drops the project straight
        // into the studio, skipping the browser.
        const code = new URLSearchParams(location.search).get("import");
        const imported = code ? decodeShareCode(code) : null;
        if (imported) {
          setScreen({ kind: "studio", services: openProject(core, imported) });
        } else {
          setScreen({ kind: "browser", core });
        }
      },
      (error) => {
        if (!cancelled) setScreen({ kind: "error", message: String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const openDoc = useCallback((core: CoreServices, doc: ProjectDocument) => {
    setScreen({ kind: "studio", services: openProject(core, doc) });
  }, []);

  /** Swap the studio's services in place (collab session start/leave). */
  const replaceServices = useCallback((services: Services) => {
    setScreen({ kind: "studio", services });
  }, []);

  const backToBrowser = useCallback((services: Services) => {
    void services.closeProject().then(() => {
      setScreen({ kind: "browser", core: services.core });
    });
  }, []);

  if (screen.kind === "booting") {
    return <div className="boot">PULSE FORGE — forging audio engine…</div>;
  }
  if (screen.kind === "error") {
    return <div className="boot boot-error">Failed to start: {screen.message}</div>;
  }
  if (screen.kind === "browser") {
    return <ProjectBrowser core={screen.core} onOpen={(doc) => openDoc(screen.core, doc)} />;
  }
  return (
    <ErrorBoundary onCrashSave={() => screen.kind === "studio" && void screen.services.flushSave()}>
      <App
        services={screen.services}
        onOpenBrowser={() => backToBrowser(screen.services)}
        onReplaceServices={replaceServices}
      />
    </ErrorBoundary>
  );
}
