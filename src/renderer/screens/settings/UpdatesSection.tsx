import { SectionTitle } from "./Field";

/** Updates: filled in by the update work (a daily check with a badge, updates on your click). */
export function UpdatesSection() {
  return (
    <section aria-labelledby="settings-updates" data-testid="settings-updates">
      <SectionTitle id="settings-updates">Updates</SectionTitle>
      <p className="text-muted-foreground text-sm" data-testid="updates-placeholder">
        Update checks arrive with the first release: Treepeek will look for a new version once a day
        and show a badge, and nothing downloads or installs until you click Update.
      </p>
    </section>
  );
}
