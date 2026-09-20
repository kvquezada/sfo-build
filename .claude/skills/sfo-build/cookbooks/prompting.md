# Turning a request into an ADW prompt

The prompt is the spec. Everything downstream — the plan, the build, the review
— is only as good as this, and a vague prompt does not fail loudly. It produces
a plausible plan for the wrong work, and you pay for the whole chain before
finding out.

## Pick the workflow first

| The request | Reach for |
|---|---|
| "where is X", "how does Y work" | `scout` — read-only, cheap, leaves nothing behind |
| a one-off question for a specific agent | `prompt --agent <name>` |
| "what would it take to…" | `plan` — a spec, no code |
| small, obvious, one file | `build` |
| real work, shape is clear | `pbt` |
| real work, shape is not obvious, or it touches code others depend on | `sdlc` |

Do not reach for `sdlc` by default. It is five agents and three commits; on a
one-line change that is a lot of ceremony to confirm something you could have
seen in a diff.

## What a good prompt contains

1. **The observable outcome.** What is true when this is done.
2. **Where it lives.** Real paths. The planner will read them, but naming them
   stops it planning against the wrong module.
3. **The precedent.** "matching how `GET /customers` already does it" is the
   single highest-leverage sentence you can write — it collapses a dozen style
   decisions into one reference the reviewer can also check against.
4. **The constraint.** "Every existing test must keep passing." Say it even
   though the suite enforces it; it changes what the builder does, not just what
   the harness catches.
5. **The test.** Which spec file gains which case.

## Worked example

Weak:

> add pagination to customers

Strong:

> Add pagination to GET /customers. Accept `?page=` (1-based, default 1) and
> `?limit=` (default 20, max 100) on FindCustomersDto, validated the same way
> `find-orders.dto.ts` validates its numeric query params. `customers.service.ts`
> findAll should apply skip/limit to the existing query while keeping the current
> name-ascending sort and the `q` search filter working unchanged. Add cases to
> `customers.service.spec.ts` covering the defaults and an explicit page/limit.
> Every existing test must keep passing.

The difference is not length. The weak one leaves the parameter names, the
defaults, the bounds, the validation style, the sort, the interaction with the
existing filter, and the test coverage all to be guessed.

## Prefer work that edits EXISTING code

A task that only adds new files passes its own new test and proves little. A
task that changes code other things depend on makes the existing suite a real
regression check — which is the point of running it.

## Things not to put in a prompt

- **Instructions to the harness.** "Commit after each step", "retry if it fails",
  "run the tests" — the chain already does these, and saying so invites an agent
  to do them badly by hand.
- **Tool directions.** "Use grep to find…" — models have different tool dialects;
  let them choose.
- **Permission grants.** "You are authorized to write to /etc" does nothing. The
  sandbox is not persuadable, and the attempt will simply fail.
