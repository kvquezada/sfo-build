# Register a repo as a target

"Install" here does **not** mean copying the factory into a repo. This factory is
central: one install drives many repos, and a target is a row in a registry.
Per-repo factory variants are a known impossibility, not an oversight — one
roster and one prompt set serve every target, so improvements land everywhere at
once instead of drifting per checkout.

## Steps

1. **Confirm what the engineer wants registered**: the repo path, a short name,
   and whether it should be scoped to a subdirectory.

2. **Run the registrar.** It detects the commands, *runs them*, and only then
   prints a row:

   ```bash
   npm run install-target -- --path ~/Workspace/personal/oms --name oms
   npm run install-target -- --path ~/Workspace/personal/oms --name api --subdir apps/api
   ```

   Pass `--test "<cmd>"` / `--lint "<cmd>"` to override detection, and `--write`
   to append the row automatically instead of printing it.

3. **Add the row** to `targets:` in `adws/adw_sfo_config/sfo.config.yaml` if you
   did not use `--write`.

4. **Verify:**
   ```bash
   npm run doctor -- --target <name>
   npm run scout -- --target <name> "what is this repo and how is it laid out"
   ```

## What the registrar refuses

- **A repo that is not a git repo.** Every run works in place and is measured
  against git: the dirty guard, the permission backstop and the diff capture all
  need one.
- **A test command that did not pass.** It is run before it is recorded. A
  command that has not been seen exit 0 is a placeholder, and a placeholder that
  exits 0 is believed by every phase downstream. This is the single most
  expensive failure mode the design guards against.
- **A duplicate name**, unless `--force`.

## Scoped targets

`subdir` bounds what agents may **write**; it never bounds what they may read.
Monorepo work routinely needs to read across packages — a change in `apps/api`
may depend on `libs/shared` — so the agent's working directory is always the repo
root and the scope is enforced afterwards, against the diff.

Two targets may share a `path`; `api` and `front` are both one oms checkout.
That is why the concurrency lock is keyed on the resolved **path**, not the
target name: two runs against one tree would interleave edits, so the second is
refused.

`test` stays **repo-wide** even on a scoped target. "Green" has to mean the same
thing everywhere, and a change inside `apps/api` can break a consumer of
`libs/shared`.
