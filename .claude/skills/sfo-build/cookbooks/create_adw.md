# Create a new ADW

An ADW is a **thin** script (hard rule 6): sequencing and nothing else. If you
find yourself writing logic, it belongs in `adw_modules/`.

## Skeleton

```ts
#!/usr/bin/env bun
/**
 * ADW <name> — <one line>.
 *
 *   npm run <script> -- --target <t> "<prompt>"
 *
 * Phases: engineer(request) -> ... -> git(commit)
 */

import { adw, main } from "./adw_modules/session.ts";
import * as gates from "./adw_modules/gates.ts";
import * as quality from "./adw_modules/quality.ts";
import { BuildOutput } from "./adw_modules/types.ts";

const REQUIRED_AGENTS = ["builder"];          // hard rule 1

main(
  adw({
    name: "adw_<name>",
    requiredAgents: REQUIRED_AGENTS,
    argv: process.argv.slice(2),
    body: async (run, args) => {
      {
        await using ph = run.phase({
          name: "request",
          kind: "engineer",
          owner: run.engineer,
          description: "Capture the incoming ask",
        });
        ph.log({ input: args.prompt, target: run.target.name });
        ph.done();
      }

      // ... phases ...

      return run.finish(accepted, "why it was not accepted");
    },
  }),
);
```

Then add it to `package.json` scripts.

## The rules that bite

- **Braces around each phase.** `await using` disposes at the end of its
  enclosing block, so a phase without its own `{ }` stays open until the function
  returns and the trace shows nonsense timings.
- **`ph.done()` as the last line of the block.** Forgetting it fails the phase,
  which is the safe direction but a confusing one to debug.
- **A real `description`.** Blank, or a restatement of the name, is rejected at
  construction. `commit_plan: "Commit the plan"` tells a reader nothing.
- **A code phase's `ph.done()` means "the runner ran".** Not "the code passed".
  Whether the suite was green is the *run's* acceptance question, settled at
  `run.finish(...)` — never by failing the phase that honestly executed a command.
- **`requireCleanRepo: false`** only for genuinely read-only chains.

## Adding a new envelope type

The contract is a synced triad (hard rule 2):

1. the Zod schema in `types.ts`
2. the JSON example in the agent's `user.md` `## Report` section
3. `outputType` + `outputTypeName` at the call site

Change one, change all three. Drift here shows up as a correction loop that
burns turns re-asking for a field the prompt never mentioned.

## Bounded loops

Repair and revision loops are `for` loops with a constant ceiling, and the
ceiling is a named constant at the top of the file:

```ts
const MAX_FIX_LOOPS = 3;
```

Unbounded retry against a model that cannot solve the problem is how a run costs
real money and still fails.
