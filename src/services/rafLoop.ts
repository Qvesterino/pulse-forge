type RafCallback = (timestamp: number) => void;

const callbacks = new Map<string, RafCallback>();
let rafId = 0;
let running = false;

function tick(now: number) {
  for (const cb of callbacks.values()) {
    cb(now);
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
