# Platform notes

Facts about the platform Treepeek builds on, each confirmed on a real machine rather than
assumed. Re-check a fact when the thing it depends on changes (the Electron major, the Bun
version, or the app gaining runtime dependencies).

Confirmed on 2026-11-09 on an Apple Silicon Mac (macOS 27.0, arm64) with Bun 1.4.3,
Electron 45.2.3 (Node 24.22.2, Chromium 156) and electron-builder 26.18.0.

## Bun with electron-builder: works

`bun run package` works from a clean `bun install --frozen-lockfile`.

Evidence, from a fresh `git clone` of the branch:

```
$ bun install --frozen-lockfile
391 packages installed [6.87s]
$ node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --version
v45.2.3
$ bun run package
  • electron-builder  version=26.18.0 os=27.0.0
  • packaging       platform=darwin arch=arm64 electron=45.2.3 appOutDir=dist/mac-arm64
  • searching for node modules  pm=bun ...
  • no node modules returned while searching directories
  • executing @electron/fuses  electronPath=dist/mac-arm64/Treepeek.app
  • skipped macOS code signing  reason=identity explicitly is set to null
$ codesign --verify --strict dist/mac-arm64/Treepeek.app   # exits 0 (ad-hoc signature)
```

Things that made it work, or that the next person should know:

- **Electron 45 has no install script.** It downloads its binary on first use or through
  its `install-electron` command, so `bun install` alone leaves no binary. The
  `postinstall` script runs `install-electron`. `trustedDependencies` still lists
  `electron`, as the decision log asks, but there is nothing for it to allow today.
- **Bun blocks esbuild's postinstall** (`bun pm untrusted`). It is harmless: esbuild finds
  its platform binary through its optional dependency.
- **The app has no runtime `node_modules`.** Every package is a dev dependency and is
  bundled into `out/` by electron-vite, so electron-builder's production-dependency
  collection found nothing to copy. That path is therefore **not yet exercised under
  Bun's hoisted layout**. Re-run this check when the first runtime dependency arrives
  (`@parcel/watcher`, a native module, is expected in the live-refresh work).
- The clean install reused Electron's download cache (`~/Library/Caches/electron`). A
  first-ever download on a new machine goes through the same `install-electron` step.

## `node:sqlite` in the core service: available

The packaged app's core service loads `node:sqlite` without flags and runs SQLite 3.53.4.

Evidence: `probeSqlite()` (`src/core/probe-sqlite.ts`) runs when the core service starts,
and its result is reported through the `app.info` core call. The end-to-end suite
against the packaged app prints it:

```
$ APP_TARGET=packaged bun run test:e2e
[packaged] core service node:sqlite probe: {"available":true,"version":"3.53.4"}
```

and the packaged app's `userData/logs/core.log` records:

```
INFO [core:service] core service started {"pid":72953,"node":"24.22.2","electron":"45.2.3","sqlite":{"available":true,"version":"3.53.4"}}
```

So review marks can use `node:sqlite`; the JSON-per-repository fallback stays as the
designed safety net for a future Electron that drops it.

## Minimum macOS: 13.0 (Ventura)

Electron 44 and later need macOS 13 (Ventura), so Treepeek on Electron 45 does too. It is
written to `mac.minimumSystemVersion` in `electron-builder.yml`.

Evidence:

- Electron's breaking changes at v45.2.3, "Removed: macOS 12 support": macOS 13 (Ventura)
  or later is required to run Electron v44.0.0 and higher.
  <https://github.com/electron/electron/blob/v45.2.3/docs/breaking-changes.md#removed-macos-12-support>
- Electron's README at v45.2.3 lists "macOS (Ventura and up)".
- Electron 45.2.3's own bundle declares it:

  ```
  $ plutil -p node_modules/electron/dist/Electron.app/Contents/Info.plist | grep LSMinimum
    "LSMinimumSystemVersion" => "13.0"
  ```

- The packaged app carries it: `LSMinimumSystemVersion` is `13.0` in
  `dist/mac-arm64/Treepeek.app/Contents/Info.plist`.

## Git: minimum version 2.36.0

Treepeek needs Git 2.36.0 or newer (`MIN_GIT_VERSION` in `src/shared/domain/git.ts`);
discovery reports an older git as `tooOld`. Two facts set the minimum:

- **`git worktree list --porcelain -z`**, the newest flag in the command catalogue. Git
  2.36.0's release notes add `-z` to `worktree list --porcelain` because pathnames were not
  quoted safely without it.
- **`core.fsmonitor` as a boolean.** At v2.36.0 the documentation describes `true` as
  turning on the built-in monitor; at v2.35.0 the value is a hook command. On Git before
  2.36, the hardening argument `-c core.fsmonitor=false` would name a hook program called
  `false` instead of turning the monitor off.

Confirmed on 2026-11-09 against Git's own sources in `git/git` on GitHub:

- _Release notes_: `Documentation/RelNotes/<version>.adoc`.
- _Tagged docs_: the first `v2.N.0` tag whose `Documentation/` names the flag, found by
  binary search over `v2.0.0` to `v2.48.0` (the last tags with `.txt` documentation).
- "≤ 2.0.0" means the flag is already documented at `v2.0.0`. Its exact version was not
  looked up, because it is far below the minimum.

