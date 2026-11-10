import type { ReactNode } from "react";

/** One setting: its name and explanation on the left, its control on the right. */
export function Field({
  label,
  labelFor,
  description,
  children,
}: {
  label: string;
  /** The id of the control the label names, when it is a single form control. */
  labelFor?: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)] gap-x-6 gap-y-1 border-border border-b py-4 last:border-b-0">
      <div>
        {labelFor ? (
          <label htmlFor={labelFor} className="font-medium text-sm">
            {label}
          </label>
        ) : (
          <p className="font-medium text-sm">{label}</p>
        )}
        {description && <p className="mt-0.5 text-muted-foreground text-xs">{description}</p>}
      </div>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  );
}

export function SectionTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="mb-2 font-semibold text-lg">
      {children}
    </h2>
  );
}

/** A message under a control: what went wrong, or what just happened. */
export function FieldMessage({
  tone,
  children,
  testId,
}: {
  tone: "error" | "ok";
  children: ReactNode;
  testId?: string;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={tone === "error" ? "mt-1.5 text-destructive text-xs" : "mt-1.5 text-xs"}
      data-testid={testId}
    >
      {children}
    </p>
  );
}

export const selectClass =
  "h-8 w-full max-w-sm rounded-md border border-input bg-card px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
