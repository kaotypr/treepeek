/**
 * A map that keeps at most `maxEntries` entries, dropping the least recently used one when
 * a new key would pass the limit. `get` and `set` count as use; `peek` and `has` do not.
 * `Infinity` makes it an ordinary unbounded map.
 */
export class Lru<K, V> {
  readonly maxEntries: number;
  readonly #entries = new Map<K, V>();

  constructor(maxEntries: number) {
    if (!(maxEntries === Infinity || (Number.isInteger(maxEntries) && maxEntries > 0))) {
      throw new RangeError("maxEntries must be a positive integer or Infinity");
    }
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The value for `key`, marking it most recently used. */
  get(key: K): V | undefined {
    if (!this.#entries.has(key)) return undefined;
    const value = this.#entries.get(key) as V;
    // A Map iterates in insertion order, so re-inserting moves the key to the newest end.
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  /** The value for `key`, without counting as use. */
  peek(key: K): V | undefined {
    return this.#entries.get(key);
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  /** Stores `value` as the most recently used entry, evicting the oldest past the limit. */
  set(key: K, value: V): this {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Keys from least to most recently used. */
  keys(): IterableIterator<K> {
    return this.#entries.keys();
  }
}
