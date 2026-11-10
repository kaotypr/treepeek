/** The last task queued for each key. */
const tails = new Map<string, Promise<void>>();

/**
 * Runs `task` once every task queued before it under `key` has settled. Marks for one
 * checkout change in the order the window sent them: "Unmark all" sent while "Mark all" is
 * still keeping snapshots must not finish first and then be undone by it.
 */
export function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
