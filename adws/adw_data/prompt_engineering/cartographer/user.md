# Cartographer Task

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

Answer the question in `prompt` by describing the path end to end: where the
request starts, what each repo does with it, what crosses each boundary, and
where it ends up.

Write your write-up to `{{handoff_root}}/map.md` as markdown: the question, the
path hop by hop with the repo named at each step, then the contract between the
sides and anything worth knowing about it. Then emit your Report JSON.

Every hop's `file` is checked against the repo its `target` names. A path that
is not there, or a target this run did not open, fails the gate.

## Report

Respond with ONLY valid JSON matching `MapOutput`. No prose before or after,
no code fence:

```json
{
  "status": "success",
  "summary": "<one sentence describing the flow>",
  "hops": [
    { "target": "front", "file": "src/app/orders/actions.ts", "note": "POSTs {stage} to the api and revalidates on the way back" },
    { "target": "api", "file": "src/orders/orders.controller.ts", "note": "receives it, delegates to orders.service" }
  ],
  "contract": "<what the two sides agree on, in one sentence>",
  "observations": ["<worth knowing, not a defect — omit the list entirely if there is nothing>"],
  "artifacts": ["{{handoff_root}}/map.md"],
  "notes_for_next_agent": "<what someone working in this area should know>"
}
```
