/** Minimal surface the vitest suite drives directly (gallery-agent-origin
 * tests instantiate the server factory without listening). */

export interface GalleryEntry {
  id: string;
  title: string;
  author: string;
  origin: "human" | "agent";
  agent: string | null;
  tags: string[];
  code: string;
  bpm: number | null;
  [key: string]: unknown;
}

export interface CollabServerHandle {
  server: import("node:http").Server;
  wss: import("ws").WebSocketServer;
  gallery: {
    add(input: Record<string, unknown>): { item?: GalleryEntry; error?: string };
    list(): GalleryEntry[];
    find(id: string): GalleryEntry | null;
    registerPlay(id: string): number | null;
  };
  metrics: unknown;
}

export function createCollabServer(options?: Record<string, unknown>): CollabServerHandle;
