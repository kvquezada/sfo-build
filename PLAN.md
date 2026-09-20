# sfo-build — implementation plan

Build a multi-repo AI software factory, ported from the Super Simple Software Factory
(SSSF) skill. Python→TypeScript, pi→GitHub Copilot, single-repo→central multi-target.

**Source to port FROM:** `~/Workspace/super-simple-software-factory/.claude/skills/sssf/`
**First target repo:** `~/Workspace/personal/oms` (Nx monorepo, already cleaned)
**This factory:** `~/Workspace/sfo-build/` (new private repo)

> Read "Verified facts" before writing code. Every claim there was measured on this
> machine in the design session. Several contradict what the SSSF README says, and
> several contradict reasonable assumptions. Do not re-derive them; do not "fix" a
> decision by reverting to how SSSF did it.

---

## 1. Core idea (unchanged from SSSF)

Deterministic code owns sequencing, retries, and acceptance. Coding agents work inside
bounded phases. Typed JSON envelopes carry context across seams. Every event streams to
SQLite while it happens. **Agent proposes, code disposes.**

Three phase kinds: `engineer` (human), `agent` (prompt in, typed envelope out, gates
verified), `code` (deterministic step — commit, test run). A known command is code, not
an agent.

---

## 2. Settled decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Central factory + **flat target registry** | one install drives many repos; `--target NAME` |
| 2 | **TypeScript on Bun** (not Python, not bash) | collapses the engine/UI type duplication; Zod ≈ pydantic |
| 3 | **`await using`** phase primitive | preserves "success must be earned" without `with` |
| 4 | **Copilot only** for v1; `agent_claude.ts` is a typed stub | Claude Code worker agents rejected on billing |
| 5 | **In-place + dirty guard + per-path lock** (no worktrees) | cheapest; explicitly refuses concurrent runs |
| 6 | **Prevent + detect** permissions | harness sandbox primary, factory tripwire as backstop |
| 7 | Agent cwd = **repo root**; `subdir` is a soft scope | monorepos need cross-package reads |
| 8 | **Neutral tool vocab + `tools_extra`** | keeps a roster entry readable by both adapters |
| 9 | **Next.js visualizer on Node**, shipped last | matches oms stack (Next 16 / React 19) |
| 10 | **Spine of 4 ADWs**, other 8 generated on demand | prove the engine before multiplying it |

### Factory vs runtime — DO NOT COLLAPSE THESE

Forced by decisions 1+6. Agents must write handoff artifacts; the harness sandbox blocks
out-of-tree writes; so the session dir must be `--add-dir`'d; but `--add-dir` grants a
whole tree. If runtime sits under the factory, the agent gets write access to the engine
and the prompts that grade it.

```
~/Workspace/sfo-build/            FACTORY — git repo, granted to NOBODY
  adws/adw_modules/*.ts             engine
  adws/adw_*.ts                     chains
  adws/adw_sfo_config/sfo.config.yaml
  adws/adw_data/prompt_engineering/ <- the grading criteria
  apps/visualizer/
  .claude/skills/sfo-build/

~/.sfo-build/                     RUNTIME — outside git, granted narrowly
  id/<agent>/.github/agents/<agent>.md   --add-dir (that agent only)
  sessions/<adw_id>/context_handoff/     --add-dir (that run only)
  sessions/<adw_id>/<agent>/             envelope.json, raw_output.jsonl, prompts
  sessions/<adw_id>/agent_map.json
  sfo.db
  locks/<repo-path-hash>
```

Per agent call, grants are exactly:
```
-C        <target repo path>
--add-dir ~/.sfo-build/id/<agent>
--add-dir ~/.sfo-build/sessions/<adw_id>
# NEVER: --allow-all-paths, --allow-all, --yolo
# NEVER grant: ~/Workspace/sfo-build, other agents' id dirs, other runs
```

---

## 3. Verified facts (measured — do not re-derive)

### Copilot CLI 1.0.86

Works, and maps onto what SSSF needs:
```
-p                          non-interactive
--output-format json        JSONL, one object per line
--stream off                REQUIRED — otherwise per-token assistant.message_delta floods
--session-id <uuid>         "resume, or set the UUID for a NEW session" = create-or-continue
--reasoning-effort          none|minimal|low|medium|high|xhigh|max
--available-tools           tool allowlist
--excluded-tools
-C <dir>                    working directory
--add-dir <dir>             grants file access AND loads its .github/agents + .github/skills
--agent <name>              select a custom agent
--allow-all-tools           required for non-interactive; does NOT imply --allow-all-paths
COPILOT_HOME                overrides config/state dir (per-agent isolation)
```

