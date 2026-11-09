# Diff viewer: `@pierre/diffs`

**Decision:** Treepeek's diff viewer is **`@pierre/diffs` 1.6.4**, behind the `DiffView`
interface in `src/renderer/diff-view/`. CodeMirror 6, the fallback, is not used. It
rendered the trial's thin proof and was then removed.

**Decided:** 2026-11-09, after a time-boxed trial against the seven pass criteria in the
diff-pipeline design. The decisive criteria are 1, 2, 5 and 6: a failure there that could
not be fixed in the time box would have meant CodeMirror 6. `@pierre/diffs` passed all
four. Two of the passes depend on Treepeek code around the library, described below.

## Results

| #   | Criterion              | Result                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Input                  | **Pass**                      | Renders from `FileDiff` (git hunks plus both texts) in split, unified and resulting-file modes. Unit tests check, for every fixture, that the library's hunks equal git's (starts, counts, and the exact removed and added lines). End-to-end tests check that every fixture shows every line git named, in every mode.                                                                                            |
| 2   | Large files            | **Pass** (with 20-row chunks) | `big-20k` highlighted: first paint 46–134 ms; worst main-thread frame while scrolling 18–31 ms; median frame interval 16.7 ms (no dropped frames at 60 Hz). `patch-50k` with highlighting off: first paint 90–111 ms. Numbers are below.                                                                                                                                                                           |
| 3   | Side-by-side scrolling | **Equivalent, with a gap**    | Each side has its own horizontal scroll container and the sides share one vertical scroll. The library keeps the two horizontal positions in step, and no option turns that off. Lines are not independently scrollable per side as in the prototype.                                                                                                                                                              |
| 4   | Resulting file         | **Pass** (custom model)       | The whole right-side file with right-side line numbers; added lines carry a change bar and background. Built as a diff of the right side against itself minus its added lines (`toPierreDiff(…, "result")`), so it uses the same virtualized renderer.                                                                                                                                                             |
| 5   | Themes                 | **Pass** (with a CSP shim)    | Light and dark switch on the app's `.dark` class with no new highlight request: the end-to-end test counts worker requests across a flip. This works only with `csp-styles.ts`, because the library's own theme CSS and token colors are blocked by Treepeek's CSP (see "The CSP finding").                                                                                                                        |
| 6   | File switching         | **Pass**                      | Ten runs of 50 rapid file and mode switches, each ending on a different file and mode, all show the right content: every expected line is on screen and nothing from another file is. The adapter drives the library's classes directly, with one instance per (file, layout), torn down before the next exists. The open re-render issues (#876, #442, #478) concern reusing an instance, so they did not appear. |
| 7   | License                | **Pass**                      | `@pierre/diffs` 1.6.4 is Apache-2.0 (`LICENSE.md`, "Copyright 2025 Pierre Computer Company"). The package itself has no NOTICE file, but two of its dependencies do; see "Notices".                                                                                                                                                                                                                                |

## The CSP finding

Treepeek's CSP allows styles only from the app (`style-src 'self'`, no `'unsafe-inline'`).
`@pierre/diffs` writes its theme CSS into a `<style>` element inside its shadow root, and
every syntax token's colors into an inline `style` attribute. The CSP blocks both. Without
help, the diff renders unthemed (light in dark mode) and without syntax colors. The
library's `useCSSClasses` option looks like the answer, but in 1.6.4 it is accepted and
never used.

`src/renderer/diff-view/pierre/csp-styles.ts` re-applies the same styles through the
CSSOM, which the CSP does not govern:

- the text of each `<style>` element goes into an adopted (constructed) stylesheet;
- each blocked `style` attribute is set again through `element.style`.

It adds no styles of its own; only the library's declarations apply. The CSP is unchanged.

**The cost.** Chromium still reports every blocked attribute as a violation while it parses
the library's HTML, and that is slow. With the library's default chunk size (50 rows),
scrolling `big-20k` in split mode produced frames of 57–60 ms of main-thread work, about
32 ms of it in HTML parsing. In an uncommitted experiment that allowed inline styles in
the lab build, the parsing dropped to about 1.5 ms and the worst frame to 23–29 ms. The fix
kept here is the library's own `hunkLineCount` metric set to 20 rows per chunk
(`VIRTUAL_METRICS` in `PierreDiffView.tsx`), which brings the worst frame to 18–31 ms
under the strict CSP.

