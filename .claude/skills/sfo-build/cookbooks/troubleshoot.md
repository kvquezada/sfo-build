# A run failed — finding out why

```bash
npm run phases -- <adw_id>        # which phase, and its error
npm run tail -- <adw_id>          # the surrounding narrative
```

Then the run's own record: `~/.sfo-build/sessions/<adw_id>/` holds the exact
prompts sent, every raw Copilot event, and each parsed envelope.

## Failures that look like something else

**`config validation failed`** — nothing spawned. A prompt file is missing, a
model/thinking pair is unusable, or a tool name is not in the neutral
vocabulary. `npm run doctor` says which.

**`Model "X" does not support reasoning effort configuration`** — that model
takes only `none`. Fix `thinking:` in the roster; `doctor --refresh` re-probes.

**`target ... has N uncommitted change(s)`** — the dirty guard. It is not
optional: the permission backstop distinguishes the agent's writes from the
engineer's by diffing, and it cannot do that on a tree that was already dirty.
Show the engineer `git status` and let them decide; never clean it for them.

**`... is locked by a run already in flight`** — another run holds this path.
The message carries the pid. A stale lock (owning process gone) is reclaimed
automatically, so this means a real process.

**`<agent> failed gates after N attempt(s)`** — the agent's claims did not hold
up. The gate's `note` says exactly what was checked and what was found. Usually
the prompt's `## Report` example and the Zod schema have drifted apart
(hard rule 2's triad).

**`<agent> never produced valid <T> JSON`** — three attempts, still malformed.
Look at `raw_output.jsonl`; usually the agent wrapped prose around it, or used a
`status` value outside `success | fail`.

**`<agent> reported status='fail'`** — the agent declined the work. Read its
`summary`. Note that `status` describes the *agent's own work*, not the suite's
verdict; if an agent is failing because a pre-existing test is red, its prompt
needs that distinction spelled out.

**`is <scope> but modified N path(s)`** — the permission backstop. The paths were
rolled back. Either the agent overstepped, or its `writes:` is too narrow for
the job it was given.

**`TRIPWIRE: ... changed N path(s) inside the factory tree`** — treat this as a
sandbox failure, not an agent mistake. No agent is ever granted that tree.
Check that no `--allow-all-paths` / `--allow-all` / `--yolo` reached the CLI,
and inspect the named paths by hand before running anything else.

**`nothing to commit — the preceding phases changed no files`** — an agent
claimed work it did not land. This is the system failing closed, and it is
working: it refused to create a commit that would have described nothing.

## What a failed run leaves

The plan commit stands; unverified code stays uncommitted in the working tree.
That is deliberate — the spec is a real artifact either way, and the unfinished
code belongs where the engineer can see it. Do not clean it up or finish it by
hand; report it and let them choose.
