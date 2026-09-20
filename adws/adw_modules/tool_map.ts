/**
 * Neutral tool vocabulary -> each vendor's real tool names.
 *
 * Decision 8. A roster entry says `tools: [read, search, shell]` and stays
 * readable whichever adapter runs it; the adapter translates. An unmapped name
 * is a HARD FAIL at validate time, not a silently dropped capability — an
 * agent that quietly loses `shell` fails three phases later for reasons nobody
 * can trace back to a typo in the roster.
 *
 * The Copilot column is not guessed. It is the `tools[].name` list dumped from
 * a real `session.usage_checkpoint` (24 tools, unrestricted run, 2026-09-20).
 * An earlier restricted probe reported `rg` where the unrestricted one reported
 * `grep`, which is exactly why this table is built from measured output and why
 * `agent_copilot.ts` records what was actually offered on every call.
 */

import type { CodingAgent } from "./types.ts";

/** What the roster is allowed to say. Keep this small and vendor-neutral. */
export const NEUTRAL_TOOLS = [
  "read",
  "write",
  "edit",
  "search",
  "glob",
  "shell",
  "fetch",
  "subagent",
  "skill",
  "sql",
] as const;

export type NeutralTool = (typeof NEUTRAL_TOOLS)[number];

/**
 * One neutral name can unlock several vendor tools. `shell` without
 * `read_bash`/`stop_bash` gives an agent a way to start a background command
 * and no way to read or kill it, which reads as a hung agent.
 */
const COPILOT: Record<NeutralTool, string[]> = {
  read: ["view"],
  write: ["create"],
  edit: ["edit"],
  search: ["grep", "search_code_subagent"],
  glob: ["glob"],
  shell: ["bash", "read_bash", "list_bash", "stop_bash"],
  fetch: ["web_fetch", "fetch_copilot_cli_documentation"],
  subagent: ["task", "list_agents", "read_agent", "write_agent"],
  skill: ["skill"],
  sql: ["sql", "session_store_sql"],
};

/**
 * Claude Code's names, for the stub adapter. Recorded now so the neutral
 * vocabulary is provably expressible in both, which is the whole point of
 * having one — decision 4 keeps the adapter a stub, not the vocabulary.
 */
const CLAUDE: Record<NeutralTool, string[]> = {
  read: ["Read"],
  write: ["Write"],
  edit: ["Edit"],
  search: ["Grep"],
  glob: ["Glob"],
  shell: ["Bash", "BashOutput", "KillShell"],
  fetch: ["WebFetch", "WebSearch"],
  subagent: ["Task"],
  skill: ["Skill"],
  sql: [],
};

const TABLES: Record<CodingAgent, Record<NeutralTool, string[]>> = {
  copilot: COPILOT,
  claude: CLAUDE,
};

export class UnknownToolError extends Error {}

/**
 * Translate a roster `tools:` list into vendor names.
 *
 * `null` in, `null` out: the roster's way of saying "every tool this CLI has",
 * which the adapter renders by simply not passing `--available-tools`.
 */
export function resolveTools(
  vendor: CodingAgent,
  tools: string[] | null,
  toolsExtra: string[] = [],
): string[] | null {
  if (tools === null) return null;
  const table = TABLES[vendor];
  const resolved: string[] = [];
  const unknown: string[] = [];
  for (const name of tools) {
    const mapped = table[name as NeutralTool];
    if (!mapped) {
      unknown.push(name);
      continue;
    }
    resolved.push(...mapped);
  }
  if (unknown.length) {
    throw new UnknownToolError(
      `unknown tool name(s) ${unknown.map((u) => `'${u}'`).join(", ")} — ` +
        `the roster speaks a neutral vocabulary: ${NEUTRAL_TOOLS.join(", ")}. ` +
        `For a vendor-specific tool, use tools_extra: instead.`,
    );
  }
  // tools_extra rides through verbatim: it exists precisely for the tool that
  // has no neutral equivalent, so validating it against this table would
  // defeat it.
  return [...new Set([...resolved, ...toolsExtra])];
}

/** Every neutral name that maps to nothing on this vendor — validate surfaces it. */
export function unsupported(vendor: CodingAgent, tools: string[] | null): string[] {
  if (tools === null) return [];
  const table = TABLES[vendor];
  return tools.filter((t) => (table[t as NeutralTool] ?? []).length === 0);
}
