# Review Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

### scope

Target `{{target}}` — repo root `{{repo_root}}`, focus `{{subdir}}`.

## Task

Decide whether the work in the tree satisfies `prompt`.

1. Read `{{context_handoff_dir}}/plan.md` if it exists — that is what the
   builder was told to do.
2. Read the actual diff. `git diff HEAD` and `git status --porcelain` show you
   the uncommitted work; `git log --oneline -5` shows what this run already
   committed.
3. Turn `prompt` (and the plan) into a list of concrete requirements, then
   check each one against the code you just read.
4. Write your review to `{{context_handoff_dir}}/review.md`, then emit your
   Report JSON.

## Report

Respond with ONLY valid JSON matching `ReviewOutput`. No prose before or after,
no code fence:

```json
{
  "status": "success",
  "summary": "<one sentence verdict>",
  "approved": true,
  "findings": [
    { "requirement": "GET /customers accepts ?page= and ?limit=", "met": true, "evidence": "FindCustomersDto gains both, transformed to Int; customers.service.ts applies skip/limit" }
  ],
  "blocking": [],
  "artifacts": ["{{context_handoff_dir}}/review.md"],
  "notes_for_next_agent": "<what the documenter should emphasise>"
}
```

`status` is `"success"` when you completed the review — it describes YOUR work,
not the code's. A rejection is a successful review with `approved: false`.
Set `approved: false` and list what must change in `blocking`.
