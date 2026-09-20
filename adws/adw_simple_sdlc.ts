#!/usr/bin/env bun
/**
 * ADW Simple SDLC — plan, build, test, review, document, committing as it goes.
 *
 *   npm run sdlc -- --target api "add pagination to GET /customers"
 *
 * Phases: engineer(request) -> planner -> git(commit_plan)
 *         -> builder -> code(test) [-> builder(fix) -> code(test) ... bounded]
 *         -> reviewer ‖ adversary [-> builder(revise) -> reviewer ... bounded]
 *         -> code(retest, only if a revision changed code)
 *         -> git(commit_build) -> code(changes) -> documenter -> git(commit_docs)
 *         [-> ship: branch, push, PR]
 *
 * Three commits, three work products, three authors. The plan, the code and the
 * write-up each land in their own commit, and each message is the words of the
 * agent that produced it — `commit_message` on PlanOutput describes the spec, on
 * BuildOutput the code, on DocumentOutput the write-up. No agent's sentence is
 * ever reused for another agent's diff.
 *
 * Two different questions get asked, in order, and neither can answer the
 * other's. The suite asks "does it run"; the reviewer asks "is this what was
 * asked for", against plan.md. A revision that closes a review finding re-enters
 * the suite, so the tree that gets committed is the tree that was both tested
 * and approved.
 *
 * The code commit lands after verification, not straight after the build: fixes
 * and revisions are part of the same work product, and red code has no business
 * on the branch. A run that fails verification leaves the plan committed and the
 * working tree dirty — the spec is a real artifact either way, and the unfinished
 * code stays where the engineer can see it.
 *
 * `--adversary` adds a SECOND judge on a third vendor, running alongside the
 * reviewer rather than after it (see review.ts). Advisory: its objections join
 * what the builder must close, so it can spend a revision loop, but `verified`
 * still turns on a green suite and the reviewer's own approval. Opt-in, flag
 * last, like `--ship`.
 *
 * `--ship` appends the ship chain — branch, push, pull request — after the last
 * commit. Opt-in, because a push is outward-facing in a way a local commit is
 * not, and inside the `verified` block, so a run that never came back clean
 * leaves nothing on a remote.
 *
 * The documenter measures against the commit this run STARTED from, not against
 * main, because by then the run has moved main itself. That baseline is pinned
 * before the first commit phase and printed in the request phase.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

import { adw, main } from "./adw_modules/session.ts";
import * as changes from "./adw_modules/changes.ts";
import * as gates from "./adw_modules/gates.ts";
import * as git from "./adw_modules/git_helper.ts";
import * as quality from "./adw_modules/quality.ts";
import * as ship from "./adw_modules/ship.ts";
import { mergeReviews, reviewRound } from "./adw_modules/review.ts";
import {
  BuildOutput,
  DocumentOutput,
  PlanOutput,
  type QualityResult,
  type ReviewOutput,
} from "./adw_modules/types.ts";

const ARGV = process.argv.slice(2);
/** Read before the session opens — `requiredAgents` decides what gets probed. */
const ADVERSARIAL = ARGV.some((a) => a === "--adversary" || a.startsWith("--adversary="));
const BASE_AGENTS = ["planner", "builder", "reviewer", "documenter"];
const REQUIRED_AGENTS = ADVERSARIAL ? [...BASE_AGENTS, "adversary"] : BASE_AGENTS;
const MAX_FIX_LOOPS = 3;
const MAX_REVISION_LOOPS = 2;
const DOCS_DIR = "app_docs";

const DOCUMENT_NOTES =
  "Read diff_path in full before writing. Document only what the diff shows, " +
  "then write it into app_docs/ as your task describes.";

