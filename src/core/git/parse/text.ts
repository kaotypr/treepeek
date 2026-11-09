const decoder = new TextDecoder("utf-8");

/** Git output as text. Parsers take the bytes `runGit` returns, or a string. */
export function toText(output: string | Uint8Array): string {
  return typeof output === "string" ? output : decoder.decode(output);
}

/**
 * Splits `-z` output into its NUL-terminated fields. Every field must be terminated, so
 * output cut short is noticed instead of read as a shorter list. Returns `null` when it is.
 */
export function nulFields(text: string): string[] | null {
  if (text === "") return [];
  if (!text.endsWith("\0")) return null;
  return text.slice(0, -1).split("\0");
}
