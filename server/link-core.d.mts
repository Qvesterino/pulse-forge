/**
 * Type surface of server/link-core.mjs — the pure Ableton Link session core.
 * Hand-maintained: the implementation is plain ESM JavaScript (it runs under
 * bare `node server/link-bridge.mjs`), so this declaration is what lets
 * tests and tools consume it under strict TypeScript.
 */

export declare const LINK_DEFAULT_PORT: number;
export declare const LINK_DEFAULT_HOST: string;
export declare const MIN_TEMPO: number;
export declare const MAX_TEMPO: number;
export declare const DEFAULT_QUANTUM: number;
export declare const MAX_INTEGRATION_MS: number;

export declare function clampTempo(bpm: number): number | null;

export interface LinkCoreFrame {
  type: "link";
  /** Absolute session beats at `at` (tempo-integrated). */
  beat: number;
  tempo: number;
  playing: boolean;
  quantum: number;
  peers: number;
  /** Epoch ms of the beat sample. */
  at: number;
}

export declare function createLinkCore(options?: { quantum?: number; tempo?: number; now?: () => number }): {
  readonly tempo: number;
  readonly playing: boolean;
  readonly quantum: number;
  readonly peerCount: number;
  touchPeer(id: unknown, name?: string): void;
  dropPeer(id: unknown): void;
  applyClientState(state?: { tempo?: number; playing?: boolean }): { tempo: number; playing: boolean };
  applyNativeState(state?: { tempo?: number; playing?: number | boolean }): void;
  frame(): LinkCoreFrame;
};