main(
  adw({
    name: "adw_simple_sdlc",
    requiredAgents: REQUIRED_AGENTS,
    argv: process.argv.slice(2),
    body: async (run, args) => {
      const repo = run.target.path;
      const baseline = git.rev("HEAD", repo); // pinned before this run commits anything

      /** Commit what the preceding phase produced, in that agent's own words. */
      const commit = (ph: { log: (p: Record<string, unknown>) => void }, envelope: {
        commit_message: string;
        summary: string;
      }): void => {
        const message = envelope.commit_message || `chore(${run.adw_id}): ${envelope.summary}`;
        ph.log({ sha: git.commitAll(message, repo), message });
      };

      const record = (
        ph: { log: (p: Record<string, unknown>) => void },
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
          description: "Capture the incoming ask and pin the baseline the run is measured from",
        });
        ph.log({
          input: args.prompt,
          target: run.target.name,
          baseline: git.shortSha(baseline, repo),
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

      {
        await using ph = run.phase({
          name: "commit_plan",
          kind: "code",
          owner: "git",
          description: "Put the spec on record before any code exists to blur it",
        });
        commit(ph, plan);
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

      let review: ReviewOutput | null = null;
      let adversary: ReviewOutput | null = null;
      let revised = false;
      for (let i = 1; i <= MAX_REVISION_LOOPS; i += 1) {
        ({ review, adversary } = await reviewRound({
          run,
          round: i,
          prompt: args.prompt,
          build,
          adversarial: ADVERSARIAL,
        }));
        // One envelope, both sets of objections. `verified` below still reads
        // the reviewer's own verdict — the adversary cannot hold the chain shut.
        const merged = mergeReviews(review, adversary);
        if (merged.approved || i === MAX_REVISION_LOOPS) break;

        await using ph = run.phase({
          name: `revise_${i}`,
          kind: "agent",
          owner: "builder",
          description: "Close the judges' blocking findings",
          retries: 1,
        });
        build = await ph.call({
          outputType: BuildOutput,
          outputTypeName: "BuildOutput",
          prompt: args.prompt,
          previous: merged,
          gates: [gates.diff_matches_claims],
        });
        revised = true;
        ph.done();
      }

      // A revision edited code after the suite last ran, so the green light is
      // stale. Re-run rather than commit on a result that predates the change.
      if (revised && review?.approved) {
        await using ph = run.phase({
          name: "retest",
          kind: "code",
          owner: "quality",
          description: "Re-run the suite — the revision changed code after the last green result",
        });
        test = quality.runTests(run);
        record(ph, test);
        ph.done();
      }

      // Red tests or a rejected review stop the chain here: the code stays
      // uncommitted and nothing is documented, because there is nothing worth
      // describing yet. The plan commit stands — it records what was asked.
      const verified = Boolean(test?.passed) && Boolean(review?.approved);
      // Advisory, but not silent: a run may commit over the adversary's
      // objections, and whoever reads the trace afterwards should find them
      // said out loud rather than only in adversary.md.
      if (verified && adversary && !adversary.approved) {
        run.console.warn(
          `committing over ${adversary.blocking.length} unresolved adversary objection(s): ` +
            adversary.blocking.join("; "),
        );
      }
      if (verified) {
        {
          await using ph = run.phase({
            name: "commit_build",
            kind: "code",
            owner: "git",
            description: "Land the code only now: green suite, approved review",
          });
          commit(ph, build);
          ph.done();
        }

        let changeset;
        {
          await using ph = run.phase({
            name: "changes",
            kind: "code",
            owner: "git",
            description: "Diff the whole run against its pinned baseline, for the documenter",
          });
          changeset = changes.capture(run, { base: baseline });
          ph.log({
            base: `${changeset.base.ref.slice(0, 7)} @ ${changeset.base.commit.slice(0, 7)}`,
            reason: changeset.base.reason,
            files: changeset.files.length + changeset.untracked.length,
            lines: `+${changeset.insertions} -${changeset.deletions}`,
            diff: changeset.diff_path,
          });
          if (changes.isEmpty(changeset)) {
            throw new Error(
              `nothing changed since the baseline (${changeset.base.reason}) — ` +
                `there is nothing to document.`,
            );
          }
          // `mkdir -p app_docs` is a known command, so code runs it (hard rule
          // 8). It also removes the documenter's only reason to need a shell
          // before it can write anything: `create` does not make parent
          // directories, and a missing one sent a real run's write-up into
          // COPILOT_HOME instead of the repo.
          mkdirSync(path.join(repo, DOCS_DIR), { recursive: true });
          ph.log({ docs_dir: DOCS_DIR });
          ph.done();
        }

        let document;
        {
          await using ph = run.phase({
            name: "document",
            kind: "agent",
            owner: "documenter",
            description: "Write up the completed change from the diff of what actually shipped",
            retries: 1,
          });
          document = await ph.call({
            outputType: DocumentOutput,
            outputTypeName: "DocumentOutput",
            prompt: args.prompt,
            previous: changes.asEnvelope(changeset, repo, DOCUMENT_NOTES),
            // file_in_repo is the one that matters here: a write-up that is
            // not in the repo is not a work product, however real the file is.
            gates: [
              gates.artifacts_exist,
              gates.files_non_empty,
              gates.file_in_repo("document_path"),
            ],
          });
          ph.done();
        }

        {
          await using ph = run.phase({
            name: "commit_docs",
            kind: "code",
            owner: "git",
            description: "Ship the write-up in its own commit, beside the code it describes",
          });
          commit(ph, document);
          ph.done();
        }

        // Opt-in, and only here: three commits that were tested, reviewed and
        // written up are a complete unit of work, which is the only thing worth
        // putting in front of a reviewer.
        if (args.flags["ship"] === true) {
          const shipped = await ship.ship(run, ship.optionsFrom(args.flags));
          if (shipped.pr_url) run.console.note(`pull request: ${shipped.pr_url}`);
        }
      }

      return run.finish(verified, "the suite or the review never came back clean");
    },
  }),
);
