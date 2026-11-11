import { access } from "node:fs/promises";
import { join } from "node:path";
import { CHANGE_KINDS, type ChangeKind } from "../../shared/domain/change";
import type { Repository, Start, TimelineEntry, Upstream } from "../../shared/domain/scan";
import { coreEvents } from "../../shared/ipc";
import type { Logger } from "../../shared/log";
import type { CoreState } from "../cache/shared-state";
import { isIpcError } from "../compare/kinds";
import { asIpcError, GitError } from "../git/errors";
import type { WorktreeEntry } from "../git/parse/worktree-list";
import type { GitPriority } from "../git/queue";
import { reviewContext } from "../review/background";
import { computeStatus } from "../review/status";
import type { ScanContext } from "../scan/context";
import { isAncestor } from "../scan/queries";
import { buildRepositories } from "../scan/repositories";
import { readStatus, resolveCheckout, type ScannedCheckout } from "../scan/resolve-checkout";
import { scanRootsOf, walkedCandidates, walkScanRoots } from "../scan/scan";
import { buildTimeline } from "../scan/timeline";
import {
  listedPaths,
  type UnwalkedCheckout,
  unwalkedCheckouts,
  type ValidCandidate,
  validateCandidates,
  validateUnwalked,
  worktreeList,
} from "../scan/validate";
import type { Session } from "../sessions/session";
import type { ReviewStore } from "../store/review-store";
import type { WatchChange } from "./manager";

export interface RefreshRunnerOptions {
  /** Every open session. */
  sessions(): readonly Session[];
  state: CoreState;
  store(): ReviewStore | null;
  log: Logger;
  /** A refresh changed which checkouts a session's scan holds: watch its new scan. */
  rewatch(session: Session): void;
}

/** What one session has to refresh, gathered while its previous refresh ran. */
interface Batch {
  /** Re-walk the scan roots: checkouts may have appeared or gone. */
  structure: boolean;
  /** Read every checkout again (the Mac woke from sleep). */
  revalidate: boolean;
  /** Repositories whose refs moved, with those refs (`null`: any may have). */
  repositories: Map<string, Set<string> | null>;
  checkouts: Map<string, Set<ChangeKind>>;
}

interface Queue {
  batch: Batch;
  running: Promise<void> | null;
}

/** What refreshing one checkout found. */
interface CheckoutOutcome {
  scanned: ScannedCheckout;
  changed: Set<ChangeKind>;
}

/** Kinds after which a checkout's review status is computed again. */
const REVIEW_KINDS: ReadonlySet<ChangeKind> = new Set(["workingTree", "index", "head", "reflog"]);

/** Checkouts whose review status is computed at once after a refresh. */
const REVIEW_PARALLEL = 2;

/**
 * Runs the refresh tasks of live refresh (live-refresh design, "From event to UI", steps 3
 * and 4) with the scan's own functions, so a refreshed checkout is built exactly like a
 * scanned one:
 *
 * | Change | Task |
 * | --- | --- |
 * | `workingTree`, `index` | status (counts, branch); working-side caches dropped; review status |
 * | `head` | status, history counts; review scope (its right side moved); review status |
 * | `reflog` | start again (identity fallback included), which may move the timeline |
 * | `refs` | status of the checkouts on (or tracking) the moved refs; timeline relations |
 * | `structure` | the scan roots walked again and the worktree lists read; new checkouts resolved, gone ones removed |
 *
 * Git caches are invalidated once per change, for every window; then each window showing
 * the checkout refreshes its own view (two windows on one repository share the git work
 * through the caches). A window's refreshes run one batch at a time, waiting for a scan in
 * progress, and a scan starting stops the one running: the scan reads everything anyway.
 *
 * A session in the background (`setForeground`) skips changes that are only edits in a
 * working tree: it marks the checkout stale instead, and refreshes it once when it comes
 * back to the foreground.
 */
export class RefreshRunner {
  readonly #options: RefreshRunnerOptions;
  readonly #queues = new Map<Session, Queue>();
  /**
   * The sessions in the background, each with its stale checkouts: those whose working
   * tree changed while it was there, and whose status no refresh has read since.
   */
  readonly #background = new WeakMap<Session, Set<string>>();

  constructor(options: RefreshRunnerOptions) {
    this.#options = options;
  }

