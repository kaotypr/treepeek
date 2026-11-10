import { useId } from "react";
import { APPEARANCES, type Appearance } from "../../../shared/settings";
import { Switch } from "../../components/ui/switch";
import { Field, SectionTitle } from "./Field";
import { useChoice, useSettings } from "./use-settings";

const LABELS: Readonly<Record<Appearance, string>> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/** General: appearance, and whether windows come back on launch. */
export function GeneralSection() {
  const { settings, save } = useSettings();
  const name = useId();
  const restoreId = useId();
  const [appearance, setAppearance] = useChoice<Appearance | null>(settings?.appearance ?? null);
  const [restore, setRestore] = useChoice(settings?.restoreWindows ?? true);
  return (
    <section aria-labelledby="settings-general" data-testid="settings-general">
      <SectionTitle id="settings-general">General</SectionTitle>
      <Field label="Appearance" description="System follows macOS, including Auto at sunset.">
        <div role="radiogroup" aria-label="Appearance" className="flex gap-4">
          {APPEARANCES.map((candidate) => (
            <label key={candidate} className="flex items-center gap-1.5">
              <input
                type="radio"
                name={name}
                value={candidate}
                checked={appearance === candidate}
                onChange={() => {
                  setAppearance(candidate);
                  void save({ appearance: candidate });
                }}
                className="accent-primary-strong"
                data-testid={`appearance-${candidate}`}
              />
              {LABELS[candidate]}
            </label>
          ))}
        </div>
      </Field>
      <Field
        label="Restore windows"
        labelFor={restoreId}
        description="Reopen the folders that were open when Treepeek quit, with their layout."
      >
        <Switch
          id={restoreId}
          checked={restore}
          onCheckedChange={(checked) => {
            setRestore(checked);
            void save({ restoreWindows: checked });
          }}
          data-testid="restore-windows"
        />
      </Field>
    </section>
  );
}
