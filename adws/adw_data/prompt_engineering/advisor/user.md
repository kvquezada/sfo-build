# Advisor Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### handoff_root

{{handoff_root}}

## Task

The correlator wrote `{{handoff_root}}/trace.md`; each scout wrote
`{{handoff_root}}/<target>/scout.md`, one directory per repo. Read the trace
first, the scout reports for detail.

Propose at most THREE candidate fixes for the issue in `prompt`, ordered with
the one you would make first.

Write them to `{{handoff_root}}/fixes.md` as markdown. Head each option
exactly `## <n>. <name>`, matching the `name` in your report, and under each
give what changes, where, what it buys, and what it costs. Then emit your
Report JSON.

Two things are checked mechanically: every file you name must exist in the repo
your option's `target` names, and `fixes.md` must open on the same option your
report puts first.

## Report

Respond with ONLY valid JSON matching `OptionsOutput`. No prose before or after,
no code fence:

```json
{
  "status": "success",
  "summary": "<one sentence on what you would do>",
  "options": [
    {
      "name": "make the retry conditional on the status",
      "target": "mobile",
      "files": ["Sources/Checkout/CheckoutClient.swift"],
      "pros": ["fixes it at the source — nothing downstream has to change"],
      "cons": ["every other caller of this client keeps the blanket retry"],
      "effort": "small"
    }
  ],
  "artifacts": ["{{handoff_root}}/fixes.md"],
  "notes_for_next_agent": "<what whoever implements this needs to know>"
}
```
