import { GIT_TIMEOUT_MS } from "../../shared/constants";
import type {
  Comparison,
  ComparisonKind,
  ContentSide,
  ListableComparisonKind,
} from "../../shared/domain/compare";
import { isKnownStart } from "../../shared/domain/scan";
import type { IpcError } from "../../shared/ipc/result";
import type { RepositoryResources } from "../cache/shared-state";
import { GitError } from "../git/errors";
import { resolveUserRef } from "../git/refs";
import { isAncestor, mergeBase } from "../scan/queries";
import type { ScannedCheckout } from "../scan/resolve-checkout";

/**
 * Why a checkout cannot have a comparison kind (domain model, "Comparison kinds",
 * "Available when"). It travels as `detail.unavailable` on the error.
 *
 * - `noHead`: the checkout has no commits yet.
 * - `noStart`: the start is unknown and no override was given.
 * - `noTimeline`: no finished scan has placed the checkout on the timeline yet.
 * - `notAfter`: there is no direct previous checkout (relation is not `after`).
 * - `noUpstream`: the branch has no upstream.
 * - `noMergeBase`: HEAD and the ref share no history.
 * - `noRef`: `base` was asked for without a ref.
 */
export type UnavailableReason =
  | "noHead"
  | "noStart"
  | "noTimeline"
  | "notAfter"
  | "noUpstream"
  | "noMergeBase"
  | "noRef";

export interface SidesRequest {
  kind: ListableComparisonKind;
  /** The base for `base`. */
  ref?: string;
  /** A start for this call alone, in place of the checkout's. */
  startOverride?: string;
}

export interface SidesContext {
  readonly checkout: ScannedCheckout;
  /**
   * The previous checkout of the same repository on the last finished scan's timeline:
   * `null` when it has none, `undefined` when no finished scan has placed it yet.
   */
  readonly predecessor: ScannedCheckout | null | undefined;
  readonly repo: RepositoryResources;
  readonly signal: AbortSignal;
}

/** A comparison's resolved sides, and what its list reports besides the files. */
export interface ResolvedSides {
  comparison: Comparison;
  /** The commit range `commits` counts, when the kind reports it. */
  counted?: { left: string; right: string };
  /** The commit `contained` asks HEAD to be an ancestor of, when the kind reports it. */
  containedIn?: string;
  /** Set when the list is partial, or the checkout has no commits. */
  note?: string;
}

export const EMPTY: ContentSide = Object.freeze({ kind: "empty" });
export const INDEX: ContentSide = Object.freeze({ kind: "index" });
export const WORKING_TREE: ContentSide = Object.freeze({ kind: "workingTree" });

const commit = (oid: string): ContentSide => ({ kind: "commit", oid });

const NOTES = Object.freeze({
  noStart:
    "No start is known, so this lists only uncommitted changes. Set a start to review everything this worktree changed.",
  noHead: "This checkout has no commits yet, so every file is new.",
  contained: "HEAD is contained in the selected ref",
});

/** Kinds whose list says when HEAD is already contained in the compared ref. */
const CONTAINED_NOTE: ReadonlySet<ComparisonKind> = new Set<ComparisonKind>([
  "incoming",
  "sincePrevious",
  "base",
  "upstream",
]);

/** The note for a list where HEAD turned out to be contained in the compared ref. */
export function containedNote(kind: ComparisonKind): string | undefined {
  return CONTAINED_NOTE.has(kind) ? NOTES.contained : undefined;
}

/**
 * Resolves the two sides of `request.kind` for a checkout, as the domain model defines
 * them, or the error that says why the checkout cannot have that kind. A ref the person
 * typed (`ref`, `startOverride`) goes through `resolveUserRef`; one that names no commit
 * throws a `refNotFound` `GitError`, a malformed one `invalidRequest`.
 *
 * | Kind | Left → right |
 * | --- | --- |
 * | `review` | start (or override) → working tree; HEAD → working tree without a start |
 * | `worktree` | start → HEAD |
 * | `working` | HEAD → working tree (staged, unstaged, untracked) |
 * | `incoming` | previous checkout's HEAD → start, when that HEAD is an ancestor of the start |
 * | `sincePrevious` | previous checkout's HEAD → HEAD, on the same condition |
 * | `base` | merge-base(ref, HEAD) → HEAD |
 * | `upstream` | merge-base(upstream, HEAD) → HEAD |
 */
