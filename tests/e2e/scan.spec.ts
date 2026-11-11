import { expect, test } from "@playwright/test";
import { type Fixture, fixture } from "../support/git-fixture";
import { type App, launchApp, target } from "./support/app";

/**
 * A window scans a folder over its port to the core service: the scan.start result comes
 * first, then each checkout as a scan.checkout event, then scan.done.
 */
test.describe(`scan (${target})`, () => {
  let app: App;
  let fx: Fixture;

  test.beforeAll(async () => {
    fx = fixture();
    const repo = fx.repo("app").commit({ "README.md": "hello\n" });
    repo
      .worktree("app-feature", { from: "main" })
      .commit({ "feature.txt": "f\n" })
      .write({ "notes.txt": "uncommitted\n" });
    app = await launchApp();
  });

  test.afterAll(async () => {
    await app?.close();
    fx?.cleanup();
  });

  test("opens a session on a folder and streams its scan in order", async () => {
    const result = await app.page.evaluate(async (scanRoot) => {
      const order: string[] = [];
      const checkouts: string[] = [];
      const offCheckout = window.treepeek.on("scan.checkout", (checkout) => {
        order.push("scan.checkout");
        checkouts.push(checkout.path);
      });
      const done = new Promise<{ sequences: number[]; names: string[] }>((resolve) => {
        const offDone = window.treepeek.on("scan.done", (payload) => {
          order.push("scan.done");
          offDone();
          resolve({
            sequences: payload.timeline.map((entry) => entry.sequence),
            names: payload.repositories.map((repo) => repo.displayName),
          });
        });
      });
      const opened = await window.treepeek.core.session.open({ scanRoots: [scanRoot] });
      const started = await window.treepeek.core.scan.start({ requestId: "e2e-scan" });
      order.push("result");
      const finished = await done;
      offCheckout();
      return {
        opened: opened.ok,
        started: started.ok
          ? { ok: true, roots: started.value.roots.map((root) => root.path) }
          : started,
        finished,
        order,
        checkouts,
      };
    }, fx.root);

    expect(result.opened).toBe(true);
    expect(result.started).toEqual({ ok: true, roots: [fx.root] });
    expect(result.order).toEqual(["result", "scan.checkout", "scan.checkout", "scan.done"]);
    expect(result.checkouts.sort()).toEqual([fx.path("app"), fx.path("app-feature")].sort());
    expect(result.finished).toEqual({ sequences: [1, 2], names: ["app"] });
  });

  test("lists a checkout's review comparison over the port", async () => {
    const listed = await app.page.evaluate(
      (checkoutPath) => window.treepeek.core.comparison.list({ checkoutPath, kind: "review" }),
      fx.path("app-feature"),
    );
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.comparison).toMatchObject({
      kind: "review",
      right: { kind: "workingTree" },
    });
    expect(listed.value.files.map((file) => [file.path, file.status])).toEqual([
      ["feature.txt", "added"],
      ["notes.txt", "untracked"],
    ]);
    expect(listed.value.commits).toBe(1);
  });

  test("sends a file's diff over the port", async () => {
    const diffed = await app.page.evaluate(
      (checkoutPath) =>
        window.treepeek.core.diff.file({
          requestId: "e2e-diff",
          checkoutPath,
          comparison: { kind: "review" },
          path: "notes.txt",
        }),
      fx.path("app-feature"),
    );
    expect(diffed).toMatchObject({
      ok: true,
      value: {
        path: "notes.txt",
        status: "untracked",
        binary: false,
        left: "",
        right: "uncommitted\n",
        stats: { added: 1, removed: 0 },
        limits: { patchTruncated: false, contentOmitted: false, highlightOff: false },
      },
    });
    if (!diffed.ok) return;
    expect(diffed.value.hunks).toEqual([
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        header: "@@ -0,0 +1 @@",
        lines: [{ kind: "add", text: "uncommitted", oldNo: null, newNo: 1 }],
      },
    ]);
    const committed = await app.page.evaluate(
      (checkoutPath) =>
        window.treepeek.core.diff.file({
          requestId: "e2e-diff-2",
          checkoutPath,
          comparison: { kind: "worktree" },
          path: "feature.txt",
        }),
      fx.path("app-feature"),
    );
    expect(committed).toMatchObject({
      ok: true,
      value: { path: "feature.txt", status: "added", left: "", right: "f\n" },
    });
  });

  test("refuses a diff for a path outside the scan or the checkout", async () => {
    const refused = await app.page.evaluate(
      ({ outside, checkout }) =>
        Promise.all([
          window.treepeek.core.diff.file({
            requestId: "e2e-diff-outside",
            checkoutPath: outside,
            comparison: { kind: "review" },
            path: "secret.txt",
          }),
          window.treepeek.core.diff.file({
            requestId: "e2e-diff-up",
            checkoutPath: checkout,
            comparison: { kind: "review" },
            path: "../app/README.md",
          }),
        ]),
      { outside: fx.outside, checkout: fx.path("app-feature") },
    );
    expect(refused).toMatchObject([
      { ok: false, error: { code: "notInScan" } },
      { ok: false, error: { code: "notInScan" } },
    ]);
  });

  test("refuses a comparison for a path outside the scan", async () => {
    const refused = await app.page.evaluate(
      (checkoutPath) => window.treepeek.core.comparison.list({ checkoutPath, kind: "working" }),
      fx.outside,
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "notInScan" } });
  });

  test("refuses a start override for a path outside the scan", async () => {
    const refused = await app.page.evaluate(
      (path) => window.treepeek.core.start.override({ checkoutPath: path, commit: null }),
      fx.outside,
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "notInScan" } });
  });
});
