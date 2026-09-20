#!/usr/bin/env bun
/**
 * ADW Plan Build — spec it, build it, land it. No suite in between.
 *
 *   npm run pb -- --target api "add a /health endpoint"
 *
 * Phases: engineer(request) -> planner -> builder -> git(commit)
 *
 * This is the one chain in the factory that commits work the suite never saw,
 * and that is the whole reason it exists rather than an oversight. A spike, a
 * scaffold, a rename across files nothing covers yet — work where the tests
 * would answer a question nobody is asking. The commit is the point: the diff
 * goes on record, attributed and readable, instead of sitting in a dirty tree.
 *
 * Use `npm run pbt` the moment the suite IS the question. It is the same chain
 * with the green light wired into acceptance, and it costs one test run more.
 */

import { adw, main } from "./adw_modules/session.ts";
import * as gates from "./adw_modules/gates.ts";
import * as git from "./adw_modules/git_helper.ts";
import { BuildOutput, PlanOutput } from "./adw_modules/types.ts";

const REQUIRED_AGENTS = ["planner", "builder"];

main(
  adw({
    name: "adw_plan_build",
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
        ph.log({
          input: args.prompt,
          target: run.target.name,
          scope: run.target.subdir || "whole repo",
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

      {
        await using ph = run.phase({
          name: "commit",
          kind: "code",
          owner: "git",
          description: "Land the builder's changes, in the words the builder wrote for them",
        });
        const message = build.commit_message || `chore(${run.adw_id}): ${build.summary}`;
        ph.log({ sha: git.commitAll(message, run.target.path), message });
        ph.done();
      }

      // Nothing downstream can refuse this run: every phase either passed or
      // already failed the run on its own. `finish()` with no argument says
      // exactly that, rather than inventing a criterion the chain never tested.
      return run.finish();
    },
  }),
);
