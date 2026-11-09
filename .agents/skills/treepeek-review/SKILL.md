---

name: treepeek-review
description: Review a Treepeek change (a branch, a pull request, or uncommitted work) the way a principal engineer would - risks first, every finding verified against the code, read-only. Use when asked to review, audit or check a Treepeek diff before it merges.
---

# Review a Treepeek change

Review like the engineer who will be paged when this breaks. Look for what can hurt users
or the codebase - security holes, wrong results, crashes, leaks, contract drift, missing
tests - and leave style to the tools. A small number of findings you have proven beats a
long list of guesses.

`AGENTS.md` at the repository root is the standard. A change that breaks a rule there is
a finding; a rule that turns out to be wrong is also a finding, against `AGENTS.md`.

## Ground rules

- **Read-only.** Do not edit, format, stage or commit anything. You may run the repository's
  checks (`bun run lint`, `typecheck`, `test`, `build`, `test:e2e`); they do not change
  tracked files.
- **Independence.** If you wrote or changed this code in the current session, say at the
  top of the report that the review is not independent.
- **Report on the diff, research the whole codebase.** Findings are about what the change
  introduces or breaks. Read callers, callees, schemas and tests anywhere in the repository
  before deciding something is a problem.
- **Prove it.** Every finding names the file and line, quotes the code, and states the
  concrete failure: which input or sequence of events produces which wrong outcome. If you
  cannot construct that, it is a question, not a finding.
- **Skip what tooling enforces.** Biome, TypeScript and the import-boundary rules already
  catch formatting, unused code, type errors and forbidden imports. Mention them only if
  the change disables or weakens them.

## Process

1. **Pin the range.** Use the base the person names, else the pull request's base, else
   `main`. Collect `git diff <base>...HEAD`, `git log --oneline <base>..HEAD`, and any
   uncommitted changes if those are in scope. Stop and say so if the range is empty or the
   base does not resolve.
2. **Learn the intent.** Read the pull request description, the spec or plan the person
   points to, and the commit messages. Note what the change claims to do, so you can check
   that it does it and nothing unrequested.
3. **Map the change to risk areas** using the checklist below. Changes under `src/main`,
   `src/preload`, `src/core/rpc.ts`, `electron.vite.config.ts`, `electron-builder.yml` or
   `src/renderer/index.html` always get the security area, however small.
4. **Walk each relevant area.** Read the changed code and its surroundings; trace data
   from where it enters (renderer, IPC payload, git output, disk) to where it is used.
5. **Verify each candidate finding** by re-reading the exact lines and, where it helps,
   running the relevant test. Drop anything that does not survive.
6. **Run the checks** that fit the change (see "Before you say a change is done" in
   `AGENTS.md`) unless the person asked for a reading-only review. Report their real
   output.
7. **Write the report** in the format at the end.

## Checklist, in order of risk

### 1. Trust boundaries and Electron security

- Windows come only from `createWindow`; `contextIsolation`, `sandbox`, `webSecurity` on,
  `nodeIntegration` off, no webviews, no `allowRunningInsecureContent`, no experimental or
  Blink feature flags.
- Nothing loads remote content or `file://`. Assets are bundled and served through
  `app://`; the handler cannot be walked out of `out/renderer` (encoded `..`, absolute
  paths, other hosts).
- The CSP is unchanged or stricter: no `unsafe-eval`, `unsafe-inline` or remote origins
  outside the dev-server plugin.
- Navigation, redirects, `window.open` and webview attachment are still denied; browser
  permissions are still refused.
- New main handlers go through `handleMain`, so the trusted-sender check and schema
  validation apply. Nothing new is exposed through `contextBridge` beyond the contract.
- Paths from the renderer obey the path rule (inside the session's scan after symlink
  resolution); `shell.openExternal` never receives renderer input.
- Fuses, asar settings and signing options in `electron-builder.yml` are not loosened.
- Logs do not gain file contents, environment values or secrets.

### 2. The IPC contract

- New or changed channels are declared in `src/shared/ipc/contract.ts`; request schemas
  are `strictObject` with bounded strings and arrays.
- Results use `Result` and the right `IpcErrorCode`; nothing throws across a boundary;
  error messages do not leak internals the renderer should not see.
- Long calls take a `requestId` and stop work (and child processes) when the signal
  aborts.
- Shape changes bump `CONTRACT_VERSION`; the preload API is still generated, not
  hand-extended.
- Large payloads travel over the window's port, not through main.

### 3. Git and the filesystem (core service)

