# Installing and running sfo-build

**Don't copy, register.**

There are two ways you could make this factory work on a new repo, and only one
of them is supported. Copying — duplicating `adws/`, the roster and the prompt
set into each codebase — gives you N factories that drift: fix a prompt in one
and the others keep the old behaviour. Registering leaves the factory where it
is and appends a row to the target registry. Nothing is installed in the target
repo; it does not even know it is a target.

One roster and one prompt set serve every target, so improvements land
everywhere at once. Per-repo factory variants are a known impossibility, not an
oversight.

## Prerequisites

```bash
copilot --version              # GitHub Copilot CLI, authenticated
bun --version                  # the ADWs run on bun
cd ~/Workspace/sfo-build && npm install
```

The factory shells out to whatever `COPILOT_PATH` names, defaulting to `copilot`
on your `PATH`.

Every target must be a **git repo with a clean tree**. Each run works in place
and is measured against git — the dirty guard, the permission backstop and the
diff capture all need one, and a dirty target refuses to run because the
backstop must be able to tell the agent's writes from yours.

## Registering targets

A worked example: an nx monorepo, a Python service, and a docs site.

```bash
cd ~/Workspace/sfo-build

# nx monorepo — one checkout, two scoped targets
npm run install-target -- --path ~/Workspace/personal/oms --name api \
  --subdir apps/api --base-branch main --write
npm run install-target -- --path ~/Workspace/personal/oms --name front \
  --subdir apps/front --base-branch main --write

# python service — detection finds pyproject.toml and offers `pytest -q`
npm run install-target -- --path ~/Workspace/personal/billing --name billing \
  --lint "ruff check ." --base-branch main --write

# docs site — no test suite worth gating on
npm run install-target -- --path ~/Workspace/personal/handbook --name docs \
  --test "npm run build" --write
```

| flag | |
|---|---|
| `--path P` | the repo to register (required) |
| `--name N` | what `--target N` will select (required) |
| `--subdir D` | bound writes to this subtree |
| `--test "cmd"` / `--lint "cmd"` | override detection |
| `--base-branch B` / `--remote R` | what `ship` branches from and pushes to |
| `--force` | print a replacement row for a name already taken |
| `--write` | append the row instead of printing it |

Without `--write` the registrar prints the YAML row for you to paste into
`adws/adw_sfo_config/sfo.config.yaml`.

Each invocation **runs** the detected test and lint commands before recording
them. Expect it to take a while, and expect registration to fail if the suite is
red. That is the point: a command that has not been seen exit 0 is a
placeholder, and a placeholder that exits 0 is believed by every phase
downstream. This is the single most expensive failure mode the design guards
against.

The registrar also refuses a repo that is not a git repo, and a duplicate name
unless `--force`.

## What you end up with

```yaml
targets:
  - name: api
    path: ~/Workspace/personal/oms
    subdir: apps/api
    base_branch: main
    test: [npx, nx, run-many, -t, test]
    lint: [npx, nx, lint, api]

  - name: front
    path: ~/Workspace/personal/oms
    subdir: apps/front
    base_branch: main
    test: [npx, nx, run-many, -t, test]
    lint: [npx, nx, lint, front]

  - name: billing
    path: ~/Workspace/personal/billing
    base_branch: main
    test: [pytest, -q]
    lint: [ruff, check, .]

  - name: docs
    path: ~/Workspace/personal/handbook
    test: [npm, run, build]
```

Three things this example is chosen to show:

- **`api` and `front` share a `path`.** The concurrency lock is keyed on the
  resolved path rather than the target name, so a run against `api` refuses to
  start while `front` is running. Two runs against one tree would interleave
  edits.
- **`subdir` bounds writes, never reads.** The agent's working directory is
  always the repo root — a change in `apps/api` may depend on `libs/shared` —
  and the scope is enforced afterwards, against the diff.
- **`test` stays repo-wide on a scoped target.** "Green" has to mean the same
  thing everywhere, and a change inside `apps/api` can break a consumer of
  `libs/shared`.

## Verify before spending a request

```bash
npm run doctor                        # the roster, live
npm run doctor -- --target api        # + that target's tree is clean
npm run doctor -- --target billing
```

`doctor` checks the roster's prompts, probes each `(model, thinking)` pair
against the live CLI, prints each model's real tool dialect, and confirms the
target is clean. The probe matters because Copilot has no `--list-models`: a bad
model id fails at run time, not validate time. Results are cached 14 days.

Then a smoke test that writes nothing:

```bash
npm run scout -- --target api "what is this repo and how is it laid out"
```

## Running against them

```bash
npm run scout -- --target billing "where are invoice totals computed"
npm run sdlc  -- --target api   "add pagination to GET /customers"
npm run bt    -- --target front "the stage badge renders stale after a refetch"
npm run document -- --target docs --base main

# the only row that resolves more than one repo; the order IS the request path
npm run trace -- --target front --target api "why does the stage badge go stale"

# flags go LAST — parseArgs takes the next non-`--` token as a flag's value,
# so `--adversary "add pagination"` swallows the prompt
npm run br   -- --target api "add pagination" --adversary
npm run sdlc -- --target api "add pagination" --ship
```

Pick a chain by what has to be true before the code lands, not by how many
phases it has. See [the workflow table](README.md#workflows), or
[`cookbooks/run_adw.md`](.claude/skills/sfo-build/cookbooks/run_adw.md) for the
same table annotated with "use when".

## What "running in Copilot" means at the seam

You never invoke `copilot` yourself. Each agent phase spawns one
non-interactive call:

```
copilot -p "<rendered prompt>" \
  --model claude-sonnet-5 --reasoning-effort high \
  --session-id <uuidv5 from (adw_id, agent)> \
  --stream off --output-format json --allow-all-tools \
  -C ~/Workspace/personal/oms \
  --add-dir ~/.sfo-build/id/<agent> \
  --add-dir ~/.sfo-build/sessions/<adw_id> \
  --agent <name> --available-tools ...
```

- **`--allow-all-tools` is required for non-interactive, and does not imply
  `--allow-all-paths`.** The path sandbox stays in force: a write outside the
  project root is refused by the harness, including through `bash`. Nothing in
  this codebase ever constructs `--allow-all-paths`, `--allow-all` or `--yolo`.
- **`-C` is always the repo root**, even for a scoped target, for the read/write
  asymmetry above.
- **`--session-id` is create-or-continue**, so a revise turn costs one turn
  rather than a cold restart. Ids are UUIDv5 derived from `(adw_id, agent)`;
  Copilot rejects non-UUID session names.
- **`--add-dir` grants a whole tree**, which is why the runtime lives at
  `~/.sfo-build/` and not under the factory. Agents must be able to write
  handoff artifacts, so the session directory has to be granted — and a runtime
  under the factory would hand every agent the engine that grades it.

Measured CLI behaviour — available models, per-model reasoning-effort support,
tool dialects, what the sandbox actually refuses — is in
[`references/copilot.md`](.claude/skills/sfo-build/references/copilot.md).
Re-measure after a CLI upgrade.

## While it runs

The console prints the narrative live. From another shell:

```bash
npm run sessions                 # every run, newest first
npm run phases -- <adw_id>       # phase-by-phase, with gate results
npm run tail -- <adw_id>         # recent events
npm run procs                    # what is believed alive, and its pid
npm run obs                      # the visualizer
```

A failed run leaves evidence rather than a mess: the plan commit stands,
unverified code stays uncommitted in the working tree, and every prompt, raw
event and envelope is under `~/.sfo-build/sessions/<adw_id>/`.
