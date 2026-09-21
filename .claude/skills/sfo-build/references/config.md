# Configuration reference

`adws/adw_sfo_config/sfo.config.yaml`: defaults, observability, the agent
roster — everything the team shares. The target registry is NOT in it: that is
`~/.sfo-build/targets.yaml` (`<data_dir>/targets.yaml`, or `$SFO_TARGETS`), one
per machine. Both are parsed and validated by `config.ts` against the Zod
schemas in `types.ts`; a `targets:` key in the shared file is refused.

## defaults

```yaml
defaults:
  coding_agent: copilot        # copilot | claude (claude is a typed stub)
  model: gemini-3.6-flash
  thinking: medium             # none|minimal|low|medium|high|xhigh|max
  color: ""
  tools: null                  # null = every tool the CLI has
  tools_extra: []
  protected_files: []
  data_dir: ~/.sfo-build
```

Agents inherit `coding_agent`, `model`, `thinking`, `color`, `tools` and
`tools_extra` when they do not set them.

**`protected_files` is empty on purpose.** The factory lives outside every
target repo now, so there is no in-repo path to protect; `permissions.ts`
watches the factory tree as a *tripwire* instead, where any change at all is a
breach. Add paths here only for something inside a target repo that no agent
should touch.

**`data_dir` must be outside the factory tree.** `doctor` refuses otherwise, and
the reason is structural: `--add-dir` grants a whole directory, and agents must
be granted the session directory to write handoff artifacts. Put the runtime
under the factory and every agent gets write access to the engine and to the
prompts that grade it.

## observability

```yaml
observability:
  db: ~/.sfo-build/sfo.db
  poll_ms: 500                 # the visualizer's poll interval
```

## agents

See [../cookbooks/update_roster.md](../cookbooks/update_roster.md) for the
field-by-field guide. In short:

```yaml
agents:
  - name: builder
    model: gpt-5.6-terra
    thinking: medium
    color: "#22d3ee"
    purpose: Implement the plan exactly and report every file changed.
    tools: [read, search, glob, shell, write, edit]
    writes: null               # null unrestricted · [] read-only · [...] allowlist
```

Prompts are found by convention at
`adws/adw_data/prompt_engineering/<name>/{system,user}.md`. Both are required.

## targets

In `~/.sfo-build/targets.yaml`, not the shared config. A missing file is a
fresh machine with no targets.

```yaml
targets:
  - name: api
    path: ~/Workspace/personal/oms
    subdir: apps/api
    base_branch: main
    test: [npx, nx, run-many, -t, test]
    lint: [npx, nx, lint, api]
```

| key | default | |
|---|---|---|
| `path` | — | absolute repo root; agents spawn here |
| `subdir` | `""` | soft write scope, and where quality commands run |
| `test` `lint` `typecheck` `build` | `[]` | real argv, never a placeholder |
| `base_branch` | `master` | the trunk `npm run ship` branches from and targets |
| `remote` | `origin` | the remote it pushes to |
| `brief` | the target's `name` | which `_briefs/<brief>.md` is inlined as `{{repo_brief}}`; no file means no brief |

`base_branch` is only read by the ship chain. The default is a guess and a wrong
one is loud rather than silent: the fetch fails on a branch the remote does not
have. `npm run install-target` detects it from `<remote>/HEAD` and writes it
down, so a registered target rarely carries the default by accident.

See [../cookbooks/update_targets.md](../cookbooks/update_targets.md).

## Validation

`validate(cfg, REQUIRED_AGENTS, ...)` runs before anything spawns and collects
**every** problem before throwing — a config with three typos should take one
run to fix, not three. It checks that each required agent resolves, that its
`coding_agent` is implemented, that both prompt files exist, that every tool
name maps, and that the (model, thinking) pair is usable.

`npm run doctor` runs the same checks across the whole roster plus the targets,
and additionally prints each model's real tool dialect. `--refresh` re-probes
instead of using the 14-day cache.
