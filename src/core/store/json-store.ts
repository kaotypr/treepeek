import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import type { Logger } from "../../shared/log";
import { type JsonDocument, pendingMigrations, SCHEMA_VERSION } from "./migrations";
import {
  laterTime,
  type ReviewStore,
  type StartOverride,
  StoreError,
  storeTime,
  type WorktreeRow,
} from "./review-store";

/** How long writes are gathered before one file write. */
export const JSON_FLUSH_DELAY_MS = 250;

const FILE_NAME = /^[0-9a-f]{64}\.json$/;

const TimeSchema = v.pipe(v.string(), v.isoTimestamp());

const DocumentSchema = v.object({
  schemaVersion: v.literal(SCHEMA_VERSION),
  commonDir: v.string(),
  worktrees: v.record(
    v.string(),
    v.object({
      checkoutPath: v.string(),
      startCommit: v.nullable(v.string()),
      startObservedAt: v.nullable(TimeSchema),
      firstSeenAt: TimeSchema,
      lastSeenAt: TimeSchema,
    }),
  ),
  startOverrides: v.record(v.string(), v.object({ commit: v.string(), setAt: TimeSchema })),
});

type RepositoryDocument = v.InferOutput<typeof DocumentSchema>;

export interface JsonStoreOptions {
  /** Delay before gathered writes reach the disk. Default `JSON_FLUSH_DELAY_MS`. */
  flushDelayMs?: number;
  log?: Logger;
}

/** The file a repository's document lives in: the SHA-256 of its common dir. */
export function repositoryFileName(commonDir: string): string {
  return `${createHash("sha256").update(commonDir).digest("hex")}.json`;
}

/**
 * The store as one JSON file per repository (`store/<sha256 of common dir>.json`), the
 * review-marks design's fallback for a runtime without `node:sqlite`. Every document is
 * read at open and served from memory; writes are gathered for `flushDelayMs` and written
 * atomically (temporary file, fsync, rename). `close()` writes anything pending.
 *
 * A file that cannot be read or checked is moved aside (`<name>.corrupt-<time>`) and the
 * repository starts empty, so one damaged file never stops the app; a file from a newer
 * schema stops the store from opening, so it is never overwritten.
 */
export class JsonReviewStore implements ReviewStore {
  readonly engine = "json" as const;
  readonly dir: string;
  readonly #flushDelayMs: number;
  readonly #log: Logger | undefined;
  readonly #documents = new Map<string, RepositoryDocument>();
  /** worktreeId → commonDir, so calls by id find their repository. */
  readonly #repositoryOf = new Map<string, string>();
  readonly #dirty = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #open = true;

