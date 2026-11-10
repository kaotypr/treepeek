import { splitCommandTemplate } from "../../shared/command-template";

export interface TemplateVars {
  /** The file or folder to open. */
  path: string;
  /** The line to open at; `1` stands in when there is none. */
  line?: number;
}

/**
 * A custom command's argument array: the template is split into words first
 * (`splitCommandTemplate`), then `{path}` and `{line}` are substituted inside each word.
 * The first element is the program. Nothing is ever handed to a shell, so a path holding
 * spaces, quotes or `;` is exactly one argument and is never parsed.
 */
export function expandTemplate(template: string, vars: TemplateVars): string[] {
  const line = String(vars.line ?? 1);
  return splitCommandTemplate(template).map((word) =>
    word.replaceAll("{path}", vars.path).replaceAll("{line}", line),
  );
}

/** A program to run and its arguments. */
export interface Launch {
  command: string;
  args: string[];
}

/** `expandTemplate` as a `Launch`. */
export function templateLaunch(template: string, vars: TemplateVars): Launch {
  const [command, ...args] = expandTemplate(template, vars);
  return { command: command as string, args };
}
