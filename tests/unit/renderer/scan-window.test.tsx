import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient, Providers } from "../../../src/renderer/app/providers";
import { ScanWindow } from "../../../src/renderer/app/ScanWindow";
import { clearCommands } from "../../../src/renderer/commands/registry";

type Listener = (payload: unknown) => void;

/** A `window.treepeek` whose sticky events the test sets, recording the calls made. */
function fakeApi() {
  const listeners = new Map<string, Set<Listener>>();
  const latest = new Map<string, unknown>();
  const calls: string[] = [];
  const answer = (name: string, value: unknown) => async () => {
    calls.push(name);
    return { ok: true, value };
  };
  const api = {
    on(event: string, listener: Listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      if (latest.has(event)) queueMicrotask(() => listener(latest.get(event)));
      return () => set?.delete(listener);
    },
    main: {
      settings: { get: answer("settings.get", { appearance: "system", gitPath: null, recentFolders: [], windows: [] }) },
      window: { state: answer("window.state", {}) },
    },
    core: {
      session: { open: answer("session.open", { sessionId: "s", gitVersion: "2.50.0" }) },
      scan: { start: answer("scan.start", { scanRoot: "/w", folders: [], depthLimit: 7 }) },
      request: { cancel: answer("request.cancel", {}) },
    },
  };
  return {
    api,
    calls,
    emit(event: string, payload: unknown) {
      latest.set(event, payload);
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
}

let fake: ReturnType<typeof fakeApi>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fake = fakeApi();
  Object.defineProperty(window, "treepeek", { value: fake.api, configurable: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearCommands();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <Providers client={createQueryClient()}>
        <ScanWindow scanRoot="/w" />
      </Providers>,
    );
  });
}

describe("ScanWindow", () => {
  it("shows the git notice instead of the panels while no usable git is found", async () => {
    fake.emit("git.state", { found: false, problem: "notFound" });
    await render();
    expect(container.querySelector('[data-testid="git-missing"]')?.textContent).toContain(
      "could not find Git",
    );
    expect(container.querySelector('[data-testid="navigator"]')).toBeNull();
  });

  it("shows Reconnecting… while the core restarts, then opens the session and rescans", async () => {
    fake.emit("git.state", { found: true, path: "/usr/bin/git", version: "2.50.0" });
    fake.emit("core.state", { state: "ready" });
    await render();
    await vi.waitFor(() => expect(fake.calls.filter((call) => call === "scan.start")).toHaveLength(1));

    await act(async () => fake.emit("core.state", { state: "restarting" }));
    expect(container.querySelector('[data-testid="connection-banner"]')?.textContent).toBe(
      "Reconnecting…",
    );
    await act(async () => fake.emit("core.state", { state: "ready" }));
    expect(container.querySelector('[data-testid="connection-banner"]')).toBeNull();
    await vi.waitFor(() => expect(fake.calls.filter((call) => call === "session.open")).toHaveLength(2));
    await vi.waitFor(() => expect(fake.calls.filter((call) => call === "scan.start")).toHaveLength(2));
  });
});