export async function resolveSides(
  request: SidesRequest,
  ctx: SidesContext,
): Promise<ResolvedSides | IpcError> {
  const { kind } = request;
  const { head } = ctx.checkout.checkout;
  const query = { signal: ctx.signal, timeoutMs: GIT_TIMEOUT_MS };

  if (kind === "working") {
    return { comparison: { kind, left: head ? commit(head) : EMPTY, right: WORKING_TREE } };
  }

  if (kind === "review") {
    const start = await effectiveStart(request, ctx);
    if (start && head) {
      return {
        comparison: { kind, left: commit(start), right: WORKING_TREE },
        counted: { left: start, right: head },
        containedIn: start,
      };
    }
    if (head) {
      return {
        comparison: { kind, left: commit(head), right: WORKING_TREE },
        counted: { left: head, right: head },
        note: NOTES.noStart,
      };
    }
    return { comparison: { kind, left: EMPTY, right: WORKING_TREE }, note: NOTES.noHead };
  }

  if (!head) return unavailable("noHead", "This checkout has no commits yet.");

  if (kind === "worktree" || kind === "incoming" || kind === "sincePrevious") {
    const start = await effectiveStart(request, ctx);
    if (!start) {
      return unavailable(
        "noStart",
        "This checkout's start is unknown, so this comparison is unavailable. Set a start to use it.",
      );
    }
    if (kind === "worktree") {
      return {
        comparison: { kind, left: commit(start), right: commit(head) },
        counted: { left: start, right: head },
        containedIn: start,
      };
    }
    const previous = await directPredecessorHead(start, ctx);
    if (typeof previous !== "string") return previous;
    const right = kind === "incoming" ? start : head;
    return {
      comparison: { kind, left: commit(previous), right: commit(right) },
      counted: { left: previous, right },
      containedIn: previous,
    };
  }

  // `base` and `upstream`: from where HEAD and the ref diverged.
  let ref: string;
  let label: string;
  if (kind === "base") {
    if (request.ref === undefined) {
      return {
        ...unavailable("noRef", "Choose a branch or commit to compare with."),
        code: "invalidRequest",
      };
    }
    ref = await resolveUserRef(ctx.checkout.checkout.path, request.ref, ctx.signal);
    label = request.ref;
  } else {
    const upstream = ctx.checkout.checkout.upstream;
    if (!upstream) return unavailable("noUpstream", "This branch has no upstream.");
    try {
      ref = await resolveUserRef(ctx.checkout.checkout.path, "@{upstream}", ctx.signal);
    } catch (error) {
      if (error instanceof GitError && error.code === "refNotFound") {
        return unavailable("noUpstream", "This branch has no upstream.");
      }
      throw error;
    }
    label = upstream.ref;
  }
  const base = await mergeBase(ctx.repo, ref, head, query);
  if (!base) return unavailable("noMergeBase", `HEAD and ${label} have no common ancestor.`);
  return {
    comparison: { kind, left: commit(base), right: commit(head) },
    counted: { left: base, right: head },
    containedIn: ref,
  };
}

/** The start for this call: the request's override, else the checkout's start, else `null`. */
async function effectiveStart(request: SidesRequest, ctx: SidesContext): Promise<string | null> {
  if (request.startOverride !== undefined) {
    return resolveUserRef(ctx.checkout.checkout.path, request.startOverride, ctx.signal);
  }
  const { start } = ctx.checkout.checkout;
  return isKnownStart(start) ? start.commit : null;
}

/**
 * The previous checkout's HEAD when the relation is `after` for `start`: the predecessor's
 * HEAD is an ancestor of it. Checked here rather than read from the timeline, so a start
 * override (stored or for this call) is taken into account.
 */
async function directPredecessorHead(start: string, ctx: SidesContext): Promise<string | IpcError> {
  if (ctx.predecessor === undefined) {
    return unavailable(
      "noTimeline",
      "The scan has not finished yet, so the previous checkout is not known.",
    );
  }
  const previous = ctx.predecessor?.checkout.head ?? null;
  const after =
    previous !== null &&
    (await isAncestor(ctx.repo, previous, start, {
      signal: ctx.signal,
      timeoutMs: GIT_TIMEOUT_MS,
    }));
  if (!after || previous === null) {
    return unavailable("notAfter", "There is no direct previous checkout in this repository.");
  }
  return previous;
}

function unavailable(reason: UnavailableReason, message: string): IpcError {
  return { code: "refNotFound", message, detail: { unavailable: reason } };
}

/** Whether a value is an `IpcError` rather than a result. */
export function isIpcError(value: object): value is IpcError {
  return "code" in value && "message" in value;
}
