# Run and monitor an ADW

Read [prompting.md](prompting.md) first — a weak prompt wastes a whole run.

## The workflows

| Command | Chain | Use when |
|---|---|---|
| `npm run prompt` | engineer → one agent | a one-off question or task, any agent via `--agent` |
| `npm run scout` | engineer → scout | read-only recon; the repo must be untouched |
| `npm run plan` | engineer → planner | produce a spec and stop; prints an `adw_id` to continue from |
| `npm run quality` | engineer → quality | check a tree you are already holding. No agents, no cost |
| `npm run document` | changes → documenter | write up work that already happened, from its diff |
| `npm run build` | builder → test → commit | the plan already exists, or the task is obvious |
| `npm run bt` | builder → test ⟲ fix → commit | same, but the first attempt is not expected to be the last |
| `npm run br` | builder → review ⟲ revise → commit | correctness is a matter of intent, not of exit codes |
| `npm run pb` | plan → build → commit | a spike or scaffold: get the diff on record, skip the suite |
| `npm run pbt` | plan → build → test ⟲ fix → commit | real work, shape is clear, no review needed |
| `npm run pbtq` | plan → build → verify → test ⟲ fix → commit | green means more than the suite here — lint or typecheck gate too |
| `npm run sdlc` | plan → build → test ⟲ fix → review ⟲ revise → commit ×3 → document | the work is real and its shape is not obvious |

Pick by **what has to be true before the code lands**, not by how many phases
the row has. Each chain commits on its own acceptance criterion and nothing
else's: `pbt` on a green suite, `br` on the reviewer, `pbtq` on every block the
target configures, `pb` on neither. Two of them commit nothing at all —
`quality` and `document` only report.

Every one takes `--target NAME` and a prompt:

```bash
npm run sdlc -- --target api "add pagination to GET /customers"
npm run scout -- --target oms "where is order-stage enforced"
npm run plan -- --target api "add /health"            # prints adw_id
npm run build -- --target api --adw-id <id> "implement the plan"
```

`--adw-id` **joins** a session: the same handoff directory, the same per-agent
Copilot sessions, the phase sequence continuing rather than restarting. That is
how the short chains compose — `plan` then `bt` on the same id is `pbt` with the
engineer reading the spec in between.

`npm run document` takes one extra flag: `--base <ref>` names what the write-up
is measured from (`main` by default). It and `npm run quality` are also the two
chains that run on a dirty tree on purpose — `quality` spawns no agent at all,
and documenting after a build means the build is usually still uncommitted.

## Before launching

```bash
npm run doctor -- --target <name>
```

It checks the roster's prompts, probes each (model, thinking) pair, prints each
model's real tool dialect, and confirms the target's tree is clean. A dirty
target repo refuses to run — that is deliberate, because the permission backstop
must be able to tell the agent's writes from the engineer's.

## While it runs

The console prints the whole narrative live. From another shell:

```bash
npm run sessions                 # every run, newest first
npm run phases -- <adw_id>       # phase-by-phase, with gate results
npm run tail -- <adw_id>         # recent events
npm run tail -- <adw_id> --type tool_call
npm run procs                    # what is believed alive, and its pid
```

## Reading the outcome

A run ends with `✓ success` or `✗ fail`, and the two are decided by **two**
criteria: every phase must have passed, *and* the ADW's own acceptance test must
hold. They differ on purpose — a test phase that ran the suite did its job even
when the suite came back red, so the PHASE succeeds while the RUN must not.

A failed run leaves evidence, not a mess:
- the plan commit stands (it records what was asked)
- unverified code stays **uncommitted**, in the working tree, where the engineer
  can see it
- every prompt, raw event and envelope is under `~/.sfo-build/sessions/<adw_id>/`

If the engineer wants to retry, the working tree must be clean first — that is
their call, not yours. Show them `git status` and let them decide.
