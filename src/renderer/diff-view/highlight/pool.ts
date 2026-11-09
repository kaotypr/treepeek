/**
 * One highlight worker pool for the whole window. Both themes are always loaded, so
 * switching appearance swaps CSS variables and never highlights again.
 */

import { getOrCreateWorkerPoolSingleton, type WorkerPoolManager } from "@pierre/diffs/worker";

export const DIFF_THEMES = Object.freeze({ light: "pierre-light", dark: "pierre-dark" });

let requests = 0;

/** Highlight requests sent to the workers so far (the lab's theme-flip check reads it). */
export function highlightRequestCount(): number {
  return requests;
}

export function highlightPool(): WorkerPoolManager {
  return getOrCreateWorkerPoolSingleton({
    poolOptions: { workerFactory: createWorker, poolSize: 2 },
    highlighterOptions: { theme: { ...DIFF_THEMES }, preferredHighlighter: "shiki-js" },
  });
}

function createWorker(): Worker {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "treepeek-highlight",
  });
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (
    message: unknown,
    transfer?: Transferable[] | StructuredSerializeOptions,
  ) => {
    if (isRenderRequest(message)) requests += 1;
    if (Array.isArray(transfer)) post(message, transfer);
    else post(message, transfer);
  };
  return worker;
}

function isRenderRequest(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const type = (message as { type?: unknown }).type;
  return type === "file" || type === "diff";
}
