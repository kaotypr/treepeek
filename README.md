# Treepeek

Treepeek is a Mac app for reviewing the Git worktrees beneath a folder. Point it at a folder
and it finds every repository and checkout inside, puts them on a timeline, and shows what
each one changed in a side-by-side diff viewer, with per-file review marks so you can see
what you have already looked at. It is meant for the moment when many branches are in
flight at once: your own, a teammate's, or ones a coding agent made in its own worktrees.

- One window per scanned folder, with every checkout on a timeline.
- Comparisons for each worktree: everything it changed since it was first seen, its commits
  only, its uncommitted changes, what changed since the previous worktree, or against
  another base or its upstream. A file can also show only what changed since you viewed it.
- Per-file "Viewed" marks that add up to a reviewed worktree, and flag a file that changes
  after you viewed it.
- Live refresh as the worktrees change on disk.
- Read-only: Treepeek never writes to a repository, and it runs your system `git` with
  hardening so a repository's own configuration cannot run programs.

Treepeek is in early development (`0.1.0-alpha`). There are no releases yet.

## Requirements

- **A Mac with Apple Silicon** (M1 or later). There is no Intel build.
- macOS 13 (Ventura) or later.
- Git 2.36 or later. Treepeek uses the `git` already on your Mac (the Xcode Command Line
  Tools, Homebrew, or one you choose in Settings).

## Install

There are no releases yet. When there are, this section will cover:

- the DMG from [GitHub Releases](https://github.com/kaotypr/treepeek/releases), and
- a Homebrew cask.

Until then, build it from source.

## Build from source

You need [Bun](https://bun.sh) 1.4.3 or later and [Node.js](https://nodejs.org) 24, besides
Git. No Apple Developer account is needed: local builds are unsigned.

```sh
git clone https://github.com/kaotypr/treepeek.git
cd treepeek
bun install --frozen-lockfile
bun run package
```

The app is at `dist/mac-arm64/Treepeek.app`. Open it from there, or copy it to
`/Applications`. It is not signed with a Developer ID, so a copy that was downloaded rather
than built on your Mac has to be opened the first time with right-click › Open.

[CONTRIBUTING.md](CONTRIBUTING.md) explains running it in development, the tests, and how
changes are made.

## Security

Treepeek opens repositories it does not trust, so security reports matter. Please report a
vulnerability privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md); everyone taking
part follows the [code of conduct](CODE_OF_CONDUCT.md).

## License

Treepeek is licensed under the [Apache License, Version 2.0](LICENSE). Copyright 2026
Adhitya Yosua Sanjaya Andaria; see [NOTICE](NOTICE). The app also includes open-source
components under their own licenses, listed in Treepeek › About Treepeek ›
Acknowledgements.
