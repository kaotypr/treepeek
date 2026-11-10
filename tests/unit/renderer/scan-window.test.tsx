import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient, Providers } from "../../../src/renderer/app/providers";
import { ScanWindow } from "../../../src/renderer/app/ScanWindow";
import {
  clearCommands,
  installMenuCommands,
  registerCommand,
} from "../../../src/renderer/commands/registry";
import { uiStore } from "../../../src/renderer/state/ui-store";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings";

type Listener = (payload: unknown) => void;
type Answer =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; detail?: unknown } };

/** A `window.treepeek` whose sticky events the test sets, recording the calls made. */
function fakeApi() {
  const listeners = new Map<string, Set<Listener>>();
  const latest = new Map<string, unknown>();
  const calls: string[] = [];
  const requests: { name: string; request: unknown }[] = [];
  const answers = new Map<string, Answer>();
  const answer = (name: string, value: unknown) => async (request?: unknown) => {
    calls.push(name);
    requests.push({ name, request });
    return answers.get(name) ?? { ok: true, value };
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
      settings: {
        get: answer("settings.get", DEFAULT_SETTINGS),
        open: answer("settings.open", {}),
      },
      window: {
        state: answer("window.state", {}),
        commands: answer("window.commands", {}),
      },
      folder: { choose: answer("folder.choose", null) },
      git: {
        choose: answer("git.choose", null),
        detect: answer("git.detect", {}),
      },
      clipboard: { copy: answer("clipboard.copy", {}) },
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
    requests,
    answers,
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

const count = (name: string) => fake.calls.filter((call) => call === name).length;
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function click(element: HTMLElement | null): Promise<void> {
  if (!element) throw new Error("nothing to click");
  await act(async () => element.click());
}

describe("ScanWindow", () => {
  it("shows the git setup screen instead of the panels while no usable git is found", async () => {
    fake.emit("git.state", { found: false, problem: "notFound" });
    await render();
    expect(byTestId("git-setup")?.textContent).toContain("could not find Git");
    expect(byTestId("git-setup")?.textContent).toContain("xcode-select --install");
    expect(byTestId("git-setup")?.textContent).toContain("brew install git");
    expect(byTestId("navigator")).toBeNull();
  });

  it("looks for git again on Try Again, and scans once git is found", async () => {
    fake.emit("git.state", { found: false, problem: "notFound" });
    // As the core service answers while it has no git.
    fake.answers.set("session.open", {
      ok: false,
      error: { code: "gitNotFound", message: "No usable Git was found." },
    });
    await render();
    await vi.waitFor(() => expect(count("session.open")).toBe(1));
    await click(byTestId("git-try-again"));
    expect(count("git.detect")).toBe(1);
    expect(byTestId("git-try-again")?.textContent).toBe("Looking for Git…");

    // Discovery answers again, still without git: the screen stays, ready to try again.
    await act(async () => fake.emit("git.state", { found: false, problem: "notFound" }));
    expect(byTestId("git-try-again")?.textContent).toBe("Try Again");

    expect(count("scan.start")).toBe(0);
    fake.answers.delete("session.open");
    await act(async () =>
      fake.emit("git.state", { found: true, path: "/opt/homebrew/bin/git", version: "2.50.0" }),
    );
    expect(byTestId("git-setup")).toBeNull();
    await vi.waitFor(() => expect(count("session.open")).toBe(2));
    await vi.waitFor(() => expect(count("scan.start")).toBe(1));
  });

  it("names a picked git that is too old where it was picked", async () => {
    fake.emit("git.state", { found: false, problem: "notFound" });
    fake.answers.set("git.choose", {
      ok: true,
      value: {
        path: "/old/git",
        state: {
          found: false,
          problem: "tooOld",
          detail:
            "Git 2.30.2 at /old/git is older than 2.36.0, the oldest version Treepeek supports.",
        },
      },
    });
    await render();
    await click(byTestId("git-choose"));
    expect(byTestId("git-setup-picked")?.textContent).toContain("Git 2.30.2 at /old/git is older");
    expect(byTestId("git-setup-picked")?.getAttribute("role")).toBe("alert");
  });

  it("shows Reconnecting… while the core restarts, then opens the session and rescans", async () => {
    fake.emit("git.state", { found: true, path: "/usr/bin/git", version: "2.50.0" });
    fake.emit("core.state", { state: "ready" });
    await render();
    await vi.waitFor(() => expect(count("scan.start")).toBe(1));

    await act(async () => fake.emit("core.state", { state: "restarting" }));
    expect(byTestId("connection-banner")?.textContent).toBe("Reconnecting…");
    await act(async () => fake.emit("core.state", { state: "ready" }));
    expect(byTestId("connection-banner")).toBeNull();
    await vi.waitFor(() => expect(count("session.open")).toBe(2));
    await vi.waitFor(() => expect(count("scan.start")).toBe(2));
  });

  it("offers another folder when this one cannot be read", async () => {
    fake.emit("git.state", { found: true, path: "/usr/bin/git", version: "2.50.0" });
    fake.answers.set("session.open", {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Treepeek is not allowed to read this folder.",
        detail: { scanRoot: "unreadable" },
      },
    });
    await render();
    await vi.waitFor(() => expect(byTestId("scan-error")).not.toBeNull());
    expect(byTestId("scan-error")?.textContent).toContain("can't read this folder");
    expect(byTestId("navigator")).toBeNull();
    await click(byTestId("choose-another-folder"));
    expect(fake.requests.find((call) => call.name === "folder.choose")?.request).toEqual({
      replace: true,
    });
  });

  it("explains Git's safe.directory refusal with the command to run, and runs nothing", async () => {
    fake.emit("git.state", { found: true, path: "/usr/bin/git", version: "2.50.0" });
    await render();
    // The scan has answered with its folders; checkouts and `scan.done` follow.
    await vi.waitFor(() => expect(byTestId("scan-status")?.textContent).toContain("found"));
    await act(async () =>
      fake.emit("scan.done", {
        timeline: [],
        repositories: [],
        durationMs: 3,
        problems: [
          {
            path: "/w/someone's repo",
            code: "dubiousOwnership",
            message: "Git refuses to open this repository because it is owned by another user.",
          },
        ],
      }),
    );
    // TanStack Query tells its observers on the next task.
    await vi.waitFor(() => expect(byTestId("dubious-ownership-row")).not.toBeNull());
    const row = byTestId("dubious-ownership-row");
    expect(row?.textContent).toContain("belongs to another user");
    expect(byTestId("scan-status")?.textContent).toBe(
      "No Git checkouts found beneath this folder. · 1 folder could not be read",
    );
    expect(row?.querySelector('[data-testid="copy-command-text"]')?.textContent).toBe(
      "git config --global --add safe.directory '/w/someone'\\''s repo'",
    );
    expect(fake.calls).not.toContain("clipboard.copy");
    await click(row?.querySelector("button") ?? null);
    expect(fake.requests.find((call) => call.name === "clipboard.copy")?.request).toEqual({
      text: "git config --global --add safe.directory '/w/someone'\\''s repo'",
      kind: "command",
    });
  });

  it("tells main which commands are enabled and checked, for the menu", async () => {
    fake.emit("git.state", { found: true, path: "/usr/bin/git", version: "2.50.0" });
    await render();
    await vi.waitFor(() => expect(count("window.commands")).toBeGreaterThan(0));
    const last = () =>
      fake.requests.filter((call) => call.name === "window.commands").at(-1)?.request as {
        enabled: string[];
        checked: string[];
      };
    expect(last().enabled).toContain("view.timeline");
    expect(last().enabled).not.toContain("checkout.copyCommit");
    expect(last().checked).not.toContain("view.timeline");
    await act(async () => uiStore.getState().setTimelineOpen(true));
    await vi.waitFor(() => expect(last().checked).toContain("view.timeline"));
    await act(async () => uiStore.getState().setTimelineOpen(false));
  });

  it("starts a newly selected checkout on the default comparison from Settings", async () => {
    fake.emit("git.state", { found: true, path: "/usr/bin/git", version: "2.50.0" });
    fake.emit("settings.changed", { ...DEFAULT_SETTINGS, defaultComparison: "working" });
    await render();
    await vi.waitFor(() => expect(uiStore.getState().defaultComparison).toBe("working"));
    await act(async () => uiStore.getState().selectCheckout("/w/a"));
    expect(uiStore.getState().comparisonKind).toBe("working");
    await act(async () => {
      fake.emit("settings.changed", { ...DEFAULT_SETTINGS, defaultComparison: "review" });
      uiStore.getState().selectCheckout(null);
    });
  });
});

describe("menu commands", () => {
  it("runs the command main sends as command.run, once", async () => {
    const run = vi.fn();
    registerCommand("view.timeline", run);
    const seen: string[] = [];
    const onRun = (event: Event) => seen.push((event as CustomEvent<{ id: string }>).detail.id);
    window.addEventListener("treepeek:command", onRun);
    const uninstall = installMenuCommands();
    fake.emit("command.run", { id: "view.timeline" });
    expect(run).toHaveBeenCalledOnce();
    expect(seen).toEqual(["view.timeline"]);
    uninstall();
    window.removeEventListener("treepeek:command", onRun);
  });
});
