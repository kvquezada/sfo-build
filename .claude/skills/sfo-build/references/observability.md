# Observability

Every event lands in JSONL **and** SQLite as it happens. Files are the raw
record; `~/.sfo-build/sfo.db` is the queryable mirror. No push transport — the
flow is always `agents → sqlite → reader`. WAL mode, so reads never block a
running workflow.

## Schema

Seven tables. `node:sqlite`, zero dependencies, identical on Node 23 and Bun 1.4.

```sql
sessions(adw_id PK, adw_name, request, status, engineer,
         target, repo_path,                    -- which registry row, which checkout
         started_at, ended_at,
         total_tokens, premium_requests, nano_aiu,
         archived,                              -- review triage
         rating, note, feedback_at)             -- the reader's judgement

phases(phase_id PK, adw_id, seq, name, kind, owner, description,
       status, attempt, retries, error, started_at, ended_at)

events(event_id PK, adw_id, phase_id, parent_id, type, name,
       payload_json, tokens, started_at, ended_at)

envelopes(envelope_id PK, adw_id, phase_id, agent, output_type,
          payload_json, valid, attempt, created_at)

gate_results(id PK, adw_id, phase_id, attempt, gate, passed,
             violations_json, checks_json, created_at)

processes(id PK, adw_id, kind, name, pid, command, started_at, ended_at)

agent_sessions(adw_id, agent, coding_agent, model, color, session_id,
               context_tokens, context_window, tools_json,
               created_at, last_used_at, PRIMARY KEY(adw_id, agent))
```

### Things that will trip you up

- **`phase_id` is NULL**, not `""`, for session-scoped events. `node:sqlite`
  enforces foreign keys where Python's `sqlite3` does not, and `""` is not a
  phase anyone inserted.
- **Cost is two columns.** `premium_requests` and `nano_aiu`. Copilot reports no
  dollars, so there is no `total_cost` to select — a single number would be a
  guess wearing a decimal point.
- **`context_window` is 0 for Copilot** and always will be. `--context` is a
  tier, not a number. `context_tokens` is real (the last turn's `prompt_tokens`).
- **`status` starts `'fail'`.** Success is earned.
- **`parent_id`** is Copilot's own `parentId` — a native span tree.
- Additive columns need a `MIGRATIONS` entry in `tracer.ts`;
  `CREATE TABLE IF NOT EXISTS` never revisits an existing table. Putting a
  column in `SCHEMA` alone works on your machine and nowhere else — `archived`
  shipped that way and never reached a single existing database.
- **Four columns are the reader's, not the run's.** `archived` (triage) and
  `rating` / `note` / `feedback_at` (a 1-5 score and a note, set in the visualizer
  after the fact) are written only by the UI, through the one writable
  connection in `apps/visualizer/lib/db.ts`. No `Tracer` method touches them,
  which is what lets a chained ADW rejoin an `adw_id` without erasing what
  someone wrote about the last pass. `rating` is an integer 1-5, NULL unrated.

## Event types

`phase_start` · `phase_end` · `agent_start` · `agent_end` · `tool_call` ·
`handoff` · `gate_pass` · `gate_fail` · `log` · `error`

`log` events carry `{message, level}` and are what the console printed — the
terminal narrative and the trace are the same story, emitted together so they
cannot drift. Notable `name` values on `log`: `paths_touched` (what an agent
really changed), `tool_dialect` (requested vs offered tools), `not_accepted`.

## From the terminal

```bash
npm run sessions                 # every run, newest first
npm run phases -- <adw_id>       # phases + gate tallies + spend
npm run tail -- <adw_id> [--type tool_call] [--limit 80]
npm run procs                    # live processes, with pids
```

## Useful queries

```sql
-- what did each agent actually touch
SELECT name, payload_json FROM events
 WHERE adw_id = ? AND type = 'log' AND name = 'paths_touched';

-- every gate that ever failed, with its evidence
SELECT phase_id, gate, attempt, checks_json FROM gate_results
 WHERE passed = 0 ORDER BY id DESC;

-- correction turns: the same phase parsed more than once
SELECT phase_id, agent, output_type, attempt, valid FROM envelopes
 WHERE adw_id = ? ORDER BY created_at;

-- spend by target
SELECT target, COUNT(*) runs, SUM(premium_requests) prem, SUM(nano_aiu) aiu
  FROM sessions GROUP BY target;

-- runs that claimed success while a phase failed (should never return rows)
SELECT s.adw_id FROM sessions s JOIN phases p USING (adw_id)
 WHERE s.status = 'success' AND p.status = 'fail';
```

## On disk

```
~/.sfo-build/sessions/<adw_id>/
  events.jsonl            every event, in order, as it happened
  agent_map.json          per-agent session ids + usage baselines
  context_handoff/        plan.md · review.md · scout.md · changes.diff
  context_handoff/quality/<seq>_<name>/command.log
  <agent>/prompts/{system,user}.md    the EXACT text sent
  <agent>/raw_output.jsonl            every Copilot event for that agent
  <agent>/envelope.json               the parsed, validated output
```

`command.log` records the argv, the cwd, the exit code, the duration and the
full stdout/stderr of every deterministic block — so "the suite was green" is
always checkable after the fact, not merely asserted.
