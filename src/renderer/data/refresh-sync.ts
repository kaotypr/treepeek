/**
 * Live refresh in the renderer: the core service sends facts (`refresh.checkout` with what
 * changed and the checkout now, `refresh.timeline`, `refresh.paused`), and this decides
 * what they make stale. The scan in the cache is updated in place; each change kind names
 * the queries fetched again (`KIND_TO_KEYS`); everything else stays cached, so nothing on
 * screen flickers. The open diff is keyed by its comparison's sides and its `resultHash`,
 * so it is fetched again only when its own file changed.
 */

import { type QueryClient, type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { createStore, useStore } from "zustand";
import type { ChangeKind, RefreshPause } from "../../shared/domain/change";
import type { FolderNode } from "../../shared/domain/scan";
import type { CoreEvents } from "../../shared/ipc/contract";
import type { EventPayload } from "../../shared/ipc/define";
import { uiStore } from "../state/ui-store";
import { keys } from "./keys";
import type { ScanData } from "./scan-model";

export type RefreshCheckout = EventPayload<CoreEvents["refresh.checkout"]>;
export type RefreshTimeline = EventPayload<CoreEvents["refresh.timeline"]>;

/**
 * What each kind of change makes stale, for the checkout it happened in:
 *
 * - its working state (`workingTree`, `index`) or HEAD moved: its comparison lists and its
 *   review status (which the core service sends again itself, as `review.changed`);
 * - its start moved (`reflog`): the same, since the review scope starts there;
 * - refs or its upstream moved: its comparison lists (`base`, `upstream`), not its review;
 * - `removed`: nothing; the last lists stay on screen while it is selected;
 * - `structure` (it appeared): nothing is cached for it yet.
 */
export const KIND_TO_KEYS: Readonly<Record<ChangeKind, (checkoutPath: string) => QueryKey[]>> =
  Object.freeze({
    workingTree: (path) => [keys.checkoutComparisons(path), keys.reviewStatus(path)],
    index: (path) => [keys.checkoutComparisons(path), keys.reviewStatus(path)],
    head: (path) => [keys.checkoutComparisons(path), keys.reviewStatus(path)],
    reflog: (path) => [keys.checkoutComparisons(path), keys.reviewStatus(path)],
    refs: (path) => [keys.checkoutComparisons(path)],
    upstream: (path) => [keys.checkoutComparisons(path)],
    removed: () => [],
    structure: () => [],
  });

/**
 * The query keys a `refresh.checkout` makes stale. When a checkout's HEAD moved, the
 * comparisons of the checkouts that come after it in the same repository (whose
 * `sincePrevious` and `worktree` sides are that HEAD) are stale too.
 */
export function staleKeys(payload: RefreshCheckout, scan: ScanData | undefined): QueryKey[] {
  const found = new Map<string, QueryKey>();
  const add = (key: QueryKey) => found.set(JSON.stringify(key), key);
  for (const kind of payload.changed) {
    for (const key of KIND_TO_KEYS[kind](payload.checkoutPath)) add(key);
  }
  if (payload.changed.includes("head") && scan) {
    for (const entry of scan.timeline) {
      if (entry.predecessor === payload.checkoutPath) {
        add(keys.checkoutComparisons(entry.checkoutPath));
      }
    }
  }
  return [...found.values()];
}

/**
 * The scan after a `refresh.checkout`: the checkout as it is now, a new one added in
 * arrival order. A removed checkout leaves at once, unless it is selected: then it stays,
 * marked gone, until the person moves on (`pruneRemoved`).
 */
export function applyRefreshCheckout(
  scan: ScanData,
  payload: RefreshCheckout,
  selected: string | null,
): ScanData {
  const { checkoutPath, checkout } = payload;
  if (payload.changed.includes("removed")) {
    if (!(checkoutPath in scan.checkouts)) return scan;
    if (checkoutPath !== selected) return dropCheckout(scan, checkoutPath);
    if (checkoutPath in scan.removed) return scan;
    return { ...scan, removed: { ...scan.removed, [checkoutPath]: [] } };
  }
  const { [checkoutPath]: _back, ...removed } = scan.removed;
  const arrival = scan.arrival.includes(checkoutPath)
    ? scan.arrival
    : [...scan.arrival, checkoutPath];
  return { ...scan, checkouts: { ...scan.checkouts, [checkoutPath]: checkout }, arrival, removed };
}

/**
 * The scan after a `refresh.timeline`: the core service's timeline, repositories, the
 * window's root's folders and problems, except that a removed checkout still selected keeps its timeline entry and
 * its folder in the tree, so it stays in the picker until the person moves on.
 */
export function applyRefreshTimeline(scan: ScanData, payload: RefreshTimeline): ScanData {
  let timeline = payload.timeline;
  // The window's session has one root (`scan-stream.ts`).
  const folders = [...(payload.roots[0]?.folders ?? [])];
  const present = new Set(folders.map((folder) => folder.relativePath));
  const removed: Record<string, string[]> = {};
  for (const path of Object.keys(scan.removed)) {
    const entry = scan.timeline.find((item) => item.checkoutPath === path);
    if (entry && !timeline.some((item) => item.checkoutPath === path)) {
      timeline = [...timeline, entry];
    }
    const kept: string[] = [...(scan.removed[path] ?? [])];
    for (const folder of chainOf(scan.folders, path)) {
      if (present.has(folder.relativePath)) continue;
      present.add(folder.relativePath);
      folders.push(folder);
      if (!kept.includes(folder.relativePath)) kept.push(folder.relativePath);
    }
    removed[path] = kept;
  }
  folders.sort((a, b) => compareText(a.relativePath, b.relativePath));
  return {
    ...scan,
    timeline,
    repositories: payload.repositories,
    folders,
    problems: payload.problems,
    removed,
  };
}

/** Forgets removed checkouts the person has moved away from. */
export function pruneRemoved(scan: ScanData, selected: string | null): ScanData {
  let next = scan;
  for (const path of Object.keys(scan.removed)) {
    if (path !== selected) next = dropCheckout(next, path);
  }
  return next;
}

/** The checkout gone from the scan: its data, its timeline entry, the folders kept for it. */
function dropCheckout(scan: ScanData, path: string): ScanData {
  const keptFolders = new Set(scan.removed[path] ?? []);
  const { [path]: _checkout, ...checkouts } = scan.checkouts;
  const { [path]: _removed, ...removed } = scan.removed;
  return {
    ...scan,
    checkouts,
    arrival: scan.arrival.filter((item) => item !== path),
    timeline: scan.timeline.filter((entry) => entry.checkoutPath !== path),
    repositories: scan.repositories.map((repository) =>
      repository.checkouts.includes(path)
        ? { ...repository, checkouts: repository.checkouts.filter((item) => item !== path) }
        : repository,
    ),
    folders: scan.folders.filter(
      (folder) => !keptFolders.has(folder.relativePath) && folder.checkoutPath !== path,
    ),
    removed,
  };
}

/** The checkout's own folder node and every folder above it, as the old tree had them. */
function chainOf(folders: readonly FolderNode[], checkoutPath: string): FolderNode[] {
  const byRelative = new Map(folders.map((folder) => [folder.relativePath, folder]));
  const chain: FolderNode[] = [];
  let current = folders.find((folder) => folder.checkoutPath === checkoutPath);
  while (current) {
    chain.push(current);
    current = current.parent === null ? undefined : byRelative.get(current.parent);
  }
  return chain;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Where live refresh is paused for this window (`refresh.paused`), for the banner. */
export interface RefreshState {
  paused: RefreshPause[];
  setPaused(paused: RefreshPause[]): void;
}

export const refreshStore = createStore<RefreshState>()((set) => ({
  paused: [],
  setPaused: (paused) => set({ paused }),
}));

export function useRefreshPauses(): RefreshPause[] {
  return useStore(refreshStore, (state) => state.paused);
}

/**
 * Whether a stale key's new value arrives on its own. The core service computes the review
 * status of every checkout it refreshes and sends it as `review.changed`, so asking for it
 * again would only do the same work twice; it is marked stale, so the next selection asks.
 */
export function pushedByCore(queryKey: QueryKey): boolean {
  return queryKey[0] === keys.reviewStatuses()[0];
}

/** Applies one `refresh.checkout` to the cache: the scan, then the queries it made stale. */
export function syncRefreshCheckout(
  queryClient: QueryClient,
  scanRoot: string,
  payload: RefreshCheckout,
): void {
  const key = keys.scan(scanRoot);
  const before = queryClient.getQueryData<ScanData>(key);
  const selected = uiStore.getState().selectedCheckout;
  queryClient.setQueryData<ScanData>(key, (scan) =>
    scan ? applyRefreshCheckout(scan, payload, selected) : scan,
  );
  for (const queryKey of staleKeys(payload, before)) {
    void queryClient.invalidateQueries({
      queryKey,
      refetchType: pushedByCore(queryKey) ? "none" : "active",
    });
  }
}

/** Keeps the window's scan current while live refresh reports changes. */
export function useLiveRefresh(scanRoot: string): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const key = keys.scan(scanRoot);
    const offCheckout = window.treepeek.on("refresh.checkout", (payload) =>
      syncRefreshCheckout(queryClient, scanRoot, payload),
    );
    const offTimeline = window.treepeek.on("refresh.timeline", (payload) =>
      queryClient.setQueryData<ScanData>(key, (scan) =>
        scan ? applyRefreshTimeline(scan, payload) : scan,
      ),
    );
    const offPaused = window.treepeek.on("refresh.paused", ({ paused }) =>
      refreshStore.getState().setPaused(paused),
    );
    const offSelection = uiStore.subscribe((state, previous) => {
      if (state.selectedCheckout === previous.selectedCheckout) return;
      queryClient.setQueryData<ScanData>(key, (scan) =>
        scan && Object.keys(scan.removed).length > 0
          ? pruneRemoved(scan, state.selectedCheckout)
          : scan,
      );
    });
    return () => {
      offCheckout();
      offTimeline();
      offPaused();
      offSelection();
    };
  }, [queryClient, scanRoot]);
}
