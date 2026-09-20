#!/usr/bin/env bun
/**
 * ADW Scout — read-only recon. Just looking for stuff.
 *
 *   npm run scout -- --target api "<question or path/to/question.md>"
 *
 * Phases: engineer(request) -> scout
 *
 * The cheapest workflow in the factory, and the one that proves enforcement:
 * scout's `writes: []` means the repo must be byte-identical afterwards, while
 * its findings still land in the session handoff directory outside the repo.
 */

import { adw, main } from "./adw_modules/session.ts";
import * as gates from "./adw_modules/gates.ts";
import { ScoutOutput } from "./adw_modules/types.ts";

const REQUIRED_AGENTS = ["scout"];

main(
  adw({
    name: "adw_scout",
    requiredAgents: REQUIRED_AGENTS,
    argv: process.argv.slice(2),
    body: async (run, args) => {
      {
        await using ph = run.phase({
          name: "request",
          kind: "engineer",
          owner: run.engineer,
          description: "Capture the question being asked of the codebase",
        });
        ph.log({ input: args.prompt, target: run.target.name });
        ph.done();
      }

      {
        await using ph = run.phase({
          name: "scout",
          kind: "agent",
          owner: "scout",
          description: "Find and report where things live — change nothing",
          retries: 1,
        });
        await ph.call({
          outputType: ScoutOutput,
          outputTypeName: "ScoutOutput",
          prompt: args.prompt,
          gates: [gates.artifacts_exist, gates.files_non_empty, gates.findings_resolve],
        });
        ph.done();
      }

      return run.finish();
    },
  }),
);
