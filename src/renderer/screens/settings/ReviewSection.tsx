import { useId } from "react";
import type { ListableComparisonKind } from "../../../shared/domain/compare";
import { COMPARISON_HINTS, COMPARISON_LABELS } from "../../../shared/domain/comparison-hints";
import { DEFAULT_COMPARISON_KINDS } from "../../../shared/settings";
import { Field, SectionTitle, selectClass } from "./Field";
import { useSettings } from "./use-settings";

/** Review: the comparison a newly selected checkout starts on. */
export function ReviewSection() {
  const { settings, save } = useSettings();
  const id = useId();
  const current = settings?.defaultComparison ?? "review";
  return (
    <section aria-labelledby="settings-review" data-testid="settings-review">
      <SectionTitle id="settings-review">Review</SectionTitle>
      <Field
        label="Default comparison"
        labelFor={id}
        description="What a checkout shows when you select it. You can change it for each checkout with ⌘K."
      >
        <select
          id={id}
          className={selectClass}
          value={current}
          onChange={(event) =>
            void save({ defaultComparison: event.target.value as ListableComparisonKind })
          }
          data-testid="default-comparison"
        >
          {DEFAULT_COMPARISON_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {COMPARISON_LABELS[kind]}
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-muted-foreground text-xs">{COMPARISON_HINTS[current]}</p>
      </Field>
    </section>
  );
}
