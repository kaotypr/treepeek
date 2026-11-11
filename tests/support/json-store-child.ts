/**
 * One more core process writing a JSON review store, for the several-writer tests
 * (`tests/unit/core/store/json-store-processes.test.ts`). Started with
 * `fork(<this file>, [mode, ...args], { execArgv: [] })`: Node strips the types itself
 * (22.18 or later), and the resolve hook below lets the store's extensionless relative
 * imports find their `.ts` files, which Vitest's transform does not reach in a child.
 *
 * Modes, each starting on the parent's "go" message:
 * - `marks <dir> <worktreeId> <label> <count>`: marks `<label>/<i>.txt` one at a time,
 *   writing after each, then closes the store and reports `{ done: count }`.
 * - `loop <dir> <worktreeId> <label>`: marks `<label>/<i>.txt` for ever, writing after each
 *   and reporting `{ written: i }` once the write is on disk; the parent kills it.
 *
 * Each child reports `{ ready: true }` once its store is open.
 */
import * as nodeModule from "node:module";

nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".")) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});

const { JsonReviewStore } = await import("../../src/core/store/json-store");

const [mode, dir, worktreeArg, labelArg, count] = process.argv.slice(2);
if (!dir || !worktreeArg || !labelArg || (mode !== "marks" && mode !== "loop")) {
  throw new Error(`json-store-child: bad arguments ${process.argv.slice(2).join(" ")}`);
}
const worktreeId: string = worktreeArg;
const label: string = labelArg;

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error("json-store-child needs an IPC channel"));
      return;
    }
    process.send(message, (error: Error | null) => (error ? reject(error) : resolve()));
  });
}

const store = new JsonReviewStore(dir, { flushDelayMs: 60_000 });

function markOne(index: number): void {
  store.setMarks(worktreeId, [
    {
      path: `${label}/${index}.txt`,
      resultHash: "c".repeat(40),
      viewedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      snapshotHash: null,
    },
  ]);
  // Throws if the mark is still pending, so nothing is reported that is not on disk.
  store.flush();
}

await new Promise<void>((resolve) => {
  process.once("message", () => resolve());
  void send({ ready: true });
});

if (mode === "marks") {
  const total = Number(count);
  for (let index = 0; index < total; index += 1) markOne(index);
  store.close();
  await send({ done: total });
  process.disconnect();
} else {
  for (let index = 0; ; index += 1) {
    markOne(index);
    await send({ written: index });
  }
}
