import { MessageChannel, type MessagePort } from "node:worker_threads";
import * as v from "valibot";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { CoreRpc, type PortLike } from "../../../src/core/rpc";
import { MainRouter } from "../../../src/main/router";
import type {
  Comparison,
  ComparisonResult,
  ContentSide,
  FileChange,
} from "../../../src/shared/domain/compare";
import type { FileDiff } from "../../../src/shared/domain/diff";
import type { GitState } from "../../../src/shared/domain/git";
import type {
  Checkout,
  FolderNode,
  Repository,
  ScanProblem,
  TimelineEntry,
} from "../../../src/shared/domain/scan";
import {
  type CallMap,
  type CheckoutSchema,
  CONTRACT_VERSION,
  type ComparisonResultSchema,
  type ComparisonSchema,
  type ContentSideSchema,
  CoreToMainSchema,
  coreCalls,
  coreEvents,
  defineCall,
  defineEvent,
  err,
  type FileChangeSchema,
  type FileDiffSchema,
  type FolderNodeSchema,
  type GitStateSchema,
  IPC_ERROR_CODES,
  MAX_VALIDATE_PATHS,
  MainToCoreSchema,
  mainCalls,
  mainEvents,
  ok,
  type PortFromCore,
  parseRequest,
  type RepositorySchema,
  type Result,
  type ScanProblemSchema,
  type TimelineEntrySchema,
} from "../../../src/shared/ipc";
import { createLogger, type Logger } from "../../../src/shared/log";

function memoryLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger({ scope: "test", sink: (line) => lines.push(line) }), lines };
}

function adapt(port: MessagePort): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => port.on("message", listener),
    close: () => port.close(),
  };
}

/** The renderer's half: sends calls over a port and awaits their results. */
function client(port: MessagePort) {
  let nextId = 1;
  const waiting = new Map<number, (result: Result<unknown>) => void>();
  const hellos: number[] = [];
  /** Every result and event in arrival order: `result:<id>` or the event's channel. */
  const arrivals: string[] = [];
  port.on("message", (message: PortFromCore) => {
    if (message.t === "hello") hellos.push(message.contractVersion);
    if (message.t === "event") arrivals.push(message.ch);
    if (message.t === "result") {
      arrivals.push(`result:${message.id}`);
      waiting.get(message.id)?.(message.r as Result<unknown>);
    }
  });
  return {
    hellos,
    arrivals,
    call(ch: string, p: unknown): Promise<Result<unknown>> {
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        port.postMessage({ t: "call", id, ch, p });
      });
    },
    raw(message: unknown) {
      port.postMessage(message);
    },
  };
}

const opened: MessagePort[] = [];
afterEach(() => {
  for (const port of opened.splice(0)) port.close();
});

function setup(calls: CallMap = coreCalls) {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  const { log, lines } = memoryLogger();
  const rpc = new CoreRpc(adapt(port1), { windowId: 1, log }, calls);
  return { rpc, client: client(port2), lines };
}

