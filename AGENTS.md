# Treepeek

Treepeek is a macOS desktop app (Electron, Apple Silicon) for reviewing the Git worktrees
beneath a folder: one window per scanned folder, every checkout on a timeline, and a diff
viewer with per-file review marks. It opens repositories it does not trust, so security
and correctness rules here are not optional.

This file is the standard every change is held to, by people and agents alike. When a
rule here and a habit conflict, the rule wins; when a rule is wrong, change this file in
the same pull request and say why.

## Commands

| Task | Command |
| --- | --- |
| Install (exact, from the lockfile) | `bun install --frozen-lockfile` |
| Run with hot reload | `bun run dev` |
| Build `out/` | `bun run build` |
| Lint and format check | `bun run lint` (fix formatting with `bun run format`) |
| Type-check | `bun run typecheck` |
| Unit tests | `bun run test` |
| Build the development pages into `out-lab/` | `bun run build:lab` |
| End-to-end tests (needs `bun run build` and `bun run build:lab`) | `bun run test:e2e` |
| Watch an end-to-end run (windows shown normally) | `TREEPEEK_E2E_SHOW=1 bun run test:e2e` |
| Diff viewer performance (local machine only) | `TREEPEEK_PERF=1 bun run test:e2e tests/e2e/diff-lab.perf.spec.ts` |
| Package an unsigned arm64 app | `bun run package` |
| End-to-end tests against the package | `APP_TARGET=packaged bun run test:e2e` |

Bun installs packages and runs scripts only; Electron, electron-vite and electron-builder
run on Node. Do not add `--bun` to scripts. `docs/platform-notes.md` records the platform
facts this setup rests on and when to re-check them.

## Before you say a change is done

- Always: `bun run lint`, `bun run typecheck`, `bun run test`.
- Touching anything under `src/main`, `src/preload`, `src/core` or `src/renderer`:
  `bun run build` and `bun run test:e2e` too.
- Touching packaging, fuses, the `app://` protocol, the preload, or adding a runtime
  dependency: `bun run package` and `APP_TARGET=packaged bun run test:e2e`.
- Report what you actually ran and what it returned. A check you did not run is not a
  pass; say it is unverified.

## Architecture

Four kinds of process. Each has one job and a list of things it never does.

| Process | Source | Does | Never |
| --- | --- | --- | --- |
| Main | `src/main` | App lifecycle, one window per scan root, menus, dialogs, settings, theme, supervising the core service, handing each window a port to it | Runs git, reads repositories, or parses large output |
| Core service (one `utilityProcess` for the app) | `src/core` | All git and filesystem work, scans, comparisons, diffs, watching, the local store, caches; one session per window | Creates windows or uses native UI |
| Preload (per window) | `src/preload` | Builds the frozen `window.treepeek` API from the IPC contract | Exposes `ipcRenderer`, Node, or any channel not in the contract |
| Renderer (per window) | `src/renderer` | The React UI | Uses Node, loads remote content, or talks to anything except `window.treepeek` |

`src/shared` holds what every process uses: domain types, the IPC contract and its
schemas, constants, the logger and settings schema. It imports nothing outside itself and
no Node, Electron, DOM or React APIs.

Import boundaries are enforced by TypeScript project references and Biome
(`noRestrictedImports`, `noNodejsModules`): the renderer imports only `src/shared`;
`src/main` and `src/core` import `src/shared` but never each other; the preload imports
`src/shared` and `electron` only. Do not weaken these rules to make an import work; move
the code to the process that owns it.

### Where things live

| Concern | File |
| --- | --- |
| IPC contract (every channel), error codes | `src/shared/ipc/contract.ts`, `src/shared/ipc/result.ts` |
| Main ↔ core and port message schemas | `src/shared/ipc/messages.ts` |
| Window creation and navigation guards | `src/main/windows.ts` (`createWindow`, `guardWebContents`) |
| `app://` protocol and the CSP | `src/main/protocol.ts`, plus the meta tag in `src/renderer/index.html` |
| Trusted-sender check, permissions, startup | `src/main/index.ts` |
| Main call routing and validation | `src/main/router.ts`, `src/main/ipc.ts` (`handleMain`) |
| Core service lifecycle and restarts | `src/main/core-supervisor.ts` |
| Core call routing, validation, cancellation | `src/core/rpc.ts` (`CoreRpc`) |
| The preload API | `src/preload/index.ts`, its type in `src/shared/ipc/api.ts` |
| Settings file | `src/main/settings.ts`, schema in `src/shared/settings.ts` |
| Logger and redaction | `src/shared/log.ts` |
| Domain types | `src/shared/domain/` |
| Unified-patch parser | `src/shared/diff/parse-patch.ts` |
| Diff viewer (`DiffView`, the `@pierre/diffs` adapter, the highlight worker) | `src/renderer/diff-view/`; why this library: `docs/decisions/diff-viewer.md` |
| Diff lab (development only; never in `bun run build`) | `src/renderer/dev/diff-lab/`, fixtures from `scripts/make-diff-fixtures.ts` |
| Size limits, scan depth, git concurrency | `src/shared/constants.ts` |
| Color tokens (light and dark) | `src/renderer/styles/tokens.css`, window background in `src/shared/theme.ts` |
| Fuses, signing, minimum macOS | `electron-builder.yml` |

## IPC rules

- Every channel is declared once in `src/shared/ipc/contract.ts` with `defineCall` or
  `defineEvent` and a Valibot schema. The preload API, the handlers and the runtime
  validation all come from it. Never add a channel anywhere else, and never hand-extend
  `window.treepeek`.
