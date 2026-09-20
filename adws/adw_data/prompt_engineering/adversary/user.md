# Adversarial Review Task

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

Decide what the work in the tree does that `prompt` never asked for.

1. Read `{{context_handoff_dir}}/plan.md` if it exists — that is what the
   builder was told to do. Do NOT read `review.md`; another judge is writing it
   right now, and your value is that you did not see it.
2. Read the actual diff. Use `--no-optional-locks` on every git command — a
   second agent is reading this same checkout and the two of you will collide
   over `.git/index.lock` otherwise:

   ```
   git --no-optional-locks diff HEAD
   git --no-optional-locks status --porcelain
   git --no-optional-locks log --oneline -5
   ```

3. For each changed file, ask what ELSE it now does: what callers see, what the
   old behaviour was, which paths are untested, what a bad input reaches.
4. Write your review to `{{context_handoff_dir}}/adversary.md`, then emit your
   Report JSON.

## Report

Respond with ONLY valid JSON matching `ReviewOutput`. No prose before or after,
no code fence:

```json
{
  "status": "success",
  "summary": "<one sentence verdict>",
  "approved": false,
  "findings": [
    { "requirement": "pagination does not change the default response shape", "met": false, "evidence": "customers.service.ts now always wraps in {data,meta} — an unpaginated caller that read the bare array breaks, and nothing in the prompt asked for a new envelope" }
  ],
  "blocking": ["keep the bare-array response when no ?page= is given, or say why the break is intended"],
  "artifacts": ["{{context_handoff_dir}}/adversary.md"],
  "notes_for_next_agent": "<what the builder should look at first>"
}
```

`status` is `"success"` when you completed the review — it describes YOUR work,
not the code's. A rejection is a successful review with `approved: false`.
Finding nothing is a legitimate outcome: `approved: true`, empty `blocking`.
