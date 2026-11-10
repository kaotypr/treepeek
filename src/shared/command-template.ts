/**
 * Custom "Open in…" commands (Settings › Integrations) are written like a command line:
 * `myeditor --line {line} {path}`. They never run through a shell. This splits one into
 * words first; `main/open-in/template.ts` then substitutes `{path}` and `{line}` inside
 * each word, so whatever a path contains (spaces, quotes, `;`, `$(…)`) stays one argument.
 *
 * Quoting follows the shell's familiar rules, without any expansion:
 *
 * - whitespace separates words;
 * - `'…'` keeps everything inside literally;
 * - `"…"` keeps whitespace, and `\"` and `\\` stand for `"` and `\`;
 * - outside quotes, `\` keeps the next character literally.
 */

export class CommandTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandTemplateError";
  }
}

export function splitCommandTemplate(template: string): string[] {
  const words: string[] = [];
  let word = "";
  /** A word has started, even an empty one written as `''`. */
  let started = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < template.length; index += 1) {
    const char = template[index] as string;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && (template[index + 1] === '"' || template[index + 1] === "\\")) {
        word += template[index + 1];
        index += 1;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      const next = template[index + 1];
      if (next === undefined) throw new CommandTemplateError("The command ends with a backslash.");
      word += next;
      started = true;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    word += char;
    started = true;
  }
  if (quote !== null) throw new CommandTemplateError(`The command has an unclosed ${quote}.`);
  if (started) words.push(word);
  if (words.length === 0 || words[0] === "") {
    throw new CommandTemplateError("The command names no program.");
  }
  return words;
}

/** Why a template cannot be used, or `null` when it can. */
export function commandTemplateProblem(template: string): string | null {
  try {
    splitCommandTemplate(template);
    return null;
  } catch (error) {
    return error instanceof CommandTemplateError ? error.message : "The command cannot be read.";
  }
}
