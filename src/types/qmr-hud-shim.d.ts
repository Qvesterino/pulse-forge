/**
 * Type shims for the Qvester QMR HUD packages. The real packages ship TS
 * SOURCE from the sibling monorepo (vite resolves them via resolve.alias —
 * see vite.config.ts). These declarations keep OUR tsc program from pulling
 * 4+ MB of foreign sources: the runtime contract here mirrors only what KYX
 * consumes (the deferred mini chip + the command bus host API).
 *
 * NOTE: this file must stay a GLOBAL declaration file (no top-level
 * imports/exports) — otherwise `declare module` becomes augmentation and
 * the ambient resolution stops working. The react types come through the
 * import("react") type form.
 */
declare module "@qvester/qmr-hud/qmr-mini-chip-mount.tsx" {
  export interface QmrMiniChipMountProps {
    appId?: string;
    /** Optional manifest override; otherwise reads the global registry. */
    manifest?: unknown;
    surfaceId?: string;
    /** Optional receiver hook for inbound handoff packets. */
    onHandoff?: (packet: Record<string, unknown>) => void | Promise<void>;
    initialOpen?: boolean;
    [key: string]: unknown;
  }
  export const QmrMiniChipMount: import("react").ComponentType<QmrMiniChipMountProps>;
}

declare module "@qvester/qmr-hud/command-bus.ts" {
  export interface CommandResult {
    ok: boolean;
    unsupported?: boolean;
    message?: string;
    data?: unknown;
    url?: string;
  }
  export function listenForCommands(
    appId: string,
    handler: (command: {
      type: string;
      [key: string]: unknown;
    }) => CommandResult | Promise<CommandResult> | void | Promise<void>,
  ): () => void;
  export function dispatchViaHostBus(
    appId: string,
    command: { type: string; [key: string]: unknown },
    timeoutMs?: number,
  ): Promise<CommandResult | null>;
}
