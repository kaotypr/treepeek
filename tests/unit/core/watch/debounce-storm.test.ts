import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutDebouncer } from "../../../../src/core/watch/debounce";
import { StormGuard } from "../../../../src/core/watch/storm";

describe("CheckoutDebouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports a key once, 400 ms after its last event, with every kind gathered", () => {
    const flushed: [string, string[]][] = [];
    const debouncer = new CheckoutDebouncer((key, items) => flushed.push([key, items.sort()]));
    debouncer.add("a", ["workingTree"]);
    vi.advanceTimersByTime(300);
    debouncer.add("a", ["index"]);
    vi.advanceTimersByTime(399);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([["a", ["index", "workingTree"]]]);
    vi.advanceTimersByTime(5_000);
    expect(flushed).toHaveLength(1);
  });

  it("keeps keys apart", () => {
    const flushed: string[] = [];
    const debouncer = new CheckoutDebouncer((key) => flushed.push(key));
    debouncer.add("a", ["head"]);
    vi.advanceTimersByTime(200);
    debouncer.add("b", ["head"]);
    vi.advanceTimersByTime(200);
    expect(flushed).toEqual(["a"]);
    vi.advanceTimersByTime(200);
    expect(flushed).toEqual(["a", "b"]);
  });

  it("reports a steady trickle no later than 2 s after its first event", () => {
    const flushedAt: number[] = [];
    const start = Date.now();
    const debouncer = new CheckoutDebouncer(() => flushedAt.push(Date.now() - start));
    for (let elapsed = 0; elapsed < 3_000; elapsed += 100) {
      debouncer.add("a", ["workingTree"]);
      vi.advanceTimersByTime(100);
    }
    expect(flushedAt[0]).toBe(2_000);
  });

  it("drops a kind, and the key once nothing is left", () => {
    const flushed: string[][] = [];
    const debouncer = new CheckoutDebouncer((_key, items) => flushed.push(items));
    debouncer.add("a", ["workingTree", "index"]);
    debouncer.drop("a", "workingTree");
    vi.advanceTimersByTime(400);
    expect(flushed).toEqual([["index"]]);
    debouncer.add("a", ["workingTree"]);
    debouncer.drop("a", "workingTree");
    expect(debouncer.pending).toBe(0);
    vi.advanceTimersByTime(2_000);
    expect(flushed).toHaveLength(1);
  });
});

describe("StormGuard", () => {
  it("pauses a checkout past 2,000 events within 2 s, and only that checkout", () => {
    let now = 0;
    const guard = new StormGuard(2_000, 2_000, () => now);
    expect(guard.record("/a", 1_500)).toBe(false);
    now = 1_000;
    expect(guard.record("/b", 1_500)).toBe(false);
    expect(guard.record("/a", 501)).toBe(true);
    expect(guard.isPaused("/a")).toBe(true);
    expect(guard.isPaused("/b")).toBe(false);
    expect([...guard.paused()]).toEqual([["/a", 1_000]]);
    // Once paused, counting stops reporting.
    expect(guard.record("/a", 10_000)).toBe(false);
  });

  it("forgets events older than the window", () => {
    let now = 0;
    const guard = new StormGuard(2_000, 2_000, () => now);
    for (let second = 0; second < 20; second += 1) {
      now = second * 1_000;
      expect(guard.record("/a", 900)).toBe(false);
    }
  });

  it("resumes on request", () => {
    let now = 0;
    const guard = new StormGuard(10, 2_000, () => now);
    expect(guard.record("/a", 11)).toBe(true);
    expect(guard.resume("/a")).toBe(true);
    expect(guard.isPaused("/a")).toBe(false);
    now = 10;
    expect(guard.record("/a", 5)).toBe(false);
    expect(guard.resume("/a")).toBe(false);
  });
});
