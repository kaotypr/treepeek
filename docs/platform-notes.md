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
- **One runtime dependency: `@parcel/watcher`.** Every other package is a dev dependency
  bundled into `out/` by electron-vite. Production-dependency collection under Bun's
  hoisted layout works; see "Live refresh" below for what it packs.
- The clean install reused Electron's download cache (`~/Library/Caches/electron`). A
  first-ever download on a new machine goes through the same `install-electron` step.
- **`bun run` runs `pre` scripts.** `bun run package` runs `prepackage` first, which writes
  `build/THIRD_PARTY_NOTICES` for electron-builder to copy into `Contents/Resources`
  (confirmed 2026-11-10 with Bun 1.4.3: the package log starts with `$ bun run notices`).

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

| Flag, config or variable                                                                 | Used for                                            | Since      | Evidence                                               |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------- | ------------------------------------------------------ |
| `worktree list --porcelain`                                                              | the authoritative checkout list                     | 2.7.0      | tagged docs                                            |
| `worktree list ... -z`                                                                   | the same, NUL-separated                             | **2.36.0** | release notes 2.36.0, tagged docs                      |
| `-c core.fsmonitor=false` (boolean)                                                      | hardening                                           | **2.36.0** | tagged docs (v2.35.0 vs v2.36.0)                       |
| `rev-parse --path-format=absolute`                                                       | checkout identity                                   | 2.31.0     | release notes 2.31.0, tagged docs                      |
| `rev-parse --end-of-options`                                                             | resolving user refs                                 | 2.30.0     | release notes 2.30.0, tagged docs                      |
| `rev-parse --git-common-dir`                                                             | checkout identity                                   | 2.5.0      | tagged docs                                            |
| `rev-parse --show-toplevel`, `--git-dir`, `--verify`, `--quiet`                          | identity, refs                                      | ≤ 2.0.0    | tagged docs                                            |
| `remote get-url`                                                                         | origin URL                                          | 2.7.0      | tagged docs                                            |
| `status --porcelain=v2`                                                                  | checkout state                                      | 2.11.0     | tagged docs                                            |
| `status --no-renames`                                                                    | checkout state                                      | 2.18.0     | tagged docs                                            |
| `status -z`, `--branch`, `--untracked-files=all`                                         | checkout state                                      | ≤ 2.0.0    | tagged docs                                            |
| `reflog show --date=iso-strict`                                                          | the start                                           | 2.2.0      | tagged docs                                            |
| `--format=%H%x09%gd`, `log -z`                                                           | the start                                           | ≤ 2.0.0    | tagged docs                                            |
| `merge-base --is-ancestor`                                                               | start check, relations                              | ≤ 2.0.0    | tagged docs                                            |
| `rev-list --count`                                                                       | history counts                                      | ≤ 2.0.0    | tagged docs                                            |
| `diff --raw`, `--name-only`, `-z`, `--cached`, `-U<n>`, `--find-renames`, `--abbrev=<n>` | comparisons, patches                                | ≤ 2.0.0    | tagged docs                                            |
| `diff --no-ext-diff`, `--no-textconv`, `--no-color`, `--src-prefix`, `--dst-prefix`      | hardening, the patch parser                         | ≤ 2.0.0    | tagged docs                                            |
| `diff --no-index`                                                                        | untracked files                                     | ≤ 2.0.0    | tagged docs                                            |
| `ls-files --others --exclude-standard -z`                                                | untracked files                                     | ≤ 2.0.0    | tagged docs                                            |
| `cat-file --batch`                                                                       | blob contents                                       | ≤ 2.0.0    | tagged docs                                            |
| `cat-file --batch-command` (`info`, `contents`)                                          | blob size before its body                           | **2.36.0** | release notes 2.36.0, tagged docs                      |
| `hash-object --stdin-paths`                                                              | `resultHash`                                        | ≤ 2.0.0    | tagged docs                                            |
| `hash-object --stdin`                                                                    | a symlink's `resultHash`                            | ≤ 2.0.0    | tagged docs                                            |
| `-C <path>`, `-c <name>=<value>`                                                         | every call                                          | ≤ 2.0.0    | tagged docs                                            |
| `-c core.pager=cat`, `color.ui=false`, `core.quotePath=false`, `diff.external=`          | hardening                                           | ≤ 2.0.0    | tagged docs                                            |
| `-c log.showSignature=false`                                                             | hardening                                           | 2.10.0     | release notes 2.10.0                                   |
| `-c protocol.allow=never`                                                                | hardening                                           | 2.12.0     | tagged docs (`config.txt`)                             |
| `GIT_OPTIONAL_LOCKS=0`                                                                   | no index lock                                       | 2.15.0     | tagged docs                                            |
| `GIT_TERMINAL_PROMPT=0`                                                                  | no prompts                                          | 2.3.0      | tagged docs                                            |
| `GIT_LITERAL_PATHSPECS=1`                                                                | paths are not globs                                 | ≤ 2.0.0    | tagged docs                                            |
| `GIT_PAGER`, `GIT_ASKPASS`, `SSH_ASKPASS`                                                | no pager, no prompts                                | ≤ 2.0.0    | tagged docs                                            |
| `GIT_NO_LAZY_FETCH=1`                                                                    | no fetch in a partial clone                         | 2.45.0     | release notes 2.45.0, tagged docs                      |
| `config --list -z` (`--null`), `--includes`                                              | listing a folder's filter drivers                   | ≤ 2.0.0    | tagged docs                                            |
| `config --show-origin`                                                                   | where each listed entry comes from                  | 2.8.0      | release notes 2.8.0, tagged docs                       |
| `config --show-scope`                                                                    | which scope each listed entry is in                 | 2.26.0     | release notes 2.26.0, tagged docs                      |
| `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`                         | switching off a repository's filter drivers         | 2.31.0     | release notes 2.31.0, tagged docs (v2.30.0 vs v2.31.0) |
| `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`                                                 | honoured from the login environment                 | 2.32.0     | release notes 2.32.0, tagged docs                      |
| `diff --ignore-submodules=dirty`, `status --ignore-submodules=dirty`                     | never reading a submodule's working tree            | ≤ 2.0.0    | tagged docs                                            |
| `diff --submodule=short`                                                                 | a submodule's patch is its gitlink                  | ≤ 2.0.0    | tagged docs                                            |
| `diff --numstat`                                                                         | line counts of a truncated patch                    | ≤ 2.0.0    | tagged docs                                            |
| `hash-object -t tree --stdin`                                                            | the empty tree's id, for a checkout without commits | ≤ 2.0.0    | tagged docs                                            |
| `diff --abbrev=64`, capped at the id length                                              | whole blob ids in comparison lists                  | 2.18.0     | source (`diff.c`, v2.17.0 vs v2.18.0)                  |

