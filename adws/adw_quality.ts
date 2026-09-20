#!/usr/bin/env bun
/**
 * ADW Quality — run every deterministic block this target configures. No agents.
 *
 *   npm run quality -- --target api "before opening the PR"
 *
 * Phases: engineer(request) -> code(quality)
 *
 * The whole factory in miniature, with the agents taken out: lint, typecheck,
 * build and test are known commands, so code runs them (hard rule 8) and the
 * run costs nothing but wall time. `REQUIRED_AGENTS` is empty and stays empty —
 * the moment this chain needs judgement it is a different chain.
 *
 * The argv comes from the target registry, and only the operations that target
 * actually configured are run. A target with none is a hard error rather than a
 * green tick nobody earned; `specFor` refuses the same way per operation.
 *
 * A red block does NOT fail its phase. SSSF raised inside the phase here, which
 * reported a runner that had done its job exactly as if it had crashed, and
 * lost the artifacts of the blocks that came after. The phase records what
 * every block printed; the RUN is what a failure fails, at `finish()`.
 *
 * The dirty-tree guard is off: no agent runs, so there are no agent writes to
 * tell apart from the engineer's — and checking the tree you are holding is the
 * normal reason to reach for this.
 */

import { adw, main } from "./adw_modules/session.ts";
import * as quality from "./adw_modules/quality.ts";
import type { QualityOperation } from "./adw_modules/types.ts";

const REQUIRED_AGENTS: string[] = [];

/** Cheapest first, so a fast failure prints before a slow one starts. */
const OPERATIONS: QualityOperation[] = ["lint", "typecheck", "build", "test"];

main(
  adw({
    name: "adw_quality",
    requiredAgents: REQUIRED_AGENTS,
    argv: process.argv.slice(2),
    requireCleanRepo: false,
    body: async (run, args) => {
      const operations = quality.configured(run.target, OPERATIONS);
      if (!operations.length) {
        throw new Error(
          `target '${run.target.name}' configures none of ${OPERATIONS.join(", ")}.\n\n` +
            `Add at least one to adws/adw_sfo_config/sfo.config.yaml as an argv LIST, e.g.\n` +
            `      lint: [npx, nx, lint, ${run.target.name}]\n\n` +
            `A quality run with nothing to run is not a passing quality run.`,
        );
      }

      {
        await using ph = run.phase({
          name: "request",
          kind: "engineer",
          owner: run.engineer,
          description: "Capture why verification was asked for, and what it will cover",
        });
        ph.log({
          input: args.prompt,
          target: run.target.name,
          scope: run.target.subdir || "whole repo",
          blocks: operations.join(", "),
        });
        ph.done();
      }

      let result;
      {
        await using ph = run.phase({
          name: "quality",
          kind: "code",
          owner: "quality",
          description: "Run every configured block in one pass and collect all the failures",
        });
        result = quality.runQuality(run, operations);
        ph.log({
          passed: result.passed,
          checks: `${result.checks.filter((c) => c.passed).length}/${result.checks.length}`,
          artifacts: result.artifacts.join(", "),
        });
        ph.done();
      }

      const failed = result.checks.filter((c) => !c.passed).map((c) => c.name);
      return run.finish(result.passed, `${failed.join(", ")} failed — see the logged artifacts`);
    },
  }),
);
