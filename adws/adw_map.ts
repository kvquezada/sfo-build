#!/usr/bin/env bun
/**
 * ADW Map — how does this work across repos?
 *
 *   npm run map -- --target front --target api "how does an order stage change reach the UI"
 *
 * Phases: engineer(request) -> scout ×N -> map
 *
 * `adw_trace`'s sibling, and the difference is the QUESTION. A trace asks why
 * something is broken; this asks how something works. They share the scouts,
 * the per-phase target plumbing and `hops_resolve` — what changes is that
 * nothing here is required to find a fault.
 *
 * That is not a nicety, it is the whole reason this exists rather than a
 * `--no-advise` flag on trace. Measured, on a real run: asked the neutral
 * question "how does an order stage change reach the UI", the correlator —
 * whose prompt tells it six times to name a seam — reported that the front had
 * no error handling for a rejected transition. It had inferred that from the
 * scout reports not mentioning any, and the scouts had never been asked. The
 * advisor then read the code and refuted it. An agent told to find a problem
 * finds one, and the fabricated half of that answer is shaped exactly like the
 * real half.
 *
 * So the cartographer is told the opposite: "they agree" is a complete answer,
 * and silence in a report is not evidence of absence.
 *
 * Nothing is written to any repo — scout and cartographer are both `writes: []`,
 * which is also why the dirty guard is off.
 */

import { adw, main } from "./adw_modules/session.ts";
import * as gates from "./adw_modules/gates.ts";
import { MapOutput, ScoutOutput, type EnvelopeBase } from "./adw_modules/types.ts";

const REQUIRED_AGENTS = ["scout", "cartographer"];

main(
  adw({
    name: "adw_map",
    requiredAgents: REQUIRED_AGENTS,
    argv: process.argv.slice(2),
    requireCleanRepo: false,
    body: async (run, args) => {
      {
        await using ph = run.phase({
          name: "request",
          kind: "engineer",
          owner: run.engineer,
          description: "Capture the question and the repos it crosses",
        });
        ph.log({
          input: args.prompt,
          path: run.targets.map((t) => t.name).join(" → "),
        });
        ph.done();
      }

      const reports: EnvelopeBase[] = [];
      for (const target of run.targets) {
        await using ph = run.phase({
          name: `scout_${target.name}`,
          kind: "agent",
          owner: "scout",
          target: target.name,
          description: `Find what ${target.name} does with this request — change nothing`,
          retries: 1,
        });
        reports.push(
          await ph.call({
            outputType: ScoutOutput,
            outputTypeName: "ScoutOutput",
            prompt: args.prompt,
            gates: [gates.artifacts_exist, gates.files_non_empty, gates.findings_resolve],
          }),
        );
        ph.done();
      }

      {
        await using ph = run.phase({
          name: "map",
          kind: "agent",
          owner: "cartographer",
          description: "Describe the path end to end and what the repos agree on",
          retries: 1,
        });
        await ph.call({
          outputType: MapOutput,
          outputTypeName: "MapOutput",
          prompt: pathPrompt(args.prompt, run.targets.map((t) => t.name)),
          previous: reports[reports.length - 1],
          gates: [gates.artifacts_exist, gates.files_non_empty, gates.hops_resolve],
        });
        ph.done();
      }

      return run.finish();
    },
  }),
);

/** The question, plus the direction the repos were named in. */
function pathPrompt(prompt: string, targets: string[]): string {
  return (
    `${prompt}\n\n` +
    `The request path runs ${targets.join(" → ")}: '${targets[0]}' is where it ` +
    `starts and '${targets[targets.length - 1]}' is where it ends up. That order ` +
    `was given by the operator — follow it rather than inferring a direction.`
  );
}
