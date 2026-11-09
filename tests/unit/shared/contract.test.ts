import { MessageChannel, type MessagePort } from "node:worker_threads";
import * as v from "valibot";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { CoreRpc, type PortLike } from "../../../src/core/rpc";
import { MainRouter } from "../../../src/main/router";
import type { GitState } from "../../../src/shared/domain/git";
import {
  type CallMap,
  CONTRACT_VERSION,
  CoreToMainSchema,
  coreCalls,
  defineCall,
  err,
  type GitStateSchema,
  IPC_ERROR_CODES,
  MainToCoreSchema,
  mainCalls,
  mainEvents,
  ok,
  type PortFromCore,
  parseRequest,
  type Result,
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
  port.on("message", (message: PortFromCore) => {
    if (message.t === "hello") hellos.push(message.contractVersion);
    if (message.t === "result") waiting.get(message.id)?.(message.r as Result<unknown>);
  });
  return {
    hellos,
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
    expect(CONTRACT_VERSION).toBe(2);
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
