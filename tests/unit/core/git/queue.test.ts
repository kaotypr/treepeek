import { describe, expect, it } from "vitest";
import { GitError } from "../../../../src/core/git/errors";
import { GitQueue } from "../../../../src/core/git/queue";

/** A task that runs until `release()` is called. */
function gate(log: string[], name: string) {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    task: async () => {
      log.push(name);
      await done;
      return name;
    },
    release: () => release(),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("GitQueue", () => {
  it("runs at most `concurrency` tasks at once", async () => {
    const queue = new GitQueue(6);
    const started: string[] = [];
    const gates = Array.from({ length: 20 }, (_, index) => gate(started, `t${index}`));
    const results = gates.map((g) => queue.run(g.task));
    await tick();
    expect(queue.active).toBe(6);
    expect(queue.size).toBe(14);
    expect(started).toHaveLength(6);
    for (const g of gates) {
      g.release();
      await tick();
      expect(queue.active).toBeLessThanOrEqual(6);
    }
    expect(await Promise.all(results)).toHaveLength(20);
    expect(queue.active).toBe(0);
  });

  it("starts low-lane tasks only when no normal task waits", async () => {
    const queue = new GitQueue(1);
    const started: string[] = [];
    const first = gate(started, "normal-1");
    const low = gate(started, "low");
    const second = gate(started, "normal-2");
    const runs = [
      queue.run(first.task, "normal"),
      queue.run(low.task, "low"),
      queue.run(second.task, "normal"),
    ];
    await tick();
    expect(started).toEqual(["normal-1"]);
    first.release();
    await tick();
    expect(started).toEqual(["normal-1", "normal-2"]);
    second.release();
    await tick();
    expect(started).toEqual(["normal-1", "normal-2", "low"]);
    low.release();
    await Promise.all(runs);
  });

  it("drops a waiting task when its signal aborts, without running it", async () => {
    const queue = new GitQueue(1);
    const started: string[] = [];
    const blocker = gate(started, "blocker");
    const waiting = gate(started, "waiting");
    const controller = new AbortController();
    const first = queue.run(blocker.task);
    const second = queue.run(waiting.task, "normal", controller.signal);
    await tick();
    controller.abort();
    await expect(second).rejects.toMatchObject({ code: "cancelled" });
    expect(queue.size).toBe(0);
    blocker.release();
    await first;
    await tick();
    expect(started).toEqual(["blocker"]);
  });

  it("rejects at once when the signal is already aborted", async () => {
    const queue = new GitQueue(1);
    const controller = new AbortController();
    controller.abort();
    await expect(queue.run(async () => 1, "normal", controller.signal)).rejects.toBeInstanceOf(
      GitError,
    );
  });

  it("frees the slot when a task throws", async () => {
    const queue = new GitQueue(1);
    await expect(
      queue.run(() => {
        throw new Error("sync failure");
      }),
    ).rejects.toThrow("sync failure");
    expect(await queue.run(async () => "next")).toBe("next");
    expect(queue.active).toBe(0);
  });
});
