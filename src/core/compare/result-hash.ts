import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { FileChange } from "../../shared/domain/compare";
import { GitError } from "../git/errors";
import type { HashObjectBatch } from "../git/hash-object";
import type { GitPriority } from "../git/queue";
import { runGit } from "../git/run";
import { sniffBinary } from "./sniff";

/** A comparison file before its `resultHash` and `binary` are known. */
export interface ListedFile {
  /** Filled in by `fillResultHashes`. */
  change: FileChange;
  /**
   * The id Git reported for the right side: a blob id, a commit id for a submodule, or all
   * zeros for a working-tree file Git did not read (stat changed). `null` when Git reported
   * none (an untracked file).
   */
  reportedOid: string | null;
  /** The right side's mode as Git reported it (`160000` for a submodule), or `null`. */
  rightMode: string | null;
}

export interface ResultHashContext {
  /** The checkout's real path. */
  checkoutPath: string;
  hashObject: HashObjectBatch;
  signal: AbortSignal;
  /** Queue lane for hashing. Default `normal`. */
  priority?: GitPriority;
}

const ZERO_OID = /^0+$/;
const OID = /^[0-9a-f]{40,64}$/;
const GITLINK = "160000";
/** Working-tree files sniffed for a NUL byte at once. */
const SNIFF_PARALLEL = 16;

/**
 * Fills each file's `resultHash`, the identity of the right-side content a reviewer would
 * be looking at (domain model, FileChange), and `binary` for working-tree content:
 *
 * - a deletion: `deleted:<leftOid>`, so it can be viewed and marked too;
 * - a commit or index side: the blob id Git reported;
 * - a working-tree side: the id Git reported when it had no reason to read the file (its
 *   index entry is up to date), otherwise the id Git would give it, from `hash-object`
 *   (which writes nothing). A submodule's is the commit its checkout is at.
 *
 * Returns the finished list. An untracked file that vanished before it could be hashed is
 * left out; a tracked one Git cannot read gets `unreadable:<path>`, and a conflicted index
 * entry `unmerged:<path>`.
 */
export async function fillResultHashes(
  files: readonly ListedFile[],
  ctx: ResultHashContext,
): Promise<FileChange[]> {
  const toHash: string[] = [];
  const working: ListedFile[] = [];
  for (const file of files) {
    const { change } = file;
    if (change.status === "deleted") {
      change.resultHash = `deleted:${change.leftOid ?? "unknown"}`;
    } else if (change.right.kind !== "workingTree") {
      const oid = file.reportedOid;
      change.resultHash = oid && !ZERO_OID.test(oid) ? oid : `unmerged:${change.path}`;
    } else {
      working.push(file);
      const known = file.reportedOid !== null && !ZERO_OID.test(file.reportedOid);
      if (!known && file.rightMode !== GITLINK) toHash.push(change.path);
    }
  }

  const hashes =
    toHash.length > 0
      ? await ctx.hashObject.hash(toHash, {
          signal: ctx.signal,
          ...(ctx.priority ? { priority: ctx.priority } : {}),
        })
      : new Map<string, string>();
  const kept: ListedFile[] = [];
  for (const file of working) {
    const { change } = file;
    if (file.rightMode === GITLINK) {
      change.resultHash = await submoduleHead(ctx, change.path);
    } else if (file.reportedOid !== null && !ZERO_OID.test(file.reportedOid)) {
      change.resultHash = file.reportedOid;
    } else {
      const hash = hashes.get(change.path);
      if (hash === undefined && change.status === "untracked") continue;
      change.resultHash = hash ?? `unreadable:${change.path}`;
    }
    kept.push(file);
  }
  await sniffAll(
    kept.filter((file) => file.rightMode !== GITLINK),
    ctx,
  );
  const dropped = new Set(working.filter((file) => !kept.includes(file)));
  return files.filter((file) => !dropped.has(file)).map((file) => file.change);
}

async function sniffAll(files: readonly ListedFile[], ctx: ResultHashContext): Promise<void> {
  for (let index = 0; index < files.length; index += SNIFF_PARALLEL) {
    if (ctx.signal.aborted) throw new GitError("cancelled", "The comparison was cancelled.");
    await Promise.all(
      files.slice(index, index + SNIFF_PARALLEL).map(async (file) => {
        file.change.binary = await sniffBinary(ctx.checkoutPath, file.change.path);
      }),
    );
  }
}

/**
 * The commit a submodule's checkout is at, which Git leaves as zeros for a working-tree
 * side. `gitlink:<path>` when the folder is not a checkout of its own (not initialised).
 */
async function submoduleHead(ctx: ResultHashContext, path: string): Promise<string> {
  const folder = join(ctx.checkoutPath, path);
  try {
    const output = await runGit(
      folder,
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--verify", "HEAD"],
      {
        signal: ctx.signal,
        okExitCodes: [0, 128],
        ...(ctx.priority ? { priority: ctx.priority } : {}),
      },
    );
    const [topLevel = "", head = ""] = output.stdout.toString("utf8").split("\n");
    // Without its own checkout, Git answers for the outer repository instead.
    if (
      output.code === 0 &&
      OID.test(head) &&
      (await realpath(topLevel)) === (await realpath(folder))
    ) {
      return head;
    }
  } catch (error) {
    if (ctx.signal.aborted || (error instanceof GitError && error.code === "cancelled")) {
      throw error;
    }
  }
  return `gitlink:${path}`;
}
