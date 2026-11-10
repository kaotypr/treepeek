import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useState } from "react";
import type { DetectedApp } from "../../../shared/ipc/contract";
import type { AppChoice } from "../../../shared/settings";
import { Button } from "../../components/ui/button";
import { main, unwrap } from "../../data/client";
import { Field, FieldMessage, SectionTitle, selectClass } from "./Field";
import { useSettings } from "./use-settings";

const INTEGRATIONS_KEY = ["integrations"] as const;

const CUSTOM_EXAMPLE = {
  editor: "myeditor --line {line} {path}",
  terminal: "open -na Alacritty --args --working-directory {path}",
} as const;

/** Integrations: the editor and terminal "Open in…" uses, detected or a custom command. */
export function IntegrationsSection() {
  const queryClient = useQueryClient();
  const { settings, save } = useSettings();
  const detected = useQuery({
    queryKey: INTEGRATIONS_KEY,
    queryFn: async () => unwrap(await main().integrations.detect({})),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [detecting, setDetecting] = useState(false);
  const detectAgain = async () => {
    setDetecting(true);
    const result = await main().integrations.detect({ refresh: true });
    setDetecting(false);
    if (result.ok) queryClient.setQueryData(INTEGRATIONS_KEY, result.value);
  };
  const editors = detected.data?.editors ?? [];
  const terminals = detected.data?.terminals ?? [];

  return (
    <section aria-labelledby="settings-integrations" data-testid="settings-integrations">
      <SectionTitle id="settings-integrations">Integrations</SectionTitle>
      {settings && (
        <>
          <AppChoiceField
            kind="editor"
            label="Editor"
            description={
              <>
                Open in Editor (⌘E). Opens the selected file at its first changed line where the
                editor supports it. A custom command takes <code>{"{path}"}</code> and{" "}
                <code>{"{line}"}</code> and runs without a shell.
              </>
            }
            value={settings.editor}
            apps={editors}
            automatic={editors[0] ? `Automatic (${editors[0].name})` : "Automatic"}
            onSave={(editor) => save({ editor })}
          />
          <AppChoiceField
            kind="terminal"
            label="Terminal"
            description={
              <>
                Open in Terminal (⌘⇧E), at the checkout folder. A custom command takes{" "}
                <code>{"{path}"}</code> and runs without a shell.
              </>
            }
            value={settings.terminal}
            apps={terminals}
            automatic="Automatic (Terminal)"
            onSave={(terminal) => save({ terminal })}
          />
        </>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={detecting}
          onClick={() => void detectAgain()}
          data-testid="detect-apps"
        >
          {detecting ? "Detecting…" : "Detect Apps Again"}
        </Button>
        <p className="text-muted-foreground text-xs">
          Found by bundle id with Spotlight, or in the Applications folders.
        </p>
      </div>
    </section>
  );
}

function choiceValue(choice: AppChoice): string {
  return choice.kind === "app" ? `app:${choice.bundleId}` : choice.kind;
}

function AppChoiceField({
  kind,
  label,
  description,
  value,
  apps,
  automatic,
  onSave,
}: {
  kind: "editor" | "terminal";
  label: string;
  description: ReactNode;
  value: AppChoice;
  apps: readonly DetectedApp[];
  automatic: string;
  onSave: (choice: AppChoice) => Promise<string | null>;
}) {
  const id = useId();
  const commandId = useId();
  const [selected, setSelected] = useState(choiceValue(value));
  const [draft, setDraft] = useState(value.kind === "custom" ? value.command : "");
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSelected(choiceValue(value));
    if (value.kind === "custom") setDraft(value.command);
  }, [value]);

  const missing =
    value.kind === "app" && !apps.some((app) => app.bundleId === value.bundleId)
      ? value.bundleId
      : null;

  const choose = async (next: string) => {
    setSelected(next);
    setProblem(null);
    setSaved(false);
    if (next === "custom") {
      if (draft === "") setDraft(CUSTOM_EXAMPLE[kind]);
      return;
    }
    const choice: AppChoice =
      next === "auto" ? { kind: "auto" } : { kind: "app", bundleId: next.slice("app:".length) };
    setProblem(await onSave(choice));
  };

  const saveCommand = async () => {
    const message = await onSave({ kind: "custom", command: draft });
    setProblem(message);
    setSaved(message === null);
  };

  return (
    <Field label={label} labelFor={id} description={description}>
      <select
        id={id}
        className={selectClass}
        value={selected}
        onChange={(event) => void choose(event.target.value)}
        data-testid={`${kind}-choice`}
      >
        <option value="auto">{automatic}</option>
        {apps.map((app) => (
          <option key={app.bundleId} value={`app:${app.bundleId}`}>
            {app.name}
          </option>
        ))}
        {missing && <option value={`app:${missing}`}>{missing} (not found)</option>}
        <option value="custom">Custom command…</option>
      </select>
      {selected === "custom" && (
        <form
          className="mt-2 flex max-w-sm gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void saveCommand();
          }}
        >
          <label htmlFor={commandId} className="sr-only">
            Custom {kind} command
          </label>
          <input
            id={commandId}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
            spellCheck={false}
            autoComplete="off"
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-card px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`${kind}-command`}
          />
          <Button type="submit" size="sm" data-testid={`${kind}-command-save`}>
            Save
          </Button>
        </form>
      )}
      {problem && (
        <FieldMessage tone="error" testId={`${kind}-problem`}>
          {problem}
        </FieldMessage>
      )}
      {saved && !problem && (
        <FieldMessage tone="ok" testId={`${kind}-saved`}>
          Saved.
        </FieldMessage>
      )}
    </Field>
  );
}
