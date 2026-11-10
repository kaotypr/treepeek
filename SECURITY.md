# Security policy

## Reporting a vulnerability

Report security problems privately through GitHub's private vulnerability reporting:

1. Open [Report a vulnerability](https://github.com/kaotypr/treepeek/security/advisories/new)
   (the repository's **Security** tab › **Report a vulnerability**).
2. Describe the problem, its impact, and how to reproduce it.

Please do not open a public issue, pull request or discussion about it, and do not share
details elsewhere until a fix is released. The report stays visible only to you and the
maintainer, who will reply on it, work out a fix with you there, and publish an advisory
when the fix is out. Say in the report whether and how you would like to be credited.

A good report includes:

- the Treepeek version (Treepeek › About Treepeek, or the commit of a source build), your
  macOS version, and your git version (Settings › Git);
- the smallest way to reproduce it. For a malicious repository, a script that builds it
  with `git` commands is the most useful form;
- what an attacker gains.

## Why this matters for Treepeek

Treepeek's job is to open folders full of repositories it has no reason to trust: clones
from anywhere, branches from pull requests, worktrees made by coding agents. Everything in
such a repository is controlled by whoever made it: its git configuration, attributes and
hooks, its file names, symlinks and contents, its commit messages. Treepeek runs your
system `git` on it and shows the results in an Electron app.

It is built to stay safe when it does: it only reads (never writes) repositories, it
switches off the parts of git configuration that can run programs, it accepts only paths
inside the folder it scanned, and its windows are sandboxed with a strict content security
policy. [AGENTS.md](AGENTS.md) lists these rules in full. A way around any of them is a
vulnerability. For example, a repository or folder that makes Treepeek:

- run a program, through git configuration, filter drivers, hooks or anything else;
- write to a repository or anywhere else on disk;
- read or show a file outside the folder that was scanned, for example through a symlink;
- run script or load remote content in a Treepeek window, for example through a file name,
  a commit message or file contents;
- open a URL or an app, or reach anything beyond the IPC contract, from a window.

Problems in Git itself belong to the [Git project](https://git-scm.com/community), and
problems in Electron or Chromium to [Electron](https://github.com/electron/electron/security/policy).
If you are not sure where something belongs, report it here.

## Supported versions

Treepeek is in early development and has no stable release yet. Security fixes go into
`main` and the next release; only the latest release is supported.
