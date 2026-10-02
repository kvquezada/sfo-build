# Can hooks see `grilling` and `wayfinder` skill invocations?

Issue: #8 (map #6, Grilling Session app). Researched 2026-10-03 against Claude Code 2.1.287.

## Answer

Yes, but it takes two hook events, because a skill can start in two ways and each way fires a different event:

| How the skill starts | Hook event | Matcher | Skill name is in | Args are in |
| :- | :- | :- | :- | :- |
| The user types `/mattpocock-skills:grilling …` or `/mattpocock-skills:wayfinder …` | `UserPromptExpansion` | `mattpocock-skills:grilling\|mattpocock-skills:wayfinder` | `command_name` | `command_args` |
| Claude calls the Skill tool | `PreToolUse`, or `PostToolUse` | `Skill`, then check `tool_input.skill` inside the script | `tool_input.skill` | `tool_input.args` |

`PreToolUse` on `Skill` does **not** fire when the user types the slash command, and `UserPromptExpansion` does **not** fire when Claude calls the Skill tool. Each path triggers only its own event. Both events can add context for the agent and can run any side effect, such as starting a server or opening a browser.

## Recommended config

```json
{
  "hooks": {
    "UserPromptExpansion": [
      {
        "matcher": "mattpocock-skills:grilling|mattpocock-skills:wayfinder",
        "hooks": [{ "type": "command", "command": "<grilling-session-hook>" }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Skill",
        "hooks": [{ "type": "command", "command": "<grilling-session-hook>" }]
      }
    ]
  }
}
```

The `PreToolUse` script has to filter by skill name on its own. The `Skill` matcher matches every Skill call. Accept `tool_input.skill` when it matches `(^|:)(grilling|wayfinder)$` (see the "Bare names" section below).

## Findings

### 1. Typed slash command: `UserPromptExpansion`

