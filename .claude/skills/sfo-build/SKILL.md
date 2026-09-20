---
name: sfo-build
description: Multi-repo AI software factory — operate repeatable agents+code workflows (ADWs) against any registered repo. Use when the user says /sfo-build install, wants to run/create/update an ADW, register a target repo, manage the agent roster in sfo.config.yaml, or observe running agent workflows. Keywords - sfo, sfo-build, software factory, ADW, AI developer workflow, agent pipeline, register target, copilot workflow.
argument-hint: "[install | run adw | create adw | add target | update config | observe]"
---

# sfo-build

A **central** factory: one install at `~/Workspace/sfo-build` drives many repos
through a flat target registry. Deterministic TypeScript ADWs own sequencing,
retries and acceptance; GitHub Copilot agents work inside bounded phases; typed
Zod envelopes carry context across seams; everything streams into SQLite as it
happens. **Agent proposes, code disposes.**

## Startup

Three steps. Then stop.

1. Read [cookbooks/overview.md](cookbooks/overview.md) — the system map.
2. `ls adws/adw_*.ts` and read each file's `Phases:` docstring line.
3. Print the ADWs and the registered targets as two short tables, then
   **wait for the engineer's request.**

```
| ADW | Chain | Use when |
|---|---|---|
| adw_scout | engineer → scout | read-only recon; nothing changes |
| adw_simple_sdlc | plan → build → test → review → document, 3 commits | the work is real and its shape is not obvious |
```

**Nothing else.** No trace-db queries, no reading the config body or the ADW
scripts' internals, no repo inventory, no last-runs summary, no "current state"
dashboard. None of it was asked for, and it is not free:

- **Volunteered state is guessed state.** An orchestrator that improvises a
  status board guesses table and column names. The schema is in
  [references/observability.md](references/observability.md), one lazy read
  away. Probing to look prepared is how you end up confidently wrong in your
  first message.
- **It spends the context the real task needs**, before you know what the task is.
- **It is stale on arrival.** State printed before the request describes a
  system the very next run changes.

Two exceptions, both narrow: if the engineer's first message already contains a
request, skip the waiting and route it; and if the factory is plainly not set up
(no `adws/`, no config), say so in one line instead of the tables.

## Orchestrator rules

You run the system, observe it, and help the engineer interact with it.
**You do no ADW work yourself:**

- Never plan, implement, review or document in an agent's place — launch the ADW
  and watch it. If an ADW fails, report why; do not finish its job by hand.
- Never edit anything under `~/.sfo-build/sessions/` — that is the run record.
- Never edit a target repo directly. That is what the builder is for.
- Observe by querying `~/.sfo-build/sfo.db` (WAL, so reads never block writers)
  **when observing is the task** — not to volunteer a status nobody asked for.
- Report phase status plainly: name, owner, status, error if any.

## Request routing (lazy-load the cookbook, then follow it)

| Request | Cookbook |
|---|---|
| `/sfo-build install`, register a repo as a target | [cookbooks/install.md](cookbooks/install.md) |
| run / monitor an ADW | [cookbooks/prompting.md](cookbooks/prompting.md) **first**, then [cookbooks/run_adw.md](cookbooks/run_adw.md) |
| turn a request into an ADW prompt | [cookbooks/prompting.md](cookbooks/prompting.md) |
| create a new ADW / workflow | [cookbooks/create_adw.md](cookbooks/create_adw.md) |
| modify an existing ADW chain | [cookbooks/update_adw.md](cookbooks/update_adw.md) |
| add or retune an agent (model, thinking, tools, prompts) | [cookbooks/update_roster.md](cookbooks/update_roster.md) |
| add or change a target repo | [cookbooks/update_targets.md](cookbooks/update_targets.md) |
| extend adw_modules with new low-level logic | [cookbooks/update_modules.md](cookbooks/update_modules.md) |
| a run failed and you need to know why | [cookbooks/troubleshoot.md](cookbooks/troubleshoot.md) |

Deep specs, when needed: [references/config.md](references/config.md) ·
[references/handoff.md](references/handoff.md) ·
[references/observability.md](references/observability.md) ·
[references/copilot.md](references/copilot.md) — measured CLI behaviour, read it
before assuming anything about the harness.

## Hard rules

1. Every ADW declares `REQUIRED_AGENTS` and validates before anything spawns.
2. Typed outputs only. The contract is a **synced triad**: the Zod schema in
   `types.ts`, the JSON example in the agent's `user.md` `## Report` section, and
   `outputTypeName` at the call site. Change one, change all three.
3. Gates validate claims **after the fact**, never predictions. And an artifact
   must be somewhere the artifact is *for* — existence alone is not the property
   that matters.
4. More than 4 params → take one typed object instead.
5. One agent, one prompt, one purpose.
6. ADW scripts stay thin; all logic lives in `adw_modules/`.
7. Every phase needs a real one-sentence `description`. Blank or name-restating
   is rejected at construction, before the phase opens.
8. **A known command is code, not an agent.** Test runners, linters, git, mkdir.
9. `tools:` is capability, `writes:` is boundary. Neither implies the other.
10. Every ADW ends in `run.finish(accepted)`.
11. **Never pass `--allow-all-paths`, `--allow-all` or `--yolo`.** The path
    sandbox is the prevention half of the permission model; those flags remove it.
12. Never put the runtime inside the factory tree. `--add-dir` grants a whole
    directory, and agents must be granted the session dir — so a runtime under
    the factory hands every agent the engine that grades it.

## The factory / runtime split

```
~/Workspace/sfo-build/        FACTORY — git repo, granted to NOBODY
  adws/adw_modules/*.ts         engine
  adws/adw_*.ts                 chains
  adws/adw_sfo_config/          roster + target registry
  adws/adw_data/prompt_engineering/   the grading criteria
  apps/visualizer/

~/.sfo-build/                 RUNTIME — outside git, granted narrowly
  id/<agent>/                   --add-dir (that agent only)
  sessions/<adw_id>/            --add-dir (that run only)
  sfo.db · locks/
```

Per agent call the grants are exactly `-C <target repo>`,
`--add-dir ~/.sfo-build/id/<agent>`, `--add-dir ~/.sfo-build/sessions/<adw_id>`.
Nothing else, ever.
