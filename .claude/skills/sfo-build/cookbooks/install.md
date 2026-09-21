# Install: set up this machine, register a repo, give it a brief

"Install" here does **not** mean copying the factory into a repo. This factory is
central: one install drives many repos, and a target is a row in a registry.
Per-repo factory variants are a known impossibility, not an oversight — one
roster and one prompt set serve every target, so improvements land everywhere at
once instead of drifting per checkout.

What is shared and what is not decides where every write in this cookbook goes:

| | where | shared |
|---|---|---|
| roster, prompts, chains | the factory repo | yes — through PRs |
| **targets** | `~/.sfo-build/targets.yaml` | no — paths are per machine |
| **personal briefs** | `~/.sfo-build/briefs/<brief>.md` | no |
| **team briefs** | `adws/adw_data/prompt_engineering/_briefs/<brief>.md` | yes — through a PR |

A personal brief wins over a team one of the same name. No brief in either is
no brief — never another repo's.

Work out which of the three parts below the engineer needs, and do only those.

## A. Set up this machine

Skip if `npm run doctor` already passes.

1. **Prerequisites** — ask the engineer to confirm, don't install for them:
   ```bash
   copilot --version       # GitHub Copilot CLI, logged in with THEIR account
   bun --version
   node --version          # ≥ 22.5 if they want the visualizer
   ```
2. **Dependencies:**
   ```bash
   npm install
   npm --prefix apps/visualizer install    # only for `npm run obs`
   ```
3. **`npm run doctor`.** It probes every roster model against *this* person's
   Copilot plan — a model they don't have fails here, not mid-run. Report any
   unavailable model plainly; changing the shared roster for one person's plan is
   a team decision, not yours.

A fresh machine has no `~/.sfo-build/targets.yaml`. That is correct: doctor
says "none yet". Go to B.

## B. Register a repo

1. **Confirm**: the repo path, a short name, whether to scope it to a
   subdirectory, and **whether anything will ever be built there**.

2. **It has a test suite, and work will be built there → the registrar.** It
   detects the commands, *runs them*, and only then records a row:

   ```bash
   npm run install-target -- --path ~/Workspace/acme/api --name api --write
   npm run install-target -- --path ~/Workspace/acme/web --name web --subdir apps/web \
     --test "npm test" --lint "npm run lint" --write
   ```

   `--write` appends to `~/.sfo-build/targets.yaml`; without it the row is
   printed for the engineer to paste there.

3. **Read-only, or no suite → a row by hand.** The registrar refuses a target
   without a passing test command, by design. For a repo that will only be
   investigated (`scout`, `map`, `trace`, `plan`), write the row yourself into
   `~/.sfo-build/targets.yaml`:

   ```yaml
   targets:
     - name: ios
       path: ~/Workspace/acme/ios
       base_branch: main
   ```

   Tell the engineer what that means: the read-only chains, `pb` and `br` work;
   `build`, `bt`, `pbt`, `pbtq` and `sdlc` stop at their test phase with "no
   'test' command configured". Never fill `test:` with a command you have not
   seen pass — `true` would make every chain commit untested work as green.

4. **Verify:**
   ```bash
   npm run doctor -- --target <name>      # a git repo, and a clean tree
   ```

## C. Give it a brief (optional)

A brief is what every agent should know about the repo before reading it:
what it is, the domain's own words, conventions that are not optional. It is
inlined into **every** agent's system prompt for that target, and **no gate
checks it** — so a person confirms every line before it is saved. Offer this;
don't insist. A target with no brief works; the agents orient by reading.

1. **A team brief may already exist.** List `_briefs/`. If one covers this repo
   under another name, point the target at it with `brief: <file>` and stop.

2. **Draft it — by hand, or from a scout.** For a scout draft, run the ADW; do
   not read the repo yourself in its place:
   ```bash
   npm run scout -- --target <name> "Describe this repo for a new engineer: what it is, how it is laid out, the domain's own vocabulary with the files that define it, and the conventions every change must follow (module shape, test location and style, formatting)."
   ```
   Compose the draft from the scout's findings (under
   `~/.sfo-build/sessions/<adw_id>/`). Keep only what a finding cites. Short
   and stable: vocabulary, layout, conventions, how tests are written — not the
   test *command*, which comes from the target's `test:`.

3. **Show the draft to the engineer and let them edit it.** Nothing is saved
   until they say it is right.

4. **Save where they choose:**
   - **personal** → `~/.sfo-build/briefs/<name>.md`. Done.
   - **team** → `adws/adw_data/prompt_engineering/_briefs/<repo>.md` on a
     branch, and open a PR — never commit a team brief straight to the trunk.
     Name it for the repo, not the engineer's target, so teammates can point
     at it with `brief: <repo>`.

5. **Check it lands:** the next run's `~/.sfo-build/sessions/<adw_id>/<agent>@<target>/prompts/system.md`
   contains it.

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
Monorepo work routinely needs to read across packages — a change in `apps/web`
may depend on `libs/shared` — so the agent's working directory is always the repo
root and the scope is enforced afterwards, against the diff.

Two targets may share a `path` — two scopes of one monorepo checkout. That is
why the concurrency lock is keyed on the resolved **path**, not the target
name: two runs against one tree would interleave edits, so the second is
refused. Point both at one brief with `brief:`.

`test` stays **repo-wide** even on a scoped target. "Green" has to mean the same
thing everywhere, and a change inside `apps/web` can break a consumer of
`libs/shared`.
