# System map

## The shape

```
engineer request
  → ADW script (adws/adw_*.ts)         sequencing, retries, acceptance — DETERMINISTIC
      → run.phase(...)                 one primitive, three kinds
          engineer   a human decision, logged
          agent      prompt in → typed envelope out → gates verified
          code       a known command: test, lint, commit, diff, mkdir
      → agents.execute()               render prompts → copilot → parse → gate → enforce
      → run.finish(accepted)           two criteria: every phase passed AND the ADW's own test
  → ~/.sfo-build/sfo.db                every event, as it happens
```

## Why it is split this way

**Deterministic code owns anything that can be written down.** A test command is
a command, not a judgement call; an agent rediscovering it every run spends a
context window learning what a subprocess already knows. Agents get the parts
that need reading and deciding.

**Success must be earned.** A phase is born `fail`. `ph.done()` is the only thing
that flips it, so any `throw`, `return` or `break` that skips that line leaves the
phase failed. Failing closed is the safe direction.

**Claims are verified, never trusted.** An agent's final message is parsed against
a Zod schema; its declared artifacts are opened; its declared changed files are
stat'd; the repo is diffed before and after to see what it really touched. What
it *said* it did is an input to verification, not a substitute for it.

**Two questions, asked separately.** The suite asks "does it run". The reviewer
asks "is this what was asked for". Neither can answer the other's, so the full
chain asks both, in that order, and commits only when both are satisfied.

## Key modules

| File | Job |
|---|---|
| `types.ts` | every Zod schema and shared type. One definition; the UI imports it too |
| `config.ts` | load roster + registry, merge defaults, validate, probe models |
| `targets.ts` | resolve `--target`, dirty guard, per-PATH concurrency lock |
| `session.ts` | the `adw()` lifecycle: validate → lock → run → finish |
| `runner.ts` | `Run`, and `run.phase()` returning an `AsyncDisposable` |
| `agents.ts` | one agent call: prompts → copilot → parse → gates → permissions |
| `agent_copilot.ts` | spawn, JSONL fold, tool-call tracker, usage deltas |
| `identity.ts` | writes `--agent` files; the only channel for a system prompt |
| `tool_map.ts` | neutral tool vocabulary → each vendor's real names |
| `gates.ts` | claim verification |
| `permissions.ts` | two-tree snapshot/enforce: repo scope + factory tripwire |
| `quality.ts` | deterministic test/lint/typecheck/build from the registry |
| `changes.ts` | deterministic diff capture for the documenter |
| `tracer.ts` | `node:sqlite`, WAL, 7 tables |
| `console.ts` | one narrative, printed and traced together |

## The phase primitive

```ts
{
  await using ph = run.phase({
    name: "build",
    kind: "agent",
    owner: "builder",
    description: "Implement the plan exactly",   // REQUIRED, and must say something
  });
  const build = await ph.call({
    outputType: BuildOutput,
    outputTypeName: "BuildOutput",
    prompt,
    previous: plan,
    gates: [gates.diff_matches_claims],
  });
  ph.done();                                      // success, earned
}
```

## What a run leaves behind

```
~/.sfo-build/sessions/<adw_id>/
  agent_map.json          per-agent session ids + usage baselines
  events.jsonl            the raw record
  context_handoff/        plan.md, review.md, scout.md, changes.diff, quality/
  <agent>/
    prompts/system.md     the EXACT text sent, saved before execution
    prompts/user.md
    raw_output.jsonl      every Copilot event
    envelope.json         the parsed, validated output
```

Plus rows in `~/.sfo-build/sfo.db`. See
[../references/observability.md](../references/observability.md).
