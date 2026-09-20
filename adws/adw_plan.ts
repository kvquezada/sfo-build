#!/usr/bin/env bun
/**
 * ADW Plan — produce a spec and stop.
 *
 *   npm run plan -- --target api "add a /health endpoint"    # prints the adw_id
 *
 * Phases: engineer(request) -> planner
 *
 * The adw_id it prints is the handle: pass it to `npm run build -- --adw-id
 * <id>` and the builder rejoins the same session directory and reads the same
 * plan.md the planner just wrote.
 */

import { adw, main } from "./adw_modules/session.ts";
import * as gates from "./adw_modules/gates.ts";
import { PlanOutput } from "./adw_modules/types.ts";

const REQUIRED_AGENTS = ["planner"];

main(
  adw({
    name: "adw_plan",
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

      {
        await using ph = run.phase({
          name: "plan",
          kind: "agent",
          owner: "planner",
          description: "Turn the request into a plan the builder can implement without asking questions",
          retries: 1,
        });
        await ph.call({
          outputType: PlanOutput,
          outputTypeName: "PlanOutput",
          prompt: args.prompt,
          gates: [gates.artifacts_exist, gates.files_non_empty],
        });
        ph.done();
      }

      return run.finish();
    },
  }),
);