**Not decided here:** loosening the CSP. Allowing inline style attributes only
(`style-src-attr 'unsafe-inline'`) would remove the violation cost and most of the shim.
Script rules would be unchanged, and `img-src`/`font-src` would still block remote URLs
in CSS. That is a change to a security rule in `AGENTS.md`, so a person decides it.
Treepeek works without it.

Each blocked attribute is also logged to the DevTools console as a CSP error, so the
console of a window showing diffs is noisy.

## Performance (criterion 2)

Measured with `TREEPEEK_PERF=1 bun run test:e2e tests/e2e/diff-lab.perf.spec.ts` on the lab
build, three runs. Machine: MacBook Air, Apple M4 (10 cores), 16 GB, macOS 27.0, built-in
60 Hz display.

- _First paint_ is the time from selecting the file to its first rows on screen.
- _Highlighted_ is the time to the first syntax-colored token. It runs in the worker
  after the plain first paint.
- During a 5-second wheel scroll, _frame interval_ comes from `requestAnimationFrame`.
  At 60 Hz, 16.7 ms is one refresh.
- _Main thread per frame_ is the time in `RunTask` between consecutive
  `BeginMainThreadFrame` events, from a Chromium trace.

| Fixture     | Mode           | First paint (ms) | Highlighted (ms) | Frame interval median / max (ms) | Main thread per frame median / p95 / max (ms) |
| ----------- | -------------- | ---------------- | ---------------- | -------------------------------- | --------------------------------------------- |
| `big-20k`   | split          | 60–62            | 1,800–1,884      | 16.7 / 17.7–17.8                 | 0.4–0.6 / 2.5–3.2 / 27.3–30.9                 |
| `big-20k`   | unified        | 104–134          | 104–134 (cached) | 16.7 / 17.8–33.4                 | 0.6–0.7 / 3.0–3.3 / 21.3–30.7                 |
| `big-20k`   | resulting file | 46–52            | 1,659–1,717      | 16.7 / 17.7                      | 0.7–0.9 / 14.4–14.6 / 18.3–20.0               |
| `patch-50k` | split          | 92–110           | off              | 16.7 / 17.7                      | 0.9–1.0 / 14.8–15.5 / 17.8–19.5               |
| `patch-50k` | unified        | 90–99            | off              | 16.7 / 17.7                      | 0.9–1.0 / 9.4–10.4 / 16.8–19.9                |

The thresholds were: for `big-20k` with highlighting, median frame ≤ 16 ms, worst ≤ 50 ms,
first paint ≤ 300 ms; for `patch-50k` with highlighting off, first paint ≤ 1 s. The
"median frame" is read as main-thread work per frame. The frame-interval median cannot go
below one refresh, and 16.7 ms means no frame was dropped.

- `big-20k` is 19,994 lines a side (about 570 KB) with 41 scattered edits.
- In split and unified modes, unchanged runs are collapsed, so the scroll covers the
  hunks. The resulting-file mode scrolls the whole 20,000-line file.
- Unified mode reused the split view's highlight from the worker cache, which is why its
  highlight time equals its first paint.
- `patch-50k` rewrites all 25,000 lines of a file: a 50,000-line patch, past the
  highlighting limit.

## Size limits (`DIFF_LIMITS`)

The design's starting values **stand**, and `DIFF_LIMITS` in `src/shared/constants.ts`
already matches them:

| Limit                        | Value                | What the trial showed                                                                                                                                                                            |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Patch bytes                  | 5 MB                 | The 50,000-line patch (about 3 MB) paints in about 100 ms and scrolls with no dropped frames. 5 MB is about 1.7 times that.                                                                      |
| Full content per side        | 2 MB or 50,000 lines | 25,000-line sides of about 1.5 MB render and scroll without strain; virtualization keeps the DOM small whatever the length.                                                                      |
| Syntax highlighting per side | 1 MB or 20,000 lines | 20,000 lines (about 570 KB a side) highlight in about 1.7–1.9 s in the worker, after an immediate plain paint, with the UI responsive. At 1 MB, expect about 3 s, extrapolated and not measured. |

Two library limits also apply, and the adapter sets them:

- **Characters tokenized per file.** The library's default (`tokenizeMaxLength`) is
  100,000 characters, which would silently turn highlighting off far below Treepeek's
  limit. The adapter raises it to `DIFF_LIMITS.highlightBytes`.
