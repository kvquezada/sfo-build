#!/usr/bin/env bun
/**
 * ADW Plan Build Test Quality — the full chain with the deterministic blocks in it.
 *
 *   npm run pbtq -- --target api "add pagination to GET /customers"
 *
 * Phases: engineer(request) -> planner -> builder
 *         -> code(verify) -> code(test) [-> builder(fix) -> ... bounded]
 *         -> git(commit)
 *
 * `npm run pbt` gates on the suite alone. This gates on everything the target
 * registry knows how to run: lint, typecheck and build first, then the suite.
 * Use it when the repo's definition of green is wider than its tests — a lint
 * rule that is really a design rule, a typecheck that catches what no test
 * covers.
 *
 * Verify and test get their OWN phases, and that is the correction SSSF's
 * version asked for in a comment and never made: it folded the suite into the
 * quality block, so the trace could not say whether a run died on lint or on a
 * test, and a lint failure paid for a full test run before anyone saw it. Two
 * phases, two artifacts, two readings.
 *
 * Both are CODE. A red block does not fail its phase — the runner ran, the code
 * is what failed. Whichever block broke becomes the builder's spec, verbatim
 * command output with no parser standing between the failure and the fix, and
 * only an exhausted repair loop fails the run. Nothing is committed until both
 * come back clean.
 */

import { adw, main } from "./adw_modules/session.ts";
import * as gates from "./adw_modules/gates.ts";
import * as git from "./adw_modules/git_helper.ts";
import * as quality from "./adw_modules/quality.ts";
import {
  BuildOutput,
  PlanOutput,
  type QualityOperation,
  type QualityResult,
} from "./adw_modules/types.ts";

const REQUIRED_AGENTS = ["planner", "builder"];
const MAX_FIX_LOOPS = 3;

/** Everything except the suite, cheapest first. The suite is its own phase. */
const VERIFY_OPERATIONS: QualityOperation[] = ["lint", "typecheck", "build"];

main(
  adw({
    name: "adw_plan_build_test_quality",
    requiredAgents: REQUIRED_AGENTS,
    argv: process.argv.slice(2),
    body: async (run, args) => {
      const verifyOps = quality.configured(run.target, VERIFY_OPERATIONS);
      if (!verifyOps.length) {
        throw new Error(
          `target '${run.target.name}' configures none of ${VERIFY_OPERATIONS.join(", ")}, ` +
            `so this chain is just 'npm run pbt' with an empty phase in it.\n\n` +
            `Either add a block to adws/adw_sfo_config/sfo.config.yaml as an argv LIST, e.g.\n` +
            `      lint: [npx, nx, lint, ${run.target.name}]\n` +
            `or run: npm run pbt -- --target ${run.target.name} "<prompt>"`,
        );
      }

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
          description: "Capture the incoming ask and what green will be measured by",
        });
        ph.log({
          input: args.prompt,
          target: run.target.name,
          scope: run.target.subdir || "whole repo",
          verify: verifyOps.join(", "),
        });
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

      let verify: QualityResult | null = null;
      let test: QualityResult | null = null;
      for (let i = 1; i <= MAX_FIX_LOOPS; i += 1) {
        {
          await using ph = run.phase({
            name: `verify_${i}`,
            kind: "code",
            owner: "quality",
            description: "Lint, typecheck and build — the checks that are cheaper than the suite",
          });
          verify = quality.runQuality(run, verifyOps);
          record(ph, verify);
          ph.done();
        }

        // Only pay for the suite once the cheap checks agree the tree compiles.
        if (verify.passed) {
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

        if (verify.passed && test?.passed) break;
        if (i === MAX_FIX_LOOPS) break;

        // Whichever block broke is the spec for the repair. Verify comes first
        // because a tree that does not compile makes every test failure noise.
        const broken = verify.passed ? test! : verify;
        const what = verify.passed ? "tests" : "verification";
        await using ph = run.phase({
          name: `fix_${i}`,
          kind: "agent",
          owner: "builder",
          description: `Resolve the reported ${what} failures, from their verbatim output`,
          retries: 1,
        });
        build = await ph.call({
          outputType: BuildOutput,
          outputTypeName: "BuildOutput",
          prompt: args.prompt,
          previous: quality.asEnvelope(broken, what),
          gates: [gates.diff_matches_claims],
        });
        ph.done();
      }

      const verified = Boolean(verify?.passed) && Boolean(test?.passed);
      if (verified) {
        await using ph = run.phase({
          name: "commit",
          kind: "code",
          owner: "git",
          description: "Land the code only once every configured block came back clean",
        });
        const message = build.commit_message || `sfo(${run.adw_id}): ${build.summary}`;
        ph.log({ sha: git.commitAll(message, run.target.path), message });
        ph.done();
      }

      return run.finish(
        verified,
        `verify/test never came back clean after ${MAX_FIX_LOOPS} fix attempt(s)`,
      );
    },
  }),
);
