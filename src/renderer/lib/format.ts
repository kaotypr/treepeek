/** Dates and short ids as the window shows them (the prototype's formats). */

/** `Nov 3, 10:02 AM`; the year only when it is not this year. */
export function compactDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** The full date and time, for tooltips. */
export function fullDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "medium" }).format(
    date,
  );
}

/** The first eight characters of a commit id. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 8);
}