| Flag, config or variable                                                                 | Used for                        | Since      | Evidence                          |
| ---------------------------------------------------------------------------------------- | ------------------------------- | ---------- | --------------------------------- |
| `worktree list --porcelain`                                                              | the authoritative checkout list | 2.7.0      | tagged docs                       |
| `worktree list ... -z`                                                                   | the same, NUL-separated         | **2.36.0** | release notes 2.36.0, tagged docs |
| `-c core.fsmonitor=false` (boolean)                                                      | hardening                       | **2.36.0** | tagged docs (v2.35.0 vs v2.36.0)  |
| `rev-parse --path-format=absolute`                                                       | checkout identity               | 2.31.0     | release notes 2.31.0, tagged docs |
| `rev-parse --end-of-options`                                                             | resolving user refs             | 2.30.0     | release notes 2.30.0, tagged docs |
| `rev-parse --git-common-dir`                                                             | checkout identity               | 2.5.0      | tagged docs                       |
| `rev-parse --show-toplevel`, `--git-dir`, `--verify`, `--quiet`                          | identity, refs                  | ≤ 2.0.0    | tagged docs                       |
| `remote get-url`                                                                         | origin URL                      | 2.7.0      | tagged docs                       |
| `status --porcelain=v2`                                                                  | checkout state                  | 2.11.0     | tagged docs                       |
| `status --no-renames`                                                                    | checkout state                  | 2.18.0     | tagged docs                       |
| `status -z`, `--branch`, `--untracked-files=all`                                         | checkout state                  | ≤ 2.0.0    | tagged docs                       |
| `reflog show --date=iso-strict`                                                          | the start                       | 2.2.0      | tagged docs                       |
| `--format=%H%x09%gd`, `log -z`                                                           | the start                       | ≤ 2.0.0    | tagged docs                       |
| `merge-base --is-ancestor`                                                               | start check, relations          | ≤ 2.0.0    | tagged docs                       |
| `rev-list --count`                                                                       | history counts                  | ≤ 2.0.0    | tagged docs                       |
| `diff --raw`, `--name-only`, `-z`, `--cached`, `-U<n>`, `--find-renames`, `--abbrev=<n>` | comparisons, patches            | ≤ 2.0.0    | tagged docs                       |
| `diff --no-ext-diff`, `--no-textconv`, `--no-color`, `--src-prefix`, `--dst-prefix`      | hardening, the patch parser     | ≤ 2.0.0    | tagged docs                       |
| `diff --no-index`                                                                        | untracked files                 | ≤ 2.0.0    | tagged docs                       |
| `ls-files --others --exclude-standard -z`                                                | untracked files                 | ≤ 2.0.0    | tagged docs                       |
| `cat-file --batch`                                                                       | blob contents                   | ≤ 2.0.0    | tagged docs                       |
| `cat-file --batch-command` (`info`, `contents`)                                          | blob size before its body       | **2.36.0** | release notes 2.36.0, tagged docs |
| `hash-object --stdin-paths`                                                              | `resultHash`                    | ≤ 2.0.0    | tagged docs                       |
| `hash-object --stdin`                                                                    | a symlink's `resultHash`        | ≤ 2.0.0    | tagged docs                       |
| `-C <path>`, `-c <name>=<value>`                                                         | every call                      | ≤ 2.0.0    | tagged docs                       |
| `-c core.pager=cat`, `color.ui=false`, `core.quotePath=false`, `diff.external=`          | hardening                       | ≤ 2.0.0    | tagged docs                       |
| `-c log.showSignature=false`                                                             | hardening                       | 2.10.0     | release notes 2.10.0              |
| `-c protocol.allow=never`                                                                | hardening                       | 2.12.0     | tagged docs (`config.txt`)        |
| `GIT_OPTIONAL_LOCKS=0`                                                                   | no index lock                   | 2.15.0     | tagged docs                       |
| `GIT_TERMINAL_PROMPT=0`                                                                  | no prompts                      | 2.3.0      | tagged docs                       |
| `GIT_LITERAL_PATHSPECS=1`                                                                | paths are not globs             | ≤ 2.0.0    | tagged docs                       |
| `GIT_PAGER`, `GIT_ASKPASS`, `SSH_ASKPASS`                                                | no pager, no prompts            | ≤ 2.0.0    | tagged docs                       |
| `GIT_NO_LAZY_FETCH=1`                                                                    | no fetch in a partial clone     | 2.45.0     | release notes 2.45.0, tagged docs |

Older Git ignores `GIT_NO_LAZY_FETCH`. There `protocol.allow=never` refuses every
transport, so a lazy fetch should fail too; this was not tried with a real partial clone.

What is not confirmed:

- **No test has run on Git 2.36 itself.** The unit suite passed with Homebrew Git 2.55.0
  and Apple Git 2.50.1 (`TREEPEEK_GIT=/usr/bin/git bunx vitest run tests/unit/core`).
  This machine has no older Git. Run the suite with `TREEPEEK_GIT` pointing at a 2.36
  build before relying on the floor.
- **`diff --no-abbrev`** gives full ids whatever the hash length, so it would suit
  SHA-256 repositories better than the catalogue's `--abbrev=40`. Git accepts it (tested on
  2.50.1 and 2.55.0), but `diff-options.txt` never documents it, so it has no version here.
- Git 2.55.0 prints `iso-strict` dates in UTC with `Z`, not `+00:00`. The reflog parser
  accepts both.

## Testing the packaged app

The fuses turn off `EnableNodeCliInspectArguments`, and Playwright's `_electron.launch`
needs `--inspect` to drive the main process, so it cannot launch the packaged app. The
end-to-end tests therefore start the app with `--remote-debugging-port` (a Chromium switch
no fuse touches) and connect with `chromium.connectOverCDP`, for both the built and the
packaged app (`tests/e2e/support/app.ts`). Two consequences:

- Tests see what the renderer sees; they cannot evaluate code in the main process.
- DevTools' `Runtime.evaluate` suspends CSP's `eval` block while it runs, so the test that
  proves `eval` is blocked runs its attempt in a later page task.

`@axe-core/playwright` cannot finish its run in an Electron window reached over CDP (it
opens a new page), so the contrast check runs `axe-core` in the page directly
(`tests/e2e/support/a11y.ts`).
