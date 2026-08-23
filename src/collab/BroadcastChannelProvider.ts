/**
 * BroadcastChannelProvider — syncs Y.Doc via BroadcastChannel for local testing.
 *
 * Two Y.Doc instances in the same browser (different tabs or windows) can
 * sync via BroadcastChannel. No server needed — validates the CRDT
 * architecture works correctly before deploying a sync server.
 *
 * Usage:
 *   const provider = new BroadcastChannelProvider(yDoc, "my-project");
 *   provider.connect();
 *   // ... edits sync automatically via BroadcastChannel
 *   provider.disconnect();
 */
import * as Y from "yjs";

export class BroadcastChannelProvider {
  private yDoc: Y.Doc;
  private roomName: string;
  private channel: BroadcastChannel | null = null;
  private awarenessStates = new Map<number, Record<string, unknown>>();
  private clientId: number;

  constructor(yDoc: Y.Doc, roomName: string) {
    this.yDoc = yDoc;
    this.roomName = roomName;
    this.clientId = Math.floor(Math.random() * 2147483647); // unique client ID
  }

  /** Connect to the BroadcastChannel and start syncing. */
  connect(): void {
    if (this.channel) return;

    this.channel = new BroadcastChannel(`pulse-forge-${this.roomName}`);

    // When the Y.Doc is updated locally, broadcast the update
    this.yDoc.on("update", (update: Uint8Array, origin: unknown) => {
      // Only broadcast updates from local edits (not from this provider)
      if (origin !== this) {
        this.channel?.postMessage({ type: "update", data: Array.from(update) });
      }
    });

    // When we receive an update from another tab, apply it
    this.channel.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "update") {
        const update = new Uint8Array(msg.data);
        Y.applyUpdate(this.yDoc, update, this);
      } else if (msg.type === "sync-request") {
        // Another tab is requesting the full state
        const state = Y.encodeStateAsUpdate(this.yDoc);
        this.channel?.postMessage({ type: "sync-response", data: Array.from(state) });
      } else if (msg.type === "sync-response") {
        // We received the full state from another tab
        const state = new Uint8Array(msg.data);
        Y.applyUpdate(this.yDoc, state, this);
      } else if (msg.type === "awareness") {
        this.awarenessStates.set(msg.clientId, msg.state);
        this.onAwarenessChange?.();
      }
    };

    // Request full sync from any existing tab
    this.channel.postMessage({ type: "sync-request" });
  }

  /** Disconnect from the BroadcastChannel. */
  disconnect(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }

  /** Get the local client ID. */
  get clientID(): number {
    return this.clientId;
  }

  /** Update local awareness state (broadcasts to other tabs). */
  setAwareness(state: Record<string, unknown>): void {
    this.awarenessStates.set(this.clientId, state);
    this.channel?.postMessage({ type: "awareness", clientId: this.clientId, state });
  }

  /** Get all awareness states (local + remote). */
  getAwarenessStates(): Map<number, Record<string, unknown>> {
    return new Map(this.awarenessStates);
  }

  /** Subscribe to awareness changes. */
  onAwarenessChange: (() => void) | null = null;

  /** Whether connected. */
  get connected(): boolean {
    return this.channel !== null;
  }

  dispose(): void {
    this.disconnect();
  }
}
