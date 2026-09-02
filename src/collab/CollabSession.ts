import {
  CollaborationProvider,
  type CollaboratorInfo,
  type CursorState,
  type RemoteCursor,
} from "./CollaborationProvider";
import type * as Y from "yjs";

// Pure helpers moved to collabShared.ts so the app shell can use them
// without loading this module (and yjs) into the main bundle. Re-exported
// here for backwards compatibility with existing imports/tests.
export {
  randomRoomId,
  randomUser,
  defaultServerUrl,
  collabParamsFromSearch,
  shareUrl,
  type CollabStatus,
} from "./collabShared";

import { randomUser, type CollabStatus } from "./collabShared";

/**
 * A live collaboration session over y-websocket: reactive status +
 * participant list for the UI, cursor broadcasting for presence.
 */
export class CollabSession {
  readonly roomId: string;
  readonly serverUrl: string;
  readonly localUser: CollaboratorInfo;
  private provider: CollaborationProvider;
  private listeners = new Set<() => void>();
  private status_: CollabStatus = "connecting";
  private participants_: CollaboratorInfo[] = [];
  private cursors_: RemoteCursor[] = [];
  private unsubs: Array<() => void> = [];

  constructor(yDoc: Y.Doc, roomId: string, serverUrl: string, user: CollaboratorInfo = randomUser()) {
    this.roomId = roomId;
    this.serverUrl = serverUrl;
    this.localUser = user;
    this.provider = new CollaborationProvider(yDoc, roomId, user);
  }

  /** Connect and start tracking status/participants. Safe to call once. */
  connect(): void {
    this.provider.connect(this.serverUrl);
    this.unsubs.push(
      this.provider.onStatusChange((status) => {
        this.status_ = status;
        this.refresh();
      }),
      this.provider.onAwarenessChange(() => this.refresh()),
    );
  }

  get status(): CollabStatus {
    return this.status_;
  }

  /** Remote collaborators (the local user is not included). */
  get participants(): CollaboratorInfo[] {
    return this.participants_;
  }

  /** Remote presence cursors (empty when nobody is hovering an editor). */
  get remoteCursors(): RemoteCursor[] {
    return this.cursors_;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Broadcast the local cursor/selection for presence. */
  setCursor(cursor: CursorState | null): void {
    this.provider.setCursor(cursor);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubs) unsubscribe();
    this.unsubs = [];
    this.provider.dispose();
    this.listeners.clear();
  }

  private refresh(): void {
    this.participants_ = this.provider.getCollaborators();
    this.cursors_ = this.provider.getRemoteCursors();
    this.status_ = this.provider.connected
      ? "connected"
      : this.status_ === "connecting"
        ? "connecting"
        : "disconnected";
    for (const listener of this.listeners) listener();
  }
}
