/** Prompt rendering: load system/user templates, replace {{placeholders}}. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expandHome, shellJoin } from "./utils.ts";

/** Where each brief layer lives. `personal` is outside every repo. */
export interface BriefRoots {
  /** `<data_dir>/briefs` — this machine's, never committed. */
  personal: string;
  /** `prompt_engineering/_briefs` — the team's, changed through review. */
  team: string;
}

export function briefRoots(promptRoot: string, dataDir: string): BriefRoots {
  return {
    personal: path.join(expandHome(dataDir), "briefs"),
    team: path.join(promptRoot, "_briefs"),
  };
}

/**
 * The brief for ONE target, or "" when it has none.
 *
 * Chosen per target rather than per run: on a cross-repo trace each phase
 * stands in a different checkout, and each gets its own repo's description.
 *
 * Personal wins over team, whole-file: a private repo or an experiment needs no
 * PR, and a brief spliced from two layers is one nobody wrote. A missing file
 * is not an error and falls back to nothing — an empty brief costs the agent a
 * little orientation, a wrong one costs it the run.
 */
export function brief(roots: BriefRoots, target: { brief: string }): string {
  for (const root of [roots.personal, roots.team]) {
    const file = path.join(root, `${target.brief}.md`);
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
  }
  return "";
}

/**
 * The target's registered test argv, for a prompt to quote verbatim.
 *
 * Prompts are shared across every target, so none may name a runner. A target
 * with no test command says so in a line an agent cannot mistake for one —
 * a guessed `npm test` is the placeholder problem again, one layer up.
 */
export function testCommand(target: { test: string[] }): string {
  return target.test.length
    ? shellJoin(target.test)
    : "# no test command is registered for this target: skip this step, and do not invent one";
}

export function render(templatePath: string, variables: Record<string, string>): string {
  let text = readFileSync(templatePath, "utf8");
  for (const [key, value] of Object.entries(variables)) {
    text = text.split(`{{${key}}}`).join(value);
  }
  return text;
}

/** Save the exact prompt sent, BEFORE execution — the audit copy. */
export function save(directory: string, name: string, content: string): string {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  writeFileSync(file, content);
  return file;
}