- The docs describe this event as "Runs when a user-typed command expands into a prompt before reaching Claude", and say it can block the command, add context for a particular skill, or log which commands users invoke. [hooks#userpromptexpansion]
- The docs also say: "a `PreToolUse` hook matching the `Skill` tool fires only when Claude calls the tool, but typing `/skillname` directly bypasses `PreToolUse`. `UserPromptExpansion` fires on that direct path." [hooks#userpromptexpansion]
- The matcher runs against `command_name`. The input also includes `expansion_type` (`slash_command` for skills and custom commands, `mcp_prompt` for MCP prompts), `command_args`, `command_source`, and the original `prompt`. [hooks#userpromptexpansion-input]
- Observed input when the user typed `/mattpocock-skills:grilling probe-topic-A …` (probe, see section 6):
  ```json
  {"session_id":"14044c17-…","prompt_id":"537be88c-…","transcript_path":"…/14044c17-….jsonl","cwd":"…",
   "permission_mode":"default","hook_event_name":"UserPromptExpansion","expansion_type":"slash_command",
   "command_name":"mattpocock-skills:grilling","command_args":"probe-topic-A. …","command_source":"plugin",
   "prompt":"/mattpocock-skills:grilling probe-topic-A. …"}
  ```
  For a plugin skill, `command_name` includes the plugin prefix. In this probe, no `PreToolUse`/`Skill` event fired.
- `UserPromptSubmit` fires on the same prompt, after `UserPromptExpansion` in this probe. Its input has only the raw `prompt` text and no parsed command fields. [hooks#userpromptsubmit-input] It also has no matcher support and fires on every prompt. [hooks#matcher-patterns] Use `UserPromptExpansion`, not `UserPromptSubmit`.

### 2. Claude calls the Skill tool: `PreToolUse` / `PostToolUse` with matcher `Skill`

- For tool events, the matcher runs against `tool_name`. [hooks#matcher-patterns] The Skill tool's `tool_name` is `Skill`.
- The input includes `tool_name`, `tool_input`, and `tool_use_id`. [hooks#pretooluse-input] The hooks reference does not document the Skill tool's `tool_input` fields. The probe showed `{"skill": "<name>", "args": "<string>"}`:
  ```json
  {"session_id":"477709b1-…","prompt_id":"87a3743b-…","hook_event_name":"PreToolUse","tool_name":"Skill",
   "tool_input":{"skill":"mattpocock-skills:grilling","args":"probe-topic-B"},"tool_use_id":"toolu_01QqYF…"}
  ```
  `PostToolUse` receives the same fields plus `tool_response` (`{"success":true,"commandName":"mattpocock-skills:grilling"}`) and `duration_ms`.
- **Bare names:** `tool_input.skill` contains exactly the string Claude passed. When Claude was asked to call `grilling` without the prefix, the hook received `"skill":"grilling"` and `commandName:"grilling"`. `wayfinder` itself calls the Skill tool with bare names ("Call the Skill tool twice, for \"grilling\" and \"domain-modeling\"", wayfinder SKILL.md). The filter therefore has to accept both `grilling` and `mattpocock-skills:grilling`.
- Handlers on tool events also have an optional `if` field that uses permission-rule syntax. [hooks#common-fields] Something like `Skill(grilling)` might narrow the hook further, but this research did not test it. Filtering in the script is the dependable option.

### 3. How `wayfinder` and `grilling` can be invoked

- `wayfinder` has `disable-model-invocation: true` in its frontmatter (plugin 1.2.3, `skills/engineering/wayfinder/SKILL.md`). Only the user can start it, by typing the slash command, so only `UserPromptExpansion` will ever see a `wayfinder` start.
- `grilling` can start either way. The user can type `/mattpocock-skills:grilling`. Claude can call it through the Skill tool, either on its own, from `wayfinder` (map step 1 and every grilling ticket), or from other skills that build on it (`grill-me`, `grill-with-docs`, `ask-matt`). This means one `wayfinder` session can trigger several `grilling` Skill calls, so the app should decide whether a second call reuses the open session.

### 4. Injecting context and running side effects

- **Context.** Both events accept `hookSpecificOutput.additionalContext`. For `UserPromptExpansion` it is added "alongside the expanded prompt". [hooks#userpromptexpansion-decision-control] For `PreToolUse`/`PostToolUse` it appears "next to tool result". [hooks#add-context-for-claude] For `UserPromptExpansion`, plain-text stdout is also added as context. [hooks#exit-code-output] Both channels worked in the probe: Claude repeated back `UPE-CONTEXT-MARKER` (plain stdout from `UserPromptExpansion`) and `PRE-CONTEXT-MARKER` (`additionalContext` from `PreToolUse`). This is how the hook can tell the agent the Grilling Session URL.
  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Grilling Session open at http://localhost:NNNN/s/<id>"}}
  ```
- **Side effects.** A command hook is any shell command. It inherits the parent environment and runs without a controlling terminal, so it cannot open `/dev/tty`. [hooks#hook-input-and-output] Starting a detached server and running `open <url>` (macOS) both work from a hook. Keep the hook quick: the default timeout is 600 s, or 30 s on `UserPromptSubmit`, and a hook that times out has its output thrown away. [hooks#common-fields] Spawn the server detached (`nohup … &`) and return straight away.
- **Async.** `"async": true` runs a command hook in the background. Its decision fields are then ignored, and its output is delivered on the next turn instead of with the current prompt or tool call. [hooks#run-hooks-in-the-background] To get the URL into context in the same turn, run the hook synchronously and spawn the server detached from inside it.
- **Blocking.** Neither path needs to block. `PreToolUse` could deny a Skill call (`permissionDecision`), and `UserPromptExpansion` could block the expansion (`decision: "block"`). [hooks#pretooluse-decision-control] Do not set either field.

### 5. Identifiers that tie one Grilling Session to one invocation

| Field | Slash path (`UserPromptExpansion`) | Tool path (`PreToolUse`) | Notes |
| :- | :- | :- | :- |
| `session_id` | yes | yes | The Claude Code session. [hooks#common-input-fields] |
| `transcript_path` | yes | yes | The session's JSONL file. It is written asynchronously and may lag behind. [hooks#common-input-fields] |
| `prompt_id` | yes | yes | UUID of the current user prompt. Requires v2.1.196 or later. [hooks#common-input-fields] |
| `tool_use_id` | no | yes | Unique per Skill call. Also present on `PostToolUse`. [hooks#pretooluse-input] |
| `agent_id` / `agent_type` | in subagents | in subagents | Present only inside a subagent or with `--agent`. [hooks#common-input-fields] |
| `cwd` | yes | yes | Identifies the repo. |

Suggested key: `session_id` plus `tool_use_id`, falling back to `prompt_id` on the slash path, which has no `tool_use_id`. The slash path fires once per typed prompt, so `prompt_id` is unique enough there.

### 6. Probe method

Three headless runs (`claude -p --settings probe/settings.json --model haiku`) with logging hooks on `UserPromptExpansion`, `UserPromptSubmit`, and `PreToolUse`/`PostToolUse` (`Skill`). Each hook appended its stdin to a log file:

1. Prompt `/mattpocock-skills:grilling probe-topic-A …` fired `UserPromptExpansion`, then `UserPromptSubmit`. Neither Skill tool event fired.
2. Asking Claude to call the Skill tool with `mattpocock-skills:grilling` fired `UserPromptSubmit`, then `PreToolUse`, then `PostToolUse`. `UserPromptExpansion` did not fire.
3. Asking Claude to call the Skill tool with bare `grilling` fired `PreToolUse`/`PostToolUse` with `tool_input.skill: "grilling"`.

## Open points for the build

- Decide what the app does when one session triggers several `grilling` Skill calls (`wayfinder` makes these).
- The Skill tool's `tool_input` shape (`skill`, `args`) was only observed in the probe. The hooks reference does not document it, so it could change in a later release.
- Where the hook lives: user `~/.claude/settings.json`, the project's `.claude/settings.json`, or a small local plugin. The trigger decision in #6 rules out putting it in the third-party skill's frontmatter.

## Sources

- [hooks] Claude Code hooks reference, https://code.claude.com/docs/en/hooks (fetched 2026-10-03 as `hooks.md`). Sections cited: Matcher patterns, Common fields (`if`, `timeout`, `async`), Common input fields, Exit code output, Add context for Claude, UserPromptSubmit, UserPromptExpansion, PreToolUse input/decision control, Run hooks in the background.
- Claude Code changelog, https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (2.1.287). No entries contradict the above.
- mattpocock-skills plugin 1.2.3: `skills/engineering/wayfinder/SKILL.md` (frontmatter `disable-model-invocation: true`, bare-name Skill calls), `skills/productivity/grilling/SKILL.md`.
- Local probe on Claude Code 2.1.287 (section 6).
