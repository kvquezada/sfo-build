# sfo-build

A multi-repo AI software factory. Deterministic TypeScript owns sequencing,
retries and acceptance; GitHub Copilot agents work inside bounded phases; typed
Zod envelopes carry context across seams; every event streams to SQLite as it
happens.

**Agent proposes, code disposes.**

```bash
npm install
npm run doctor                                          # validate the roster, live

npm run scout -- --target api  "where is order-stage enforced"
npm run sdlc  -- --target api  "add pagination to GET /customers"
npm run trace -- --target front --target api  "why does the stage badge go stale"

npm run sessions ; npm run phases -- <id> ; npm run tail -- <id>
```

The visualizer is its own Next.js app with its own dependencies — the root
`npm install` does not cover it:

```bash
npm --prefix apps/visualizer install   # once
npm run obs                            # http://localhost:4317
```

It needs Node ≥ 22.5 (`node:sqlite`) and reads `~/.sfo-build/sfo.db`, which
exists only after the first run. `SFO_DB`, `SFO_SESSIONS` and `SFO_CONFIG`
override where it looks.

Setting up from scratch, or pointing this at another repo?
[`INSTRUCTIONS.md`](INSTRUCTIONS.md).

## Team setup

The repo is the part everyone shares; everything about *your* repos stays on
your machine.

| | where | shared |
|---|---|---|
| engine, chains, roster, prompts | this repo | yes — through PRs |
| targets | `~/.sfo-build/targets.yaml` | no — paths are per machine |
| personal briefs | `~/.sfo-build/briefs/<brief>.md` | no |
| team briefs | `adws/adw_data/prompt_engineering/_briefs/<brief>.md` | yes — through a PR |

A fresh clone has no targets and no briefs, and that is a working state.

```bash
gh repo clone kvquezada/sfo-build ~/Workspace/sfo-build
cd ~/Workspace/sfo-build && npm install
copilot --version        # logged in with your own account; usage bills to your plan
npm run doctor           # probes every roster model against YOUR Copilot plan
claude                   # then: /sfo-build install
```

