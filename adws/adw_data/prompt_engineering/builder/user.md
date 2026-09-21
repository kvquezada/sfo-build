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

If `previous_envelope` is a `ReviewOutput`, a judge has already read your work
and this turn is a REVISION, not a fresh build. `prompt` is still the original
ask, unchanged — it is context, not the task. The task is:

- **Close every item in `blocking`.** Each one is a condition of the commit.
- **Close every finding with `met: false`.** Its `evidence` says what is missing
  or where the gap is.
- An item prefixed `[adversary]` comes from the second judge — something the
  change does that nobody asked for. Treat it exactly like the rest.
- If you believe an item is wrong, say so in `notes_for_next_agent` with your
  reasoning and change nothing for it. Do not silently skip it: the same judge
  reads the tree again after this turn, and an unexplained miss costs the run a
  whole round to rediscover.

Re-run the suite afterwards. A revision that closes a review finding and breaks
a test has not closed anything.

When the code is written, run the suite with this target's registered test
command, exactly as written:

```
{{test_command}}
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

