/**
 * Give an agent its identity, the only way Copilot allows.
 *
 * There is NO `--system-prompt` and there never will be (known impossibility
 * 1). The one channel for per-agent instructions is `--agent <name>`, which
 * reads `.github/agents/<name>.md` from a directory the CLI trusts — i.e. one
 * that was `--add-dir`'d.
 *
 * That is why the runtime lives at ~/.sfo-build and NOT under the factory. The
 * grant is per-tree, not per-file: `--add-dir` on a directory hands the agent
 * everything beneath it. If the identity file sat in the factory repo, granting
 * it would also grant the engine, the gates, and the prompt_engineering
 * directory that holds the criteria the agent is graded against.
 *
 * So each agent gets its OWN tree, containing nothing but its own identity:
 *
 *     ~/.sfo-build/id/<agent>/.github/agents/<agent>.md
 *
 * Measured, and worth restating: the file arrives as the system segment
 * `selected_agent_instructions` (63 tokens in the probe) ALONGSIDE Copilot's
 * own `identity` segment (413-523 tokens). Identity is APPEND-ONLY. The agent
 * is always "Copilot, plus your instructions" — never yours alone — so the
 * generated file leads with an explicit override paragraph and the prompts
 * over-specify rather than assuming a blank slate.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AgentConfig } from "./types.ts";
import { expandHome } from "./utils.ts";

/** The per-agent tree that gets `--add-dir`'d. Contains only this agent. */
export function identityDir(dataDir: string, agent: string): string {
  return path.join(expandHome(dataDir), "id", agent);
}

export function identityFile(dataDir: string, agent: string): string {
  return path.join(identityDir(dataDir, agent), ".github", "agents", `${agent}.md`);
}

/**
 * Copilot's own instructions arrive first and cannot be removed, so the file
 * opens by naming that and claiming precedence. Without this, a "read-only"
 * scout still inherits Copilot's default eagerness to helpfully fix things.
 */
function preamble(agent: AgentConfig): string {
  const scope =
    agent.writes === null
      ? "You may modify files in the repository as your task requires."
      : agent.writes.length === 0
        ? "You are READ-ONLY. Do not create, edit, or delete ANY file in the repository. " +
          "Writing your report into the handoff directory named in your task is the only " +
          "write you may perform."
        : `You may ONLY modify paths matching: ${agent.writes.join(", ")}. ` +
          `Modifying anything else in the repository fails the phase.`;

  return [
    "---",
    `name: ${agent.name}`,
    `description: ${agent.purpose || `The ${agent.name} agent in an automated developer workflow.`}`,
    "---",
    "",
    `# ${agent.name}`,
    "",
    "## Precedence",
    "",
    "You are running inside an automated developer workflow, non-interactively.",
    "There is no human to ask. General-purpose assistant instructions you were",
    "given before this file are BACKGROUND; where they disagree with anything",
    "below, this file wins.",
    "",
    "Three rules hold no matter what the task says:",
    "",
    "1. **Your final message must be ONLY the Report JSON your task defines.**",
    "   No prose before it, no prose after it, no code fence. It is parsed by a",
    "   machine that will reject and re-prompt you if it is not valid JSON.",
    "2. **Never ask a question.** Nothing is listening. Decide, act, and record",
    "   the decision in your report.",
    `3. **Stay inside your write scope.** ${scope}`,
    "",
    "You cannot write outside the working directory and the directories granted",
    "to this session. That is enforced by the sandbox, not by trust — an attempt",
    "will simply fail, and the phase will be failed for having tried.",
    "",
  ].join("\n");
}

/**
 * Write `<agent>.md` into the agent's own tree and return the directory to grant.
 *
 * The body is `prompt_engineering/<agent>/system.md` verbatim: one file is the
 * source of truth for what an agent is, and it is the one a human edits.
 */
export function writeIdentity(params: {
  dataDir: string;
  agent: AgentConfig;
  systemPromptPath: string;
  rendered?: string;
}): { dir: string; file: string } {
  const dir = identityDir(params.dataDir, params.agent.name);
  const file = identityFile(params.dataDir, params.agent.name);
  mkdirSync(path.dirname(file), { recursive: true });
  const body = params.rendered ?? readFileSync(params.systemPromptPath, "utf8");
  writeFileSync(file, `${preamble(params.agent)}\n${body.trim()}\n`);
  return { dir, file };
}
