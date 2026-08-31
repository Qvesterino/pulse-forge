type RafCallback = (timestamp: number) => void;

const callbacks = new Map<string, RafCallback>();
let rafId = 0;
let running = false;

function tick(now: number) {
  for (const [id, cb] of callbacks) {
    try {
      cb(now);
    } catch (err) {
      // One broken consumer must not freeze the shared bus: without this,
      // a throwing callback kills the rAF chain and every meter/animation
      // stops silently while `running` still claims the loop is alive.
      // Remove the offender (it would throw every frame) and keep going.
      console.error(`[rafLoop] callback "${id}" threw and was removed:`, err);
      callbacks.delete(id);
    }
  }
  if (callbacks.size > 0) {
    rafId = requestAnimationFrame(tick);
  } else {
    running = false;
  }
}

export function registerRaf(id: string, cb: RafCallback) {
  callbacks.set(id, cb);
  if (!running) {
    running = true;
    rafId = requestAnimationFrame(tick);
  }
}

export function unregisterRaf(id: string) {
  callbacks.delete(id);
  if (callbacks.size === 0 && running) {
    cancelAnimationFrame(rafId);
    running = false;
  }
}
