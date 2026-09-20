# Build Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

### scope

Target `{{target}}` — repo root `{{repo_root}}`, writable scope `{{subdir}}`.

You may READ anything under `{{repo_root}}`; a monorepo change often needs to.
You may WRITE only inside `{{subdir}}`. A write outside it is rolled back and
fails this phase.

## Task

Implement the work described in `prompt`, guided by `previous_envelope` if one
is present.

If `previous_envelope` is a `VerifyOutput` with `passed: false`, its `failures`
are verbatim command output. Trust that output over any summary of it,
including your own from a previous turn. Fix every failure listed.

When the code is written, run the suite:

```
npx nx run-many -t test
```

Anything your own change broke, fix before reporting. A failure that predates
your change and is unrelated to it is not yours to chase — note it and report
success; the workflow's repair loop will hand it back to you with the verbatim
output if it matters.

## Report

Respond with ONLY valid JSON matching `BuildOutput`. No prose before or after,
no code fence:

```json
{
  "status": "success",
  "summary": "<one sentence describing what you built>",
  "changed_files": ["apps/api/src/customers/customers.service.ts"],
  "artifacts": [],
  "commit_message": "<Conventional Commits subject for THE CODE YOU CHANGED — e.g. 'feat(customers): add cursor pagination'>",
  "notes_for_next_agent": "<how a reviewer should verify this, and anything you decided that the plan did not specify>"
}
```

`changed_files` must be repo-relative paths that exist on disk right now.

### Commit subject

`commit_message` follows Conventional Commits v1.0.0 — `<type>(<scope>): <description>`,
with `<type>` one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, `revert`, and `(<scope>)` optional. Breaking change: `!`
before the colon.

The subject is the whole message. Write no body and no footers — anything after
the first line is dropped before the commit is made.

