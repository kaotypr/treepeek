import { useState } from "react";
import { Button } from "../../components/ui/button";
import { main } from "../../data/client";
import { Field, FieldMessage, SectionTitle } from "./Field";

/** Advanced: the logs folder. */
export function AdvancedSection() {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <section aria-labelledby="settings-advanced" data-testid="settings-advanced">
      <SectionTitle id="settings-advanced">Advanced</SectionTitle>
      <Field
        label="Logs"
        description="What Treepeek did, for troubleshooting. Logs name repository paths, never file contents."
      >
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const result = await main().logs.open();
            setProblem(result.ok ? null : result.error.message);
          }}
          data-testid="open-logs"
        >
          Open Logs Folder
        </Button>
        {problem && <FieldMessage tone="error">{problem}</FieldMessage>}
      </Field>
    </section>
  );
}
