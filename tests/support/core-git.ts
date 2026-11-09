/**
 * Points the core service's git layer at the tests' git, with the isolated test
 * environment, so `runGit` can run in unit tests without discovery.
 */
import { gitEnv } from "../../src/core/git/env";
import { resetGitRuntime, setGitBinary } from "../../src/core/git/runtime";
import { gitTestEnv, testGitPath, testGitVersion } from "./git";

/** Makes `runGit` use the tests' git. Pass `extraEnv` to add variables after the table. */
export function useTestGit(extraEnv: Readonly<Record<string, string>> = {}): void {
  setGitBinary(
    { found: true, path: testGitPath(), version: testGitVersion() },
    { ...gitEnv(gitTestEnv()), ...extraEnv },
  );
}

/** Makes `runGit` run `path` (a fake git script) instead. */
export function useFakeGit(path: string): void {
  setGitBinary({ found: true, path, version: "2.99.0" }, gitEnv(gitTestEnv()));
}

export { resetGitRuntime };
