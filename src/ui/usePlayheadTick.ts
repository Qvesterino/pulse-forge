import { useEffect, useId, useState } from "react";
import { registerRaf, unregisterRaf } from "../services/rafLoop";
import { useServices } from "./context";

/**
 * The transport's playhead tick — the tick the DSP is playing RIGHT NOW.
 *
 * A surface that shows "the value in effect" has to follow the playhead: an
 * automation lane's value is a function of the tick (audit F-09/F-10). Without
 * this, the surface would show the lane's value at tick 0 forever and the
 * number would be wrong for every tick after it.
 *
 * The transport plays on a 25 ms tick, but a human reading a knob needs ~10
 * updates a second, not 40 — and re-rendering a panel 40 times a second is
 * its own kind of lie about what the machine is doing. So the position is
 * sampled at 10 Hz through the SHARED rAF bus, and only while the transport
 * actually plays.
 *
 * `active` turns the subscription off for surfaces that do not need it: a
 * rack device whose effect has no automated parameter must not re-render 10
 * times a second because some OTHER effect in the project does.
 */
export function usePlayheadTick(active = true): number {
  const services = useServices();
  const instanceId = useId();
  const [tick, setTick] = useState(() => services.transport.position);

  useEffect(() => {
    if (!active) return;
    let lastSampleAt = 0;
    let registered = false;
    const rafId = `playhead-${instanceId}`;
    const update = (time: number) => {
      if (time - lastSampleAt < 100) return;
      lastSampleAt = time;
      const position = services.transport.position;
      setTick((current) => (Math.abs(position - current) < 1 ? current : position));
    };
    // The subscription starts stale-free: the tick is read at subscribe time,
    // so a surface that only just became active already shows the right
    // number instead of the one it mounted with.
    setTick(services.transport.position);
    const stop = services.transport.subscribePlaying((playing) => {
      if (playing && !registered) {
        registerRaf(rafId, update);
        registered = true;
      } else if (!playing && registered) {
        unregisterRaf(rafId);
        registered = false;
        setTick(services.transport.position);
      }
    });
    return () => {
      stop();
      if (registered) unregisterRaf(rafId);
    };
  }, [services, active, instanceId]);

  return tick;
}
