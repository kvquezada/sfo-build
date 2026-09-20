#!/usr/bin/env bun
/**
 * ADW Build Test — implement, verify, repair, land. No plan phase.
 *
 *   npm run bt -- --target api --adw-id <id> "implement the plan"
 *
 * Phases: engineer(request) -> builder
 *         -> code(test) [-> builder(fix) -> code(test) ... bounded]
 *         -> git(commit)
 *
 * `npm run build` is one shot: build, test once, commit if green. This is the
 * same shape with a bounded repair loop, for work where the first attempt is
 * not expected to be the last — and it is what `npm run pbt` becomes once a
 * plan already exists, whether a `npm run plan` wrote one into this session or
 * the engineer knows the change well enough to skip planning it.
 *
 * Testing is CODE. The suite's argv lives in the target registry, so no agent
 * spends a context window rediscovering it, and a failure reaches the builder
 * as a typed envelope through `quality.asEnvelope` — the same door an agent
 * handoff uses.
 *
 * A red suite does NOT fail its phase: the runner ran, the code is what failed.
 * It fails the RUN, at `finish()`, once the loop is out of attempts. Only
 * tested work is committed, so a run that ends red leaves the tree dirty and
 * exactly where the engineer can see it.
 */

import { adw, main } from "./adw_modules/session.ts";
import * as gates from "./adw_modules/gates.ts";
import * as git from "./adw_modules/git_helper.ts";
import * as quality from "./adw_modules/quality.ts";
import { BuildOutput, type QualityResult } from "./adw_modules/types.ts";

const REQUIRED_AGENTS = ["builder"];
const MAX_FIX_LOOPS = 3;

main(
  adw({
    name: "adw_build_test",
    requiredAgents: REQUIRED_AGENTS,
    argv: process.argv.slice(2),
    body: async (run, args) => {
      const record = (
        ph: { log: (payload: Record<string, unknown>) => void },
        result: QualityResult,
      ): void => {
        ph.log({
          passed: result.passed,
          checks: `${result.checks.filter((c) => c.passed).length}/${result.checks.length}`,
          artifacts: result.artifacts.join(", "),
        });
      };

      {
        await using ph = run.phase({
          name: "request",
          kind: "engineer",
          owner: run.engineer,
          description: "Capture the incoming ask",
        });
        ph.log({
          input: args.prompt,
          target: run.target.name,
          scope: run.target.subdir || "whole repo",
        });
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
          record(ph, test);
          ph.done();
        }
        if (test.passed || i === MAX_FIX_LOOPS) break;

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
