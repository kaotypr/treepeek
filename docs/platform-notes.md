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
