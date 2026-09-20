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
| `npm run ship` | branch → push → pull request | work is committed and ready for a reviewer. No agents, no cost |

Pick by **what has to be true before the code lands**, not by how many phases
the row has. Each chain commits on its own acceptance criterion and nothing
else's: `pbt` on a green suite, `br` on the reviewer, `pbtq` on every block the
target configures, `pb` on neither. Two of them commit nothing at all —
`quality` and `document` only report, and `ship` commits nothing because it runs
on commits that already exist.

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

## Shipping

`npm run ship` is the last mile: it takes commits that already exist and puts
them in front of a reviewer.

```bash
npm run ship -- --target api --dry-run   # derive and render, touch nothing
npm run ship -- --target api
npm run ship -- --target api --draft --branch feature/pagination
```

| flag | |
|---|---|
| `--dry-run` | print the branch, title and body a real run would produce, then stop |
| `--branch N` | override the derived name |
| `--template P` | override the body template for this run |
| `--draft` | open the PR as a draft |
| `--no-pr` | branch and push, open nothing |
| `--no-rewind` | leave the local trunk where the run left it |

The branch is **derived from the commits**, never from a model: `feat` →
`feature/`, else `fix` → `fix/`, else `chore/`, and the slug comes from the
first commit of the winning type. A `docs:` commit never names the branch. A
name already taken gets the `adw_id` appended.

The PR title is that same commit's subject, conventional prefix intact, so a
squash-merge lands a conforming subject on the trunk. The body is rendered from
`adws/adw_data/templates/pull_request.md` — **your file, edit it any time**, no
code change. Placeholders: `{{title}} {{commits}} {{stat}} {{files}}
{{file_count}} {{insertions}} {{deletions}} {{docs}} {{adw_id}} {{target}}
{{base}} {{branch}} {{remote}}`.

The range is always `<remote>/<base_branch>..HEAD`, so it reads correctly while
you are standing on the trunk — which is where the chains leave you. Set
`base_branch` per target in the registry; it defaults to `master`.

Because the chains commit onto the trunk, after the branch is cut the local
trunk still carries the work. So once the push succeeds, `ship` moves the local
base ref back onto its remote (`git branch -f <base> <remote>/<base>`) — nothing
is lost, the commits are on the pushed branch. `--no-rewind` opts out.

Already standing on a feature branch? `ship` pushes that one rather than cutting
another.

`--ship` appends all of this to `npm run sdlc` and `npm run pbtq`, inside their
`verified` block:

```bash
npm run sdlc -- --target api "add pagination" --ship
```

Opt-in, because a push is outward-facing in a way a local commit is not. It uses
your own `gh` credentials and holds none of its own.

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