`/sfo-build install` walks the rest: registering a repo (the registrar when it
has a suite you'll build against, a hand-written row when it is read-only), and
optionally a brief — written by you or drafted from a scout, confirmed by you
before it is saved, personal or team. A brief reaches every agent on that repo
and no gate checks it, so team briefs land through review;
[`_briefs/README.md`](adws/adw_data/prompt_engineering/_briefs/README.md) has
the rules.

If `doctor` reports a roster model your plan doesn't include, raise it with the
team rather than editing the roster in place — the roster is shared.

## What it is

Three phase kinds, one primitive:

- **engineer** — a human decision, logged.
- **agent** — prompt in, typed envelope out, gates verified, writes bounded.
- **code** — a known command. A test runner is a command, not a judgement call.

A phase is born `fail`; only `ph.done()` earns success, so any throw or early
return leaves it failed. Every claim an agent makes — the files it wrote, the
artifacts it produced, the paths it touched — is checked against the filesystem
before anything downstream believes it.

## Workflows

| Command | Chain |
|---|---|
| `prompt` | one agent, one prompt |
| `scout` | read-only recon |
| `trace` | scout ×N repos → correlate → advise. Read-only, crosses checkouts |
| `map` | scout ×N repos → map. Same, for "how does this work" |
| `plan` | a spec, then stop |
| `build` | build → test → commit |
| `bt` | build → test ⟲ fix → commit |
| `br` | build → review ⟲ revise → commit |
| `pb` | plan → build → commit (no suite — deliberate) |
| `pbt` | plan → build → test ⟲ fix → commit |
| `pbtq` | plan → build → verify → test ⟲ fix → commit |
| `quality` | lint / typecheck / build / test. No agents |
| `document` | diff → write-up |
| `sdlc` | plan → build → test ⟲ fix → review ⟲ revise → commit ×3 → document |
| `ship` | branch → push → pull request. No agents |

They compose rather than nest: each row commits on its OWN acceptance criterion
and nothing else's. `pbt` gates on the suite, `br` on the reviewer, `pbtq` on
every block the target configures, `pb` on neither — for a spike whose diff
belongs on record even though the tests would answer a question nobody asked.

`sdlc` produces three commits from three authors — the spec, the code and the
write-up each in their own commit, each message written by the agent that
produced that work.

`trace` is the only row that resolves more than one repo, and `--target` is the
only flag that may repeat. Each phase stands in exactly one checkout — one cwd,
one write boundary, nothing widened — and the order you name them in IS the
request path: the first is where the request starts. What actually spans the
repos is code, not an agent: `hops_resolve` stands outside every checkout and
stats each claimed path against the one it was claimed in, so the correlator
proposes a trail through trees it was never allowed to open and the harness
walks it. It ends in two files in the session handoff directory — `trace.md`,
what IS and where the two sides disagree, and `fixes.md`, at most three options
with their costs. The order of those options is the recommendation; there is no
separate field to disagree with it, and a fourth option is refused by the parser
rather than asked against in a prompt. Nothing is written to any repo.

`map` is the same chain asking the opposite question, and the split is
deliberate rather than a flag. The correlator's prompt tells it six times to
name a seam, and an agent told to find a problem finds one: asked the neutral
question "how does an order stage change reach the UI", it reported that the
front had no error handling for a rejected transition — inferred from the scout
reports not mentioning any, by scouts who had never been asked. The next agent
read the code and refuted it. So the cartographer is told the opposite, in the
words that matter: "they agree" is a complete answer, and silence in a report is
not evidence of absence. Use `trace` when something is wrong and `map` when you
want to learn the flow.

`ship` is the last mile, and it runs on commits that already exist. The branch
name is derived from them rather than asked of a model — `feat` → `feature/`,
else `fix` → `fix/`, else `chore/`, slugged from the first commit of the winning
type — and the PR title is that commit's subject, so a squash-merge lands a
conforming subject on the trunk. The body comes from
`adws/adw_data/templates/pull_request.md`, which is the operator's file to edit.
Per target, `base_branch` names the trunk it branches from and aims at.

```bash
npm run ship -- --target api --dry-run   # derive and render, touch nothing
npm run ship -- --target api
npm run sdlc -- --target api "..." --ship
```

`--ship` appends it to `sdlc` and `pbtq`, inside their verified block. Opt-in:
a push is outward-facing in a way a local commit is not, and it uses your own
`gh` credentials rather than any the factory holds.

`--adversary` adds a second judge to `br` and `sdlc`. The reviewer asks whether
each requirement was met; the adversary asks what the change does that nobody
asked for — silent behaviour changes, a requirement met technically and not
practically, the unhandled path. It runs on a third vendor
(`grok-4.6`, against the builder's `gpt-5.6-terra` and the reviewer's
`claude-sonnet-5`) and it runs **alongside** the reviewer, not after it: both
are given `--add-dir` onto the session directory, so a second judge that went
second would find the first one's `review.md` and anchor on it.

```bash
npm run br -- --target api "add pagination to GET /customers" --adversary
```

Its verdict is advisory. Objections from both judges are merged into the one
envelope the builder revises against, so the adversary can cost a revision
loop — but the commit still turns on the reviewer's own approval, and a run
that commits over an unresolved objection says so on the console. Like
`--ship`, the flag goes LAST: the parser takes the next non-`--` token as a
flag's value, so `--adversary "add pagination"` eats your prompt.

[`WORKFLOWS.md`](WORKFLOWS.md) has every chain in full — its phases, which
agents it needs, how many commits it makes, what its loop bounds are, and the
exact condition each one calls success.

## Roster

Nine agents, one roster, every target — there is no per-repo variant, so a model
or prompt improvement lands everywhere at once.

| | |
|---|---|
| **planner** claude-sonnet-5 | plans; never implements. Writes `specs/` |
| **builder** gpt-5.6-terra | implements the plan. The only one that writes source |
| **scout** gemini-3.6-flash | finds where things live. Changes nothing |
| **reviewer** claude-sonnet-5 | was each requirement met? Gates the commit |
| **adversary** grok-4.6 | what does this do that nobody asked for? Advisory |
| **correlator** claude-sonnet-5 | names the seam between two repos' scout reports |
| **cartographer** claude-sonnet-5 | describes the flow instead of hunting a fault |
| **advisor** claude-sonnet-5 | at most three ranked fixes, with costs |
| **documenter** claude-haiku-4.5 | writes up a change from its diff |

The vendor splits are load-bearing: a reviewer sharing the builder's failure
modes approves the builder's mistakes, and the adversary is a third vendor again
because it is there to catch what the *reviewer* waves through. `tools:` is
capability, `writes:` is boundary, and neither implies the other.

[`ROSTER.md`](ROSTER.md) has the whole thing — what each agent is for, what the
three `writes:` states mean, and which settings were measured rather than
chosen.

## Targets

One install drives many repos. A target is a row in a flat registry that lives
**on your machine**, at `~/.sfo-build/targets.yaml` — never in this repo, so a
teammate's paths never reach yours:

```yaml
targets:
  - name: api
    path: ~/Workspace/personal/oms
    subdir: apps/api                      # bounds WRITES, never reads
    test: [npx, nx, run-many, -t, test]   # real argv, verified before recording
    lint: [npx, nx, lint, api]
```

```bash
npm run install-target -- --path ~/Workspace/personal/oms --name api --subdir apps/api
```

The registrar runs the commands before it will record them. A test command that
has not been seen exit 0 is a placeholder, and a placeholder that exits 0 is
believed by every phase downstream.

Registering is the only install there is — nothing is copied into the target
repo, and per-repo factory variants are a known impossibility rather than an
oversight. [`INSTRUCTIONS.md`](INSTRUCTIONS.md) walks a full example: several
repos registered at once, what the registrar refuses, and what each agent call
actually looks like when it reaches Copilot.

## Layout

The factory and its runtime are **separate trees**, and that is load-bearing:

```
~/Workspace/sfo-build/     FACTORY — granted to no agent, ever
  adws/adw_modules/          the engine
  adws/adw_*.ts              the chains
  adws/adw_sfo_config/       roster (targets are per machine)
  adws/adw_data/prompt_engineering/
  apps/visualizer/
  .claude/skills/sfo-build/

~/.sfo-build/              RUNTIME — outside git, granted narrowly
  id/<agent>/                --add-dir (that agent only)
  sessions/<adw_id>/         --add-dir (that run only)
  targets.yaml               this machine's target registry
  briefs/<brief>.md          personal briefs (win over the team's)
  sfo.db · locks/
```

Agents must be able to write handoff artifacts, so the session directory has to
be `--add-dir`'d — and `--add-dir` grants a whole tree. If the runtime sat under
the factory, every agent would have write access to the engine and to the
prompts that grade it.

## Permissions

Prevent **and** detect.

*Prevent* is the Copilot path sandbox, and it is the strong half: an attempt to
write outside the working directory is refused by the harness, including through
`bash`. It holds only while nothing passes `--allow-all-paths`, `--allow-all` or
`--yolo`, which this codebase never constructs.

*Detect* is the backstop. Both the target repo and the factory tree are
fingerprinted before each agent call and compared afterwards. Anything an agent
introduced outside its `writes:` allowlist is rolled back and the phase dies;
any change at all inside the factory tree is a tripwire, because no agent is
ever granted it.

## Development

```bash
npm test          # bun test
npm run typecheck
```

Measured harness behaviour — model availability, tool dialects, reasoning-effort
support, the event stream, what the sandbox actually refuses — is written down in
[`.claude/skills/sfo-build/references/copilot.md`](.claude/skills/sfo-build/references/copilot.md).
Read it before assuming anything about the CLI.
