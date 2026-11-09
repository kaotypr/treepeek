import { runGit } from "../../../../../src/core/git/run";

/** Runs a catalogue command through the real wrapper and returns its stdout bytes. */
export async function git(cwd: string, args: readonly string[]): Promise<Buffer> {
  const output = await runGit(cwd, args, { signal: new AbortController().signal });
  return output.stdout;
}
