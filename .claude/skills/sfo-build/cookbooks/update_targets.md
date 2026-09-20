# Add or change a target

`targets:` in `adws/adw_sfo_config/sfo.config.yaml`. A flat registry: one row,
one `--target NAME`.

Adding one is [install.md](install.md) — use the registrar, because it runs the
commands before recording them.

## The fields

```yaml
  - name: api
    path: ~/Workspace/personal/oms
    subdir: apps/api                       # optional
    base_branch: main                      # optional, default master
    remote: origin                         # optional, default origin
    test: [npx, nx, run-many, -t, test]
    lint: [npx, nx, lint, api]
    typecheck: []                          # optional
    build: []                              # optional
```

**`path`** — resolved absolutely; `~` expands. Two rows may share one path.

**`subdir`** — a WRITE scope, not a read scope. Agents always work from the repo
root so a monorepo can be read across packages; the scope is enforced afterwards
against the diff. Quality commands run from `path/subdir`, which is fine for nx
(it resolves its workspace root upward — verified) and is what lets a
per-package runner work elsewhere.

**`base_branch`** — the trunk `npm run ship` cuts its branch from and opens its
PR against, and the left side of the `<remote>/<base_branch>..HEAD` range that
decides what a ship run is carrying. Read by nothing else. The default is
`master`, which is a guess; a wrong one fails loudly at the fetch rather than
shipping to the wrong place. `npm run install-target` reads it off
`<remote>/HEAD` and writes it down, so registering a target normally settles it.

**Command lists are argv, never shell strings.** No quoting bugs, no shell
injection. Call binaries by bare name (`npx`, `bun`, `pytest`) — these inherit
the engineer's environment, so bare names resolve exactly as they do in their
terminal. An absolute path bakes one machine into the trace.

**A missing command is an error, not a no-op.** `quality.ts` refuses to run an
operation the registry does not define rather than skipping it quietly. A
quality block that exits 0 without running anything reports green for work
nobody checked — SSSF's worst shipped failure mode, and the reason the registrar
runs a command before it will record it.

## Keep `test` repo-wide

Even on a scoped target. "Green" has to mean the same thing everywhere, and a
change inside `apps/api` can break a consumer of `libs/shared`. `lint` is
usually the opposite — scope it to the package, because a repo-wide lint failure
somebody else introduced is not this run's problem.

## Concurrency

The lock is keyed on the resolved **path**. Two runs against one checkout are
refused, even under different target names, because they work in place and would
interleave edits. A lock whose owning process is gone is reclaimed
automatically; the error names the pid so a genuinely hung run can be killed.
