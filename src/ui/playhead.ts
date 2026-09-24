import { useEffect, useId, useRef, useState } from "react";
import { BAR_TICKS, STEP_TICKS } from "../project-model/types";
import type { Transport } from "../transport/Transport";
import type { ProjectDocument } from "../project-model/types";
import { getActivePattern } from "../project-model/types";
import { ticksPerBar, ticksPerBeat } from "../project-model/schema";
import { registerRaf, unregisterRaf } from "../services/rafLoop";

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
  // registerRaf is a shared Map (last writer wins) — a fixed string id would
  // make two mounted consumers overwrite/unregister each other's callback.
  const rafId = useId();
  useEffect(() => {
    let last = "";
    registerRaf(rafId, () => {
      const next = formatPosition(transportPosition(transport, doc));
      if (next !== last) {
        last = next;
        setDisplay(next);
      }
    });
    return () => unregisterRaf(rafId);
  }, [transport, doc.timeSignature.numerator, doc.timeSignature.denominator, rafId]);
  return display;
}

export function usePlayheadStep(transport: Transport, doc: ProjectDocument): number {
  const pattern = getActivePattern(doc);
  const [step, setStep] = useState(-1);
  const rafId = useId();
  useEffect(() => {
    let last = -2;
    registerRaf(rafId, () => {
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
    });
    return () => unregisterRaf(rafId);
  }, [transport, pattern.stepCount, rafId]);
  return step;
}

/**
 * Fractional bar position of the transport (0 = bar 1). Throttled to bar
 * resolution changes so the arrangement ruler playhead stays cheap.
 */
export function usePlayheadBar(transport: Transport): number {
  const [bar, setBar] = useState(0);
  const rafId = useId();
  useEffect(() => {
    let last = -1;
    registerRaf(rafId, () => {
      const next = Math.max(0, transport.position) / BAR_TICKS;
      const quantized = Math.floor(next * 8) / 8;
      if (quantized !== last) {
        last = quantized;
        setBar(quantized);
      }
    });
    return () => unregisterRaf(rafId);
  }, [transport, rafId]);
  return bar;
}

/**
 * Id of the arrangement item under the playhead — updates ONLY when the
 * playhead crosses an item boundary. Clip crossings are rare compared to the
 * 1/8-bar playhead cadence, so panels can highlight "the current clip"
 * without re-rendering themselves at the playhead's tick rate (quality
 * backlog B4). Restart-free: the item list is read through a ref.
 */
export function useCurrentItemId<T extends { id: string; startBar: number; lengthBars: number }>(
  items: T[],
  transport: Transport,
): string | null {
  const [currentId, setCurrentId] = useState<string | null>(null);
  const rafId = useId();
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    let last: string | null = null;
    registerRaf(rafId, () => {
      const bar = Math.max(0, transport.position) / BAR_TICKS;
      const hit = itemsRef.current.find(
        (item) => bar >= item.startBar && bar < item.startBar + item.lengthBars,
      );
      const id = hit?.id ?? null;
      if (id !== last) {
        last = id;
        setCurrentId(id);
      }
    });
    return () => unregisterRaf(rafId);
  }, [transport, rafId]);
  return currentId;
}
