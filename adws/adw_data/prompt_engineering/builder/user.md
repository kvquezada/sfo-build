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

When the code is written, run the suite and confirm it is green before you
report:

```
npx nx run-many -t test
```

## Report

Respond with ONLY valid JSON matching `BuildOutput`. No prose before or after,
no code fence:

```json
{
  "status": "success",
  "summary": "<one sentence describing what you built>",
  "changed_files": ["apps/api/src/customers/customers.service.ts"],
  "artifacts": [],
  "commit_message": "<imperative one-line git subject for THE CODE YOU CHANGED — this is what the commit of your work will say>",
  "notes_for_next_agent": "<how a reviewer should verify this, and anything you decided that the plan did not specify>"
}
```

`changed_files` must be repo-relative paths that exist on disk right now.