- `execFile`/`spawn` without a shell; `--` before paths; refs validated so they cannot be
  read as options.
- The hardening `-c` options and pinned diff prefixes are present on every call.
- Nothing writes to a repository; `dubiousOwnership` is surfaced, never bypassed.
- Output caps, timeouts and `GIT_CONCURRENCY` are respected; a huge repository or patch
  degrades with `outputTooLarge`/`timeout`, not memory growth.
- Paths: non-ASCII, spaces, quoted names, CRLF, renames and copies, symlinks.

### 4. Lifecycle, concurrency and resources

- What happens when the core service restarts mid-call, a window reloads or closes, or two
  windows scan the same repository? Sessions close; ports, timers, listeners, watchers and
  child processes are released.
- Stale responses: after rapid file or mode switching, the UI shows the latest request's
  result, never an earlier one that finished last.
- Shared state is reference-counted and released by its last user; no races on the local
  store.
- Nothing blocking (sync filesystem work, large parsing) runs on the main process.

### 5. Correctness and edge cases

- Empty, single and huge inputs; missing files; detached HEAD; unknown start; no upstream;
  repositories with no commits.
- Off-by-one errors in line numbers, ranges and counts; time zones in reflog dates.
- Error paths do what the happy path's caller expects; nothing fails silently (an empty
  `catch`, a swallowed `Result`, a default that hides a failure).

### 6. Performance

- Within the limits in `src/shared/constants.ts` (5 MB patches, 50,000-line files, 20,000
  lines highlighted): virtualized rendering, highlighting off the UI thread, no quadratic
  work over lines or files.
- No repeated git calls for data already cached; work is cancelled when no longer needed.

### 7. Design and types

- Code sits in the process and module that owns the concern; boundaries are not bent.
- No `any`; casts do not hide unchecked assumptions; data from outside is validated where
  it enters.
- Abstractions earn their place; no speculative options or layers. Names say what things
  are. Logic is not duplicated across processes when `src/shared` can hold it.
- The change does what it claims and nothing unrequested.

### 8. UI, theming and accessibility

- Colors come from tokens and work in both themes at WCAG AA; the window follows the app's
  theme class, not only the OS setting.
- Controls are reachable and operable by keyboard with visible focus; labels exist for
  inputs and icon buttons.

### 9. Tests

- New behaviour has tests that would fail without it; every bug fix has a regression test.
- Git behaviour is tested against real temporary repositories, never mocks.
- Security-relevant changes (protocol, preload, windows, CSP, IPC validation) have an
  end-to-end test.
- Tests assert outcomes, are deterministic (no sleeps standing in for conditions), and
  clean up after themselves.

### 10. Packaging and operations

- New runtime dependencies are justified, Apache-2.0 compatible, and re-checked with
  `bun run package`; native modules are unpacked from asar.
- Settings changes come with a migration and a `SETTINGS_VERSION` bump.
- `docs/platform-notes.md` is updated when a platform fact it records changes.

## Severity

| Severity     | Meaning                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Blocker**  | Security hole, data loss or a write to a repository, crash or hang in ordinary use, broken contract between processes, a check that now fails |
| **Major**    | Wrong result in a realistic case, a resource or listener leak, risky code without the test that would catch its failure, a boundary rule bent |
| **Minor**    | Maintainability cost: unclear names, duplication, a needless abstraction, a weak test                                                         |
| **Question** | Something that looks wrong but you could not prove; say what would settle it                                                                  |

Leave out nits unless the person asked for them.

## Report

```
## Verdict
Approve | Approve with follow-ups | Request changes - one sentence on why.
(State here if the review is not independent.)

## Findings
1. [Blocker] src/core/rpc.ts:118 - <what is wrong>
   Failure: <input or sequence> → <wrong outcome>.
   Evidence: <quoted line(s)>
   Fix: <the smallest change that resolves it>
2. ...

## Questions
- <things you could not prove, and what would settle them>

## Checks
- <command>: <real result>
- Not run: <command> - <why>

## Covered
<the checklist areas you reviewed, and any you skipped because the change does not touch them>
```

Order findings by severity. If there are none, say so plainly and list what you checked.
Approve a change when it clearly improves the codebase, even if it is not perfect; block
only on blockers or majors.

## Sources this checklist draws on

- Electron's security checklist: <https://www.electronjs.org/docs/latest/tutorial/security>
- OWASP Cheat Sheet Series: <https://cheatsheetseries.owasp.org/>
- Google's code review guide (the approval standard):
  <https://google.github.io/eng-practices/review/reviewer/standard.html>