- Request schemas use `v.strictObject` so unknown keys are rejected, and bound strings
  and arrays that come from the renderer.
- Calls return `Result<T>`: `ok(value)` or `err(code, message, detail?)` with a code from
  `IPC_ERROR_CODES`. Nothing throws across a process boundary; a handler that throws
  becomes `internal`.
- Renderer ↔ core traffic (scans, comparisons, diffs, marks, refresh) goes over the
  window's MessagePort, never through main. Renderer ↔ main is for native actions and
  settings only.
- A call that can run long takes a `requestId` and honours the `AbortSignal` its handler
  receives: stop work and kill child processes when it aborts.
- State-like events are `sticky`, so a late subscriber gets the current value.
- Changing a channel's shape bumps `CONTRACT_VERSION`.

## Security rules

These carry Electron's security checklist into this codebase. Breaking one is a blocker.

- Windows are created only through `createWindow`: `contextIsolation`, `sandbox` and
  `webSecurity` on, `nodeIntegration` off, no webviews.
- Content comes only from the bundled app through `app://`. No remote URLs, no `file://`,
  no CDN assets, no remote fonts.
- The CSP stays strict: `default-src 'self'`, no `unsafe-eval`, no `unsafe-inline`, no
  remote origins. Only `bun run dev` relaxes it (in `electron.vite.config.ts`), so check
  anything that writes inline styles in the lab build or the built app, not the dev
  server. The diff viewer library's `<style>` tags and `style` attributes are re-applied
  through the CSSOM (`renderer/diff-view/pierre/csp-styles.ts`).
- The `app://` handler serves files from `out/renderer` and nothing else.
- Navigation, redirects, new windows and webview attachment stay denied for every web
  contents; browser permission requests stay denied.
- Main handles calls only from the top frame of its own windows (the trusted-sender
  check). Every payload is validated before a handler runs.
- **Path rule:** any path that reaches the core service from the renderer must be one the
  current session's scan produced, or lie inside such a checkout after symlink
  resolution. Everything else is rejected with `notInScan`.
- "Open in…" actions run in main and accept only local paths the core service confirms
  are in a scan. Never pass renderer-supplied input to `shell.openExternal`.
- Fuses stay as `electron-builder.yml` sets them (RunAsNode, NODE_OPTIONS and the inspect
  arguments off; asar integrity and only-load-from-asar on).
- Logs may contain repository paths. They never contain file contents or environment
  values; pass data through the logger, which redacts `env` and secret-looking keys.

## Git rules (core service)

- Run the system `git` with `execFile` (or `spawn` without a shell). Never build a shell
  command string.
- Put `--` before paths. Validate refs so a user-controlled value can never be read as an
  option.
- Pass hardening `-c` options on every call so a repository's own config cannot run
  programs: no fsmonitor, external diff, textconv or pager, and pin diff prefixes
  (`--src-prefix=a/ --dst-prefix=b/`; the patch parser assumes them).
- Treepeek never writes to a repository. Read-only commands only.
- Git's `safe.directory` refusal (`dubiousOwnership`) is shown to the user and never
  overridden.
- Respect the limits in `src/shared/constants.ts`: output caps, `GIT_CONCURRENCY`,
  timeouts. Return `outputTooLarge` or `timeout` instead of growing without bound.

## Code style

- TypeScript strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. No
  `any`. Data crossing a boundary (IPC, files, git output) is `unknown` until a schema or
  a parser has checked it. A cast must not hide an unchecked assumption.
- Small modules with one reason to change. Abstractions earn their place with a second
  real use, not an imagined one.
- Comments say why, not what. English everywhere: code, comments, tests, commit messages.
- UI uses the color tokens, never hard-coded colors, and must work in both themes at WCAG
  AA contrast. Prefer the Base UI components in `src/renderer/components/ui`.
- A new runtime dependency (`dependencies`, not `devDependencies`) changes what gets
  packaged: justify it, check its license is compatible with Apache-2.0, and re-run the
  packaging checks. Native modules must be unpacked from asar.

## Tests

- Unit tests live in `tests/unit` (Vitest, Node environment for `shared`, `core` and
  `main`; happy-dom for `renderer`).
- Anything that reads git output is tested against a real temporary repository made with
  `tests/support/git.ts`. Never mock git.
- End-to-end tests live in `tests/e2e` and drive the app over the DevTools protocol
  (`tests/e2e/support/app.ts`), against the built app or the package. A change to a
  security rule, the protocol, the preload or the window setup needs an end-to-end test.
- End-to-end runs use background mode by default (`TREEPEEK_E2E_BACKGROUND`, set by the
  launcher): windows are transparent, click-through and never focused, and the app has no
  Dock icon, so a run never interrupts the person at the machine. Tests must not depend on
  the window having OS focus.
- Every bug fix comes with a test that fails without the fix.
- A test must be able to fail: assert behaviour, not that code ran.

## Commits and pull requests

- Conventional Commits, imperative subject: `type(scope): subject`, where scope is one of
  `main`, `core`, `preload`, `renderer`, `shared`, `ipc`, `build`, `test`, `docs`, or
  omitted for cross-cutting changes.
- One logical change per commit; failing or partial work may be committed on a work
  branch, never merged.
- No AI-agent attribution, generated-by lines or co-author trailers in commits or pull
  requests.
- A pull request says what changed, which checks ran with their results, and what is not
  verified.

## Review

When asked to review a change, use the `treepeek-review` skill
(`.agents/skills/treepeek-review/SKILL.md`). A review by the agent that wrote the change is
not independent; say so when that is the case.