  /**
   * Puts a session in the background (`false`) or brings it back (`true`); a session starts
   * in the foreground, and sending the state it is in does nothing. Back in the
   * foreground, each stale checkout still in its scan is refreshed once, for it alone.
   */
  setForeground(session: Session, foreground: boolean): void {
    const stale = this.#background.get(session);
    if (!foreground) {
      if (!stale) this.#background.set(session, new Set());
      return;
    }
    if (!stale) return;
    this.#background.delete(session);
    if (session.closed) return;
    const paths = [...stale].filter((path) => session.checkoutAt(path) !== undefined);
    if (paths.length === 0) return;
    this.#enqueue(session, (batch) => {
      for (const path of paths) addKinds(batch, path, ["workingTree"]);
    });
  }

  /** Routes a debounced change to every session it concerns. */
  handle(change: WatchChange): void {
    switch (change.scope) {
      case "checkout":
        this.#checkoutChanged(change.checkoutPath, change.kinds);
        return;
      case "repository":
        this.#repositoryChanged(change.commonDir, change.kinds, change.refs);
        return;
      case "root":
        for (const session of this.#scanned()) {
          if (session.scanRoots?.includes(change.scanRoot)) {
            this.#enqueue(session, (batch) => {
              batch.structure = true;
            });
          }
        }
        return;
    }
  }

  /** Refreshes a checkout in every window showing it; resolves once all are done. */
  run(checkoutPath: string, kinds: readonly ChangeKind[]): Promise<void> {
    this.#checkoutChanged(checkoutPath, kinds);
    return this.idle();
  }

  /** Refreshes a repository's checkouts after its refs or worktrees changed. */
  runRepository(
    commonDir: string,
    kinds: readonly ChangeKind[],
    refs: readonly string[] | null = null,
  ): Promise<void> {
    this.#repositoryChanged(commonDir, kinds, refs);
    return this.idle();
  }

  /**
   * Reads every window's checkouts again: status per checkout, the worktree list per
   * repository, and the scan roots' folders (after sleep, FSEvents may have dropped events).
   */
  revalidate(): Promise<void> {
    for (const session of this.#scanned()) {
      for (const scanned of session.lastScan?.checkouts ?? []) {
        const repo = this.#options.state.repository(scanned.commonDir);
        if (!repo) continue;
        repo.cache.worktreeList.clear();
        repo.cache.invalidate(scanned.checkout.path, ["workingTree", "index", "head"]);
      }
      this.#enqueue(session, (batch) => {
        batch.revalidate = true;
      });
    }
    return this.idle();
  }

  /** Resolves once no window has a refresh waiting or running. */
  async idle(): Promise<void> {
    for (;;) {
      const running = [...this.#queues.values()].flatMap((queue) =>
        queue.running ? [queue.running] : [],
      );
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  #scanned(): Session[] {
    return this.#options
      .sessions()
      .filter((session) => !session.closed && session.lastScan !== null);
  }

  #checkoutChanged(checkoutPath: string, kinds: readonly ChangeKind[]): void {
    const sessions = this.#scanned().filter((session) => session.checkoutAt(checkoutPath));
    const scanned = sessions[0]?.checkoutAt(checkoutPath);
    if (!scanned) return;
    const repo = this.#options.state.repository(scanned.commonDir);
    if (repo) {
      // Runs no git, so it happens for sessions in the background too.
      repo.cache.invalidate(checkoutPath, kinds);
      // Whatever moved, the status says whether HEAD did: a commit on a branch only
      // touches the branch's ref, the index and the reflog, never `HEAD` itself.
      repo.cache.statuses.delete(checkoutPath);
    }
    const editsOnly = kinds.length > 0 && kinds.every((kind) => kind === "workingTree");
    for (const session of sessions) {
      const stale = this.#background.get(session);
      if (stale && editsOnly) {
        stale.add(checkoutPath);
        continue;
      }
      this.#enqueue(session, (batch) => addKinds(batch, checkoutPath, kinds));
    }
  }

  #repositoryChanged(
    commonDir: string,
    kinds: readonly ChangeKind[],
    refs: readonly string[] | null,
  ): void {
    const repo = this.#options.state.repository(commonDir);
    const structure = kinds.includes("structure");
    const moved = kinds.includes("refs");
    if (structure) repo?.cache.worktreeList.clear();
    for (const session of this.#scanned()) {
      const checkouts = (session.lastScan?.checkouts ?? []).filter(
        (item) => item.commonDir === commonDir,
      );
      if (checkouts.length === 0) continue;
      if (moved && repo) {
        for (const item of checkouts) {
          if (refsConcern(item, refs)) repo.cache.statuses.delete(item.checkout.path);
        }
      }
      this.#enqueue(session, (batch) => {
        if (structure) batch.structure = true;
        if (!moved) return;
        const gathered = batch.repositories.get(commonDir);
        if (refs === null || gathered === null) batch.repositories.set(commonDir, null);
        else batch.repositories.set(commonDir, new Set([...(gathered ?? []), ...refs]));
      });
    }
  }

  #enqueue(session: Session, update: (batch: Batch) => void): void {
    let queue = this.#queues.get(session);
    if (!queue) {
      queue = { batch: emptyBatch(), running: null };
      this.#queues.set(session, queue);
    }
    update(queue.batch);
    if (!queue.running) queue.running = this.#drain(session, queue);
  }

  async #drain(session: Session, queue: Queue): Promise<void> {
    try {
      while (!isEmpty(queue.batch)) {
        if (session.closed) {
          this.#queues.delete(session);
          return;
        }
        await session.idle();
        const batch = queue.batch;
        queue.batch = emptyBatch();
        const signal = session.refreshSignal();
        try {
          await this.#process(session, batch, signal);
        } catch (error) {
          if (!signal.aborted && !isCancelled(error)) {
            session.log.warn("live refresh failed", { error });
          }
        }
      }
    } finally {
      // Set in the same turn as the loop's last check, so a change arriving later starts
      // a new drain rather than waiting on this one.
      queue.running = null;
    }
  }

  async #process(session: Session, batch: Batch, signal: AbortSignal): Promise<void> {
    if (!session.lastScan || session.closed) return;
    const ctx = session.scanContext(signal);
    let structure = batch.structure || batch.revalidate;
    let timelineMoved = false;
    const review = new Map<string, GitPriority>();

    if (structure) {
      const outcome = await this.#structure(session, ctx);
      if (signal.aborted) return;
      if (outcome) {
        for (const item of outcome.removed) {
          session.rpc.emit(coreEvents["refresh.checkout"], {
            checkoutPath: item.checkout.path,
            checkout: item.checkout,
            changed: ["removed"],
          });
        }
        for (const item of outcome.added) {
          session.rpc.emit(coreEvents["refresh.checkout"], {
            checkoutPath: item.checkout.path,
            checkout: item.checkout,
            changed: ["structure"],
          });
          review.set(item.checkout.path, "low");
        }
        timelineMoved = true;
      }
      structure = outcome !== null;
    }

    // What each checkout refreshes, and whether its status must be read for it.
    const work = new Map<string, { kinds: Set<ChangeKind>; read: boolean }>();
    for (const [checkoutPath, kinds] of batch.checkouts) {
      work.set(checkoutPath, { kinds: new Set(kinds), read: true });
    }
    for (const [commonDir, refs] of batch.repositories) {
      for (const item of session.lastScan?.checkouts ?? []) {
        if (item.commonDir !== commonDir) continue;
        const entry = work.get(item.checkout.path) ?? { kinds: new Set(), read: false };
        entry.kinds.add("refs");
        if (refsConcern(item, refs)) entry.read = true;
        work.set(item.checkout.path, entry);
      }
    }
    if (batch.revalidate) {
      for (const item of session.lastScan?.checkouts ?? []) {
        const entry = work.get(item.checkout.path) ?? { kinds: new Set(), read: true };
        entry.kinds.add("workingTree");
        entry.read = true;
        work.set(item.checkout.path, entry);
      }
    }

    const outcomes = await Promise.all(
      [...work].map(async ([checkoutPath, entry]) => {
        const scanned = session.checkoutAt(checkoutPath);
        if (!scanned || entry.kinds.size === 0) return null;
        return this.#checkout(session, ctx, scanned, entry.kinds, entry.read);
      }),
    );
    if (signal.aborted) return;
    let gone = false;
    for (const outcome of outcomes) {
      if (outcome === "gone") {
        gone = true;
        continue;
      }
      if (!outcome) continue;
      const path = outcome.scanned.checkout.path;
      session.rpc.emit(coreEvents["refresh.checkout"], {
        checkoutPath: path,
        checkout: outcome.scanned.checkout,
        changed: CHANGE_KINDS.filter((kind) => outcome.changed.has(kind)),
      });
      if (outcome.changed.has("head") || outcome.changed.has("reflog")) timelineMoved = true;
      if ([...outcome.changed].some((kind) => REVIEW_KINDS.has(kind))) {
        review.set(path, batch.revalidate ? "low" : (review.get(path) ?? "normal"));
      }
    }

    if (timelineMoved) {
      const moved = await this.#retimeline(session, ctx);
      if (signal.aborted) return;
      if (moved || structure) {
        const scan = session.lastScan;
        if (scan) {
          session.rpc.emit(coreEvents["refresh.timeline"], {
            timeline: scan.timeline,
            repositories: scan.repositories,
            roots: scan.roots,
            problems: scan.problems,
          });
        }
      }
    }
    if (structure) this.#options.rewatch(session);
    if (gone) {
      // A checkout that could not be read because it is gone: walk again to remove it.
      this.#enqueue(session, (next) => {
        next.structure = true;
      });
    }
    await this.#review(session, review, signal);
  }

  /** Refreshes one checkout; `"gone"` when it no longer exists. */
  async #checkout(
    session: Session,
    ctx: ScanContext,
    scanned: ScannedCheckout,
    kinds: ReadonlySet<ChangeKind>,
    read: boolean,
  ): Promise<CheckoutOutcome | "gone" | null> {
    const changed = new Set(kinds);
    if (!read) return { scanned, changed };
    const path = scanned.checkout.path;
    // Read now, so no longer stale; an edit landing while it runs marks it again, and a
    // refresh that fails or stops leaves it stale.
    const wasStale = this.#background.get(session)?.delete(path) ?? false;
    const stillStale = () => {
      if (wasStale) this.#background.get(session)?.add(path);
    };
    try {
      const repo = ctx.repository(scanned.commonDir);
      const status = await readStatus(repo, path, ctx.signal);
      if (status.head !== scanned.checkout.head) {
        // HEAD moved: the start (an ancestor of HEAD) and the lists against it are stale.
        changed.add("head");
        repo.cache.starts.delete(path);
        repo.cache.comparisons(path).clear();
      }
      const updated = await resolveCheckout(
        {
          path,
          gitDir: scanned.gitDir,
          commonDir: scanned.commonDir,
          kind: scanned.checkout.kind,
          location: scanned.checkout.location,
          locked: scanned.checkout.locked,
          repo,
        },
        ctx,
        { fresh: false },
      );
      if (ctx.signal.aborted) {
        stillStale();
        return null;
      }
      if (!sameUpstream(scanned.checkout.upstream, updated.checkout.upstream)) {
        changed.add("upstream");
      }
      if (
        !sameStart(scanned.checkout.start, updated.checkout.start) ||
        scanned.worktreeId !== updated.worktreeId
      ) {
        changed.add("reflog");
      }
      session.replaceCheckout(updated);
      return { scanned: updated, changed };
    } catch (error) {
      stillStale();
      if (ctx.signal.aborted || isCancelled(error)) throw error;
      if (!(await exists(join(path, ".git")))) return "gone";
      session.log.warn("could not refresh a checkout", { path, error });
      return null;
    }
  }

  /**
   * Walks the scan roots again (git-service design, "The scan", step 1), validates only the
   * folders that are not checkouts already, and reads the worktree lists of the
   * repositories the walks found for their other checkouts, as the scan does. A walked
   * checkout stays while the walk still finds it and Git still lists it; any other while
   * Git still lists it (not as prunable), its folder is there and the session's worktree
   * choice keeps it. Returns `null` when nothing changed.
   */
  async #structure(
    session: Session,
    ctx: ScanContext,
  ): Promise<{ added: ScannedCheckout[]; removed: ScannedCheckout[] } | null> {
    const previous = session.lastScan;
    if (!previous) return null;
    const walked = await walkScanRoots(ctx);
    const roots = scanRootsOf(walked);
    const candidates = new Set(walkedCandidates(walked));
    const known = new Map(previous.checkouts.map((item) => [item.checkout.path, item]));
    const fresh = [...candidates].filter((path) => !known.has(path));
    const validation = await validateCandidates(fresh, ctx);
    const lists = new Map(validation.worktreeLists);
    const listed = new Map<string, ReadonlySet<string>>(validation.listed);
    for (const commonDir of new Set(previous.checkouts.map((item) => item.commonDir))) {
      if (listed.has(commonDir)) continue;
      try {
        const entries = await worktreeList(ctx.repository(commonDir), ctx.signal);
        lists.set(commonDir, entries);
        listed.set(commonDir, await listedPaths(entries));
      } catch (error) {
        if (ctx.signal.aborted || isCancelled(error)) throw error;
        // The repository itself is gone: so are its checkouts.
        listed.set(commonDir, new Set());
      }
    }
    const isListed = (item: ScannedCheckout) =>
      listed.get(item.commonDir)?.has(item.checkout.path) ?? false;
    const walkedKept = previous.checkouts.filter(
      (item) => candidates.has(item.checkout.path) && isListed(item),
    );

    // The other checkouts of the repositories the walks found, as the scan derives them.
    const unwalked = new Map<string, { commonDir: string; item: UnwalkedCheckout }>();
    const found = new Set([...walkedKept, ...validation.valid].map((item) => item.commonDir));
    for (const commonDir of found) {
      const entries = lists.get(commonDir);
      if (!entries) continue;
      for (const item of await unwalkedCheckouts(entries, candidates, ctx)) {
        unwalked.set(item.path, { commonDir, item });
      }
    }
    const kept = previous.checkouts.filter((item) =>
      candidates.has(item.checkout.path)
        ? isListed(item)
        : unwalked.get(item.checkout.path)?.commonDir === item.commonDir,
    );
    const removed = previous.checkouts.filter((item) => !kept.includes(item));
    const problems = [...validation.problems];
    const derived = await Promise.all(
      [...unwalked.values()]
        .filter(({ item }) => !known.has(item.path))
        .map(({ commonDir, item }) => validateUnwalked(item, commonDir, ctx, problems)),
    );
    const valid = [
      ...validation.valid,
      ...derived.filter((item): item is ValidCandidate => item !== null),
    ];
    const resolved = await Promise.all(
      valid.map(async (candidate) => {
        try {
          return await resolveCheckout(candidate, ctx);
        } catch (error) {
          if (ctx.signal.aborted || isCancelled(error)) throw error;
          const ipc = asIpcError(error);
          problems.push({ path: candidate.path, code: ipc.code, message: ipc.message });
          return null;
        }
      }),
    );
    const added = resolved.filter((item): item is ScannedCheckout => item !== null);
    problems.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (
      added.length === 0 &&
      removed.length === 0 &&
      sameJson(previous.roots, roots) &&
      sameJson(previous.problems, problems)
    ) {
      return null;
    }
    const ordered = await this.#order(ctx, [...kept, ...added], lists);
    // The session opened again meanwhile (other roots or choice): this result is not its.
    if (ctx.signal.aborted) return null;
    session.adoptScan({
      ...previous,
      roots,
      checkouts: ordered.checkouts,
      timeline: ordered.timeline,
      repositories: ordered.repositories,
      problems,
      listedCheckouts: new Map([...previous.listedCheckouts, ...listed]),
    });
    for (const item of removed) {
      this.#options.state
        .repository(item.commonDir)
        ?.cache.invalidate(item.checkout.path, ["removed"]);
    }
    session.log.info("live refresh: checkouts changed", {
      added: added.map((item) => item.checkout.path),
      removed: removed.map((item) => item.checkout.path),
    });
    return { added, removed };
  }

  /** The timeline again after starts or HEADs moved; `true` when it changed. */
  async #retimeline(session: Session, ctx: ScanContext): Promise<boolean> {
    const scan = session.lastScan;
    if (!scan) return false;
    const ordered = await this.#order(ctx, scan.checkouts, new Map(), scan.repositories);
    if (ctx.signal.aborted || session.lastScan !== scan) return false;
    if (
      sameJson(scan.timeline, ordered.timeline) &&
      sameJson(scan.repositories, ordered.repositories)
    ) {
      return false;
    }
    session.adoptScan({
      ...scan,
      checkouts: ordered.checkouts,
      timeline: ordered.timeline,
      repositories: ordered.repositories,
    });
    return true;
  }

  /**
   * Steps 5 and 6 of the scan for `checkouts`: the timeline, and the repositories in its
   * order. A repository's name comes from its worktree list (read if not given), or is
   * kept from `known`.
   */
  async #order(
    ctx: ScanContext,
    checkouts: readonly ScannedCheckout[],
    lists: ReadonlyMap<string, readonly WorktreeEntry[]>,
    known: readonly Repository[] = [],
  ): Promise<{
    checkouts: ScannedCheckout[];
    timeline: TimelineEntry[];
    repositories: Repository[];
  }> {
    const timeline = await buildTimeline(
      checkouts.map((item) => ({
        checkoutPath: item.checkout.path,
        commonDir: item.commonDir,
        start: item.checkout.start,
        head: item.checkout.head,
      })),
      (commonDir, ancestor, descendant) =>
        isAncestor(ctx.repository(commonDir), ancestor, descendant, { signal: ctx.signal }).catch(
          (error: unknown) => {
            if (ctx.signal.aborted || isCancelled(error)) throw error;
            return false;
          },
        ),
    );
    const byPath = new Map(checkouts.map((item) => [item.checkout.path, item]));
    const ordered = timeline.flatMap((entry) => {
      const item = byPath.get(entry.checkoutPath);
      return item ? [item] : [];
    });
    const names = new Map(lists);
    for (const commonDir of new Set(ordered.map((item) => item.commonDir))) {
      if (names.has(commonDir) || known.some((repo) => repo.commonDir === commonDir)) continue;
      try {
        names.set(commonDir, await worktreeList(ctx.repository(commonDir), ctx.signal));
      } catch (error) {
        if (ctx.signal.aborted || isCancelled(error)) throw error;
      }
    }
    const repositories = buildRepositories(
      ordered.map((item) => ({ path: item.checkout.path, commonDir: item.commonDir })),
      names,
    ).map((repository) => {
      const kept = known.find((repo) => repo.commonDir === repository.commonDir);
      return kept && !names.has(repository.commonDir)
        ? { ...repository, displayName: kept.displayName }
        : repository;
    });
    return { checkouts: ordered, timeline, repositories };
  }

  /** Review status of refreshed checkouts, sent as `review.changed`. */
  async #review(
    session: Session,
    checkouts: ReadonlyMap<string, GitPriority>,
    signal: AbortSignal,
  ): Promise<void> {
    const store = this.#options.store();
    if (!store || checkouts.size === 0) return;
    const queue = [...checkouts];
    const worker = async () => {
      for (;;) {
        const next = queue.shift();
        if (!next || signal.aborted || session.closed) return;
        const [path, priority] = next;
        const scanned = session.checkoutAt(path);
        if (!scanned) continue;
        try {
          const status = await computeStatus(
            reviewContext(session, scanned, store, signal, priority),
          );
          if (!signal.aborted && !isIpcError(status)) {
            session.rpc.emit(coreEvents["review.changed"], status);
          }
        } catch (error) {
          if (signal.aborted || isCancelled(error)) return;
          session.log.warn("could not refresh a checkout's review status", { path, error });
        }
      }
    };
    await Promise.all(Array.from({ length: REVIEW_PARALLEL }, worker));
  }
}

