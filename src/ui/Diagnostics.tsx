import { useEffect, useState } from "react";
import { useServices } from "./context";

export function Diagnostics() {
  const services = useServices();
  const [rows, setRows] = useState<Record<string, string | number | boolean>>({});

  useEffect(() => {
    const update = () => setRows(services.getDiagnostics());
    update();
    const timer = setInterval(update, 400);
    return () => clearInterval(timer);
  }, [services]);

  return (
    <section className="diagnostics" aria-label="Engine diagnostics">
      <h2 className="panel-title">DIAGNOSTICS</h2>
      <div className="diagnostics-grid">
        {Object.entries(rows).map(([key, value]) => (
          <div key={key} className="diagnostics-row">
            <span className="diagnostics-key">{key}</span>
            <span className="diagnostics-value">{String(value)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
