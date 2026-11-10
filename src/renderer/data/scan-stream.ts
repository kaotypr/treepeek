/**
 * Runs the window's scan and writes it into the query cache as it streams: `session.open`,
 * then `scan.start` (the folder tree), then one `scan.checkout` per checkout as it resolves,
 * then `scan.done` (timeline, repositories, problems). The picker fills in while the scan
 * is still running.
 *
 * Checkouts are written once per animation frame, not once per event, so a large scan does
 * not re-render the panels for every checkout.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { Checkout } from "../../shared/domain/scan";
import type { IpcError } from "../../shared/ipc/result";
import { core, newRequestId } from "./client";
import { keys } from "./keys";
import { emptyScan, type ScanData, scanRootProblem } from "./scan-model";

export interface ScanStream {
  /** Opens the session again and rescans; what is on screen stays until it is replaced. */
  rescan(): Promise<void>;
  /** Stops listening and cancels a scan in progress. */
  stop(): void;
}

export interface ScanStreamOptions {
  /** Called once each scan is done, failed or stopped. */
  onSettled?: (scan: ScanData) => void;
}

export function startScan(
  queryClient: QueryClient,
  scanRoot: string,
  options: ScanStreamOptions = {},
): ScanStream {
  const key = keys.scan(scanRoot);
  let generation = 0;
  let stopped = false;
  let requestId: string | null = null;
  /** Checkouts are taken from the moment a scan is asked for. */
  let active = false;
  /**
   * `scan.done` only once that scan answered: a `scan.done` queued before the answer is
   * from the scan it replaced.
   */
  let replied = false;
  let seen = new Set<string>();
  let pending: Checkout[] = [];
  let flushHandle: { frame: number; timer: ReturnType<typeof setTimeout> } | null = null;

  const read = () => queryClient.getQueryData<ScanData>(key) ?? emptyScan(scanRoot);
  const write = (update: (scan: ScanData) => ScanData) =>
    queryClient.setQueryData<ScanData>(key, (previous) => update(previous ?? emptyScan(scanRoot)));
  if (queryClient.getQueryData(key) === undefined)
    queryClient.setQueryData(key, emptyScan(scanRoot));

  const flush = () => {
    if (flushHandle) {
      cancelAnimationFrame(flushHandle.frame);
      clearTimeout(flushHandle.timer);
      flushHandle = null;
    }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    write((scan) => {
      const checkouts = { ...scan.checkouts };
      const arrival = [...scan.arrival];
      for (const checkout of batch) {
        if (!(checkout.path in checkouts) && !arrival.includes(checkout.path)) {
          arrival.push(checkout.path);
        }
        checkouts[checkout.path] = checkout;
      }
      return { ...scan, checkouts, arrival };
    });
  };

  // A hidden window gets no animation frames; the timer makes sure the batch still lands.
  const scheduleFlush = () => {
    if (flushHandle) return;
    flushHandle = { frame: requestAnimationFrame(flush), timer: setTimeout(flush, 100) };
  };

  const offCheckout = window.treepeek.on("scan.checkout", (checkout) => {
    if (!active) return;
    seen.add(checkout.path);
    pending.push(checkout);
    scheduleFlush();
  });

  const offDone = window.treepeek.on("scan.done", (payload) => {
    if (!active || !replied) return;
    active = false;
    flush();
    write((scan) => {
      // Checkouts this scan did not report are gone (a rescan keeps them until here).
      const checkouts: Record<string, Checkout> = {};
      for (const [path, checkout] of Object.entries(scan.checkouts)) {
        if (seen.has(path)) checkouts[path] = checkout;
      }
      return {
        ...scan,
        phase: "done",
        checkouts,
        arrival: scan.arrival.filter((path) => seen.has(path)),
        timeline: payload.timeline,
        repositories: payload.repositories,
        problems: payload.problems,
        durationMs: payload.durationMs,
        removed: {},
        error: null,
      };
    });
    options.onSettled?.(read());
  });

  const fail = (error: IpcError) => {
    active = false;
    const scanRoot = error.code === "invalidRequest" ? scanRootProblem(error.detail) : undefined;
    write((scan) => ({
      ...scan,
      phase: "failed",
      error: { code: error.code, message: error.message, ...(scanRoot ? { scanRoot } : {}) },
    }));
    options.onSettled?.(read());
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    generation += 1;
    const mine = generation;
    active = false;
    replied = false;
    seen = new Set();
    pending = [];
    write((scan) => ({ ...scan, phase: "opening", error: null }));

    const opened = await core().session.open({ scanRoot });
    if (mine !== generation || stopped) return;
    if (!opened.ok) {
      fail(opened.error);
      return;
    }

    write((scan) => ({ ...scan, phase: "walking" }));
    const id = newRequestId("scan");
    requestId = id;
    active = true;
    const result = await core().scan.start({ requestId: id });
    if (mine !== generation || stopped) return;
    if (!result.ok) {
      fail(result.error);
      return;
    }
    replied = true;
    write((scan) => ({
      ...scan,
      phase: "resolving",
      folders: result.value.folders,
      depthLimit: result.value.depthLimit,
    }));
  };

  void run();

  return {
    rescan: run,
    stop: () => {
      stopped = true;
      active = false;
      offCheckout();
      offDone();
      if (flushHandle) {
        cancelAnimationFrame(flushHandle.frame);
        clearTimeout(flushHandle.timer);
      }
      if (requestId !== null) void core().request.cancel({ requestId });
    },
  };
}
