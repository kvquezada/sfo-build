/**
 * Claude Code interface — a TYPED STUB in v1, by decision 4 (billing).
 *
 * The config schema accepts `coding_agent: claude` so nothing breaks at the
 * schema level and the tool vocabulary stays provably two-vendor, but
 * selecting it throws until a v2 implements this interface.
 *
 * What a v2 would build against (Claude Code 2.1.278, verified):
 *   --system-prompt / --system-prompt-file / --append-system-prompt
 *       Claude Code CAN replace its system prompt. Copilot cannot. An agent's
 *       identity here would be ITS OWN, not "Copilot plus instructions", so
 *       the over-specified prompts this factory writes would be a poor fit and
 *       should be re-tuned rather than reused verbatim.
 *   --agents <json>         roster inline, no identity files on disk
 *   --allowed-tools         cf. tool_map.ts CLAUDE column
 *   --add-dir               same grant model as Copilot
 *   --print --output-format stream-json
 *   --session-id <uuid>     NOTE: sets a NEW session. Continuing needs
 *                           --resume. This is the one place the two CLIs
 *                           genuinely differ: Copilot's --session-id is
 *                           create-or-continue, so the correction-turn loop in
 *                           agents.ts would need a --resume branch here.
 */

import type { AgentRequest } from "./types.ts";

export class NotImplementedError extends Error {}

export async function run(_request: AgentRequest, ..._rest: unknown[]): Promise<never> {
  throw new NotImplementedError(
    "coding_agent 'claude' is not implemented — this factory runs GitHub Copilot " +
      "only (decision 4: Claude Code worker agents were rejected on billing). " +
      "Set coding_agent: copilot (or omit it) in sfo.config.yaml.",
  );
}
