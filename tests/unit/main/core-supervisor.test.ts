import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreSupervisor } from "../../../src/main/core-supervisor";
import { CONTRACT_VERSION, MAX_VALIDATE_PATHS } from "../../../src/shared/ipc";
import { createLogger } from "../../../src/shared/log";

interface FakeChild {
  readonly posted: unknown[];
  emit(event: string, ...args: unknown[]): boolean;
}

/** The utility processes `utilityProcess.fork` returned, newest last. */
const fake = vi.hoisted(() => ({ children: [] as FakeChild[] }));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Child extends EventEmitter implements FakeChild {
    readonly pid = 4242;
    readonly posted: unknown[] = [];
    postMessage(message: unknown): void {
      this.posted.push(message);
    }
    kill(): boolean {
      return true;
    }
  }
  return {
    utilityProcess: {
      fork: () => {
        const child = new Child();
        fake.children.push(child);
        return child;
      },
    },
    MessageChannelMain: class {
      port1 = {};
      port2 = {};
    },
  };
});

const supervisors: CoreSupervisor[] = [];

function started(options: { validateTimeoutMs?: number } = {}) {
  const supervisor = new CoreSupervisor({
    entry: "/nowhere/core.js",
    userDataDir: "/nowhere/user-data",
    log: createLogger({ scope: "test", sink: () => undefined }),
    healthIntervalMs: 60_000,
    validateTimeoutMs: options.validateTimeoutMs ?? 5_000,
  });
  supervisors.push(supervisor);
  supervisor.start();
  const child = fake.children.at(-1);
  if (!child) throw new Error("no child");
  return { supervisor, child };
}

function ready(child: FakeChild): void {
  child.emit("message", { type: "core.ready", pid: 1, contractVersion: CONTRACT_VERSION });
}

function lastAsk(child: FakeChild): { type: string; id: number; paths: string[] } {
  return child.posted.at(-1) as { type: string; id: number; paths: string[] };
}

afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.stop();
  fake.children.length = 0;
});

describe("CoreSupervisor.validatePaths", () => {
  it("asks the core service and resolves its answer, one boolean per path", async () => {
    const { supervisor, child } = started();
    ready(child);
    const answer = supervisor.validatePaths(["/scan/app", "/etc/passwd"]);
    const ask = lastAsk(child);
    expect(ask).toEqual({
      type: "paths.validate",
      id: ask.id,
      paths: ["/scan/app", "/etc/passwd"],
    });
    child.emit("message", { type: "paths.validate", id: ask.id, valid: [true, false] });
    expect(await answer).toEqual([true, false]);
  });

  it("answers false without asking while the service is not ready, or for bad input", async () => {
    const { supervisor, child } = started();
    expect(await supervisor.validatePaths(["/scan/app"])).toEqual([false]);
    ready(child);
    const posted = child.posted.length;
    const tooMany = Array.from({ length: MAX_VALIDATE_PATHS + 1 }, (_, i) => `/p${i}`);
    expect(await supervisor.validatePaths(tooMany)).toEqual(tooMany.map(() => false));
    expect(await supervisor.validatePaths(["/ok", ""])).toEqual([false, false]);
    expect(await supervisor.validatePaths([])).toEqual([]);
    expect(child.posted.length).toBe(posted);
  });

  it("answers false when the service does not reply in time, or replies with the wrong count", async () => {
    const { supervisor, child } = started({ validateTimeoutMs: 50 });
    ready(child);
    expect(await supervisor.validatePaths(["/a"])).toEqual([false]);

    const answer = supervisor.validatePaths(["/a", "/b"]);
    child.emit("message", { type: "paths.validate", id: lastAsk(child).id, valid: [true] });
    expect(await answer).toEqual([false, false]);
  });

  it("answers false when the service exits before replying, and ignores a late reply", async () => {
    const { supervisor, child } = started();
    ready(child);
    const answer = supervisor.validatePaths(["/a"]);
    const { id } = lastAsk(child);
    child.emit("exit", 1);
    expect(await answer).toEqual([false]);
    child.emit("message", { type: "paths.validate", id, valid: [true] });
  });
});
