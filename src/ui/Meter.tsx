import { useEffect, useRef, useState } from "react";

export function Meter({ read }: { read: () => number }) {
  const [level, setLevel] = useState(0);
  const smoothed = useRef(0);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last >= 33) {
        last = t;
        const value = read();
        smoothed.current = Math.max(value, smoothed.current * 0.92);
        setLevel(Math.min(1, smoothed.current));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [read]);

  const color = level > 0.92 ? "#f87171" : level > 0.75 ? "#f59e0b" : "#4ade80";
  return (
    <div className="meter" role="meter" aria-label="Level meter" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="meter-fill" style={{ height: `${level * 100}%`, background: color }} />
    </div>
  );
}
