import type { OfflineRenderRuntimeDiagnostics } from "../rendering/renderer";

export function MasteringRuntimeStatus({ diagnostics }: { diagnostics: OfflineRenderRuntimeDiagnostics }) {
  const degradationCount = diagnostics.degradedEffects.length + diagnostics.degradedMasterStages.length;
  return (
    <div
      className="mastering-runtime-status"
      data-state={degradationCount > 0 ? "warn" : "ok"}
      role="note"
      aria-label="Offline render processor status"
    >
      <strong>OFFLINE RENDER PROCESSING</strong>
      <span>
        {degradationCount === 0
          ? "The offline engine reported no reduced or bypassed processors for this render."
          : `${degradationCount} reduced or bypassed processor status${degradationCount === 1 ? " was" : "es were"} reported.`}
      </span>
      {degradationCount > 0 && (
        <ul>
          {diagnostics.degradedEffects.map((item) => (
            <li key={`${item.trackId}:${item.fxId}`}>
              {item.ownerName} · {item.effectType.toUpperCase()}: {item.reason}
            </li>
          ))}
          {diagnostics.degradedMasterStages.map((item) => (
            <li key={item.stageId}>
              MASTER {item.stageId.toUpperCase()}: {item.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
