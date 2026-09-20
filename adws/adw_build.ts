#!/usr/bin/env bun
/**
 * ADW Build — implement, then verify with the suite.
 *
 *   npm run build -- --target api --adw-id <id> "implement the plan"
 *
 * Phases: engineer(request) -> builder -> code(test) -> git(commit)
 *
 * Joining an existing --adw-id is the point: the planner's plan.md is already
 * in that session's handoff directory, and the builder's own Copilot session
 * for that run is rejoined rather than started cold.
 */

import { adw, main } from "./adw_modules/session.ts";
import * as gates from "./adw_modules/gates.ts";
import * as git from "./adw_modules/git_helper.ts";
import * as quality from "./adw_modules/quality.ts";
import { BuildOutput } from "./adw_modules/types.ts";

const REQUIRED_AGENTS = ["builder"];

main(
  adw({
    name: "adw_build",
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

      let build;
      {
        await using ph = run.phase({
          name: "build",
          kind: "agent",
          owner: "builder",
          description: "Implement the request, or the plan this session already holds",
        });
        build = await ph.call({
          outputType: BuildOutput,
          outputTypeName: "BuildOutput",
          prompt: args.prompt,
          gates: [gates.diff_matches_claims],
        });
        ph.done();
      }

      let test;
      {
        await using ph = run.phase({
          name: "test",
          kind: "code",
          owner: "quality",
          description: "Run the suite — a known command, so code runs it and no agent rediscovers it",
        });
        test = quality.runTests(run);
        ph.log({
          passed: test.passed,
          checks: `${test.checks.filter((c) => c.passed).length}/${test.checks.length}`,
          artifacts: test.artifacts.join(", "),
        });
        // The PHASE succeeded — the runner ran. Whether the CODE passed is the
        // run's acceptance question, settled at finish().
        ph.done();
      }

      if (test.passed) {
        await using ph = run.phase({
          name: "commit",
          kind: "code",
          owner: "git",
          description: "Land the code only after the suite came back green",
        });
        const message = build.commit_message || `chore(${run.adw_id}): ${build.summary}`;
        ph.log({ sha: git.commitAll(message, run.target.path), message });
        ph.done();
      }

      return run.finish(test.passed, "the suite did not pass, so nothing was committed");
    },
  }),
);
