import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Checkout } from "../../../../src/shared/domain/scan";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { oldestReflog, tempStore } from "../../../support/core-scan";
import { type Client, type Harness, harness } from "../../../support/core-session";
import {
  type Fixture,
  type FixtureCheckout,
  type FixtureRepo,
  fixture,
} from "../../../support/git-fixture";

let fx: Fixture;
let app: FixtureRepo;
let feature: FixtureCheckout;
let stored: ReturnType<typeof tempStore>;
const harnesses: Harness[] = [];

function newHarness(): Harness {
  const created = harness(() => stored.store);
  harnesses.push(created);
  return created;
}

beforeAll(() => {
  setTestGit();
  fx = fixture();
  app = fx.repo("app").commit({ "a.txt": "1\n" }).commit({ "a.txt": "2\n" });
  feature = app.worktree("feature", { from: "main" });
  feature.commit({ "b.txt": "b\n" }).commit({ "c.txt": "c\n" });
  stored = tempStore();
});
afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose();
});
afterAll(() => {
  stored.dispose();
  fx.cleanup();
  resetGitRuntime();
});

/** Opens a session on the fixture and waits for its scan to finish. */
async function scanned(created: Harness, windowId = 1): Promise<Client> {
  const { client } = created.open(windowId);
  await client.call("session.open", { scanRoot: fx.root });
  await client.call("scan.start", { requestId: "s1" });
  await client.waitForEvent("scan.done");
  return client;
}

function override(client: Client, checkoutPath: string, commit: string | null) {
  return client.call<Checkout>("start.override", { checkoutPath, commit });
}

describe("start.override", () => {
  it("rejects a path outside the scan, or one that is not a checkout, with notInScan", async () => {
    const client = await scanned(newHarness());
    for (const path of [fx.outside, fx.path("feature/b.txt"), "/", fx.root]) {
      expect(await override(client, path, "main")).toMatchObject({
        ok: false,
        error: { code: "notInScan" },
      });
    }
  });

  it("returns refNotFound for something that is not a commit, and invalidRequest for an option", async () => {
    const client = await scanned(newHarness());
    const tree = app.rev("HEAD^{tree}");
    for (const commit of [tree, "no-such-branch", "0".repeat(40)]) {
      expect(await override(client, feature.path, commit)).toMatchObject({
        ok: false,
        error: { code: "refNotFound" },
      });
    }
    expect(await override(client, feature.path, "-x")).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
  });

  it("sets the start to a commit, recounts history, and clears back to the reflog start", async () => {
    const client = await scanned(newHarness());
    const base = app.rev("main~1");
    const set = await override(client, feature.path, "main~1");
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.value.start).toMatchObject({ commit: base, source: "override" });
    expect(set.value.history).toEqual({ commits: 3, files: 3 });

    const cleared = await override(client, feature.path, null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.value.start).toEqual({ ...oldestReflog(feature.path), source: "reflog" });
    expect(cleared.value.history).toEqual({ commits: 2, files: 2 });
  });

  it("keeps the override after the store closes and opens again, as after a restart", async () => {
    const first = newHarness();
    const client = await scanned(first);
    const base = app.rev("main~1");
    expect(await override(client, feature.path, base)).toMatchObject({ ok: true });
    first.dispose();
    stored.reopen();

    const restarted = await scanned(newHarness(), 2);
    const found = restarted
      .events<Checkout>("scan.checkout")
      .find((checkout) => checkout.path === feature.path);
    expect(found?.start).toMatchObject({ commit: base, source: "override" });

    await override(restarted, feature.path, null);
  });

  it("fails internal, without changing anything, when there is no store", async () => {
    const created = harness(() => null);
    harnesses.push(created);
    const client = await scanned(created);
    expect(await override(client, feature.path, "main")).toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
  });
});
