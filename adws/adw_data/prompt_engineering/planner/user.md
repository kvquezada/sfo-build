# Plan Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

### adw_id

{{adw_id}}

### scope

Target `{{target}}` — repo root `{{repo_root}}`, writable scope `{{subdir}}`.

## Task

Plan the work described in `prompt`.

1. Write the full plan to `{{context_handoff_dir}}/plan.md`. This is the copy
   the builder reads, and it is the one that must be complete.

2. Copy that file into the repo at `specs/{{adw_id}}_<slug>.md`, where `<slug>`
   is two to four kebab-case words naming the work.
   - **List `specs/` before you pick the name.** A session that plans more than
     once reuses `{{adw_id}}`, so the obvious name may already be taken.
   - If that name exists, use `_v2`, then `_v3`, until one is free.
     **Never overwrite an existing spec** — the earlier plan is the record of
     what was asked for then.
   - **Copy it, do not retype it.** One bash call does the whole step:
     `mkdir -p specs && cp "{{context_handoff_dir}}/plan.md" "specs/{{adw_id}}_<slug>.md"`
     Writing the plan a second time through `create` re-emits every line you
     already wrote, costs the whole document again in output tokens, and lets
     the two copies drift.

3. Emit your Report JSON, declaring BOTH paths in `artifacts`.

### What the plan must contain

```markdown
# <title>

## Goal
<one paragraph: what will be true when this is done>

## Files
<every file to create or modify, by full path, with what changes in each>

## Steps
<ordered, each one independently checkable>

## Verification
<which *.spec.ts gains which case, and what each case asserts>

## Decisions
<any ambiguity you resolved, and why — omit the heading if there were none>
```

## Report

Respond with ONLY valid JSON matching `PlanOutput`. No prose before or after,
no code fence:

```json
{
  "status": "success",
  "summary": "<one sentence describing the plan>",
  "artifacts": ["{{context_handoff_dir}}/plan.md", "specs/{{adw_id}}_<slug>.md"],
  "commit_message": "<imperative one-line git subject for committing THIS PLAN DOCUMENT, not the work it describes — e.g. 'Add spec for customer pagination'>",
  "notes_for_next_agent": "<what the builder must know that the plan does not already say>"
}
```

Both `artifacts` entries are the paths you ACTUALLY wrote, `_v2` suffix and all.
A gate opens these files; a name you meant to use fails it.
