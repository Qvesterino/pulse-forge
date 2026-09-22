import {
  decodeMrt2AudioPacket,
  parseMrt2ControlMessage,
  serializeMrt2ControlMessage,
  type Mrt2ControlMessage,
} from "./protocol";
import {
  Mrt2CompanionProvider,
  type Mrt2CompanionEvent,
  type Mrt2CompanionProviderOptions,
  type Mrt2CompanionTransport,
} from "./companion-provider";

export interface Mrt2LocalhostWebSocketOptions {
  url: string;
  authToken?: string;
  WebSocketImpl?: typeof WebSocket;
}

export interface Mrt2LocalhostProviderOptions
  extends Omit<Mrt2CompanionProviderOptions, "transportFactory">, Mrt2LocalhostWebSocketOptions {}

function assertAllowedLocalhostUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MRT2 companion URL is invalid");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("MRT2 companion requires ws:// or wss://");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("MRT2 companion connections are limited to localhost");
  }
  if (url.username || url.password) throw new Error("MRT2 companion credentials must not be embedded in the URL");
  return url;
}

/** Explicit opt-in browser transport; the URL is never read from project data. */
export async function connectMrt2LocalhostWebSocket(
  options: Mrt2LocalhostWebSocketOptions,
): Promise<Mrt2CompanionTransport> {
  const url = assertAllowedLocalhostUrl(options.url);
  const Socket = options.WebSocketImpl ?? globalThis.WebSocket;
  if (!Socket) throw new Error("WebSocket is unavailable in this host");
  const socket = new Socket(url.toString());
  socket.binaryType = "arraybuffer";
  const listeners = new Set<(event: Mrt2CompanionEvent) => void>();
  let opened = false;
  let closed = false;
  const emit = (event: Mrt2CompanionEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      opened = true;
      resolve();
    });
    socket.addEventListener("error", () => {
      if (!opened) reject(new Error("MRT2 companion WebSocket connection failed"));
      emit({ kind: "closed", reason: "MRT2 companion WebSocket error" });
    });
    socket.addEventListener("close", () => {
      closed = true;
      emit({ kind: "closed", reason: "MRT2 companion WebSocket closed" });
    });
    socket.addEventListener("message", (event) => {
      try {
        if (typeof event.data === "string") {
          emit({ kind: "control", message: parseMrt2ControlMessage(event.data) });
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          emit({ kind: "audio", packet: decodeMrt2AudioPacket(event.data) });
          return;
        }
        throw new Error("MRT2 companion sent an unsupported WebSocket payload");
      } catch (error) {
        emit({
          kind: "control",
          message: {
            version: 1,
            type: "error",
            code: "invalid-message",
            message: error instanceof Error ? error.message : "Invalid MRT2 companion message",
          },
        });
      }
    });
  });
  await ready;
  return {
    sendControl: (message) => {
      if (closed || socket.readyState !== Socket.OPEN) throw new Error("MRT2 companion WebSocket is not open");
      const outgoing: Mrt2ControlMessage =
        message.type === "hello" && options.authToken ? { ...message, authToken: options.authToken } : message;
      socket.send(serializeMrt2ControlMessage(outgoing));
    },
    sendBinary: (packet) => {
      if (closed || socket.readyState !== Socket.OPEN) throw new Error("MRT2 companion WebSocket is not open");
      socket.send(packet);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      if (!closed) socket.close(1000, "KYX disposed");
    },
  };
}

/** Build a provider only after the caller has deliberately selected a localhost endpoint. */
export function createMrt2LocalhostProvider(options: Mrt2LocalhostProviderOptions): Mrt2CompanionProvider {
  const { url, authToken, WebSocketImpl, ...providerOptions } = options;
  return new Mrt2CompanionProvider({
    ...providerOptions,
    transportFactory: () => connectMrt2LocalhostWebSocket({ url, authToken, WebSocketImpl }),
  });
}

export function isAllowedMrt2CompanionUrl(value: string): boolean {
  try {
    assertAllowedLocalhostUrl(value);
    return true;
  } catch {
    return false;
  }
}
