# Add or retune an agent

The roster is `agents:` in `adws/adw_sfo_config/sfo.config.yaml`. One roster
serves every target (decision 9), so a change here lands everywhere.

## Adding an agent

1. **A row in `agents:`** — name, model, thinking, color, purpose, tools, writes.
2. **A prompt pair** at `adws/adw_data/prompt_engineering/<name>/system.md` and
   `user.md`. Both are required; `validate()` refuses to start without them.
3. **`npm run doctor`** — it probes the (model, thinking) pair and prints the
   model's real tool dialect.

## The fields

**`model`** — there is no catalog and no `--list-models`. A bad id fails at run
time, so `doctor` probes it live and caches the verdict for 14 days.
Known available on this account: `gpt-5.6-luna`, `gpt-5.6-terra`,
`claude-sonnet-5`, `claude-haiku-4.5`, `gemini-3.6-flash`, `grok-4.6`.

**`thinking`** — `none | minimal | low | medium | high | xhigh | max`, **but
support is per-model**. `claude-haiku-4.5` accepts only `none` and rejects every
other level outright. This is why `doctor` probes the *pair*, not the model.

**`tools`** — the neutral vocabulary: `read write edit search glob shell fetch
subagent skill sql`. An unmapped name is a hard failure at validate time, never
a silent drop. Use `tools_extra` for a vendor-specific tool with no neutral
equivalent. `null` means every tool the CLI has.

> **Keep `shell` on any agent expected to write files.** Tool dialects are
> chosen by the model: `gpt-5.6-terra` has no `create` and no `edit` at all and
> writes through `bash`. And `create` does not make parent directories — a
> documenter without `shell` once could not `mkdir` the directory its own task
> named, and quietly wrote its report somewhere nothing reads.

**`writes`** — the boundary, enforced in code after every call.
- `null` — unrestricted, bounded by the target's `subdir` if it has one
- `[]` — read-only with respect to the repo (it still writes its own report into
  the session directory, which is outside every repo)
- `["specs/", "**/*.md"]` — only these. A trailing `/` is a directory prefix;
  `*` stops at a path separator and `**` crosses one.

An explicit `writes:` entry **overrides `subdir`**. That is deliberate: a scope
bounds the open-ended default grant, while an allowlist is someone writing down
exactly where an agent belongs — and some of those places are repo-level. The
planner's `specs/` and the documenter's `app_docs/` live at the root whichever
package the work happened in.

## Retuning prompts

`system.md` becomes the agent's `--agent` identity file; `user.md` is the task
message. Both support `{{prompt}}`, `{{previous_envelope}}`,
`{{context_handoff_dir}}`, `{{adw_id}}`, `{{target}}`, `{{repo_root}}`,
`{{subdir}}`, `{{scope_dir}}`, `{{agent_name}}`, `{{repo_brief}}`,
`{{test_command}}` (the target's registered test argv, never a hard-coded runner).

`{{repo_brief}}` is `prompt_engineering/_briefs/<brief>.md`, inlined into every
system prompt for that target. `<brief>` is the target's `brief:` in the
registry, defaulting to its `name`, so scopes of one repo share a file
(`api` and `front` both say `brief: oms`). Domain vocabulary and conventions go
**there**, once — five copies drift within a week. A target with no brief file
gets no brief, never another repo's.

> **Over-specify.** Copilot has no `--system-prompt` and never will. Your file
> arrives as `selected_agent_instructions` *alongside* Copilot's own `identity`
> segment, so an agent is always "Copilot, plus your instructions", never yours
> alone. Anything you leave unsaid, Copilot's defaults will say for you. The
> generated identity file opens with an explicit precedence paragraph for
> exactly this reason.

## Choose the judges' vendors deliberately

The reviewer is `claude-sonnet-5` while the builder is `gpt-5.6-terra`, and that
is not arbitrary. A reviewer sharing the builder's failure modes approves the
builder's mistakes. If you change one, check you have not accidentally made them
the same family.

The optional `adversary` (`--adversary` on `br` and `sdlc`) is a third vendor
again — `grok-4.6` — for the same reason one step further out: it is
there to catch what the *reviewer* waves through, so sharing the reviewer's
family would cost most of what it is for. Three agents, three vendors, no shared
blind spot. Changing any one of them is a decision about all three.

Both judges are `writes: []` and both stand in the same checkout at the same
time. Any read-only agent that may run concurrently with another must use
`git --no-optional-locks` in its prompt — a plain `git status` refreshes the
index, takes `.git/index.lock`, and the loser of the race reports the collision
as if it were a finding about your code.
