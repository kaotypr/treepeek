import { createHash } from "node:crypto";
import type { KnownStart, Start } from "../../shared/domain/scan";
import type { ReviewStore, WorktreeRow } from "./review-store";
import { storeTime } from "./review-store";

/** The domain model's stand-in for an unknown start inside the identity hash. */
const NO_START = "∅";

/**
 * A checkout's identity as a reviewable unit across time (domain model, WorktreeIdentity):
 * `sha256(commonDir, checkoutPath, startCommit or "∅")`, as 64 hex characters. The fields
 * are joined with NUL, which no path or commit id can contain.
 */
export function worktreeId(
  commonDir: string,
  checkoutPath: string,
  startCommit: string | null,
): string {
  return createHash("sha256")
    .update([commonDir, checkoutPath, startCommit ?? NO_START].join("\0"))
    .digest("hex");
}

/** What the scan knows about a checkout when it resolves the checkout's identity. */
export interface IdentityInput {
  commonDir: string;
  checkoutPath: string;
  /** The oldest HEAD reflog entry that is an ancestor of HEAD, or `null` when there is none. */
  reflogStart: { commit: string; observedAt: string } | null;
}

/**
 * - `reflog`: the identity of the reflog start.
 * - `earlierIdentity`: the reflog has no start, and the one earlier identity recorded for
 *   this path (with a known start) is reused.
 * - `fresh`: the reflog has no start and there is no single earlier identity to reuse.
 */
export type IdentitySource = "reflog" | "earlierIdentity" | "fresh";

export interface ResolvedIdentity {
  worktreeId: string;
  /** The checkout's start: the user's override when there is one, which always wins. */
  start: Start;
  via: IdentitySource;
}

/**
 * Chooses the identity review marks and the start override attach to, records it as seen,
 * and works out the checkout's start (domain model, WorktreeIdentity):
 *
 * 1. With a reflog start, the identity is that start's. A worktree deleted and recreated
 *    at the same path has a new start, so it gets a new identity.
 * 2. Without one (the reflog expired), the one earlier identity recorded for this path
 *    with a known start is kept, its recorded start treated as an override, so a
 *    long-lived worktree's marks do not vanish. Identities recorded without a start do not
 *    count: they have no start to carry over.
 * 3. With zero or several such identities, the identity is a fresh one for "no start".
 *
 * A start override the user entered is stored per identity and wins over the start the
 * identity was made from; it never changes the identity itself, so setting one keeps the
 * marks.
 */
export function resolveIdentity(
  store: ReviewStore,
  input: IdentityInput,
  now: Date = new Date(),
): ResolvedIdentity {
  const seenAt = storeTime(now);
  const { commonDir, checkoutPath, reflogStart } = input;

  if (reflogStart) {
    const id = worktreeId(commonDir, checkoutPath, reflogStart.commit);
    store.upsertWorktree({
      worktreeId: id,
      commonDir,
      checkoutPath,
      startCommit: reflogStart.commit,
      startObservedAt: reflogStart.observedAt,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    });
    const start: KnownStart = { ...reflogStart, source: "reflog" };
    return { worktreeId: id, start: withOverride(store, id, start), via: "reflog" };
  }

  const earlier = store
    .findWorktreesByPath(commonDir, checkoutPath)
    .filter((row): row is WorktreeRow & { startCommit: string } => row.startCommit !== null);
  const [only] = earlier;
  if (only && earlier.length === 1) {
    store.upsertWorktree({ ...only, lastSeenAt: seenAt });
    const recorded: KnownStart = {
      commit: only.startCommit,
      observedAt: only.startObservedAt ?? only.firstSeenAt,
      source: "override",
    };
    return {
      worktreeId: only.worktreeId,
      start: withOverride(store, only.worktreeId, recorded),
      via: "earlierIdentity",
    };
  }

  const id = worktreeId(commonDir, checkoutPath, null);
  store.upsertWorktree({
    worktreeId: id,
    commonDir,
    checkoutPath,
    startCommit: null,
    startObservedAt: null,
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
  });
  return { worktreeId: id, start: withOverride(store, id, { unknown: true }), via: "fresh" };
}

/**
 * The user's override for `id` if there is one, else `fallback`. An override keeps the
 * fallback's place on the timeline when it has one; otherwise it is placed when it was set.
 */
function withOverride(store: ReviewStore, id: string, fallback: Start): Start {
  const override = store.getStartOverride(id);
  if (!override) return fallback;
  return {
    commit: override.commit,
    observedAt: fallback.unknown ? override.setAt : fallback.observedAt,
    source: "override",
  };
}
