# Can a Claude Code tool call block until Send?

Issue: #7 (map #6, Grilling Session app). Researched 2026-10-03 against Claude Code
docs as published that day; local CLI is v2.1.287.

## Answer

Yes. An MCP tool on a **stdio** server can hold a call open for hours. The call
returns when the human hits Send. Three limits apply, and each one can be
configured:

1. **Wall-clock.** It defaults to about 28 h. Set it per server with `timeout`.
2. **Idle timeout.** It defaults to 30 min on stdio. Periodic progress
   notifications reset it, and a per-server `timeout` also sets its floor.
3. **Auto-backgrounding.** After 2 min, Claude Code moves a main-conversation
   MCP call into a background task, and the turn stops blocking. Turn this off
   with `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`.

A Bash command can also block, but only up to the Bash ceiling (10 min by
default, raisable). After that Claude Code moves the command to the background
and does not kill it, so the turn stops blocking.

**Recommendation:** use a stdio MCP server tool that blocks until Send, and
treat a Bash CLI as the fallback.

## MCP tool call: the limits

| Limit | Default | Knob | Source |
| - | - | - | - |
| Server startup | 30 s | `MCP_TIMEOUT` | [env-vars][env] |
| Tool wall-clock | 100000000 ms (~28 h) | `MCP_TOOL_TIMEOUT`, or per-server `timeout` in `.mcp.json` (overrides it; values < 1000 ignored) | [env-vars][env], [mcp][mcp-t] |
| Per-request first-byte timer | max(60 s, tool timeout, `MCP_TIMEOUT`) | HTTP/SSE/connector only. **Stdio and WebSocket have none** | [mcp][mcp-t] |
| Idle (no response, no progress) | 5 min network, **30 min stdio** | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (`0` disables). Per-server `timeout` ≥ 1000 is a floor on it (v2.1.203+) | [mcp][mcp-t], [env-vars][env] |
| Auto-background | 120000 ms (2 min) | `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` (`0` disables); `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` also disables it (v2.1.212+) | [mcp][mcp-bg], [env-vars][env] |

Facts that matter for the design:

- "The per-server `timeout` is a hard wall-clock limit per tool call, and
  progress notifications from the server don't extend it." [mcp][mcp-t]
- Progress notifications **do** reset the idle timer: a call aborts only when
  the server "sends no response and no progress notification for the idle
  window." [mcp][mcp-t]
- "An MCP tool call in the main conversation that is still running after two
  minutes moves to a background task instead of blocking the session. Claude
  receives the task ID immediately and keeps working, and the result arrives as
  a task notification when the call settles." [mcp][mcp-bg] The `/tasks` entry
  shows the latest progress the server reported, and the task does not survive
  the session ending. The wall-clock and idle limits still apply.
- Some calls are never backgrounded. Calls from **subagents** stay in the
  foreground, and so do calls to IDE servers and calls in non-interactive `-p`
  mode (unless `CLAUDE_AUTO_BACKGROUND_TASKS=1`). Claude Code also does not
  background a call while an **elicitation dialog** is open. [mcp][mcp-bg]
- The MCP spec lets a client "reset the timeout clock when receiving a progress
  notification" but says it "SHOULD always enforce a maximum timeout".
  [spec lifecycle][spec-life] Claude Code follows that rule: progress resets
  the idle clock but not the wall-clock.
- Progress uses `notifications/progress` with the request's `progressToken`.
  [spec progress][spec-prog]

### Example config (a blocking stdio server)

```jsonc
// .mcp.json
{ "mcpServers": { "grilling": {
    "command": "bun", "args": ["apps/grilling-session/mcp.ts"],
    "timeout": 14400000            // 4 h wall-clock; also a 4 h idle floor
} } }
```

```jsonc
// .claude/settings.json (or settings.local.json)
{ "env": { "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS": "0" } }
```

The server should still send a `notifications/progress` about every 60 s, for
example "waiting on Round 3", because those updates show in the UI and in
`/tasks`.

## Bash: the limits

| Limit | Default | Knob | Source |
| - | - | - | - |
| Foreground default | 2 min | `BASH_DEFAULT_TIMEOUT_MS` | [tools][tools], [env-vars][env] |
| Foreground ceiling | 10 min | `BASH_MAX_TIMEOUT_MS` (effective = max of the two) | same |
| Background (`run_in_background`) | 30 min, or the `timeout` Claude passes, up to 2 h | Raise with `BASH_DEFAULT_TIMEOUT_MS` > 1800000 / `BASH_MAX_TIMEOUT_MS` > 7200000 (v2.1.285+) | [tools][tools] |

