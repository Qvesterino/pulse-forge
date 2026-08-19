import { STORE_LIBRARY, openDb, tx } from "./db";

export interface LibraryState {
  favoriteAssets: string[];
  favoritePresets: string[];
  recentAssets: string[];
  recentPresets: string[];
}

const STATE_ID = "library-state";
const MAX_RECENT = 24;

const EMPTY: LibraryState = { favoriteAssets: [], favoritePresets: [], recentAssets: [], recentPresets: [] };

/**
 * Favorites + recents for factory assets and presets. Persisted as a single
 * blob in IndexedDB. Read-heavy (the sample/preset browsers subscribe to it).
 */
export class LibraryRepository {
  private listeners = new Set<(state: LibraryState) => void>();
  private cache: LibraryState | null = null;

  subscribe = (listener: (state: LibraryState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async load(): Promise<LibraryState> {
    try {
      const db = await openDb();
      const stored = await tx<LibraryState | undefined>(db, STORE_LIBRARY, "readonly", (store) => store.get(STATE_ID));
      const state = stored ? this.sanitize(stored) : EMPTY;
      this.cache = state;
      return state;
    } catch {
      return { ...EMPTY };
    }
  }

  /** Synchronous snapshot for React — falls back to an empty state until loaded. */
  get = (): LibraryState => this.cache ?? EMPTY;

  private sanitize(raw: Partial<LibraryState>): LibraryState {
    return {
      favoriteAssets: Array.isArray(raw.favoriteAssets) ? raw.favoriteAssets.filter((x) => typeof x === "string") : [],
      favoritePresets: Array.isArray(raw.favoritePresets) ? raw.favoritePresets.filter((x) => typeof x === "string") : [],
      recentAssets: Array.isArray(raw.recentAssets) ? raw.recentAssets.filter((x) => typeof x === "string") : [],
      recentPresets: Array.isArray(raw.recentPresets) ? raw.recentPresets.filter((x) => typeof x === "string") : [],
    };
  }

  private async mutate(mutator: (state: LibraryState) => LibraryState): Promise<LibraryState> {
    const base = this.cache ?? (await this.load());
    const next = mutator(base);
    this.cache = next;
    this.listeners.forEach((listener) => listener(next));
    try {
      const db = await openDb();
      await tx(db, STORE_LIBRARY, "readwrite", (store) => store.put({ id: STATE_ID, ...next }) as IDBRequest<IDBValidKey>);
    } catch {
      // persistence is best-effort; the in-memory cache already updated
    }
    return next;
  }

  toggleAssetFavorite(id: string): Promise<LibraryState> {
    return this.mutate((state) => {
      const favorites = state.favoriteAssets.includes(id)
        ? state.favoriteAssets.filter((x) => x !== id)
        : [...state.favoriteAssets, id];
      return { ...state, favoriteAssets: favorites };
    });
  }

  togglePresetFavorite(id: string): Promise<LibraryState> {
    return this.mutate((state) => {
      const favorites = state.favoritePresets.includes(id)
        ? state.favoritePresets.filter((x) => x !== id)
        : [...state.favoritePresets, id];
      return { ...state, favoritePresets: favorites };
    });
  }

  recordAsset(id: string): Promise<LibraryState> {
    return this.mutate((state) => {
      const recent = [id, ...state.recentAssets.filter((x) => x !== id)].slice(0, MAX_RECENT);
      return { ...state, recentAssets: recent };
    });
  }

  recordPreset(id: string): Promise<LibraryState> {
    return this.mutate((state) => {
      const recent = [id, ...state.recentPresets.filter((x) => x !== id)].slice(0, MAX_RECENT);
      return { ...state, recentPresets: recent };
    });
  }
}