- **Line length.** Lines longer than 1,000 characters are not tokenized
  (`tokenizeMaxLineLength`, left at its default). The `long-lines` fixture shows those
  lines plain inside an otherwise highlighted file.

## The fallback's thin proof

CodeMirror 6 (`@codemirror/merge` 6.12.3) rendered `small-edit` in split mode.

- **Same diff as git.** `MergeView` was given both texts and git's hunks as its diff
  (`diffConfig.override`), so it showed git's changes and git's collapsed runs.
- **CSP.** It was mounted in a shadow root, where CodeMirror loads its styles as
  constructed stylesheets, and logged no CSP violations. On the document itself it writes
  `<style>` tags, which the CSP blocks.
- **Where it is.** The proof is in this repository's history (`feat(renderer): add a thin
  CodeMirror 6 proof for the viewer trial`) and was removed with its packages once the
  decision was made.
- **Not compared.** Highlighting, large files and the other criteria were not measured
  for CodeMirror. The plan builds them only if `@pierre/diffs` fails a decisive criterion.

## Notices (for the third-party notices list)

These are bundled into the renderer with the viewer:

| Package                                       | Version                                   | License      | NOTICE                                                                                 |
| --------------------------------------------- | ----------------------------------------- | ------------ | -------------------------------------------------------------------------------------- |
| `@pierre/diffs`                               | 1.6.4                                     | Apache-2.0   | none                                                                                   |
| `@pierre/theme`                               | 2.0.0                                     | Apache-2.0   | `NOTICE.md`: credits `primer/github-vscode-theme` (MIT)                                |
| `@pierre/theming`                             | 1.0.2                                     | Apache-2.0   | none                                                                                   |
| `@pierre/highlights`                          | 0.4.0                                     | Apache-2.0   | `NOTICE.md`: licenses of the bundled community themes                                  |
| `shiki`, `@shikijs/*`                         | 4.6.0 (`@shikijs/vscode-textmate` 10.1.0) | MIT          | none; the grammars in `@shikijs/langs` come from many sources under their own licenses |
| `diff`                                        | 9.0.0                                     | BSD-3-Clause | none                                                                                   |
| `hast-util-to-html`                           | 9.0.5                                     | MIT          | none                                                                                   |
| `lru_map`                                     | 0.4.1                                     | MIT          | none                                                                                   |
| `oniguruma-to-es`, `regex`, `regex-recursion` | 4.3.6, 6.1.0, 6.0.2                       | MIT          | none                                                                                   |

Both NOTICE files must ship in Treepeek's notices. The grammar licenses need checking
when that list is generated.

## Known gaps and follow-ups

- **Horizontal scroll (criterion 3).** Per-side independent horizontal scroll needs the
  library's scroll sync turned off. It has no option for that, and the only way is to
  reach into a protected member. The review screen should decide whether linked
  horizontal scroll, or `overflow: "wrap"`, is acceptable.
- **Bundle size.** The highlight worker and every Shiki grammar are bundled, and
  `out/renderer` grows to about 11 MB (405 files). Grammars load lazily, so this is disk
  and package size, not memory. Limiting the bundled languages is a possible follow-up.
- **Contrast.** Diff backgrounds come from the app's color tokens through the library's
  override variables (`pierre/pierre.css`). They have not yet been checked for WCAG AA
  against the pierre syntax themes.
- **Highlight latency.** Large files show plain text first and gain colors about 2 s
  later. The review screen may want a quiet indicator while that happens.
- **Library internals.** The adapter relies on `@pierre/diffs` writing styles to a
  `<style>` element and `style` attributes in its shadow root. A library upgrade must
  re-run the diff lab's end-to-end tests, which fail visibly if theming or highlighting
  stops applying.

## How to reproduce

```sh
bun run build && bun run build:lab
bun run test:e2e tests/e2e/diff-lab.spec.ts
TREEPEEK_PERF=1 bun run test:e2e tests/e2e/diff-lab.perf.spec.ts   # writes test-results/diff-viewer-perf.json
```

The diff lab opens in `bun run dev` (View → Open Diff Lab, or `#diff-lab`) and in the lab
build. Only the lab build runs under the real CSP: the dev server allows inline styles, so
it cannot show the CSP finding above. `bun scripts/make-diff-fixtures.ts --large --out out-lab/renderer/lab-fixtures` adds
the large fixtures to a lab build.
