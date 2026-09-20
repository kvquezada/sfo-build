# Extend adw_modules

All logic lives here (hard rule 6). An ADW script that grew an `if` about *how*
something works is telling you a module is missing.

## Where things go

| You are adding | Module |
|---|---|
| a new envelope shape, config field, or shared type | `types.ts` |
| a new claim to verify after an agent call | `gates.ts` |
| a new deterministic command block | `quality.ts` |
| new git plumbing | `git_helper.ts` |
| a new boundary rule | `permissions.ts` |
| a new coding-agent vendor | `agent_<vendor>.ts` + a column in `tool_map.ts` |
| a new trace table or column | `tracer.ts` (and `MIGRATIONS`) |

## Conventions

- **More than 4 params → one typed object** (hard rule 4). `PhaseParams` and
  `AgentCall` are the pattern.
- **Everything takes its root explicitly.** No module reads an implicit process
  cwd to decide which repo it is talking to. A factory that drives many repos
  must never guess which one.
- **Tests go in `adws/adw_modules/<name>.test.ts`** and run with `npm test`.
  Note `bunfig.toml` scopes the test root: Bun's default matcher includes
  `*_test.ts`, which would otherwise pick up `adw_plan_build_test.ts` — a
  workflow — and *execute* it.
- **Additive schema changes need a `MIGRATIONS` entry.**
  `CREATE TABLE IF NOT EXISTS` never revisits an existing table.

## Adding a gate

```ts
export const my_gate: Gate = named("my_gate", (envelope, run) => {
  const report = new GateReport();
  report.check("what I looked at", ok, "the evidence either way");
  return report;
});
```

Check **claims, after the fact** (hard rule 3) — never a prediction, never code
quality. `note` is evidence on a pass and the reason on a failure, and on a
failure it is what the agent is told, so write it as something actionable.

Existence is rarely the property that matters. A gate that only asked "does this
file exist" passed a report written into the agent's own CLI state directory:
real, non-empty, and read by nobody. Ask whether the artifact is where the
artifact is *for*.

## Adding a vendor

`agent_claude.ts` is the typed stub and documents the shape. The one genuine
divergence: Copilot's `--session-id` is create-or-continue, while Claude Code's
`--session-id` starts a NEW session and continuing needs `--resume`. The
correction-turn loop in `agents.ts` assumes the former, so a second vendor needs
that branch.
