import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { validatePaths } from "../../../../src/core/handlers/paths";
import { resetGitRuntime, setTestGit } from "../../../support/core-git";
import { type Client, type Harness, harness } from "../../../support/core-session";
import { type Fixture, type FixtureRepo, fixture } from "../../../support/git-fixture";

let fx: Fixture;
let other: Fixture;
let app: FixtureRepo;
let otherApp: FixtureRepo;
const harnesses: Harness[] = [];

beforeAll(() => {
  setTestGit();
  fx = fixture();
  other = fixture();
  app = fx.repo("group/app").commit({ "src/a.txt": "a\n" });
  mkdirSync(fx.path("plain/sub"), { recursive: true });
  writeFileSync(fx.path("plain/loose.txt"), "not in a checkout\n");
  writeFileSync(fx.outsidePath("secret.txt"), "outside\n");
  symlinkSync(fx.outsidePath("secret.txt"), fx.path("group/app/escape"));
  symlinkSync(fx.outside, fx.path("group/app/escape-dir"));
  symlinkSync(fx.outsidePath("not-there-yet"), fx.path("group/app/dangling"));
  symlinkSync(fx.path("group/app/src/a.txt"), fx.path("group/app/inner-link"));
  otherApp = other.repo("other").commit({ "o.txt": "o\n" });
});
afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose();
});
afterAll(() => {
  fx.cleanup();
  other.cleanup();
  resetGitRuntime();
});

async function scanned(created: Harness, windowId: number, root: string): Promise<Client> {
  const { client } = created.open(windowId);
  await client.call("session.open", { scanRoots: [root] });
  await client.call("scan.start", { requestId: "s1" });
  await client.waitForEvent("scan.done");
  return client;
}

describe("paths.validate", () => {
  it("is true only for paths some session's scan holds", async () => {
    const created = harness();
    harnesses.push(created);
    await scanned(created, 1, fx.root);
    await scanned(created, 2, other.root);
    const cases: [string, boolean][] = [
      [fx.root, true],
      [fx.path("group"), true],
      [fx.path("plain/sub"), true],
      [app.path, true],
      [fx.path("group/app/src/a.txt"), true],
      [fx.path("group/app/src/deleted-or-new.txt"), true],
      [fx.path("group/app/inner-link"), true],
      [otherApp.path, true],
      // A file in a folder of the tree, but not inside a checkout.
      [fx.path("plain/loose.txt"), false],
      [fx.path("group/app/escape"), false],
      [fx.path("group/app/escape-dir"), false],
      [fx.path("group/app/escape-dir/secret.txt"), false],
      [fx.path("group/app/dangling"), false],
      [fx.path("group/app/../../plain/loose.txt"), false],
      [fx.path("group/app/../../../"), false],
      [fx.outsidePath("secret.txt"), false],
      ["group/app/src/a.txt", false],
      ["/", false],
    ];
    const valid = await validatePaths(
      created.registry.all(),
      cases.map(([path]) => path),
    );
    expect(cases.map(([path], index) => [path, valid[index]])).toEqual(cases);
  });

  it("is false for everything once the session that scanned it closes", async () => {
    const created = harness();
    harnesses.push(created);
    await scanned(created, 1, fx.root);
    expect(await validatePaths(created.registry.all(), [app.path])).toEqual([true]);
    created.registry.close(1);
    expect(await validatePaths(created.registry.all(), [app.path])).toEqual([false]);
  });
});