- When a foreground command hits its timeout, Claude Code "moves it to the
  background instead of stopping it, unless the command starts with `sleep`".
  The result reads "Command did not complete within its 120s timeout and was
  moved to the background". From then on the turn no longer blocks. [tools][tools]
- Claude chooses the per-call `timeout`, and the user never sets it. [tools][tools]
  A blocking CLI therefore depends on Claude passing a large `timeout` and on
  the env ceiling having been raised.
- A background command that the main conversation started keeps running after
  the turn ends. When it finishes, Claude gets a notification that starts a new
  turn. A foreground subagent's background commands stop when that subagent
  ends. [tools][tools]

## How each option behaves on interrupt

- **Esc** "Stop[s] the current response or tool call mid-turn so you can
  redirect. Claude keeps the work done so far." [interactive][int] Ctrl+C
  interrupts in the same way.
- **Ctrl+Enter** (send queued messages now) moves backgroundable work (shell
  commands, subagents) to the background and lets Claude read the messages in
  the same turn. If the running work cannot move to the background, the key
  interrupts the turn instead (v2.1.281+). [interactive][int-q] A message
  queued without that key waits until the running tool calls finish.
- **MCP cancellation:** the spec defines `notifications/cancelled`, after which
  the receiver "SHOULD stop processing … not send a response."
  [spec cancellation][spec-cancel] The Claude Code docs **do not say** whether
  Esc sends `notifications/cancelled` to the server. *Unverified.* The server
  should treat both cancel and stdio close as "the agent stopped waiting", keep
  the Round open in the app, and let a later call re-attach to it by Round id.
- **Background tasks** (backgrounded MCP calls and `run_in_background` Bash)
  can be stopped from `/tasks` or with `TaskStop`. [tools][tools], [mcp][mcp-bg]

## Option comparison

| Option | Blocks the turn? | Ceiling | Verdict |
| - | - | - | - |
| **MCP stdio tool waits for Send** | Yes, if auto-background is off (always for subagents) | ~28 h, set per server | **Recommended** |
| Bash CLI that waits (e.g. long-poll `curl`) | Up to `BASH_MAX_TIMEOUT_MS` (10 min default), then auto-backgrounds | Raisable via env | Fallback; depends on Claude passing a large `timeout` |
| Bash `run_in_background` + completion notification | No: the turn ends and a new turn starts on completion | 30 min / 2 h | Works if "resume on a new turn" is acceptable; loses the single turn |
| MCP call left to auto-background | No after 2 min; the result arrives as a task notification | ~28 h | Same semantics as the row above; this is the default you get |
| File drop + poll | No; each poll is a turn or a tool call | none | Reject: wastes tokens and turns |
| Channel push (`notifications/claude/channel`) | No; it pushes a new event into the session | n/a | Research preview, needs `--dangerously-load-development-channels`. [channels][chan] Worth revisiting later |
| MCP elicitation (URL mode) | Yes; the call is not backgrounded while the dialog is open | wall-clock | Terminal dialog shows a link prompt; it is a sign-in-style flow, so it feels awkward for Rounds. [mcp][mcp-elic] |

## Sources

- [mcp-t]: https://code.claude.com/docs/en/mcp (MCP server timeouts, around line 414 of `mcp.md`)
- [mcp-bg]: https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls
- [mcp-elic]: https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests
- [env]: https://code.claude.com/docs/en/env-vars
- [tools]: https://code.claude.com/docs/en/tools-reference (Bash tool: timeouts, background commands)
- [int]: https://code.claude.com/docs/en/interactive-mode (keyboard shortcuts)
- [int-q]: https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works
- [chan]: https://code.claude.com/docs/en/channels-reference
- [spec-life]: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#timeouts
- [spec-prog]: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress
- [spec-cancel]: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation

[mcp-t]: https://code.claude.com/docs/en/mcp
[mcp-bg]: https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls
[mcp-elic]: https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests
[env]: https://code.claude.com/docs/en/env-vars
[tools]: https://code.claude.com/docs/en/tools-reference
[int]: https://code.claude.com/docs/en/interactive-mode
[int-q]: https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works
[chan]: https://code.claude.com/docs/en/channels-reference
[spec-life]: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#timeouts
[spec-prog]: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress
[spec-cancel]: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation

## Open questions

- Does Esc send `notifications/cancelled` to a stdio server? Answer it with a
  10-line prototype server that logs incoming notifications.
- Should a backgrounded call (auto-background left on) be acceptable UX? That
  would let the agent keep working while the human answers.
