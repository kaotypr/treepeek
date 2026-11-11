import { describe, expect, it } from "vitest";
import { RepoCache } from "../../../../src/core/cache/repo-cache";
import type { RepositoryResources } from "../../../../src/core/cache/shared-state";
import {
  containedNote,
  isIpcError,
  resolveSides,
  type SidesContext,
} from "../../../../src/core/compare/kinds";
import { CatFileBatch } from "../../../../src/core/git/cat-file";
import type { ScannedCheckout } from "../../../../src/core/scan/resolve-checkout";
import type { Checkout } from "../../../../src/shared/domain/scan";

/**
 * The kinds' availability rules that need no git: a checkout's state alone decides them.
 * The repository resources are never used on these paths (no process starts).
 */

const A = "a".repeat(40);
const B = "b".repeat(40);

function scanned(overrides: Partial<Checkout>): ScannedCheckout {
  return {
    checkout: {
      path: "/nowhere/app",
      kind: "linked",
      location: "inside",
      locked: false,
      branch: "topic",
      head: B,
      upstream: null,
      originUrl: null,
      start: { commit: A, observedAt: "2025-01-01T00:00:00Z", source: "reflog" },
      working: { staged: 0, unstaged: 0, untracked: 0 },
      history: { commits: 1, files: 1 },
      ...overrides,
    },
    commonDir: "/nowhere/app/.git",
    gitDir: "/nowhere/app/.git/worktrees/app",
    worktreeId: "id",
    reflogStart: null,
  };
}

function context(checkout: ScannedCheckout, predecessor?: ScannedCheckout | null): SidesContext {
  const repo: RepositoryResources = {
    commonDir: checkout.commonDir,
    cache: new RepoCache(checkout.commonDir),
    catFile: new CatFileBatch(checkout.commonDir),
  };
  return { checkout, predecessor, repo, signal: new AbortController().signal };
}

describe("resolveSides without git", () => {
  it("compares HEAD with the working tree for working, or nothing without commits", async () => {
    expect(await resolveSides({ kind: "working" }, context(scanned({})))).toEqual({
      comparison: {
        kind: "working",
        left: { kind: "commit", oid: B },
        right: { kind: "workingTree" },
      },
    });
    const unborn = scanned({ head: null, start: { unknown: true }, history: null });
    expect(await resolveSides({ kind: "working" }, context(unborn))).toMatchObject({
      comparison: { left: { kind: "empty" } },
    });
  });

  it("falls back to HEAD for review without a start, and to nothing without commits", async () => {
    const noStart = scanned({ start: { unknown: true }, history: null });
    expect(await resolveSides({ kind: "review" }, context(noStart))).toEqual({
      comparison: {
        kind: "review",
        left: { kind: "commit", oid: B },
        right: { kind: "workingTree" },
      },
      counted: { left: B, right: B },
      note: expect.stringMatching(/only uncommitted changes/),
    });
    const unborn = scanned({ head: null, start: { unknown: true }, history: null });
    expect(await resolveSides({ kind: "review" }, context(unborn))).toEqual({
      comparison: { kind: "review", left: { kind: "empty" }, right: { kind: "workingTree" } },
      note: expect.stringMatching(/no commits yet/),
    });
    expect(await resolveSides({ kind: "review" }, context(scanned({})))).toEqual({
      comparison: {
        kind: "review",
        left: { kind: "commit", oid: A },
        right: { kind: "workingTree" },
      },
      counted: { left: A, right: B },
      containedIn: A,
    });
  });

  it("names why a kind is unavailable", async () => {
    const cases: [Parameters<typeof resolveSides>[0], SidesContext, string, string][] = [
      [{ kind: "worktree" }, context(scanned({ head: null })), "refNotFound", "noHead"],
      [{ kind: "base", ref: "main" }, context(scanned({ head: null })), "refNotFound", "noHead"],
      [
        { kind: "worktree" },
        context(scanned({ start: { unknown: true } })),
        "refNotFound",
        "noStart",
      ],
      [
        { kind: "sincePrevious" },
        context(scanned({ start: { unknown: true } }), null),
        "refNotFound",
        "noStart",
      ],
      [{ kind: "incoming" }, context(scanned({}), undefined), "refNotFound", "noTimeline"],
      [{ kind: "incoming" }, context(scanned({}), null), "refNotFound", "notAfter"],
      [
        { kind: "sincePrevious" },
        context(scanned({}), scanned({ path: "/nowhere/main", head: null })),
        "refNotFound",
        "notAfter",
      ],
      [{ kind: "upstream" }, context(scanned({})), "refNotFound", "noUpstream"],
      [{ kind: "base" }, context(scanned({})), "invalidRequest", "noRef"],
    ];
    for (const [request, ctx, code, reason] of cases) {
      const result = await resolveSides(request, ctx);
      expect(isIpcError(result), `${request.kind} ${reason}`).toBe(true);
      expect(result, `${request.kind} ${reason}`).toMatchObject({
        code,
        detail: { unavailable: reason },
      });
    }
  });

  it("notes containment only for kinds that compare with another ref", () => {
    expect(containedNote("base")).toBe("HEAD is contained in the selected ref");
    expect(containedNote("upstream")).toBeDefined();
    expect(containedNote("incoming")).toBeDefined();
    expect(containedNote("sincePrevious")).toBeDefined();
    expect(containedNote("review")).toBeUndefined();
    expect(containedNote("worktree")).toBeUndefined();
    expect(containedNote("working")).toBeUndefined();
  });
});
