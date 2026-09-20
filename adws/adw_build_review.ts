#!/usr/bin/env bun
/**
 * ADW Build Review — implement, then confirm it is what was asked for.
 *
 *   npm run br -- --target api "add pagination to GET /customers"
 *
 * Phases: engineer(request) -> builder
 *         [-> reviewer -> builder(revise) ... bounded]
 *         -> git(commit)
 *
 * Review is not testing, and neither question can answer the other's. The
 * suite asks "does it run". The reviewer asks "is this the thing that was
 * asked for" — it reads the spec (the `plan.md` this session already holds if
 * a plan phase wrote one, else the prompt verbatim), reads the code on disk,
 * and rules on each requirement one at a time.
 *
 * Use this chain when correctness is a matter of intent rather than of exit
 * codes: config, copy, API shape, a refactor that must not change behaviour.
 * When both questions matter, `npm run sdlc` asks them in order and re-runs the
 * suite after any revision.
 *
 * Like the tester, the reviewer's phase succeeds when it RUNS and REPORTS. A
 * rejection does not fail the phase; it fails the run at `finish()`, once the
 * bounded revise loop has had its chances. Approval is this chain's whole
 * acceptance criterion, so nothing is committed without it.
 */

import { adw, main } from "./adw_modules/session.ts";
import * as gates from "./adw_modules/gates.ts";
import * as git from "./adw_modules/git_helper.ts";
import { BuildOutput, ReviewOutput } from "./adw_modules/types.ts";

const REQUIRED_AGENTS = ["builder", "reviewer"];
const MAX_REVISION_LOOPS = 3;

main(
  adw({
    name: "adw_build_review",
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

      let review = null;
      for (let i = 1; i <= MAX_REVISION_LOOPS; i += 1) {
        {
          await using ph = run.phase({
            name: `review_${i}`,
            kind: "agent",
            owner: "reviewer",
            description: "Rule on every requirement in the spec, against the code on disk",
            retries: 1,
          });
          review = await ph.call({
            outputType: ReviewOutput,
            outputTypeName: "ReviewOutput",
            prompt: args.prompt,
            previous: build,
            gates: [gates.artifacts_exist, gates.verdict_consistent],
          });
          ph.done();
        }
        if (review.approved || i === MAX_REVISION_LOOPS) break;

        await using ph = run.phase({
          name: `revise_${i}`,
          kind: "agent",
          owner: "builder",
          description: "Close every blocking finding the reviewer named",
          retries: 1,
        });
        build = await ph.call({
          outputType: BuildOutput,
          outputTypeName: "BuildOutput",
          prompt: args.prompt,
          previous: review,
          gates: [gates.diff_matches_claims],
        });
        ph.done();
      }

      const approved = review?.approved ?? false;
      if (approved) {
        await using ph = run.phase({
          name: "commit",
          kind: "code",
          owner: "git",
          description: "Land the code only once the reviewer signed off on it",
        });
        const message = build.commit_message || `sfo(${run.adw_id}): ${build.summary}`;
        ph.log({ sha: git.commitAll(message, run.target.path), message });
        ph.done();
      }

      return run.finish(
        approved,
        `the reviewer never approved after ${MAX_REVISION_LOOPS} revision(s)`,
      );
    },
  }),
);
