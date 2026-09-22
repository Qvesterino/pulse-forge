import type {
  GeneratedAudio,
  GenerativeAudioListener,
  GenerativeAudioProvider,
  GenerativeAudioSession,
  GenerativeCapabilities,
  GenerativeCaptureRequest,
  GenerativeInput,
  GenerativeSessionConfig,
  GenerativeStatus,
  GenerativeStatusListener,
} from "./types";

/** Runtime capability registry. Project files store provider ids, never provider instances. */
export class GenerativeProviderRegistry {
  private readonly providers = new Map<string, GenerativeAudioProvider>();

  register(provider: GenerativeAudioProvider): void {
    if (!provider.id || provider.id.length > 80) throw new Error("Generative provider id is invalid");
    if (this.providers.has(provider.id)) throw new Error(`Generative provider ${provider.id} is already registered`);
    this.providers.set(provider.id, provider);
  }

  unregister(providerId: string): boolean {
    return this.providers.delete(providerId);
  }

  get(providerId: string): GenerativeAudioProvider | undefined {
    return this.providers.get(providerId);
  }

  list(): GenerativeAudioProvider[] {
    return [...this.providers.values()];
  }

  capabilities(providerId: string): GenerativeCapabilities | undefined {
    return this.providers.get(providerId)?.getCapabilities();
  }
}

class UnavailableSession implements GenerativeAudioSession {
  readonly capabilities: GenerativeCapabilities;
  readonly config: GenerativeSessionConfig;
  private status: GenerativeStatus;
  private readonly statusListeners = new Set<GenerativeStatusListener>();

  constructor(capabilities: GenerativeCapabilities, config: GenerativeSessionConfig, reason: string) {
    this.capabilities = capabilities;
    this.config = config;
    this.status = { state: "unavailable", message: reason };
  }

  getStatus(): GenerativeStatus {
    return this.status;
  }

  subscribeStatus(listener: GenerativeStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  subscribeAudio(_listener: GenerativeAudioListener): () => void {
    return () => undefined;
  }

  async updateInput(_input: GenerativeInput): Promise<void> {
    this.throwUnavailable();
  }

  async start(): Promise<void> {
    this.throwUnavailable();
  }

  async stop(): Promise<void> {
    // Stopping an unavailable session is already complete.
  }

  async capture(_request: GenerativeCaptureRequest): Promise<GeneratedAudio> {
    this.throwUnavailable();
  }

  async dispose(): Promise<void> {
    this.status = { state: "disposed" };
    for (const listener of this.statusListeners) listener(this.status);
    this.statusListeners.clear();
  }

  private throwUnavailable(): never {
    throw new Error(this.status.message ?? "Generative provider is unavailable");
  }
}

/** Explicit provider entry used by hosts that know a provider is unavailable. */
export function createUnavailableGenerativeProvider(
  providerId: string,
  reason: string,
  modelId = "unknown",
): GenerativeAudioProvider {
  const capabilities: GenerativeCapabilities = {
    providerId,
    modelIds: [modelId],
    supportsRealtime: false,
    supportsCapture: false,
    supportsTextStyle: false,
    supportsAudioStyle: false,
    supportsNoteConditioning: false,
    supportsDrumsMode: false,
    supportsSeed: false,
    outputSampleRates: [],
    outputChannels: [],
    maxCaptureSeconds: 0,
  };
  return {
    id: providerId,
    getCapabilities: () => capabilities,
    createSession: async (config) => new UnavailableSession(capabilities, config, reason),
  };
}
