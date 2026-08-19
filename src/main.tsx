import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createCoreServices, openProject } from "./services";
import type { CoreServices, Services } from "./services";
import type { ProjectDocument } from "./project-model/types";
import { App } from "./ui/App";
import { ProjectBrowser } from "./ui/ProjectBrowser";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");

createRoot(container).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);

type Screen =
  | { kind: "booting" }
  | { kind: "browser"; core: CoreServices }
  | { kind: "studio"; services: Services }
  | { kind: "error"; message: string };

function Boot() {
  const [screen, setScreen] = useState<Screen>({ kind: "booting" });

  useEffect(() => {
    let cancelled = false;
    createCoreServices().then(
      (core) => {
        if (!cancelled) setScreen({ kind: "browser", core });
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
  return <App services={screen.services} onOpenBrowser={() => backToBrowser(screen.services)} />;
}