Older Git ignores `GIT_NO_LAZY_FETCH`. There `protocol.allow=never` refuses every
transport, so a lazy fetch should fail too; this was not tried with a real partial clone.

The rows from `config --list` down were added once the filter-driver overrides, the
submodule pins, truncated patches and checkouts without commits came in. They were checked
on 2026-11-09 the same way, against `git/git` on GitHub: where a version is given, the
flag is absent from the tagged documentation of the release before and present at that
version, whose release notes announce it; "≤ 2.0.0" rows are documented at `v2.0.0`.
None of them raises the minimum: the newest is `GIT_CONFIG_GLOBAL` at 2.32.0, which
Treepeek only passes through from the login environment (the tests set it to `/dev/null`
to shut out the machine's own config).

What is not confirmed:

- **No test has run on Git 2.36 itself.** The unit suite passed with Homebrew Git 2.55.0
  and Apple Git 2.50.1 (`TREEPEEK_GIT=/usr/bin/git bunx vitest run tests/unit/core`).
  This machine has no older Git. Run the suite with `TREEPEEK_GIT` pointing at a 2.36
  build before relying on the floor.
- **The `--abbrev` cap is confirmed from Git's source, not its documentation.** The
  documentation of `--abbrev=<n>` never says it is capped. `diff.c` caps it at 40 in every
  tag from v2.0.0 to v2.17.0 and at the object format's id length from v2.18.0 to v2.55.0,
  so `--abbrev=64` prints whole SHA-1 ids on any Git 2.x and whole SHA-256 ids from 2.18.0
  (SHA-256 repositories need Git 2.29 or newer anyway). `diff --no-abbrev` would do the same, but
  `diff-options.txt` never documents it.
- Git 2.55.0 prints `iso-strict` dates in UTC with `Z`, not `+00:00`. The reflog parser
  accepts both.

## Scan baseline

The baseline for later work on review marks and live refresh, from `bun scripts/bench-scan.ts`
on 2026-11-09: an Apple M4 with 16 GB, macOS 27.0, Bun 1.4.3. The script drives the core
service's own modules over a session port under Bun, not inside Electron's Node, so treat
the times as relative. The process counts do not depend on the runtime.

The fixture is three repositories, each a main checkout and nine linked worktrees (30
checkouts), with 200 files and 10 commits each; every worktree has two commits of its own
and staged, unstaged and untracked changes. Cold is a fresh `CoreState` and git
environment (no repository caches, batch processes or config listings); warm is
`scan.start` again in the same session. Times are the median of 5 rounds.

| Git                                       | Cold scan        | Warm scan        | Git processes, cold | Git processes, warm |
| ----------------------------------------- | ---------------- | ---------------- | ------------------- | ------------------- |
| Homebrew 2.55.0 (`/opt/homebrew/bin/git`) | 327 ms (317–375) | 105 ms (102–108) | 270                 | 60                  |
| Apple 2.50.1 (`/usr/bin/git`)             | 671 ms (659–717) | 179 ms (175–216) | 270                 | 60                  |

- Cold processes: `merge-base` 54, `config` 33 (one listing per checkout and per common
  dir), `diff` 30, `reflog` 30, `remote` 30, `rev-list` 30, `rev-parse` 30, `status` 30,
  `worktree` 3.
- Warm processes: `rev-parse` 30 and `status` 30. Validation and the status are read again
  on every scan; everything else comes from the caches. That is 78% fewer processes.
- `/usr/bin/git` is the Command Line Tools shim, which finds and starts the real git on
  every call; that start-up cost roughly doubles the scan time with the same work.

`hash-object --stdin-paths` on a large untracked tree: `review` on a checkout with 10,000
untracked files (about 170 bytes each, in 100 folders), with Homebrew Git 2.55.0:

| `review` list                                                          | Time   | Git processes                                      |
| ---------------------------------------------------------------------- | ------ | -------------------------------------------------- |
| First (every file hashed)                                              | 553 ms | 3: `diff`, `ls-files`, `hash-object --stdin-paths` |
| Again after `invalidate(path, ["workingTree"])` (size and mtime cache) | 354 ms | 2: `diff`, `ls-files`                              |
| Again, unchanged (comparison cache)                                    | 8 ms   | 0                                                  |

With Apple Git 2.50.1 the same three took 648, 359 and 7 ms. One `hash-object` process
hashes the whole tree in chunks of 256 paths; without hashing, the rest of the time is
`ls-files`, `lstat` of every file and the binary sniff of each file's first 8 KB.

### Review status after a scan

Review marks compute every checkout's review status after each scan, in the git queue's
low lane, two checkouts at a time (`core/review/background.ts`). Measured with
`TREEPEEK_PERF=1 bun run test:e2e tests/e2e/review-status.perf.spec.ts` on 2026-11-10, on
the same machine and fixture as the scan baseline (30 checkouts), in the built app
(Electron, `APP_TARGET=dev`) with Homebrew Git 2.55.0. Four runs:

| From `scan.done` to the last checkout's status          | Runs                  | Median |
| ------------------------------------------------------- | --------------------- | ------ |
| Cold (first scan; no comparison or hash caches)         | 285, 299, 313, 316 ms | 306 ms |
| Warm (⌘R; hash cache kept, comparison lists read again) | 158, 163, 169, 175 ms | 166 ms |

Cold is the core service's own measure (its `review status computed` log line, from
`scan.done` to the last `review.changed`); warm is also measured in the page, from the
`scan.done` event to the 30th `review.changed`, within 2 ms of the log. The target is
5 s. Selecting the checkout the background reaches last, right after `scan.done` of a ⌘R,
showed its file list in 11–14 ms; selecting one with nothing running took 23–25 ms (both
measured from the test, over DevTools, so they include the protocol's round trips).
Four more runs later the same day, with other work keeping the load average near 8.5:
cold 722–1,209 ms, warm 385–828 ms, file lists 28–77 ms. Busy, still well under 5 s.

## Live refresh: `@parcel/watcher` on FSEvents

Confirmed on 2026-11-10 on the machine above (Apple M4, 16 GB, macOS 27.0), with
`@parcel/watcher` 2.6.0 and Homebrew Git 2.55.0.

**Packaging.** `@parcel/watcher` is the app's one runtime dependency (MIT; a native module
with N-API prebuilds). electron-vite keeps it external, as a dynamic `import()` in
`out/core/index.js`, which the core service loads on first use so that a module that will
not load only costs the FSEvents backend (live refresh falls back to `fs.watch`). With Bun
there is no dependency-tree command, so `bun run package` logs that electron-builder
"utilizing file traversal collector"; it packs `@parcel/watcher`,
`@parcel/watcher-darwin-arm64`, `detect-libc`, `is-glob`, `is-extglob`, `node-addon-api` and
`picomatch` into `app.asar`, and unpacks `watcher.node` to
`app.asar.unpacked/node_modules/@parcel/watcher-darwin-arm64/` (`asarUnpack: **/*.node`). It
also logs the other platforms' optional prebuilds as missing, which is expected.
`codesign --verify --strict dist/mac-arm64/Treepeek.app` exits 0.

