#!/usr/bin/env bun
/**
 * ADW Trace — follow one issue across several repos, then say what to do.
 *
 *   npm run trace -- --target mobile --target api "checkout 500s after a retry"
 *
 * Phases: engineer(request) -> scout ×N -> correlate -> advise
 *
 * The first cross-repo workflow, and the reason `--target` learned to repeat.
 * A question that spans a seam — a mobile client and the service it calls, a
 * web app and its API — cannot be answered by a run that resolved one checkout:
 * scout on the client physically cannot cite a server path without failing
 * `findings_resolve`, because a gate resolves what it is told against the one
 * repo it knows.
 *
 * So the run resolves N repos and each PHASE picks one. Every agent still works
 * inside exactly one tree, with one cwd and one write boundary — nothing here
 * widens what an agent can reach. What spans the repos is the CODE: `hops_resolve`
 * stands outside all of them and stats each claimed path against the checkout it
 * was claimed in. The correlator proposes a trail through trees it never opened;
 * the harness walks it.
 *
 * Order is meaning. The first `--target` is where the request starts.
 *
 * Nothing is written to any repo. Scout, correlator and advisor are all
 * `writes: []`, which is also why the dirty guard is off: you investigate the
 * tree that is misbehaving, and it is usually mid-edit.
 */

import { adw, main } from "./adw_modules/session.ts";
import * as gates from "./adw_modules/gates.ts";
import { OptionsOutput, ScoutOutput, TraceOutput, type EnvelopeBase } from "./adw_modules/types.ts";

const REQUIRED_AGENTS = ["scout", "correlator", "advisor"];

main(
  adw({
    name: "adw_trace",
    requiredAgents: REQUIRED_AGENTS,
    argv: process.argv.slice(2),
    // Read-only, end to end. Requiring N clean checkouts to ask a question
    // would tax the investigation without buying any safety the permission
    // enforcement does not already provide.
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

      // One scout per repo, in order, each standing in its own checkout and
      // writing into its own handoff directory. Sequential on purpose: the
      // console attaches events to one phase at a time and the waterfall draws
      // phases as a sequence, so concurrency here would cost correctness in
      // both to save wall-clock on the cheapest agent in the roster.
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

      let trace;
      {
        await using ph = run.phase({
          name: "correlate",
          kind: "agent",
          owner: "correlator",
          description: "Join the per-repo reports into one request path and name the seam",
          retries: 1,
        });
        trace = await ph.call({
          outputType: TraceOutput,
          outputTypeName: "TraceOutput",
          prompt: pathPrompt(args.prompt, run.targets.map((t) => t.name)),
          // The LAST scout's envelope. The rest are on disk, which is where a
          // correlator is told to read them from anyway — inlining N reports
          // into the prompt would spend the context window on what it is about
          // to open by name.
          previous: reports[reports.length - 1],
          gates: [gates.artifacts_exist, gates.files_non_empty, gates.hops_resolve],
        });
        ph.done();
      }

      {
        await using ph = run.phase({
          name: "advise",
          kind: "agent",
          owner: "advisor",
          description: "Propose at most three fixes for the seam, best first, each with its cost",
          retries: 1,
        });
        await ph.call({
          outputType: OptionsOutput,
          outputTypeName: "OptionsOutput",
          prompt: pathPrompt(args.prompt, run.targets.map((t) => t.name)),
          previous: trace,
          gates: [gates.artifacts_exist, gates.files_non_empty, gates.options_sound],
        });
        ph.done();
      }

      // Every phase either passed or already failed the run on its own. A trace
      // makes no other claim — it did not fix anything and has no suite to be
      // green — so there is no acceptance criterion to invent here.
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