describe("contract", () => {
  it("lists the error codes from the IPC design", () => {
    expect(IPC_ERROR_CODES).toEqual([
      "invalidRequest",
      "notInScan",
      "gitNotFound",
      "gitTooOld",
      "notARepository",
      "dubiousOwnership",
      "refNotFound",
      "timeout",
      "outputTooLarge",
      "cancelled",
      "coreUnavailable",
      "internal",
    ]);
  });

  it("builds results as values", () => {
    expect(ok(3)).toEqual({ ok: true, value: 3 });
    expect(err("timeout", "slow")).toEqual({
      ok: false,
      error: { code: "timeout", message: "slow" },
    });
    expect(err("internal", "x", { a: 1 })).toEqual({
      ok: false,
      error: { code: "internal", message: "x", detail: { a: 1 } },
    });
  });

  it("validates settings.set strictly", () => {
    const call = mainCalls["settings.set"];
    expect(parseRequest(call, { appearance: "dark" })).toEqual({
      ok: true,
      value: { appearance: "dark" },
    });
    const wrongValue = parseRequest(call, { appearance: "purple" });
    expect(wrongValue.ok).toBe(false);
    if (!wrongValue.ok) expect(wrongValue.error.code).toBe("invalidRequest");
    const unknownKey = parseRequest(call, { appearance: "dark", shell: "rm -rf /" });
    expect(unknownKey.ok).toBe(false);
  });

  it("never lets the renderer set the git binary", () => {
    const result = parseRequest(mainCalls["settings.set"], { gitPath: "/tmp/evil" });
    expect(result).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
  });

  it("validates git.state as the domain's GitState", () => {
    expectTypeOf<v.InferOutput<typeof GitStateSchema>>().toEqualTypeOf<GitState>();
    const payload = mainEvents["git.state"].payload;
    expect(
      v.safeParse(payload, { found: true, path: "/usr/bin/git", version: "2.39.5" }).success,
    ).toBe(true);
    expect(v.safeParse(payload, { found: false, problem: "tooOld", detail: "old" }).success).toBe(
      true,
    );
    expect(v.safeParse(payload, { found: false, problem: "notFound" }).success).toBe(true);
    expect(v.safeParse(payload, { found: false, problem: "gone" }).success).toBe(false);
    expect(v.safeParse(payload, { found: true, path: "/usr/bin/git" }).success).toBe(false);
  });

  it("carries the login PATH in core.init and the git messages between main and core", () => {
    const init = {
      type: "core.init",
      contractVersion: CONTRACT_VERSION,
      userDataDir: "/tmp/u",
      gitPathOverride: null,
      loginPath: "/opt/homebrew/bin:/usr/bin",
    };
    expect(v.safeParse(MainToCoreSchema, init).success).toBe(true);
    const { loginPath: _dropped, ...withoutPath } = init;
    expect(v.safeParse(MainToCoreSchema, withoutPath).success).toBe(false);
    expect(v.safeParse(MainToCoreSchema, { type: "settings.gitPath", path: null }).success).toBe(
      true,
    );
    expect(
      v.safeParse(CoreToMainSchema, {
        type: "git.state",
        state: { found: false, problem: "xcodeMissing" },
      }).success,
    ).toBe(true);
    expect(CONTRACT_VERSION).toBe(5);
  });

  it("carries paths.validate between main and core, bounded", () => {
    const ask = { type: "paths.validate", id: 4, paths: ["/a", "/b c"] };
    expect(v.safeParse(MainToCoreSchema, ask).success).toBe(true);
    expect(v.safeParse(MainToCoreSchema, { ...ask, paths: [""] }).success).toBe(false);
    expect(v.safeParse(MainToCoreSchema, { ...ask, id: 0 }).success).toBe(false);
    const tooMany = Array.from({ length: MAX_VALIDATE_PATHS + 1 }, (_, i) => `/p${i}`);
    expect(v.safeParse(MainToCoreSchema, { ...ask, paths: tooMany }).success).toBe(false);
    expect(
      v.safeParse(CoreToMainSchema, { type: "paths.validate", id: 4, valid: [true, false] })
        .success,
    ).toBe(true);
  });

  it("keeps the scan schemas and the domain types in step", () => {
    expectTypeOf<v.InferOutput<typeof CheckoutSchema>>().toExtend<Checkout>();
    expectTypeOf<Checkout>().toExtend<v.InferOutput<typeof CheckoutSchema>>();
    expectTypeOf<v.InferOutput<typeof FolderNodeSchema>>().toEqualTypeOf<FolderNode>();
    expectTypeOf<v.InferOutput<typeof RepositorySchema>>().toEqualTypeOf<Repository>();
    expectTypeOf<v.InferOutput<typeof TimelineEntrySchema>>().toEqualTypeOf<TimelineEntry>();
    expectTypeOf<v.InferOutput<typeof ScanProblemSchema>>().toEqualTypeOf<ScanProblem>();
  });

  it("keeps the comparison schemas and the domain types in step", () => {
    expectTypeOf<v.InferOutput<typeof ContentSideSchema>>().toEqualTypeOf<ContentSide>();
    expectTypeOf<v.InferOutput<typeof ComparisonSchema>>().toEqualTypeOf<Comparison>();
    expectTypeOf<v.InferOutput<typeof FileChangeSchema>>().toEqualTypeOf<FileChange>();
    expectTypeOf<v.InferOutput<typeof ComparisonResultSchema>>().toEqualTypeOf<ComparisonResult>();
    expectTypeOf<v.InferOutput<typeof FileDiffSchema>>().toEqualTypeOf<FileDiff>();
  });

  it("validates diff.file requests strictly: a comparison selector, bounded strings", () => {
    const diff = coreCalls["diff.file"];
    const good = {
      requestId: "d1",
      checkoutPath: "/x",
      comparison: { kind: "review" },
      path: "src/a b.ts",
    };
    expect(parseRequest(diff, good).ok).toBe(true);
    expect(
      parseRequest(diff, {
        ...good,
        comparison: { kind: "working" },
        category: "unstaged",
      }).ok,
    ).toBe(true);
    expect(
      parseRequest(diff, {
        ...good,
        comparison: { kind: "base", ref: "main", startOverride: "v1" },
      }).ok,
    ).toBe(true);
    for (const bad of [
      { ...good, requestId: "" },
      { ...good, requestId: "r".repeat(129) },
      { ...good, checkoutPath: "" },
      { ...good, path: "" },
      { ...good, path: "p".repeat(4097) },
      { ...good, category: "ignored" },
      { ...good, comparison: { kind: "sinceViewed" } },
      { ...good, comparison: { kind: "base", ref: "a".repeat(201) } },
      // Sides, commit and blob ids are never taken from the renderer.
      { ...good, comparison: { kind: "review", left: { kind: "empty" } } },
      { ...good, comparison: { kind: "review", right: { kind: "workingTree" } } },
      { ...good, leftOid: "a".repeat(40) },
      { ...good, resultHash: "a".repeat(40) },
      (({ requestId: _, ...rest }) => rest)(good),
      (({ comparison: _, ...rest }) => rest)(good),
    ]) {
      expect(parseRequest(diff, bad).ok, JSON.stringify(bad)).toBe(false);
    }
    const fileDiff: FileDiff = {
      path: "b.txt",
      oldPath: "a.txt",
      status: "renamed",
      binary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          header: "@@ -1 +1 @@",
          lines: [
            { kind: "remove", text: "a", oldNo: 1, newNo: null },
            { kind: "add", text: "b", oldNo: null, newNo: 1 },
            { kind: "noNewline", text: "No newline at end of file", oldNo: null, newNo: null },
          ],
        },
      ],
      left: "a",
      right: "b",
      stats: { added: 1, removed: 1 },
      limits: { patchTruncated: false, contentOmitted: false, highlightOff: false },
      resultHash: "c".repeat(40),
    };
    expect(v.safeParse(diff.response, fileDiff).success).toBe(true);
    expect(v.safeParse(diff.response, { ...fileDiff, left: null, right: null }).success).toBe(true);
    expect(v.safeParse(diff.response, { ...fileDiff, oldPath: undefined }).success).toBe(false);
    expect(v.safeParse(diff.response, { ...fileDiff, status: "unmerged" }).success).toBe(false);
    expect(
      v.safeParse(diff.response, { ...fileDiff, stats: { added: -1, removed: 0 } }).success,
    ).toBe(false);
  });

  it("validates comparison.list requests strictly and bounds the refs", () => {
    const list = coreCalls["comparison.list"];
    expect(parseRequest(list, { checkoutPath: "/x", kind: "review" }).ok).toBe(true);
    expect(
      parseRequest(list, { checkoutPath: "/x", kind: "base", ref: "main", startOverride: "v1" }).ok,
    ).toBe(true);
    for (const bad of [
      { checkoutPath: "/x", kind: "sinceViewed" },
      { checkoutPath: "/x", kind: "nope" },
      { checkoutPath: "/x" },
      { checkoutPath: "", kind: "review" },
      { checkoutPath: "/x", kind: "base", ref: "" },
      { checkoutPath: "/x", kind: "base", ref: "a".repeat(201) },
      { checkoutPath: "/x", kind: "review", startOverride: "a".repeat(201) },
      { checkoutPath: "/x", kind: "review", ref: undefined },
      { checkoutPath: "/x", kind: "review", extra: true },
    ]) {
      expect(parseRequest(list, bad).ok, JSON.stringify(bad)).toBe(false);
    }
    const response = list.response;
    const file: FileChange = {
      path: "a b.txt",
      oldPath: "a.txt",
      status: "renamed",
      left: { kind: "commit", oid: "a".repeat(40) },
      right: { kind: "workingTree" },
      leftOid: "b".repeat(40),
      resultHash: "c".repeat(40),
      binary: false,
    };
    const result: ComparisonResult = {
      comparison: { kind: "review", left: file.left, right: file.right },
      files: [file, { ...file, oldPath: undefined as never }],
      commits: 2,
      contained: false,
    };
    expect(v.safeParse(response, { ...result, files: [file] }).success).toBe(true);
    expect(v.safeParse(response, result).success).toBe(false);
    expect(
      v.safeParse(response, { ...result, files: [{ ...file, status: "unmerged" }] }).success,
    ).toBe(false);
    expect(
      v.safeParse(response, {
        ...result,
        files: [],
        comparison: { kind: "working", left: { kind: "commit" }, right: { kind: "index" } },
      }).success,
    ).toBe(false);
  });

  it("validates the session, scan and start-override requests strictly", () => {
    expect(parseRequest(coreCalls["session.open"], { scanRoot: "/x" }).ok).toBe(true);
    expect(parseRequest(coreCalls["session.open"], { scanRoot: "" }).ok).toBe(false);
    expect(parseRequest(coreCalls["session.open"], { scanRoot: "/x", extra: 1 }).ok).toBe(false);
    expect(parseRequest(coreCalls["session.open"], { scanRoot: "/".repeat(4097) }).ok).toBe(false);
    expect(parseRequest(coreCalls["scan.start"], { requestId: "r" }).ok).toBe(true);
    expect(parseRequest(coreCalls["scan.start"], { requestId: "" }).ok).toBe(false);
    const override = coreCalls["start.override"];
    expect(parseRequest(override, { checkoutPath: "/x", commit: null }).ok).toBe(true);
    expect(parseRequest(override, { checkoutPath: "/x", commit: "main" }).ok).toBe(true);
    expect(parseRequest(override, { checkoutPath: "/x" }).ok).toBe(false);
    expect(parseRequest(override, { checkoutPath: "/x", commit: "a".repeat(201) }).ok).toBe(false);
    expect(parseRequest(override, { checkoutPath: "/x", commit: "" }).ok).toBe(false);
  });

  it("checks scan event payloads, which are not sticky", () => {
    const checkout: Checkout = {
      path: "/r/app",
      kind: "main",
      branch: null,
      head: null,
      upstream: null,
      originUrl: null,
      start: { unknown: true },
      working: { staged: 0, unstaged: 0, untracked: 0 },
      history: null,
    };
    const payload = coreEvents["scan.checkout"].payload;
    expect(v.safeParse(payload, checkout).success).toBe(true);
    expect(
      v.safeParse(payload, {
        ...checkout,
        start: { commit: "a".repeat(40), observedAt: "2025-01-01T00:00:00Z", source: "reflog" },
      }).success,
    ).toBe(true);
    expect(v.safeParse(payload, { ...checkout, start: { commit: "x" } }).success).toBe(false);
    expect(v.safeParse(payload, { ...checkout, kind: "other" }).success).toBe(false);
    const done = coreEvents["scan.done"].payload;
    expect(
      v.safeParse(done, { timeline: [], repositories: [], durationMs: 3, problems: [] }).success,
    ).toBe(true);
    expect(
      v.safeParse(done, {
        timeline: [],
        repositories: [],
        durationMs: 3,
        problems: [{ path: "/r/x", code: "nonsense", message: "?" }],
      }).success,
    ).toBe(false);
    expect(coreEvents["scan.checkout"].sticky).toBe(false);
    expect(coreEvents["scan.done"].sticky).toBe(false);
  });

  it("marks state-like events sticky", () => {
    expect(mainEvents["theme.changed"].sticky).toBe(true);
    expect(mainEvents["core.state"].sticky).toBe(true);
    expect(mainEvents["git.state"].sticky).toBe(true);
    expect(v.safeParse(mainEvents["core.state"].payload, { state: "gone" }).success).toBe(false);
  });
});

