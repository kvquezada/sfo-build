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
 *
 * ── The table is a REQUEST, not a guarantee ──────────────────────────────────
 * `--available-tools` is an INTERSECTION filter, and the set it intersects with
 * is chosen by the MODEL, not by the flags. Measured on identical arguments,
 * same identity file, same cwd, 2026-09-20:
 *
 *   gemini-3.6-flash  ->  bash read_bash stop_bash list_bash view create edit
 *                         search_code_subagent grep glob
 *   gpt-5.6-terra     ->  bash read_bash stop_bash list_bash view
 *                         search_code_subagent rg glob
 *
 * Two different dialects. `gpt-5.6-terra` has no `create` and no `edit` AT ALL
 * — it writes files through `bash` — and calls its search tool `rg` where
 * gemini calls it `grep`. Asking for a tool a model does not have is harmless
 * (it is simply absent), but asking for ONLY such tools would leave an agent
 * with no way to write and no error to explain why.
 *
 * So the map stays a request, `agent_copilot.ts` records what was actually
 * offered on every call, and `agents.ts` logs the difference. `doctor` probes
 * each roster model and prints its real dialect, so the surprise happens on a
 * terminal rather than three phases into a run.
 *
 * PRACTICAL CONSEQUENCE: any agent expected to modify files should keep
 * `shell` in its `tools:`. On a create/edit-less model that is the only way to
 * write, and on the others it costs nothing.
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
  // `rg` and `grep` are the same tool under two names, and which one a model is
  // offered is the model's choice. Both are requested so the filter matches
  // whichever dialect turns up; the unused name is simply absent.
  search: ["grep", "rg", "search_code_subagent"],
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

/**
 * Which requested tools the model did not actually offer.
 *
 * Called after the first send with the list from `session.usage_checkpoint`.
 * Purely informational: a dialect gap is a fact to record, not a failure —
 * the agent still has `bash`, which is how a create/edit-less model writes.
 */
export function missingFromOffer(requested: string[] | null, offered: string[]): string[] {
  if (requested === null || !offered.length) return [];
  const have = new Set(offered);
  const satisfied = (tool: string) =>
    have.has(tool) || (ALIASES[tool] ?? []).some((alias) => have.has(alias));
  // Deduplicate by alias group, so one capability reports as one gap.
  const seen = new Set<string>();
  return requested.filter((tool) => {
    if (satisfied(tool)) return false;
    const key = [tool, ...(ALIASES[tool] ?? [])].sort().join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Different names for the SAME tool. Which name a model uses is the model's
 * choice — `rg` and `grep` are one search tool, and requesting both is how the
 * intersection filter matches whichever dialect turns up. Without this, every
 * model reports the name it did not happen to pick as "missing".
 */
const ALIASES: Record<string, string[]> = {
  grep: ["rg"],
  rg: ["grep"],
};

/** Every neutral name that maps to nothing on this vendor — validate surfaces it. */
export function unsupported(vendor: CodingAgent, tools: string[] | null): string[] {
  if (tools === null) return [];
  const table = TABLES[vendor];
  return tools.filter((t) => (table[t as NeutralTool] ?? []).length === 0);
}
