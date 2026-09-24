import { decodeMrt2AudioPacket, parseMrt2ControlMessage, type Mrt2ControlMessage } from "./protocol";
import { Mrt2CompanionProvider, type Mrt2CompanionEvent, type Mrt2CompanionTransport } from "./companion-provider";
import type { GenerativeCapabilities } from "../../types";

interface Mrt2WindowsBridgeEvent {
  transportId: string;
  kind: "control" | "audio" | "closed";
  message?: unknown;
  data?: unknown;
  reason?: string;
}

interface Mrt2WindowsBridge {
  getAvailability?: () => Promise<{ platform?: string; windowsCompanionInstalled?: boolean; status?: string }>;
  openTransport: () => Promise<string>;
  sendControl: (transportId: string, message: Mrt2ControlMessage) => Promise<void>;
  sendBinary: (transportId: string, packet: ArrayBuffer) => Promise<void>;
  closeTransport: (transportId: string) => Promise<void>;
  subscribe: (listener: (event: Mrt2WindowsBridgeEvent) => void) => () => void;
}

function toArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  throw new Error("MRT2 Windows transport received unsupported binary data");
}

async function connectWindowsTransport(): Promise<Mrt2CompanionTransport> {
  const bridge = window.kyxDesktop?.mrt2 as Mrt2WindowsBridge | undefined;
  if (!bridge) throw new Error("MRT2 Windows companion is available only in the KYX desktop app");
  if (bridge.getAvailability) {
    const availability = await bridge.getAvailability();
    if (availability.platform !== "win32") {
      throw new Error("MRT2 Windows companion is available only on Windows");
    }
  }
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
          message: error instanceof Error ? error.message : "Invalid MRT2 Windows companion message",
        },
      });
    }
  });

  return {
    sendControl: (message) => {
      if (closed) throw new Error("MRT2 Windows transport is closed");
      return bridge.sendControl(transportId, message);
    },
    sendBinary: (packet) => {
      if (closed) throw new Error("MRT2 Windows transport is closed");
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

/** Windows desktop provider backed by the optional fixed companion executable. */
export function createMrt2WindowsProvider(
  options: { timeoutMs?: number; capabilities?: Partial<GenerativeCapabilities> } = {},
): Mrt2CompanionProvider {
  return new Mrt2CompanionProvider({
    ...options,
    capabilities: {
      // Windows must not claim live playback until the companion has passed
      // the benchmark gate and reported a non-capture execution tier.
      supportsRealtime: false,
      supportsCapture: true,
      ...options.capabilities,
    },
    transportFactory: () => connectWindowsTransport(),
  });
}
