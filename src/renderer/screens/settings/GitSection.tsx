import { useState } from "react";
import { Button } from "../../components/ui/button";
import { main } from "../../data/client";
import { useLatestEvent } from "../../data/events";
import { GIT_PROBLEMS, pickedGitMessage } from "../git-setup/GitSetup";
import { Field, FieldMessage, SectionTitle } from "./Field";
import { useSettings } from "./use-settings";

/**
 * Git: the git Treepeek runs (path and version, or why there is none), the person's own
 * choice of git, and Detect Again. A picked git that is too old is named here and not used.
 */
export function GitSection() {
  const { settings, save } = useSettings();
  const git = useLatestEvent("git.state");
  const [picked, setPicked] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [detecting, setDetecting] = useState(false);

  const choose = async () => {
    const result = await main().git.choose();
    if (!result.ok) setPicked({ text: result.error.message, tone: "error" });
    else if (result.value !== null) setPicked(pickedGitMessage(result.value));
  };

  return (
    <section aria-labelledby="settings-git" data-testid="settings-git">
      <SectionTitle id="settings-git">Git</SectionTitle>
      <Field label="Git in use" description="Treepeek runs the Git installed on this Mac.">
        <div aria-live="polite" data-testid="git-current">
          {git === null ? (
            <span className="text-muted-foreground">Looking for Git…</span>
          ) : git.found ? (
            <>
              <span className="font-medium">Git {git.version}</span>
              <span className="block break-all font-mono text-muted-foreground text-xs">
                {git.path}
              </span>
            </>
          ) : (
            <>
              <span className="text-destructive">{GIT_PROBLEMS[git.problem]}</span>
              {git.detail && (
                <span className="block break-words text-muted-foreground text-xs">
                  {git.detail}
                </span>
              )}
            </>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={detecting}
          onClick={async () => {
            setDetecting(true);
            setPicked(null);
            await main().git.detect();
            setDetecting(false);
          }}
          data-testid="git-detect-again"
        >
          Detect Again
        </Button>
      </Field>
      <Field
        label="Git program"
        description="Normally found on your login PATH, in Homebrew's folders, or from Apple's Command Line Tools. Choose one to use it instead."
      >
        <p className="break-all" data-testid="git-override">
          {settings?.gitPath ? (
            <span className="font-mono text-xs">{settings.gitPath}</span>
          ) : (
            <span className="text-muted-foreground">Found automatically</span>
          )}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void choose()}
            data-testid="git-choose"
          >
            Choose…
          </Button>
          {settings?.gitPath && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPicked(null);
                void save({ gitPath: null });
              }}
              data-testid="git-automatic"
            >
              Find Automatically
            </Button>
          )}
        </div>
        {picked && (
          <FieldMessage tone={picked.tone} testId="git-picked">
            {picked.text}
          </FieldMessage>
        )}
      </Field>
    </section>
  );
}