**No `--system-prompt`. This is permanent and cannot be worked around.**
Measured: an external `--agent` file arrived as system segment `selected_agent_instructions`
(63 tokens) *alongside* Copilot's own `identity` segment (523 tokens). Agent identity is
**append-only**: every agent is "Copilot plus your instructions", never yours alone.
Prompts must over-specify to compensate.

**Available models (Copilot Pro, measured):**
```
AVAILABLE      gpt-5.6-luna  gpt-5.6-terra  claude-sonnet-5  claude-haiku-4.5  gemini-3.6-flash
NOT AVAILABLE  claude-opus-5  claude-sonnet-4.5  gemini-3-pro  o4-mini  gpt-5
```
There is **no `--list-models`** and no local catalog in `~/.copilot/`. A bad model id fails
at run time, not at validate time. Invalid id → `Error: Model "X" from --model flag is not available.`

**Copilot tool vocabulary (measured, unrestricted run):**
```
bash create edit fetch_copilot_cli_documentation glob grep list_agents list_bash
read_agent read_bash search_code_subagent session_store_sql skill sql stop_bash
task view web_fetch write_agent  (+ github-mcp-server-*)
```
Note `task` / `list_agents` / `read_agent` / `write_agent` — **Copilot has native subagents**,
so SSSF's `harness_engineering: [subagents.ts]` pi extension is unnecessary.
A restricted run reported `rg` where the unrestricted run reported `grep` — dump
`session.usage_checkpoint …tools[].name` in P1 and build the map from real output.

**Path sandbox works, including through bash.** Measured:
```
prompt: bash -> echo PWNED > <factory>/gates.ts
result: file UNCHANGED; agent replied
        "Permission denied. I can't write outside the repo/workspace in this environment."
```
This is *prevention*, stronger than SSSF's detect-and-rollback. It only holds if you never
pass `--allow-all-paths` / `--allow-all` / `--yolo`.

**Copilot event stream shape:**
- every event has `id`, `parentId`, `timestamp`, `type`, `data`, `ephemeral`
- `parentId` gives a native span tree → maps onto `events.parent_id`
- with `--stream off`: ~13 events per turn
- `result` carries `sessionId`, `exitCode`, `usage.premiumRequests`, `usage.codeChanges.filesModified`
- `session.usage_checkpoint` carries `totalNanoAiu`, `totalPremiumRequests`, `prompt_tokens`,
  `cache_read`, `cache_write`, and the full system-prompt segment breakdown
- **no dollar cost anywhere** — `premiumRequests` + `nanoAiu` only

### Claude Code 2.1.278 (reference only — stub adapter)
Has `--system-prompt`, `--system-prompt-file`, `--append-system-prompt`, `--agents <json>`,
`--allowed-tools`, `--add-dir`, `--print --output-format stream-json`, `--session-id <uuid>`
(must be a valid UUID), `--resume`. NOTE: `--session-id` sets a NEW session; continuing
needs `--resume` — unlike Copilot/pi where `--session-id` is create-or-continue.

### Runtimes
- `await using` + `Symbol.asyncDispose` **verified on Bun 1.4.2**; fail-by-default survives
  both clean exit and throw.
- `node:sqlite` **verified identical on Node 23.11.0 and Bun 1.4.2**, zero deps, no native
  build. Node emits `ExperimentalWarning` → suppress with `NODE_OPTIONS=--no-warnings`.
- `just` is NOT installed. Use npm scripts. Do not generate a justfile.
- pi IS installed but has no `~/.pi/agent/models.json`. It never worked. Do not use it.

### Session IDs
Both CLIs want UUIDs. SSSF's `sssf-{adw_id}-{agent}-{rand}` format is invalid.
Use **UUIDv5 derived from (adw_id, agent)** — deterministic, so the resume-context
behaviour via `agent_map.json` still works.

### Target repo: oms
```
~/Workspace/personal/oms   Nx 23.0.1 · NestJS 11 · Next 16.1.6 · React 19 · Jest 30 · npm
projects: ["shared","front","api"]
apps/api/src/{orders(+counters),customers,products,users,stats,app}/   each with *.spec.ts
libs/shared/src/lib/{order,order-stage,customer,product,stats}.ts
full suite: npx nx run-many -t test  ->  3 projects, 70 tests, ALL GREEN, 10s cold
```
State: cleaned of the old sssf install; `git status --porcelain` empty.

---

## 4. Config shape

