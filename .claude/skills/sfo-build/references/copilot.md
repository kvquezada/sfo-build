# GitHub Copilot CLI — measured behaviour

Everything here was **measured** against `GitHub Copilot CLI 1.0.86` on
2026-09-20. Where it contradicts an assumption, trust this file. Re-measure
before trusting it after a CLI upgrade.

## The invocation

```
copilot -p "<prompt>"
  --model <id>
  --reasoning-effort <none|minimal|low|medium|high|xhigh|max>
  --session-id <uuid>
  --stream off
  --output-format json
  --allow-all-tools
  -C <target repo>
  --add-dir <dir>              (repeatable)
  --agent <name>
  --available-tools a b c
```

- **`--stream off` is required.** With streaming on the transcript floods with
  per-token `assistant.message_delta` events; off, a turn is ~13 events.
- **`--allow-all-tools` is required for non-interactive**, and it does **not**
  imply `--allow-all-paths`. The path sandbox stays in force.
- **`--session-id` is create-or-continue.** Verified: a second send on the same
  id answered from the first turn's context, `message_count: 3`. This is what
  makes a correction turn cost one turn instead of a cold restart.
- **Session ids must be real UUIDs.** A `name-with-dashes` scheme is rejected.
  This factory derives UUIDv5 from `(adw_id, agent)` so it is both valid and
  deterministic.
- **`--add-dir` grants a whole TREE** and loads its `.github/agents` and
  `.github/skills` as trusted configuration. This is the single fact the entire
  factory/runtime split exists to respect.

## There is no `--system-prompt`

Permanent, and not workable around. The only channel for per-agent instructions
is `--agent <name>`, reading `.github/agents/<name>.md` from an `--add-dir`'d
tree.

Measured: an external agent file arrives as the system segment
`selected_agent_instructions` (63 tokens) **alongside** Copilot's own `identity`
segment (413–523 tokens). **Agent identity is append-only.** Every agent is
"Copilot, plus your instructions" — never yours alone. Prompts must
over-specify; anything left unsaid, Copilot's defaults say for you.

## Models

There is **no `--list-models`** and no local catalog under `~/.copilot/`. A bad
id fails at run time, not validate time:

```
Error: Model "X" from --model flag is not available.
```

exit 1, on stderr, in ~5s, **before any model call** — so probing costs time,
not a premium request. That is what `doctor` does, cached 14 days.

Available on this account (measured): `gpt-5.6-luna`, `gpt-5.6-terra`,
`claude-sonnet-5`, `claude-haiku-4.5`, `gemini-3.6-flash`, `grok-4.6`.
Not available: `claude-opus-5`, `claude-sonnet-4.5`, `gemini-3-pro`, `o4-mini`,
`gpt-5`, `grok-4`, `grok-4-6`, `grok-4.6-fast`.

`grok-4.6` was probed 2026-09-21 on the same CLI build: accepted at
`--reasoning-effort high`, 10 tools offered, and `doctor` reports the adversary
gets every tool it asks for — so its dialect includes `create`, unlike
`gpt-5.6-terra`. The rest of its dialect has not been read off a probe.

### Reasoning effort is per-model

`claude-haiku-4.5` accepts **only** `none`; every other level fails with
`does not support reasoning effort configuration`. `claude-sonnet-5` takes the
full range. There is no catalog for this either, so `doctor` probes the
**(model, thinking) pair**.

## Tool dialects are chosen by the MODEL

Identical flags, identical identity file, identical cwd:

```
gemini-3.6-flash  bash read_bash stop_bash list_bash view create edit
                  search_code_subagent grep glob
gpt-5.6-terra     bash read_bash stop_bash list_bash view
                  search_code_subagent rg glob
```

`gpt-5.6-terra` has **no `create` and no `edit` at all** — it writes through
`bash` — and calls its search tool `rg` where gemini calls it `grep`.

So `--available-tools` is an **intersection filter, not a guarantee**. Asking
for a tool a model lacks is harmless; asking for *only* such tools leaves an
agent unable to act with no error explaining why. Any agent expected to write
files should keep `shell`.

Note also: `create` does **not** create parent directories.

The full unrestricted vocabulary (24 tools):

```
bash create edit fetch_copilot_cli_documentation glob grep list_agents list_bash
read_agent read_bash search_code_subagent session_store_sql skill sql stop_bash
task view web_fetch write_agent  (+ 5 × github-mcp-server-*)
```

`task` / `list_agents` / `read_agent` / `write_agent` mean **Copilot has native
subagents**, so no harness extension is needed for fan-out.

## The path sandbox works, including through bash

Measured, with no factory identity loaded and the request framed as authorized:

```
prompt: bash -> printf x >> <factory>/adws/adw_modules/gates.ts
result: tool success = false
        "write access ... (outside the current project root) was denied by the
         environment permissions policy"
        file UNCHANGED
```

This is **prevention**, which is stronger than detect-and-rollback. It holds
only while nothing passes `--allow-all-paths`, `--allow-all` or `--yolo`.

## Event stream

Every event has `id`, `parentId`, `timestamp`, `type`, `data`, `ephemeral`.
`parentId` gives a native span tree, kept as `events.parent_id`.

| Event | Carries |
|---|---|
| `user.message` | the prompt, plus `transformedContent` with a datetime header |
| `assistant.message` | `content` (the final text), `toolRequests`, `reasoningText` |
| `tool.execution_start` | `toolCallId`, `toolName`, `arguments` |
| `tool.execution_partial_result` | streaming output; may repeat |
| `tool.execution_complete` | `success`, `result.content`, `shellExecution.exitCode` |
| `session.usage_checkpoint` | `totalNanoAiu`, `totalPremiumRequests`, and per-model `prompt_tokens`, `cache_read`, `cache_write`, `tools[]`, `system_segments[]` |
| `result` | `sessionId`, `exitCode`, `usage.premiumRequests`, `usage.codeChanges.filesModified` |

**Note the dots**: `tool.execution_*`, not `tool_execution_*`.

## Usage counters are session-cumulative

Not per-call. Measured on one session: turn 1 reported
`totalPremiumRequests: 14`; turn 2 reported `28`. A fresh session started at
`14` again. So a call's real cost is the **delta** against what that session had
already spent, which is why `agent_map.json` carries the baseline across
processes — a resumed session does not restart at zero.

**There is no dollar cost anywhere.** Only `premiumRequests` and `nanoAiu`,
which is why the schema has two columns and not one invented `total_cost`.

`prompt_tokens` is the size of the prompt actually sent that turn — i.e. current
window occupancy. It is the one honest context number available. There is **no**
context ceiling: `--context` is a *tier* (`default` | `long_context`), not a
number, and no catalog exposes a window size. `context_window` stays 0.
