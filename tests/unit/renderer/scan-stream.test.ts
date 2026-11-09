import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "../../../src/renderer/data/keys";
import type { ScanData } from "../../../src/renderer/data/scan-model";
import { startScan } from "../../../src/renderer/data/scan-stream";
import type { Checkout } from "../../../src/shared/domain/scan";
import type { Result } from "../../../src/shared/ipc/result";

type Listener = (payload: unknown) => void;

/** A stand-in for `window.treepeek`: calls answer when the test says so. */
function fakeApi() {
  const listeners = new Map<string, Set<Listener>>();
  const pendingStarts: Array<(result: Result<unknown>) => void> = [];
  const cancelled: string[] = [];
  const api = {
    on(event: string, listener: Listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return () => set?.delete(listener);
    },
    core: {
      session: { open: async () => ({ ok: true, value: { sessionId: "s", gitVersion: "2.50.0" } }) },
      scan: {
        start: () => new Promise<Result<unknown>>((resolve) => pendingStarts.push(resolve)),
      },
      request: {
        cancel: async ({ requestId }: { requestId: string }) => {
          cancelled.push(requestId);
          return { ok: true, value: {} };
        },
      },
    },
  };
  return {
    api,
    cancelled,
    emit(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    /** Answers the oldest unanswered `scan.start`. */
    async answerStart() {
      await vi.waitFor(() => expect(pendingStarts.length).toBeGreaterThan(0));
      pendingStarts.shift()?.({
        ok: true,
        value: { scanRoot: "/w", folders: [], depthLimit: 7 },
      });
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function checkout(path: string): Checkout {
  return {
    path,
    kind: "main",
    branch: "main",
    head: "a",
    upstream: null,
    originUrl: null,
    start: { unknown: true },
    working: { staged: 0, unstaged: 0, untracked: 0 },
    history: null,
  };
}

const done = (paths: string[]) => ({
  timeline: paths.map((path, index) => ({
    sequence: index + 1,
    checkoutPath: path,
    commonDir: `${path}/.git`,
    predecessor: null,
    relation: "first",
  })),
  repositories: [],
  durationMs: 5,
  problems: [],
});

let fake: ReturnType<typeof fakeApi>;
let client: QueryClient;
const read = () => client.getQueryData<ScanData>(keys.scan("/w"));

beforeEach(() => {
  fake = fakeApi();
  Object.defineProperty(window, "treepeek", { value: fake.api, configurable: true });
  client = new QueryClient();
});
afterEach(() => {
  client.clear();
});

describe("startScan", () => {
  it("writes checkouts as they stream, then the timeline when the scan is done", async () => {
    const stream = startScan(client, "/w");
    await fake.answerStart();
    expect(read()?.phase).toBe("resolving");
    fake.emit("scan.checkout", checkout("/w/a"));
    fake.emit("scan.checkout", checkout("/w/b"));
    await vi.waitFor(() => expect(Object.keys(read()?.checkouts ?? {})).toEqual(["/w/a", "/w/b"]));
    expect(read()?.phase).toBe("resolving");
    fake.emit("scan.done", done(["/w/a", "/w/b"]));
    expect(read()?.phase).toBe("done");
    expect(read()?.timeline).toHaveLength(2);
    stream.stop();
  });

  it("keeps what is on screen during a rescan, then drops checkouts that are gone", async () => {
    const stream = startScan(client, "/w");
    await fake.answerStart();
    fake.emit("scan.checkout", checkout("/w/a"));
    fake.emit("scan.checkout", checkout("/w/b"));
    fake.emit("scan.done", done(["/w/a", "/w/b"]));

    const again = stream.rescan();
    await fake.answerStart();
    await again;
    expect(Object.keys(read()?.checkouts ?? {})).toEqual(["/w/a", "/w/b"]);
    fake.emit("scan.checkout", checkout("/w/a"));
    fake.emit("scan.done", done(["/w/a"]));
    expect(Object.keys(read()?.checkouts ?? {})).toEqual(["/w/a"]);
    expect(read()?.arrival).toEqual(["/w/a"]);
    stream.stop();
  });

  it("ignores a scan.done that arrives before the newer scan answered", async () => {
    const stream = startScan(client, "/w");
    await fake.answerStart();
    fake.emit("scan.checkout", checkout("/w/a"));

    void stream.rescan();
    await vi.waitFor(() => expect(read()?.phase).toBe("walking"));
    // The replaced scan's last event, already on its way.
    fake.emit("scan.done", done(["/w/old"]));
    expect(read()?.phase).toBe("walking");
    expect(read()?.timeline).toEqual([]);

    await fake.answerStart();
    fake.emit("scan.checkout", checkout("/w/a"));
    fake.emit("scan.done", done(["/w/a"]));
    expect(read()?.phase).toBe("done");
    expect(read()?.timeline.map((item) => item.checkoutPath)).toEqual(["/w/a"]);
    stream.stop();
  });

  it("stops listening and cancels the scan when stopped", async () => {
    const stream = startScan(client, "/w");
    await fake.answerStart();
    stream.stop();
    expect(fake.cancelled).toHaveLength(1);
    fake.emit("scan.checkout", checkout("/w/late"));
    fake.emit("scan.done", done(["/w/late"]));
    expect(read()?.phase).toBe("resolving");
    expect(read()?.checkouts).toEqual({});
  });
});
