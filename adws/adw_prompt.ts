#!/usr/bin/env bun
/**
 * ADW Prompt — the smallest ADW: one agent, one prompt, traced end to end.
 *
 *   npm run prompt -- --target oms "<prompt or path/to/prompt.md>" [--agent builder]
 *
 * Phases: engineer(request) -> <agent>
 *
 * ADW scripts stay thin (hard rule 6): everything below is sequencing. All the
 * logic lives in adw_modules/.
 */

import { adw, main } from "./adw_modules/session.ts";
import { GenericOutput } from "./adw_modules/types.ts";

const DEFAULT_AGENT = "builder";

main(
  adw({
    name: "adw_prompt",
    // Resolved from --agent at parse time, so validation still happens before
    // anything spawns. `flags` is read here rather than in the body because
    // REQUIRED_AGENTS must be known up front (hard rule 1).
    requiredAgents: [agentFromArgv()],
    argv: process.argv.slice(2),
    body: async (run, args) => {
      const agent = args.agent ?? DEFAULT_AGENT;

      {
        await using ph = run.phase({
          name: "request",
          kind: "engineer",
          owner: run.engineer,
          description: "Capture the incoming ask",
        });
        ph.log({ input: args.prompt, target: run.target.name });
        ph.done();
      }

      {
        await using ph = run.phase({
          name: "prompt",
          kind: "agent",
          owner: agent,
          description: `Send the request straight to ${agent} and parse its envelope`,
        });
        await ph.call({
          outputType: GenericOutput,
          outputTypeName: "GenericOutput",
          prompt: args.prompt,
        });
        ph.done();
      }

      return run.finish();
    },
  }),
);

/** Peek at --agent before the full parse, so REQUIRED_AGENTS is honest. */
function agentFromArgv(): string {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--agent");
  if (index !== -1 && argv[index + 1]) return argv[index + 1]!;
  const inline = argv.find((a) => a.startsWith("--agent="));
  return inline ? inline.split("=")[1]! : DEFAULT_AGENT;
}