function emptyBatch(): Batch {
  return { structure: false, revalidate: false, repositories: new Map(), checkouts: new Map() };
}

/** Adds `kinds` to what the batch refreshes in a checkout. */
function addKinds(batch: Batch, checkoutPath: string, kinds: Iterable<ChangeKind>): void {
  const gathered = batch.checkouts.get(checkoutPath) ?? new Set<ChangeKind>();
  for (const kind of kinds) gathered.add(kind);
  batch.checkouts.set(checkoutPath, gathered);
}

function isEmpty(batch: Batch): boolean {
  return (
    !batch.structure &&
    !batch.revalidate &&
    batch.repositories.size === 0 &&
    batch.checkouts.size === 0
  );
}

/**
 * Whether a checkout's status can have changed when `refs` moved: its branch is one of
 * them, or its upstream is. `null` (any ref, as with `packed-refs`) concerns every checkout.
 */
function refsConcern(item: ScannedCheckout, refs: Iterable<string> | null): boolean {
  if (refs === null) return true;
  const { branch, upstream } = item.checkout;
  for (const ref of refs) {
    if (branch !== null && ref === `refs/heads/${branch}`) return true;
    if (upstream === null) continue;
    if (ref === `refs/heads/${upstream.ref}` || ref === `refs/remotes/${upstream.ref}`) return true;
  }
  return false;
}

function sameUpstream(a: Upstream | null, b: Upstream | null): boolean {
  return a?.ref === b?.ref && a?.ahead === b?.ahead && a?.behind === b?.behind;
}

function sameStart(a: Start, b: Start): boolean {
  return sameJson(a, b);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isCancelled(error: unknown): boolean {
  return error instanceof GitError && error.code === "cancelled";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
