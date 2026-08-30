import { useMemo, useState } from "react";
import { useDoc, useServices } from "./context";
import { assistBuild, assistFill, assistReplace, assistVary } from "../commands/commands";
import { styleNames, type ReplaceTarget } from "../assist/patternOps";
import { buildAssistPatch } from "../assist/pipeline";
import { ASSIST_ENGINE_VERSION, type AssistOperation } from "../assist/types";
import { getActivePattern, getDrumTrack } from "../project-model/types";
import { nextSeed } from "../shared/dice";

function randomSeed(prev?: string): string {
  return nextSeed(prev ?? String(Date.now()), "assist");
}

/**
 * Assist — iterate on YOUR pattern instead of regenerating from scratch.
 * Every operation is deterministic for a given seed (same seed = same
 * result), undoable as one gesture, and re-rolls the seed after applying so
 * pressing the button again gives a fresh take. That tight loop —
 * apply, listen, undo or iterate — is the whole point.
 */
export function AssistPanel({ onClose }: { onClose: () => void }) {
  const services = useServices();
  const doc = useDoc();
  const pattern = getActivePattern(doc);
  const [seed, setSeed] = useState(randomSeed);
  const [amount, setAmount] = useState(0.6);
  const [bars, setBars] = useState(4);
  const [target, setTarget] = useState<ReplaceTarget>("hats");
  const [style, setStyle] = useState("house");
  const [previewOperation, setPreviewOperation] = useState<AssistOperation>("vary");
  const [flash, setFlash] = useState<string | null>(null);

  const apply = (label: string, run: () => void) => {
    run();
    setFlash(`${label} · seed ${seed}`);
    setSeed((prev) => randomSeed(prev)); // next press = fresh take on the same idea
    setTimeout(() => setFlash(null), 2500);
  };

  const stylesForTarget = styleNames(target);
  const drumPads = getDrumTrack(doc).pads;
  const previewPatch = useMemo(
    () =>
      buildAssistPatch(pattern, drumPads, {
        operation: previewOperation,
        seed,
        amount,
        bars,
        target,
        style,
      }),
    [pattern, drumPads, previewOperation, seed, amount, bars, target, style],
  );
  const previewPad =
    drumPads.find((pad) => (previewPatch.rows[pad.id] ?? []).some((value) => value > 0)) ?? drumPads[0];
  const previewRow = previewPad ? (previewPatch.rows[previewPad.id] ?? []) : [];
  const beforeHits = Object.values(pattern.rows).reduce(
    (total, row) => total + row.filter((value) => value > 0).length,
    0,
  );
  const afterHits = Object.values(previewPatch.rows).reduce(
    (total, row) => total + row.filter((value) => value > 0).length,
    0,
  );

  return (
    <div className="collab-panel assist-panel" role="dialog" aria-label="Pattern assist">
      <div className="collab-title">
        ASSIST — {pattern.name.toUpperCase()}
        <button type="button" className="btn btn-small" onClick={onClose} aria-label="Close assist">
          ×
        </button>
      </div>
      <p className="collab-hint">
        Iterate on this pattern — your hits stay yours, the assist modifies surgically. Same seed = same result; the
        seed re-rolls after every apply. Ctrl+Z takes anything back.
      </p>

      <div className="assist-seed">
        <label className="collab-field">
          <span>SEED</span>
          <input value={seed} onChange={(e) => setSeed(e.target.value)} spellCheck={false} />
        </label>
        <button
          type="button"
          className="btn btn-small"
          title="Re-roll seed"
          onClick={() => setSeed((prev) => randomSeed(prev))}
        >
          ⚄
        </button>
      </div>

      <div className="assist-preview">
        <div className="assist-preview-header">
          <span>PREVIEW</span>
          <span className="assist-engine">LOCAL ASSIST {ASSIST_ENGINE_VERSION}</span>
          <select value={previewOperation} onChange={(e) => setPreviewOperation(e.target.value as AssistOperation)}>
            <option value="vary">VARY</option>
            <option value="build">BUILD</option>
            <option value="replace">REPLACE</option>
            <option value="fill">FILL</option>
          </select>
        </div>
        <div className="assist-preview-meta">
          {previewPad?.name ?? "No drum pad"} · {beforeHits} → {afterHits} hits ·{" "}
          {previewPatch.stepCount ?? pattern.stepCount} steps
        </div>
        <div className="assist-preview-grid" role="img" aria-label={`${previewOperation} pattern preview`}>
          {Array.from({ length: 16 }, (_, step) => (
            <span
              key={step}
              className={`assist-preview-cell${(previewRow[step] ?? 0) > 0 ? " active" : ""}${step % 4 === 0 ? " beat" : ""}`}
              style={(previewRow[step] ?? 0) > 0 ? { opacity: 0.3 + (previewRow[step] ?? 0) * 0.7 } : undefined}
            />
          ))}
        </div>
      </div>

      <div className="assist-ops">
        <div className="assist-op">
          <label className="collab-field">
            <span>VARY — humanize velocities, ghosts, feel (amount {amount.toFixed(2)})</span>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </label>
          <button
            type="button"
            className="btn btn-export"
            onClick={() => apply("Varied", () => services.store.execute(assistVary(doc, pattern.id, seed, amount)))}
          >
            VARY PATTERN
          </button>
        </div>

        <div className="assist-op">
          <label className="collab-field">
            <span>BUILD — expand to bars with an element + energy ramp</span>
            <select value={bars} onChange={(e) => setBars(Number(e.target.value))}>
              <option value={2}>2 bars</option>
              <option value={4}>4 bars</option>
              <option value={8}>8 bars</option>
            </select>
          </label>
          <button
            type="button"
            className="btn btn-export"
            onClick={() =>
              apply(`Built to ${bars} bars`, () => services.store.execute(assistBuild(doc, pattern.id, bars, seed)))
            }
          >
            BUILD
          </button>
        </div>

        <div className="assist-op">
          <div className="assist-op-row">
            <label className="collab-field">
              <span>REPLACE</span>
              <select
                value={target}
                onChange={(e) => {
                  const next = e.target.value as ReplaceTarget;
                  setTarget(next);
                  setStyle(styleNames(next)[0]);
                }}
              >
                <option value="hats">hi-hats</option>
                <option value="kicks">kicks</option>
                <option value="snares">snares</option>
              </select>
            </label>
            <label className="collab-field">
              <span>WITH STYLE</span>
              <select value={style} onChange={(e) => setStyle(e.target.value)}>
                {stylesForTarget.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            className="btn btn-export"
            onClick={() =>
              apply(`${target} → ${style}`, () =>
                services.store.execute(assistReplace(doc, pattern.id, target, style, seed)),
              )
            }
          >
            REPLACE
          </button>
        </div>

        <div className="assist-op">
          <button
            type="button"
            className="btn btn-export"
            onClick={() => apply("Fill added", () => services.store.execute(assistFill(doc, pattern.id, seed)))}
          >
            FILL LAST BAR (crescendo)
          </button>
        </div>
      </div>
      {flash && <div className="slice-info">{flash}</div>}
    </div>
  );
}