```yaml
defaults:
  coding_agent: copilot
  model: gemini-3.6-flash
  thinking: medium
  data_dir: ~/.sfo-build
  protected_files: []          # factory is out-of-tree now; tripwire covers it

observability:
  db: ~/.sfo-build/sfo.db
  poll_ms: 500

agents:
  - name: planner    { model: claude-sonnet-5,   thinking: high,   color: "#a78bfa" }
  - name: builder    { model: gpt-5.6-terra,     thinking: medium, color: "#22d3ee" }
  - name: scout      { model: gemini-3.6-flash,  thinking: low,    color: "#fbbf24", writes: [] }
  - name: reviewer   { model: claude-sonnet-5,   thinking: high,   color: "#fb7185", writes: [] }
  - name: documenter { model: claude-haiku-4.5,  thinking: medium, color: "#e879f9",
                       writes: ["app_docs/","docs/","**/*.md","*.md"] }

targets:
  - name: oms
    path: ~/Workspace/personal/oms
    test:  [npx, nx, run-many, -t, test]
    lint:  [npx, nx, run-many, -t, lint]
  - name: api
    path: ~/Workspace/personal/oms
    subdir: apps/api
    test:  [npx, nx, run-many, -t, test]     # repo-wide green, deliberately
    lint:  [npx, nx, lint, api]
  - name: front
    path: ~/Workspace/personal/oms
    subdir: apps/front
    test:  [npx, nx, run-many, -t, test]
    lint:  [npx, nx, lint, front]
```

Reviewer is a **different vendor** from builder on purpose — a reviewer sharing the
builder's failure modes approves the builder's mistakes.

`test` stays repo-wide even on scoped targets: "green" means the same thing everywhere.
`subdir` constrains what the builder may WRITE, not what must pass.

---

## 5. Phases

### P0 · scaffold
```
~/Workspace/sfo-build/  git init
  package.json     deps: zod, yaml, typescript
  tsconfig.json    lib: ["esnext","esnext.disposable"]   <- required for await using
  adws/{adw_modules,adw_sfo_config,adw_data/prompt_engineering}
  apps/visualizer/  .claude/skills/sfo-build/
~/.sfo-build/{id,sessions,locks}
gh repo create sfo-build --private        <- ASK THE USER FIRST (outward-facing)
```

### P1 · engine + first green run — 40%

**Probe before building:** confirm Copilot `--session-id` create-or-continue survives a
second send (the correction turn). If it does not, corrections cost a cold restart and the
retry design must change. This is the single riskiest assumption.

| File | ~Lines | Job |
|---|---|---|
| `types.ts` | 400 | Zod: `EnvelopeBase` + `Plan/Build/Scout/Review/Doc/Verify` outputs, Config, Agent, Target, PhaseParams, AgentCall. **One definition — the UI imports this too** |
| `config.ts` | 120 | load yaml, merge defaults→agents, validate (models via cached probe) |
| `targets.ts` | 150 | resolve target, dirty guard, lock keyed on **path** not target name |
| `tracer.ts` | 300 | `node:sqlite` WAL; 7 tables + `sessions.target`, `sessions.repo_path`, cost split into `premium_requests` / `nano_aiu` (drop `total_cost REAL`) |
| `agent_copilot.ts` | 300 | spawn, JSONL fold, ToolCallTracker, UUIDv5 session ids |
| `tool_map.ts` | 60 | neutral → copilot names; unmapped name = hard fail at validate |
| `runner.ts` | 200 | `Run`, `run.phase()` returning an `AsyncDisposable` |
| `session/console/prompts/utils` | 250 | |
| `adw_prompt.ts` | 50 | |
| `sfo.config.yaml` | | roster + targets above |
| 5×2 prompts | | **written for the oms domain** — orders/order-stage/customers/products/stats, Nest module conventions, colocated `*.spec.ts`, nx targets. NOT ported from sssf (those describe a demo app) |
| npm observe scripts | | `sessions`, `phases`, `tail`, `procs` — ship here, not P5 |

Exit: `npm run prompt -- --target oms "one-line summary of this repo"` → ACCEPTED, rows in `sfo.db`.

### P2 · enforcement — 10%
- `identity.ts` — generate `~/.sfo-build/id/<agent>/.github/agents/<agent>.md` from
  `prompt_engineering/<agent>/system.md`, `--add-dir` it
- `permissions.ts` — two-tree snapshot/enforce (target repo for `writes:`, factory tree as
  tripwire where ANY change = breach)
- `gates.ts` — `artifacts_exist`, `files_non_empty`, `json_parses`, `diff_matches_claims`
- `adw_scout.ts`

