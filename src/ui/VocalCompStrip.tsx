import type { CompPlan } from "../vocal/comping";

/**
 * VOCAL COMP STRIP (vocal lane UI) — the take picker's plan view: one cell
 * per bar, colored by the take that WINS that bar, gaps rendered honestly as
 * unsung. Pure render over a `CompPlan` — the panel owns the takes, the PCM
 * and the apply action; this component only shows who wins which bar.
 */

const TAKE_HUES = [210, 150, 30, 280, 0, 170];

export function takeHue(index: number): number {
  return TAKE_HUES[index % TAKE_HUES.length]!;
}

export interface VocalCompStripProps {
  plan: CompPlan;
  /** Take display labels, index-aligned with the plan's takes array. */
  labels: string[];
}

export function VocalCompStrip({ plan, labels }: VocalCompStripProps) {
  const bars = Array.from({ length: plan.bars }, (_, bar) => {
    const segment = plan.segments.find((s) => bar >= s.startBar && bar <= s.endBar);
    return { bar, segment };
  });
  const contributors = plan.perTakeBars
    .map((count, index) => ({ count, index }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.index);

  return (
    <div className="vocal-comp-strip" data-testid="vocal-comp-strip">
      <div className="vocal-comp-strip__bars" style={{ display: "flex", gap: 2 }}>
        {bars.map(({ bar, segment }) => {
          const hue = segment ? takeHue(segment.takeIndex) : undefined;
          const label = segment
            ? `${labels[segment.takeIndex] ?? `Take ${segment.takeIndex + 1}`} — takt ${bar + 1}`
            : `takt ${bar + 1} — ticho`;
          return (
            <div
              key={bar}
              title={label}
              data-bar={bar}
              data-take={segment?.takeIndex ?? "gap"}
              style={{
                flex: 1,
                height: 18,
                borderRadius: 3,
                background: hue === undefined ? "transparent" : `hsl(${hue} 60% 45%)`,
                border: "1px solid rgba(255,255,255,0.15)",
              }}
            />
          );
        })}
      </div>
      <div className="vocal-comp-strip__legend" style={{ display: "flex", gap: 12, marginTop: 4, fontSize: 11 }}>
        {contributors.map(({ count, index }) => (
          <span key={index}>
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: 2,
                marginRight: 4,
                background: `hsl(${takeHue(index)} 60% 45%)`,
              }}
            />
            {labels[index] ?? `Take ${index + 1}`} · {count} taktov
          </span>
        ))}
        <span style={{ opacity: 0.6 }}>
          {plan.sungBars}/{plan.bars} spievaných
        </span>
      </div>
    </div>
  );
}
