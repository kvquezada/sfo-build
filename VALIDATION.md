# Validation

What stands between an agent's work and a commit. **Agent proposes, code
disposes**: no agent ever rules on its own output. Four layers, each owned by
code, each answering a different question.

| Layer | Where | Asks | On failure |
|---|---|---|---|
| Gates | `adws/adw_modules/gates.ts` | did the agent do what it *claimed*? | correction turn, same session |
| Permissions | `adws/adw_modules/permissions.ts` | did it write only where it *may*? | phase aborts, no retry |
| Acceptance | each `adws/adw_*.ts` chain | does the work meet the chain's bar? | run fails, code stays uncommitted |
| Evidence | `~/.sfo-build/sessions/<adw_id>/` | what happened? | — |

The chains themselves are in [`WORKFLOWS.md`](WORKFLOWS.md); the agents and
their `writes:` / `retries:` in [`ROSTER.md`](ROSTER.md).

## 1. Gates — verify claims, never predictions

A gate is `gate(envelope, run) -> GateReport`, run after the agent returns its
typed envelope. It checks what the envelope *says* against the disk. "Will this
work?" is not a gate; "you said you wrote this file — did you?" is. Whether the
change is the *right* one is the reviewer's question, and no gate pretends to it.

| Gate | Checks |
|---|---|
| `artifacts_exist` | at least one artifact declared; each exists, inside the repo or this run's session dir |
| `files_non_empty` | no declared artifact is an empty file |
| `json_parses` | every declared `.json` artifact parses |
| `file_in_repo(field)` | the named field points at a file **in the repo** — a work product that ships can't live in the session dir |
| `diff_matches_claims` | the builder claims at least one changed file, and every claimed file exists |
| `verdict_consistent` | a review agrees with itself: no approval with blocking items or unmet requirements, no rejection that names no problem |
| `findings_resolve` | at least one finding; each cites a path that exists |
| `hops_resolve` | every trace hop names a real file in a target this run resolved |
| `options_sound` | each fix option's files exist in its target, and the write-up's first `##` heading is `options[0]` — the order is the recommendation |

Every check is recorded, pass or fail, so a green gate says *what* it verified.

A failed gate goes back to the **same** agent session as a correction —
context intact, one turn instead of a cold start. The budget is the agent's
`retries:` in `sfo.config.yaml` (default `0`); past it the phase fails. Malformed
JSON gets its own separate budget of 2 correction turns before any gate runs.

## 2. Permissions — prevent, then detect

**Prevent** is the harness sandbox: the agent can't write outside its checkout.
It holds only while nothing passes `--allow-all-paths`, `--allow-all` or
`--yolo`, which is why `agent_copilot.ts` never builds them.

**Detect** is the backstop. Both trees are snapshotted before the phase's first
send, and every send in the phase — first prompt, JSON retries, gate
corrections — is measured against that one baseline:

- **target repo** — the change-set must fit the agent's `writes:` allowlist.
  Comparing change-*sets* rather than watching writes is what catches
  `git checkout -- .`: a path dirty before and clean after was reverted, and a
  reversion is a modification.
- **factory tree** — a tripwire. No agent is ever granted it; one differing
  byte is a breach.

A breach is **not** a gate violation. The write already happened, so
re-prompting can't correct it — it aborts the phase and names every offending
path.

This is also why a dirty target repo refuses to run: the diff must be able to
tell the agent's writes from yours.

## 3. Acceptance — each chain's own bar

A run ends `✓ success` only when **every phase passed and the chain's
acceptance test holds**. The two differ on purpose: a test phase that ran the
suite did its job even when the suite came back red, so the phase passes while
the run must not.

| Chain | Commits only when |
|---|---|
| `build` | the suite passes, once |
| `bt`, `pbt` | the suite passes within 3 fix attempts |
| `pbtq` | verify (lint, typecheck, build) **and** the suite are clean within 3 attempts — separate phases, so the two failures are distinguishable |
| `br` | the reviewer approves within 3 revisions; `--adversary` adds a second judge |
| `sdlc` | the suite (3 fix attempts) **and** the review (2 revisions) both come back clean; a revision that changed code triggers a retest |
| `pb` | every phase passed — nothing more. It commits work the suite never saw, deliberately |

The suite and the reviewer answer different questions. The suite asks "does it
run"; the reviewer reads the spec and the code on disk and rules on each
requirement — "is this the thing that was asked for". Neither substitutes for
the other.

Test and verify argv come from the **target registry** (`quality.ts`). Only the
operations a target configured are run, and a target with none is a hard error
rather than a green tick nobody earned.

`ship` is a separate chain, so a run whose tests went red leaves nothing on a
remote.

## 4. Evidence — what a failed run leaves

- the plan commit stands — it records what was asked for
- unverified code stays **uncommitted** in the working tree
- every prompt, raw event, envelope and gate row is under
  `~/.sfo-build/sessions/<adw_id>/`

```bash
npm run phases -- <adw_id>       # phase-by-phase, with gate results
npm run tail -- <adw_id>         # raw events
npm run obs                      # the visualizer
```

Retrying needs a clean tree first. That is the engineer's call, not the
factory's.

## Checking by hand

```bash
npm run doctor -- --target X     # roster prompts, model probes, dialects, clean tree
npm run quality -- --target X    # lint, typecheck, build, test — no agents, no cost
```

The factory's own guarantees are tested in `adws/adw_modules/*.test.ts`
(`gates`, `permissions`, `review`, `runner`, …):

```bash
npm test && npm run typecheck
```
