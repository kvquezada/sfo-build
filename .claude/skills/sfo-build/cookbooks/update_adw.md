# Modify an existing ADW chain

## Before editing

Read the file's docstring `Phases:` line and confirm the change the engineer
wants is a *sequencing* change. If it is about how an agent behaves, the edit
belongs in `adw_data/prompt_engineering/<agent>/`, not here. If it is about how
a mechanism works, it belongs in `adw_modules/`.

## Common changes

**Insert a phase.** Braces, description, `ph.done()`. Phase `seq` is assigned at
runtime, so nothing needs renumbering.

**Add a gate.** Gates compose — pass a list. Prefer adding one over widening an
existing gate's meaning; a gate named for what it checks stays readable in the
trace.

**Change a loop ceiling.** The named constant at the top.

**Make a phase retryable.** `retries: 1` on the phase params. That is the number
of *correction turns* inside the same Copilot session, not fresh phases. Because
`--session-id` is create-or-continue, a correction costs one turn with context
intact — not a cold restart.

## What not to do

- **Do not commit unverified work.** A commit phase belongs after the checks that
  justify it. The existing chains commit the plan early (it is a record of what
  was asked) and the code only after green + approved, and that asymmetry is
  deliberate.
- **Do not let an agent do a code phase's job.** If the step is a known command,
  it is `quality.ts` or `git_helper.ts`, not a prompt.
- **Do not reuse one agent's `commit_message` for another agent's diff.** Each
  envelope's message describes its own work product. That is why `PlanOutput`,
  `BuildOutput` and `DocumentOutput` each carry their own.
- **Do not widen `run.finish(accepted)`.** It is the one place the db, the banner
  and the exit code are settled together, so they cannot disagree.
