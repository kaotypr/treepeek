import type { Logger } from "../../shared/log";
import type { RefreshRunner } from "./refresh";

/**
 * After the Mac wakes from sleep (`power.resume`): FSEvents may have dropped events while
 * it slept, so every window's checkouts are read again, cheaply: the status of each
 * checkout and the worktree list of each repository, with the scan root walked again
 * (live-refresh design, "Floods, sleep and failure"). What changed reaches the windows as
 * any live refresh does.
 */
export async function revalidateAll(runner: RefreshRunner, log: Logger): Promise<void> {
  const startedAt = Date.now();
  log.info("revalidating after sleep");
  await runner.revalidate();
  log.info("revalidated after sleep", { durationMs: Date.now() - startedAt });
}