**FSEvents is the backend in the packaged app.** The core service names `@parcel/watcher`'s
`fs-events` backend outright: left to choose, it prefers Watchman when that is installed.
The test-only `test.liveRefresh` call reports the backend of every subscription, and
`APP_TARGET=packaged bun run test:e2e` prints:

```
[packaged] live refresh backend: fsevents
```

**Timing.** From the moment a commit in a watched worktree returns to the moment both the
selected checkout's counts and its timeline row show it, with a scan of 30 worktrees (the
scan benchmark's fixture), in the packaged app, five commits per run. The budget is 1.5 s.

| Run | Commit to screen           | Median |
| --- | -------------------------- | ------ |
| 1   | 500, 514, 526, 543, 544 ms | 526 ms |
| 2   | 525, 530, 533, 533, 542 ms | 533 ms |

The 400 ms quiet window of the debounce is most of it; the refresh itself (status, history
counts, timeline) and the render take the rest. Measured with
`TREEPEEK_PERF=1 APP_TARGET=packaged bun run test:e2e tests/e2e/live-refresh.perf.spec.ts`
(results in `test-results/live-refresh-perf.json`), with the load average near 4.

**Streams and memory.** One FSEvents stream per watched folder: the scan root, each
repository's common dir (which carries every checkout's `HEAD`, `index` and `logs/HEAD`,
since a linked worktree's git dir is `<common>/worktrees/<name>`), and each working tree.
The core service's memory is its resident set after the scan has settled, compared with
the same scan in a launch where every watcher backend is switched off
(`TREEPEEK_E2E_WATCHER_FAULT=fsevents,fs.watch`); one sample each, so read the difference
as a rough size.

