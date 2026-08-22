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

export interface CollaboratorInfo {
  id: string;
  name: string;
  color: string;
}

export interface CursorState {
  view: "sequencer" | "arrangement" | "mixer" | "inspector";
  patternId?: string;
  padId?: string;
  stepIndex?: number;
  trackId?: string;
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
  connect(serverUrl: string = "ws://localhost:1234"): void {
    if (this.provider) return;
    this.provider = new WebsocketProvider(serverUrl, this.roomId, this.yDoc, {
      connect: true,
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
