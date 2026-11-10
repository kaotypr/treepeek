# Repository settings

Three settings of the hosted `kaotypr/treepeek` repository that the files in this repository
cannot hold. Each changes the repository on GitHub, so only an admin applies them, on
purpose. The commands use the [GitHub CLI](https://cli.github.com), logged in as a
repository admin (`gh auth status`).

| Setting                                    | Why                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Private vulnerability reporting            | `SECURITY.md` and the issue forms send security reports there.                                               |
| Read-only default token for GitHub Actions | A workflow gets write access only where it asks for it, and CI asks for none.                                |
| Ruleset on `main`                          | Every change reaches `main` through a pull request whose CI passed; `main` is never force-pushed or deleted. |

## Private vulnerability reporting

```sh
gh api --method PUT repos/kaotypr/treepeek/private-vulnerability-reporting
```

Check:

```sh
gh api repos/kaotypr/treepeek/private-vulnerability-reporting
# {"enabled":true}
```

## Read-only default token for GitHub Actions

```sh
gh api --method PUT repos/kaotypr/treepeek/actions/permissions/workflow \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=false
```

Check:

```sh
gh api repos/kaotypr/treepeek/actions/permissions/workflow
# {"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}
```

Workflows still declare `permissions: contents: read` themselves
(`.github/workflows/ci.yml`), so they stay read-only even if this setting changes.

## Ruleset on `main`

The ruleset requires a pull request and the four CI jobs to pass before anything reaches
the default branch, and blocks force-pushes and deletion. The required checks are the job
names in `.github/workflows/ci.yml`; renaming a job there means updating them here and on
GitHub. `integration_id` 15368 is GitHub Actions, so only a CI run can satisfy a check.

| Required check                   | CI job              |
| -------------------------------- | ------------------- |
| `Lint, typecheck and unit tests` | `checks`            |
| `Package and end-to-end tests`   | `package`           |
| `License allow-list`             | `licenses`          |
| `Electronegativity`              | `electronegativity` |

It asks for no approving review (`required_approving_review_count: 0`): with one maintainer,
a required review would block their own pull requests. Raise it when there is a second
maintainer. There are no bypass actors, so an admin goes through pull requests too.

Create it:

```sh
gh api --method POST repos/kaotypr/treepeek/rulesets --input - <<'EOF'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] }
  },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "Lint, typecheck and unit tests", "integration_id": 15368 },
          { "context": "Package and end-to-end tests", "integration_id": 15368 },
          { "context": "License allow-list", "integration_id": 15368 },
          { "context": "Electronegativity", "integration_id": 15368 }
        ]
      }
    }
  ]
}
EOF
```

Running the `POST` again creates a second ruleset. To change the existing one, find its id
and send the same body with `PUT`:

```sh
gh api repos/kaotypr/treepeek/rulesets --jq '.[] | select(.name == "main") | .id'
gh api --method PUT repos/kaotypr/treepeek/rulesets/<id> --input - <<'EOF'
{ ...the same body... }
EOF
```

Check:

```sh
gh api repos/kaotypr/treepeek/rulesets --jq '.[] | {id, name, enforcement}'
gh api repos/kaotypr/treepeek/rules/branches/main --jq '.[].type'
# deletion, non_fast_forward, pull_request, required_status_checks
```
