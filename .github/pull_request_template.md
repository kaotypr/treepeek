## Summary

<!-- What changed and why. Link the issue it fixes, if there is one. -->

## Testing

<!--
Which checks you ran and what they returned, word for word where it matters, and what is
not verified. A check you did not run is not a pass.
-->

- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] `bun run build` and `bun run test:e2e` (changes under `src/`)
- [ ] `bun run package` and `APP_TARGET=packaged bun run test:e2e` (packaging, fuses, the
  `app://` protocol, the preload, or a new runtime dependency)

Not verified:

## Checklist

- [ ] The change follows [AGENTS.md](https://github.com/kaotypr/treepeek/blob/main/AGENTS.md), including its security and
  git rules.
- [ ] Commits follow Conventional Commits (`type(scope): subject`), one logical change each.
- [ ] A bug fix comes with a test that fails without the fix.
- [ ] A new runtime dependency is justified, and `bun run licenses:check` passes.
- [ ] Documentation that describes the changed behaviour is updated.
