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
    repo.worktree("app-feature", { from: "main" }).commit({ "feature.txt": "f\n" });
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
      const opened = await window.treepeek.core.session.open({ scanRoot });
      const started = await window.treepeek.core.scan.start({ requestId: "e2e-scan" });
      order.push("result");
      const finished = await done;
      offCheckout();
      return {
        opened: opened.ok,
        started: started.ok ? { ok: true, root: started.value.scanRoot } : started,
        finished,
        order,
        checkouts,
      };
    }, fx.root);

    expect(result.opened).toBe(true);
    expect(result.started).toEqual({ ok: true, root: fx.root });
    expect(result.order).toEqual(["result", "scan.checkout", "scan.checkout", "scan.done"]);
    expect(result.checkouts.sort()).toEqual([fx.path("app"), fx.path("app-feature")].sort());
    expect(result.finished).toEqual({ sequences: [1, 2], names: ["app"] });
  });

  test("refuses a start override for a path outside the scan", async () => {
    const refused = await app.page.evaluate(
      (path) => window.treepeek.core.start.override({ checkoutPath: path, commit: null }),
      fx.outside,
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "notInScan" } });
  });
});
