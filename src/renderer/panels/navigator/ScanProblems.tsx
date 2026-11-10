import { useScan, useScanContext } from "../../data/hooks/useScan";
import { quantity, relativePath } from "../../data/scan-model";
import { DubiousOwnershipRow } from "./DubiousOwnershipRow";

/**
 * Folders the scan found but could not read as checkouts, each with the reason: Git's
 * `safe.directory` refusal gets its own explanation, anything else its message.
 */
export function ScanProblems() {
  const { scanRoot } = useScanContext();
  const problems = useScan((scan) => (scan.phase === "done" ? scan.problems : []));
  if (problems.length === 0) return null;
  return (
    <details
      open
      className="max-h-[40%] shrink-0 overflow-auto border-border border-y text-xs"
      data-testid="scan-problems"
    >
      <summary className="cursor-default px-3 py-1.5 font-medium text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {quantity(problems.length, "folder")} could not be read
      </summary>
      <ul className="divide-y divide-border">
        {problems.map((problem) =>
          problem.code === "dubiousOwnership" ? (
            <DubiousOwnershipRow key={problem.path} problem={problem} scanRoot={scanRoot} />
          ) : (
            <li key={problem.path} className="px-3 py-2" data-testid="scan-problem-row">
              <p className="font-medium text-foreground" title={problem.path}>
                {relativePath(scanRoot, problem.path)}
              </p>
              <p className="mt-0.5 text-muted-foreground">{problem.message}</p>
            </li>
          ),
        )}
      </ul>
    </details>
  );
}