describe("CoreRpc (core path)", () => {
  it("says hello with the contract version and round-trips app.ping", async () => {
    const { rpc, client: c } = setup();
    rpc.onCall(coreCalls["app.ping"], () => ok({ process: "core", pid: 7, at: 1 }));
    rpc.hello();
    const result = await c.call("app.ping", {});
    expect(result).toEqual({ ok: true, value: { process: "core", pid: 7, at: 1 } });
    expect(c.hellos).toEqual([CONTRACT_VERSION]);
  });

  it("returns invalidRequest for a payload that fails its schema, without throwing", async () => {
    const { rpc, client: c, lines } = setup();
    let ran = false;
    rpc.onCall(coreCalls["app.ping"], () => {
      ran = true;
      return ok({ process: "core", pid: 1, at: 1 });
    });
    const result = await c.call("app.ping", { unexpected: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalidRequest");
    expect(ran).toBe(false);
    expect(lines.some((line) => line.includes("rejected an invalid request"))).toBe(true);
  });

  it("rejects an unknown channel", async () => {
    const { client: c } = setup();
    const result = await c.call("fs.readFile", { path: "/etc/passwd" });
    expect(result).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    // Inherited object keys are not channels either.
    const proto = await c.call("toString", {});
    expect(proto).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
  });

  it("drops malformed port messages and keeps serving", async () => {
    const { rpc, client: c } = setup();
    rpc.onCall(coreCalls["app.ping"], () => ok({ process: "core", pid: 1, at: 1 }));
    c.raw({ nonsense: true });
    c.raw("text");
    expect((await c.call("app.ping", {})).ok).toBe(true);
  });

  it("turns a throwing handler into internal", async () => {
    const { rpc, client: c } = setup();
    rpc.onCall(coreCalls["app.ping"], () => {
      throw new Error("boom");
    });
    expect(await c.call("app.ping", {})).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("cancels a slow call by request id and aborts its handler's signal", async () => {
    const slow = defineCall({
      name: "test.slow",
      request: v.strictObject({ requestId: v.string() }),
      response: v.object({ done: v.boolean() }),
    });
    const { rpc, client: c } = setup({ ...coreCalls, [slow.name]: slow });
    let seenSignal: AbortSignal | undefined;
    rpc.onCall(slow, async (_ctx, _request, signal) => {
      seenSignal = signal;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return ok({ done: true });
    });

    const pending = c.call("test.slow", { requestId: "scan-1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancel = await c.call("request.cancel", { requestId: "scan-1" });
    expect(cancel).toEqual({ ok: true, value: {} });
    expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(seenSignal?.aborted).toBe(true);
  });

  it("posts a call's result before anything its afterReply work emits", async () => {
    const tick = defineEvent({ name: "test.tick", payload: v.object({ n: v.number() }) });
    const { rpc, client: c } = setup();
    rpc.onCall(coreCalls["app.ping"], (ctx) => {
      ctx.afterReply(async () => {
        // Emitted synchronously, before any await: it must still follow the result.
        rpc.emit(tick, { n: 1 });
        await Promise.resolve();
        rpc.emit(tick, { n: 2 });
      });
      return ok({ process: "core", pid: 1, at: 1 });
    });
    await c.call("app.ping", {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(c.arrivals).toEqual(["result:1", "test.tick", "test.tick"]);
  });

  it("keeps afterReply work cancellable by request id until it settles", async () => {
    const slow = defineCall({
      name: "test.slow",
      request: v.strictObject({ requestId: v.string() }),
      response: v.object({}),
    });
    const { rpc, client: c } = setup({ ...coreCalls, [slow.name]: slow });
    let aborted = false;
    let finished: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      finished = resolve;
    });
    rpc.onCall(slow, (ctx, _request, signal) => {
      ctx.afterReply(
        () =>
          new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
              finished();
            });
          }),
      );
      return ok({});
    });
    expect(await c.call("test.slow", { requestId: "bg" })).toEqual({ ok: true, value: {} });
    // Still running, so the id is still taken.
    expect(await c.call("test.slow", { requestId: "bg" })).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
    expect(await c.call("request.cancel", { requestId: "bg" })).toEqual({ ok: true, value: {} });
    await settled;
    expect(aborted).toBe(true);
    // Released once it settled.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await c.call("test.slow", { requestId: "bg" })).toMatchObject({ ok: true });
    rpc.close();
  });

  it("aborts afterReply work when the port closes, and drops it for a failed call", async () => {
    const { rpc, client: c } = setup();
    let signalSeen: AbortSignal | undefined;
    let ranAfterError = false;
    rpc.onCall(coreCalls["app.ping"], (ctx, _request, signal) => {
      signalSeen = signal;
      ctx.afterReply(() => new Promise<void>(() => undefined));
      return ok({ process: "core", pid: 1, at: 1 });
    });
    rpc.onCall(coreCalls["app.info"], (ctx) => {
      ctx.afterReply(async () => {
        ranAfterError = true;
      });
      return err("internal", "no");
    });
    await c.call("app.ping", {});
    await c.call("app.info", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ranAfterError).toBe(false);
    expect(signalSeen?.aborted).toBe(false);
    rpc.close();
    expect(signalSeen?.aborted).toBe(true);
  });

  it("refuses a request id that is already in flight", async () => {
    const slow = defineCall({
      name: "test.slow",
      request: v.strictObject({ requestId: v.string() }),
      response: v.object({}),
    });
    const { rpc, client: c } = setup({ ...coreCalls, [slow.name]: slow });
    rpc.onCall(slow, (_ctx, _request, signal) => {
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(ok({}))));
    });
    const first = c.call("test.slow", { requestId: "same" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await c.call("test.slow", { requestId: "same" });
    expect(second).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    rpc.close();
    void first;
  });
});

describe("MainRouter (main path)", () => {
  it("round-trips app.ping", async () => {
    const router = new MainRouter(memoryLogger().log);
    router.handle(mainCalls["app.ping"], () => ok({ process: "main", at: 5 }));
    expect(await router.dispatch({ ch: "app.ping", p: {} }, { windowId: 1 })).toEqual({
      ok: true,
      value: { process: "main", at: 5 },
    });
  });

  it("returns invalidRequest for an invalid payload and rejects unknown channels", async () => {
    const router = new MainRouter(memoryLogger().log);
    router.handle(mainCalls["settings.set"], (_ctx, patch) =>
      ok({ appearance: patch.appearance ?? "system", gitPath: null }),
    );
    expect(
      await router.dispatch({ ch: "settings.set", p: { appearance: 1 } }, { windowId: 1 }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(await router.dispatch({ ch: "shell.exec", p: {} }, { windowId: 1 })).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
    expect(await router.dispatch("not an envelope", { windowId: 1 })).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
  });

  it("will not register a handler for a channel outside the contract", () => {
    const router = new MainRouter(memoryLogger().log);
    const rogue = defineCall({ name: "rogue.call", request: v.object({}), response: v.object({}) });
    expect(() => router.handle(rogue, () => ok({}))).toThrow(/not a main channel/);
  });
});
