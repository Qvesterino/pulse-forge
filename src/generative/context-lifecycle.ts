/**
 * Rebinds generative playback to the live AudioContext as the engine replaces
 * it, and serializes stop/start transitions around suspend/resume events.
 */
export interface GenerativeLiveContextSource {
  subscribeLiveContext(listener: (context: AudioContext | null) => void): () => void;
}

export interface GenerativeContextRuntime {
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
}

export interface GenerativeContextLifecycle {
  pause(): void;
  resume(): void;
  dispose(): void;
}

export type GenerativeContextLifecycleError = (operation: "suspend" | "resume", error: unknown) => void;

export function bindGenerativeContextLifecycle(
  source: GenerativeLiveContextSource,
  runtime: GenerativeContextRuntime,
  isTransportPlaying: () => boolean,
  onError: GenerativeContextLifecycleError = () => undefined,
): GenerativeContextLifecycle {
  let context: AudioContext | null = null;
  let paused = false;
  let disposed = false;
  let transition = Promise.resolve();

  const enqueue = (operation: "suspend" | "resume", action: () => Promise<void>): void => {
    transition = transition
      .then(async () => {
        if (!disposed) await action();
      })
      .catch((error: unknown) => {
        if (disposed) return;
        try {
          onError(operation, error);
        } catch {
          /* a diagnostic callback must not poison later context transitions */
        }
      });
  };

  const pause = (): void => {
    if (disposed || !isTransportPlaying() || paused) return;
    paused = true;
    enqueue("suspend", () => runtime.stopAll());
  };

  const resume = (): void => {
    if (disposed || !paused) return;
    if (!isTransportPlaying()) {
      paused = false;
      return;
    }
    // Visibility can become active before the browser grants audio playback
    // again. Keep the pause latched until a running statechange arrives.
    if (!context || context.state !== "running") return;
    paused = false;
    enqueue("resume", async () => {
      if (!disposed && !paused && isTransportPlaying() && context?.state === "running") {
        await runtime.startAll();
      }
    });
  };

  const onStateChange = (): void => {
    if (!context || context.state !== "running") pause();
    else resume();
  };

  const onContextChange = (next: AudioContext | null): void => {
    if (disposed) return;
    if (context !== next) {
      const previous = context;
      // Context replacement invalidates the old AudioWorklet node even when
      // the browser never delivered a preceding `suspended` event.
      if (previous && isTransportPlaying()) pause();
      previous?.removeEventListener("statechange", onStateChange);
      context = next;
      context?.addEventListener("statechange", onStateChange);
    }
    onStateChange();
  };

  const unsubscribe = source.subscribeLiveContext(onContextChange);
  return {
    pause,
    resume,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      context?.removeEventListener("statechange", onStateChange);
      context = null;
    },
  };
}