| Worktrees (repositories) | Streams | Core RSS watched | Core RSS unwatched | Open files, watched / not |
| ------------------------ | ------- | ---------------- | ------------------ | ------------------------- |
| 30 (3)                   | 34      | 104.5 MB         | 98.4 MB            | 129 / 128                 |
| 100 (10)                 | 111     | 124.3 MB         | 116.3 MB           | 318 / 317                 |

So watching costs about 6–8 MB and no file descriptor per stream (FSEvents talks to
`fseventsd` over Mach ports). No stream was refused at 111.

Facts the implementation rests on:

- **FSEvents excludes at most 8 paths in the kernel** (`FSEventStreamSetExclusionPaths`); past
  that it excludes none. `@parcel/watcher` passes its ignore paths there and filters
  everything else itself, so a working tree's watch excludes `.git` and the first seven
  skip-listed folders as paths and the rest as globs (`core/watch/targets.ts`).
- **`@parcel/watcher` stops a stream itself when the watched folder is deleted**, on its
  FSEvents thread and without the lock its `unsubscribe` takes. An unsubscribe of the same
  stream at that moment can release it twice: a unit test run that deleted fixture folders
  while unsubscribes were still running crashed its worker with SIGTRAP, "BUG IN CLIENT OF
  LIBMALLOC: memory corruption of free block". Tests now stop every watcher before deleting
  folders (`Harness.disposeAndWait`). In the app a removed worktree's watch is released only
  after the debounced refresh that notices it (400 ms or more later), so the two do not
  meet; a window closing at the very instant its worktree folder is deleted still could.
  Not seen in the app.
- **A folder must be unsubscribed even after it was deleted.** `@parcel/watcher` shares one
  watcher per folder and ignore list, and does not start a new stream for a folder it
  still holds, so a worktree recreated at the same path would never be watched again.

## Windows: vibrancy, folder drops and the test-only open hook

Scan windows put the macOS `sidebar` material behind the timeline and navigator
(`vibrancy: "sidebar"` with a clear window background; the preview and toolbar stay
opaque). It is left off when "Reduce transparency" is on (`nativeTheme.prefersReducedTransparency`,
followed live), and in background-mode test runs, whose windows are invisible anyway, so
the contrast checks there measure the opaque surfaces. Not yet checked by eye: test runs
never show windows, and macOS 13 (the minimum) was not available.

A folder dropped on the Dock icon arrives as `app.on("open-file")`, which Treepeek
registers before `ready` (a drop can launch the app). The packaged app declares folders
(`public.folder`) in `CFBundleDocumentTypes` with `LSHandlerRank` `None`, so it accepts the
drop without claiming to open folders by default (`extendInfo` in `electron-builder.yml`).
A folder dropped on a window is read by the preload (`webUtils.getPathForFile`; pages
cannot see a file's path) and opened through `folder.open`. Neither drop can be synthesized
in a background test run; both are unverified end to end.

End-to-end tests open folders through `TREEPEEK_E2E_OPEN` (paths joined with `:`), which
main honours only when `NODE_ENV` is `test`. electron-vite leaves `process.env.NODE_ENV`
alone in the main bundle (checked in `out/main/index.js`), so the packaged app reads it at
run time like the other test variables.

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
