export interface SharedPixiTextureLease<Value> {
  readonly value: Value;
  release(): void;
}

interface PixiTextureCacheEntry<Value> {
  readonly promise: Promise<Value>;
  readonly controller: AbortController;
  references: number;
  value: Value | undefined;
  lastIdleTick: number;
  disposeOnIdle: boolean;
  weight: number;
}

interface PixiTextureCacheLimits {
  readonly entries: number;
  readonly weight: number;
}

/** Reference-counted async cache with a configurable, bounded idle LRU. */
export class SharedPixiTextureCache<Key, Value> {
  private readonly entries = new Map<Key, PixiTextureCacheEntry<Value>>();
  private readonly load: (key: Key, signal: AbortSignal) => Promise<Value>;
  private readonly dispose: (value: Value) => void;
  private readonly measure: (value: Value) => number;
  private readonly onDelete: (key: Key) => void;
  private readonly defaultLimits: PixiTextureCacheLimits;
  private readonly limitOwners = new Map<symbol, PixiTextureCacheLimits>();
  private maximumIdleEntries: number;
  private maximumIdleWeight: number;
  private tick = 0;

  constructor(
    load: (key: Key, signal: AbortSignal) => Promise<Value>,
    dispose: (value: Value) => void,
    maximumIdleEntries: number,
    measure: (value: Value) => number = () => 1,
    maximumIdleWeight = Number.POSITIVE_INFINITY,
    onDelete: (key: Key) => void = () => undefined,
  ) {
    this.load = load;
    this.dispose = dispose;
    this.measure = measure;
    this.onDelete = onDelete;
    this.defaultLimits = {
      entries: this.normalizeLimit(maximumIdleEntries),
      weight: this.normalizeWeight(maximumIdleWeight),
    };
    this.maximumIdleEntries = this.defaultLimits.entries;
    this.maximumIdleWeight = this.defaultLimits.weight;
  }

  /**
   * Register one live owner's cache budget. The shared cache observes the most
   * restrictive active budget so scene creation order cannot silently change
   * another scene's memory contract.
   */
  registerLimits(maximumIdleEntries: number, maximumIdleWeight: number): () => void {
    const owner = Symbol("pixi-texture-cache-owner");
    this.limitOwners.set(owner, {
      entries: this.normalizeLimit(maximumIdleEntries),
      weight: this.normalizeWeight(maximumIdleWeight),
    });
    this.applyLimits();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.limitOwners.delete(owner);
      this.applyLimits();
    };
  }

  has(key: Key): boolean {
    return this.entries.has(key);
  }

  async acquire(key: Key, signal?: AbortSignal): Promise<SharedPixiTextureLease<Value>> {
    if (signal?.aborted) throw this.abortError();
    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: PixiTextureCacheEntry<Value> = {
        promise: Promise.resolve().then(() => this.load(key, controller.signal)),
        controller,
        references: 0,
        value: undefined,
        lastIdleTick: 0,
        disposeOnIdle: false,
        weight: 0,
      };
      created.promise.then(
        (value) => {
          created.value = value;
          created.weight = this.normalizeWeight(this.measure(value));
          if (this.entries.get(key) !== created) {
            this.dispose(value);
            return;
          }
          if (created.references === 0 && created.disposeOnIdle) {
            this.disposeEntry(key, created);
          }
        },
        () => {
          this.deleteEntry(key, created);
        },
      );
      this.entries.set(key, created);
      entry = created;
    }

    entry.references += 1;
    let value: Value;
    try {
      value = await this.waitForEntry(entry, signal);
    } catch (error) {
      this.release(key, entry);
      throw error;
    }

    let released = false;
    return {
      value,
      release: () => {
        if (released) return;
        released = true;
        this.release(key, entry);
      },
    };
  }

  /** Dispose listed entries now, or as soon as their final owner releases. */
  disposeWhenIdle(keys: Iterable<Key>): void {
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      entry.disposeOnIdle = true;
      if (entry.references !== 0) continue;
      if (entry.value === undefined) this.cancelPendingEntry(key, entry);
      else this.disposeEntry(key, entry);
    }
  }

  private release(key: Key, entry: PixiTextureCacheEntry<Value>): void {
    if (entry.references <= 0) return;
    entry.references -= 1;
    if (entry.references !== 0 || this.entries.get(key) !== entry) return;
    if (entry.value === undefined) {
      this.cancelPendingEntry(key, entry);
      return;
    }
    if (entry.disposeOnIdle) {
      this.disposeEntry(key, entry);
      return;
    }
    entry.lastIdleTick = this.tick += 1;
    this.trimIdleEntries();
  }

  private trimIdleEntries(): void {
    const idle = [...this.entries.entries()]
      .filter((entry): entry is [Key, PixiTextureCacheEntry<Value>] => {
        return entry[1].references === 0 && entry[1].value !== undefined;
      })
      .sort((left, right) => left[1].lastIdleTick - right[1].lastIdleTick);
    let idleWeight = idle.reduce((total, candidate) => {
      return total + candidate[1].weight;
    }, 0);
    let idleEntries = idle.length;
    for (let index = 0; index < idle.length; index += 1) {
      if (idleEntries <= this.maximumIdleEntries && idleWeight <= this.maximumIdleWeight) {
        break;
      }
      const candidate = idle[index];
      if (!candidate) continue;
      const [key, entry] = candidate;
      if (this.entries.get(key) === entry && entry.references === 0) {
        this.disposeEntry(key, entry);
        idleEntries -= 1;
        idleWeight = Math.max(0, idleWeight - entry.weight);
      }
    }
  }

  private applyLimits(): void {
    let entries = this.defaultLimits.entries;
    let weight = this.defaultLimits.weight;
    for (const limits of this.limitOwners.values()) {
      entries = Math.min(entries, limits.entries);
      weight = Math.min(weight, limits.weight);
    }
    this.maximumIdleEntries = entries;
    this.maximumIdleWeight = weight;
    this.trimIdleEntries();
  }

  private disposeEntry(key: Key, entry: PixiTextureCacheEntry<Value>): void {
    if (this.entries.get(key) !== entry || entry.references !== 0 || entry.value === undefined) {
      return;
    }
    this.deleteEntry(key, entry);
    this.dispose(entry.value);
  }

  private cancelPendingEntry(key: Key, entry: PixiTextureCacheEntry<Value>): void {
    if (this.entries.get(key) !== entry || entry.references !== 0 || entry.value !== undefined) {
      return;
    }
    this.deleteEntry(key, entry);
    entry.disposeOnIdle = true;
    entry.controller.abort();
  }

  private deleteEntry(key: Key, entry: PixiTextureCacheEntry<Value>): boolean {
    if (this.entries.get(key) !== entry) return false;
    this.entries.delete(key);
    this.onDelete(key);
    return true;
  }

  private waitForEntry(entry: PixiTextureCacheEntry<Value>, signal?: AbortSignal): Promise<Value> {
    if (!signal) return entry.promise;
    if (signal.aborted) return Promise.reject(this.abortError());
    return new Promise<Value>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        callback();
      };
      const abort = (): void => finish(() => reject(this.abortError()));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      entry.promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  private abortError(): Error {
    const error = new Error("Pixi texture loading was aborted");
    error.name = "AbortError";
    return error;
  }

  private normalizeLimit(value: number): number {
    const limit = Number(value);
    return Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 48;
  }

  private normalizeWeight(value: number): number {
    const weight = Number(value);
    return Number.isFinite(weight) ? Math.max(0, Math.trunc(weight)) : Number.POSITIVE_INFINITY;
  }
}
