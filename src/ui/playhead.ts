import { useEffect, useRef, useState } from "react";
import { STEP_TICKS } from "../project-model/types";
import type { Transport } from "../transport/Transport";
import type { ProjectDocument } from "../project-model/types";
import { getActivePattern } from "../project-model/types";
import { ticksPerBar, ticksPerBeat } from "../project-model/schema";

export function transportPosition(
  transport: Transport,
  doc: ProjectDocument,
): { bar: number; beat: number; step: number } {
  const tick = Math.max(0, transport.position);
  const tpb = ticksPerBar(doc);
  const tpbBeat = ticksPerBeat(doc);
  return {
    bar: Math.floor(tick / tpb) + 1,
    beat: Math.floor((tick % tpb) / tpbBeat) + 1,
    step: Math.floor((tick % tpbBeat) / STEP_TICKS) + 1,
  };
}

export function formatPosition(pos: { bar: number; beat: number; step: number }): string {
  return `${pos.bar}.${pos.beat}.${pos.step}`;
}

export function useTransportPosition(transport: Transport, doc: ProjectDocument): string {
  const [display, setDisplay] = useState("1.1.1");
  const rafRef = useRef(0);
  useEffect(() => {
    let last = "";
    const loop = () => {
      const next = formatPosition(transportPosition(transport, doc));
      if (next !== last) {
        last = next;
        setDisplay(next);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [transport, doc.timeSignature.numerator, doc.timeSignature.denominator]);
  return display;
}

export function usePlayheadStep(transport: Transport, doc: ProjectDocument): number {
  const pattern = getActivePattern(doc);
  const [step, setStep] = useState(-1);
  const rafRef = useRef(0);
  useEffect(() => {
    let last = -2;
    const loop = () => {
      let next = -1;
      if (transport.playing) {
        const patternTicks = STEP_TICKS * pattern.stepCount;
        const tick = ((transport.position % patternTicks) + patternTicks) % patternTicks;
        next = Math.floor(tick / STEP_TICKS);
      }
      if (next !== last) {
        last = next;
        setStep(next);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [transport, pattern.stepCount]);
  return step;
}
