import type { GitProblem } from "../../shared/domain/git";

const PROBLEMS: Readonly<Record<GitProblem, string>> = {
  notFound: "Treepeek could not find Git on this Mac.",
  tooOld: "The Git on this Mac is too old for Treepeek.",
  xcodeMissing:
    "The only Git on this Mac is Apple's, which needs the Xcode Command Line Tools installed first.",
};

/**
 * Shown instead of the scan while no usable git is found. The full setup screen (choosing a
 * git, detecting again) arrives with the desktop integration.
 */
export function GitMissingNotice({ problem, detail }: { problem: GitProblem; detail?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8" data-testid="git-missing">
      <section className="max-w-md rounded-xl border border-border bg-card p-6 text-card-foreground">
        <h1 className="font-semibold text-lg">Git is needed</h1>
        <p className="mt-2 text-sm">{PROBLEMS[problem]}</p>
        <p className="mt-2 text-muted-foreground text-sm">
          Install Git 2.36 or later (for example with the Xcode Command Line Tools or Homebrew),
          then reopen this folder.
        </p>
        {detail && (
          <p className="mt-2 break-words font-mono text-muted-foreground text-xs">{detail}</p>
        )}
      </section>
    </div>
  );
}
