import type { ScanProblem } from "../../../shared/domain/scan";
import { CopyCommand } from "../../components/CopyCommand";
import { relativePath } from "../../data/scan-model";

/** `path` as one shell word: single-quoted, with each `'` written as `'\''`. */
export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** The command that tells Git to trust a repository owned by someone else. */
export function safeDirectoryCommand(path: string): string {
  return `git config --global --add safe.directory ${shellQuote(path)}`;
}

/**
 * A repository Git refused to open because another user owns it (`dubiousOwnership`).
 * Git's `safe.directory` setting is the person's call: Treepeek explains it and shows the
 * command they could run, and never changes Git's configuration itself.
 */
export function DubiousOwnershipRow({
  problem,
  scanRoot,
}: {
  problem: ScanProblem;
  scanRoot: string;
}) {
  return (
    <li className="px-3 py-2" data-testid="dubious-ownership-row" data-path={problem.path}>
      <p className="font-medium text-foreground" title={problem.path}>
        {relativePath(scanRoot, problem.path)}
      </p>
      <p className="mt-0.5 text-muted-foreground">
        Git won't open this repository because it belongs to another user on this Mac. Git protects
        you this way from repositories someone else could have set up to run programs. If you trust
        it, you can tell Git so yourself by running:
      </p>
      <CopyCommand
        command={safeDirectoryCommand(problem.path)}
        label="the safe.directory command"
      />
      <p className="mt-1 text-muted-foreground">
        Treepeek never changes Git's settings. Rescan (⌘R) after running it.
      </p>
    </li>
  );
}
