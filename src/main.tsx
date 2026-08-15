import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createServices } from "./services";
import type { Services } from "./services";
import { App } from "./ui/App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");

createRoot(container).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);

type BootState =
  | { kind: "loading" }
  | { kind: "ready"; services: Services }
  | { kind: "error"; message: string };

function Boot() {
  const [state, setState] = useState<BootState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    createServices().then(
      (services) => {
        if (!cancelled) setState({ kind: "ready", services });
      },
      (error) => {
        if (!cancelled) setState({ kind: "error", message: String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return <div className="boot">PULSE FORGE — forging audio engine…</div>;
  }
  if (state.kind === "error") {
    return <div className="boot boot-error">Failed to start: {state.message}</div>;
  }
  return <App services={state.services} />;
}
