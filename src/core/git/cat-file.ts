import { BatchProcess, type BatchRequestOptions } from "./batch-process";
import { GitError, GitParseError } from "./errors";

/** A blob read in full. */
export interface BlobContent {
  size: number;
  data: Buffer;
  tooLarge?: never;
}

/** A blob over the caller's cap: only its size was read, never its body. */
export interface BlobTooLarge {
  tooLarge: true;
  size: number;
}

export type BlobRead = BlobContent | BlobTooLarge;

export interface CatFileBatchOptions {
  /** Idle time before the process closes. Default `BATCH_IDLE_MS`. */
  idleMs?: number;
  /** Time limit for one read. Default `GIT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** An object id: hex only, so it can never smuggle a second command onto the line. */
const OID = /^[0-9a-f]{4,64}$/i;

const WHAT = "cat-file --batch-command";

type Header =
  | { kind: "found"; type: string; size: number }
  | { kind: "missing" | "ambiguous" }
  | { kind: "notBlob"; type: string }
  | { kind: "tooLarge"; size: number };

/**
 * Reads blobs from one repository through one long-lived `git cat-file --batch-command`
 * (git-service design, "Long-lived batch processes"), one per common dir. Every read asks
 * for the object's size first (`info`) and asks for the body (`contents`) only when it fits
 * the caller's cap, so a blob over the cap is never read. `--batch-command` came in Git
 * 2.36.0, the minimum.
 */
export class CatFileBatch {
  readonly commonDir: string;
  readonly #batch: BatchProcess;

  /** `commonDir` is the repository's common dir; git runs there (`-C`). */
  constructor(commonDir: string, options: CatFileBatchOptions = {}) {
    this.commonDir = commonDir;
    this.#batch = new BatchProcess({
      cwd: commonDir,
      args: ["cat-file", "--batch-command"],
      ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  /** The running process's pid, or `null` when none is running. */
  get pid(): number | null {
    return this.#batch.pid;
  }

  /** Bytes read from git's stdout so far, across restarts. */
  get bytesRead(): number {
    return this.#batch.bytesRead;
  }

  /**
   * Reads the blob `oid`: its bytes when it is at most `maxBytes`, otherwise only its size.
   * Fails with `refNotFound` when the repository has no such object (or the abbreviation
   * is ambiguous), and with `internal` when the object is not a blob.
   */
  async read(oid: string, maxBytes: number, options: BatchRequestOptions): Promise<BlobRead> {
    if (!OID.test(oid)) throw new GitError("internal", "cat-file was given a malformed object id.");
    const result = await this.#batch.request(async (io): Promise<Header | BlobContent> => {
      io.write(`info ${oid}\n`);
      const header = parseHeader(await io.readLine());
      if (header.kind !== "found") return header;
      if (header.type !== "blob") return { kind: "notBlob", type: header.type };
      if (header.size > maxBytes) return { kind: "tooLarge", size: header.size };
      io.write(`contents ${oid}\n`);
      const again = parseHeader(await io.readLine());
      if (again.kind !== "found" || again.size !== header.size) {
        throw new GitParseError(WHAT, "the object changed between two reads");
      }
      const body = await io.readBytes(header.size + 1);
      if (body[header.size] !== 0x0a) throw new GitParseError(WHAT, "the body is not terminated");
      return { size: header.size, data: body.subarray(0, header.size) };
    }, options);
    if (!("kind" in result)) return result;
    switch (result.kind) {
      case "tooLarge":
        return { tooLarge: true, size: result.size };
      case "missing":
      case "ambiguous":
        throw new GitError("refNotFound", `Git has no single object ${oid}.`);
      case "notBlob":
        throw new GitError("internal", `Object ${oid} is a ${result.type}, not a blob.`);
      case "found":
        throw new GitParseError(WHAT, "a header was left unanswered");
    }
  }

  /** Stops the process; later reads fail with `cancelled`. */
  close(): void {
    this.#batch.close();
  }
}

/** `<oid> <type> <size>`, `<oid> missing` or `<oid> ambiguous`. */
function parseHeader(line: Buffer): Header {
  const fields = line.toString("latin1").split(" ");
  if (fields.length === 2 && (fields[1] === "missing" || fields[1] === "ambiguous")) {
    return { kind: fields[1] };
  }
  const [oid, type, size] = fields;
  if (fields.length !== 3 || !oid || !type || !size || !/^\d+$/.test(size)) {
    throw new GitParseError(WHAT, `unexpected header "${line.toString("latin1").slice(0, 200)}"`);
  }
  return { kind: "found", type, size: Number(size) };
}