  constructor(dir: string, options: JsonStoreOptions = {}) {
    this.dir = dir;
    this.#flushDelayMs = options.flushDelayMs ?? JSON_FLUSH_DELAY_MS;
    this.#log = options.log;
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (FILE_NAME.test(name)) this.#load(name);
    }
  }

  upsertWorktree(row: WorktreeRow): void {
    this.#check();
    const document = this.#document(row.commonDir);
    const existing = document.worktrees[row.worktreeId];
    document.worktrees[row.worktreeId] = existing
      ? {
          ...existing,
          startObservedAt: existing.startObservedAt ?? row.startObservedAt,
          lastSeenAt: laterTime(existing.lastSeenAt, row.lastSeenAt),
        }
      : {
          checkoutPath: row.checkoutPath,
          startCommit: row.startCommit,
          startObservedAt: row.startObservedAt,
          firstSeenAt: row.firstSeenAt,
          lastSeenAt: row.lastSeenAt,
        };
    this.#repositoryOf.set(row.worktreeId, row.commonDir);
    this.#changed(row.commonDir);
  }

  getWorktree(worktreeId: string): WorktreeRow | null {
    this.#check();
    const commonDir = this.#repositoryOf.get(worktreeId);
    const entry =
      commonDir === undefined ? undefined : this.#documents.get(commonDir)?.worktrees[worktreeId];
    return commonDir !== undefined && entry ? { worktreeId, commonDir, ...entry } : null;
  }

  findWorktreesByPath(commonDir: string, checkoutPath: string): WorktreeRow[] {
    this.#check();
    const document = this.#documents.get(commonDir);
    if (!document) return [];
    return Object.entries(document.worktrees)
      .filter(([, entry]) => entry.checkoutPath === checkoutPath)
      .map(([worktreeId, entry]) => ({ worktreeId, commonDir, ...entry }))
      .sort((a, b) =>
        a.firstSeenAt === b.firstSeenAt
          ? a.worktreeId.localeCompare(b.worktreeId)
          : a.firstSeenAt < b.firstSeenAt
            ? -1
            : 1,
      );
  }

  setStartOverride(worktreeId: string, commit: string | null, setAt: string = storeTime()): void {
    this.#check();
    const commonDir = this.#repositoryOf.get(worktreeId);
    const document = commonDir === undefined ? undefined : this.#documents.get(commonDir);
    if (commonDir === undefined || !document) {
      if (commit === null) return;
      throw new StoreError(`No worktree ${worktreeId} has been recorded.`);
    }
    if (commit === null) {
      if (!(worktreeId in document.startOverrides)) return;
      delete document.startOverrides[worktreeId];
    } else {
      document.startOverrides[worktreeId] = { commit, setAt };
    }
    this.#changed(commonDir);
  }

  getStartOverride(worktreeId: string): StartOverride | null {
    this.#check();
    const commonDir = this.#repositoryOf.get(worktreeId);
    const entry =
      commonDir === undefined
        ? undefined
        : this.#documents.get(commonDir)?.startOverrides[worktreeId];
    return entry ? { worktreeId, ...entry } : null;
  }

  /** Writes every changed document now. */
  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    for (const commonDir of [...this.#dirty]) {
      const document = this.#documents.get(commonDir);
      if (document) this.#write(document);
      this.#dirty.delete(commonDir);
    }
  }

  close(): void {
    if (!this.#open) return;
    this.flush();
    this.#open = false;
  }

  #check(): void {
    if (!this.#open) throw new StoreError("The store is closed.");
  }

  #document(commonDir: string): RepositoryDocument {
    let document = this.#documents.get(commonDir);
    if (!document) {
      const fresh: JsonDocument = { schemaVersion: 0, commonDir };
      document = migrateDocument(fresh);
      this.#documents.set(commonDir, document);
    }
    return document;
  }

  #changed(commonDir: string): void {
    this.#dirty.add(commonDir);
    if (this.#timer) return;
    const timer = setTimeout(() => this.flush(), this.#flushDelayMs);
    timer.unref?.();
    this.#timer = timer;
  }

  #load(name: string): void {
    const file = join(this.dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      this.#setAside(file, "it is not valid JSON", error);
      return;
    }
    const version = isObject(raw) ? raw.schemaVersion : undefined;
    if (typeof version === "number" && version > SCHEMA_VERSION) {
      throw new StoreError(
        `${name} was written by a newer Treepeek (schema ${version}; this one knows ${SCHEMA_VERSION}).`,
      );
    }
    let document: RepositoryDocument;
    try {
      if (!isObject(raw)) throw new Error("not an object");
      document = migrateDocument(raw);
    } catch (error) {
      this.#setAside(file, "its contents do not match the schema", error);
      return;
    }
    if (
      this.#documents.has(document.commonDir) ||
      name !== repositoryFileName(document.commonDir)
    ) {
      this.#setAside(file, "it belongs to another file name", null);
      return;
    }
    this.#documents.set(document.commonDir, document);
    for (const worktreeId of Object.keys(document.worktrees)) {
      this.#repositoryOf.set(worktreeId, document.commonDir);
    }
  }

  #setAside(file: string, reason: string, error: unknown): void {
    const aside = `${file}.corrupt-${storeTime().replace(/[:]/g, "")}`;
    try {
      renameSync(file, aside);
    } catch {
      // Leave it where it is; it will be overwritten by the next write for that repository.
    }
    this.#log?.warn("set aside an unreadable store file", {
      file,
      aside,
      reason,
      error: error instanceof Error ? error.message : undefined,
    });
  }

  #write(document: RepositoryDocument): void {
    const file = join(this.dir, repositoryFileName(document.commonDir));
    const temporary = `${file}.${process.pid}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(document)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  }
}

/** Brings a document to `SCHEMA_VERSION` and checks it; throws when it does not fit. */
function migrateDocument(document: JsonDocument): RepositoryDocument {
  const version = document.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new StoreError("The document has no schema version.");
  }
  for (const migration of pendingMigrations(version)) {
    migration.json(document);
    document.schemaVersion = migration.version;
  }
  return v.parse(DocumentSchema, document);
}

function isObject(value: unknown): value is JsonDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
