import { useId } from "react";
import type { LoudnessTimeline } from "../audio-engine/kweighting";

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 218;
const PLOT_LEFT = 52;
const PLOT_RIGHT = 986;
const PLOT_TOP = 14;
const PLOT_BOTTOM = 174;
const LOUDNESS_FLOOR = -60;
const LOUDNESS_CEILING = 0;
const LOUDNESS_MARKS = [0, -12, -24, -36, -48, -60] as const;

function yForLufs(value: number): number {
  const bounded = Math.max(LOUDNESS_FLOOR, Math.min(LOUDNESS_CEILING, value));
  const fraction = (LOUDNESS_CEILING - bounded) / (LOUDNESS_CEILING - LOUDNESS_FLOOR);
  return PLOT_TOP + fraction * (PLOT_BOTTOM - PLOT_TOP);
}

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  if (safeSeconds < 10) return `${safeSeconds.toFixed(2)} s`;
  const wholeSeconds = Math.floor(safeSeconds);
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

export function MasteringLoudnessTimeline({ timeline }: { timeline: LoudnessTimeline | null }) {
  const instanceId = useId().replaceAll(":", "");
  const titleId = `mastering-loudness-title-${instanceId}`;
  const descriptionId = `mastering-loudness-description-${instanceId}`;
  if (!timeline || timeline.points.length === 0) {
    return (
      <section className="mastering-loudness-timeline" aria-label="Short-term loudness timeline">
        <div className="mastering-loudness-heading">
          <div>
            <h4>Short-term loudness</h4>
            <p>Three-second windows · 100 ms step</p>
          </div>
          <span className="mastering-loudness-unmeasured">NOT MEASURED</span>
        </div>
        <p className="mastering-loudness-empty">A measurable programme of at least 3 seconds is required.</p>
      </section>
    );
  }

  const timeRangeSeconds = Math.max(0, timeline.durationSeconds - timeline.startSeconds);
  const pointX = (timeSeconds: number): number =>
    PLOT_LEFT +
    (timeRangeSeconds > 0 ? (timeSeconds - timeline.startSeconds) / timeRangeSeconds : 0) * (PLOT_RIGHT - PLOT_LEFT);
  const meanLine = timeline.points
    .map((point) => `${pointX(point.timeSeconds).toFixed(1)},${yForLufs(point.meanLufs).toFixed(1)}`)
    .join(" ");
  const lowLufs = Math.min(...timeline.points.map((point) => point.lowLufs));
  const highLufs = Math.max(...timeline.points.map((point) => point.highLufs));
  const meanLufs = timeline.points.reduce((sum, point) => sum + point.meanLufs, 0) / timeline.points.length;
  const xMarks =
    timeRangeSeconds === 0
      ? ([0] as const)
      : timeRangeSeconds < 1
        ? ([0, 1] as const)
        : timeRangeSeconds < 5
          ? ([0, 0.5, 1] as const)
          : ([0, 0.25, 0.5, 0.75, 1] as const);

  return (
    <section className="mastering-loudness-timeline" aria-labelledby={titleId}>
      <div className="mastering-loudness-heading">
        <div>
          <h4 id={titleId}>Short-term loudness</h4>
          <p>Three-second windows · 100 ms step</p>
        </div>
        <span className="mastering-loudness-range">
          {lowLufs.toFixed(1)}–{highLufs.toFixed(1)} LUFS · mean {meanLufs.toFixed(1)} LUFS
        </span>
      </div>
      <svg
        className="mastering-loudness-chart"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
        preserveAspectRatio="none"
      >
        <desc id={descriptionId}>
          Three-second short-term loudness windows, stepped every 100 milliseconds. Each vertical range shows the lowest
          and highest windows in a time bucket; the line shows their mean. Values are shown from 0 to minus 60 LUFS.
          Timeline spans {formatTime(timeline.startSeconds)} to {formatTime(timeline.durationSeconds)}.
        </desc>
        {LOUDNESS_MARKS.map((mark) => {
          const y = yForLufs(mark);
          return (
            <g key={mark} className="mastering-loudness-gridline">
              <line x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={y} y2={y} />
              <text x={PLOT_LEFT - 8} y={y + 3} textAnchor="end">
                {mark}
              </text>
            </g>
          );
        })}
        {timeline.points.map((point, index) => {
          const x = pointX(point.timeSeconds);
          return (
            <line
              key={`range-${index}`}
              className="mastering-loudness-range-mark"
              x1={x}
              x2={x}
              y1={yForLufs(point.highLufs)}
              y2={yForLufs(point.lowLufs)}
            />
          );
        })}
        {timeline.points.length > 1 && (
          <polyline className="mastering-loudness-mean-line" points={meanLine} fill="none" />
        )}
        {timeline.points.length === 1 && (
          <circle
            className="mastering-loudness-mean-dot"
            cx={pointX(timeline.points[0].timeSeconds)}
            cy={yForLufs(timeline.points[0].meanLufs)}
            r={4}
          />
        )}
        {xMarks.map((fraction) => {
          const x = PLOT_LEFT + fraction * (PLOT_RIGHT - PLOT_LEFT);
          const time = timeline.startSeconds + fraction * timeRangeSeconds;
          return (
            <g key={fraction} className="mastering-loudness-time-mark">
              <line x1={x} x2={x} y1={PLOT_BOTTOM} y2={PLOT_BOTTOM + 5} />
              <text
                x={x}
                y={PLOT_BOTTOM + 21}
                textAnchor={fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"}
              >
                {formatTime(time)}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="mastering-loudness-footnote">
        Shading shows the min–max range within each display bucket; long renders are condensed to at most 1,200 buckets.
      </p>
    </section>
  );
}
