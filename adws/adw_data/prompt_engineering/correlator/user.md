# Correlator Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### handoff_root

{{handoff_root}}

## Task

Each scout wrote its findings to `{{handoff_root}}/<target>/scout.md`, one
directory per repo. Read every one of them.

Answer the question in `prompt` by joining those reports into a single ordered
path: where the request starts, what each repo does with it, and where the two
sides stop agreeing.

Write your write-up to `{{handoff_root}}/trace.md` as markdown: the
question, the path hop by hop with the repo named at each step, then the seam
and the evidence for it. Then emit your Report JSON.

Every hop's `file` is checked against the repo its `target` names. A path that
is not there, or a target this run did not open, fails the gate.

## Report

Respond with ONLY valid JSON matching `TraceOutput`. No prose before or after,
no code fence:

```json
{
  "status": "success",
  "summary": "<one sentence naming the seam>",
  "hops": [
    { "target": "mobile", "file": "Sources/Checkout/CheckoutClient.swift", "note": "retries on any non-2xx, including 409" },
    { "target": "api", "file": "src/checkout/checkout.controller.ts", "note": "409 means the order already exists — a retry re-submits it" }
  ],
  "seam": "<where the two sides disagree, in one sentence>",
  "artifacts": ["{{handoff_root}}/trace.md"],
  "notes_for_next_agent": "<what someone proposing a fix needs to know>"
}
```
