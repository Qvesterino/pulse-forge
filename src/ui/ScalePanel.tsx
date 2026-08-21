import { useDoc, useServices } from "./context";
import { setProjectKey } from "../commands/commands";
import { ROOT_NAMES, SCALE_TYPES, SCALE_LABELS, formatKey, parseKey } from "../project-model/scales";

export function ScalePanel({
  scaleSnap,
  onToggleSnap,
}: {
  scaleSnap: boolean;
  onToggleSnap: () => void;
}) {
  const services = useServices();
  const doc = useDoc();
  const key = doc.key;
  const parsed = key ? parseKey(key) : null;
  const rootIdx = parsed?.root ?? 0;
  const scaleIdx = parsed ? SCALE_TYPES.indexOf(parsed.scaleType) : 0;

  const changeRoot = (newRoot: string) => {
    const rootNum = ROOT_NAMES.indexOf(newRoot);
    if (rootNum < 0) return;
    const scaleType = SCALE_TYPES[scaleIdx];
    services.store.execute(setProjectKey(doc, formatKey(rootNum, scaleType)));
  };

  const changeScale = (newScale: string) => {
    const scaleNum = SCALE_TYPES.indexOf(newScale as any);
    if (scaleNum < 0) return;
    services.store.execute(setProjectKey(doc, formatKey(rootIdx, SCALE_TYPES[scaleNum])));
  };

  const clearKey = () => {
    services.store.execute(setProjectKey(doc, null));
  };

  return (
    <div className="scale-panel">
      <div className="scale-row">
        <label className="scale-label">ROOT</label>
        <select
          className="scale-select"
          value={ROOT_NAMES[rootIdx]}
          aria-label="Scale root"
          onChange={(e) => changeRoot(e.target.value)}
        >
          {ROOT_NAMES.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </div>
      <div className="scale-row">
        <label className="scale-label">SCALE</label>
        <select
          className="scale-select"
          value={SCALE_TYPES[scaleIdx]}
          aria-label="Scale type"
          onChange={(e) => changeScale(e.target.value)}
        >
          {SCALE_TYPES.map((s) => (
            <option key={s} value={s}>{SCALE_LABELS[s]}</option>
          ))}
        </select>
      </div>
      <div className="scale-row">
        <button
          type="button"
          className={`btn btn-small${scaleSnap ? " active-solo" : ""}`}
          onClick={onToggleSnap}
          title={scaleSnap ? "Scale snap ON — notes snap to scale" : "Scale snap OFF — free placement"}
          aria-pressed={scaleSnap}
        >
          SNAP {scaleSnap ? "ON" : "OFF"}
        </button>
        {key && (
          <button type="button" className="btn btn-small" onClick={clearKey} title="Clear project key">
            CLEAR
          </button>
        )}
      </div>
    </div>
  );
}