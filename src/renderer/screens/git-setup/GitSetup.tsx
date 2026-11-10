import { useEffect, useState } from "react";
import {
  formatGitVersion,
  type GitProblem,
  type GitState,
  MIN_GIT_VERSION,
} from "../../../shared/domain/git";
import { CopyCommand } from "../../components/CopyCommand";
import { Button } from "../../components/ui/button";
import { main } from "../../data/client";

const MINIMUM = formatGitVersion(MIN_GIT_VERSION);

export const GIT_PROBLEMS: Readonly<Record<GitProblem, string>> = {
  notFound: "Treepeek could not find Git on this Mac.",
  tooOld: `The Git on this Mac is too old for Treepeek, which needs Git ${MINIMUM} or later.`,
  xcodeMissing:
    "The only Git on this Mac is Apple's, which needs the Xcode Command Line Tools installed first.",
};

/** What picking a git found, said where it was picked. */
export function pickedGitMessage(picked: { path: string; state: GitState }): {
  text: string;
  tone: "ok" | "error";
} {
  const { state } = picked;
  if (state.found) return { text: `Using Git ${state.version} at ${state.path}.`, tone: "ok" };
  if (state.problem === "tooOld") {
    return {
      text: state.detail ?? `That Git is older than ${MINIMUM}, the oldest Treepeek supports.`,
      tone: "error",
    };
  }
  return { text: state.detail ?? GIT_PROBLEMS[state.problem], tone: "error" };
}

/**
 * Shown instead of the scan while no usable git is found (git-service design, "Finding
 * git"): why, how to install Git, picking a git binary, and Try again. Treepeek installs
 * nothing itself; the commands are for the person to run.
 */
export function GitSetup({ state }: { state: Extract<GitState, { found: false }> }) {
  const [checking, setChecking] = useState(false);
  const [picked, setPicked] = useState<{ text: string; tone: "ok" | "error" } | null>(null);

  // Every discovery answers with a fresh `git.state`, found or not.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new state ends the check
  useEffect(() => setChecking(false), [state]);

  const tryAgain = async () => {
    setChecking(true);
    setPicked(null);
    const result = await main().git.detect();
    if (!result.ok) setChecking(false);
  };

  const choose = async () => {
    const result = await main().git.choose();
    if (!result.ok) {
      setPicked({ text: result.error.message, tone: "error" });
      return;
    }
    if (result.value === null) return;
    setPicked(pickedGitMessage(result.value));
  };

  return (
    <div
      className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-8"
      data-testid="git-setup"
    >
      <section
        aria-labelledby="git-setup-title"
        className="w-full max-w-lg rounded-xl border border-border bg-card p-6 text-card-foreground text-sm"
      >
        <h1 id="git-setup-title" className="font-semibold text-lg">
          Treepeek needs Git
        </h1>
        <p className="mt-2" data-testid="git-setup-problem">
          {GIT_PROBLEMS[state.problem]}
        </p>
        {state.detail && (
          <p className="mt-1 break-words font-mono text-muted-foreground text-xs">{state.detail}</p>
        )}

        <h2 className="mt-5 font-medium">Install Git</h2>
        <p className="mt-1 text-muted-foreground">
          Install Apple's Command Line Tools, which include Git:
        </p>
        <CopyCommand command="xcode-select --install" label="the Command Line Tools command" />
        <p className="mt-3 text-muted-foreground">
          Or, with <span className="font-medium text-foreground">Homebrew</span> installed:
        </p>
        <CopyCommand command="brew install git" label="the Homebrew command" />

        <h2 className="mt-5 font-medium">Already have Git somewhere else?</h2>
        <p className="mt-1 text-muted-foreground">
          Choose the git program, for example{" "}
          <code className="font-mono">/opt/homebrew/bin/git</code>.
        </p>

        {picked && (
          <p
            role={picked.tone === "error" ? "alert" : "status"}
            className={picked.tone === "error" ? "mt-3 text-destructive" : "mt-3"}
            data-testid="git-setup-picked"
          >
            {picked.text}
          </p>
        )}

        <div className="mt-5 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void choose()}
            data-testid="git-choose"
          >
            Choose Git…
          </Button>
          <Button
            size="sm"
            onClick={() => void tryAgain()}
            disabled={checking}
            data-testid="git-try-again"
          >
            {checking ? "Looking for Git…" : "Try Again"}
          </Button>
        </div>
      </section>
    </div>
  );
}
