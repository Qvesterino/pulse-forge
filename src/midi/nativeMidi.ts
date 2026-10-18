/**
 * Web MIDI shim backed by the optional native bridge (ADR 0052).
 *
 * Chrome on Android does not expose Web MIDI. The shell supplies USB/BLE MIDI
 * through `window.kyxNative.midi`; this module exposes the small slice of the
 * Web MIDI surface the app already uses (`MIDIAccess`, inputs/outputs,
 * `midimessage`, `statechange`) so `MidiInput`/`MidiOutput` need no parallel
 * code path.
 *
 * Web MIDI wins when it exists: the shim only installs when
 * `navigator.requestMIDIAccess` is missing. A bridge injected after boot is
 * picked up by the next `requestAccess()` call because both MIDI classes call
 * `installNativeMidiShim()` first.
 */
import { getNativeMidiBridge, type NativeMidiBridge } from "../mobile/nativeBridge";

type MidiMessageHandler = ((event: MIDIMessageEvent) => void) | null;
type MidiStateHandler = ((event: MIDIConnectionEvent) => void) | null;

const SHIM_FLAG = "__kyxNativeMidiShim";
const MAX_EVENT_BYTES = 64;

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function sanitizeBytes(value: unknown): Uint8Array | null {
  if (!Array.isArray(value)) return null;
  const out = new Uint8Array(Math.min(value.length, MAX_EVENT_BYTES));
  for (let i = 0; i < out.length; i++) {
    const byte = value[i];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    out[i] = byte;
  }
  return out.length > 0 ? out : null;
}

class NativeMidiInputPort extends EventTarget {
  readonly type = "input";
  readonly version = "";
  readonly state = "connected";
  readonly connection = "open";
  onmidimessage: MidiMessageHandler = null;
  readonly id: string;
  readonly name: string;
  readonly manufacturer: string;

  constructor(port: { id: string; name?: string; manufacturer?: string }) {
    super();
    this.id = port.id;
    this.name = stringField(port.name, "Native MIDI input");
    this.manufacturer = stringField(port.manufacturer, "");
  }

  open(): Promise<unknown> {
    return Promise.resolve(this);
  }

  close(): Promise<unknown> {
    return Promise.resolve(this);
  }

  emit(data: Uint8Array): void {
    const event = new Event("midimessage") as Event & { data?: Uint8Array };
    Object.defineProperty(event, "data", { value: data, enumerable: true });
    try {
      this.onmidimessage?.(event as unknown as MIDIMessageEvent);
    } catch (error) {
      console.error("[native-midi] onmidimessage handler failed:", error);
    }
    this.dispatchEvent(event);
  }
}

class NativeMidiOutputPort {
  readonly type = "output";
  readonly version = "";
  readonly state = "connected";
  readonly connection = "open";
  readonly id: string;
  readonly name: string;
  readonly manufacturer: string;
  private readonly bridge: NativeMidiBridge;

  constructor(port: { id: string; name?: string; manufacturer?: string }, bridge: NativeMidiBridge) {
    this.id = port.id;
    this.name = stringField(port.name, "Native MIDI output");
    this.manufacturer = stringField(port.manufacturer, "");
    this.bridge = bridge;
  }

  open(): Promise<unknown> {
    return Promise.resolve(this);
  }

  close(): Promise<unknown> {
    return Promise.resolve(this);
  }

  send(data: number[] | Uint8Array): void {
    const bytes = Array.from(data);
    try {
      void Promise.resolve(this.bridge.send(this.id, bytes)).catch((error) => {
        console.warn("[native-midi] send failed:", error);
      });
    } catch (error) {
      console.warn("[native-midi] send threw:", error);
    }
  }
}

class NativeMidiAccess extends EventTarget {
  readonly inputs = new Map<string, NativeMidiInputPort>();
  readonly outputs = new Map<string, NativeMidiOutputPort>();
  readonly sysexEnabled = false;
  onstatechange: MidiStateHandler = null;
  private readonly bridge: NativeMidiBridge;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(bridge: NativeMidiBridge) {
    super();
    this.bridge = bridge;
    const unsubscribe = bridge.subscribe((event) => {
      const data = sanitizeBytes(event?.data);
      if (!data) return;
      const input = this.inputs.get(String(event?.inputId ?? ""));
      input?.emit(data);
    });
    if (typeof unsubscribe === "function") this.unsubscribers.push(unsubscribe);
  }

  private notifyPort(id: string, state: "connected" | "disconnected"): void {
    const event = { port: { id, state } } as unknown as MIDIConnectionEvent;
    try {
      this.onstatechange?.(event);
    } catch (error) {
      console.error("[native-midi] onstatechange handler failed:", error);
    }
    this.dispatchEvent(new Event("statechange"));
  }

  async refresh(): Promise<void> {
    const [inputs, outputs] = await Promise.all([this.bridge.listInputs(), this.bridge.listOutputs()]);
    const nextInputs = new Map<string, NativeMidiInputPort>();
    for (const port of inputs ?? []) {
      const id = String(port?.id ?? "");
      if (!id) continue;
      nextInputs.set(id, this.inputs.get(id) ?? new NativeMidiInputPort({ ...port, id }));
    }
    const nextOutputs = new Map<string, NativeMidiOutputPort>();
    for (const port of outputs ?? []) {
      const id = String(port?.id ?? "");
      if (!id) continue;
      nextOutputs.set(id, this.outputs.get(id) ?? new NativeMidiOutputPort({ ...port, id }, this.bridge));
    }

    const removed = [...this.inputs.keys()].filter((id) => !nextInputs.has(id));
    const added = [...nextInputs.keys()].filter((id) => !this.inputs.has(id));
    this.inputs.clear();
    for (const [id, port] of nextInputs) this.inputs.set(id, port);
    this.outputs.clear();
    for (const [id, port] of nextOutputs) this.outputs.set(id, port);

    for (const id of added) this.notifyPort(id, "connected");
    for (const id of removed) this.notifyPort(id, "disconnected");
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch {
        /* best effort */
      }
    }
    this.unsubscribers.length = 0;
  }

  private wireStateChanges(): void {
    const onState = this.bridge.onStateChange?.(() => {
      void this.refresh();
    });
    if (typeof onState === "function") this.unsubscribers.push(onState);
  }

  /** Called by the factory after the initial refresh. */
  start(): void {
    this.wireStateChanges();
  }
}

/**
 * Build the minimal Web MIDI access surface backed by the shell.
 * Exported for tests and for a future explicit "use native MIDI" action.
 */
export async function createNativeMidiAccess(bridge: NativeMidiBridge): Promise<MIDIAccess> {
  const access = new NativeMidiAccess(bridge);
  await access.refresh();
  access.start();
  return access as unknown as MIDIAccess;
}

/**
 * Install the shim only when Web MIDI is absent and a native MIDI bridge is
 * present. Returns true when the shim is (already) installed.
 */
export function installNativeMidiShim(bridge: NativeMidiBridge | null = getNativeMidiBridge()): boolean {
  if (!bridge || typeof navigator === "undefined") return false;
  if (typeof navigator.requestMIDIAccess === "function") return false;
  const nav = navigator as Navigator & { [SHIM_FLAG]?: boolean };
  if (nav[SHIM_FLAG]) return true;
  try {
    Object.defineProperty(navigator, "requestMIDIAccess", {
      configurable: true,
      value: () => createNativeMidiAccess(bridge),
    });
    nav[SHIM_FLAG] = true;
    return true;
  } catch {
    return false;
  }
}
