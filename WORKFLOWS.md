# The ADWs

An ADW is a deterministic TypeScript chain. It owns sequencing, retries and
acceptance; agents work inside bounded phases; code runs anything that is a
known command. **Agent proposes, code disposes.**

Every chain is built from three phase kinds — `engineer` (a human decision,
logged), `agent` (prompt in, typed envelope out, gates verified, writes bounded)
and `code` (a known command). A phase is born `fail`; only `ph.done()` earns
success, so any throw or early return leaves it failed.

The roster those agents come from is in [`ROSTER.md`](ROSTER.md). Registering
the repos they run against is in [`INSTRUCTIONS.md`](INSTRUCTIONS.md).

## Every chain at a glance

| Command | Phases | Agents | Commits | A run succeeds when |
|---|---|---|---|---|
| `prompt` | engineer → *any agent* | 1, your pick | — | every phase passed |
| `scout` | engineer → scout | scout | — | every phase passed |
| `trace` | engineer → scout ×N → correlate → advise | scout, correlator, advisor | — | every phase passed |
| `map` | engineer → scout ×N → map | scout, cartographer | — | every phase passed |
| `plan` | engineer → planner | planner | — | every phase passed |
| `build` | engineer → builder → code(test) → git | builder | 1 | the suite passed |
| `bt` | engineer → builder → code(test) ⟲ builder(fix) → git | builder | 1 | green within 3 fix attempts |
| `br` | engineer → builder → reviewer ‖ adversary ⟲ builder(revise) → git | builder, reviewer, (adversary) | 1 | the reviewer approved within 3 revisions |
| `pb` | engineer → planner → builder → git | planner, builder | 1 | every phase passed |
| `pbt` | engineer → planner → builder → code(test) ⟲ fix → git | planner, builder | 1 | green within 3 fix attempts |
| `pbtq` | engineer → planner → builder → code(verify) → code(test) ⟲ fix → git | planner, builder | 1 | verify **and** test clean within 3 attempts |
| `sdlc` | plan → commit → build → test ⟲ fix → review ‖ adversary ⟲ revise → commit → document → commit | planner, builder, reviewer, documenter, (adversary) | 3 | the suite and the review both came back clean |
| `quality` | engineer → code(quality) | none | — | every configured block passed |
| `document` | engineer → code(changes) → documenter | documenter | — | every phase passed |
| `ship` | engineer → code(branch) → code(push) → code(PR) | none | — | every phase passed |

Chains **compose rather than nest**: each row commits on its own acceptance
criterion and nothing else's. A row with no criterion — `finish()` with no
argument — is not being lenient; it makes no claim beyond "every phase either
passed or already failed the run", rather than inventing a test it never ran.

## Read-only

**`prompt`** — the smallest ADW: one agent, one prompt, traced end to end. Pick
the agent with `--agent`; the prompt may be a string or a path to a file.

```bash
npm run prompt -- --target oms "summarize this repo in one line" --agent scout
```

**`scout`** — read-only recon. The cheapest chain in the factory and the one
that proves enforcement: scout's `writes: []` means the repo must be
byte-identical afterwards, while its findings still land in the session handoff
directory outside the repo.

**`trace`** — follow one issue across several repos, then say what to do. The
reason `--target` learned to repeat, and the only chain that resolves more than
one repo.

```bash
npm run trace -- --target front --target api "why does the stage badge go stale"
```

Each phase still stands in exactly one checkout — one cwd, one write boundary,
nothing widened. What spans the repos is *code*: `hops_resolve` stands outside
every checkout and stats each claimed path against the repo it was claimed in,
so the correlator can propose a trail through trees it was never allowed to
open. The order you name targets in **is** the request path: the first is where
the request starts. It ends in two files in the session directory — `trace.md`
(what is, and where the two sides disagree) and `fixes.md` (at most three
options with their costs, best first).

**`map`** — the same chain asking the opposite question, and a separate chain
rather than a `--no-advise` flag on purpose. Measured on a real run: asked the
neutral question "how does an order stage change reach the UI", the correlator —
whose prompt tells it six times to name a seam — reported that the front had no
error handling for a rejected transition. It had inferred that from the scout
reports not mentioning any, by scouts who were never asked. The next agent read
the code and refuted it. So the cartographer is told the opposite: "they agree"
is a complete answer, and silence in a report is not evidence of absence.

Use `trace` when something is wrong, `map` when you want to learn the flow.

**`plan`** — produce a spec and stop. It prints an `adw_id`, and that is the
handle: pass it to `npm run build -- --adw-id <id>` and the builder rejoins the
same session directory and reads the same `plan.md`.

## Producing code

**`build`** — one shot: build, test once, commit if green.

**`bt`** — the same shape with a bounded repair loop (3 attempts), for work
where the first attempt is not expected to be the last. It is what `pbt` becomes
once a plan already exists.

**`br`** — build, then confirm it is what was asked for. Review is not testing
and neither question answers the other's: the suite asks "does it run", the
reviewer asks "is this the thing that was asked for" — reading the spec, reading
the code on disk, and ruling on each requirement one at a time. Use it when
correctness is a matter of intent rather than exit codes: config, copy, API
shape, a refactor that must not change behaviour.

