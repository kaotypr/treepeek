/**
 * The Shiki grammars and color themes Treepeek does not ship. `@pierre/diffs` bundles every
 * grammar and theme Shiki has; these are under licenses Treepeek may not redistribute (GPL),
 * or no license could be confirmed upstream. The rest were reviewed and are recorded in
 * `build/license-allowlist.json`.
 *
 * This list is the one place that decides it:
 * - the build replaces every import of these with an empty module, so their content never
 *   reaches `out/renderer` (`electron.vite.config.ts`, `excludeShikiAssets`);
 * - the license tooling leaves them out of the shipped set and the notices
 *   (`build/licenses.ts`);
 * - a file in one of these languages is shown as plain text (`isExcludedGrammar`, used by
 *   `pierre/to-pierre.ts`).
 *
 * The names are Shiki's language and theme ids, which are also their module names in
 * `@shikijs/langs` and `@shikijs/themes`. None of these languages has an alias.
 */

export interface ExcludedAsset {
  readonly name: string;
  /** Why it is left out: the upstream license, or what was missing. */
  readonly reason: string;
}

export const EXCLUDED_GRAMMARS: readonly ExcludedAsset[] = Object.freeze([
  { name: "ada", reason: "GPL-3.0 (AdaCore/ada_language_server)" },
  { name: "ahk2", reason: "LGPL-3.0 (thqby/vscode-autohotkey2-lsp)" },
  { name: "gnuplot", reason: "GPL-3.0 (MarioSchwalbe/vscode-gnuplot)" },
  { name: "nginx", reason: "GPL-3.0 (hangxingliu/vscode-nginx-conf-hint)" },
  { name: "org", reason: "GPL-3.0 (vscode-org-mode/vscode-org-mode)" },
  { name: "racket", reason: "GPL-3.0 (Eugleo/magic-racket)" },
  { name: "apl", reason: "no license in kimmolinna/vscode-apl-language" },
  { name: "dax", reason: "no license in huyza/dax-language" },
  { name: "dream-maker", reason: "no license in gbasood/vscode-atomic-dreams" },
  { name: "glsl", reason: "no license in polym0rph/GLSL.tmbundle" },
  { name: "hurl", reason: "nikeee/language-hurl names MIT but carries no license text" },
  { name: "rel", reason: "relationalai-oss/rel_vscode names MIT but carries no license text" },
  { name: "tcl", reason: "no license in sleutho/tcl" },
]);

export const EXCLUDED_THEMES: readonly ExcludedAsset[] = Object.freeze([
  { name: "aurora-x", reason: "GPL-3.0 (marqu3ss/Aurora-X)" },
]);

const excludedGrammarNames = new Set(EXCLUDED_GRAMMARS.map((asset) => asset.name));

/** Whether `language` is a grammar the app does not ship, so its files show as plain text. */
export function isExcludedGrammar(language: string): boolean {
  return excludedGrammarNames.has(language);
}