Exit: scout run leaves oms clean · deliberate out-of-scope write fails the phase ·
bash escape to the factory refused.

### P3 · code phases — 10%
- `quality.ts` — per-target argv, cwd = `path/subdir`. **Real commands from the registry,
  never placeholders.** (SSSF's #1 shipped failure mode is placeholder commands that exit 0.)
- `git_helper.ts`
- `adw_plan_build_test.ts`

Exit: `GET /health` on api → green → committed. Force one red to exercise the bounded fix loop.

### P4 · full chain — 5%
`adw_simple_sdlc.ts` + reviewer/documenter prompts.

Exit — the smoke task is **pagination on `GET /customers`**:
`?page=` / `?limit=` across `customers.controller.ts`, `customers.service.ts`, and its spec.
All 70 existing tests stay green. 3 commits from 3 authors. Reviewer approves. Documenter
writes it up. Chosen because it edits EXISTING code, so the green suite is a real
regression check.

### P6 · skill + docs — 5%
`SKILL.md` (hard rules + routing table), 9 cookbooks, `references/`, `install.ts`, README.
Exit: `/sfo-build install` works in a fresh repo.

### P5 · visualizer — 30%
Next.js App Router **on Node**, `node:sqlite`, `NODE_OPTIONS=--no-warnings`, 8 routes ported
from the Vue original, plus target filter and badge. Port reference:
`~/Workspace/super-simple-software-factory/.claude/skills/sssf/apps/visualizer/`
(4,621 lines Vue — `shared/types.ts` there is now redundant, import `types.ts` from the engine).
Built against real P1–P4 runs in the db. No fixtures.

**Order: P0 → P1 → P2 → P3 → P4 → P6 → P5.**

---

## 6. Hard rules (carry over from SSSF)

1. Every ADW declares `REQUIRED_AGENTS` and validates before anything spawns.
2. Typed outputs only. The contract is a **synced triad**: the Zod type, the JSON example in
   the agent's `user.md` `## Report` section, and `outputType:` at the call site. Change one,
   change all three. (Consider generating the example from the schema via `zod-to-json-schema`
   — this kills the drift failure mode outright.)
3. Gates validate claims after the fact, never predictions.
4. >4 params → take one typed object instead.
5. One agent, one prompt, one purpose.
6. ADW scripts stay thin; all logic in `adw_modules/`.
7. Every phase needs a real one-sentence `description`; reject blank or name-restating.
8. A known command is code, not an agent.
9. `tools:` is capability, `writes:` is boundary.
10. Every ADW ends in `run.finish(accepted=...)`.

---

## 7. Known impossibilities (do not attempt)

1. **Replacing Copilot's system prompt.** No flag exists. Identity is append-only, forever.
2. **Fail-fast model validation.** No catalog. Cached probe is the best available.
3. **A single honest `total_cost`.** No dollars from Copilot. Columns split.
4. **Context-occupancy gauge.** `--context` is a tier, not a number; no catalog to read a
   window from. `agent_sessions.context_window` will be null/0 for Copilot.
5. **pi harness extensions** (`-e file.ts`). Neither CLI loads them. Native `task` + MCP instead.
6. **Claude Code as a worker agent.** Billing decision. `agent_claude.ts` stays a typed stub.
7. **Atomic cross-workspace runs.** Flat targets → `api` and `front` are two runs.
8. **Concurrent runs on one repo path.** The lock refuses them.
9. **Per-repo factory variants.** One roster, one prompt set, all targets.

---

## 8. Risks

| Risk | When | Mitigation |
|---|---|---|
| Copilot session resume across correction turns unverified | P1, FIRST | probe before design commits |
| Tool names guessed (`rg` vs `grep` differed between probes) | P1 | dump real `usage_checkpoint` tool names |
| Append-only identity leaks Copilot defaults into agent behavior | P2 | over-specify prompts; measure |
| Zod error prose weaker than pydantic for corrections | P1 | ~20-line formatter |
| oms dirty at run time blocks every run | P3+ | dirty guard fails fast with a clear message |

---

## 9. Usage (once built)

```bash
cd ~/Workspace/sfo-build && npm install
npm run doctor                                  # validate roster models against Copilot

npm run prompt -- --target oms   "summarize how orders are validated"
npm run scout  -- --target api   "where is order-stage enforced"
npm run sdlc   -- --target api   "add pagination to GET /customers"

npm run plan   -- --target api "add /health"           # prints adw_id
npm run build  -- --target api --adw-id <id> "implement the plan"

npm run sessions ; npm run phases -- <id> ; npm run tail -- <id>
npm run obs                                     # after P5
```
