/**
 * Runtime processor-error containment (cross-platform campaign GOAL 07).
 *
 * The browser silently KILLS an AudioWorkletProcessor that throws at
 * runtime (post-load): `isWorkletReady` is load-time only, the effect
 * runtime's degraded flag never flips, and nothing appears anywhere. This
 * module is the single reporter: node factories attach the guard, errors
 * are counted, and `getDiagnostics()` surfaces the count.
 *
 * Scope note: wiring is incremental — factories attach the guard as they
 * are touched; unwired factories are listed in docs/FAULT-CONTAINMENT.md.
 */

let runtimeProcessorErrors = 0;

/** Attach the runtime-error reporter to a worklet node. Idempotent per node. */
export function attachProcessorErrorGuard(node: AudioWorkletNode, label: string): void {
  node.onprocessorerror = () => {
    runtimeProcessorErrors += 1;
    console.error(
      `[worklet] processor error in "${label}" — the browser stopped the processor; ` +
        "the effect may be silent until the graph rebuilds (reload or re-trigger the effect)",
    );
  };
}

/** Total runtime processor errors this session (surfaced in Diagnostics). */
export function processorErrorCount(): number {
  return runtimeProcessorErrors;
}
