/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena — VocalForge IPC Contract
//
// Wraps a simple PeerRegistry to provide Ozvena-specific
// IPC operations: register Ozvena instances, subscribe to peer
// level notifications, and read peer masks for the masking meter.
//
// This is a self-contained implementation (no external package
// dependency) that mirrors the plugin-graph package API.
// ═══════════════════════════════════════════════════════════

/** Plugin kind — matches the native processor kind enum. */
export type PluginKind = "fxeq" | "voicestrip" | "hlasin" | "ultina" | "ozvena";

/** Unique identifier for a plugin instance within the host. */
export type PeerInstanceId = number;

/** Notification envelope broadcast by a peer. */
export interface PeerNotification {
  readonly fromInstanceId: PeerInstanceId;
  readonly fromKind: PluginKind;
  readonly freqHz: number;
  readonly magDb: number;
  readonly timestamp: number;
}

/** Callback type for level subscriptions. */
export type PeerNotificationCallback = (notification: PeerNotification) => void;

export interface PeerRegistry {
  register(kind: PluginKind, name: string, sampleRate: number, latencySamples: number, channelCount: number): PeerInstanceId;
  unregister(instanceId: PeerInstanceId): boolean;
  getPeer(instanceId: PeerInstanceId): { instanceId: PeerInstanceId; kind: PluginKind; name: string; sampleRate: number } | undefined;
  getPeers(): readonly { instanceId: PeerInstanceId; kind: PluginKind; name: string; sampleRate: number }[];
  notifyLevel(fromInstanceId: PeerInstanceId, freqHz: number, magDb: number, timestamp: number): void;
  subscribe(callback: PeerNotificationCallback): () => void;
  subscribePeer(instanceId: PeerInstanceId, callback: PeerNotificationCallback): () => void;
  reset(): void;
}

let nextInstanceId: PeerInstanceId = 1;

export function createPeerRegistry(): PeerRegistry {
  const peers = new Map<PeerInstanceId, { instanceId: PeerInstanceId; kind: PluginKind; name: string; sampleRate: number }>();
  const subscriptions = new Set<PeerNotificationCallback>();
  const peerSubscriptions = new Map<PeerInstanceId, Set<PeerNotificationCallback>>();

  return {
    register(kind, name, sampleRate, _latencySamples, _channelCount) {
      const id = nextInstanceId++;
      peers.set(id, { instanceId: id, kind, name, sampleRate });
      return id;
    },

    unregister(instanceId) {
      const deleted = peers.delete(instanceId);
      peerSubscriptions.delete(instanceId);
      return deleted;
    },

    getPeer(instanceId) {
      return peers.get(instanceId);
    },

    getPeers() {
      return Array.from(peers.values());
    },

    notifyLevel(fromInstanceId, freqHz, magDb, timestamp) {
      const peer = peers.get(fromInstanceId);
      if (!peer) return;

      const notification: PeerNotification = {
        fromInstanceId,
        fromKind: peer.kind,
        freqHz,
        magDb,
        timestamp,
      };

      for (const cb of subscriptions) {
        try { cb(notification); } catch { /* swallow */ }
      }

      const peerCbs = peerSubscriptions.get(fromInstanceId);
      if (peerCbs) {
        for (const cb of peerCbs) {
          try { cb(notification); } catch { /* swallow */ }
        }
      }
    },

    subscribe(callback) {
      subscriptions.add(callback);
      return () => subscriptions.delete(callback);
    },

    subscribePeer(instanceId, callback) {
      if (!peerSubscriptions.has(instanceId)) {
        peerSubscriptions.set(instanceId, new Set());
      }
      peerSubscriptions.get(instanceId)!.add(callback);
      return () => peerSubscriptions.get(instanceId)?.delete(callback);
    },

    reset() {
      peers.clear();
      subscriptions.clear();
      peerSubscriptions.clear();
    },
  };
}

/** Global singleton (used by the host). */
export const globalPeerRegistry: PeerRegistry = createPeerRegistry();

export interface OzvenaIpc {
  register(name: string, sampleRate: number, latencySamples: number, channelCount: number): PeerInstanceId;
  unregister(): void;
  getPeers(): readonly PeerNotification[];
  getInstanceId(): PeerInstanceId | null;
  subscribe(callback: PeerNotificationCallback): () => void;
  subscribePeer(instanceId: PeerInstanceId, callback: PeerNotificationCallback): () => void;
  notifyLevel(freqHz: number, magDb: number): void;
  getLastPeerLevels(): Map<PeerInstanceId, PeerNotification>;
}

export function createOzvenaIpc(
  registry: PeerRegistry = globalPeerRegistry,
): OzvenaIpc {
  let instanceId: PeerInstanceId | null = null;
  const lastLevels = new Map<PeerInstanceId, PeerNotification>();

  return {
    register(name, sr, latencySamples, channelCount) {
      // Re-registering (e.g. a re-prepare after a device change) must drop
      // the previous registry entry first — otherwise the old peer id
      // lingers forever as a zombie that still receives broadcasts.
      if (instanceId !== null) {
        registry.unregister(instanceId);
      }
      instanceId = registry.register("ozvena", name, sr, latencySamples, channelCount);
      return instanceId;
    },

    unregister() {
      if (instanceId !== null) {
        registry.unregister(instanceId);
        instanceId = null;
        // Drop cached levels of the departed instance so ducking/masking
        // logic never reads stale data from a peer that no longer exists.
        lastLevels.clear();
      }
    },

    getPeers() {
      if (instanceId === null) return [];
      return Array.from(lastLevels.values()).filter((n) => n.fromInstanceId !== instanceId);
    },

    getInstanceId() {
      return instanceId;
    },

    subscribe(callback) {
      return registry.subscribe((n) => {
        lastLevels.set(n.fromInstanceId, n);
        callback(n);
      });
    },

    subscribePeer(peerId, callback) {
      return registry.subscribePeer(peerId, (n) => {
        lastLevels.set(n.fromInstanceId, n);
        callback(n);
      });
    },

    notifyLevel(freqHz, magDb) {
      if (instanceId === null) return;
      registry.notifyLevel(instanceId, freqHz, magDb, performance.now());
    },

    getLastPeerLevels() {
      return new Map(lastLevels);
    },
  };
}