# The roster

Nine agents, one roster, every target. There is no per-repo variant — the same
nine serve `api`, `front`, `oms` and anything else you register, which is why a
prompt or model improvement lands everywhere at once.

The roster lives in [`adws/adw_sfo_config/sfo.config.yaml`](adws/adw_sfo_config/sfo.config.yaml).
This file explains what is in it and why. To change it, read
[`cookbooks/update_roster.md`](.claude/skills/sfo-build/cookbooks/update_roster.md).

## Defaults

```yaml
defaults:
  coding_agent: copilot
  model: gemini-3.6-flash
  thinking: medium
  data_dir: ~/.sfo-build
  protected_files: []
```

An agent that omits `model` or `thinking` inherits these. `protected_files` is
empty on purpose: the factory now lives outside every target repo, so there is
no in-repo path to protect, and `permissions.ts` watches the whole factory tree
as a tripwire instead — where **any** change is a breach.

## Who they are

| Agent | Model | Thinking | Writes | Runs in |
|---|---|---|---|---|
| **planner** | claude-sonnet-5 | high | `specs/` | `plan` `pb` `pbt` `pbtq` `sdlc` |
| **builder** | gpt-5.6-terra | medium | *(target scope)* | `build` `bt` `br` `pb` `pbt` `pbtq` `sdlc` |
| **scout** | gemini-3.6-flash | low | — | `scout` `trace` `map` |
| **reviewer** | claude-sonnet-5 | high | — | `br` `sdlc` |
| **adversary** | grok-4.6 | high | — | `br --adversary` `sdlc --adversary` |
| **correlator** | claude-sonnet-5 | high | — | `trace` |
| **cartographer** | claude-sonnet-5 | high | — | `map` |
| **advisor** | claude-sonnet-5 | high | — | `trace` |
| **documenter** | claude-haiku-4.5 | none | `app_docs/` `docs/` `**/*.md` `*.md` | `document` `sdlc` |

`quality` and `ship` require no agents at all. Their `REQUIRED_AGENTS` is empty
and stays empty — a known command is code, not a judgement call, so those two
rows cost nothing but wall time.

Each agent also carries a `color`, which is what the visualizer draws its lane
in. It is presentation, not policy.

## What each one is for

**planner** — turns a request into a plan the builder can implement without
asking questions. Plans; never implements. Its `specs/` is repo-level even on a
scoped target: the record of what was asked for belongs in one place, not
scattered into whichever package the run happened to touch. This was learned the
hard way — with `subdir` vetoing the allowlist, a planner on a scoped target
wrote its spec, passed both gates, and had it deleted by the rollback for being
out of scope. An explicit `writes:` entry now wins outright.

**builder** — implements the plan and reports every file it changed. The only
agent whose output lands in your source: the documenter also carries `edit`,
but its `writes:` pins it to markdown. The builder's boundary is the target's
own scope rather than a list, which is the open grant.

**scout** — finds and reports where things live. Read-only with respect to the
repo; it still writes findings into the session handoff directory, which sits
outside every checkout and therefore outside the boundary entirely.

**reviewer** — asks whether each requirement was met. Judges; never fixes. Its
`approved` is the thing that gates the commit on `br` and `sdlc`.

**adversary** — asks the opposite question: what does this change do that nobody
asked for? Silent behaviour changes, a requirement met technically but not
practically, the unhandled path. Advisory — it cannot fail a run — but its
objections are merged into the envelope the builder revises against, so it can
cost a revision loop. Opt in with `--adversary`.

**correlator** — reads the per-repo scout reports and names the seam between
them. It opens no repo at all, which is exactly what lets one agent reason
across checkouts that none of them were allowed to see at once.

**cartographer** — the correlator's sibling on `map`. Same inputs, same
read-only boundary, opposite instruction: it describes the path and is allowed
to conclude that the two sides agree. It is a separate agent rather than a flag
because an agent told to find a problem finds one — asked neutrally, a
correlator once reported missing error handling it had inferred from silence in
reports whose authors were never asked about it.

**advisor** — proposes at most three candidate fixes for a traced issue, best
first, with trade-offs. Proposes; never implements. The order is the
recommendation; a fourth option is refused by the parser rather than argued
against in a prompt.

**documenter** — writes up a completed change from its diff.

## Three rules the roster encodes

### Vendor splits are load-bearing

The reviewer is Anthropic while the builder is OpenAI, and that is not
arbitrary: a reviewer sharing the builder's failure modes approves the builder's
mistakes. The adversary is a third vendor again (xAI) one step further out — it
exists to catch what the *reviewer* waves through, so sharing the reviewer's
family would cost most of what it is for. The correlator is a different vendor
from the scout for the same reason.

Three judges, three vendors, no shared blind spot. Changing any one of them is a
decision about all three.

### `tools:` is capability, `writes:` is boundary

Neither implies the other. `shell` runs anything and `write` reaches any path,
so the tool list is a statement of intent that nothing checks. `writes:` is what
`permissions.ts` actually enforces. That is why the reviewer and the adversary
carry both `shell` and `writes: []` — shell is there to read git, and the empty
list is what holds the line.

Three states, and they mean different things:

| `writes:` | meaning |
|---|---|
| absent | the default open grant, bounded by the target's `subdir` |
| `[]` | read-only with respect to the repo |
| a list | exactly these paths, and the list **wins over** `subdir` |

Tool names in the roster are the neutral vocabulary — `read write edit search
glob shell fetch subagent skill sql` — mapped per vendor in
[`adw_modules/tool_map.ts`](adws/adw_modules/tool_map.ts). An unmapped name is a
hard failure at validate time, never a silent drop.

### Some settings are measured, not preferred

The documenter's `thinking: none` is not a taste: `claude-haiku-4.5` rejects
every other level outright. Its `shell` is not decoration either — without it
the documenter cannot `mkdir` the directory its own task names, because `create`
does not make parent directories. It failed a real run that way and quietly
wrote its report into `COPILOT_HOME` instead.

Model availability is measured the same way. There is no `--list-models` and no
local catalog, so `npm run doctor` probes each **(model, thinking) pair** live
and caches the verdict for 14 days. A bad id costs ~5s and no premium request,
because it fails before any model call.

## Context ceilings

```yaml
models:
  claude-sonnet-5:   { context_window: 200000 }
  claude-opus-5:     { context_window: 200000 }
  claude-haiku-4.5:  { context_window: 200000 }
  gpt-5.6-terra:     { context_window: 400000 }
  gpt-5.6-luna:      { context_window: 400000 }
  gemini-3.6-flash:  { context_window: 1000000 }
  grok-4.6:          { context_window: 328000 }
```

These are **declared, not measured.** Copilot's `--context` is a tier, not a
number, and no catalog exposes a window size, so `context_window` on every
`agent_sessions` row is 0 and always will be. The trace UI draws its CONTEXT bar
against the numbers above and says so in the tooltip. Verify them before
trusting a percentage; a model with no row here shows its token count and no
percentage, which is the honest default.

## Checking the roster

```bash
npm run doctor                    # prompts, model × thinking probes, tool dialects
npm run doctor -- --target api    # + that target's tree is clean
```

`doctor` also prints each model's real tool dialect, because the **model**
chooses the dialect — `--available-tools` is an intersection filter, not a
promise. Asking for a tool a model lacks is harmless; asking for *only* such
tools leaves an agent unable to act with nothing explaining why. Expect one
standing warning: `gpt-5.6-terra` offers no `create` or `edit` and writes
through `bash`.
