/**
 * Fails on Electronegativity findings that nobody has reviewed. Electronegativity reports and
 * exits 0 whatever it finds, so CI runs it with SARIF output and then this script:
 *
 *   bun ./build/check-electronegativity.ts <results.sarif> <scanned folder>
 *
 * A finding passes when `build/electronegativity-reviewed.json` lists its check and file with
 * a reason, and the file has no more instances of it than the review counted. Line numbers are
 * not compared, so unrelated edits to the file do not reopen a review.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Reviewed {
  check: string;
  file: string;
  count: number;
  reason: string;
}

const [sarifPath, scanned] = process.argv.slice(2);
if (!sarifPath || !scanned) {
  console.error("Usage: bun ./build/check-electronegativity.ts <results.sarif> <scanned folder>");
  process.exit(2);
}

const root = resolve(import.meta.dirname, "..");
const reviewed = loadReviewed(join(root, "build", "electronegativity-reviewed.json"));
const found = countFindings(readFileSync(sarifPath, "utf8"), scanned);

const unreviewed: string[] = [];
for (const [key, count] of found) {
  const [check, file] = JSON.parse(key) as [string, string];
  const entry = reviewed.find((item) => item.check === check && item.file === file);
  if (!entry) unreviewed.push(`  ${check}  ${file}  (${count})`);
  else if (count > entry.count) {
    unreviewed.push(`  ${check}  ${file}  (${count}; the review covered ${entry.count})`);
  }
}
const stale = reviewed.filter((item) => !found.has(JSON.stringify([item.check, item.file])));

console.log(`Electronegativity: ${[...found.values()].reduce((a, b) => a + b, 0)} findings.`);
if (stale.length > 0) {
  console.log("\nReviewed findings no longer reported (remove them from the review list):");
  for (const item of stale) console.log(`  ${item.check}  ${item.file}`);
}
if (unreviewed.length > 0) {
  console.error(
    "\nNot reviewed. Fix the code, or review the finding and add it with a reason to build/electronegativity-reviewed.json:",
  );
  for (const line of unreviewed) console.error(line);
  process.exit(1);
}
console.log("Every finding is reviewed.");

/** Findings per `[check, file]`, with files relative to the repository. */
function countFindings(text: string, folder: string): Map<string, number> {
  const sarif: unknown = JSON.parse(text);
  const runs = isRecord(sarif) && Array.isArray(sarif.runs) ? sarif.runs : null;
  if (!runs) throw new Error(`${sarifPath} is not a SARIF log`);
  const counts = new Map<string, number>();
  for (const run of runs) {
    const results = isRecord(run) && Array.isArray(run.results) ? run.results : [];
    for (const result of results) {
      if (!isRecord(result) || typeof result.ruleId !== "string") continue;
      const uri = firstUri(result.locations);
      const file = uri ? join(folder, decodeURIComponent(uri)).replaceAll("\\", "/") : "(none)";
      const key = JSON.stringify([result.ruleId, file]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function firstUri(locations: unknown): string | null {
  if (!Array.isArray(locations)) return null;
  const physical = isRecord(locations[0]) ? locations[0].physicalLocation : null;
  const artifact = isRecord(physical) ? physical.artifactLocation : null;
  return isRecord(artifact) && typeof artifact.uri === "string" ? artifact.uri : null;
}

function loadReviewed(file: string): Reviewed[] {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(raw) || !Array.isArray(raw.findings)) {
    throw new Error(`${file} needs a "findings" list`);
  }
  return raw.findings.map((entry, index): Reviewed => {
    if (
      !isRecord(entry) ||
      typeof entry.check !== "string" ||
      typeof entry.file !== "string" ||
      typeof entry.count !== "number" ||
      typeof entry.reason !== "string" ||
      entry.reason.trim() === ""
    ) {
      throw new Error(`${file}, findings[${index}] needs a check, a file, a count and a reason`);
    }
    return { check: entry.check, file: entry.file, count: entry.count, reason: entry.reason };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
