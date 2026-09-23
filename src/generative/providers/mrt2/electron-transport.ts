import { decodeMrt2AudioPacket, parseMrt2ControlMessage, type Mrt2ControlMessage } from "./protocol";
import { Mrt2CompanionProvider, type Mrt2CompanionEvent, type Mrt2CompanionTransport } from "./companion-provider";

interface Mrt2ElectronBridgeEvent {
  transportId: string;
  kind: "control" | "audio" | "closed";
  message?: unknown;
  data?: unknown;
  reason?: string;
}

interface Mrt2ElectronBridge {
  openTransport: () => Promise<string>;
  sendControl: (transportId: string, message: Mrt2ControlMessage) => Promise<void>;
  sendBinary: (transportId: string, packet: ArrayBuffer) => Promise<void>;
  closeTransport: (transportId: string) => Promise<void>;
  subscribe: (listener: (event: Mrt2ElectronBridgeEvent) => void) => () => void;
}

function toArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  throw new Error("MRT2 Electron transport received unsupported binary data");
}

async function connectElectronTransport(): Promise<Mrt2CompanionTransport> {
  const bridge = window.kyxDesktop?.mrt2 as Mrt2ElectronBridge | undefined;
  if (!bridge) throw new Error("MRT2 native transport is available only in the KYX desktop app");
  const transportId = await bridge.openTransport();
  const listeners = new Set<(event: Mrt2CompanionEvent) => void>();
  let closed = false;
  const emit = (event: Mrt2CompanionEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const unsubscribe = bridge.subscribe((event) => {
    if (closed || event?.transportId !== transportId) return;
    try {
      if (event.kind === "control") {
        emit({ kind: "control", message: parseMrt2ControlMessage(event.message) });
      } else if (event.kind === "audio") {
        emit({ kind: "audio", packet: decodeMrt2AudioPacket(toArrayBuffer(event.data)) });
      } else if (event.kind === "closed") {
        closed = true;
        unsubscribe();
        emit({ kind: "closed", reason: typeof event.reason === "string" ? event.reason : undefined });
      }
    } catch (error) {
      emit({
        kind: "control",
        message: {
          version: 1,
          type: "error",
          code: "invalid-message",
          message: error instanceof Error ? error.message : "Invalid MRT2 native-host message",
        },
      });
    }
  });

  return {
    sendControl: (message) => {
      if (closed) throw new Error("MRT2 Electron transport is closed");
      return bridge.sendControl(transportId, message);
    },
    sendBinary: (packet) => {
      if (closed) throw new Error("MRT2 Electron transport is closed");
      return bridge.sendBinary(transportId, packet);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      listeners.clear();
      await bridge.closeTransport(transportId);
    },
  };
}

/** Desktop-only provider backed by the fixed native MRT2 helper over Electron IPC. */
export function createMrt2ElectronProvider(options: { timeoutMs?: number } = {}): Mrt2CompanionProvider {
  return new Mrt2CompanionProvider({
    ...options,
    transportFactory: () => connectElectronTransport(),
  });
}
