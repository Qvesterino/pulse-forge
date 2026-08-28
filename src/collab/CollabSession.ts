import { CollaborationProvider, type CollaboratorInfo, type CursorState } from "./CollaborationProvider";
import type * as Y from "yjs";

export type CollabStatus = "connecting" | "connected" | "disconnected";

/** Six-char lowercase room code, e.g. "k3x9qz" — short enough to say out loud. */
export function randomRoomId(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no lookalikes (i/l/1/o/0)
  let id = "";
  for (let i = 0; i < 6; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

const PRODUCER_NAMES = ["Nova", "Static", "Ember", "Vapor", "Circuit", "Prism", "Drift", "Pulse", "Echo", "Grid"];
const USER_COLORS = ["#f59e0b", "#22d3ee", "#a78bfa", "#34d399", "#f472b6", "#60a5fa", "#fbbf24", "#fb7185"];

export function randomUser(): CollaboratorInfo {
  return {
    id: Math.random().toString(36).slice(2, 10),
    name: PRODUCER_NAMES[Math.floor(Math.random() * PRODUCER_NAMES.length)],
    color: USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)],
  };
}

/** Default collab server for the current origin (dev: ws://<host>:1234). */
export function defaultServerUrl(): string {
  if (typeof location === "undefined") return "ws://127.0.0.1:1234";
  if (location.protocol === "https:") return `wss://${location.host}`;
  return `ws://${location.hostname || "127.0.0.1"}:1234`;
}

/** Parse ?collab=<room>[&server=<url>] from a search string (pure for tests). */
export function collabParamsFromSearch(search: string): { roomId: string; serverUrl: string } | null {
  if (!search) return null;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const roomId = params.get("collab");
  if (!roomId) return null;
  const serverUrl = params.get("server") || defaultServerUrl();
  return { roomId, serverUrl };
}

/** Build a share URL for a room (pure for tests). */
export function shareUrl(roomId: string, serverUrl: string, origin: string): string {
  const url = new URL(origin);
  url.searchParams.set("collab", roomId);
  if (serverUrl !== defaultServerUrl()) url.searchParams.set("server", serverUrl);
  return url.toString();
}

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
    this.status_ = this.provider.connected
      ? "connected"
      : this.status_ === "connecting"
        ? "connecting"
        : "disconnected";
    for (const listener of this.listeners) listener();
  }
}
