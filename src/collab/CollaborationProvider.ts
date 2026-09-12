/**
 * CollaborationProvider — manages y-websocket connection for real-time sync.
 *
 * Handles:
 * - Connecting to a sync server room
 * - Awareness (user presence, cursor positions)
 * - Reconnection on network issues
 * - Cleanup on disconnect
 */
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { normalizeJamRole, type JamRole } from "./jamRoles";
import type { SharedTransportState } from "./transportSync";

export interface CollaboratorInfo {
  id: string;
  name: string;
  color: string;
  /** Self-selected jam role (presence — the server has no auth by design). */
  role?: JamRole;
}

export interface CursorState {
  view: "sequencer" | "arrangement" | "mixer" | "inspector" | "pianoroll";
  patternId?: string;
  padId?: string;
  stepIndex?: number;
  trackId?: string;
  pitch?: number;
}

/** A remote user's presence cursor, with who it belongs to. */
export interface RemoteCursor {
  user: CollaboratorInfo;
  cursor: CursorState;
}

/**
 * CollaborationProvider wraps y-websocket for real-time sync.
 * One provider per project room.
 */
export class CollaborationProvider {
  private provider: WebsocketProvider | null = null;
  private yDoc: Y.Doc;
  private roomId: string;
  private user: CollaboratorInfo;

  constructor(yDoc: Y.Doc, roomId: string, user: CollaboratorInfo) {
    this.yDoc = yDoc;
    this.roomId = roomId;
    this.user = user;
  }

  /** Connect to the sync server. */
  private syncedCb: ((hasRemote: boolean) => void) | null = null;

  /**
   * Called once on the first successful room sync: `hasRemote` tells the
   * caller whether the room already carried content (so a joining client can
   * adopt it instead of seeding its own initial document over it).
   */
  onSynced(cb: (hasRemote: boolean) => void): void {
    this.syncedCb = cb;
  }

  connect(serverUrl: string = "ws://localhost:1234"): void {
    if (this.provider) return;
    this.provider = new WebsocketProvider(serverUrl, this.roomId, this.yDoc, {
      connect: true,
    });
    // y-websocket emits "synced" (see its synced setter) but the installed
    // typings omit it from the event union — subscribe through the raw emitter.
    (this.provider as unknown as { on: (event: string, cb: () => void) => void }).on("synced", () => {
      this.syncedCb?.(this.yDoc.getMap("project").size > 0);
    });
    // Set local awareness state
    this.provider.awareness.setLocalState({
      user: this.user,
      cursor: null,
    });
  }

  /** Disconnect from the sync server. */
  disconnect(): void {
    if (this.provider) {
      this.provider.disconnect();
      this.provider.destroy();
      this.provider = null;
    }
  }

  /** Update the local cursor position for awareness. */
  setCursor(cursor: CursorState | null): void {
    this.provider?.awareness.setLocalStateField("cursor", cursor);
  }

  /** Change (and re-broadcast) the local jam role. */
  setRole(role: JamRole): void {
    this.user = { ...this.user, role: normalizeJamRole(role) };
    this.provider?.awareness.setLocalStateField("user", this.user);
  }

  /** Get all connected collaborators. */
  getCollaborators(): CollaboratorInfo[] {
    if (!this.provider) return [];
    const states = this.provider.awareness.getStates();
    const collaborators: CollaboratorInfo[] = [];
    states.forEach((state, clientId) => {
      if (clientId === this.provider?.awareness.clientID) return;
      if (state.user) collaborators.push(state.user);
    });
    return collaborators;
  }

  /** Remote cursors (awareness states that have both a user and a cursor). */
  getRemoteCursors(): RemoteCursor[] {
    if (!this.provider) return [];
    const states = this.provider.awareness.getStates();
    const cursors: RemoteCursor[] = [];
    states.forEach((state, clientId) => {
      if (clientId === this.provider?.awareness.clientID) return;
      if (state.user && state.cursor) cursors.push({ user: state.user, cursor: state.cursor });
    });
    return cursors;
  }

  /** Broadcast the local shared-transport state (Instant Jam pulse). */
  setTransportState(state: SharedTransportState): void {
    this.provider?.awareness.setLocalStateField("transport", state);
  }

  /**
   * Subscribe to remote shared-transport states. On every awareness change
   * the LATEST remote state (highest `at`, own echo excluded) is reported —
   * null when no peer has broadcast.
   */
  onTransportChange(
    callback: (state: SharedTransportState | null, fromClientId: number) => void,
  ): () => void {
    if (!this.provider) return () => {};
    const provider = this.provider;
    const handler = () => {
      const states = provider.awareness.getStates();
      const me = provider.awareness.clientID;
      let best: SharedTransportState | null = null;
      let bestId = -1;
      states.forEach((state: Record<string, unknown>, clientId: number) => {
        if (clientId === me) return;
        const t = state.transport as SharedTransportState | undefined;
        if (t && (!best || t.at > best!.at)) {
          best = t;
          bestId = clientId;
        }
      });
      callback(best, bestId);
    };
    provider.awareness.on("change", handler);
    return () => provider.awareness.off("change", handler);
  }

  /** Get the local client ID. */
  get clientId(): number {
    return this.provider?.awareness.clientID ?? 0;
  }

  /** Whether the provider is connected. */
  get connected(): boolean {
    return this.provider?.wsconnected ?? false;
  }

  /** Subscribe to connection state changes. */
  onStatusChange(callback: (status: "connected" | "disconnected") => void): () => void {
    if (!this.provider) return () => {};
    const handler = ({ status }: { status: string }) => {
      callback(status === "connected" ? "connected" : "disconnected");
    };
    this.provider.on("status", handler);
    return () => this.provider?.off("status", handler);
  }

  /** Subscribe to awareness changes. */
  onAwarenessChange(callback: () => void): () => void {
    if (!this.provider) return () => {};
    const handler = () => callback();
    this.provider.awareness.on("change", handler);
    return () => this.provider?.awareness.off("change", handler);
  }

  dispose(): void {
    this.disconnect();
  }
}
