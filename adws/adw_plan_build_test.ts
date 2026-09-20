#!/usr/bin/env bun
/**
 * ADW Plan Build Test — the full starter chain.
 *
 *   npm run pbt -- --target api "add a GET /health endpoint"
 *
 * Phases: engineer(request) -> planner -> builder
 *         -> code(test) [-> builder(fix) -> code(test) ... bounded]
 *         -> git(commit)
 *
 * Testing is CODE. The suite's argv lives in the target registry, so no agent
 * spends a context window rediscovering it. Failures flow back to the builder
 * as a typed envelope through quality.asEnvelope — the same door an agent
 * handoff uses — and only an exhausted fix loop fails the run.
 *
 * Only tested work gets committed: a red suite leaves the tree uncommitted and
 * exactly where the engineer can see it.
 */

import { adw, main } from "./adw_modules/session.ts";
import * as gates from "./adw_modules/gates.ts";
import * as git from "./adw_modules/git_helper.ts";
import * as quality from "./adw_modules/quality.ts";
import { BuildOutput, PlanOutput, type QualityResult } from "./adw_modules/types.ts";

const REQUIRED_AGENTS = ["planner", "builder"];
const MAX_FIX_LOOPS = 3;

main(
  adw({
    name: "adw_plan_build_test",
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
        ph.log({ input: args.prompt, target: run.target.name, scope: run.target.subdir || "whole repo" });
        ph.done();
      }

      let plan;
      {
        await using ph = run.phase({
          name: "plan",
          kind: "agent",
          owner: "planner",
          description: "Turn the request into an implementable plan",
          retries: 1,
        });
        plan = await ph.call({
          outputType: PlanOutput,
          outputTypeName: "PlanOutput",
          prompt: args.prompt,
          gates: [gates.artifacts_exist, gates.files_non_empty],
        });
        ph.done();
      }

      let build;
      {
        await using ph = run.phase({
          name: "build",
          kind: "agent",
          owner: "builder",
          description: "Implement the plan exactly",
        });
        build = await ph.call({
          outputType: BuildOutput,
          outputTypeName: "BuildOutput",
          prompt: args.prompt,
          previous: plan,
          gates: [gates.diff_matches_claims],
        });
        ph.done();
      }

      let test: QualityResult | null = null;
      for (let i = 1; i <= MAX_FIX_LOOPS; i += 1) {
        {
          await using ph = run.phase({
            name: `test_${i}`,
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
          ph.done();
        }

        if (test.passed) break;
        if (i === MAX_FIX_LOOPS) break; // out of attempts; finish() records why

        await using ph = run.phase({
          name: `fix_${i}`,
          kind: "agent",
          owner: "builder",
          description: "Repair what the suite reported, from its verbatim output",
          retries: 1,
        });
        build = await ph.call({
          outputType: BuildOutput,
          outputTypeName: "BuildOutput",
          prompt: args.prompt,
          previous: quality.asEnvelope(test, "tests"),
          gates: [gates.diff_matches_claims],
        });
        ph.done();
      }

      const green = test?.passed ?? false;
      if (green) {
        await using ph = run.phase({
          name: "commit",
          kind: "code",
          owner: "git",
          description: "Land the code only after the suite came back green",
        });
        const message = build.commit_message || `sfo(${run.adw_id}): ${build.summary}`;
        ph.log({ sha: git.commitAll(message, run.target.path), message });
        ph.done();
      }

      return run.finish(green, `the suite still failed after ${MAX_FIX_LOOPS} attempt(s)`);
    },
  }),
);
