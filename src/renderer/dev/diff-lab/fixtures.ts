/**
 * The lab's fixtures: the committed small ones, bundled into the lab build only, and the
 * large ones, which tests generate into `lab-fixtures/` next to the built page.
 */

import type { FileDiff } from "../../../shared/domain/diff";

const small = import.meta.glob<unknown>("../../../../tests/fixtures/diffs/*.json", {
  eager: true,
  import: "default",
});

export const SMALL_FIXTURES: ReadonlyMap<string, FileDiff> = new Map(
  Object.entries(small)
    .map(([path, value]): [string, FileDiff] => [fixtureName(path), checkFileDiff(value, path)])
    .sort(([a], [b]) => a.localeCompare(b)),
);

/** Names of the large fixtures next to the built page, or none when they were not made. */
export async function listLargeFixtures(): Promise<string[]> {
  try {
    const response = await fetch("lab-fixtures/index.json");
    if (!response.ok) return [];
    const names: unknown = await response.json();
    return Array.isArray(names) ? names.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}

export async function loadLargeFixture(name: string): Promise<FileDiff> {
  const response = await fetch(`lab-fixtures/${encodeURIComponent(name)}.json`);
  if (!response.ok) throw new Error(`No large fixture named ${name}`);
  return checkFileDiff(await response.json(), name);
}

function fixtureName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/, "");
}

/** A shallow shape check: fixtures come from our own script, but still cross a boundary. */
function checkFileDiff(value: unknown, source: string): FileDiff {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    Array.isArray((value as { hunks?: unknown }).hunks) &&
    typeof (value as { limits?: unknown }).limits === "object"
  ) {
    return value as FileDiff;
  }
  throw new Error(`${source} is not a FileDiff`);
}
