#!/usr/bin/env bun
/**
 * ADW Ship — put committed work on a branch, push it, open the pull request.
 *
 *   npm run ship -- --target api
 *   npm run ship -- --target api --dry-run
 *   npm run ship -- --target api --branch feature/pagination --draft
 *
 * Phases: engineer(request) -> code(branch) -> code(push)
 *         [-> code(rewind)] [-> code(pull_request)]
 *
 * The factory's output boundary used to be a local commit on the trunk. This is
 * the missing last mile, and it is deliberately a separate chain: shipping is
 * not part of producing, and the two fail for unrelated reasons. A run whose
 * tests went red should leave nothing on a remote; a push that fails because
 * gh is logged out says nothing about the code.
 *
 * No agents, and `REQUIRED_AGENTS` stays empty. Naming a branch is a fact about
 * the commits — their conventional type and subject already state it — so code
 * derives it (hard rule 8) and no model is asked to restate what git knows. The
 * PR body comes from adws/adw_data/templates/pull_request.md, which is the
 * operator's file to edit at any time without touching this chain.
 *
 * The dirty-tree guard is ON, by the session default. A ship run works on what
 * is already committed; an uncommitted tree means a run that has not finished,
 * and pushing half of it is the wrong answer to that.
 */

import { adw, main } from "./adw_modules/session.ts";
import * as ship from "./adw_modules/ship.ts";
import * as git from "./adw_modules/git_helper.ts";

const REQUIRED_AGENTS: string[] = [];

main(
  adw({
    name: "adw_ship",
    requiredAgents: REQUIRED_AGENTS,
    argv: process.argv.slice(2),
    requirePrompt: false,
    body: async (run, args) => {
      const options = ship.optionsFrom(args.flags);

      {
        await using ph = run.phase({
          name: "request",
          kind: "engineer",
          owner: run.engineer,
          description: "Capture what is being shipped, and the trunk it is aimed at",
        });
        ph.log({
          input: args.prompt || "(none)",
          target: run.target.name,
          base: `${run.target.remote}/${run.target.base_branch}`,
          standing_on: git.currentBranch(run.target.path),
          mode: options.dryRun ? "dry run" : options.noPr ? "push only" : "push + PR",
        });
        ph.done();
      }

      const result = await ship.ship(run, options);

      if (result.pr_url) run.console.note(`pull request: ${result.pr_url}`);
      else if (result.pushed) run.console.note(`pushed ${result.remote}/${result.branch}`);

      return run.finish(true);
    },
  }),
);
