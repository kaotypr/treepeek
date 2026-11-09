import { describe, expect, it } from "vitest";
import { buildTimeline, type TimelineInput } from "../../../../src/core/scan/timeline";

const at = (minute: number) => `2025-01-01T00:${String(minute).padStart(2, "0")}:00Z`;

function input(
  path: string,
  commonDir: string,
  start: { commit: string; minute: number } | null,
  head: string | null = `head-${path}`,
): TimelineInput {
  return {
    checkoutPath: `/root/${path}`,
    commonDir,
    relativePath: path,
    start: start
      ? { commit: start.commit, observedAt: at(start.minute), source: "reflog" }
      : { unknown: true },
    head,
  };
}

describe("buildTimeline", () => {
  it("orders by start, unknown starts last, ties by relative path, and numbers across the scan", async () => {
    const timeline = await buildTimeline(
      [
        input("z-unknown", "/r1", null),
        input("b", "/r2", { commit: "c2", minute: 5 }),
        input("a-unknown", "/r1", null),
        input("c", "/r1", { commit: "c1", minute: 1 }),
        input("a", "/r2", { commit: "c3", minute: 5 }),
      ],
      async () => false,
    );
    expect(timeline.map((entry) => [entry.sequence, entry.checkoutPath])).toEqual([
      [1, "/root/c"],
      [2, "/root/a"],
      [3, "/root/b"],
      [4, "/root/a-unknown"],
      [5, "/root/z-unknown"],
    ]);
  });

  it("takes the predecessor within the repository and asks whether its HEAD began this start", async () => {
    const asked: string[] = [];
    const timeline = await buildTimeline(
      [
        input("main", "/r1", { commit: "m0", minute: 1 }, "m1"),
        input("other", "/r2", { commit: "o0", minute: 2 }),
        input("wt1", "/r1", { commit: "m1", minute: 3 }, "w1"),
        input("wt2", "/r1", { commit: "x", minute: 4 }),
        input("lost", "/r1", null),
      ],
      async (commonDir, ancestor, descendant) => {
        asked.push(`${commonDir}:${ancestor}->${descendant}`);
        return ancestor === "m1" && descendant === "m1";
      },
    );
    const byPath = new Map(timeline.map((entry) => [entry.checkoutPath, entry]));
    expect(byPath.get("/root/main")).toMatchObject({ predecessor: null, relation: "first" });
    expect(byPath.get("/root/other")).toMatchObject({ predecessor: null, relation: "first" });
    expect(byPath.get("/root/wt1")).toMatchObject({
      predecessor: "/root/main",
      relation: "after",
    });
    expect(byPath.get("/root/wt2")).toMatchObject({
      predecessor: "/root/wt1",
      relation: "parallel",
    });
    // An unknown start cannot be `after` anything, so git is not asked.
    expect(byPath.get("/root/lost")).toMatchObject({
      predecessor: "/root/wt2",
      relation: "parallel",
    });
    expect(asked.sort()).toEqual(["/r1:m1->m1", "/r1:w1->x"]);
  });

  it("calls a checkout after a predecessor without commits parallel", async () => {
    const timeline = await buildTimeline(
      [input("empty", "/r1", null, null), input("wt", "/r1", { commit: "c", minute: 1 })],
      async () => true,
    );
    expect(timeline.map((entry) => entry.relation)).toEqual(["first", "parallel"]);
  });
});
