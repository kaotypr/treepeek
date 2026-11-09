import { describe, expect, it } from "vitest";
import { Lru } from "../../../../src/core/cache/lru";
import { Memo } from "../../../../src/core/cache/memo";

/** A computation the test finishes by hand, recording the signal it was given. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const live = () => new AbortController().signal;

describe("Lru", () => {
  it("drops the least recently used entry past its limit; get and set count as use", () => {
    const lru = new Lru<string, number>(2);
    lru.set("a", 1).set("b", 2);
    expect(lru.get("a")).toBe(1);
    lru.set("c", 3);
    expect([...lru.keys()]).toEqual(["a", "c"]);
    expect(lru.peek("b")).toBeUndefined();
    // peek does not count as use.
    lru.peek("a");
    lru.set("d", 4);
    expect([...lru.keys()]).toEqual(["c", "d"]);
    expect(lru.size).toBe(2);
  });

  it("stores undefined values and refuses a nonsensical limit", () => {
    const lru = new Lru<string, number | undefined>(Infinity);
    lru.set("x", undefined);
    expect(lru.has("x")).toBe(true);
    expect(lru.get("x")).toBeUndefined();
    expect(() => new Lru(0)).toThrow(RangeError);
    expect(() => new Lru(1.5)).toThrow(RangeError);
  });
});

describe("Memo", () => {
  it("runs one computation for callers asking at the same time, and stores its result", async () => {
    const memo = new Memo<string, number>();
    let runs = 0;
    const gate = deferred<number>();
    const compute = () => {
      runs += 1;
      return gate.promise;
    };
    const a = memo.get("k", compute, live());
    const b = memo.get("k", compute, live());
    gate.resolve(42);
    expect(await Promise.all([a, b])).toEqual([42, 42]);
    expect(await memo.get("k", compute, live())).toBe(42);
    expect(runs).toBe(1);
    expect(memo.peek("k")).toBe(42);
  });

  it("does not store a failure; the next caller tries again", async () => {
    const memo = new Memo<string, number>();
    await expect(memo.get("k", () => Promise.reject(new Error("boom")), live())).rejects.toThrow(
      "boom",
    );
    expect(memo.has("k")).toBe(false);
    expect(await memo.get("k", async () => 7, live())).toBe(7);
  });

  it("treats a computation that throws synchronously as a failure", async () => {
    const memo = new Memo<string, number>();
    await expect(
      memo.get(
        "k",
        () => {
          throw new Error("sync");
        },
        live(),
      ),
    ).rejects.toThrow("sync");
    expect(memo.has("k")).toBe(false);
  });

  it("detaches a caller that aborts without stopping the computation others wait for", async () => {
    const memo = new Memo<string, number>();
    const gate = deferred<number>();
    let computeSignal: AbortSignal | null = null;
    const quitter = new AbortController();
    const leaving = memo.get(
      "k",
      (signal) => {
        computeSignal = signal;
        return gate.promise;
      },
      quitter.signal,
    );
    const staying = memo.get("k", () => Promise.resolve(-1), live());
    quitter.abort();
    await expect(leaving).rejects.toMatchObject({ code: "cancelled" });
    expect((computeSignal as AbortSignal | null)?.aborted).toBe(false);
    gate.resolve(5);
    expect(await staying).toBe(5);
    expect(memo.peek("k")).toBe(5);
  });

  it("aborts and forgets the computation once every caller has given up", async () => {
    const memo = new Memo<string, number>();
    let computeSignal: AbortSignal | null = null;
    const first = new AbortController();
    const second = new AbortController();
    const compute = (signal: AbortSignal) => {
      computeSignal = signal;
      return new Promise<number>(() => {});
    };
    const a = memo.get("k", compute, first.signal);
    const b = memo.get("k", compute, second.signal);
    first.abort();
    expect((computeSignal as AbortSignal | null)?.aborted).toBe(false);
    second.abort();
    await expect(a).rejects.toMatchObject({ code: "cancelled" });
    await expect(b).rejects.toMatchObject({ code: "cancelled" });
    expect((computeSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(memo.has("k")).toBe(false);
    expect(await memo.get("k", async () => 9, live())).toBe(9);
  });

  it("rejects at once for a caller whose signal is already aborted", async () => {
    const memo = new Memo<string, number>();
    const controller = new AbortController();
    controller.abort();
    let runs = 0;
    await expect(
      memo.get(
        "k",
        async () => {
          runs += 1;
          return 1;
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(runs).toBe(0);
  });

  it("after delete, callers already waiting get their result but it is not stored", async () => {
    const memo = new Memo<string, number>();
    const gate = deferred<number>();
    const waiting = memo.get("k", () => gate.promise, live());
    memo.delete("k");
    gate.resolve(1);
    expect(await waiting).toBe(1);
    expect(memo.has("k")).toBe(false);
    expect(await memo.get("k", async () => 2, live())).toBe(2);
  });

  it("keeps at most maxEntries results", async () => {
    const memo = new Memo<number, number>(3);
    for (let key = 0; key < 5; key += 1) await memo.get(key, async () => key * 10, live());
    expect(memo.keys()).toEqual([2, 3, 4]);
  });
});
