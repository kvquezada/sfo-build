# The handoff contract

Agents never talk to each other. They hand **typed envelopes** to code, and code
decides what happens next. That is the seam the whole design rests on: an
agent's final message is a *claim*, and every claim is parsed, verified and
recorded before anything downstream believes it.

## The envelope

Every output type extends `EnvelopeBase`:

```ts
{
  status: "success" | "fail",     // there is no third value
  summary: string,
  artifacts: string[],
  notes_for_next_agent: string,
}
```

| Type | Adds |
|---|---|
| `GenericOutput` | — |
| `PlanOutput` | `commit_message` |
| `BuildOutput` | `changed_files`, `commit_message` |
| `ScoutOutput` | `findings[{file, note}]` |
| `ReviewOutput` | `approved`, `findings[{requirement, met, evidence}]`, `blocking[]` |
| `DocumentOutput` | `document_path`, `documented_files`, `commit_message` |
| `VerifyOutput` | `passed`, `failures[]` — **written by code**, read by an agent |
| `ChangesOutput` | `base`, `changed_files`, `insertions`, `deletions`, `stat`, `diff_path` — **written by code** |

The last two are adapters. A failing test run and a git diff are not agent
output, but they reach the next agent through the same door an agent's report
would — so the repair loop and the documenter need no special case, and the ADW
script is the only thing that knows the difference.

## `status` means the AGENT'S work

Not the codebase's health. A builder whose change landed correctly reports
`success` even if some unrelated pre-existing test is red — the workflow runs
the suite itself, in its own phase, and has a bounded repair loop for exactly
that. `fail` means *I could not do what you asked*.

Getting this wrong is expensive and silent: a builder that reported `fail`
because it noticed someone else's red test killed a chain before the repair loop
that would have handled it could run.

## The synced triad

For each agent call, three things must agree (hard rule 2):

1. the **Zod schema** in `types.ts`
2. the **JSON example** in that agent's `user.md` `## Report` section
3. `outputType` + `outputTypeName` at the **call site**

Change one, change all three. Drift shows up as a correction loop burning turns
re-asking for a field the prompt never mentioned.

## What happens to a reply

```
final assistant message
  → extractJson()        strip prose and fences, take the last {...}
  → schema.safeParse()   on failure: correct in the SAME session, up to 2×
  → gates               claims verified against the filesystem; violations
                        become a correction in the SAME session, up to `retries`
  → permissions.enforce  both trees diffed; a breach ABORTS (it cannot be re-prompted —
                        the write already happened)
  → persisted           envelopes table + <agent>/envelope.json
  → status !== success  → the phase throws
```

Correction turns are affordable because `--session-id` is create-or-continue:
the agent is re-prompted with its context intact, for one turn, rather than
restarted cold.

## Passing context forward

`previous:` on an `AgentCall` serializes the prior envelope into
`{{previous_envelope}}`. Files go through `{{context_handoff_dir}}` —
`~/.sfo-build/sessions/<adw_id>/context_handoff/`, which is `--add-dir`'d for the
run and lives outside every repo.

Large payloads go on disk, not in the envelope. `ChangesOutput` carries a
`diff_path`, not the diff: an envelope is a summary with a pointer, and a
20,000-line diff pasted into the next agent's context is how a chain runs out of
window halfway through.