**`pb`** — the one chain that commits work the suite never saw, and that is why
it exists rather than an oversight. A spike, a scaffold, a rename nothing covers
yet — work where the tests would answer a question nobody is asking. The commit
is the point: the diff goes on record, attributed and readable, instead of
sitting in a dirty tree.

**`pbt`** — the full starter chain. Only tested work gets committed; a red suite
leaves the tree uncommitted and exactly where you can see it.

**`pbtq`** — gates on everything the target registry knows how to run: lint,
typecheck and build first, then the suite. Use it when the repo's definition of
green is wider than its tests. Verify and test get their **own** phases, so a
lint failure and a test failure are distinguishable in the trace.

**`sdlc`** — three commits, three work products, three authors. The plan, the
code and the write-up each land in their own commit, and each message is the
words of the agent that produced it. No agent's sentence is ever reused for
another agent's diff. Fix loop is bounded at 3, the revision loop at 2, and a
revision that changed code triggers a retest.

## No agents at all

**`quality`** — the whole factory in miniature with the agents taken out: lint,
typecheck, build and test are known commands, so code runs them and the run
costs nothing but wall time. The argv comes from the target registry, and only
the operations that target actually configured are run — a target with none is a
hard error rather than a green tick nobody earned. A red block does **not** fail
its phase: the runner did its job. It fails the run.

**`ship`** — the last mile, on commits that already exist. Deliberately separate
from producing, because the two fail for unrelated reasons: a run whose tests
went red should leave nothing on a remote, and a push that fails because `gh` is
logged out says nothing about the code.

```bash
npm run ship -- --target api --dry-run    # derive and render, touch nothing
npm run ship -- --target api --draft --branch feature/pagination
```

| flag | |
|---|---|
| `--dry-run` | print the branch, title and body, then stop |
| `--branch N` | override the derived name |
| `--template P` | override the body template for this run |
| `--draft` | open the PR as a draft |
| `--no-pr` | branch and push, open nothing |
| `--no-rewind` | leave the local trunk where the run left it |

The branch name is **derived from the commits**, never asked of a model: `feat`
→ `feature/`, else `fix` → `fix/`, else `chore/`, slugged from the first commit
of the winning type. The PR title is that commit's subject, prefix intact, so a
squash-merge lands a conforming subject on the trunk. The body renders from
`adws/adw_data/templates/pull_request.md` — your file, edit it any time.

**`document`** — writes up work that already happened, from its diff. It uses
the documenter agent, but its guard is structural: capturing the change is a
*code* phase, and an empty diff throws there, before any agent is spawned. There
is nothing to document until something was built, and a subprocess can say so
for free instead of an agent discovering it at model prices. `--base` names the
ref the work is measured from, and the run records *which* interpretation it
used, because a diff is only as trustworthy as the thing it was taken against.

## Flags every chain shares

| flag | |
|---|---|
| `--target NAME` | required; the only flag that may repeat, and only on `trace` / `map` |
| `--adw-id ID` | **join** an existing session: same handoff dir, same per-agent Copilot sessions, phases continuing rather than restarting |
| `--adversary` | `br` and `sdlc` only — adds the second judge |
| `--ship` | `sdlc` and `pbtq` only — appends `ship` inside the verified block |

`--adw-id` is how the short chains compose: `plan`, then `bt` on the same id, is
`pbt` with you reading the spec in between.

> **`--adversary` and `--ship` go LAST.** The parser takes the next non-`--`
> token as a flag's value, so `--adversary "add pagination"` swallows your
> prompt and the run dies on "a prompt is required".

`--ship` is opt-in because a push is outward-facing in a way a local commit is
not, and it uses your own `gh` credentials rather than any the factory holds.

## Picking one

Pick by **what has to be true before the code lands**, not by how many phases
the row has.

- The suite is the question → `pbt`, or `bt` if the plan exists.
- Green means more than the suite → `pbtq`.
- Correctness is about intent → `br`.
- The diff belongs on record and tests would answer nothing → `pb`.
- The shape is not obvious and the work is real → `sdlc`.
- Nothing should change → `scout`, `trace`, `map`.

## Before and while it runs

```bash
npm run doctor -- --target api   # roster prompts, model probes, dialects, clean tree
```

A dirty target repo refuses to run. That is deliberate: the permission backstop
compares change-sets before and after each agent call, so it must be able to
tell the agent's writes from yours.

```bash
npm run sessions                 # every run, newest first
npm run phases -- <adw_id>       # phase-by-phase, with gate results
npm run tail -- <adw_id> [--type tool_call] [--limit 80]
npm run procs                    # what is believed alive, and its pid
npm run obs                      # the visualizer
```

## How a run ends

`✓ success` or `✗ fail`, decided by **two** criteria: every phase must have
passed, *and* the chain's own acceptance test must hold. They differ on purpose
— a test phase that ran the suite did its job even when the suite came back red,
so the phase succeeds while the run must not.

A failed run leaves evidence, not a mess:

- the plan commit stands — it records what was asked for
- unverified code stays **uncommitted**, in the working tree
- every prompt, raw event and envelope is under `~/.sfo-build/sessions/<adw_id>/`

Retrying needs a clean tree first. That is the engineer's call, not the
factory's.
