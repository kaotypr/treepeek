import { CatFileBatch } from "../git/cat-file";
import { HashObjectBatch } from "../git/hash-object";
import { RepoCache } from "./repo-cache";

/** Who holds shared resources: a session (one per window), by its id. */
export type Holder = number | string;

/** What a repository's sessions share: its caches and its `cat-file` process. */
export interface RepositoryResources {
  readonly commonDir: string;
  readonly cache: RepoCache;
  readonly catFile: CatFileBatch;
}

/** What a checkout's sessions share: its `hash-object` process and hash cache. */
export interface CheckoutResources {
  readonly checkoutPath: string;
  readonly hashObject: HashObjectBatch;
}

/** How resources are made and released; tests replace them. */
export interface CoreStateFactories {
  repository(commonDir: string): RepositoryResources;
  checkout(checkoutPath: string): CheckoutResources;
}

const defaultFactories: CoreStateFactories = {
  repository: (commonDir) => ({
    commonDir,
    cache: new RepoCache(commonDir),
    catFile: new CatFileBatch(commonDir),
  }),
  checkout: (checkoutPath) => ({ checkoutPath, hashObject: new HashObjectBatch(checkoutPath) }),
};

interface Held<V> {
  value: V;
  holders: Set<Holder>;
}

/** Values made on first acquire and disposed of when their last holder lets go. */
class RefCounted<K, V> {
  readonly #items = new Map<K, Held<V>>();
  readonly #make: (key: K) => V;
  readonly #dispose: (value: V) => void;

  constructor(make: (key: K) => V, dispose: (value: V) => void) {
    this.#make = make;
    this.#dispose = dispose;
  }

  /** Acquiring again with the same holder does not count twice. */
  acquire(holder: Holder, key: K): V {
    let held = this.#items.get(key);
    if (!held) {
      held = { value: this.#make(key), holders: new Set() };
      this.#items.set(key, held);
    }
    held.holders.add(holder);
    return held.value;
  }

  release(holder: Holder, key: K): void {
    const held = this.#items.get(key);
    if (!held?.holders.delete(holder) || held.holders.size > 0) return;
    this.#items.delete(key);
    this.#dispose(held.value);
  }

  releaseHolder(holder: Holder): void {
    for (const [key, held] of [...this.#items]) {
      if (held.holders.has(holder)) this.release(holder, key);
    }
  }

  peek(key: K): V | undefined {
    return this.#items.get(key)?.value;
  }

  holders(key: K): number {
    return this.#items.get(key)?.holders.size ?? 0;
  }

  get size(): number {
    return this.#items.size;
  }

  disposeAll(): void {
    const values = [...this.#items.values()];
    this.#items.clear();
    for (const held of values) this.#dispose(held.value);
  }
}

/**
 * Repository-level state shared by every session in the core service (architecture
 * design, "Why one shared core service"): per repository its `RepoCache` and `CatFileBatch`,
 * per checkout its `HashObjectBatch`. Sessions acquire what their scan uses; a resource is
 * released, closing its processes and dropping its caches, when the last session holding
 * it releases it or closes.
 */
export class CoreState {
  readonly #repositories: RefCounted<string, RepositoryResources>;
  readonly #checkouts: RefCounted<string, CheckoutResources>;

  constructor(factories: CoreStateFactories = defaultFactories) {
    this.#repositories = new RefCounted(factories.repository, (resources) => {
      resources.catFile.close();
      resources.cache.clear();
    });
    this.#checkouts = new RefCounted(factories.checkout, (resources) => {
      resources.hashObject.close();
    });
  }

  /** The shared resources of the repository at `commonDir`, held by `holder` until released. */
  acquireRepository(holder: Holder, commonDir: string): RepositoryResources {
    return this.#repositories.acquire(holder, commonDir);
  }

  /** The shared resources of the checkout at `checkoutPath`, held by `holder` until released. */
  acquireCheckout(holder: Holder, checkoutPath: string): CheckoutResources {
    return this.#checkouts.acquire(holder, checkoutPath);
  }

  releaseRepository(holder: Holder, commonDir: string): void {
    this.#repositories.release(holder, commonDir);
  }

  releaseCheckout(holder: Holder, checkoutPath: string): void {
    this.#checkouts.release(holder, checkoutPath);
  }

  /** Releases everything `holder` acquired (a session closing). */
  releaseHolder(holder: Holder): void {
    this.#repositories.releaseHolder(holder);
    this.#checkouts.releaseHolder(holder);
  }

  /** The repository's resources if some session holds them; acquires nothing. */
  repository(commonDir: string): RepositoryResources | undefined {
    return this.#repositories.peek(commonDir);
  }

  /** The checkout's resources if some session holds them; acquires nothing. */
  checkout(checkoutPath: string): CheckoutResources | undefined {
    return this.#checkouts.peek(checkoutPath);
  }

  /** How many holders the repository's resources have. */
  repositoryHolders(commonDir: string): number {
    return this.#repositories.holders(commonDir);
  }

  /** How many holders the checkout's resources have. */
  checkoutHolders(checkoutPath: string): number {
    return this.#checkouts.holders(checkoutPath);
  }

  /** Repositories and checkouts currently held. */
  get size(): { repositories: number; checkouts: number } {
    return { repositories: this.#repositories.size, checkouts: this.#checkouts.size };
  }

  /** Releases everything at once (the core service shutting down). */
  close(): void {
    this.#repositories.disposeAll();
    this.#checkouts.disposeAll();
  }
}
