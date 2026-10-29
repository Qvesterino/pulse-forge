import type { ReactElement } from "react";

/**
 * Arrangement collaborator 2/4 — the view controls: ruler unit, the scene
 * intensity lane, and the zoom group (− / FIT / +).
 *
 * Extracted verbatim from ArrangementPanel. Pure renderer: zoom clamping, the
 * scroll ref and the MIN/MAX constants stay in the shell, which is why the
 * three zoom buttons arrive as verbs rather than a setter.
 */

export interface ArrangementViewControlsProps {
  rulerMode: "bars" | "seconds";
  onToggleRulerMode: () => void;
  showIntensity: boolean;
  onToggleIntensity: () => void;
  /** CF-09: page-jump the view so a moving playhead stays visible. */
  followPlayhead?: boolean;
  onToggleFollowPlayhead?: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onZoomIn: () => void;
}

export function ArrangementViewControls(props: ArrangementViewControlsProps): ReactElement {
  const {
    rulerMode,
    onToggleRulerMode,
    showIntensity,
    onToggleIntensity,
    followPlayhead,
    onToggleFollowPlayhead,
    onZoomOut,
    onFit,
    onZoomIn,
  } = props;
  return (
    <>
      <button
        type="button"
        className={`btn btn-small${rulerMode === "seconds" ? " active-solo" : ""}`}
        onClick={onToggleRulerMode}
      >
        {rulerMode === "bars" ? "BARS" : "SECS"}
      </button>
      <button
        type="button"
        className={`btn btn-small${showIntensity ? " active-solo" : ""}`}
        aria-pressed={showIntensity}
        title="Show the scene-intensity lane under the clip lane"
        onClick={onToggleIntensity}
      >
        INT
      </button>
      {onToggleFollowPlayhead !== undefined && (
        <button
          type="button"
          className={`btn btn-small${followPlayhead ? " active-solo" : ""}`}
          aria-pressed={followPlayhead}
          title="Follow playhead: while playing, the view page-jumps so the playhead stays visible. Scrolling yourself turns it off (the automatic jumps never do)."
          onClick={onToggleFollowPlayhead}
        >
          FOLLOW
        </button>
      )}
      <span className="arr-zoom-group" role="group" aria-label="Arrangement zoom">
        <button type="button" className="btn btn-small" aria-label="Zoom out" onClick={onZoomOut}>
          −
        </button>
        <button
          type="button"
          className="btn btn-small"
          aria-label="Fit arrangement"
          title="Fit the whole arrangement into the view"
          onClick={onFit}
        >
          FIT
        </button>
        <button type="button" className="btn btn-small" aria-label="Zoom in" onClick={onZoomIn}>
          +
        </button>
      </span>
    </>
  );
}
