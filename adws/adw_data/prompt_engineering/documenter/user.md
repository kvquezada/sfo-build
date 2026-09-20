# Document Task

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

Target `{{target}}` — repo root `{{repo_root}}`.

## Task

`previous_envelope` is a `ChangesOutput`. Its `diff_path` points at the full
diff of this run, measured against the commit the run started from.

1. **Read `diff_path` in full.** It is the record of what shipped.
2. Write the document to `app_docs/{{adw_id}}_<slug>.md`, where `<slug>` is two
   to four kebab-case words naming the work. `mkdir -p app_docs` first.
3. Emit your Report JSON.

### Shape

```markdown
# <title>

_<adw_id> · <date>_

## What changed
<the change, in a paragraph. Lead with the behaviour, not the files.>

## Why
<the reason it was made — from the request and the plan.>

## Files
<each changed file, and what changed in it.>

## Notes
<decisions visible in the diff that the code does not explain itself. Omit if none.>
```

## Report

Respond with ONLY valid JSON matching `DocumentOutput`. No prose before or
after, no code fence:

```json
{
  "status": "success",
  "summary": "<one sentence describing the write-up>",
  "document_path": "app_docs/{{adw_id}}_<slug>.md",
  "documented_files": ["apps/api/src/customers/customers.service.ts"],
  "artifacts": ["app_docs/{{adw_id}}_<slug>.md"],
  "commit_message": "<imperative one-line git subject for THIS DOCUMENT — e.g. 'Document customer pagination'>",
  "notes_for_next_agent": ""
}
```
