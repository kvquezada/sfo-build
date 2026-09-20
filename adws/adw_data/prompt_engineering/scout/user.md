# Scout Task

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

Answer the question in `prompt` by reading the repository.

Write your findings to `{{context_handoff_dir}}/scout.md` as markdown: the
question, your answer, and the evidence path for each claim. Then emit your
Report JSON.

## Report

Respond with ONLY valid JSON matching `ScoutOutput`. No prose before or after,
no code fence:

```json
{
  "status": "success",
  "summary": "<one sentence answering the question>",
  "findings": [
    { "file": "apps/api/src/orders/orders.service.ts", "note": "transition() is the only writer of stage; guards via canTransition" }
  ],
  "artifacts": ["{{context_handoff_dir}}/scout.md"],
  "notes_for_next_agent": "<what someone acting on this should know>"
}
```
